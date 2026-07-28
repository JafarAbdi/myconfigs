# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.1.4 (April 10th, 2024)."""

import mujoco
import numpy as np
from mujoco import minimize

# Both arms are identical and fully gravity-compensated; only the bookkeeping of the
# compensation force differs, and with it what the actuator force clamp has to pay for.
GRAVCOMP_XML = """
<mujoco model="actuator_gravcomp">
  <compiler angle="radian"/>

  <default>
    <geom type="capsule" fromto="0 0 0 .4 0 0" size=".03" mass="2"/>
    <motor ctrlrange="-20 20"/>
  </default>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="passive_comp" pos="0 -.5 .6" gravcomp="1">
      <joint name="passive_comp" type="hinge" axis="0 1 0" actuatorfrcrange="-3 3"/>
      <geom/>
    </body>
    <body name="actuated_comp" pos="0 .5 .6" gravcomp="1">
      <!-- Gravity compensation now counts as actuation, so it is subject to the same clamp. -->
      <joint name="actuated_comp" type="hinge" axis="0 1 0" actuatorfrcrange="-3 3"
             actuatorgravcomp="true"/>
      <geom/>
    </body>
  </worldbody>

  <actuator>
    <motor name="passive_comp" joint="passive_comp"/>
    <motor name="actuated_comp" joint="actuated_comp"/>
  </actuator>
</mujoco>
"""

# eulerseq="XYZ" is the extrinsic sequence that URDF rpy uses.
EULER_XML = """
<mujoco model="euler_seq">
  <compiler angle="radian" eulerseq="XYZ"/>
  <worldbody>
    <body name="sensor_mount" pos="0 0 .5" euler=".3 -.7 1.1">
      <geom type="box" size=".05 .03 .02"/>
    </body>
  </worldbody>
</mujoco>
"""

IK_XML = """
<mujoco model="planar_arm">
  <compiler angle="radian"/>

  <default>
    <joint type="hinge" axis="0 0 1" range="-2.6 2.6"/>
    <geom type="capsule" size=".02" mass=".5"/>
  </default>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="shoulder">
      <joint name="q0"/>
      <geom fromto="0 0 0 .3 0 0"/>
      <body name="elbow" pos=".3 0 0">
        <joint name="q1"/>
        <geom fromto="0 0 0 .25 0 0"/>
        <body name="wrist" pos=".25 0 0">
          <joint name="q2"/>
          <geom fromto="0 0 0 .15 0 0"/>
          <site name="tip" pos=".15 0 0" size=".01"/>
        </body>
      </body>
    </body>
  </worldbody>
</mujoco>
"""


def actuator_gravity_compensation() -> None:
    """Charge a joint's gravity compensation to the actuator so force clamps account for it."""
    model = mujoco.MjModel.from_xml_string(GRAVCOMP_XML)
    data = mujoco.MjData(model)

    # Hold both arms horizontal, where gravity torque is largest, and ask for zero net torque.
    data.ctrl[:] = 0.0
    mujoco.mj_forward(model, data)

    for name in ("passive_comp", "actuated_comp"):
        dof = model.joint(name).dofadr[0]
        flag = bool(model.jnt_actgravcomp[model.joint(name).id])
        print(
            f"  {name:<14} actuatorgravcomp={str(flag):<5}"
            f" qfrc_passive={data.qfrc_passive[dof]:+7.3f}"
            f" qfrc_actuator={data.qfrc_actuator[dof]:+7.3f}"
            f" qfrc_gravcomp={data.qfrc_gravcomp[dof]:+7.3f}"
        )

    # actuatorfrcrange is +-3 Nm but holding this link needs ~3.9 Nm. Only the joint that
    # books gravcomp as actuation gets clamped, so it is the only one that actually sags.
    mujoco.mj_step(model, data, nstep=500)
    print(f"  after {data.time:.1f}s: passive_comp={data.qpos[0]:+.4f} rad,"
          f" actuated_comp={data.qpos[1]:+.4f} rad")


def euler_to_quat() -> None:
    """Convert an Euler-angle triple to a MuJoCo quaternion with an explicit rotation sequence."""
    euler = np.array([0.3, -0.7, 1.1])

    # Replaces hand-rolled quaternion products or a scipy Rotation round-trip. Lowercase
    # axes are intrinsic, uppercase extrinsic; 'XYZ' is what URDF rpy and MJCF
    # eulerseq="XYZ" mean, and the two orders give genuinely different rotations.
    quat_World_Extrinsic = np.zeros(4)
    quat_World_Intrinsic = np.zeros(4)
    mujoco.mju_euler2Quat(quat_World_Extrinsic, euler, "XYZ")
    mujoco.mju_euler2Quat(quat_World_Intrinsic, euler, "xyz")
    print(f"  'XYZ' extrinsic -> {np.array2string(quat_World_Extrinsic, precision=6)}")
    print(f"  'xyz' intrinsic -> {np.array2string(quat_World_Intrinsic, precision=6)}")

    # Same numbers the compiler produces for <body euler> under eulerseq="XYZ".
    model = mujoco.MjModel.from_xml_string(EULER_XML)
    compiled = model.body("sensor_mount").quat
    print(f"  compiled body quat -> {np.array2string(compiled, precision=6)}")
    print(f"  matches extrinsic: {np.allclose(compiled, quat_World_Extrinsic)}")


def least_squares_ik() -> None:
    """Solve a bounded nonlinear least-squares problem, here inverse kinematics."""
    model = mujoco.MjModel.from_xml_string(IK_XML)
    data = mujoco.MjData(model)
    tip_id = model.site("tip").id
    pos_World_Target = np.array([0.35, 0.42, 0.0])

    def residual(qpos_batch: np.ndarray) -> np.ndarray:
        """Tip position error, vectorized over the columns of qpos_batch."""
        errors = np.empty((3, qpos_batch.shape[1]))
        for i, qpos in enumerate(qpos_batch.T):
            data.qpos[:] = qpos
            mujoco.mj_kinematics(model, data)
            errors[:, i] = data.site_xpos[tip_id] - pos_World_Target
        return errors

    def jacobian(qpos_batch: np.ndarray, error: np.ndarray) -> np.ndarray:
        """Analytic residual Jacobian: the site's translational Jacobian."""
        del error  # Unused: the residual is affine in the tip position.
        data.qpos[:] = qpos_batch[:, 0]
        mujoco.mj_kinematics(model, data)
        mujoco.mj_comPos(model, data)
        jacp_World_Tip = np.zeros((3, model.nv))
        mujoco.mj_jacSite(model, data, jacp_World_Tip, None, tip_id)
        return jacp_World_Tip

    # Levenberg-Marquardt with box bounds, so joint limits are respected at every iterate --
    # no post-hoc clamping, and no scipy dependency for a MuJoCo-shaped problem.
    qpos_init = np.zeros(model.nq)
    bounds = [model.jnt_range[:, 0].copy(), model.jnt_range[:, 1].copy()]
    qpos_solution, trace = minimize.least_squares(
        qpos_init,
        residual,
        bounds=bounds,
        jacobian=jacobian,
        verbose=minimize.Verbosity.SILENT,
    )

    data.qpos[:] = qpos_solution
    mujoco.mj_kinematics(model, data)
    error = np.linalg.norm(data.site_xpos[tip_id] - pos_World_Target)
    print(f"  {len(trace)} iterations, objective {trace[0].objective:.3e} -> "
          f"{trace[-1].objective:.3e}")
    print(f"  qpos={np.array2string(qpos_solution, precision=4)} (limits respected:"
          f" {np.all(qpos_solution >= bounds[0]) and np.all(qpos_solution <= bounds[1])})")
    print(f"  tip={np.array2string(data.site_xpos[tip_id], precision=5)}, error={error:.2e} m")


def main() -> None:
    print("actuator_gravity_compensation:")
    actuator_gravity_compensation()
    print("euler_to_quat:")
    euler_to_quat()
    print("least_squares_ik:")
    least_squares_ik()


if __name__ == "__main__":
    main()
