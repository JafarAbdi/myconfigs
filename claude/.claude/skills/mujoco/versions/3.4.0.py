# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.4.0 (December 5, 2025)."""

import mujoco
import numpy as np

WAREHOUSE_MJCF = """
<mujoco model="crate_pile">
  <option timestep="0.005">
    <flag sleep="enable"/>
  </option>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="crate_bottom" pos="0 0 0.05">
      <freejoint/>
      <geom type="box" size="0.05 0.05 0.05"/>
    </body>
    <body name="crate_top" pos="0 0 0.16">
      <freejoint/>
      <geom type="box" size="0.05 0.05 0.05"/>
    </body>
    <body name="dropped_ball" pos="1 0 1">
      <freejoint/>
      <geom type="sphere" size="0.05"/>
    </body>
  </worldbody>
</mujoco>
"""

ARM_MJCF = """
<mujoco model="planar_arm">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.004"/>
  <worldbody>
    <geom name="floor" type="plane" size="2 2 0.1"/>
    <body name="upper" pos="0 0 0.6">
      <joint name="shoulder" type="hinge" axis="0 1 0" range="-2 2"/>
      <geom type="capsule" fromto="0 0 0 0.25 0 0" size="0.03"/>
      <body name="fore" pos="0.25 0 0">
        <joint name="elbow" type="hinge" axis="0 1 0" range="-2.5 2.5"/>
        <geom type="capsule" fromto="0 0 0 0.25 0 0" size="0.025"/>
        <site name="tool" pos="0.25 0 0"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <position name="shoulder" joint="shoulder" kp="30" kv="3"/>
    <position name="elbow" joint="elbow" kp="20" kv="2"/>
  </actuator>
</mujoco>
"""

CABLE_MJCF = """
<mujoco model="cable_driven_wrist">
  <compiler autolimits="true"/>
  <worldbody>
    <site name="anchor" pos="0 0 0.6"/>
    <geom name="pulley_geom" type="sphere" pos="0 0.08 0.5" size="0.03"/>
    <site name="pulley_side" pos="0 0.08 0.55"/>
    <body name="link1" pos="0 0 0.5">
      <joint name="j1" type="hinge" axis="0 1 0"/>
      <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02"/>
      <site name="mid" pos="0.2 0 0"/>
      <body name="link2" pos="0.2 0 0">
        <joint name="j2" type="hinge" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02"/>
        <site name="tip" pos="0.2 0 0"/>
      </body>
    </body>
  </worldbody>
  <tendon>
    <spatial name="cable" width="0.004">
      <site site="anchor"/>
      <geom geom="pulley_geom" sidesite="pulley_side"/>
      <site site="mid"/>
      <pulley divisor="2"/>
      <site site="mid"/>
      <site site="tip"/>
    </spatial>
    <fixed name="coupler">
      <joint joint="j1" coef="1"/>
      <joint joint="j2" coef="-0.5"/>
    </fixed>
  </tendon>
</mujoco>
"""

SOFT_BODY_MJCF = """
<mujoco model="soft_block">
  <option timestep="0.002" integrator="implicitfast" solver="CG" tolerance="1e-6"/>
  <worldbody>
    <geom name="floor" type="plane" size="2 2 0.1"/>
    <flexcomp name="block" type="grid" count="4 4 4" spacing="0.05 0.05 0.05"
              pos="0 0 0.4" dim="3" radius="0.001" mass="1" dof="quadratic">
      <elasticity young="5e4" poisson="0.2" damping="1e-3"/>
      <contact selfcollide="none" internal="false"/>
    </flexcomp>
  </worldbody>
</mujoco>
"""


def sleeping_islands() -> None:
    """Let settled free bodies drop out of the pipeline so a scene full of passive props stays cheap."""
    model = mujoco.MjModel.from_xml_string(WAREHOUSE_MJCF)
    data = mujoco.MjData(model)

    # Sleeping is opt-in via <flag sleep="enable"/>. The compiler assigns each
    # kinematic tree a policy; trees carrying actuators default to "never".
    policies = [mujoco.mjtSleepPolicy(p).name for p in model.tree_sleep_policy]
    print(f"ntree={model.ntree} policies={policies} tolerance={model.opt.sleep_tolerance}")

    for step in range(1200):
        mujoco.mj_step(model, data)
        if step % 300 == 0:
            asleep = (data.tree_asleep >= 0).sum()
            print(f"  t={data.time:5.2f} ncon={data.ncon:2d} trees asleep={asleep}/{model.ntree}")

    # tree_asleep < 0 is awake: it starts at -(1 + mjMINAWAKE) and is incremented every
    # slow timestep up to -1, "ready to sleep". >= 0 is the sleeping island index.
    states = [mujoco.mjtSleepState(s).name for s in data.body_awake]
    print(f"settled: tree_asleep={data.tree_asleep} ncon={data.ncon}")
    print(f"body sleep states: {dict(zip(['world', 'crate_bottom', 'crate_top', 'ball'], states))}")

    # Writing a non-zero velocity (or qpos, or applied force) wakes the whole island.
    data.qvel[0] = 1e-3
    mujoco.mj_forward(model, data)
    print(f"after nudging crate_bottom: tree_asleep={data.tree_asleep}")


def kinematics_only_pipeline() -> None:
    """Refresh site poses and Jacobians for an IK iteration without paying for dynamics."""
    model = mujoco.MjModel.from_xml_string(ARM_MJCF)
    data = mujoco.MjData(model)
    tool = model.site("tool").id

    # mj_fwdKinematics replaces the hand-rolled mj_kinematics + mj_comPos +
    # mj_camLight + mj_flex + mj_tendon chain that IK loops used to call.
    pos_World_Tool_target = np.array([0.35, 0.0, 0.75])
    jacp_World_Tool = np.zeros((3, model.nv))
    jacr_World_Tool = np.zeros((3, model.nv))
    damping = 1e-3
    # jnt_range is indexed by joint, not by qpos, and only means anything where
    # jnt_limited is set — so resolve the limited joints to qpos addresses up front.
    limited = np.flatnonzero(model.jnt_limited)
    limited_qposadr = model.jnt_qposadr[limited]
    lower, upper = model.jnt_range[limited].T
    data.qpos[:] = [0.5, -1.0]
    for iteration in range(200):
        mujoco.mj_fwdKinematics(model, data)
        error = pos_World_Tool_target - data.site_xpos[tool]
        if np.linalg.norm(error) < 1e-9:
            break
        mujoco.mj_jacSite(model, data, jacp_World_Tool, jacr_World_Tool, tool)
        gram = jacp_World_Tool @ jacp_World_Tool.T + damping * np.eye(3)
        dq = jacp_World_Tool.T @ np.linalg.solve(gram, error)
        # dq lives in qvel space, so it is applied with mj_integratePos rather than by
        # adding to qpos: only that handles ball and free joints, where nq > nv.
        mujoco.mj_integratePos(model, data.qpos, np.clip(dq, -0.1, 0.1), 1.0)
        data.qpos[limited_qposadr] = np.clip(data.qpos[limited_qposadr], lower, upper)

    print(f"IK converged in {iteration} iterations, qpos={data.qpos.round(4)}")
    print(f"tool position after mj_fwdKinematics: {data.site_xpos[tool].round(6)}")

    # A full mj_forward agrees on the kinematic quantities, and additionally
    # fills in the dynamics the IK loop never needed.
    mujoco.mj_forward(model, data)
    print(f"tool position after mj_forward:       {data.site_xpos[tool].round(6)}")


def extract_state_components() -> None:
    """Pull a sub-state out of a serialized state vector without round-tripping it through mjData."""
    model = mujoco.MjModel.from_xml_string(ARM_MJCF)
    data = mujoco.MjData(model)
    data.ctrl[:] = [0.4, -0.8]
    mujoco.mj_step(model, data, nstep=200)

    full_sig = mujoco.mjtState.mjSTATE_FULLPHYSICS
    full_state = np.zeros(mujoco.mj_stateSize(model, full_sig))
    mujoco.mj_getState(model, data, full_state, full_sig)

    # mj_extractState slices a recorded state down to a smaller signature in
    # place; previously this meant mj_setState into a scratch mjData, then
    # mj_getState back out with the narrower signature.
    pos_sig = mujoco.mjtState.mjSTATE_QPOS
    qpos_only = np.zeros(mujoco.mj_stateSize(model, pos_sig))
    mujoco.mj_extractState(model, full_state, full_sig, qpos_only, pos_sig)

    # mjSTATE_PHYSICS is qpos, qvel, act and the actuator/sensor delay history buffer.
    # FULLPHYSICS adds two more components on top of it: time and plugin_state. This
    # model declares neither delays nor plugins, so nhistory and npluginstate are 0.
    physics_sig = mujoco.mjtState.mjSTATE_PHYSICS
    physics_only = np.zeros(mujoco.mj_stateSize(model, physics_sig))
    mujoco.mj_extractState(model, full_state, full_sig, physics_only, physics_sig)

    print(f"FULLPHYSICS state: {full_state.size} numbers (time first: {full_state[0]:.3f})")
    print(f"extracted qpos:    {qpos_only.round(4)} (matches data.qpos: {np.array_equal(qpos_only, data.qpos)})")
    print(
        f"extracted PHYSICS: {physics_only.size} numbers = nq {model.nq} + nv {model.nv}"
        f" + na {model.na} + nhistory {model.nhistory}"
    )


def copy_state_between_data() -> None:
    """Checkpoint and restore an mjData for rollout-style planning without allocating state vectors."""
    model = mujoco.MjModel.from_xml_string(ARM_MJCF)
    data = mujoco.MjData(model)
    checkpoint = mujoco.MjData(model)
    data.ctrl[:] = [0.4, -0.8]
    mujoco.mj_step(model, data, nstep=100)

    # mj_copyState moves state components straight between two mjData, replacing
    # the mj_getState-into-a-buffer / mj_setState-back-out pair.
    sig = mujoco.mjtState.mjSTATE_INTEGRATION
    mujoco.mj_copyState(model, data, checkpoint, sig)
    branch_time, branch_qpos = data.time, data.qpos.copy()

    data.ctrl[:] = [-1.0, 1.0]
    mujoco.mj_step(model, data, nstep=100)
    print(f"branch rollout ended at t={data.time:.3f} qpos={data.qpos.round(4)}")

    mujoco.mj_copyState(model, checkpoint, data, sig)
    print(f"restored checkpoint t={data.time:.3f} qpos={data.qpos.round(4)}")
    print(f"restore exact: {data.time == branch_time and np.array_equal(data.qpos, branch_qpos)}")


def tendon_path_wraps() -> None:
    """Walk a tendon's routing from Python to audit which sites, geoms and pulleys it passes through."""
    spec = mujoco.MjSpec.from_string(CABLE_MJCF)

    # MjsTendon.path is iterable and indexable; before 3.4.0 the wrap list was
    # only reachable through the compiled mjModel's wrap_* arrays.
    for tendon in (spec.tendon("cable"), spec.tendon("coupler")):
        print(f"{tendon.name}: {len(tendon.path)} wraps")
        for index, wrap in enumerate(tendon.path):
            target = wrap.target.name if wrap.target is not None else "-"
            sidesite = wrap.sidesite.name if wrap.sidesite is not None else "-"
            print(
                f"  [{index}] {wrap.type.name:18s} target={target:12s} "
                f"sidesite={sidesite:12s} coef={wrap.coef} divisor={wrap.divisor}"
            )

    branch = spec.tendon("cable").path[3]
    print(f"pulley wrap splits the cable by divisor={branch.divisor}")


def quadratic_flex_dof() -> None:
    """Simulate a deformable solid with curved deformation modes at a fraction of a full flex's dof count."""
    model = mujoco.MjModel.from_xml_string(SOFT_BODY_MJCF)
    data = mujoco.MjData(model)

    # dof="quadratic" is the curved sibling of "trilinear": both replace the
    # per-vertex "full" dofs with a small shared basis, so the same mesh
    # resolution costs a fraction of the dofs and bodies.
    full = mujoco.MjModel.from_xml_string(SOFT_BODY_MJCF.replace('dof="quadratic"', 'dof="full"'))
    print(f"{model.nflexvert} flex vertices: nv={model.nv} quadratic vs nv={full.nv} full")
    print(f"                   nbody={model.nbody} quadratic vs nbody={full.nbody} full")

    vertices = slice(model.flex_vertadr[0], model.flex_vertadr[0] + model.flex_vertnum[0])
    mujoco.mj_forward(model, data)
    rest_height = data.flexvert_xpos[vertices, 2].mean()
    mujoco.mj_step(model, data, nstep=600)
    print(f"block centroid height: rest={rest_height:.4f} after impact={data.flexvert_xpos[vertices, 2].mean():.4f}")
    print(f"squash (z extent): {np.ptp(data.flexvert_xpos[vertices, 2]):.4f} m")


def main() -> None:
    sleeping_islands()
    print()
    kinematics_only_pipeline()
    print()
    extract_state_components()
    print()
    copy_state_between_data()
    print()
    tendon_path_wraps()
    print()
    quadratic_flex_dof()


if __name__ == "__main__":
    main()
