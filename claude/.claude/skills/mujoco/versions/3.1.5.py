# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.1.5 (May 7, 2024)."""

import mujoco
import numpy as np
from mujoco import mjx

# One module definition, six copies. Suffixes are zero-padded to the width of count-1,
# and every element that *references* the subtree is replicated too -- including the
# actuator and sensor declared outside the replicate block.
REPLICATE_XML = """
<mujoco model="gripper_ring">
  <compiler angle="radian"/>

  <worldbody>
    <light pos="0 0 1"/>
    <replicate count="6" sep="_" offset="0 0 0" euler="0 0 1.047">
      <body name="finger" pos=".08 0 .2">
        <joint name="flex" axis="0 1 0" range="0 1.4"/>
        <geom type="capsule" fromto="0 0 0 0 0 -.06" size=".008" mass=".02"/>
        <site name="tip" pos="0 0 -.06" size=".006"/>
      </body>
    </replicate>
  </worldbody>

  <actuator>
    <position name="flex" joint="flex" kp="2" ctrlrange="0 1.4"/>
  </actuator>

  <sensor>
    <framepos name="tip" objtype="site" objname="tip"/>
  </sensor>
</mujoco>
"""

# A unit tetrahedron, scaled anisotropically at compile time.
MESH_SCALE_XML = """
<mujoco model="scaled_mesh">
  <asset>
    <mesh name="wedge" scale=".2 .1 .05"
          vertex="0 0 0  1 0 0  0 1 0  0 0 1"
          face="0 2 1  0 1 3  0 3 2  1 2 3"/>
  </asset>

  <worldbody>
    <light pos="0 0 1"/>
    <body name="part" pos="0 0 .3">
      <freejoint/>
      <geom type="mesh" mesh="wedge"/>
    </body>
  </worldbody>
</mujoco>
"""

# metallic/roughness/bulbradius are inert in MuJoCo's own renderer: they exist so a
# path-tracer or USD/Isaac exporter can read PBR parameters straight off mjModel.
PBR_XML = """
<mujoco model="pbr_hints">
  <asset>
    <material name="brushed_steel" rgba=".7 .7 .75 1" metallic="1" roughness=".35"/>
    <material name="rubber" rgba=".1 .1 .1 1" metallic="0" roughness=".9"/>
    <material name="unset"/>
  </asset>

  <worldbody>
    <light name="spot" type="spot" pos="0 0 1.2" dir="0 0 -1" cutoff="45" bulbradius=".08"/>
    <geom name="shaft" type="cylinder" size=".05 .2" material="brushed_steel"/>
    <geom name="grip" type="capsule" fromto="0 0 .2 0 0 .3" size=".06" material="rubber"/>
  </worldbody>
</mujoco>
"""

MJX_XML = """
<mujoco model="mjx_constraints">
  <option jacobian="dense"/>

  <worldbody>
    <light pos="0 0 2"/>
    <geom name="floor" type="plane" size="2 2 .05"/>
    <body name="cube" pos="0 0 .045">
      <freejoint name="cube_free"/>
      <geom name="cube_geom" type="box" size=".05 .05 .05" condim="3"/>
    </body>
    <body name="arm" pos=".4 0 .3">
      <joint name="shoulder" type="hinge" axis="0 1 0" range="-.5 .5" limited="true"/>
      <geom name="arm_geom" type="capsule" fromto="0 0 0 .2 0 0" size=".02"/>
    </body>
  </worldbody>

  <equality>
    <weld name="hold" body1="arm" anchor="0 0 0"/>
  </equality>
</mujoco>
"""


def replicate_subtree() -> None:
    """Stamp out a repeated kinematic module without duplicating the MJCF by hand."""
    model = mujoco.MjModel.from_xml_string(REPLICATE_XML)
    data = mujoco.MjData(model)

    # Replaces hand-written copies or a Python string-templating pass over the MJCF.
    bodies = [model.body(i).name for i in range(1, model.nbody)]
    print(f"  nbody={model.nbody - 1} fingers: {bodies}")
    print(f"  actuators: {[model.actuator(i).name for i in range(model.nu)]}")
    print(f"  sensors:   {[model.sensor(i).name for i in range(model.nsensor)]}")

    # euler is cumulative between replicas, so 6 x 60 deg closes the ring.
    mujoco.mj_forward(model, data)
    tips_World = np.array([data.sensor(f"tip_{i}").data for i in range(model.nsensor)])
    angles_deg = np.degrees(np.arctan2(tips_World[:, 1], tips_World[:, 0]))
    print(f"  tip bearings (deg): {np.array2string(angles_deg, precision=1)}")


def mesh_asset_scale() -> None:
    """Recover the compile-time scale that was applied to a mesh asset's vertices."""
    model = mujoco.MjModel.from_xml_string(MESH_SCALE_XML)
    mesh_id = model.mesh("wedge").id

    # The compiler moves mesh vertices into the mesh's inertial frame (mesh_pos/mesh_quat)
    # after scaling them, so mesh_vert alone cannot be compared to the source asset.
    # mesh_scale is the only record of the <mesh scale> attribute, and it is the last
    # piece needed to invert the whole transform -- exporters and mesh-swapping code used
    # to have to re-parse the MJCF for it.
    scale = model.mesh_scale[mesh_id]
    vertadr = model.mesh_vertadr[mesh_id]
    verts = model.mesh_vert[vertadr : vertadr + model.mesh_vertnum[mesh_id]]

    rmat_Mesh_Source = np.zeros(9)
    mujoco.mju_quat2Mat(rmat_Mesh_Source, model.mesh_quat[mesh_id].astype(np.float64))
    source_verts = (verts @ rmat_Mesh_Source.reshape(3, 3).T + model.mesh_pos[mesh_id]) / scale

    print(f"  mesh_scale={np.array2string(scale, precision=3)}")
    print(f"  compiled vert[0]={np.array2string(verts[0], precision=4)}")
    print(f"  recovered source verts:\n{np.round(source_verts, 6) + 0.0}")


def pbr_material_hints() -> None:
    """Carry PBR material and light-bulb parameters through mjModel for external renderers."""
    model = mujoco.MjModel.from_xml_string(PBR_XML)

    for name in ("brushed_steel", "rubber", "unset"):
        mat_id = model.material(name).id
        metallic = model.mat_metallic[mat_id]
        roughness = model.mat_roughness[mat_id]
        # -1 is the "not specified" sentinel; the renderer should fall back to its own default.
        unset = "  (unset)" if metallic < 0 else ""
        print(f"  {name:<14} metallic={metallic:+.2f} roughness={roughness:+.2f}{unset}")

    light_id = model.light("spot").id
    print(f"  spot light bulbradius={model.light_bulbradius[light_id]:.3f} m (soft shadows)")


def mjx_constraint_layout() -> None:
    """Read MJX's constraint block sizes and per-contact efc addresses back on device."""
    mj_model = mujoco.MjModel.from_xml_string(MJX_XML)
    model = mjx.put_model(mj_model)
    data = mjx.make_data(model)
    data = mjx.forward(model, data)

    # These counts match mjData exactly, so the same indexing code works on both sides.
    # On 3.11 the JAX backend keeps them under Data._impl; they are not traced, so they
    # are plain Python ints and safe to slice with.
    impl = data._impl
    print(f"  ne={impl.ne} nf={impl.nf} nl={impl.nl} nefc={impl.nefc} ncon={impl.ncon}")

    types = [mujoco.mjtConstraint(t).name for t in np.unique(np.asarray(impl.efc_type))]
    print(f"  efc_type present: {types}")

    contact = impl.contact
    geom_pairs = np.asarray(contact.geom)
    dist = np.asarray(contact.dist)
    # contact.geom replaces the deprecated geom1/geom2 scalars: one (ncon, 2) array to vmap
    # over. MJX pre-allocates every potential contact slot so shapes stay static under jit;
    # unengaged slots are still listed, with a large positive dist.
    for i in range(impl.ncon):
        name1 = mjx.id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_pairs[i, 0]))
        name2 = mjx.id2name(model, mujoco.mjtObj.mjOBJ_GEOM, int(geom_pairs[i, 1]))
        engaged = "engaged" if dist[i] < 0 else "idle"
        print(
            f"  contact {i}: {name1}-{name2} dim={contact.dim[i]}"
            f" efc_address={contact.efc_address[i]} dist={dist[i]:+.4f} ({engaged})"
        )


def mjx_name_lookup() -> None:
    """Resolve MuJoCo names to ids directly against an mjx.Model, on either model type."""
    mj_model = mujoco.MjModel.from_xml_string(MJX_XML)
    model = mjx.put_model(mj_model)

    # mjx.name2id / mjx.id2name mirror mj_name2id / mj_id2name and accept either model
    # type, so index-building code no longer has to be duplicated per backend.
    body_id = mjx.name2id(model, mujoco.mjtObj.mjOBJ_BODY, "cube")
    joint_id = mjx.name2id(model, mujoco.mjtObj.mjOBJ_JOINT, "shoulder")
    missing = mjx.name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "nonexistent")
    print(f"  body 'cube' -> {body_id}, joint 'shoulder' -> {joint_id}, unknown -> {missing}")
    print(f"  geom ids -> {[mjx.id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) for i in range(3)]}")
    print(f"  agrees with mujoco: {mujoco.mj_name2id(mj_model, mujoco.mjtObj.mjOBJ_BODY, 'cube')}")


def main() -> None:
    print("replicate_subtree:")
    replicate_subtree()
    print("mesh_asset_scale:")
    mesh_asset_scale()
    print("pbr_material_hints:")
    pbr_material_hints()
    print("mjx_constraint_layout:")
    mjx_constraint_layout()
    print("mjx_name_lookup:")
    mjx_name_lookup()


if __name__ == "__main__":
    main()
