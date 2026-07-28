# /// script
# dependencies = [
#   "mujoco==3.11.0",
#   "mujoco-mjx==3.11.0",
#   "absl-py",
#   "colorama",
#   "jinja2",
#   "matplotlib",
#   "plotly",
#   "pyyaml",
#   "scipy",
#   "tabulate",
# ]
# ///
"""New in mujoco 3.5.0 (February 12, 2026)."""

import mujoco
import numpy as np
from jax import numpy as jp
from mujoco import mjx, rollout, sysid

DELAYED_SERVO_MJCF = """
<mujoco model="delayed_servo">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.01"/>
  <worldbody>
    <body name="link" pos="0 0 0.5">
      <joint name="hinge" type="hinge" axis="0 1 0" damping="0.5"/>
      <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03"/>
    </body>
  </worldbody>
  <actuator>
    <general name="torque" joint="hinge" gainprm="1"
             nsample="6" delay="0.06" interp="linear"/>
  </actuator>
  <sensor>
    <jointpos name="encoder" joint="hinge" nsample="10" delay="0.05"/>
    <jointvel name="tach" joint="hinge" nsample="6" interval="0.05"/>
  </sensor>
</mujoco>
"""

DEPTH_SENSOR_MJCF = """
<mujoco model="bin_picking">
  <compiler angle="radian" autolimits="true"/>
  <worldbody>
    <geom name="table" type="plane" size="3 3 0.1"/>
    <geom name="ball" type="sphere" pos="0 0 0.25" size="0.25"/>
    <geom name="brick" type="box" pos="0.5 0.2 0.1" size="0.12 0.12 0.1"/>
    <body name="camera_mount" pos="0 0 1.5" mocap="true">
      <camera name="depthcam" resolution="8 6" fovy="60"
              output="rgb depth normal"/>
      <camera name="profilometer" resolution="8 6" fovy="1.0"
              projection="orthographic"/>
    </body>
  </worldbody>
  <sensor>
    <rangefinder name="cloud" camera="depthcam" data="dist point normal depth"/>
    <rangefinder name="profile" camera="profilometer" data="dist origin"/>
  </sensor>
</mujoco>
"""

LIDAR_MJCF = """
<mujoco model="lidar_room">
  <compiler angle="radian" autolimits="true"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <geom name="wall" type="box" pos="0 2 0.5" size="3 0.05 0.5"/>
    <geom name="pillar" type="cylinder" pos="-0.8 0.9 0.5" size="0.2 0.5"/>
    <geom name="crate" type="box" pos="1.1 1.0 0.3" euler="0 0 0.6" size="0.3 0.3 0.3"/>
    <body name="robot" pos="0 0 0.3">
      <site name="scanner" pos="0 0 0"/>
    </body>
  </worldbody>
</mujoco>
"""

CLOTH_MJCF = """
<mujoco model="draped_cloth">
  <option timestep="0.002" integrator="implicitfast"/>
  <worldbody>
    <geom name="floor" type="plane" size="2 2 0.1"/>
    <geom name="dome" type="sphere" pos="0 0 0.2" size="0.2"/>
    <flexcomp name="cloth" type="grid" count="9 9 1" spacing="0.06 0.06 0.06"
              pos="0 0 0.55" dim="2" radius="0.002" mass="0.2">
      <edge equality="vert" damping="0.1"/>
      <contact selfcollide="none" internal="false"/>
    </flexcomp>
  </worldbody>
</mujoco>
"""

SPRING_MASS_MJCF = """
<mujoco model="spring_mass">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002">
    <flag contact="disable"/>
  </option>
  <worldbody>
    <body name="slider" pos="0 0 0.1">
      <inertial pos="0 0 0" mass="1.4" diaginertia="0.001 0.001 0.001"/>
      <joint name="axis" type="slide" axis="1 0 0" stiffness="100" damping="3.5"/>
      <geom type="sphere" size="0.05"/>
    </body>
  </worldbody>
  <actuator>
    <motor name="push" joint="axis"/>
  </actuator>
  <sensor>
    <jointpos name="position" joint="axis"/>
    <jointvel name="velocity" joint="axis"/>
  </sensor>
</mujoco>
"""

MJX_ARM_MJCF = """
<mujoco model="planar_arm">
  <compiler angle="radian" autolimits="true"/>
  <worldbody>
    <body name="upper" pos="0 0 0.5">
      <joint name="shoulder" type="hinge" axis="0 1 0" range="-2 2"/>
      <geom type="capsule" fromto="0 0 0 0.25 0 0" size="0.03"/>
      <site name="anchor" pos="0 0 0"/>
      <body name="fore" pos="0.25 0 0">
        <joint name="elbow" type="hinge" axis="0 1 0" range="-2.5 2.5"/>
        <geom type="capsule" fromto="0 0 0 0.25 0 0" size="0.025"/>
        <site name="tool" pos="0.25 0 0"/>
      </body>
    </body>
  </worldbody>
  <tendon>
    <spatial name="cable">
      <site site="anchor"/>
      <site site="tool"/>
    </spatial>
  </tendon>
  <actuator>
    <position name="shoulder" joint="shoulder" kp="30"/>
    <general name="winch" tendon="cable" gainprm="1"/>
  </actuator>
</mujoco>
"""


def _lag_steps(delayed: np.ndarray, truth: np.ndarray) -> int:
    """Number of steps by which `delayed` reproduces `truth` most exactly."""
    lags = range(len(truth) // 2)
    return min(lags, key=lambda k: np.abs(delayed[k:] - truth[: len(truth) - k]).max())


def actuator_and_sensor_delays() -> None:
    """Give actuators command latency and sensors a slow sampling rate without hand-rolling ring buffers."""
    model = mujoco.MjModel.from_xml_string(DELAYED_SERVO_MJCF)
    data = mujoco.MjData(model)
    torque, encoder, tach = 0, 0, 1

    # nsample allocates the per-element ring buffer inside mjData.history, which
    # is part of the physics state; delay/interp/interval say how it is read.
    print(f"nhistory={model.nhistory} numbers in the state, mjData.history{data.history.shape}")
    print(f"actuator [nsample, interp]={model.actuator_history[torque]} delay={model.actuator_delay[torque]}")
    print(f"sensors  [nsample, interp]=\n{model.sensor_history} delay={model.sensor_delay}")
    print(f"tach interval [period, phase]={model.sensor_interval[tach]}")

    # Seed the command buffer so the actuator holds a bias torque during the
    # first delay window instead of the default zero.
    mujoco.mj_initCtrlHistory(model, data, torque, None, np.full(6, 0.2))

    step_count = 200
    sample_times, ctrl_log, applied_log = [], [], []
    qpos_log, encoder_log, tach_log = [], [], []
    for _ in range(step_count):
        data.ctrl[torque] = 0.2 + 0.5 * data.time
        # Both the actuator and the sensors are evaluated in this step's forward
        # pass, i.e. against the state at the start of the step, so sample the
        # true joint position here rather than after mj_step. Logging it after
        # would add a spurious one-step offset that is an artifact of the
        # logging, not of the delay.
        sample_times.append(data.time)
        qpos_log.append(data.qpos[0])
        mujoco.mj_step(model, data)
        ctrl_log.append(data.ctrl[torque])
        applied_log.append(data.actuator_force[torque])
        encoder_log.append(data.sensor("encoder").data[0])
        tach_log.append(data.sensor("tach").data[0])

    ctrl_log, applied_log = np.array(ctrl_log), np.array(applied_log)
    qpos_log, encoder_log = np.array(qpos_log), np.array(encoder_log)
    # Both elements realise a lag of exactly delay/timestep steps. `delay` is
    # real-valued, but since reading happens before writing, any positive delay
    # costs at least one timestep no matter how small a value is asked for.
    print(f"applied torque lags ctrl by {_lag_steps(applied_log, ctrl_log)} steps of {model.opt.timestep} s")
    print(f"encoder lags true joint position by {_lag_steps(encoder_log, qpos_log)} steps")
    print(f"tach updated {len(set(np.round(tach_log, 12)))} times in {step_count} steps (period 0.05 s)")

    # mj_readCtrl / mj_readSensor expose the buffer directly; both subtract the
    # element's own delay from the time argument, so passing data.time returns
    # exactly what the engine is reading, and passing tau + delay probes the
    # buffer at absolute time tau. interp=-1 uses the interp set in the model.
    print(f"engine is applying ctrl={mujoco.mj_readCtrl(model, data, torque, data.time, -1):.4f}"
          f" while ctrl={data.ctrl[torque]:.4f} was commanded")
    for tau in (data.time - 0.05, data.time - 0.025):
        zoh = mujoco.mj_readCtrl(model, data, torque, tau + model.actuator_delay[torque], 0)
        linear = mujoco.mj_readCtrl(model, data, torque, tau + model.actuator_delay[torque], 1)
        print(f"  buffered ctrl at t={tau:.3f}: zoh={zoh:.4f} linear={linear:.4f} commanded={0.2 + 0.5 * tau:.4f}")
    reading = np.zeros(model.sensor(encoder).dim)
    tau = data.time - 0.035
    mujoco.mj_readSensor(model, data, encoder, tau + model.sensor_delay[encoder], reading, 1)
    print(f"buffered encoder at t={tau:.3f}: {reading[0]:.6f} "
          f"vs logged joint position "
          f"{np.interp(tau, sample_times, qpos_log):.6f}")


def rangefinder_camera_scan() -> None:
    """Get a full range image out of the physics engine by attaching a rangefinder to a camera."""
    model = mujoco.MjModel.from_xml_string(DEPTH_SENSOR_MJCF)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    depthcam = model.camera("depthcam").id
    width, height = model.cam_resolution[depthcam]
    projections = [mujoco.mjtProjection(p).name for p in model.cam_projection]
    print(f"cameras {projections}, resolution {width}x{height}")

    # A camera rangefinder casts one ray per pixel and can return several fields
    # per ray, so a depth+normal image no longer needs a hand-written mj_ray loop.
    # (The old cam_orthographic flag is now cam_projection, an mjtProjection.)
    cloud = data.sensor("cloud").data.reshape(height, width, 8)
    distance, point, normal, depth = (
        cloud[..., 0],
        cloud[..., 1:4],
        cloud[..., 4:7],
        cloud[..., 7],
    )
    print("range image (distance from camera origin):\n", distance.round(3))
    print("depth image (distance from camera plane):\n", depth.round(3))
    hit = distance > 0
    print(f"{hit.sum()}/{hit.size} rays hit; hit points span z in "
          f"[{point[hit][:, 2].min():.3f}, {point[hit][:, 2].max():.3f}]")
    tilt = np.degrees(np.arccos(np.clip(normal[hit] @ np.array([0.0, 0.0, 1.0]), -1, 1)))
    print(f"surface tilt from horizontal: min={tilt.min():.1f} deg max={tilt.max():.1f} deg")

    # Orthographic cameras spread the ray origins over the image plane, which is
    # what a line-scan profilometer does; "origin" reports where each ray started.
    profile = data.sensor("profile").data.reshape(height, width, 4)
    print("orthographic ray origins, first row (x):", profile[0, :, 1].round(3))
    print("orthographic distance, centre row:", profile[height // 2, :, 0].round(3))

    # cam_output is a free-form mjtCamOutBit annotation the renderer ignores;
    # it is where a model declares which image types a camera is meant to serve.
    bits = [
        name
        for name, bit in mujoco.mjtCamOutBit.__members__.items()
        if name.startswith("mjCAMOUT_") and model.cam_output[depthcam] & bit
    ]
    print("depthcam advertises outputs:", bits)


def raycast_with_normals() -> None:
    """Sweep a planar lidar and get surface normals back from the same ray cast."""
    model = mujoco.MjModel.from_xml_string(LIDAR_MJCF)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    scanner = model.site("scanner").id
    pos_World_Scanner = data.site_xpos[scanner]
    nray = 24
    bearings = np.linspace(-0.6, 0.6, nray)
    vec_World_Rays = np.stack(
        [np.sin(bearings), np.cos(bearings), np.zeros(nray)], axis=1
    ).ravel()

    # mj_multiRay batches the whole sweep; `normal` is a required argument here,
    # unlike mj_ray / mj_rayFlex where it defaults to None.
    distance = np.zeros(nray)
    geomid = np.zeros(nray, np.int32)
    normal_World = np.zeros(3 * nray)
    mujoco.mj_multiRay(
        model,
        data,
        pos_World_Scanner,
        vec_World_Rays,
        None,  # geomgroup: None scans every group
        True,  # flg_static: include the floor and walls
        model.body("robot").id,  # exclude the robot's own geoms
        geomid,
        distance,
        normal_World,
        nray,
        10.0,  # cutoff [m]
    )
    normal_World = normal_World.reshape(nray, 3)
    direction = vec_World_Rays.reshape(nray, 3)

    hit = distance > 0
    incidence = np.degrees(
        np.arccos(np.clip(-np.einsum("ij,ij->i", direction[hit], normal_World[hit]), -1, 1))
    )
    names = [model.geom(gid).name for gid in geomid[hit]]
    print(f"{hit.sum()}/{nray} returns, range {distance[hit].min():.3f}-{distance[hit].max():.3f} m")
    print(f"hit geoms: {sorted(set(names))}")
    print(f"incidence angle: min={incidence.min():.1f} deg max={incidence.max():.1f} deg")

    # mj_ray takes the same optional normal, for one-off probes.
    forward_geom = np.zeros(1, np.int32)
    forward_normal = np.zeros(3)
    forward_distance = mujoco.mj_ray(
        model,
        data,
        pos_World_Scanner,
        np.array([0.0, 1.0, 0.0]),
        None,
        True,
        model.body("robot").id,
        forward_geom,
        forward_normal,
    )
    wall = model.geom(forward_geom[0]).name
    print(f"straight ahead: {forward_distance:.3f} m to '{wall}', normal {forward_normal.round(3)}")


def cloth_flexvert_equality() -> None:
    """Simulate cloth on a coarse mesh by constraining vertex positions rather than every edge length."""
    model = mujoco.MjModel.from_xml_string(CLOTH_MJCF)
    data = mujoco.MjData(model)

    # flexvert equality (MJCF: <edge equality="vert"/>) constrains vertex
    # positions instead of the per-edge lengths the older `flex` equality used,
    # so a coarse mesh stays inextensible and drapes like cloth.
    eq_names = [mujoco.mjtEq(eq_type).name for eq_type in model.eq_type]
    print(f"neq={eq_names} vertices={model.flex_vertnum[0]} edges={model.flex_edgenum[0]}")

    vertices = slice(model.flex_vertadr[0], model.flex_vertadr[0] + model.flex_vertnum[0])
    mujoco.mj_forward(model, data)
    rest = data.flexvert_xpos[vertices].copy()
    rest_span = np.ptp(rest[:, :2], axis=0)
    print(f"equality rows: ne={data.ne} of nefc={data.nefc}")

    mujoco.mj_step(model, data, nstep=1500)

    draped = data.flexvert_xpos[vertices]
    print(f"cloth footprint {rest_span.round(4)} -> {np.ptp(draped[:, :2], axis=0).round(4)} m")
    print(f"lowest vertex fell from {rest[:, 2].min():.3f} to {draped[:, 2].min():.3f} m")
    print(f"highest vertex rests at {draped[:, 2].max():.3f} m (dome top is 0.4 m)")


def system_identification() -> None:
    """Fit physical parameters of a model to recorded sensor data with the sysid toolbox."""
    # Pretend this rollout is a log from real hardware: mass 1.4 kg, damping 3.5.
    truth_spec = mujoco.MjSpec.from_string(SPRING_MASS_MJCF)
    truth_model = truth_spec.compile()
    truth_data = mujoco.MjData(truth_model)
    times = np.arange(1500) * truth_model.opt.timestep
    ctrl = (5.0 * np.sin(2 * np.pi * 1.5 * times) + 3.0 * np.sin(2 * np.pi * 3.7 * times))
    initial_state = sysid.create_initial_state(
        truth_model, truth_data.qpos, truth_data.qvel, truth_data.act
    )
    state, sensordata = rollout.rollout(
        truth_model, truth_data, initial_state, ctrl[:-1].reshape(1, -1, 1)
    )
    measured = sysid.TimeSeries.from_names(state[0, :, 0], sensordata[0], truth_model)

    # Parameters are named, bounded, and applied to an MjSpec by a callback;
    # the toolbox builds the residual and runs Gauss-Newton over batched rollouts.
    def set_mass(spec: mujoco.MjSpec, parameter: sysid.Parameter) -> None:
        spec.body("slider").mass = parameter.value[0]

    def set_damping(spec: mujoco.MjSpec, parameter: sysid.Parameter) -> None:
        spec.joint("axis").damping = [parameter.value[0], 0.0, 0.0]

    params = sysid.ParameterDict()
    params.add(sysid.Parameter(
        "mass", nominal=1.0, min_value=0.3, max_value=3.0, modifier=set_mass,
    ))
    params.add(sysid.Parameter(
        "damping", nominal=1.0, min_value=0.1, max_value=10.0, modifier=set_damping,
    ))
    params["mass"].value[:] = 2.5
    params["damping"].value[:] = 1.0

    sequences = sysid.ModelSequences(
        "spring_mass",
        mujoco.MjSpec.from_string(SPRING_MASS_MJCF),
        "sine_sweep",
        initial_state,
        sysid.TimeSeries(times, ctrl.reshape(-1, 1)),
        measured,
    )
    residual_fn = sysid.build_residual_fn(models_sequences=[sequences])
    opt_params, opt_result = sysid.optimize(
        initial_params=params,
        residual_fn=residual_fn,
        optimizer="mujoco",
        verbose=False,
        max_iters=50,
    )

    objective = opt_result.extras["objective"]
    print(f"start:     mass=2.500 damping=1.000, objective={objective[0]:.4e}")
    print(f"recovered: mass={opt_params['mass'].value[0]:.4f} "
          f"damping={opt_params['damping'].value[0]:.4f}, objective={objective[-1]:.4e}")
    print("truth:     mass=1.4000 damping=3.5000")


def mjx_smooth_dynamics_fields() -> None:
    """Read transmission lengths and com-based motion axes straight off mjx.Data instead of recomputing them."""
    model = mujoco.MjModel.from_xml_string(MJX_ARM_MJCF)
    model_mjx = mjx.put_model(model)
    data_mjx = mjx.make_data(model_mjx)
    data_mjx = data_mjx.replace(qpos=jp.array([0.3, -1.2]))
    data_mjx = mjx.forward(model_mjx, data_mjx)

    # actuator_length, cdof and cdof_dot are now carried on mjx.Data, so
    # transmission and Jacobian-style terms can be read rather than rebuilt.
    print(f"impl={data_mjx.impl.name} nv={model.nv} nu={model.nu}")
    print(f"actuator_length={np.asarray(data_mjx.actuator_length).round(5)} "
          f"(joint transmission, then tendon length)")
    print(f"cdof{data_mjx.cdof.shape} com-based motion axes:\n{np.asarray(data_mjx.cdof).round(4)}")
    print(f"cdof_dot{data_mjx.cdof_dot.shape} max magnitude at rest: "
          f"{np.abs(np.asarray(data_mjx.cdof_dot)).max():.3e}")

    # The CPU pipeline agrees, which is what makes these usable as MJX targets.
    data = mujoco.MjData(model)
    data.qpos[:] = [0.3, -1.2]
    mujoco.mj_forward(model, data)
    print(f"matches mjData.actuator_length: "
          f"{np.allclose(data_mjx.actuator_length, data.actuator_length, atol=1e-6)}")


def main() -> None:
    actuator_and_sensor_delays()
    print()
    rangefinder_camera_scan()
    print()
    raycast_with_normals()
    print()
    cloth_flexvert_equality()
    print()
    system_identification()
    print()
    mjx_smooth_dynamics_fields()


if __name__ == "__main__":
    main()
