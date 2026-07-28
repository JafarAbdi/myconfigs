# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.2.0 (Jul 15, 2024)."""

import jax
import mujoco
import numpy as np
from mujoco import mjx


def spec_build_model() -> None:
    """Build a model in Python instead of emitting MJCF text — mjSpec, the model editing API."""
    # This replaces string-templating XML and re-parsing it: the spec is the parse tree, so you
    # edit typed fields, compile, and keep editing. MuJoCo's own MJCF/URDF parsers target it.
    spec = mujoco.MjSpec()
    spec.modelname = "two_link"
    spec.option.timestep = 0.002
    spec.option.integrator = mujoco.mjtIntegrator.mjINT_IMPLICITFAST

    # Default classes work procedurally too: pass the class into the element constructor.
    link_default = spec.add_default("link", spec.default)
    link_default.geom.type = mujoco.mjtGeom.mjGEOM_CAPSULE
    link_default.geom.size = [0.03, 0, 0]
    link_default.geom.rgba = [0.6, 0.7, 0.9, 1]
    link_default.joint.type = mujoco.mjtJoint.mjJNT_HINGE
    link_default.joint.axis = [0, 1, 0]
    # damping is a polynomial in joint *velocity*: f(v) = -(a v + b v|v| + c v^3). Index 0 is the
    # linear coefficient a; the higher indices are the anti-symmetrized higher-order terms.
    link_default.joint.damping[0] = 0.2

    parent = spec.worldbody
    lengths = (0.35, 0.28)
    for index, length in enumerate(lengths):
        body = parent.add_body(
            name=f"link{index}", pos=[0 if index == 0 else lengths[index - 1], 0, 0]
        )
        body.add_joint(name=f"joint{index}", default=link_default)
        body.add_geom(default=link_default, fromto=[0, 0, 0, length, 0, 0], mass=1.5 - 0.5 * index)
        parent = body
    parent.add_site(name="tool", pos=[lengths[-1], 0, 0])

    for index in range(len(lengths)):
        actuator = spec.add_actuator(
            name=f"joint{index}", target=f"joint{index}", trntype=mujoco.mjtTrn.mjTRN_JOINT
        )
        # set_to_* fills in the gain/bias/dyn parameters that MJCF's <position>, <motor>, ... imply.
        actuator.set_to_position(kp=60.0, kv=6.0)
    spec.add_sensor(
        name="tool_pos",
        type=mujoco.mjtSensor.mjSENS_FRAMEPOS,
        objtype=mujoco.mjtObj.mjOBJ_SITE,
        objname="tool",
    )

    model = spec.compile()
    data = mujoco.MjData(model)
    data.ctrl[:] = [-0.6, 1.1]
    mujoco.mj_step(model, data, nstep=2000)

    print(f"compiled '{spec.modelname}': nq={model.nq} nu={model.nu} nsensor={model.nsensor}")
    print(
        f"integrator={mujoco.mjtIntegrator(model.opt.integrator).name}"
        f" timestep={model.opt.timestep}"
    )
    print(
        f"qpos={np.array2string(data.qpos, precision=4)}"
        f" tool={np.array2string(data.sensordata, precision=4)}"
    )
    # The spec stays editable after compilation, and can be written back out as MJCF.
    print(f"saved MJCF is {len(spec.to_xml())} characters")


def orthographic_camera() -> None:
    """Use an orthographic camera: parallel rays, and a scale that does not fall off with depth."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="scene" pos="0 1 1">
          <geom name="wall" type="box" size="1 0.02 1"/>
        </body>
        <camera name="perspective" pos="0 -0.5 1" xyaxes="1 0 0 0 0 1" fovy="45" resolution="3 3"/>
        <!-- For an orthographic camera fovy is the vertical view height in metres, not degrees.
             The free camera has the same switch: visual/global orthographic="true". -->
        <camera name="ortho" pos="0 -0.5 1" xyaxes="1 0 0 0 0 1" projection="orthographic"
                fovy="0.6" resolution="3 3"/>
      </worldbody>
      <sensor>
        <rangefinder name="perspective" camera="perspective" data="dist origin"/>
        <rangefinder name="ortho" camera="ortho" data="dist origin"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    for sensor_id, name in enumerate(("perspective", "ortho")):
        camera_id = model.camera(name).id
        projection = mujoco.mjtProjection(model.cam_projection[camera_id])
        rays = data.sensor(name).data.reshape(-1, 4)
        origins = rays[:, 1:]
        # Perspective rays all leave the camera origin; orthographic ray origins are spread
        # across the image plane and the directions are parallel.
        print(f"camera '{name}': {projection.name}, fovy={model.cam_fovy[camera_id]}")
        print(f"  distinct ray origins over the 3x3 image: {len(np.unique(origins, axis=0))}")
        print(
            f"  origin spread (max - min) = {np.array2string(np.ptp(origins, axis=0), precision=3)}"
        )
        print(f"  measured distances = {np.array2string(rays[:, 0], precision=4)}")


def mesh_maxhullvert() -> None:
    """Cap the convex hull of a dense mesh so collision stays cheap — mesh maxhullvert."""
    # The collision cost of a mesh geom is driven by its hull, not its render mesh. Before
    # maxhullvert the only lever was decimating the mesh itself, which also changed its looks.
    rng = np.random.default_rng(0)
    cloud = rng.normal(size=(500, 3))
    cloud /= np.linalg.norm(cloud, axis=1, keepdims=True)
    cloud *= 0.08

    for max_hull_vertices in (-1, 24):
        spec = mujoco.MjSpec()
        spec.add_mesh(name="rock", uservert=cloud.flatten().tolist(), maxhullvert=max_hull_vertices)
        body = spec.worldbody.add_body(name="rock", pos=[0, 0, 0.3])
        body.add_freejoint()
        body.add_geom(type=mujoco.mjtGeom.mjGEOM_MESH, meshname="rock", mass=0.5)
        spec.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_PLANE, size=[1, 1, 0.1])
        model = spec.compile()

        data = mujoco.MjData(model)
        mujoco.mj_step(model, data, nstep=400)
        label = "uncapped" if max_hull_vertices < 0 else f"maxhullvert={max_hull_vertices}"
        print(
            f"{label:<16} hull faces={model.nmeshface:<5} collision graph={model.nmeshgraph:<6} "
            f"resting z={data.qpos[2]:.5f}"
        )


def set_keyframe() -> None:
    """Snapshot the live state into a model keyframe — mj_setKeyframe, not six array copies."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="cart" pos="0 0 0.1">
          <joint name="slide" type="slide" axis="1 0 0"/>
          <geom type="box" size="0.1 0.05 0.05" mass="1"/>
          <body name="pole" pos="0 0 0.05">
            <joint name="pivot" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0 0 0.4" size="0.02" mass="0.2"/>
          </body>
        </body>
      </worldbody>
      <actuator><motor name="drive" joint="slide" gear="8"/></actuator>
      <keyframe>
        <!-- Allocate the slots; mj_setKeyframe fills them at runtime. -->
        <key name="swing_up"/>
        <key name="balanced"/>
      </keyframe>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[1] = 3.0

    for step_index in range(1500):
        data.ctrl[0] = 0.4 * np.sin(0.01 * step_index)
        mujoco.mj_step(model, data)
        if step_index == 500:
            # Copies qpos, qvel, act, ctrl, mocap and time into key 'swing_up' in one call.
            mujoco.mj_setKeyframe(model, data, model.key("swing_up").id)
    mujoco.mj_setKeyframe(model, data, model.key("balanced").id)

    for key_id in range(model.nkey):
        print(
            f"key '{model.key(key_id).name}': t={model.key_time[key_id]:.3f} "
            f"qpos={np.array2string(model.key_qpos[key_id], precision=4)} "
            f"ctrl={np.array2string(model.key_ctrl[key_id], precision=4)}"
        )

    mujoco.mj_resetDataKeyframe(model, data, model.key("swing_up").id)
    print(f"replaying 'swing_up': t={data.time:.3f} qpos={np.array2string(data.qpos, precision=4)}")


def urdf_ball_joint() -> None:
    """Import a URDF that uses a spherical joint — mapped to a MuJoCo ball joint since 3.2.0."""
    urdf = """
    <robot name="wrist">
      <link name="forearm">
        <inertial><mass value="1.5"/>
          <inertia ixx="0.02" iyy="0.02" izz="0.005" ixy="0" ixz="0" iyz="0"/></inertial>
      </link>
      <link name="hand">
        <inertial><mass value="0.4"/>
          <inertia ixx="0.002" iyy="0.002" izz="0.001" ixy="0" ixz="0" iyz="0"/></inertial>
      </link>
      <joint name="wrist" type="spherical">
        <parent link="forearm"/>
        <child link="hand"/>
        <origin xyz="0 0 0.25" rpy="0 0 0"/>
      </joint>
    </robot>
    """
    model = mujoco.MjModel.from_xml_string(urdf)
    joint_id = model.joint("wrist").id
    joint_type = mujoco.mjtJoint(model.jnt_type[joint_id])
    # A ball joint costs 4 qpos (scalar-first quaternion) but only 3 qvel.
    print(f"joint '{model.joint(joint_id).name}': {joint_type.name}, nq={model.nq}, nv={model.nv}")

    data = mujoco.MjData(model)
    data.qvel[:] = [0.0, 0.0, 4.0]
    mujoco.mj_step(model, data, nstep=200)
    print(f"quat_Forearm_Hand = {np.array2string(data.qpos, precision=5)}")


def quaternion_normalization() -> None:
    """Know when mjData.qpos quaternions get normalized: at use, not in place by mj_kinematics."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="sat" pos="0 0 1">
          <freejoint/>
          <geom type="box" size="0.1 0.1 0.05" mass="1"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    # Deliberately unnormalized, as you get from a filter output or a naive interpolation.
    data.qpos[3:7] = [0.9, 0.1, 0.2, 0.05]

    mujoco.mj_forward(model, data)
    quat_World_Sat = data.qpos[3:7].copy()
    print(
        f"after mj_forward: qpos quat={np.array2string(quat_World_Sat, precision=5)}"
        f" |q|={np.linalg.norm(quat_World_Sat):.6f}"
    )
    print(
        f"                  xquat     ={np.array2string(data.xquat[1], precision=5)}"
        f" |q|={np.linalg.norm(data.xquat[1]):.6f}"
    )

    mujoco.mj_step(model, data)
    quat_World_Sat = data.qpos[3:7]
    print(
        f"after mj_step:    qpos quat={np.array2string(quat_World_Sat, precision=5)}"
        f" |q|={np.linalg.norm(quat_World_Sat):.6f}"
    )
    print("mj_kinematics no longer writes back into qpos; the integrator is what renormalizes it")


def rotate_vector_by_matrix() -> None:
    """Re-express a vector between frames with mju_mulMatVec3 / mju_mulMatTVec3."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="tool" pos="0.2 0.1 0.6" euler="10 25 40">
          <freejoint/>
          <geom type="box" size="0.05 0.03 0.02" mass="0.5"/>
          <site name="tcp" pos="0.05 0 0"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    # 3.2.0 deprecated mju_rotVecMat / mju_rotVecMatT (already gone from the Python bindings) in
    # favour of these two, whose names and argument order match the rest of mju_*.
    # xmat is stored flat (9,), which is exactly what the mju_* matrix functions take; reshape to
    # 3x3 only when you want to do matrix algebra on it yourself.
    mat_World_Tool = data.site("tcp").xmat
    force_Tool = np.array([0.0, 0.0, -12.0])
    force_World = np.zeros(3)
    mujoco.mju_mulMatVec3(force_World, mat_World_Tool, force_Tool)

    roundtrip_Tool = np.zeros(3)
    mujoco.mju_mulMatTVec3(roundtrip_Tool, mat_World_Tool, force_World)

    print(f"force_Tool  = {np.array2string(force_Tool, precision=5)}")
    print(f"force_World = {np.array2string(force_World, precision=5)} (mju_mulMatVec3)")
    print(f"back to Tool= {np.array2string(roundtrip_Tool, precision=5)} (mju_mulMatTVec3)")
    numpy_World = mat_World_Tool.reshape(3, 3) @ force_Tool
    print(f"matches numpy mat @ v: {np.allclose(force_World, numpy_World)}")


def mjx_elliptic_cone() -> None:
    """Simulate with an elliptic friction cone in MJX — the physically correct cone."""
    xml = """
    <mujoco>
      <option timestep="0.002" cone="elliptic" solver="Newton" iterations="20" impratio="10"/>
      <worldbody>
        <geom name="ramp" type="plane" size="3 3 0.1" euler="0 12 0" friction="0.4 0.005 0.0001"/>
        <body name="crate" pos="0 0 0.35">
          <freejoint/>
          <geom type="box" size="0.1 0.1 0.1" mass="3" friction="0.4 0.005 0.0001"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    mjx_model = mjx.put_model(model)
    mjx_data = mjx.make_data(mjx_model)

    data = mujoco.MjData(model)
    step = jax.jit(mjx.step)
    for _ in range(600):
        mujoco.mj_step(model, data)
        mjx_data = step(mjx_model, mjx_data)

    cone = mujoco.mjtCone(model.opt.cone)
    print(f"cone={cone.name}, impratio={model.opt.impratio}")
    print(f"pos_World_Crate mujoco={np.array2string(data.qpos[:3], precision=5)}")
    print(f"                mjx   ={np.array2string(np.asarray(mjx_data.qpos[:3]), precision=5)}")
    print(
        f"slide speed     mujoco={np.linalg.norm(data.qvel[:3]):.5f}"
        f"  mjx={np.linalg.norm(np.asarray(mjx_data.qvel[:3])):.5f}"
    )


def main() -> None:
    for demo in (
        spec_build_model,
        orthographic_camera,
        mesh_maxhullvert,
        set_keyframe,
        urdf_ball_joint,
        quaternion_normalization,
        rotate_vector_by_matrix,
        mjx_elliptic_cone,
    ):
        print(f"\n=== {demo.__name__} ===")
        demo()


if __name__ == "__main__":
    main()
