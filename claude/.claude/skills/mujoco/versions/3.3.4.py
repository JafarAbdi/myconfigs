# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.3.4 (July 8, 2025)."""

import mujoco


def spec_delete() -> None:
    """Remove a subtree from an MjSpec together with everything that references it."""
    xml = """
    <mujoco model="two_arm">
      <compiler autolimits="true"/>
      <worldbody>
        <body name="left_shoulder" pos="-0.2 0 0.6">
          <joint name="left_shoulder_pitch" axis="0 1 0" range="-2 2"/>
          <geom name="left_upper_arm" type="capsule" fromto="0 0 0 0 0 -0.3" size="0.03"/>
          <body name="left_elbow" pos="0 0 -0.3">
            <joint name="left_elbow_pitch" axis="0 1 0" range="0 2.5"/>
            <geom name="left_forearm" type="capsule" fromto="0 0 0 0 0 -0.25" size="0.025"/>
            <site name="left_tool" pos="0 0 -0.25"/>
          </body>
        </body>
        <body name="right_shoulder" pos="0.2 0 0.6">
          <joint name="right_shoulder_pitch" axis="0 1 0" range="-2 2"/>
          <geom name="right_upper_arm" type="capsule" fromto="0 0 0 0 0 -0.3" size="0.03"/>
          <body name="right_elbow" pos="0 0 -0.3">
            <joint name="right_elbow_pitch" axis="0 1 0" range="0 2.5"/>
            <geom name="right_forearm" type="capsule" fromto="0 0 0 0 0 -0.25" size="0.025"/>
            <site name="right_tool" pos="0 0 -0.25"/>
          </body>
        </body>
      </worldbody>
      <contact>
        <pair name="arm_arm" geom1="left_forearm" geom2="right_forearm"/>
      </contact>
      <actuator>
        <position name="left_shoulder" joint="left_shoulder_pitch" kp="30" kv="3"/>
        <position name="left_elbow" joint="left_elbow_pitch" kp="20" kv="2"/>
        <position name="right_shoulder" joint="right_shoulder_pitch" kp="30" kv="3"/>
        <position name="right_elbow" joint="right_elbow_pitch" kp="20" kv="2"/>
      </actuator>
      <sensor>
        <framepos name="left_tool_pos" objtype="site" objname="left_tool"/>
        <framepos name="right_tool_pos" objtype="site" objname="right_tool"/>
      </sensor>
    </mujoco>
    """
    spec = mujoco.MjSpec.from_string(xml)

    # spec.delete(element) is the single removal entry point: it replaces the old
    # element.delete() methods and the mjs_detachBody / mjs_detachDefault C functions.
    spec.delete(spec.body("left_shoulder"))

    model = spec.compile()
    print("3.3.4 spec.delete: kept bodies", [model.body(i).name for i in range(1, model.nbody)])
    print(
        "3.3.4 spec.delete: dangling references removed with the subtree —",
        f"actuators={[actuator.name for actuator in spec.actuators]},",
        f"sensors={[sensor.name for sensor in spec.sensors]},",
        f"pairs={[pair.name for pair in spec.pairs]}",
    )


def spec_name_collisions() -> None:
    """Reject a duplicate element name where it is assigned, not at compile time."""
    spec = mujoco.MjSpec()
    spec.worldbody.add_geom(name="table", type=mujoco.mjtGeom.mjGEOM_BOX, size=[0.6, 0.4, 0.02])
    spec.worldbody.add_site(name="tool_frame", pos=[0, 0, 0.1])

    # Assigning .name now goes through mjs_setName, which checks for collisions at
    # set-time; previously the name was a plain string and the clash only surfaced
    # as a compile error, far away from the code that chose the name.
    site = spec.worldbody.add_site(pos=[0.1, 0, 0.1])
    try:
        site.name = "tool_frame"
    except ValueError as error:
        print(f"3.3.4 set-time name check: {error}")
        site.name = "tool_frame_2"

    model = spec.compile()
    print(
        "3.3.4 set-time name check: compiled with sites",
        [model.site(i).name for i in range(model.nsite)],
    )


def main() -> None:
    spec_delete()
    spec_name_collisions()


if __name__ == "__main__":
    main()
