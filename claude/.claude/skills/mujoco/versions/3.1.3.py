# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.1.3 (March 5th, 2024)."""

import mujoco
import numpy as np

INHERITRANGE_XML = """
<mujoco model="inheritrange">
  <compiler angle="radian"/>
  <option integrator="implicitfast"/>

  <default>
    <geom type="capsule" fromto="0 0 0 .25 0 0" size=".02" mass=".4"/>
    <joint type="hinge" axis="0 0 1" range="-.4 1.2" damping=".5"/>
  </default>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="a" pos="0 -.9 .5">
      <joint name="wide"/>
      <geom/>
    </body>
    <body name="b" pos="0 -.3 .5">
      <joint name="safe"/>
      <geom/>
    </body>
    <body name="c" pos="0 .3 .5">
      <joint name="authority"/>
      <geom/>
    </body>
    <body name="d" pos="0 .9 .5">
      <joint name="integrated"/>
      <geom/>
    </body>
  </worldbody>

  <actuator>
    <!-- The ctrlrange follows the joint's range; no duplicated numbers to keep in sync. -->
    <position name="wide" joint="wide" kp="8" inheritrange="1"/>
    <!-- Shrink about the range midpoint: the servo can never command a limit hit. -->
    <position name="safe" joint="safe" kp="8" inheritrange=".8"/>
    <!-- Grow about the midpoint: the servo keeps pushing once the joint is on its limit. -->
    <position name="authority" joint="authority" kp="8" inheritrange="1.2"/>
    <!-- On intvelocity, inheritrange sets actrange (the integrated setpoint) instead. -->
    <intvelocity name="integrated" joint="integrated" kp="8" inheritrange="1"/>
  </actuator>
</mujoco>
"""

ANGMOM_XML = """
<mujoco model="angmom">
  <compiler angle="radian"/>
  <option gravity="0 0 0"/>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="torso" pos="0 0 1">
      <freejoint name="root"/>
      <geom type="box" size=".12 .08 .2" mass="8"/>
      <body name="arm" pos=".12 0 .15">
        <joint name="shoulder" type="hinge" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 .3 0 0" size=".03" mass="1.5"/>
      </body>
      <body name="leg" pos="0 0 -.2">
        <joint name="hip" type="hinge" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 0 0 -.35" size=".04" mass="3"/>
      </body>
    </body>
  </worldbody>

  <sensor>
    <subtreeangmom name="torso_angmom" body="torso"/>
  </sensor>
</mujoco>
"""


def inheritrange_actuators() -> None:
    """Derive a servo's ctrlrange (or actrange) from its transmission target's range."""
    model = mujoco.MjModel.from_xml_string(INHERITRANGE_XML)

    # Replaces copy-pasting the joint's range into ctrlrange, which silently rots the moment
    # the joint limit changes. inheritrange is resolved at compile time, so what you read
    # back on mjModel (and what a saved XML contains) is the explicit range.
    joint_range = model.jnt_range[model.joint("wide").id]
    print(f"  joint range = {np.array2string(joint_range, precision=3)} for all four joints")
    for name, factor in (("wide", 1.0), ("safe", 0.8), ("authority", 1.2)):
        ctrlrange = model.actuator_ctrlrange[model.actuator(name).id]
        print(f"  {name:<10} inheritrange={factor:<4} -> ctrlrange="
              f"{np.array2string(ctrlrange, precision=3)}")

    integrated_id = model.actuator("integrated").id
    actrange = model.actuator_actrange[integrated_id]
    limited = bool(model.actuator_ctrllimited[integrated_id])
    print(f"  integrated intvelocity -> actrange={np.array2string(actrange, precision=3)},"
          f" ctrllimited={limited} (its ctrl is a velocity, left unbounded here)")

    # Saturate every actuator: only the narrowed servo stops short of the joint limit.
    data = mujoco.MjData(model)
    data.ctrl[:3] = model.actuator_ctrlrange[:3, 1]
    data.ctrl[integrated_id] = 0.5  # rad/s; the integrated setpoint stops at actrange.
    mujoco.mj_step(model, data, nstep=2000)
    print(f"  saturated qpos = {np.array2string(data.qpos, precision=4)}")
    print(f"  integrated act = {np.array2string(data.act, precision=4)} (clamped to actrange)")


def angular_momentum_matrix() -> None:
    """Map generalized velocities to a subtree's angular momentum with the 3 x nv matrix H(q)."""
    model = mujoco.MjModel.from_xml_string(ANGMOM_XML)
    data = mujoco.MjData(model)
    torso_id = model.body("torso").id

    rng = np.random.default_rng(0)
    data.qvel[:] = rng.uniform(-1.0, 1.0, model.nv)
    mujoco.mj_forward(model, data)

    # H(q) is the momentum equivalent of mj_jacSubtreeCom: it gives you the linear map, not
    # just the current value, so centroidal-momentum controllers can put it straight into a
    # QP instead of finite-differencing the subtreeangmom sensor.
    angmom_mat_World_Torso = np.zeros((3, model.nv))
    mujoco.mj_angmomMat(model, data, angmom_mat_World_Torso, torso_id)

    angmom_World_Torso = angmom_mat_World_Torso @ data.qvel
    measured = data.sensor("torso_angmom").data
    print(f"  H shape {angmom_mat_World_Torso.shape}, nv={model.nv}")
    print(f"  H @ qvel = {np.array2string(angmom_World_Torso, precision=6)}")
    print(f"  sensor   = {np.array2string(measured, precision=6)}")
    print(f"  agree: {np.allclose(angmom_World_Torso, measured)}")

    # Which dofs can change the torso's angular momentum, and by how much.
    dof_names = []
    for dof in range(model.nv):
        joint = model.joint(model.dof_jntid[dof])
        dof_names.append(f"{joint.name}[{dof - joint.dofadr[0]}]")
    contributions = np.linalg.norm(angmom_mat_World_Torso, axis=0)
    ranked = sorted(zip(dof_names, contributions), key=lambda pair: -pair[1])
    top = ", ".join(f"{name}={value:.4f}" for name, value in ranked[:4])
    print(f"  dof sensitivity: {top}")


def main() -> None:
    print("inheritrange_actuators:")
    inheritrange_actuators()
    print("angular_momentum_matrix:")
    angular_momentum_matrix()


if __name__ == "__main__":
    main()
