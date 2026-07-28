# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.8.1 (May 11, 2026)."""

import pathlib
import tempfile
import textwrap

import mujoco
import numpy as np

# A unit cube, as an in-memory .obj asset. Stands in for a mesh that arrives
# over the network, out of a zip, or from a procedural generator.
BOX_OBJ = textwrap.dedent("""\
    v -0.5 -0.5 -0.5
    v  0.5 -0.5 -0.5
    v  0.5  0.5 -0.5
    v -0.5  0.5 -0.5
    v -0.5 -0.5  0.5
    v  0.5 -0.5  0.5
    v  0.5  0.5  0.5
    v -0.5  0.5  0.5
    f 1 2 3 4
    f 5 8 7 6
    f 1 5 6 2
    f 2 6 7 3
    f 3 7 8 4
    f 4 8 5 1
""").encode()

MESH_XML = """
<mujoco model="palletizer">
  <asset>
    <mesh name="crate" file="crate.obj" scale="0.4 0.3 0.25"/>
  </asset>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="crate_0" pos="0 0 0.2">
      <freejoint/>
      <geom name="crate_0" type="mesh" mesh="crate" mass="8"/>
    </body>
  </worldbody>
</mujoco>
"""


def vfs_assets() -> None:
    """Feed in-memory assets to the compiler through a virtual file system."""
    # MjVfs replaces the deprecated `assets={name: bytes}` dict, which is slated
    # for removal; one VFS is shared by every parse/compile instead of being
    # rebuilt and re-copied per call. Passing both `assets` and `vfs` is an error.
    with mujoco.MjVfs() as vfs:
        vfs["crate.obj"] = BOX_OBJ
        assert "crate.obj" in vfs  # __contains__ wraps mj_containsBufferVFS.

        # Parsing and compiling both resolve `file="crate.obj"` out of the VFS.
        spec = mujoco.MjSpec.from_string(MESH_XML, vfs=vfs)
        model = spec.compile(vfs=vfs)

        # The VFS outlives the compile, so edit-and-recompile costs nothing extra.
        for index in range(1, 4):
            body = spec.worldbody.add_body(name=f"crate_{index}", pos=[0, 0, 0.2 + 0.3 * index])
            body.add_freejoint()
            body.add_geom(name=f"crate_{index}", type=mujoco.mjtGeom.mjGEOM_MESH,
                          meshname="crate", mass=8)
        stacked = spec.compile(vfs=vfs)

        del vfs["crate.obj"]
        assert "crate.obj" not in vfs

    print(f"vfs_assets: first compile ngeom={model.ngeom}, restacked ngeom={stacked.ngeom}, "
          f"mesh verts={stacked.mesh('crate').vertnum[0]}, "
          f"crate mass={stacked.body('crate_3').mass[0]:.1f} kg")


def spec_encode() -> None:
    """Serialize a spec through a registered encoder plugin, chosen by file extension."""
    spec = mujoco.MjSpec()
    spec.modelname = "two_link_arm"
    spec.option.timestep = 0.002

    shoulder = spec.worldbody.add_body(name="upper_arm", pos=[0, 0, 1])
    shoulder.add_joint(name="shoulder", type=mujoco.mjtJoint.mjJNT_HINGE, axis=[0, 1, 0])
    shoulder.add_geom(type=mujoco.mjtGeom.mjGEOM_CAPSULE, fromto=[0, 0, 0, 0.3, 0, 0], size=[0.04])
    elbow = shoulder.add_body(name="forearm", pos=[0.3, 0, 0])
    elbow.add_joint(name="elbow", type=mujoco.mjtJoint.mjJNT_HINGE, axis=[0, 1, 0])
    elbow.add_geom(type=mujoco.mjtGeom.mjGEOM_CAPSULE, fromto=[0, 0, 0, 0.25, 0, 0], size=[0.035])
    for joint in ("shoulder", "elbow"):
        actuator = spec.add_actuator(name=joint, target=joint,
                                     trntype=mujoco.mjtTrn.mjTRN_JOINT)
        actuator.set_to_position(kp=40, dampratio=1)
    model = spec.compile()

    with tempfile.TemporaryDirectory() as tmpdir:
        path = pathlib.Path(tmpdir) / "arm.xml"
        # 3.8.1 is where MjSpec.encode appeared as a Python method: one call that
        # dispatches on file extension to a registered mjpEncoder, where `to_file`
        # is always MJCF XML. Pass the compiled model to fold runtime edits back
        # into the output. For the full set of formats see 3.11.0 encode_model.
        nbytes = spec.encode(str(path), model)
        reloaded = mujoco.MjSpec.from_file(str(path)).compile()

    print(f"spec_encode: wrote {nbytes} bytes, reloaded "
          f"nbody={reloaded.nbody} nu={reloaded.nu} timestep={reloaded.opt.timestep}, "
          f"round-trip identical={reloaded.nbody == model.nbody and reloaded.nu == model.nu}")


def dense_inertia_matrix() -> None:
    """Expand mjData.M (sparse CSR) into a dense inertia matrix for linear algebra."""
    xml = """
    <mujoco>
      <worldbody>
        <body name="torso" pos="0 0 1">
          <freejoint/>
          <geom type="capsule" fromto="0 0 0 0 0 0.4" size="0.07" mass="12"/>
          <body name="arm" pos="0 0 0.4">
            <joint name="shoulder" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.04" mass="2"/>
            <body name="hand" pos="0.3 0 0">
              <joint name="elbow" axis="0 1 0"/>
              <geom type="capsule" fromto="0 0 0 0.25 0 0" size="0.03" mass="1"/>
            </body>
          </body>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[model.joint("shoulder").qposadr[0]] = 0.6
    mujoco.mj_forward(model, data)

    # mju_sym2dense expands a lower-triangular, implicitly symmetric CSR matrix, of which
    # mjData.M is the canonical example. In 3.8.1 `mj_fullM(m, dst, d.qM)` still worked;
    # MuJoCo shipped this as the forward-compatible way to write the same thing, ahead of
    # the announced breakage (mj_fullM became mj_fullM(m, d, dst) in 3.10.0, and the legacy
    # qM layout was removed outright in 3.11.0).
    inertia = np.zeros((model.nv, model.nv))
    mujoco.mju_sym2dense(inertia, data.M, model.M_rownnz, model.M_rowadr, model.M_colind)

    # Cross-check against the sparse multiply MuJoCo uses internally.
    v = np.linspace(-1.0, 1.0, model.nv)
    momentum = np.zeros(model.nv)
    mujoco.mj_mulM(model, data, momentum, v)

    print(f"dense_inertia_matrix: nv={model.nv} nM={model.nM} "
          f"(dense would be {model.nv**2}), symmetric={np.allclose(inertia, inertia.T)}, "
          f"matches mj_mulM={np.allclose(inertia @ v, momentum)}, "
          f"condition number={np.linalg.cond(inertia):.1f}")


def main() -> None:
    vfs_assets()
    spec_encode()
    dense_inertia_matrix()


if __name__ == "__main__":
    main()
