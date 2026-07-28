# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.0.0 (October 18, 2023)."""

import jax
import jax.numpy as jnp
import mujoco
import numpy as np
from mujoco import mjx


def mjx_batched_rollout() -> None:
    """Simulate many worlds at once on an accelerator with MJX and jax.vmap."""
    # MJX is the JAX reimplementation of the engine: the same MJCF, compiled by the same
    # compiler, then stepped under jit/vmap. One mjx.Data is broadcast into a batch of
    # worlds and vmap runs them in lockstep; mujoco.rollout is the threaded CPU alternative.
    xml = """
    <mujoco model="tumbling_box">
      <option timestep="0.004" iterations="10" ls_iterations="10"/>
      <worldbody>
        <geom name="floor" type="plane" size="5 5 0.1"/>
        <body name="box" pos="0 0 0.5">
          <freejoint/>
          <geom type="box" size="0.1 0.1 0.1" mass="0.4" friction="0.6 0.005 0.0001"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)

    mjx_model = mjx.put_model(model)
    mjx_data = mjx.make_data(model)

    # One spin per world, about the box's own x axis, from the same drop height.
    spins = jnp.array([0.0, 4.0, 8.0, 16.0])
    batch = jax.vmap(lambda spin: mjx_data.replace(qvel=mjx_data.qvel.at[3].set(spin)))(spins)

    @jax.jit
    @jax.vmap
    def rollout(data: mjx.Data) -> mjx.Data:
        return jax.lax.fori_loop(0, 250, lambda _, d: mjx.step(mjx_model, d), data)

    final = rollout(batch)
    qpos = np.asarray(final.qpos)
    print(f"mjx_batched_rollout: {spins.shape[0]} worlds x 250 steps on {jax.default_backend()}")
    for spin, state in zip(np.asarray(spins), qpos, strict=True):
        rmat_World_Box = np.zeros(9)
        mujoco.mju_quat2Mat(rmat_World_Box, state[3:7])
        tilt = np.degrees(np.arccos(np.clip(rmat_World_Box[8], -1.0, 1.0)))
        print(
            f"  spin {spin:5.1f} rad/s -> settled at z={state[2]:.4f} m, "
            f"y={state[1]:+.3f} m, tilt from upright {tilt:5.1f} deg"
        )


def runtime_equality_toggle() -> None:
    """Grab and release a payload by flipping mjData.eq_active during a rollout."""
    # Equality constraints are enabled/disabled through mjData.eq_active; mjModel.eq_active
    # was renamed to eq_active0 and now only seeds it. Editing mjData means no recompile and
    # no reset, so a gripper can latch and let go mid-simulation.
    xml = """
    <mujoco model="suction_gripper">
      <option timestep="0.002"/>
      <worldbody>
        <geom name="floor" type="plane" size="3 3 0.1"/>
        <body name="gripper" pos="0 0 0.55" mocap="true">
          <geom type="box" size="0.06 0.06 0.02" rgba="0.3 0.5 0.9 1" contype="0" conaffinity="0"/>
        </body>
        <body name="payload" pos="0 0 0.5">
          <freejoint/>
          <geom type="box" size="0.05 0.05 0.05" mass="0.2"/>
        </body>
      </worldbody>
      <equality>
        <weld name="suction" body1="gripper" body2="payload" active="false"
              solref="0.005 1" solimp="0.95 0.99 0.001"/>
      </equality>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    suction = model.equality("suction").id
    payload = model.body("payload").id
    print(f"runtime_equality_toggle: eq_active0={model.eq_active0[suction]} seeds eq_active")

    def move_gripper_to(height: float, duration: float) -> None:
        """Move the mocap gripper toward a height over `duration` seconds."""
        start = data.mocap_pos[0, 2]
        end_time = data.time + duration
        while data.time < end_time:
            alpha = 1.0 - (end_time - data.time) / duration
            data.mocap_pos[0, 2] = start + alpha * (height - start)
            mujoco.mj_step(model, data)

    move_gripper_to(0.55, 0.2)
    print(f"  t={data.time:.2f}s inactive weld: payload z={data.xpos[payload, 2]:.3f} m")

    data.eq_active[suction] = 1
    move_gripper_to(0.95, 0.6)
    print(f"  t={data.time:.2f}s welded, gripper raised: payload z={data.xpos[payload, 2]:.3f} m")

    data.eq_active[suction] = 0
    move_gripper_to(0.95, 0.5)
    print(f"  t={data.time:.2f}s released: payload z={data.xpos[payload, 2]:.3f} m (dropped)")


def exact_filter_actuator() -> None:
    """Model actuator lag without integration error using dyntype='filterexact' and actearly."""
    # 'filter' integrates da/dt = (u - a)/tau with the Euler step and drifts once the timestep
    # approaches tau; 'filterexact' applies the closed-form solution, so a coarse control
    # timestep costs nothing. 'actearly' additionally removes the one-step force delay by
    # using the next activation when computing this step's force.
    tau = 0.05
    xml = f"""
    <mujoco model="lagged_actuators">
      <option timestep="0.02"/>
      <worldbody>
        <body name="euler" pos="0 0 1">
          <joint name="euler" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="0.5"/>
        </body>
        <body name="exact" pos="0 0.5 1">
          <joint name="exact" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="0.5"/>
        </body>
        <body name="early" pos="0 1 1">
          <joint name="early" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="0.5"/>
        </body>
      </worldbody>
      <actuator>
        <general name="euler" joint="euler" dyntype="filter" dynprm="{tau}"
                 gaintype="fixed" gainprm="1" biastype="none" ctrlrange="-1 1"/>
        <general name="exact" joint="exact" dyntype="filterexact" dynprm="{tau}"
                 gaintype="fixed" gainprm="1" biastype="none" ctrlrange="-1 1"/>
        <general name="early" joint="early" dyntype="filterexact" dynprm="{tau}"
                 gaintype="fixed" gainprm="1" biastype="none" ctrlrange="-1 1" actearly="true"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.ctrl[:] = 1.0  # Unit step command on all three.

    timestep = model.opt.timestep
    print(f"exact_filter_actuator: tau={tau}s, timestep={timestep}s (h/tau={timestep / tau:.1f})")
    print("  t      act(filter)  act(filterexact)  analytic  force(exact)  force(actearly)")
    for _ in range(5):
        mujoco.mj_step(model, data)
        analytic = 1.0 - np.exp(-data.time / tau)
        print(
            f"  {data.time:.2f}   {data.act[0]:.6f}     {data.act[1]:.6f}      "
            f"{analytic:.6f}  {data.actuator_force[1]:.6f}      {data.actuator_force[2]:.6f}"
        )
    euler_error = abs(data.act[0] - (1.0 - np.exp(-data.time / tau)))
    exact_error = abs(data.act[1] - (1.0 - np.exp(-data.time / tau)))
    print(
        f"  activation error at t={data.time:.2f}s: filter={euler_error:.2e} exact={exact_error:.2e}"
    )


def camera_projection_sensor() -> None:
    """Get the pixel coordinates of a tracked site from a calibrated camera, with no renderer."""
    # The camprojection sensor plus the camera calibration attributes (resolution / focal /
    # sensorsize) replace hand-rolled pinhole projection code: it runs in mj_sensorPos, needs
    # no OpenGL context, and uses the same intrinsics the offscreen renderer would.
    xml = """
    <mujoco model="calibrated_camera">
      <worldbody>
        <camera name="overhead" pos="0 -2 1.2" xyaxes="1 0 0 0 0.5 0.87"
                resolution="640 480" focal="0.008 0.008" sensorsize="0.0072 0.0054"/>
        <body name="pendulum" pos="0 0 1.2">
          <joint name="swing" axis="0 1 0" damping="0.02"/>
          <geom type="capsule" fromto="0 0 0 0 0 -0.6" size="0.02" mass="0.4"/>
          <site name="marker" pos="0 0 -0.6" size="0.03" rgba="1 0 0 1"/>
        </body>
      </worldbody>
      <sensor>
        <camprojection name="marker_px" site="marker" camera="overhead"/>
        <framepos name="marker_cam" objtype="site" objname="marker" reftype="camera" refname="overhead"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    camera = model.camera("overhead").id

    # The intrinsics the sensor uses. The principal point is always the image center here:
    # the camera's principal / principalpixel attributes affect rendering, not camprojection.
    width, height = model.cam_resolution[camera]
    focal_x, focal_y = model.cam_intrinsic[camera, :2]
    sensor_width, sensor_height = model.cam_sensorsize[camera]
    fx = focal_x / sensor_width * width
    fy = focal_y / sensor_height * height
    print(f"camera_projection_sensor: {width}x{height} px, fx={fx:.1f} fy={fy:.1f} px")

    data.qpos[0] = 0.9
    print("  t      swing[rad]  marker px (u, v)   depth[m]  in frame?")
    for sample_time in (0.3, 0.6, 0.9, 1.2):
        while data.time < sample_time:
            mujoco.mj_step(model, data)
        u, v = data.sensor("marker_px").data
        pos_Camera_Marker = data.sensor("marker_cam").data
        # MuJoCo cameras look down -z, so a target in front of the camera has negative z.
        depth = -pos_Camera_Marker[2]
        visible = depth > 0 and 0 <= u < width and 0 <= v < height
        print(
            f"  {data.time:.2f}   {data.qpos[0]:+.4f}    ({u:7.2f}, {v:7.2f})   "
            f"{depth:.3f}     {visible}"
        )

    # The projection the sensor saves you from writing by hand.
    pos_World_Marker = data.site("marker").xpos
    pos_World_Camera = data.cam_xpos[camera]
    rmat_World_Camera = data.cam_xmat[camera].reshape(3, 3)
    pos_Camera_Marker = rmat_World_Camera.T @ (pos_World_Marker - pos_World_Camera)
    pinhole = np.array(
        [
            -fx * pos_Camera_Marker[0] / pos_Camera_Marker[2] + 0.5 * width,
            fy * pos_Camera_Marker[1] / pos_Camera_Marker[2] + 0.5 * height,
        ]
    )
    np.testing.assert_allclose(pinhole, data.sensor("marker_px").data, atol=1e-9)
    print(f"  hand-rolled pinhole projection agrees: {np.array2string(pinhole, precision=2)}")


def discrete_inverse_dynamics() -> None:
    """Recover exactly the torques that produced a recorded trajectory, using the invdiscrete flag."""
    # The one-step integrators modify the mass matrix to M - h*D, so finite-differenced
    # accelerations do not match the continuous-time qacc that mj_inverse expects. Enabling
    # mjENBL_INVDISCRETE undoes that, which is what makes inverse dynamics on logged
    # (position, velocity) data exact instead of merely close.
    xml = """
    <mujoco model="damped_arm">
      <option timestep="0.01" integrator="implicitfast"/>
      <worldbody>
        <body name="upper" pos="0 0 1">
          <joint name="shoulder" axis="0 1 0" damping="5"/>
          <geom type="capsule" fromto="0 0 0 0.4 0 0" size="0.04" mass="1"/>
          <body name="lower" pos="0.4 0 0">
            <joint name="elbow" axis="0 1 0" damping="3"/>
            <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="0.6"/>
          </body>
        </body>
      </worldbody>
      <actuator>
        <motor name="shoulder" joint="shoulder" gear="1"/>
        <motor name="elbow" joint="elbow" gear="1"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[:] = [0.3, -0.2]
    data.qvel[:] = [1.0, -0.5]

    # Forward pass: record the state before and after a step, and the torque we applied.
    torque = np.array([2.0, -1.0])
    data.ctrl[:] = torque
    qpos, qvel = data.qpos.copy(), data.qvel.copy()
    mujoco.mj_step(model, data)
    qacc_finite_difference = (data.qvel - qvel) / model.opt.timestep

    def inverse_torque(*, invdiscrete: bool) -> np.ndarray:
        if invdiscrete:
            model.opt.enableflags |= mujoco.mjtEnableBit.mjENBL_INVDISCRETE
        else:
            model.opt.enableflags &= ~int(mujoco.mjtEnableBit.mjENBL_INVDISCRETE)
        inverse = mujoco.MjData(model)
        inverse.qpos[:] = qpos
        inverse.qvel[:] = qvel
        inverse.qacc[:] = qacc_finite_difference
        mujoco.mj_inverse(model, inverse)
        return inverse.qfrc_inverse.copy()

    print(
        f"discrete_inverse_dynamics: integrator={mujoco.mjtIntegrator(model.opt.integrator).name}"
    )
    print(f"  applied torque              {np.array2string(torque, precision=6, sign=' ')} Nm")
    for invdiscrete in (False, True):
        recovered = inverse_torque(invdiscrete=invdiscrete)
        error = np.abs(recovered - torque).max()
        print(
            f"  invdiscrete={invdiscrete!s:<5} qfrc_inverse "
            f"{np.array2string(recovered, precision=6, sign=' ')} max error {error:.2e} Nm"
        )


def solver_statistics() -> None:
    """Read per-island solver convergence out of mjData and tune the linesearch with it."""
    # mjData.solver is a mjNISLAND x mjNSOLVER matrix of per-iteration statistics and
    # solver_niter/solver_nnz are per-island vectors, so convergence can be inspected island
    # by island. ls_iterations and ls_tolerance bound the linesearch inside each iteration.
    boxes = "".join(
        f'<body name="box{i}" pos="0 0 {0.21 + 0.402 * i}">'
        f'<freejoint/><geom type="box" size="0.2 0.2 0.2" mass="1"/></body>'
        for i in range(10)
    )
    xml = f"""
    <mujoco model="box_stack">
      <option solver="Newton" tolerance="1e-14" iterations="200"/>
      <worldbody><geom name="floor" type="plane" size="10 10 0.1"/>{boxes}</worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    settled = mujoco.MjData(model)
    while settled.time < 1.0:
        mujoco.mj_step(model, settled)

    # Kick the settled stack so the solver has real work to do from a cold warmstart.
    kick = np.random.default_rng(0).normal(scale=1.0, size=model.nv)

    def solve_once(*, ls_iterations: int, ls_tolerance: float) -> mujoco.MjData:
        model.opt.ls_iterations = ls_iterations
        model.opt.ls_tolerance = ls_tolerance
        data = mujoco.MjData(model)
        data.qpos[:] = settled.qpos
        data.qvel[:] = kick
        mujoco.mj_forward(model, data)
        return data

    data = solve_once(ls_iterations=50, ls_tolerance=0.01)
    print(
        f"solver_statistics: {data.ncon} contacts, {data.nefc} constraints, {data.nisland} island(s)"
    )
    island = 0
    print(
        f"  island {island}: {data.solver_niter[island]} iterations, "
        f"{data.solver_nnz[island]} nonzeros in the solver matrix"
    )
    print("  iter  improvement    gradient     linesearch evals")
    for i in range(data.solver_niter[island]):
        stat = data.solver[island * mujoco.mjNSOLVER + i]  # Row `island`, column `iteration`.
        print(f"  {i:4d}  {stat.improvement:.4e}  {stat.gradient:.4e}  {stat.neval:2d}")

    print("  linesearch budget vs total cost:")
    for ls_iterations, ls_tolerance in ((50, 0.01), (2, 0.01), (50, 1e-8)):
        data = solve_once(ls_iterations=ls_iterations, ls_tolerance=ls_tolerance)
        niter = data.solver_niter[0]
        neval = sum(data.solver[i].neval for i in range(niter))
        print(
            f"    ls_iterations={ls_iterations:<3d} ls_tolerance={ls_tolerance:<7g} -> "
            f"{niter} solver iterations, {neval} linesearch evaluations, "
            f"final gradient {data.solver[niter - 1].gradient:.2e}"
        )


def joint_actuator_force_limits() -> None:
    """Cap the total actuator force reaching a joint with actuatorfrcrange."""
    # actuatorfrcrange (renamed from actuatorforcerange) clamps the *sum* of all actuator
    # forces on a joint, which per-actuator forcerange cannot do. With actuatorgravcomp the
    # gravity-compensation term is charged against the same budget, so the limit reflects
    # what the real joint can deliver.
    xml = """
    <mujoco model="rated_joint">
      <worldbody>
        <body name="link" pos="0 0 1" gravcomp="1">
          <joint name="hinge" axis="0 1 0" actuatorfrcrange="-3 3" actuatorgravcomp="true"/>
          <geom type="capsule" fromto="0 0 0 0.5 0 0" size="0.04" mass="2"/>
        </body>
      </worldbody>
      <actuator>
        <motor name="primary" joint="hinge" gear="1" ctrlrange="-20 20"/>
        <motor name="assist" joint="hinge" gear="1" ctrlrange="-20 20"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    hinge = model.joint("hinge").id
    lower, upper = model.jnt_actfrcrange[hinge]
    print(
        f"joint_actuator_force_limits: actfrclimited={bool(model.jnt_actfrclimited[hinge])}, "
        f"actuatorfrcrange=[{lower:g}, {upper:g}] Nm"
    )
    print("  ctrl(primary, assist)  actuators  gravcomp  requested  qfrc_actuator (clamped)")
    for primary, assist in ((1.0, 0.5), (5.0, 4.0), (-8.0, -6.0)):
        data.ctrl[:] = [primary, assist]
        mujoco.mj_forward(model, data)
        actuators = data.actuator_force.sum()
        gravcomp = data.qfrc_gravcomp[0]
        print(
            f"  ({primary:+5.1f}, {assist:+5.1f})         {actuators:+8.3f}  {gravcomp:+8.3f}  "
            f"{actuators + gravcomp:+9.3f}  {data.qfrc_actuator[0]:+8.3f} Nm"
        )
    print("  (gravity compensation is inside the budget because actuatorgravcomp is true)")


def main() -> None:
    mjx_batched_rollout()
    print()
    runtime_equality_toggle()
    print()
    exact_filter_actuator()
    print()
    camera_projection_sensor()
    print()
    discrete_inverse_dynamics()
    print()
    solver_statistics()
    print()
    joint_actuator_force_limits()


if __name__ == "__main__":
    main()
