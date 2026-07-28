# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.3.6 (September 15, 2025)."""

import jax
import mujoco
import numpy as np
from mujoco import mjx


def constraint_islands() -> None:
    """Find which degrees of freedom are currently coupled by constraints."""
    xml = """
    <mujoco model="two_piles">
      <compiler angle="radian" autolimits="true"/>
      <worldbody>
        <geom name="floor" type="plane" size="5 5 .1"/>
        <body name="left_lower" pos="-1 0 .05"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body name="left_upper" pos="-1 0 .15"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body name="right_lower" pos="1 0 .05"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body name="right_upper" pos="1 0 .15"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=100)

    # Islanding is on by default since 3.3.6 — no mjENBL_ISLAND to set any more — so
    # mjData.nisland and the island index arrays are simply there after a step.
    for island in range(data.nisland):
        dofs = np.flatnonzero(data.dof_island == island)
        bodies = sorted({model.body(body_id).name for body_id in model.dof_bodyid[dofs]})
        constraints = data.island_nefc[island]
        print(f"3.3.6 islands: island {island} has {constraints} constraints over {bodies}")

    # The monolithic solver is still reachable, mainly to A/B a suspected islanding issue.
    model.opt.disableflags |= mujoco.mjtDisableBit.mjDSBL_ISLAND
    monolithic = mujoco.MjData(model)
    mujoco.mj_step(model, monolithic, nstep=100)
    print(
        f"3.3.6 islands: nisland={data.nisland} by default,",
        f"{monolithic.nisland} with mjDSBL_ISLAND,",
        f"max qpos difference {np.abs(data.qpos - monolithic.qpos).max():.2e}",
    )


def disable_spring_and_damper() -> None:
    """Switch off joint/tendon springs and dampers independently to isolate passive forces."""
    xml = """
    <mujoco model="springy_link">
      <compiler angle="radian" autolimits="true"/>
      <worldbody>
        <body name="link" gravcomp="1">
          <joint name="hinge" axis="0 1 0" stiffness="8" springref="0.3" damping="0.5"/>
          <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".03"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    def passive_force(disableflags: int) -> float:
        model.opt.disableflags = disableflags
        mujoco.mj_resetData(model, data)
        data.qpos[0] = 0.6
        data.qvel[0] = -1.2
        mujoco.mj_forward(model, data)
        return data.qfrc_passive[0]

    # mjDSBL_SPRING and mjDSBL_DAMPER replace the single mjDSBL_PASSIVE flag, so a spring
    # can be removed while damping still stabilises the sim. Setting *both* is the old
    # mjDSBL_PASSIVE and kills everything passive — gravity compensation, fluid forces,
    # mjcb_passive and passive plugins included.
    spring = mujoco.mjtDisableBit.mjDSBL_SPRING
    damper = mujoco.mjtDisableBit.mjDSBL_DAMPER
    print(
        "3.3.6 spring/damper flags: qfrc_passive =",
        f"{passive_force(0):+.4f} (all on),",
        f"{passive_force(spring):+.4f} (no spring),",
        f"{passive_force(damper):+.4f} (no damper),",
        f"{passive_force(spring | damper):+.4f} (neither — gravcomp gone too)",
    )


def forward_idempotence() -> None:
    """Warm-start the constraint solver explicitly now that mj_forward leaves state alone."""
    xml = """
    <mujoco model="pile">
      <compiler angle="radian" autolimits="true"/>
      <!-- Deliberately starved solver, so the warm start still matters. -->
      <option iterations="1" tolerance="0"/>
      <worldbody>
        <geom name="floor" type="plane" size="5 5 .1"/>
        <body pos="0    0    .05" euler="0 0    0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".02  .01  .15" euler="0 0.09 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".04  .02  .25" euler="0 0.17 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".06  .03  .35" euler="0 0.26 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".08  .04  .45" euler="0 0.35 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".10  .05  .55" euler="0 0.44 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".12  .06  .65" euler="0 0.52 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
        <body pos=".14  .07  .75" euler="0 0.61 0"><freejoint/><geom type="box" size=".05 .05 .05"/></body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=30)

    # mj_forward no longer writes qacc_warmstart, so repeated calls on unchanged state
    # return exactly the same answer — which is what makes it safe in analysis code.
    mujoco.mj_forward(model, data)
    qacc_first = data.qacc.copy()
    mujoco.mj_forward(model, data)
    repeat = np.abs(data.qacc - qacc_first).max()
    print(f"3.3.6 idempotent mj_forward: repeat call differs by {repeat:.2e}")

    # Migration for code that relied on the old convergence-by-repetition behaviour:
    # carry the warm start forward by hand.
    data.qacc_warmstart[:] = data.qacc
    mujoco.mj_forward(model, data)
    print(
        "3.3.6 idempotent mj_forward: after qacc_warmstart <- qacc the solver moves by",
        f"{np.abs(data.qacc - qacc_first).max():.2e}",
    )


def contact_sensor_subtree() -> None:
    """Report contacts between a whole kinematic subtree and an object as a fixed-size array."""
    xml = """
    <mujoco model="gripper">
      <compiler angle="radian" autolimits="true"/>
      <worldbody>
        <geom name="floor" type="plane" size="1 1 .1"/>
        <body name="column" pos="0 0 .5">
          <body name="arm">
            <joint name="lift" type="slide" axis="0 0 1" range="-.5 0"/>
            <geom name="forearm" type="capsule" fromto="0 0 0 0 0 -.2" size=".02"/>
            <body name="hand" pos="0 0 -.2">
              <geom name="palm" type="box" size=".05 .03 .01"/>
              <body name="finger_left" pos="-.04 0 -.04">
                <joint name="grip_left" type="slide" axis="1 0 0" range="0 .04"/>
                <geom name="pad_left" type="box" size=".008 .02 .03"/>
              </body>
              <body name="finger_right" pos=".04 0 -.04">
                <joint name="grip_right" type="slide" axis="-1 0 0" range="0 .04"/>
                <geom name="pad_right" type="box" size=".008 .02 .03"/>
              </body>
            </body>
          </body>
        </body>
        <body name="cube" pos="0 0 .03">
          <freejoint/>
          <geom name="cube" type="box" size=".025 .025 .03" mass=".2"/>
        </body>
      </worldbody>
      <keyframe>
        <key name="grasp" qpos="-.22 .008 .0075  0 0 .03 1 0 0 0"/>
      </keyframe>
      <sensor>
        <contact name="grasp" subtree1="hand" body2="cube" num="4" data="found force dist" reduce="maxforce"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key("grasp").id)
    mujoco.mj_forward(model, data)

    # subtree1/subtree2 accept any body, not only a direct child of world — so "hand"
    # here matches the palm and both fingers without listing their geoms one by one.
    slots = data.sensor("grasp").data.reshape(4, -1)
    matched = int(slots[0, 0])
    reported = min(matched, 4)
    print(f"3.3.6 contact sensor subtree: {matched} hand/cube contacts, strongest {reported} reported")
    for slot in slots[:reported]:
        force, dist = slot[1:4], slot[4]
        print(
            f"3.3.6 contact sensor subtree:   |force|={np.linalg.norm(force):6.3f} N,"
            f" penetration={-dist * 1e3:.2f} mm"
        )


def mesh_default_material() -> None:
    """Give a mesh asset a fallback material instead of repeating it on every geom."""
    xml = """
    <mujoco model="painted">
      <compiler angle="radian" autolimits="true"/>
      <asset>
        <material name="brushed_metal" rgba=".7 .72 .75 1" specular=".9" shininess=".6"/>
        <material name="warning_red" rgba=".8 .1 .1 1"/>
        <mesh name="shell" builtin="sphere" params="2" scale=".05 .05 .05" material="brushed_metal"/>
      </asset>
      <worldbody>
        <body name="inherits" pos="-.2 0 .3">
          <geom type="mesh" mesh="shell"/>
        </body>
        <body name="overrides" pos=".2 0 .3">
          <geom type="mesh" mesh="shell" material="warning_red"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)

    # mesh/material is the fallback: a geom that names its own material still wins.
    for geom_id in range(model.ngeom):
        body = model.body(model.geom_bodyid[geom_id]).name
        material = model.material(model.geom_matid[geom_id]).name
        print(f"3.3.6 mesh material: geom on '{body}' renders with '{material}'")


def mjx_tendon_length() -> None:
    """Read tendon lengths straight off mjx.Data, without reaching into the private impl."""
    xml = """
    <mujoco model="winch">
      <compiler angle="radian" autolimits="true"/>
      <worldbody>
        <site name="anchor" pos="0 0 .5"/>
        <body name="load" pos="0 0 .2">
          <joint name="lift" type="slide" axis="0 0 1" range="-.15 .15"/>
          <geom type="sphere" size=".04" mass="1"/>
          <site name="hook" pos="0 0 .04"/>
        </body>
      </worldbody>
      <tendon>
        <spatial name="cable" limited="true" range="0 .3" width=".004">
          <site site="anchor"/>
          <site site="hook"/>
        </spatial>
      </tendon>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[0] = 0.1
    mujoco.mj_forward(model, data)

    # ten_length was mjx.Data._impl.ten_length; it is public API now, so tendon-space
    # rewards and observations no longer touch the implementation-specific struct.
    model_mjx = mjx.put_model(model)
    data_mjx = jax.jit(mjx.forward)(model_mjx, mjx.put_data(model, data))
    print(
        f"3.3.6 mjx.Data.ten_length: mjx {np.asarray(data_mjx.ten_length)}",
        f"vs C {data.ten_length}",
    )


def main() -> None:
    constraint_islands()
    disable_spring_and_damper()
    forward_idempotence()
    contact_sensor_subtree()
    mesh_default_material()
    mjx_tendon_length()


if __name__ == "__main__":
    main()
