# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.0.1 (November 15, 2023)."""

import jax
import jax.numpy as jnp
import mujoco
import numpy as np
from mujoco import mjx


def passive_force_breakdown() -> None:
    """Attribute mjData.qfrc_passive to its individual sub-term sources."""
    # Before these sub-terms existed, the only way to tell which passive effect dominated
    # was to re-run the model with stiffness / damping / gravcomp / density zeroed one at a
    # time. mjData now reports the decomposition directly: qfrc_spring, qfrc_damper,
    # qfrc_gravcomp, qfrc_fluid and qfrc_adhesion sum to qfrc_passive. The one exception is a
    # joint with actuatorgravcomp="true", whose gravcomp is charged to qfrc_actuator instead.
    xml = """
    <mujoco model="underwater_arm">
      <!-- Water: density 1000 kg/m^3, viscosity 1e-3 Pa*s. -->
      <option density="1000" viscosity="1e-3"/>
      <worldbody>
        <body name="upper" pos="0 0 1" gravcomp="0.8">
          <joint name="shoulder" axis="0 1 0" stiffness="30" springref="0.2" damping="1.5"/>
          <geom type="capsule" fromto="0 0 0 0 0 -0.4" size="0.05" mass="2"/>
          <body name="lower" pos="0 0 -0.4">
            <joint name="elbow" axis="0 1 0" stiffness="8" damping="0.4"/>
            <geom type="capsule" fromto="0 0 0 0 0 -0.35" size="0.04" mass="1"/>
          </body>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    # Fluid and damping terms only appear at nonzero velocity, so pose the arm off its
    # spring reference and give it a swing.
    data.qpos[:] = [0.7, -0.5]
    data.qvel[:] = [2.5, -1.8]
    mujoco.mj_forward(model, data)

    terms = {
        "spring": data.qfrc_spring,
        "damper": data.qfrc_damper,
        "gravcomp": data.qfrc_gravcomp,
        "fluid": data.qfrc_fluid,
        "adhesion": data.qfrc_adhesion,  # Zero here: no geom carries an adhesion value.
    }
    total = sum(terms.values())
    np.testing.assert_allclose(total, data.qfrc_passive, atol=1e-12)

    dof_names = [model.joint(model.dof_jntid[i]).name for i in range(model.nv)]
    print("passive_force_breakdown: torque [Nm] per dof", dof_names)
    for name, torque in terms.items():
        print(f"  qfrc_{name:<8} {np.array2string(torque, precision=4, sign=' ')}")
    print(f"  {'sum':<13} {np.array2string(total, precision=4, sign=' ')}")
    print(f"  qfrc_passive  {np.array2string(data.qfrc_passive, precision=4, sign=' ')}")
    dominant = max(terms, key=lambda name: abs(terms[name][0]))
    print(f"  dominant term on 'shoulder': {dominant}")


def disable_actuator_groups() -> None:
    """Switch whole sets of actuators on and off at runtime by their group id."""
    # mjOption.disableactuator is a group bitfield, so alternative control modes can live in
    # one model as separate actuator groups instead of being swapped in by rebuilding the
    # model or by manually zeroing ctrl (which still integrates stateful activations).
    xml = """
    <mujoco model="dual_mode_arm">
      <option actuatorgroupdisable="1"/>
      <worldbody>
        <body name="link" pos="0 0 1">
          <joint name="hinge" axis="0 1 0" damping="0.5"/>
          <geom type="capsule" fromto="0 0 0 0.4 0 0" size="0.04" mass="1"/>
        </body>
      </worldbody>
      <actuator>
        <position name="servo" joint="hinge" group="0" kp="40" kv="4" ctrlrange="-1.5 1.5"/>
        <motor name="torque" joint="hinge" group="1" gear="1" ctrlrange="-10 10"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    servo = model.actuator("servo").id
    torque = model.actuator("torque").id
    data.ctrl[servo] = 1.0
    data.ctrl[torque] = 5.0

    def group_bit(group: int) -> int:
        return 1 << group

    modes = {
        "position mode (group 1 off)": group_bit(1),
        "torque mode (group 0 off)": group_bit(0),
        "both groups off": group_bit(0) | group_bit(1),
    }
    print("disable_actuator_groups: ctrl held fixed at servo=1.0, torque=5.0")
    print(f"  compiled-in actuatorgroupdisable bitfield: {model.opt.disableactuator:#04b}")
    for label, disableactuator in modes.items():
        model.opt.disableactuator = disableactuator
        mujoco.mj_resetData(model, data)
        data.ctrl[servo] = 1.0
        data.ctrl[torque] = 5.0
        mujoco.mj_forward(model, data)
        forces = data.actuator_force
        print(
            f"  {label:<28} disableactuator={disableactuator:#04b} "
            f"actuator_force={np.array2string(forces, precision=3, sign=' ')} "
            f"qfrc_actuator={data.qfrc_actuator[0]: .3f} Nm"
        )


def model_from_data() -> None:
    """Write helpers that take only mjData, using the mjData.model back-reference."""
    # mjData now keeps a reference to the model it was created from, so diagnostic and
    # logging helpers no longer need the model threaded through every call site.
    xml = """
    <mujoco model="contact_probe">
      <worldbody>
        <geom name="ground" type="plane" size="3 3 0.1"/>
        <body name="cube" pos="0 0 0.6">
          <freejoint/>
          <geom name="cube_geom" type="box" size="0.1 0.1 0.1" mass="0.5"/>
        </body>
        <body name="ball" pos="0.05 0 1.0">
          <freejoint/>
          <geom name="ball_geom" type="sphere" size="0.08" mass="0.3"/>
        </body>
      </worldbody>
    </mujoco>
    """

    def contact_report(data: mujoco.MjData) -> list[tuple[str, str, float, float]]:
        """Name every contact and its normal force -- no mjModel argument needed."""
        model = data.model
        wrench = np.zeros(6)
        report = []
        for i in range(data.ncon):
            contact = data.contact[i]
            mujoco.mj_contactForce(model, data, i, wrench)
            report.append(
                (
                    model.geom(contact.geom[0]).name,
                    model.geom(contact.geom[1]).name,
                    contact.dist,
                    wrench[0],
                )
            )
        return report

    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    while data.time < 1.5:
        mujoco.mj_step(model, data)

    print(f"model_from_data: data.model is model -> {data.model is model}")
    print(f"  settled at t={data.time:.2f}s with {data.ncon} contacts")
    for geom1, geom2, dist, force_normal in contact_report(data):
        print(f"  {geom1:<10} x {geom2:<10} dist={dist:+.5f} m  normal force={force_normal:6.2f} N")


def mjx_joint_equality() -> None:
    """Run a joint-coupling equality constraint under the MJX Newton solver, batched over worlds."""
    # MJX gained mjEQ_JOINT and the Newton solver here; Newton is the solver to pick for
    # accelerator rollouts, and joint equalities express gearing without a tendon.
    xml = """
    <mujoco model="coupled_fingers">
      <option solver="Newton" iterations="20" ls_iterations="10" timestep="0.002"/>
      <worldbody>
        <body name="proximal" pos="0 0 0.5">
          <joint name="drive" axis="0 1 0" damping="0.05"/>
          <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02" mass="0.2"/>
          <body name="distal" pos="0.2 0 0">
            <joint name="follower" axis="0 1 0" damping="0.05"/>
            <geom type="capsule" fromto="0 0 0 0.15 0 0" size="0.018" mass="0.1"/>
          </body>
        </body>
      </worldbody>
      <equality>
        <!-- follower = 1.5 * drive: a stiff underactuated finger linkage. -->
        <joint joint1="follower" joint2="drive" polycoef="0 1.5 0 0 0"
               solref="0.004 1" solimp="0.99 0.9999 1e-4"/>
      </equality>
      <actuator>
        <motor name="drive_motor" joint="drive" gear="1" ctrlrange="-2 2"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    assert model.opt.solver == mujoco.mjtSolver.mjSOL_NEWTON

    mjx_model = mjx.put_model(model)
    torques = jnp.array([[-0.4], [0.0], [0.4], [0.8]])

    @jax.jit
    @jax.vmap
    def rollout(ctrl: jax.Array) -> jax.Array:
        """Hold a constant drive torque for 100 steps, return the final joint angles."""
        mjx_data = mjx.make_data(mjx_model).replace(ctrl=ctrl)
        mjx_data = jax.lax.fori_loop(0, 100, lambda _, d: mjx.step(mjx_model, d), mjx_data)
        return mjx_data.qpos

    qpos = np.asarray(rollout(torques))
    print(f"mjx_joint_equality: {qpos.shape[0]} worlds on {jax.default_backend()}, 100 steps each")
    for ctrl, (drive, follower) in zip(np.asarray(torques).ravel(), qpos, strict=True):
        print(
            f"  drive torque {ctrl:+.1f} Nm -> drive={drive:+.4f} rad follower={follower:+.4f} rad"
            f"  coupling residual={follower - 1.5 * drive:+.2e} rad"
        )


def main() -> None:
    passive_force_breakdown()
    print()
    disable_actuator_groups()
    print()
    model_from_data()
    print()
    mjx_joint_equality()


if __name__ == "__main__":
    main()
