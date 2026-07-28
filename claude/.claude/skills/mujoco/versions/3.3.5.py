# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.3.5 (August 8, 2025)."""

import mujoco
import numpy as np


def contact_sensor() -> None:
    """Read contacts as a fixed-size array, so they can feed a policy or an env rule."""
    xml = """
    <mujoco model="stool">
      <compiler angle="radian" autolimits="true"/>
      <worldbody>
        <geom name="floor" type="plane" size="2 2 .1"/>
        <body name="stool" pos="0 0 .02">
          <freejoint/>
          <geom name="seat" type="cylinder" size=".12 .01" pos="0 0 .18" mass="1"/>
          <geom name="payload" type="box" size=".03 .03 .03" pos=".07 0 .22" mass=".5"/>
          <geom name="foot_a" type="sphere" size=".02" pos=".1 0 0"/>
          <geom name="foot_b" type="sphere" size=".02" pos="-.05 .0866 0"/>
          <geom name="foot_c" type="sphere" size=".02" pos="-.05 -.0866 0"/>
        </body>
      </worldbody>
      <sensor>
        <contact name="feet" body1="stool" geom2="floor" num="5"
                 data="found force dist pos" reduce="maxforce"/>
        <contact name="ground_reaction" geom1="floor" body2="stool"
                 data="found force torque pos" reduce="netforce"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=200)

    # The sensor turns the variable-length mjData.contact into a fixed-size block, so it
    # can be used as a policy observation; hand-rolled loops over mjData.contact cannot.
    slots = data.sensor("feet").data.reshape(5, -1)
    # "found" carries the number of *matching* contacts, not a plain boolean, so slots
    # beyond the match count are identically zero.
    print(f"3.3.5 contact sensor: found={slots[:, 0]} for {len(slots)} requested slots")
    for slot in slots[: int(slots[0, 0])]:
        force, dist, pos = slot[1:4], slot[4], slot[5:8]
        print(
            f"3.3.5 contact sensor:   normal force {force[0]:6.2f} N at "
            f"({pos[0]:+.3f}, {pos[1]:+.3f}, {pos[2]:+.3f}), penetration {-dist * 1e3:.3f} mm"
        )

    # reduce="netforce" collapses every match into one equivalent wrench at the
    # force-weighted centroid. Ordering the criteria floor-then-stool points the normal
    # from floor to stool, so this is the ground reaction force and centre of pressure.
    found, force, torque, pos = np.split(data.sensor("ground_reaction").data, [1, 4, 7])
    print(
        f"3.3.5 contact sensor: net of {int(found[0])} contacts —",
        f"force {np.array2string(force, precision=2, suppress_small=True)} N,",
        f"torque {np.array2string(torque, precision=3, suppress_small=True)} N.m,",
        f"centre of pressure {np.array2string(pos, precision=3, suppress_small=True)}",
    )


def insidesite_sensor() -> None:
    """Trigger environment logic when an object enters a region of space."""
    xml = """
    <mujoco model="goal_region">
      <compiler angle="radian" autolimits="true"/>
      <worldbody>
        <geom name="floor" type="plane" size="2 2 .1"/>
        <site name="goal" type="box" pos="0 0 .06" size=".15 .15 .06" rgba="0 .8 0 .2"/>
        <body name="cube" pos="0 0 .8">
          <freejoint/>
          <geom name="cube" type="box" size=".03 .03 .03" mass=".1"/>
        </body>
      </worldbody>
      <sensor>
        <insidesite name="in_goal" objtype="geom" objname="cube" site="goal"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    # A site's own volume — box, sphere, cylinder, ... — is the region; no bespoke
    # bounding-box arithmetic against geom_xpos any more. The named accessor returns a
    # live view of this sensor's slice of sensordata, so bind it once outside the loop.
    in_goal = data.sensor("in_goal").data
    entered = None
    for _ in range(400):
        mujoco.mj_step(model, data)
        if in_goal[0] and entered is None:
            entered = data.time
    arrival = f"t={entered:.3f} s" if entered is not None else "never"
    print(
        f"3.3.5 insidesite sensor: cube entered the goal site at {arrival},",
        f"still inside at t={data.time:.3f} s: {bool(in_goal[0])}",
    )


def tactile_sensor() -> None:
    """Measure per-taxel penetration depth and slip where a pad presses on an SDF geom."""
    xml = """
    <mujoco model="fingertip">
      <compiler angle="radian" autolimits="true"/>
      <option sdf_iterations="20" sdf_initpoints="40"/>
      <extension>
        <plugin plugin="mujoco.sdf.torus">
          <instance name="torus">
            <config key="radius1" value="0.35"/>
            <config key="radius2" value="0.15"/>
          </instance>
        </plugin>
      </extension>
      <asset>
        <mesh name="torus"><plugin instance="torus"/></mesh>
        <!-- The wedge builtin exists for this sensor: it carries a per-vertex tangent
             frame, without which the two slip channels stay identically zero. -->
        <mesh name="skin" builtin="wedge" params="12 12 60 45 0" scale=".04 .04 .04"/>
      </asset>
      <worldbody>
        <geom name="torus" type="sdf" mesh="torus" rgba=".3 .3 .8 1">
          <plugin instance="torus"/>
        </geom>
        <body name="fingertip" pos=".35 0 .19">
          <joint name="press" type="slide" axis="0 0 1" range="-.1 .1"/>
          <joint name="sweep" type="slide" axis="1 0 0" range="-.1 .1"/>
          <geom name="tip" type="sphere" size=".04" mass=".1" solimp="0 .95 .02"/>
          <!-- The taxel grid itself is massless and non-colliding: it only samples. -->
          <geom name="skin" type="mesh" mesh="skin" mass="0"
                contype="0" conaffinity="0" rgba="1 1 1 .3"/>
        </body>
      </worldbody>
      <sensor>
        <tactile name="skin" geom="skin" mesh="skin"/>
      </sensor>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[model.joint("press").qposadr[0]] = -0.005
    data.qvel[model.joint("sweep").dofadr[0]] = 0.4
    mujoco.mj_forward(model, data)

    # Three channel-major planes of one value per mesh vertex: penetration depth, then
    # slip speed along each tangent. Only SDF geoms contribute, which is why the torus
    # is a mujoco.sdf.torus plugin geom rather than a plain mesh.
    depth, slip_tangent1, slip_tangent2 = data.sensor("skin").data.reshape(3, -1)
    touching = np.flatnonzero(depth)
    slip = np.hypot(slip_tangent1, slip_tangent2)
    print(
        f"3.3.5 tactile sensor: {len(touching)}/{len(depth)} taxels loaded,",
        f"max depth {depth.max() * 1e3:.2f} mm,",
        f"slip under the loaded taxels {slip[touching].min():.3f}-{slip[touching].max():.3f} m/s",
    )


def builtin_meshes() -> None:
    """Generate mesh assets from parameters instead of shipping OBJ files with the model."""
    spec = mujoco.MjSpec()

    # The MJCF spelling is <mesh builtin="supertorus" params="24 .3 1 1"/>; from Python
    # these convenience methods name the parameters, so procedural models stay readable.
    handle = spec.add_mesh(name="handle", scale=[0.08, 0.08, 0.08])
    handle.make_supertorus(resolution=24, radius=0.3, s=1.0, t=1.0)

    # e/n below 1 square the sphere off — a rounded box without a modelling tool.
    knob = spec.add_mesh(name="knob", scale=[0.04, 0.04, 0.02])
    knob.make_supersphere(resolution=20, e=0.4, n=0.4)

    # plate is a flat sampling grid for the tactile sensor, so its geom must stay
    # non-colliding — a coplanar mesh has no convex hull to build.
    pad = spec.add_mesh(name="pad", scale=[0.05, 0.05, 0.01])
    pad.make_plate(resolution=[8, 8])

    for mesh in (handle, knob):
        body = spec.worldbody.add_body(name=mesh.name, pos=[0, 0, 0.2])
        body.add_geom(type=mujoco.mjtGeom.mjGEOM_MESH, meshname=mesh.name)
    taxels = spec.worldbody.add_body(name=pad.name, pos=[0, 0, 0.2])
    taxels.add_geom(
        type=mujoco.mjtGeom.mjGEOM_MESH, meshname=pad.name, contype=0, conaffinity=0, mass=0
    )

    model = spec.compile()
    for mesh_id in range(model.nmesh):
        mesh = model.mesh(mesh_id)
        print(
            f"3.3.5 builtin meshes: '{mesh.name}' -> {model.mesh_vertnum[mesh_id]} vertices,",
            f"{model.mesh_facenum[mesh_id]} faces",
        )


def main() -> None:
    contact_sensor()
    insidesite_sensor()
    tactile_sensor()
    builtin_meshes()


if __name__ == "__main__":
    main()
