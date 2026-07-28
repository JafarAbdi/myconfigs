# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.3.2 (April 28, 2025)."""

import jax
import jax.numpy as jp
import mujoco
import numpy as np
from mujoco import mjx

_ARM_XML = """
<mujoco>
  <option timestep="0.002"/>
  <worldbody>
    <body name="upper" pos="0 0 1">
      <joint name="shoulder" type="hinge" axis="0 1 0"/>
      <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".04" mass="1.2"/>
      <body name="lower" pos="0 0 -.3">
        <joint name="elbow" type="hinge" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".03" mass=".7"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <motor name="shoulder" joint="shoulder"/>
    <motor name="elbow" joint="elbow"/>
  </actuator>
</mujoco>"""


def mjx_inverse_dynamics() -> None:
    """Get the feedforward torque for a reference trajectory, batched on the MJX backend."""
    model = mujoco.MjModel.from_xml_string(_ARM_XML)
    model_mjx = mjx.put_model(model)

    # A smooth reference trajectory for both joints, sampled at the control rate.
    t = np.arange(0.0, 1.0, model.opt.timestep)
    qpos = np.stack([0.6 * np.sin(2 * np.pi * t), -0.9 + 0.4 * np.cos(2 * np.pi * t)], axis=1)
    qvel = np.gradient(qpos, model.opt.timestep, axis=0)
    qacc = np.gradient(qvel, model.opt.timestep, axis=0)

    # mjx.inverse is the MJX counterpart of mj_inverse: it runs the position and velocity
    # stages itself and fills qfrc_inverse from (qpos, qvel, qacc), so the whole trajectory
    # can be solved in one vmapped, jitted call. Build the template mjx.Data once outside
    # and .replace() the state inside, the way the MJX tutorial batches over initial states.
    data_mjx = mjx.make_data(model_mjx)

    def torque(qpos: jax.Array, qvel: jax.Array, qacc: jax.Array) -> jax.Array:
        state = data_mjx.replace(qpos=qpos, qvel=qvel, qacc=qacc)
        return mjx.inverse(model_mjx, state).qfrc_inverse

    qfrc_inverse = jax.jit(jax.vmap(torque))(jp.array(qpos), jp.array(qvel), jp.array(qacc))

    data = mujoco.MjData(model)
    qfrc_reference = np.empty_like(qpos)
    for i in range(len(t)):
        data.qpos[:], data.qvel[:], data.qacc[:] = qpos[i], qvel[i], qacc[i]
        mujoco.mj_inverse(model, data)
        qfrc_reference[i] = data.qfrc_inverse

    print(f"{len(t)} states solved in one call, qfrc_inverse shape {qfrc_inverse.shape}")
    print(f"peak |torque| = {np.abs(np.asarray(qfrc_inverse)).max(axis=0).round(4)} N*m")
    print(f"max |mjx - mj_inverse| = {np.abs(np.asarray(qfrc_inverse) - qfrc_reference).max():.2e}")

    # Round-trip check: feeding the torque back through forward dynamics reproduces qacc.
    data.qpos[:], data.qvel[:] = qpos[0], qvel[0]
    data.qfrc_applied[:] = qfrc_reference[0]
    mujoco.mj_forward(model, data)
    print(f"round-trip qacc error = {np.abs(data.qacc - qacc[0]).max():.2e}")


def mjx_tendon_actuator_force_sensor() -> None:
    """Read the clamped total actuator force on a tendon from inside a jitted MJX rollout."""
    xml = """
    <mujoco>
      <option timestep="0.002"/>
      <worldbody>
        <site name="drum" pos="0 0 1.2"/>
        <body name="load" pos="0 0 .4">
          <joint name="hoist" type="slide" axis="0 0 1" range="0 .8"/>
          <geom type="box" size=".08 .08 .08" mass="5"/>
          <site name="hook" pos="0 0 .08"/>
        </body>
      </worldbody>
      <tendon>
        <spatial name="rope" actuatorfrclimited="true" actuatorfrcrange="-120 0">
          <site site="drum"/>
          <site site="hook"/>
        </spatial>
      </tendon>
      <actuator>
        <motor name="winch_a" tendon="rope" gear="1" ctrlrange="-200 0"/>
        <motor name="winch_b" tendon="rope" gear="1" ctrlrange="-200 0"/>
      </actuator>
      <sensor><tendonactuatorfrc name="rope_frc" tendon="rope"/></sensor>
    </mujoco>"""
    model = mujoco.MjModel.from_xml_string(xml)
    model_mjx = mjx.put_model(model)
    step = jax.jit(mjx.step)

    # tendonactuatorfrc reports the SUM of every actuator force on the tendon, after the
    # tendon's own actuatorfrcrange clamp - MJX gained this sensor in 3.3.2.
    for commanded in (-40.0, -200.0):
        data_mjx = mjx.make_data(model_mjx).replace(ctrl=jp.full(model.nu, commanded))
        data_mjx = step(model_mjx, data_mjx)
        data = mujoco.MjData(model)
        data.ctrl[:] = commanded
        mujoco.mj_step(model, data)
        print(
            f"ctrl={commanded:7.1f} N each -> mjx sensor={float(data_mjx.sensordata[0]):7.1f} N"
            f"  c sensor={data.sensor('rope_frc').data[0]:7.1f} N"
            f"  (range {model.tendon_actfrcrange[0]})"
        )


def main() -> None:
    for demo in (mjx_inverse_dynamics, mjx_tendon_actuator_force_sensor):
        print(f"\n=== {demo.__name__}: {demo.__doc__}")
        demo()


if __name__ == "__main__":
    main()
