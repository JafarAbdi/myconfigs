# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.2.5 (Nov 4, 2024)."""

import jax
import jax.numpy as jp
import mujoco
import numpy as np
from mujoco import mjx

# Cross-section of an extruded U-channel: non-convex, and its area centroid
# falls inside the notch, i.e. outside the material.
CHANNEL_PROFILE = np.array([
    [0.00, 0.00],
    [0.30, 0.00],
    [0.30, 0.20],
    [0.20, 0.20],
    [0.20, 0.03],
    [0.10, 0.03],
    [0.10, 0.20],
    [0.00, 0.20],
])
CHANNEL_HALF_DEPTH = 0.05

SOFT_BALL = """
<mujoco model="soft_ball">
  <option solver="CG" tolerance="1e-6" timestep=".001" integrator="implicitfast"/>
  <size memory="16M"/>
  <worldbody>
    <geom name="ramp" type="box" pos="0 0 .25" size="2 1 .05" euler="0 15 0"/>
    <body name="ball" pos="-.5 0 1">
      <freejoint/>
      <geom size=".1" contype="0" conaffinity="0" group="4"/>
      <flexcomp name="skin" type="ellipsoid" count="6 6 6" spacing=".06 .06 .06" dim="3"
                radius=".001" rgba="0 .7 .7 1" mass="5" dof="radial">
        <edge equality="true" solimp="0 .9 .01" solref=".02 1"/>
        <contact selfcollide="none" internal="false"/>
      </flexcomp>
    </body>
  </worldbody>
</mujoco>
"""

QUADROTOR = """
<mujoco model="quadrotor">
  <option timestep=".004"/>
  <worldbody>
    <body name="frame" pos="0 0 1">
      <freejoint/>
      <geom type="box" size=".1 .1 .02" mass="1"/>
      <site name="rotor0" pos=" .12  .12 .02"/>
      <site name="rotor1" pos="-.12  .12 .02"/>
      <site name="rotor2" pos="-.12 -.12 .02"/>
      <site name="rotor3" pos=" .12 -.12 .02"/>
    </body>
  </worldbody>
</mujoco>
"""

GRIPPER = """
<mujoco model="pick_and_place">
  <option timestep=".004"/>
  <worldbody>
    <geom name="floor" type="plane" size="2 2 .1"/>
    <body name="hand" mocap="true" pos="0 0 .6">
      <geom type="box" size=".03 .03 .01" contype="0" conaffinity="0"/>
    </body>
    <body name="cube" pos="0 0 .55">
      <freejoint/>
      <geom type="box" size=".03 .03 .03" mass=".2"/>
    </body>
  </worldbody>
  <equality>
    <weld name="grasp" body1="hand" body2="cube" solref=".01 1"/>
  </equality>
</mujoco>
"""

LIDAR_SCENE = """
<mujoco model="lidar">
  <asset>
    <material name="shell" rgba=".8 .6 .2 1"/>
  </asset>
  <worldbody>
    <geom name="floor" type="plane" size="4 4 .1"/>
    <body name="rover" pos="-1 0 .4">
      <freejoint/>
      <geom name="rover" type="box" size=".15 .15 .1" mass="5" material="shell"
            contype="0" conaffinity="0"/>
      <site name="eye" pos=".15 0 0"/>
    </body>
    <body name="rock" pos="1 0 .4">
      <freejoint/>
      <geom name="rock" type="ellipsoid" size=".2 .3 .4" material="shell" mass="2"/>
    </body>
  </worldbody>
</mujoco>
"""


def extruded_prism(profile: np.ndarray, half_depth: float) -> tuple[np.ndarray, np.ndarray]:
    """Watertight triangle soup for a prism, wound so every face normal points outwards."""
    count = len(profile)
    vert = np.concatenate([
        np.column_stack([profile, np.full(count, -half_depth)]),
        np.column_stack([profile, np.full(count, half_depth)]),
    ])
    face = []
    for i in range(1, count - 1):
        face.append([0, i + 1, i])  # bottom cap, -z
        face.append([count, count + i, count + i + 1])  # top cap, +z
    for i in range(count):
        j = (i + 1) % count
        face.append([i, j, count + j])
        face.append([i, count + j, count + i])
    return vert, np.array(face)


def mesh_inertia_modes() -> None:
    """Pick per mesh how mass properties are derived from geometry, instead of a global flag."""
    vert, face = extruded_prism(CHANNEL_PROFILE, CHANNEL_HALF_DEPTH)
    density = 1000.0
    area = 0.30 * 0.20 - 0.10 * 0.17
    print(f"mesh inertia ({len(vert)} verts, {len(face)} faces, density {density:.0f} kg/m^3)")
    print(f"  true mass {area * 2 * CHANNEL_HALF_DEPTH * density:.4f} kg")

    # The global compiler flag exactmeshinertia is gone: inertia is a mesh attribute,
    # so a scene can mix an exact frame with convex-hull payloads. legacy is still
    # the default, only for backward compatibility.
    modes = (
        mujoco.mjtMeshInertia.mjMESH_INERTIA_LEGACY,
        mujoco.mjtMeshInertia.mjMESH_INERTIA_CONVEX,
        mujoco.mjtMeshInertia.mjMESH_INERTIA_EXACT,
        mujoco.mjtMeshInertia.mjMESH_INERTIA_SHELL,
    )
    for mode in modes:
        spec = mujoco.MjSpec()
        mesh = spec.add_mesh(
            name="channel",
            uservert=vert.flatten().tolist(),
            userface=face.flatten().tolist(),
        )
        mesh.inertia = mode
        body = spec.worldbody.add_body(name="channel")
        body.add_freejoint()
        body.add_geom(
            type=mujoco.mjtGeom.mjGEOM_MESH, meshname="channel", density=density
        )
        model = spec.compile()
        inertia = np.array2string(model.body_inertia[1], precision=4)
        print(
            f"  {mode.name.removeprefix('mjMESH_INERTIA_'):6s} "
            f"mass {model.body_mass[1]:8.4f} kg  diaginertia {inertia}"
        )


def flexcomp_shell_types() -> None:
    """Build a deformable shell body from a primitive shape, the replacement for composite."""
    # composite box/cylinder/sphere were removed; flexcomp box/cylinder/ellipsoid
    # build the same shells and run through the engine's flex pipeline instead.
    model = mujoco.MjModel.from_xml_string(SOFT_BALL)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    rest_height = np.ptp(data.flexvert_xpos[:, 2])

    squash = 0.0
    for _ in range(1500):
        mujoco.mj_step(model, data)
        squash = max(squash, rest_height - np.ptp(data.flexvert_xpos[:, 2]))

    print("flexcomp ellipsoid bouncing down a ramp:")
    print(f"  {model.flex_vertnum[0]} flex vertices, {model.nv} dofs")
    sliders = np.count_nonzero(model.jnt_type == mujoco.mjtJoint.mjJNT_SLIDE)
    print(f"  dof=radial: {sliders} radial sliders (centre point pinned) + the parent freejoint")
    print(f"  diameter {rest_height:.4f} m at rest, squashed by {squash * 1e3:.1f} mm on impact")
    print(f"  rolled to x {data.qpos[0]:.3f} m, plugins {model.nplugin}")


def mjx_apply_cartesian_force() -> None:
    """Turn Cartesian forces at points on a body into generalized forces, inside a jitted step."""
    model = mujoco.MjModel.from_xml_string(QUADROTOR)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    model_mjx = mjx.put_model(model)
    data_mjx = jax.jit(mjx.forward)(model_mjx, mjx.put_data(model, data))

    rotor = np.array([model.site(f"rotor{i}").id for i in range(4)])
    rotor_body = jp.array(model.site_bodyid[rotor])
    thrust = jp.array([2.7, 2.4, 2.4, 2.5])  # N, deliberately unbalanced

    def rotor_qfrc(model_mjx: mjx.Model, data_mjx: mjx.Data, thrust: jax.Array) -> jax.Array:
        force_World = jax.vmap(lambda f: jp.array([0.0, 0.0, f]))(thrust)
        torque_World = jp.zeros((4, 3))
        point_World = data_mjx.site_xpos[jp.array(rotor)]
        # apply_ft is the MJX counterpart of mj_applyFT; it is public API rather
        # than a private helper, so custom force models can use it directly.
        qfrc = jax.vmap(mjx.apply_ft, in_axes=(None, None, 0, 0, 0, 0))(
            model_mjx, data_mjx, force_World, torque_World, point_World, rotor_body
        )
        return qfrc.sum(axis=0)

    qfrc = jax.jit(rotor_qfrc)(model_mjx, data_mjx, thrust)

    reference = np.zeros(model.nv)
    for i, site in enumerate(rotor):
        mujoco.mj_applyFT(
            model,
            data,
            np.array([0.0, 0.0, float(thrust[i])]),
            np.zeros(3),
            data.site_xpos[site],
            model.site_bodyid[site],
            reference,
        )

    # mjx.jac returns (nv, 3) blocks: the transpose of mj_jacSite's (3, nv).
    jacp, jacr = jax.jit(mjx.jac)(model_mjx, data_mjx, data_mjx.site_xpos[rotor[0]], rotor_body[0])
    # xfrc_accumulate does the same reduction over every body's xfrc_applied wrench.
    data_wind = data_mjx.replace(
        xfrc_applied=data_mjx.xfrc_applied.at[1].set(jp.array([2.0, 0.0, 0.0, 0.0, 0.0, 0.3]))
    )
    qfrc_wind = jax.jit(mjx.xfrc_accumulate)(model_mjx, data_wind)

    print("mjx rotor thrust -> qfrc:")
    print(f"  apply_ft   {np.asarray(qfrc)}")
    print(f"  mj_applyFT {reference}")
    print(f"  jac blocks {jacp.shape} translational, {jacr.shape} rotational")
    print(f"  xfrc_accumulate (wind wrench on the frame) {np.asarray(qfrc_wind)}")


def mjx_release_equality() -> None:
    """Switch a weld on and off during a jitted rollout, without recompiling the model."""
    model = mujoco.MjModel.from_xml_string(GRIPPER)
    model_mjx = mjx.put_model(model)
    data_mjx = mjx.make_data(model_mjx)
    step_mjx = jax.jit(mjx.step)

    # eq_active is per-rollout state, so grasp and release are traced values;
    # before 3.2.5 MJX only had the compile-time eq_active0.
    height = {}
    for i in range(400):
        grasping = i < 150
        data_mjx = data_mjx.replace(eq_active=jp.array([grasping]))
        data_mjx = step_mjx(model_mjx, data_mjx)
        if i in (149, 399):
            height[i] = float(data_mjx.qpos[2])

    print("mjx eq_active (weld grasp then release):")
    print(f"  model default eq_active0 {model_mjx.eq_active0}")
    print(f"  cube z held {height[149]:.4f} m -> released {height[399]:.4f} m")


def mjx_ray_ellipsoid() -> None:
    """Cast a rangefinder ray in MJX and get the hit distance and geom, ellipsoids included."""
    model = mujoco.MjModel.from_xml_string(LIDAR_SCENE)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    model_mjx = mjx.put_model(model)
    data_mjx = jax.jit(mjx.forward)(model_mjx, mjx.put_data(model, data))

    rover = model.body("rover").id
    pnt_World = data_mjx.site_xpos[model.site("eye").id]
    vec_World = jp.array([1.0, 0.0, 0.0])
    # flg_static=False skips the floor, bodyexclude stops the rover seeing its own hull.
    # Both are Python-level filters, so they have to be static arguments under jit.
    dist, geom = jax.jit(mjx.ray, static_argnames=("flg_static", "bodyexclude"))(
        model_mjx, data_mjx, pnt_World, vec_World, flg_static=False, bodyexclude=rover
    )

    geomid = np.zeros(1, dtype=np.int32)
    reference = mujoco.mj_ray(
        model, data, np.asarray(pnt_World), np.asarray(vec_World), None, 0, rover, geomid
    )

    print("mjx.ray from a rover's eye site:")
    print(f"  hit geom {model.geom(int(geom)).name!r} at {float(dist):.4f} m")
    print(f"  mj_ray   {model.geom(geomid[0]).name!r} at {reference:.4f} m")


def main() -> None:
    mesh_inertia_modes()
    flexcomp_shell_types()
    mjx_apply_cartesian_force()
    mjx_release_equality()
    mjx_ray_ellipsoid()


if __name__ == "__main__":
    main()
