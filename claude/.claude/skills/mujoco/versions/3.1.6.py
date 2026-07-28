# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.1.6 (Jun 3, 2024)."""

import mujoco
import numpy as np

CLEARANCE_XML = """
<mujoco model="clearance">
  <worldbody>
    <light pos="0 0 2"/>
    <geom name="table" type="box" size=".4 .4 .02" pos="0 0 .3"/>
    <body name="tool" pos="0 0 .6">
      <joint name="lift" type="slide" axis="0 0 1" range="-.4 .1"/>
      <geom name="finger" type="capsule" fromto="-.05 0 0 .05 0 0" size=".01"/>
    </body>
  </worldbody>
</mujoco>
"""

COLLISION_SENSOR_XML = """
<mujoco model="collision_sensors">
  <worldbody>
    <light pos="0 0 2"/>
    <body name="table">
      <geom name="top" type="box" size=".4 .4 .02" pos="0 0 .3"/>
      <geom name="leg" type="cylinder" size=".03 .15" pos="0 0 .15"/>
      <!-- A guard rail above the table top: nearer to the tool than "top" is. -->
      <geom name="rail" type="capsule" fromto="0 -.3 .45 0 .3 .45" size=".02"/>
    </body>
    <body name="tool" pos="0 0 .6">
      <joint name="lift" type="slide" axis="0 0 1" range="-.4 .1"/>
      <geom name="finger" type="capsule" fromto="-.05 0 0 .05 0 0" size=".01"/>
    </body>
  </worldbody>

  <sensor>
    <!-- For collision sensors cutoff is the search radius (mj_geomDistance's distmax), not the
         usual clipping value; distance additionally returns cutoff when nothing is found. -->
    <distance name="gap" geom1="finger" geom2="top" cutoff=".5"/>
    <!-- normal always points from the geom1 surface to the geom2 surface, which under penetration
         is generally opposite to the centroid-to-centroid direction: that is why it flips sign on
         the last row below. fromto is (point on geom1, point on geom2); both return zeros on a
         miss, and for these two cutoff never clips. -->
    <normal name="gap_normal" geom1="finger" geom2="top" cutoff=".5"/>
    <fromto name="gap_segment" geom1="finger" geom2="top" cutoff=".5"/>
    <!-- body1/body2 scan every geom of the body and keep the smallest distance, so this
         one tracks whichever part of the table is closest, not a hard-coded geom. -->
    <distance name="gap_body" geom1="finger" body2="table" cutoff=".5"/>
  </sensor>
</mujoco>
"""

POSITION_ACTUATOR_XML = """
<mujoco model="position_actuator">
  <compiler angle="radian"/>
  <option timestep=".002" integrator="implicitfast"/>

  <default>
    <geom type="capsule" fromto="0 0 0 .3 0 0" size=".03" mass="1"/>
    <joint type="hinge" axis="0 0 1" range="-1.5 1.5"/>
    <position kp="30" ctrlrange="-1.5 1.5"/>
  </default>

  <worldbody>
    <light pos="0 0 2"/>
    <body name="link_pd" pos="0 -.4 .5">
      <joint name="elbow_pd"/>
      <geom/>
    </body>
    <body name="link_filtered" pos="0 .4 .5">
      <joint name="elbow_filtered"/>
      <geom/>
    </body>
  </worldbody>

  <actuator>
    <!-- dampratio sets kv in natural units: 1 is critical damping for this joint's inertia. -->
    <position name="pd" joint="elbow_pd" dampratio="1"/>
    <!-- timeconst makes the actuator stateful: ctrl is low-pass filtered by act, exactly. -->
    <position name="filtered" joint="elbow_filtered" dampratio="1" timeconst=".15"/>
  </actuator>
</mujoco>
"""


def geom_clearance() -> None:
    """Shortest signed distance between two geoms and the segment realizing it."""
    model = mujoco.MjModel.from_xml_string(CLEARANCE_XML)
    data = mujoco.MjData(model)
    finger_id = model.geom("finger").id
    table_id = model.geom("table").id

    # mj_geomDistance queries the narrowphase collider directly, so it ignores contype /
    # conaffinity and the contact list. Before 3.1.6 this meant inflating geom margin and
    # reading mjData.contact back out, which perturbed the dynamics being measured.
    distmax = 0.5
    fromto = np.zeros(6)
    for lift in (0.0, -0.15, -0.25, -0.28):
        data.qpos[model.joint("lift").qposadr] = lift
        mujoco.mj_forward(model, data)
        distance = mujoco.mj_geomDistance(model, data, finger_id, table_id, distmax, fromto)
        pos_World_OnFinger, pos_World_OnTable = fromto[:3], fromto[3:]
        print(
            f"  lift={lift:+.2f}  distance={distance:+.4f}"
            f"  finger={np.array2string(pos_World_OnFinger, precision=3)}"
            f"  table={np.array2string(pos_World_OnTable, precision=3)}"
        )

    # Nothing within distmax: the call returns distmax and leaves fromto zeroed.
    data.qpos[model.joint("lift").qposadr] = 0.0
    mujoco.mj_forward(model, data)
    fromto[:] = 0
    far = mujoco.mj_geomDistance(model, data, finger_id, table_id, 0.05, fromto)
    print(f"  distmax=0.05 -> {far:.4f} (no witness segment written: {not fromto.any()})")


def collision_sensors() -> None:
    """Declare geom-geom clearance, contact normal and witness segment as sensors in the model."""
    model = mujoco.MjModel.from_xml_string(COLLISION_SENSOR_XML)
    data = mujoco.MjData(model)

    # The declarative form of mj_geomDistance: values land in mjData.sensordata every
    # mj_forward, so they are available to rollout, MJX-free logging and sensor-based rewards.
    for lift in (0.0, -0.12, -0.25, -0.28):
        data.qpos[model.joint("lift").qposadr] = lift
        mujoco.mj_forward(model, data)
        gap = data.sensor("gap").data[0]
        normal_World = data.sensor("gap_normal").data
        segment = data.sensor("gap_segment").data
        gap_body = data.sensor("gap_body").data[0]
        print(
            f"  lift={lift:+.2f}  gap={gap:+.4f}  gap_to_body={gap_body:+.4f}"
            f"  normal={np.array2string(normal_World, precision=3)}"
            f"  segment={np.array2string(segment, precision=3)}"
        )

    types = [mujoco.mjtSensor(model.sensor_type[i]).name for i in range(model.nsensor)]
    print(f"  sensor types: {types}")


def position_actuator_shaping() -> None:
    """Tune a position actuator's damping in natural units and low-pass its setpoint."""
    model = mujoco.MjModel.from_xml_string(POSITION_ACTUATOR_XML)
    data = mujoco.MjData(model)
    pd_id = model.actuator("pd").id
    filtered_id = model.actuator("filtered").id

    # dampratio is resolved at compile time into biasprm[2] = -kv using the joint's
    # effective inertia, so you state the damping you want instead of hand-computing kv.
    # It is a compile-time conversion: change the link's inertia later and you must
    # recompile (or fix up biasprm and call mj_setConst) for kv to follow.
    kp = model.actuator_gainprm[pd_id, 0]
    kv = -model.actuator_biasprm[pd_id, 2]
    print(f"  dampratio=1 with kp={kp:.1f} compiled to kv={kv:.4f}")

    # timeconst gives the actuator filterexact dynamics, so it owns one act variable.
    act_adr = model.actuator_actadr[filtered_id]
    print(f"  na={model.na}, actadr(filtered)={act_adr}, actadr(pd)={model.actuator_actadr[pd_id]}")

    setpoint = 1.0
    data.ctrl[[pd_id, filtered_id]] = setpoint
    for _ in range(4):
        mujoco.mj_step(model, data, nstep=75)
        qpos_pd, qpos_filtered = data.qpos[[0, 1]]
        print(
            f"  t={data.time:.2f}s  act={data.act[act_adr]:.4f}"
            f"  pd={qpos_pd:.4f} rad  filtered={qpos_filtered:.4f} rad"
        )


def main() -> None:
    print("geom_clearance:")
    geom_clearance()
    print("collision_sensors:")
    collision_sensors()
    print("position_actuator_shaping:")
    position_actuator_shaping()


if __name__ == "__main__":
    main()
