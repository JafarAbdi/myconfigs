# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.2.6 (Dec 2, 2024)."""

import jax
import mujoco
import numpy as np
from mujoco import mjx, rollout

FINGER = """
<mujoco model="finger">
  <compiler autolimits="true"/>
  <worldbody>
    <body name="proximal">
      <joint name="knuckle" axis="0 1 0" range="-30 30" damping=".01"/>
      <geom name="proximal" type="capsule" fromto="0 0 0 0 0 .06" size=".008" mass=".02"/>
      <body name="distal" pos="0 0 .06">
        <joint name="pip" axis="0 1 0" range="0 60" damping=".01"/>
        <geom name="pad" type="capsule" fromto="0 0 0 0 0 .04" size=".007" mass=".01"/>
        <site name="tip" pos="0 0 .04"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="knuckle" joint="knuckle" kp="2" inheritrange="1"/>
    <position name="pip" joint="pip" kp="2" inheritrange="1"/>
  </actuator>
</mujoco>
"""

PUCK = """
<mujoco model="puck">
  <option timestep=".002"/>
  <worldbody>
    <geom name="table" type="plane" size="3 3 .1" friction=".4 .005 .0001"/>
    <body name="puck" pos="0 0 .03">
      <freejoint/>
      <geom name="puck" type="cylinder" size=".05 .02" mass=".2" friction=".4 .005 .0001"/>
    </body>
  </worldbody>
  <sensor>
    <framepos name="puck_pos" objtype="body" objname="puck"/>
  </sensor>
</mujoco>
"""

ELBOW = """
<mujoco model="elbow">
  <option timestep=".002"/>
  <compiler autolimits="true"/>
  <default>
    <geom contype="0" conaffinity="0"/>
  </default>
  <worldbody>
    <body name="humerus" pos="0 0 1">
      <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".04" mass="2"/>
      <site name="biceps_origin" pos=".04 0 -.1"/>
      <site name="triceps_origin" pos="-.04 0 -.1"/>
      <body name="ulna" pos="0 0 -.3">
        <joint name="elbow" axis="0 -1 0" range="0 130" damping=".5"/>
        <geom type="capsule" fromto=".05 0 0 .3 0 0" size=".03" mass="1.2"/>
        <site name="biceps_insertion" pos=".06 0 .02"/>
        <site name="triceps_insertion" pos="-.02 0 -.02"/>
      </body>
    </body>
  </worldbody>
  <tendon>
    <spatial name="biceps" width=".004">
      <site site="biceps_origin"/>
      <site site="biceps_insertion"/>
    </spatial>
    <spatial name="triceps" width=".004">
      <site site="triceps_origin"/>
      <site site="triceps_insertion"/>
    </spatial>
  </tendon>
  <actuator>
    <muscle name="biceps" tendon="biceps" force="400" lengthrange=".14 .19" ctrlrange="0 1"/>
    <muscle name="triceps" tendon="triceps" force="300" lengthrange=".215 .235" ctrlrange="0 1"/>
  </actuator>
</mujoco>
"""


def bind_spec_to_model() -> None:
    """Reach mjModel/mjData fields through the MjSpec handle that created the element."""
    palm = mujoco.MjSpec()
    palm.worldbody.add_geom(
        type=mujoco.mjtGeom.mjGEOM_BOX, size=[0.05, 0.02, 0.01], mass=0.1
    )

    # Two copies of the same finger, so names collide and only the handles are unique.
    # Grab the handles before attaching: attach renames the child's elements.
    fingers = {}
    for side, y in (("left", 0.03), ("right", -0.03)):
        finger = mujoco.MjSpec.from_string(FINGER)
        fingers[side] = {
            "tip": finger.site("tip"),
            "joints": [finger.joint("knuckle"), finger.joint("pip")],
            "actuators": [finger.actuator("knuckle"), finger.actuator("pip")],
        }
        mount = palm.worldbody.add_site(name=f"mount_{side}", pos=[0, y, 0.01])
        palm.attach(finger, site=mount, prefix=f"{side}_")

    model = palm.compile()
    data = mujoco.MjData(model)

    # bind replaces dm_control PyMJCF's binding helper: no name mangling, no id
    # bookkeeping across attach/detach. A sequence of handles binds element-wise.
    for side, handles in fingers.items():
        for actuator, gain in zip(handles["actuators"], (8.0, 4.0), strict=True):
            model.bind(actuator).gainprm[0] = gain
            model.bind(actuator).biasprm[1] = -gain
        data.bind(handles["joints"]).qpos = np.array([0.2, 0.6])

    mujoco.mj_forward(model, data)
    for side, handles in fingers.items():
        tip = handles["tip"]
        qposadr = np.array(model.bind(handles["joints"]).qposadr)
        # Both handles are still named "tip"; binding resolves each to its own element.
        print(f"bind {side}: tip -> {model.bind(tip).name!r} at {data.bind(tip).xpos}")
        gainprm = np.array(model.bind(handles["actuators"]).gainprm)
        print(f"  joint qposadr {qposadr}, position gains {gainprm.reshape(2, -1)[:, 0]}")


def rollout_randomized_models() -> None:
    """Roll out one control sequence against a batch of perturbed models, one model per roll."""
    nbatch, nstep = 64, 500
    rng = np.random.default_rng(0)
    friction = rng.uniform(0.2, 0.8, nbatch)
    mass_scale = rng.uniform(0.7, 1.3, nbatch)

    # rollout takes a sequence of MjModel of length nbatch; nbatch is inferred
    # from the longest input, so the old explicit nroll argument is gone.
    models = []
    for slip, scale in zip(friction, mass_scale, strict=True):
        model = mujoco.MjModel.from_xml_string(PUCK)
        model.geom_friction[:, 0] = slip
        model.body_mass[model.body("puck").id] *= scale
        models.append(model)

    # Build the initial state by posing an MjData and reading it out, rather than
    # writing into the packed FULLPHYSICS layout by offset.
    nstate = mujoco.mj_stateSize(models[0], mujoco.mjtState.mjSTATE_FULLPHYSICS)
    state_initial = np.empty((1, nstate))
    data_initial = mujoco.MjData(models[0])
    data_initial.qvel[0] = 2.0  # shove the puck along +x
    mujoco.mj_getState(
        models[0], data_initial, state_initial[0], mujoco.mjtState.mjSTATE_FULLPHYSICS
    )

    data = [mujoco.MjData(models[0]) for _ in range(4)]
    _, sensordata = rollout.rollout(models, data, state_initial, nstep=nstep)

    slid = sensordata[:, -1, 0]
    print(f"rollout over {len(models)} randomized models, {nstep} steps:")
    print(f"  slide distance {slid.min():.3f} .. {slid.max():.3f} m")
    print(f"  slipperiest model {np.argmax(slid)} (friction {friction[np.argmax(slid)]:.2f})")


def mjx_muscle_actuator() -> None:
    """Drive an MJX model with muscles: activation dynamics plus the force-length-velocity curve."""
    model = mujoco.MjModel.from_xml_string(ELBOW)
    data = mujoco.MjData(model)
    data.ctrl[:] = [0.9, 0.05]  # biceps excitation, triceps co-contraction

    model_mjx = mjx.put_model(model)
    data_mjx = mjx.put_data(model, data)
    step_mjx = jax.jit(mjx.step)
    for _ in range(400):
        data_mjx = step_mjx(model_mjx, data_mjx)
        mujoco.mj_step(model, data)

    act = np.asarray(data_mjx.act)
    force = np.asarray(data_mjx.actuator_force)
    print("mjx muscles after 0.8 s:")
    print(f"  activation {act} (mujoco {data.act})")
    print(f"  force {force} N (mujoco {data.actuator_force})")
    print(f"  elbow angle {float(data_mjx.qpos[0]):.4f} rad (mujoco {data.qpos[0]:.4f})")
    print(f"  operating length range {model.actuator_lengthrange[0]} m")


def main() -> None:
    bind_spec_to_model()
    rollout_randomized_models()
    mjx_muscle_actuator()


if __name__ == "__main__":
    main()
