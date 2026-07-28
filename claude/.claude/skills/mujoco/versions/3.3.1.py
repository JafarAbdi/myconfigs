# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.3.1 (April 9, 2025)."""

import mujoco
import numpy as np


def spec_attach() -> None:
    """Graft a child MjSpec onto a parent at a frame or a site, with one call for both."""

    def gripper() -> mujoco.MjSpec:
        return mujoco.MjSpec.from_string("""
        <mujoco model="gripper">
          <worldbody>
            <body name="palm">
              <geom name="palm" type="box" size=".02 .03 .01" mass=".2"/>
              <body name="finger" pos=".02 0 .01">
                <joint name="grip" type="slide" axis="1 0 0" range="0 .03"/>
                <geom name="pad" type="box" size=".005 .02 .02" mass=".05"/>
              </body>
            </body>
          </worldbody>
          <actuator><position name="grip" joint="grip" kp="20"/></actuator>
        </mujoco>""")

    torso = mujoco.MjSpec.from_string("""
    <mujoco model="torso">
      <worldbody>
        <body name="left_wrist" pos="-.2 0 1">
          <joint name="left_roll" type="hinge" axis="0 0 1"/>
          <geom name="left_flange" type="cylinder" size=".03 .01" mass=".5"/>
          <frame name="left_tool" pos="0 0 .01" euler="0 0 90"/>
        </body>
        <body name="right_wrist" pos=".2 0 1">
          <joint name="right_roll" type="hinge" axis="0 0 1"/>
          <geom name="right_flange" type="cylinder" size=".03 .01" mass=".5"/>
          <site name="right_tool" pos="0 0 .01"/>
        </body>
      </worldbody>
    </mujoco>""")

    # mjs_attach, one function for all four cases; it replaced mjs_attachBody, mjs_attachFrame,
    # mjs_attachToSite and mjs_attachFrameToSite, which were removed in 3.3.1.
    torso.attach(gripper(), frame="left_tool", prefix="left_")
    # prefix defaults to "/" when omitted, so pass "" explicitly if a suffix is doing the work.
    torso.attach(gripper(), site="right_tool", prefix="", suffix="_right")

    model = torso.compile()
    bodies = [model.body(i).name for i in range(model.nbody)]
    actuators = [model.actuator(i).name for i in range(model.nu)]
    print(f"bodies    = {bodies}")
    print(f"actuators = {actuators}")

    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    print(f"left pad  pos_World = {data.body('left_finger').xpos.round(4)}")
    print(f"right pad pos_World = {data.body('finger_right').xpos.round(4)}")


def tendon_armature() -> None:
    """Model the reflected inertia of a leadscrew or hydraulic ram without extra dofs."""
    # tendon/armature is the tendon analogue of joint/armature. It replaces the old workaround of
    # a rotary joint plus a slider plus a connect constraint just to carry the spinning inertia.
    xml = """
    <mujoco>
      <option gravity="0 0 0"/>
      <worldbody>
        <site name="cylinder_base" pos="0 0 .8"/>
        <body name="ram" pos="0 0 .3">
          <joint name="stroke" type="slide" axis="0 0 1" range="0 .4"/>
          <geom type="cylinder" size=".03 .1" mass="2"/>
          <site name="rod_end" pos="0 0 .1"/>
        </body>
      </worldbody>
      <tendon>
        <spatial name="leadscrew" armature="{armature}">
          <site site="cylinder_base"/>
          <site site="rod_end"/>
        </spatial>
      </tendon>
      <actuator><motor name="drive" tendon="leadscrew" gear="1"/></actuator>
    </mujoco>"""

    payload = 2.0
    for armature in (0.0, 6.0):
        model = mujoco.MjModel.from_xml_string(xml.format(armature=armature))
        data = mujoco.MjData(model)
        data.ctrl[0] = -10.0  # pull the ram out
        mujoco.mj_forward(model, data)
        # ten_J is flat sparse (nJten,), not (ntendon, nv) — index it only when you know the
        # layout. Here nv == 1, so its single entry is the moment arm, +-1, and M = payload
        # + armature exactly. For the general case densify it, as 3.6.0 sparse_tendon_jacobian does.
        print(
            f"armature={armature:3.1f} kg  ten_J={data.ten_J[0]:+.1f}  "
            f"M={data.M[0]:.1f} kg (payload+armature={payload + armature:.1f})  "
            f"qacc={data.qacc[0]:.3f} m/s^2"
        )


def tendon_actuator_force_limits() -> None:
    """Clamp the total actuator force pulling on a tendon and read it back from a sensor."""
    # tendon/actuatorfrcrange is the tendon counterpart of joint/actuatorfrcrange: it limits the
    # SUM over all actuators driving the tendon, which per-actuator forcerange cannot express.
    xml = """
    <mujoco>
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
    data = mujoco.MjData(model)
    print(f"rope actuatorfrcrange = {model.tendon_actfrcrange[0]} N")

    for commanded in (-40.0, -200.0):
        mujoco.mj_resetData(model, data)
        data.ctrl[:] = (commanded, commanded)
        mujoco.mj_step(model, data)
        print(
            f"ctrl={commanded:7.1f} N each -> actuator_force={data.actuator_force} "
            f"sum={data.actuator_force.sum():7.1f} N"
            f"  sensor={data.sensor('rope_frc').data[0]:7.1f} N"
        )


def save_inertial() -> None:
    """Bake compiled inertias into saved XML so a consumer reproduces them without the meshes."""
    tetrahedron = "0 0 0  .12 0 0  0 .18 0  0 0 .09"
    spec = mujoco.MjSpec.from_string(f"""
    <mujoco>
      <asset><mesh name="wedge" vertex="{tetrahedron}"/></asset>
      <worldbody>
        <body name="wedge">
          <freejoint/>
          <geom type="mesh" mesh="wedge" mass="1.4"/>
        </body>
      </worldbody>
    </mujoco>""")

    # compiler/saveinertial writes an explicit <inertial> for every body on save; without it the
    # inertia is only recoverable by re-running mesh inertia inference, i.e. by shipping the mesh.
    for saveinertial in (False, True):
        spec.compiler.saveinertial = saveinertial
        spec.compile()
        inertials = [line.strip() for line in spec.to_xml().splitlines() if "<inertial" in line]
        print(f"saveinertial={saveinertial!s:5s} -> {inertials or 'no <inertial> clause emitted'}")


def composite_orientation() -> None:
    """Lay out a composite cable along an arbitrary direction, or inside a frame."""
    # composite/quat (new in 3.3.1) rotates the generated chain; before this the only way to aim a
    # composite was to rotate the parent body. Composites may now also sit directly under a frame.
    xml = """
    <mujoco>
      <worldbody>
        <frame name="mast" pos=".3 0 1.2" euler="0 0 {yaw_deg}">
          <composite type="cable" curve="s" count="9 1 1" size=".4" offset="0 0 0"
                     quat="0.9659 0 0.2588 0" initial="none">
            <geom type="capsule" size=".006" rgba=".8 .3 .1 1" mass=".02"/>
          </composite>
        </frame>
      </worldbody>
    </mujoco>"""
    # composite/quat tilts the chain 30 deg below +x; the enclosing frame then yaws the whole thing.
    for yaw_deg in (0, 45):
        model = mujoco.MjModel.from_xml_string(xml.format(yaw_deg=yaw_deg))
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        pos_World_Root = data.xpos[1]
        pos_World_Tip = data.xpos[model.nbody - 1]
        axis = pos_World_Tip - pos_World_Root
        print(
            f"frame yaw={yaw_deg:2d} deg: {model.nbody - 1} links, root={pos_World_Root.round(3)}"
            f" tip={pos_World_Tip.round(3)} chain axis={(axis / np.linalg.norm(axis)).round(3)}"
        )


def bind_unnamed_elements() -> None:
    """Read compiled model/data values for spec elements you never bothered to name."""
    spec = mujoco.MjSpec()
    spec.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_PLANE, size=[2, 2, 0.1])
    rungs = []
    for i in range(4):
        body = spec.worldbody.add_body(pos=[0, 0, 0.2 + 0.15 * i])
        body.add_freejoint()
        rungs.append(
            body.add_geom(type=mujoco.mjtGeom.mjGEOM_BOX, size=[0.2, 0.02, 0.01], mass=0.3)
        )

    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=200)

    # bind() takes the mjs element itself, so procedurally built models need no name bookkeeping
    # and no dm_control PyMJCF-style wrapper objects.
    print(f"geom names: {[geom.name for geom in rungs]!r}")
    for i, rung in enumerate(rungs):
        print(
            f"rung {i}: half-size={model.bind(rung).size}  "
            f"settled z={data.bind(rung).xpos[2]:.4f} m"
        )
    heights = sorted(data.bind(rung).xpos[2] for rung in rungs)
    print(f"stack heights sorted = {np.round(heights, 4)} (rungs are 0.02 m thick)")


def main() -> None:
    for demo in (
        spec_attach,
        tendon_armature,
        tendon_actuator_force_limits,
        save_inertial,
        composite_orientation,
        bind_unnamed_elements,
    ):
        print(f"\n=== {demo.__name__}: {demo.__doc__}")
        demo()


if __name__ == "__main__":
    main()
