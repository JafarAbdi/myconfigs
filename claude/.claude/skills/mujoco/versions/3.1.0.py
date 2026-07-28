# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.1.0 (December 12, 2023)."""

import jax
import mujoco
import numpy as np
from mujoco import mjx

# <frame> applies a pose to its direct children and then disappears. Grouping geoms used
# to mean inventing a massless body, which added a kinematic node you did not want.
FRAME_XML = """
<mujoco model="frames">
  <compiler angle="radian"/>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="mount" pos="0 0 .4">
      <freejoint/>
      <geom name="base" type="box" size=".1 .1 .02" mass="1"/>

      <frame name="sensor_head" pos=".1 0 .05" euler="0 .5 0">
        <geom name="housing" type="box" size=".03 .02 .02" mass=".05"/>
        <site name="camera" pos=".03 0 0" size=".005"/>
        <!-- Frames nest: this one composes with sensor_head. -->
        <frame pos=".06 0 .01" euler="0 0 1.5708">
          <site name="lens_axis" size=".004"/>
        </frame>
      </frame>
    </body>
  </worldbody>
</mujoco>
"""

# A native position servo cannot hold a constant load without steady-state droop; the pid
# plugin adds the integral term MuJoCo's built-in actuators do not have.
PID_XML = """
<mujoco model="pid_actuator">
  <compiler angle="radian"/>
  <option timestep=".002" integrator="implicitfast"/>

  <extension>
    <plugin plugin="mujoco.pid">
      <instance name="pid">
        <config key="kp" value="200"/>
        <config key="ki" value="150"/>
        <config key="kd" value="30"/>
        <config key="imax" value="60"/>
        <config key="slewmax" value="2"/>
      </instance>
    </plugin>
  </extension>

  <default>
    <joint type="slide" axis="0 0 1" range="-.5 .5" damping=".2"/>
    <geom type="sphere" size=".04" mass="2"/>
  </default>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="pd_lift" pos="0 -.2 .5">
      <joint name="pd_lift"/>
      <geom/>
    </body>
    <body name="pid_lift" pos="0 .2 .5">
      <joint name="pid_lift"/>
      <geom/>
    </body>
  </worldbody>

  <actuator>
    <!-- kv is the actuator-applied damping term: a PD controller with zero reference
         velocity, best paired with the implicitfast or implicit integrators. -->
    <position name="pd" joint="pd_lift" kp="200" kv="30" ctrlrange="-.5 .5"/>
    <!-- actdim = 2: the integral term plus the slew-limited setpoint. -->
    <plugin name="pid" joint="pid_lift" plugin="mujoco.pid" instance="pid"
            actdim="2" ctrlrange="-.5 .5"/>
  </actuator>
</mujoco>
"""

MJX_XML = """
<mujoco model="mjx_roundtrip">
  <compiler angle="radian"/>

  <worldbody>
    <light pos="0 0 2"/>
    <geom name="floor" type="plane" size="2 2 .05"/>
    <body name="upper" pos="0 0 .6">
      <joint name="shoulder" type="hinge" axis="0 1 0"/>
      <geom type="capsule" fromto="0 0 0 .25 0 0" size=".03" mass="1"/>
      <body name="lower" pos=".25 0 0">
        <joint name="elbow" type="hinge" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 .2 0 0" size=".025" mass=".6"/>
        <site name="tool" pos=".2 0 0" size=".01"/>
      </body>
    </body>
  </worldbody>

  <actuator>
    <motor name="shoulder" joint="shoulder" ctrlrange="-5 5"/>
    <motor name="elbow" joint="elbow" ctrlrange="-5 5"/>
  </actuator>
</mujoco>
"""


def frame_transform() -> None:
    """Apply a pose to a group of children without paying for an extra body."""
    model = mujoco.MjModel.from_xml_string(FRAME_XML)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    # Only world + mount: the frames left no trace in the kinematic tree, so nv, the mass
    # matrix and the contact graph are exactly what they would be without the grouping.
    body_names = [model.body(i).name for i in range(model.nbody)]
    print(f"  nbody={model.nbody} {body_names}, nv={model.nv}")

    # The compiler bakes the frame pose into each child's local pose.
    housing_id = model.geom("housing").id
    print(f"  housing local pos={np.array2string(model.geom_pos[housing_id], precision=4)}"
          f" quat={np.array2string(model.geom_quat[housing_id], precision=4)}")
    for name in ("camera", "lens_axis"):
        site_id = model.site(name).id
        print(f"  site {name:<10} body={model.body(model.site_bodyid[site_id]).name}"
              f" world pos={np.array2string(data.site_xpos[site_id], precision=4)}")

    # Nested frames compose: the outer 0.5 rad about y and the inner 90 deg about z.
    rmat_World_Lens = data.site_xmat[model.site("lens_axis").id].reshape(3, 3)
    for axis, column in zip("xyz", rmat_World_Lens.T):
        print(f"  lens {axis}-axis in world = {np.array2string(column, precision=4)}")


def pid_actuator_plugin() -> None:
    """Drive a joint with a true PID controller, including the integral term."""
    model = mujoco.MjModel.from_xml_string(PID_XML)
    data = mujoco.MjData(model)

    # A stateful actuator plugin chooses where its state lives: mjData.plugin_state, or
    # mjData.act by implementing mjpPlugin.actuator_act_dot. mujoco.pid takes the latter, so
    # the error integral and the slew-limited setpoint are ordinary activation variables --
    # saved, restored, rolled out and finite-differenced by the normal state machinery.
    pid_id = model.actuator("pid").id
    act_adr = model.actuator_actadr[pid_id]
    print(f"  na={model.na}, pid act slice starts at {act_adr}"
          f" with {model.actuator_actnum[pid_id]} variables")

    setpoint = 0.3
    data.ctrl[:] = setpoint
    mujoco.mj_step(model, data, nstep=5000)

    # Both joints carry the same 2 kg against gravity. The P-only servo settles wherever
    # kp * error balances the weight; the PID integrates that error away.
    pd_error = data.qpos[0] - setpoint
    pid_error = data.qpos[1] - setpoint
    print(f"  t={data.time:.1f}s  position servo error={pd_error:+.5f} m")
    print(f"  t={data.time:.1f}s  pid plugin error   ={pid_error:+.5f} m")
    error_integral, slewed_setpoint = data.act
    print(f"  pid act = [error_integral={error_integral:.4f}, setpoint={slewed_setpoint:.4f}]")
    print(f"  actuator force: pd={data.actuator_force[0]:+.3f} N,"
          f" pid={data.actuator_force[pid_id]:+.3f} N (weight is 19.62 N)")


def mjx_device_roundtrip() -> None:
    """Move a model and a full mjData to device, step there, and read the result back."""
    mj_model = mujoco.MjModel.from_xml_string(MJX_XML)
    mj_data = mujoco.MjData(mj_model)
    mj_data.qpos[:] = [0.4, -0.8]
    mj_data.ctrl[:] = [0.5, -0.2]
    mujoco.mj_forward(mj_model, mj_data)

    # put_model / put_data / get_data replaced device_put and device_get_into: unlike the
    # old pair they carry derived quantities (efc_J, contacts, site frames) across the
    # boundary, so a device rollout can be seeded from a host state mid-episode.
    model = mjx.put_model(mj_model)
    data = mjx.put_data(mj_model, mj_data)

    tool_id = mj_model.site("tool").id
    print(f"  host site_xpos  {np.array2string(mj_data.site_xpos[tool_id], precision=6)}")
    print(f"  device site_xpos {np.array2string(np.asarray(data.site_xpos)[tool_id], precision=6)}")

    # Compile once, then step on device; the host copy tracks the same trajectory.
    step = jax.jit(mjx.step)
    for _ in range(20):
        data = step(model, data)
        mujoco.mj_step(mj_model, mj_data)

    # get_data allocates a fresh MjData; get_data_into fills one you already own, which is
    # what you want inside a viewer or logging loop.
    device_result = mjx.get_data(mj_model, data)
    print(f"  after 20 steps: host qpos   {np.array2string(mj_data.qpos, precision=6)}")
    print(f"  after 20 steps: device qpos {np.array2string(device_result.qpos, precision=6)}")

    readback = mujoco.MjData(mj_model)
    mjx.get_data_into(readback, mj_model, data)
    print(f"  get_data_into tool pos {np.array2string(readback.site_xpos[tool_id], precision=6)}")
    print(f"  agrees with host: {np.allclose(readback.qpos, mj_data.qpos, atol=1e-6)}")


def main() -> None:
    print("frame_transform:")
    frame_transform()
    print("pid_actuator_plugin:")
    pid_actuator_plugin()
    print("mjx_device_roundtrip:")
    mjx_device_roundtrip()


if __name__ == "__main__":
    main()
