# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.1.2 (February 05, 2024)."""

import mujoco
import numpy as np
from mujoco import mjx, rollout

# elevation is row-major, nrow x ncol, normalized by the compiler to [0, 1] and then
# scaled by size[2]. No PNG, no binary blob, no file next to the XML.
HFIELD_XML = """
<mujoco model="hfield_xml">
  <asset>
    <hfield name="ridge" nrow="5" ncol="5" size=".5 .5 .25 .05"
            elevation="0 0 0 0 0
                       0 1 2 1 0
                       0 2 4 2 0
                       0 1 2 1 0
                       0 0 0 0 0"/>
  </asset>

  <worldbody>
    <light pos="0 0 2"/>
    <geom name="terrain" type="hfield" hfield="ridge" pos="0 0 0"/>
    <body name="ball" pos="0 0 .6">
      <freejoint/>
      <geom name="ball" type="sphere" size=".04" mass=".2"/>
    </body>
  </worldbody>
</mujoco>
"""

# One MJCF, compiled twice: {discardvisual} is substituted below.
DISCARDVISUAL_XML = """
<mujoco model="discardvisual">
  <compiler discardvisual="{discardvisual}"/>

  <asset>
    <texture name="grid" type="2d" builtin="checker" width="64" height="64"
             rgb1=".1 .2 .3" rgb2=".2 .3 .4"/>
    <material name="grid" texture="grid" texrepeat="4 4"/>
    <mesh name="shell" scale=".05 .05 .05"
          vertex="0 0 0  1 0 0  0 1 0  0 0 1"
          face="0 2 1  0 1 3  0 3 2  1 2 3"/>
  </asset>

  <worldbody>
    <light pos="0 0 2"/>
    <geom name="floor" type="plane" size="2 2 .05" material="grid"/>
    <body name="chassis" pos="0 0 .3">
      <freejoint/>
      <geom name="collision" type="box" size=".1 .06 .04" mass="2" group="3"/>
      <!-- Pure decoration: contype=conaffinity=0 is exactly what discardvisual drops. -->
      <geom name="skin" type="mesh" mesh="shell" contype="0" conaffinity="0" group="2"/>
    </body>
  </worldbody>
</mujoco>
"""

ROLLOUT_XML = """
<mujoco model="cartpole">
  <compiler angle="radian"/>
  <option timestep=".01"/>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="cart" pos="0 0 .6">
      <joint name="slider" type="slide" axis="1 0 0" range="-2 2" damping=".1"/>
      <geom type="box" size=".1 .05 .05" mass="1"/>
      <body name="pole">
        <joint name="hinge" type="hinge" axis="0 1 0" damping=".01"/>
        <geom type="capsule" fromto="0 0 0 0 0 .5" size=".02" mass=".2"/>
        <site name="tip" pos="0 0 .5" size=".01"/>
      </body>
    </body>
  </worldbody>

  <actuator>
    <motor name="drive" joint="slider" ctrlrange="-10 10"/>
  </actuator>

  <sensor>
    <framepos name="tip" objtype="site" objname="tip"/>
  </sensor>
</mujoco>
"""

MJX_XML = """
<mujoco model="mjx_scene">
  <option jacobian="{jacobian}"/>

  <asset>
    <material name="scene" rgba=".6 .6 .62 1"/>
  </asset>

  <worldbody>
    <light pos="0 0 2"/>
    <geom name="floor" type="plane" size="3 3 .05" group="0" material="scene"/>
    <body name="pillar" pos=".5 0 .4">
      <geom name="pillar" type="box" size=".08 .08 .4" group="0"/>
    </body>
    <body name="payload" pos="0 0 .3">
      <freejoint/>
      <geom name="payload" type="box" size=".08 .08 .08" mass="1" group="2"/>
    </body>
    <body name="link" pos="-.6 0 .3">
      <joint name="j0" type="hinge" axis="0 1 0"/>
      <geom name="arm" type="capsule" fromto="0 0 0 .3 0 0" size=".03" group="1"/>
    </body>
  </worldbody>
</mujoco>
"""


def hfield_elevation_in_xml() -> None:
    """Define height-field terrain inline in MJCF instead of shipping a PNG alongside it."""
    model = mujoco.MjModel.from_xml_string(HFIELD_XML)
    data = mujoco.MjData(model)
    hfield_id = model.hfield("ridge").id

    # Makes procedural terrain a plain string you can generate in Python, and keeps the
    # model self-contained -- previously the only options were a PNG or a custom binary file.
    nrow = model.hfield_nrow[hfield_id]
    ncol = model.hfield_ncol[hfield_id]
    adr = model.hfield_adr[hfield_id]
    elevation = model.hfield_data[adr : adr + nrow * ncol].reshape(nrow, ncol)
    size = model.hfield_size[hfield_id]
    print(f"  {nrow}x{ncol} field, size (rx, ry, ez, bz) = {np.array2string(size, precision=2)}")
    print(f"  normalized elevation:\n{np.array2string(elevation, precision=2)}")
    print(f"  peak height = {elevation.max() * size[2]:.3f} m above the base")

    mujoco.mj_step(model, data, nstep=400)
    print(f"  ball settled at z={data.qpos[2]:.4f} m with {data.ncon} contact(s)")


def discard_visual_assets() -> None:
    """Strip render-only geoms and their assets at compile time without changing the dynamics."""
    kept = mujoco.MjModel.from_xml_string(DISCARDVISUAL_XML.format(discardvisual="false"))
    stripped = mujoco.MjModel.from_xml_string(DISCARDVISUAL_XML.format(discardvisual="true"))

    # discardvisual now drops materials, textures and meshes too, not just the geoms, so
    # this is the cheap way to load a Menagerie-style model for headless physics: no mesh
    # parsing, no texture upload. URDF imports default to discardvisual="true".
    for label, model in (("kept", kept), ("stripped", stripped)):
        print(
            f"  {label:<9} ngeom={model.ngeom} nmesh={model.nmesh}"
            f" nmat={model.nmat} ntex={model.ntex} nbuffer={model.nbuffer / 1e3:.1f} kB"
        )

    # The compiler adds explicit inertials where needed, so the dynamics are untouched.
    body_id = kept.body("chassis").id
    print(f"  chassis mass {kept.body_mass[body_id]:.4f} -> {stripped.body_mass[body_id]:.4f}")
    print(f"  inertia identical: {np.allclose(kept.body_inertia, stripped.body_inertia)}")


def rollout_batch() -> None:
    """Roll out a batch of open-loop trajectories on a thread pool and detect divergence."""
    model = mujoco.MjModel.from_xml_string(ROLLOUT_XML)
    nstate = mujoco.mj_stateSize(model, mujoco.mjtState.mjSTATE_FULLPHYSICS)

    nbatch, nstep = 6, 200
    rng = np.random.default_rng(0)

    # mjSTATE_FULLPHYSICS is the state spec: [time, qpos, qvel, act, plugin_state]. Because
    # time is part of the state, a diverged rollout is visible as a frozen clock -- no need
    # to sniff for NaNs in qpos.
    data = mujoco.MjData(model)
    initial_state = np.empty((nbatch, nstate))
    for i in range(nbatch):
        mujoco.mj_resetData(model, data)
        data.qpos[model.joint("hinge").qposadr] = rng.uniform(-0.4, 0.4)
        if i == nbatch - 1:
            data.qvel[model.joint("hinge").dofadr] = 1e4  # deliberately unstable
        mujoco.mj_getState(model, data, initial_state[i], mujoco.mjtState.mjSTATE_FULLPHYSICS)

    # The control spec is user-defined: any combination of mjSTATE_USER fields, packed in
    # mjtState bit order. Here each step carries ctrl (nu) followed by qfrc_applied (nv).
    control_spec = mujoco.mjtState.mjSTATE_CTRL | mujoco.mjtState.mjSTATE_QFRC_APPLIED
    ncontrol = mujoco.mj_stateSize(model, control_spec)
    control = np.zeros((nbatch, nstep, ncontrol))
    control[:, :, model.actuator("drive").id] = rng.uniform(-4.0, 4.0, (nbatch, 1))
    control[:, :, model.nu + model.joint("hinge").dofadr[0]] = 0.02  # nudge on the pole dof

    # One MjData per worker thread; outputs are always 3D (nbatch x nstep x n).
    with rollout.Rollout(nthread=2) as roller:
        state, sensordata = roller.rollout(
            model,
            [mujoco.MjData(model) for _ in range(2)],
            initial_state,
            control,
            control_spec=control_spec,
        )

    print(f"  state {state.shape} (nstate={nstate}), sensordata {sensordata.shape}")
    # A diverged rollout stops advancing, so its clock stalls short of nstep * timestep.
    time = state[:, -1, 0]
    diverged = time < model.opt.timestep * nstep - 1e-9
    qpos = state[:, -1, 1 : 1 + model.nq]
    print(f"  final time per rollout: {np.array2string(time, precision=3)}")
    print(f"  diverged: {diverged.tolist()}")
    print(f"  final cart x: {np.array2string(qpos[:, 0], precision=3)}")
    print(f"  final tip height: {np.array2string(sensordata[:, -1, 2], precision=3)}")


def mjx_ray_cast() -> None:
    """Cast a ray against MJX geoms on device, the way a lidar or a click-to-select would."""
    mj_model = mujoco.MjModel.from_xml_string(MJX_XML.format(jacobian="dense"))
    model = mjx.put_model(mj_model)
    data = mjx.forward(model, mjx.make_data(model))

    pnt_World = np.array([-1.5, 0.0, 0.3])
    vec_World = np.array([1.0, 0.0, 0.0])

    # mjx.ray mirrors mj_ray and returns (distance, geom_id), with -1 for a miss.
    distance, geom_id = mjx.ray(model, data, pnt_World, vec_World)
    name = mjx.id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_id))
    print(f"  ray from {pnt_World} hits {name} at {float(distance):.4f} m")

    # bodyexclude drops a body from the cast: the classic use is a sensor ignoring its own
    # robot. flg_static=False additionally skips everything welded to the world.
    distance, geom_id = mjx.ray(
        model, data, pnt_World, vec_World, bodyexclude=int(mj_model.body("link").id)
    )
    name = mjx.id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_id))
    print(f"  excluding 'link': hits {name} at {float(distance):.4f} m")

    # geomgroup is a per-group inclusion mask, same semantics as the visualizer's groups:
    # here only group 0 (the static scenery) is eligible.
    geomgroup = [1, 0, 0, 0, 0, 0]
    distance, geom_id = mjx.ray(model, data, pnt_World, vec_World, geomgroup=geomgroup)
    name = mjx.id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_id))
    print(f"  scenery only: hits {name} at {float(distance):.4f} m")


def mjx_mass_matrix() -> None:
    """Get a dense mass matrix out of MJX whichever sparse/dense layout the model selected."""
    for jacobian in ("dense", "sparse"):
        mj_model = mujoco.MjModel.from_xml_string(MJX_XML.format(jacobian=jacobian))
        model = mjx.put_model(mj_model)
        data = mjx.forward(model, mjx.make_data(model))

        # option/jacobian is honoured by MJX now, and mjx.is_sparse / mjx.full_m mirror
        # mj_isSparse / mj_fullM -- so downstream code never has to branch on the layout.
        sparse = mjx.is_sparse(model)
        mass_mat = np.asarray(mjx.full_m(model, data))

        mj_data = mujoco.MjData(mj_model)
        mujoco.mj_forward(mj_model, mj_data)
        reference = np.zeros((mj_model.nv, mj_model.nv))
        mujoco.mj_fullM(mj_model, mj_data, reference)

        print(
            f"  jacobian={jacobian:<6} is_sparse={sparse!s:<5} full_m{mass_mat.shape}"
            f" matches mj_fullM: {np.allclose(mass_mat, reference, atol=1e-6)}"
        )


def main() -> None:
    print("hfield_elevation_in_xml:")
    hfield_elevation_in_xml()
    print("discard_visual_assets:")
    discard_visual_assets()
    print("rollout_batch:")
    rollout_batch()
    print("mjx_ray_cast:")
    mjx_ray_cast()
    print("mjx_mass_matrix:")
    mjx_mass_matrix()


if __name__ == "__main__":
    main()
