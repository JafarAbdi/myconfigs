# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.7.0 (April 14, 2026)."""

import mujoco
import numpy as np

# Datasheet for a small brushed gearmotor: 24 V nominal, 0.35 N*m stall torque,
# 700 rad/s no-load speed, driving a wheel through a 20:1 gearbox.
VOLTAGE_NOMINAL = 24.0
TORQUE_STALL = 0.35
SPEED_NO_LOAD = 700.0
GEAR_RATIO = 20.0

DCMOTOR_XML = f"""
<mujoco model="wheel_drive">
  <option timestep="0.0005"/>
  <worldbody>
    <body name="wheel" pos="0 0 0.3">
      <joint name="axle" axis="0 1 0" damping="0.01"/>
      <geom type="cylinder" size="0.1 0.02" quat="0.7071 0.7071 0 0" mass="0.6"/>
    </body>
  </worldbody>
  <actuator>
    <dcmotor name="drive" joint="axle" gear="{GEAR_RATIO}"
             nominal="{VOLTAGE_NOMINAL} {TORQUE_STALL} {SPEED_NO_LOAD}"
             armature="3e-5"
             saturation="{TORQUE_STALL} 0 0"
             inductance="0 0.003"
             thermal="2.5 12 0 0.0039 25 25"
             cogging="0.005 12 0"
             ctrlrange="-{VOLTAGE_NOMINAL} {VOLTAGE_NOMINAL}"/>
  </actuator>
</mujoco>
"""


def dcmotor_actuator() -> None:
    """Drive a joint from motor datasheet numbers instead of a hand-tuned torque source."""
    # A <dcmotor> takes electrical parameters, not gain/bias triplets: `nominal`
    # gives the compiler (voltage, stall torque, no-load speed) and it derives the
    # motor constant K and terminal resistance R. This is the modelled replacement
    # for approximating a motor with <motor> plus a manual torque-speed curve.
    model = mujoco.MjModel.from_xml_string(DCMOTOR_XML)
    data = mujoco.MjData(model)

    # Each optional subsystem adds one activation variable, allocated in this
    # fixed order: controller slewmax -> previous control, controller ki ->
    # integral, thermal -> winding temperature rise, lugre -> bristle deflection,
    # inductance -> armature current. Cogging and saturation are stateless.
    # Only thermal and inductance are on here, so they take the first two slots.
    # A slot exists only when its own sub-parameter is positive, so adding
    # `controller` slewmax or ki below would push both of these along.
    act_adr = model.actuator_actadr[0]
    temperature_index, current_index = act_adr, act_adr + 1

    data.ctrl[0] = VOLTAGE_NOMINAL  # ctrl is terminal voltage in the default input mode.
    torque_peak = 0.0
    for _ in range(4000):
        mujoco.mj_step(model, data)
        torque_peak = max(torque_peak, data.actuator_force[0] * GEAR_RATIO)

    resistance, motor_constant = model.actuator_gainprm[0][:2]
    print(f"dcmotor_actuator: compiler derived K={motor_constant:.4f} N*m/A, "
          f"R={resistance:.2f} ohm; "
          f"na={model.na} activations; at {VOLTAGE_NOMINAL:.0f} V the axle settles at "
          f"{data.qvel[0]:.1f} rad/s (ideal no-load {SPEED_NO_LOAD / GEAR_RATIO:.1f}), "
          f"current={data.act[current_index]:.2f} A, "
          f"winding +{data.act[temperature_index]:.2f} K; peak axle torque during spin-up="
          f"{torque_peak:.2f} N*m (saturation caps it at "
          f"{TORQUE_STALL * GEAR_RATIO:.1f} N*m)")

    # The MjSpec equivalent, for models built in Python. K and R can be given
    # directly instead of via `nominal`; input_mode 1/2 (position/velocity) turns
    # on the built-in PID, configured through `controller`.
    spec = mujoco.MjSpec.from_string(DCMOTOR_XML)
    spec.actuators[0].set_to_dcmotor(
        motorconst=[motor_constant, motor_constant],
        resistance=resistance,
        saturation=[TORQUE_STALL, 0, 0],
        inductance=[0, 0.003],
        thermal=[2.5, 12, 0, 0.0039, 25, 25],
        cogging=[0.005, 12, 0],
    )
    rebuilt = spec.compile()
    print(f"  set_to_dcmotor reproduces the MJCF actuator: "
          f"{np.allclose(rebuilt.actuator_gainprm, model.actuator_gainprm)}, "
          f"forcerange={rebuilt.actuator_forcerange[0]} N*m (set by saturation)")


def reflected_armature_and_damping() -> None:
    """Declare rotor inertia and viscous damping on the actuator and let gear^2 do the scaling."""
    gear_ratio = 100.0
    rotor_inertia = 3e-5  # kg*m^2, on the motor side of the gearbox.
    viscous = 1e-4  # N*m*s/rad, on the motor side of the gearbox.

    def build(joint_attributes: str,
              actuator_attributes: str) -> tuple[mujoco.MjModel, mujoco.MjData]:
        xml = f"""
        <mujoco>
          <option timestep="0.001"/>
          <worldbody>
            <body pos="0 0 0.5">
              <joint name="elbow" axis="0 1 0" {joint_attributes}/>
              <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="1.2"/>
            </body>
          </worldbody>
          <actuator>
            <motor name="drive" joint="elbow" gear="{gear_ratio}" {actuator_attributes}/>
          </actuator>
        </mujoco>
        """
        model = mujoco.MjModel.from_xml_string(xml)
        data = mujoco.MjData(model)
        data.qvel[0] = 1.5
        data.ctrl[0] = 0.02
        return model, data

    # The actuator now owns the motor's own inertia and damping, and MuJoCo reflects
    # them through the transmission. This replaces hand-computing the joint-side
    # values (armature = rotor_inertia * gear**2) and keeping them in sync by hand
    # whenever the gear ratio changes.
    model_actuator, data_actuator = build("", f'armature="{rotor_inertia}" damping="{viscous}"')
    model_joint, data_joint = build(
        f'armature="{rotor_inertia * gear_ratio**2}" damping="{viscous * gear_ratio**2}"', ""
    )

    for _ in range(500):
        mujoco.mj_step(model_actuator, data_actuator)
        mujoco.mj_step(model_joint, data_joint)

    print(f"reflected_armature_and_damping: actuator armature="
          f"{model_actuator.actuator_armature[0]:.1e} kg*m^2 with gear={gear_ratio:.0f} "
          f"behaves as joint armature={model_joint.dof_armature[0]:.2f} kg*m^2 "
          f"(dof_armature stays {model_actuator.dof_armature[0]:.0f}, "
          f"the reflection happens in M); "
          f"trajectories identical={np.allclose(data_actuator.qpos, data_joint.qpos)}, "
          f"qpos={data_actuator.qpos[0]:.6f} rad")


def polynomial_stiffness_and_damping() -> None:
    """Model progressive springs and quadratic (fluid) damping without a custom force callback."""
    stiffness = (8_000.0, 90_000.0, 400_000.0)  # N/m, N/m^2, N/m^3
    damping = (300.0, 900.0, 0.0)  # N*s/m, N*s^2/m^2, N*s^3/m^3

    # Joint and tendon stiffness/damping are polynomials since 3.7.0, so bump stops
    # and fluid drag no longer need an mjcb_passive callback. The first coefficient
    # is the old scalar; mjNPOLY says how many higher-order terms follow. Stiffness
    # is the plain polynomial a*x + b*x^2 + c*x^3 (asymmetric on purpose: stiffer in
    # compression than in droop), damping is anti-symmetrized: a*v + b*v|v| + c*v^3.
    xml = f"""
    <mujoco model="suspension">
      <option timestep="0.001"/>
      <worldbody>
        <body name="hub" pos="0 0 0.4">
          <joint name="travel" type="slide" axis="0 0 1" limited="true" range="-0.15 0.15"
                 stiffness="{" ".join(map(str, stiffness))}"
                 damping="{" ".join(map(str, damping))}"/>
          <geom type="box" size="0.12 0.06 0.06" mass="45"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    assert model.jnt_stiffness[0] == stiffness[0]  # Linear coefficient, as before.
    np.testing.assert_allclose(model.jnt_stiffnesspoly[0], stiffness[1:])
    np.testing.assert_allclose(model.dof_dampingpoly[0], damping[1:])

    def spring_force(deflection: float) -> float:
        data.qpos[0] = deflection
        data.qvel[0] = 0.0
        mujoco.mj_forward(model, data)
        return data.qfrc_spring[0]

    def damper_force(velocity: float) -> float:
        data.qpos[0] = 0.0
        data.qvel[0] = velocity
        mujoco.mj_forward(model, data)
        return data.qfrc_damper[0]

    deflections = np.array([-0.14, -0.02, 0.02, 0.14])
    velocities = np.array([-1.5, 1.5])
    spring = np.array([spring_force(x) for x in deflections])
    damper = np.array([damper_force(v) for v in velocities])
    spring_expected = -sum(k * deflections ** (i + 1) for i, k in enumerate(stiffness))
    damper_expected = -sum(b * velocities * abs(velocities) ** i for i, b in enumerate(damping))

    # MjSpec side: the scalar fields became mjNPOLY+1 arrays in 3.7.0, so what used
    # to be `joint.stiffness = value` is now `joint.stiffness[0] = value`.
    spec = mujoco.MjSpec.from_string(xml)
    joint = spec.joints[0]
    joint.stiffness[0] = 12_000.0
    joint.stiffness[1:] = 0.0
    linearized = spec.compile()

    print(f"polynomial_stiffness_and_damping: mjNPOLY={mujoco.mjNPOLY} higher-order coefficients; "
          f"spring force at {deflections} m = {np.round(spring)} N vs "
          f"{np.round(-stiffness[0] * deflections)} N for the linear spring alone "
          f"(profile matches: {np.allclose(spring, spring_expected)}); "
          f"damper force at {velocities} m/s = {np.round(damper)} N, odd in v: "
          f"{np.allclose(damper, damper_expected)}; "
          f"MjSpec override -> jnt_stiffness={linearized.jnt_stiffness[0]:.0f}, "
          f"jnt_stiffnesspoly={linearized.jnt_stiffnesspoly[0]}")


def main() -> None:
    dcmotor_actuator()
    reflected_armature_and_damping()
    polynomial_stiffness_and_damping()


if __name__ == "__main__":
    main()
