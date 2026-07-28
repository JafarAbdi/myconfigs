# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.3.7 (October 13, 2025)."""

import pathlib
import tempfile

import mujoco

# A unit tetrahedron, small enough to inline but a real mesh asset.
TETRAHEDRON_OBJ = """v 0 0 0
v 0.1 0 0
v 0 0.1 0
v 0 0 0.1
f 1 3 2
f 1 2 4
f 1 4 3
f 2 3 4
"""


def spec_compiler_asset_dirs() -> None:
    """Give each spec its own mesh/texture search path so attached models keep resolving."""
    # meshdir and texturedir now live on spec.compiler, alongside degree/autolimits.
    # The old spec.meshdir / spec.texturedir aliases still work but are on the way out.
    gripper = mujoco.MjSpec()
    gripper.modelname = "gripper"
    gripper.compiler.meshdir = "gripper_assets"
    gripper.assets = {"gripper_assets/finger.obj": TETRAHEDRON_OBJ}
    gripper.add_mesh(name="finger", file="finger.obj")
    finger = gripper.worldbody.add_body(name="finger", pos=[0, 0, 0.02])
    finger.add_geom(type=mujoco.mjtGeom.mjGEOM_MESH, meshname="finger")

    scene = mujoco.MjSpec()
    scene.modelname = "scene"
    scene.compiler.meshdir = "scene_assets"
    scene.assets = {"scene_assets/table.obj": TETRAHEDRON_OBJ}
    scene.add_mesh(name="table", file="table.obj")
    table = scene.worldbody.add_body(name="table")
    table.add_geom(type=mujoco.mjtGeom.mjGEOM_MESH, meshname="table")

    # Every element also exposes the compiler of the spec it was authored in, which is
    # what makes attaching two models with different asset layouts work at all.
    # Attaching a whole spec carries its referenced assets across too, renaming them
    # under the prefix — so the two search paths coexist with no manual merging.
    mount = scene.worldbody.add_frame(pos=[0, 0, 0.4])
    scene.attach(gripper, frame=mount, prefix="gripper-")
    print(
        "3.3.7 compiler asset dirs:",
        f"table geom -> {scene.geoms[0].compiler.meshdir},",
        f"attached finger geom -> {scene.geoms[1].compiler.meshdir}",
    )
    print(f"3.3.7 compiler asset dirs: assets after attach -> {sorted(scene.assets)}")

    model = scene.compile()
    print(
        "3.3.7 compiler asset dirs: compiled",
        f"{model.nmesh} meshes from two search paths,",
        f"bodies={[model.body(i).name for i in range(1, model.nbody)]}",
    )


def xml_dependencies() -> None:
    """List every asset file an MJCF pulls in, to package or preflight a model."""
    with tempfile.TemporaryDirectory() as tmpdir:
        root = pathlib.Path(tmpdir)
        (root / "assets").mkdir()
        (root / "assets" / "link.obj").write_text(TETRAHEDRON_OBJ)
        (root / "robot.xml").write_text("""
        <mujoco model="robot">
          <compiler meshdir="assets"/>
          <asset>
            <mesh name="link" file="link.obj"/>
            <mesh name="tool" file="tool.obj"/>
          </asset>
          <worldbody>
            <body name="link"><geom type="mesh" mesh="link"/></body>
            <body name="tool" pos="0 0 .2"><geom type="mesh" mesh="tool"/></body>
          </worldbody>
        </mujoco>
        """)
        (root / "scene.xml").write_text("""
        <mujoco model="scene">
          <include file="robot.xml"/>
          <worldbody><geom name="floor" type="plane" size="1 1 .1"/></worldbody>
        </mujoco>
        """)

        # Replaces hand-rolled XML walking: this recurses through <include> and applies
        # meshdir/texturedir, returning absolute paths including the root file itself.
        paths = mujoco.mju_getXMLDependencies(str(root / "scene.xml"))
        dependencies = [pathlib.Path(path) for path in paths]
        print(
            "3.3.7 XML dependencies:",
            sorted(str(path.relative_to(root)) for path in dependencies),
        )

        # It is a static scan, not a load, so it also names assets that are missing —
        # which is what makes it usable as a packaging preflight check.
        missing = [path.relative_to(root) for path in dependencies if not path.exists()]
        print(f"3.3.7 XML dependencies: {len(missing)} referenced file(s) absent on disk: {missing}")


def main() -> None:
    spec_compiler_asset_dirs()
    xml_dependencies()


if __name__ == "__main__":
    main()
