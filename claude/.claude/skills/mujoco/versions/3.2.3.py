# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.2.3 (Sep 16, 2024)."""

import copy

import jax
import mujoco
import numpy as np
from jax import numpy as jp
from mujoco import mjx


def native_ccd_options() -> None:
    """Tune the native convex-collision solver — nativeccd plus ccd_tolerance / ccd_iterations."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="pad" pos="0 0 0">
          <freejoint/>
          <geom name="pad" type="box" size="0.1 0.1 0.1" mass="1"/>
        </body>
        <body name="roller" pos="0.35 0 0">
          <freejoint/>
          <geom name="roller" type="cylinder" size="0.08 0.1" euler="0 30 0" mass="1"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    pad_id, roller_id = model.geom("pad").id, model.geom("roller").id

    # 3.2.3 renamed mpr_tolerance/mpr_iterations to ccd_tolerance/ccd_iterations when the MPR
    # solver was replaced. Since then nativeccd became the default, so the flag flipped from an
    # enable bit (mjENBL_NATIVECCD) to a disable bit: set mjDSBL_NATIVECCD to fall back to libccd.
    # Both pipelines agree on the distance once converged, but pick different witness points, and
    # starving the solver of iterations/tolerance silently reports a distance that is too large.
    for label, disableflags, tolerance, iterations in (
        ("native ccd, converged", 0, 1e-6, 50),
        ("native ccd, starved", 0, 1e-2, 3),
        ("libccd fallback", mujoco.mjtDisableBit.mjDSBL_NATIVECCD, 1e-6, 50),
    ):
        model.opt.disableflags = disableflags
        model.opt.ccd_tolerance = tolerance
        model.opt.ccd_iterations = iterations
        fromto = np.zeros(6)
        distance = mujoco.mj_geomDistance(model, data, pad_id, roller_id, 1.0, fromto)
        witness = np.array2string(fromto[:3], precision=4)
        print(f"{label:<22} distance={distance:+.6f} witness point on box={witness}")


def equality_between_sites() -> None:
    """Connect two bodies through a pair of sites, retargetable at runtime via site_pos."""
    # The body/anchor form assumes the constraint is already satisfied at qpos0 and bakes the
    # anchor into eq_data. The site form does not: the sites snap together when the sim starts,
    # and moving mjModel.site_pos later actually moves the constraint.
    xml = """
    <mujoco>
      <option gravity="0 0 0"/>
      <worldbody>
        <body name="left" pos="-0.3 0 0.5">
          <freejoint/>
          <geom type="box" size="0.05 0.05 0.05" mass="1"/>
          <site name="left_tip" pos="0.05 0 0" size="0.01"/>
        </body>
        <body name="right" pos="0.3 0 0.5">
          <freejoint/>
          <geom type="box" size="0.05 0.05 0.05" mass="1"/>
          <site name="right_tip" pos="-0.05 0 0" size="0.01"/>
        </body>
      </worldbody>
      <equality>
        <connect name="latch" site1="left_tip" site2="right_tip"/>
      </equality>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    def site_gap() -> float:
        return float(np.linalg.norm(data.site("left_tip").xpos - data.site("right_tip").xpos))

    print(f"gap at qpos0 (constraint violated by design): {site_gap():.4f} m")
    mujoco.mj_step(model, data, nstep=2000)
    print(f"gap after snapping together:                  {site_gap():.3e} m")

    # Retarget the latch without recompiling: eq_data is ignored for the site semantic.
    model.site_pos[model.site("left_tip").id] = [0.05, 0.12, 0]
    mujoco.mj_step(model, data, nstep=2000)
    print(f"gap after moving site_pos at runtime:         {site_gap():.3e} m")
    print(f"eq objtype={mujoco.mjtObj(model.eq_objtype[0]).name}, obj1/obj2 are site ids")


def freejoint_alignment() -> None:
    """Align a free body's frame with its inertial frame to diagonalise its 6x6 inertia."""
    # Per-joint <freejoint align="true"/>, or compiler alignfree="true" for every simple free body.
    # Recommended for all new models; it invalidates qpos/qvel saved by older versions, which is
    # why the global compiler flag still defaults to false.
    xml_template = """
    <mujoco>
      <compiler alignfree="{alignfree}"/>
      <worldbody>
        <body name="wrench" pos="0 0 1" euler="0 0 30">
          <freejoint/>
          <geom type="box" size="0.20 0.03 0.02" pos="0.15 0 0" mass="0.6"/>
          <geom type="cylinder" size="0.05 0.02" pos="-0.05 0 0" mass="0.4"/>
        </body>
      </worldbody>
    </mujoco>
    """
    for alignfree in ("false", "true"):
        model = mujoco.MjModel.from_xml_string(xml_template.format(alignfree=alignfree))
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        body_id = model.body("wrench").id
        mass_matrix = np.zeros((model.nv, model.nv))
        mujoco.mj_fullM(model, data, mass_matrix)
        off_diagonal = np.abs(mass_matrix - np.diag(np.diag(mass_matrix))).max()
        same_frame = mujoco.mjtSameFrame(model.body_sameframe[body_id])
        print(
            f"alignfree={alignfree:<5}"
            f" ipos={np.array2string(model.body_ipos[body_id], precision=4)}"
            f" iquat={np.array2string(model.body_iquat[body_id], precision=4)}"
        )
        print(
            f"{'':<15} max |off-diagonal M| = {off_diagonal:.3e}, body_sameframe={same_frame.name}"
        )


def sameframe_shortcuts() -> None:
    """See why mj_kinematics can skip work for a child — the compiler's mjtSameFrame flags."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="hub" pos="0 0 0.5">
          <joint type="hinge" axis="0 0 1"/>
          <geom name="aligned" type="box" size="0.1 0.1 0.1" mass="1"/>
          <geom name="offset" type="box" size="0.05 0.05 0.05" pos="0.3 0 0" mass="0.2"/>
          <site name="rotated" quat="0.707 0 0.707 0"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    for name in ("aligned", "offset"):
        flag = mujoco.mjtSameFrame(model.geom_sameframe[model.geom(name).id])
        print(f"geom '{name}':  {flag.name}")
    # BODYROT means "same rotation, offset position"; a rotated child gets no shortcut at all.
    site_flag = mujoco.mjtSameFrame(model.site_sameframe[model.site("rotated").id])
    print(f"site 'rotated': {site_flag.name}")


def shell_inertia_for_any_geom() -> None:
    """Model thin-walled parts: shellinertia now works for every geom type, not just meshes."""
    radius, mass = 0.1, 2.0
    spec = mujoco.MjSpec()
    for name, typeinertia in (
        ("solid", mujoco.mjtGeomInertia.mjINERTIA_VOLUME),
        ("shell", mujoco.mjtGeomInertia.mjINERTIA_SHELL),
    ):
        body = spec.worldbody.add_body(name=name, pos=[0, 0, 1])
        body.add_freejoint()
        # MJCF spells this shellinertia="true"; the spec field is the mjtGeomInertia enum.
        body.add_geom(
            type=mujoco.mjtGeom.mjGEOM_SPHERE,
            size=[radius, 0, 0],
            mass=mass,
            typeinertia=typeinertia,
        )
    model = spec.compile()

    for name, expected in (("solid", 0.4 * mass * radius**2), ("shell", 2 / 3 * mass * radius**2)):
        inertia = model.body_inertia[model.body(name).id]
        print(f"{name:<6} I={np.array2string(inertia, precision=6)} (analytic {expected:.6f})")


def jacobian_time_derivative() -> None:
    """Get the bias acceleration J-dot @ v for operational-space control, exactly."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="upper" pos="0 0 1">
          <joint name="shoulder" type="hinge" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="1.2"/>
          <body name="fore" pos="0.3 0 0">
            <joint name="elbow" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0.25 0 0" size="0.025" mass="0.8"/>
            <site name="tool" pos="0.25 0 0"/>
          </body>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[:] = [0.4, -0.9]
    data.qvel[:] = [1.3, -2.1]
    mujoco.mj_forward(model, data)

    body_id = model.body("fore").id
    pos_World_Tool = data.site("tool").xpos.copy()
    jacp_World_Tool = np.zeros((3, model.nv))
    jacr_World_Tool = np.zeros((3, model.nv))
    mujoco.mj_jac(model, data, jacp_World_Tool, jacr_World_Tool, pos_World_Tool, body_id)

    # Before mj_jacDot this had to be finite-differenced by hand, at double the forward-kinematics
    # cost and with a step-size tradeoff. mj_jacDot is exact and follows the mj_jac signature.
    jacp_dot = np.zeros((3, model.nv))
    jacr_dot = np.zeros((3, model.nv))
    mujoco.mj_jacDot(model, data, jacp_dot, jacr_dot, pos_World_Tool, body_id)

    dt = 1e-6
    data_next = copy.deepcopy(data)
    mujoco.mj_integratePos(model, data_next.qpos, data_next.qvel, dt)
    mujoco.mj_forward(model, data_next)
    jacp_next = np.zeros((3, model.nv))
    mujoco.mj_jac(model, data_next, jacp_next, None, data_next.site("tool").xpos, body_id)
    jacp_dot_numeric = (jacp_next - jacp_World_Tool) / dt

    bias_acceleration = jacp_dot @ data.qvel
    print(f"vel_World_Tool     = {np.array2string(jacp_World_Tool @ data.qvel, precision=6)}")
    print(f"J-dot @ v (analytic) = {np.array2string(bias_acceleration, precision=6)}")
    print(f"J-dot @ v (finite)   = {np.array2string(jacp_dot_numeric @ data.qvel, precision=6)}")
    print(f"max |analytic - finite| = {np.abs(jacp_dot - jacp_dot_numeric).max():.3e}")


def spec_texture_from_buffer() -> None:
    """Ship a procedurally generated texture inside an MjSpec, with no PNG file anywhere."""
    width = height = 32
    pixels = np.zeros((height, width, 3), dtype=np.uint8)
    y_grid, x_grid = np.mgrid[0:height, 0:width]
    pixels[..., 0] = (255 * x_grid / (width - 1)).astype(np.uint8)
    pixels[..., 1] = (255 * y_grid / (height - 1)).astype(np.uint8)
    pixels[..., 2] = np.where((x_grid // 8 + y_grid // 8) % 2, 200, 40)

    spec = mujoco.MjSpec()
    # The alternative to file= or builtin=: hand the compiler the raw buffer directly.
    texture = spec.add_texture(
        name="uvgrid",
        type=mujoco.mjtTexture.mjTEXTURE_2D,
        width=width,
        height=height,
        nchannel=3,
    )
    texture.data = pixels.tobytes()

    material = spec.add_material(name="uvgrid", texrepeat=[2, 2], texuniform=False)
    material.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = "uvgrid"
    body = spec.worldbody.add_body(name="panel", pos=[0, 0, 0.5])
    body.add_geom(type=mujoco.mjtGeom.mjGEOM_BOX, size=[0.3, 0.3, 0.01], material="uvgrid")
    model = spec.compile()

    texture_id = model.texture("uvgrid").id
    address = model.tex_adr[texture_id]
    compiled = model.tex_data[address : address + width * height * 3].reshape(height, width, 3)
    print(
        f"texture '{model.texture(texture_id).name}':"
        f" {width}x{height}x{model.tex_nchannel[texture_id]}"
    )
    print(f"round-trip identical to source buffer: {np.array_equal(compiled, pixels)}")
    print(f"corner pixels {compiled[0, 0]} {compiled[0, -1]} {compiled[-1, -1]}")


def keyframe_merge_on_attach() -> None:
    """Attach a sub-model and keep its keyframes, re-indexed into the parent's qpos layout."""
    gripper = mujoco.MjSpec.from_string("""
    <mujoco model="gripper">
      <worldbody>
        <body name="palm">
          <joint name="jaw" type="slide" axis="0 1 0" range="0 0.05"/>
          <geom type="box" size="0.02 0.01 0.03" mass="0.1"/>
        </body>
      </worldbody>
      <keyframe>
        <key name="open" qpos="0.045"/>
        <key name="closed" qpos="0.0"/>
      </keyframe>
    </mujoco>
    """)
    arm = mujoco.MjSpec.from_string("""
    <mujoco model="arm">
      <worldbody>
        <body name="link">
          <joint name="shoulder" type="hinge" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.02" mass="1"/>
          <site name="flange" pos="0.3 0 0"/>
        </body>
      </worldbody>
      <keyframe>
        <key name="home" qpos="0.25"/>
      </keyframe>
    </mujoco>
    """)

    # Keyframes are merged on the *first* attachment only; compile before attaching anything else.
    arm.attach(gripper, prefix="grip_", site="flange")
    model = arm.compile()

    print(f"parent nq={model.nq}, nkey={model.nkey}")
    for key_id in range(model.nkey):
        name = model.key(key_id).name
        print(f"  {name:<12} qpos={np.array2string(model.key_qpos[key_id], precision=4)}")

    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key("grip_open").id)
    print(f"reset to 'grip_open': qpos={np.array2string(data.qpos, precision=4)}")


def mjx_sensors() -> None:
    """Read sensors straight off mjx.Data — position, velocity and force sensors run in MJX now."""
    xml = """
    <mujoco>
      <option timestep="0.002" integrator="implicitfast"/>
      <worldbody>
        <geom name="floor" type="plane" size="2 2 0.1"/>
        <body name="pod" pos="0 0 0.4">
          <freejoint/>
          <geom name="pod" type="box" size="0.08 0.08 0.08" mass="1.5"/>
          <site name="imu"/>
        </body>
      </worldbody>
      <sensor>
        <framepos objtype="site" objname="imu"/>
        <framequat objtype="site" objname="imu"/>
        <velocimeter site="imu"/>
        <gyro site="imu"/>
        <accelerometer site="imu"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    mjx_model = mjx.put_model(model)
    # 3.2.3 gave make_data a device= argument, for parity with put_model/put_data. None = default.
    mjx_data = mjx.make_data(mjx_model, device=None)
    twist_World_Pod = np.array([0.5, 0.0, 0.0, 0.0, 3.0, 1.0])
    mjx_data = mjx_data.replace(qvel=jp.array(twist_World_Pod))

    data = mujoco.MjData(model)
    data.qvel[:] = twist_World_Pod
    step = jax.jit(mjx.step)

    def advance(n_steps: int) -> None:
        nonlocal mjx_data
        for _ in range(n_steps):
            mujoco.mj_step(model, data)
            mjx_data = step(mjx_model, mjx_data)

    advance(100)  # Free flight, so the two pipelines are still on the same trajectory.
    sensordata = np.asarray(mjx_data.sensordata)
    for sensor_id in range(model.nsensor):
        address = model.sensor_adr[sensor_id]
        dim = model.sensor_dim[sensor_id]
        name = mujoco.mjtSensor(model.sensor_type[sensor_id]).name
        reference = data.sensordata[address : address + dim]
        computed = sensordata[address : address + dim]
        print(
            f"{name:<20} mujoco={np.array2string(reference, precision=5):<38}"
            f" max|delta|={np.abs(reference - computed).max():.2e}"
        )

    advance(900)  # Now let it land and settle.
    # efc_pos (constraint position residual) joined mjx.Data in 3.2.3; it moved behind ._impl since.
    n_efc = int(mjx_data._impl.nefc)
    efc_pos = np.asarray(mjx_data._impl.efc_pos)[:n_efc]
    print(f"at rest: ncon={int(mjx_data._impl.ncon)} nefc={n_efc}")
    print(f"efc_pos (penetration depth per contact row) = {np.array2string(efc_pos, precision=6)}")


def mjx_tendon_site_wrapping() -> None:
    """Route a spatial tendon through intermediate sites and simulate it in MJX."""
    # 3.2.3 brought *site* wrapping to MJX; wrapping over geoms and pulley
    # branches came one release later — see 3.2.4 mjx_spatial_tendon.
    xml = """
    <mujoco>
      <option timestep="0.002"/>
      <worldbody>
        <site name="anchor" pos="0 0 0.8"/>
        <site name="fairlead" pos="0.15 0 0.85"/>
        <body name="load" pos="0.3 0 0.5">
          <joint name="hoist" type="slide" axis="0 0 1"/>
          <geom type="box" size="0.04 0.04 0.04" mass="2"/>
          <site name="hook" pos="0 0 0.04"/>
        </body>
      </worldbody>
      <tendon>
        <spatial name="cable" width="0.004" limited="true" range="0 0.55">
          <site site="anchor"/>
          <site site="fairlead"/>
          <site site="hook"/>
        </spatial>
      </tendon>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    mjx_model = mjx.put_model(model)
    mjx_data = mjx.make_data(mjx_model)

    data = mujoco.MjData(model)
    step = jax.jit(mjx.step)
    for _ in range(500):
        mujoco.mj_step(model, data)
        mjx_data = step(mjx_model, mjx_data)

    print(
        f"cable length   mujoco={data.ten_length[0]:.6f}  mjx={float(mjx_data.ten_length[0]):.6f}"
    )
    print(f"load height    mujoco={data.qpos[0]:+.6f}  mjx={float(mjx_data.qpos[0]):+.6f}")
    print(f"wrap points on the cable: {data.ten_wrapnum[0]}")


def main() -> None:
    for demo in (
        native_ccd_options,
        equality_between_sites,
        freejoint_alignment,
        sameframe_shortcuts,
        shell_inertia_for_any_geom,
        jacobian_time_derivative,
        spec_texture_from_buffer,
        keyframe_merge_on_attach,
        mjx_sensors,
        mjx_tendon_site_wrapping,
    ):
        print(f"\n=== {demo.__name__} ===")
        demo()


if __name__ == "__main__":
    main()
