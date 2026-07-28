# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.10.0 (June 22, 2026)."""

import os
import pathlib
import tempfile
import warnings

import mujoco
import numpy as np

# Eight boxes dropped far enough apart that each one is its own constraint island.
CRATES_XML = """
<mujoco model="crates">
  <option timestep="0.002"/>
  <worldbody>
    <geom name="floor" type="plane" size="10 10 .1"/>
    {crates}
  </worldbody>
</mujoco>
"""


def threadpool() -> None:
    """Spread collision detection and per-island constraint solving over worker threads."""
    # Current replacement for the removed mjthread.h engine threading API: the pool is
    # attached to the mjData and torn down with it, so there is nothing to bind or free.
    crates = "".join(
        f'<body name="crate_{i}" pos="{1.5 * i} 0 0.4">'
        f'<freejoint/><geom type="box" size=".1 .1 .1" mass="2"/></body>'
        for i in range(8)
    )
    model = mujoco.MjModel.from_xml_string(CRATES_XML.format(crates=crates))

    def settle(*, nthread: int) -> mujoco.MjData:
        data = mujoco.MjData(model)
        if nthread > 1:
            mujoco.mju_threadpool(data, nthread)
        mujoco.mj_step(model, data, nstep=600)
        return data

    nthread = min(8, os.cpu_count() or 1)
    serial = settle(nthread=1)
    parallel = settle(nthread=nthread)

    # mjData.threadpool is 0 until a pool is attached, and the pool only changes how the
    # work is scheduled, never the trajectory: the honest check is agreement across
    # islands, not a wall-clock number (on a model this small threads rarely pay off).
    drift = np.abs(parallel.qpos - serial.qpos).max()
    print(
        f"threadpool: {nthread} threads, pool attached={parallel.threadpool != 0} "
        f"(serial={serial.threadpool != 0}), {parallel.nisland} islands, "
        f"{parallel.ncon} contacts, {parallel.nefc} constraint rows, "
        f"max |qpos| drift vs serial {drift:.3e}"
    )


def log_config() -> None:
    """Retarget MuJoCo's own error/warning/info stream and switch on per-topic tracing."""
    # Unified logging API: every engine message now flows through one handler with a
    # structured mjLogMessage, superseding the mju_user_error / mju_user_warning hooks.
    # Python exposes the default handler's configuration and the message struct, but not
    # mju_setLogHandler, so a custom handler still has to be installed C-side.
    xml = """
    <mujoco model="sleepy">
      <option><flag sleep="enable"/></option>
      <worldbody>
        <geom type="plane" size="5 5 .1"/>
        <body pos="0 0 .2"><freejoint/><geom type="box" size=".1 .1 .1"/></body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    restore = mujoco.MjLogConfig.get()
    with tempfile.TemporaryDirectory() as workdir:
        config = mujoco.MjLogConfig.get()
        config.logto_console = False  # Keep engine chatter out of the program's own output.
        config.logto_file = True
        config.logfile = str(pathlib.Path(workdir) / "mujoco.log")  # Default: MUJOCO_LOG.TXT in cwd.
        # topics is a bitmask over mjtLogTopic, whose members are 1-based: bit = 1 << (topic - 1).
        config.topics = 1 << (int(mujoco.mjtLogTopic.mjTOPIC_SLEEP) - 1)
        config.set()
        try:
            mujoco.mj_step(model, data, nstep=1000)
        finally:
            restore.set()  # Log configuration is process-global; always put it back.
        traced = pathlib.Path(config.logfile).read_text().splitlines()

    asleep = int((data.tree_asleep >= 0).sum())
    print(f"log_config: {asleep}/{model.ntree} trees asleep, {len(traced)} traced lines:")
    for line in traced:
        print(f"log_config:   {line}")


def compile_warnings() -> None:
    """Inspect what the model compiler objected to, and fail a build on it if you want."""
    # Compiler warnings collected by mjs_numWarnings/mjs_getWarning reach Python as
    # warnings.warn from spec.compile(), instead of being lost to stderr.
    def unconstrained_cloth() -> mujoco.MjSpec:
        spec = mujoco.MjSpec()
        body = spec.worldbody.add_body(name="cloth")
        # No equality= and no passive stiffness: the flex has nothing holding it together.
        body.make_flex(
            name="cloth",
            type="grid",
            dim=2,
            count=[6, 6, 1],
            spacing=[0.05, 0.05, 0.05],
            mass=0.2,
        )
        return spec

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        model = unconstrained_cloth().compile()
    messages = [str(entry.message).splitlines()[0] for entry in caught]
    print(f"compile_warnings: compiled nflex={model.nflex}, warnings={messages}")

    # An asset pipeline can promote them to a hard failure with the ordinary filter.
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            unconstrained_cloth().compile()
        except UserWarning as error:
            print(f"compile_warnings: strict build rejected the model: {error.args[0].splitlines()[0]}")


def attach_conflict() -> None:
    """Decide what happens to clashing global options when a child spec is attached."""
    # compiler/conflict governs mjs_attach; before it, the parent silently won every
    # physics-option clash. "merge" takes the safer side per field (min timestep,
    # max iterations), "error" refuses to guess.
    def robot_cell(policy: mujoco.mjtConflict) -> mujoco.MjSpec:
        parent = mujoco.MjSpec()
        parent.compiler.conflict = policy
        parent.option.timestep = 0.005
        parent.option.iterations = 50
        parent.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_PLANE, size=[5, 5, 0.1])
        return parent

    def stiff_gripper() -> mujoco.MjsBody:
        child = mujoco.MjSpec()
        child.option.timestep = 0.001  # Needs the finer step.
        child.option.iterations = 200  # And the tighter solve.
        body = child.worldbody.add_body(name="gripper", pos=[0, 0, 0.5])
        body.add_geom(size=[0.05, 0, 0])
        return body

    for policy in (mujoco.mjtConflict.mjCONFLICT_WARNING, mujoco.mjtConflict.mjCONFLICT_MERGE):
        parent = robot_cell(policy)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            parent.worldbody.add_frame().attach_body(stiff_gripper(), prefix="gripper_")
            model = parent.compile()
        print(
            f"attach_conflict: {policy.name} -> timestep={model.opt.timestep}, "
            f"iterations={model.opt.iterations}, warnings={len(caught)}"
        )

    # "error" refuses the attach outright and leaves the parent spec untouched.
    parent = robot_cell(mujoco.mjtConflict.mjCONFLICT_ERROR)
    try:
        parent.worldbody.add_frame().attach_body(stiff_gripper(), prefix="gripper_")
    except ValueError as error:
        print(f"attach_conflict: mjCONFLICT_ERROR refused the attach ({error.args[0].splitlines()[0]})")
    print(f"attach_conflict: parent unchanged, timestep still {parent.option.timestep}")


def make_flex() -> None:
    """Build a deformable body procedurally, without emitting a <flexcomp> XML string."""
    # body.make_flex is the programmatic equivalent of MJCF <flexcomp>: it generates the
    # particle bodies, their joints and the equality constraints in one call.
    spec = mujoco.MjSpec()
    spec.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_PLANE, size=[2, 2, 0.1])
    spec.worldbody.add_geom(name="ball", type=mujoco.mjtGeom.mjGEOM_SPHERE, pos=[0, 0, 0.1], size=[0.1, 0, 0])
    body = spec.worldbody.add_body(name="towel", pos=[0, 0, 0.3])
    flex = body.make_flex(
        name="towel",
        type="grid",
        dim=2,  # 2D grid of triangles: a sheet.
        count=[9, 9, 1],
        spacing=[0.03, 0.03, 0.03],
        radius=0.004,  # Collision thickness of each element.
        mass=0.15,
        equality=1,  # Edge-length equality constraints hold the sheet together.
    )
    flex.young = 5e3
    flex.poisson = 0.2
    flex.thickness = 2e-3
    flex.damping = 1e-3
    flex.selfcollide = mujoco.mjtFlexSelf.mjFLEXSELF_NONE

    model = spec.compile()
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=600)
    pos_World_Vertices = data.flexvert_xpos  # Already (nflexvert, 3); no reshape needed.
    print(
        f"make_flex: nflexvert={model.nflexvert}, nflexelem={model.nflexelem}, "
        f"generated bodies={model.nbody - 1}, neq={model.neq}, "
        f"vertex height range [{pos_World_Vertices[:, 2].min():.3f}, "
        f"{pos_World_Vertices[:, 2].max():.3f}] m draped over the ball"
    )


def make_flex_from_obj() -> None:
    """Load a 1D flex (rope, cable, suture) straight from OBJ line segments."""
    # dim=1 reads the OBJ 'l' records as flex edges, so a polyline authored in any mesh
    # tool becomes a rope without a separate cable-plugin definition.
    nvert = 16
    vertices = "\n".join(f"v {0.04 * i:.4f} 0 0.6" for i in range(nvert))
    segments = "\n".join(f"l {i + 1} {i + 2}" for i in range(nvert - 1))
    rope_obj = f"{vertices}\n{segments}\n".encode()

    spec = mujoco.MjSpec()
    spec.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_PLANE, size=[2, 2, 0.1])
    # A bar for the rope to drape over, so the result shows bending rather than free fall.
    spec.worldbody.add_geom(
        name="bar",
        type=mujoco.mjtGeom.mjGEOM_CYLINDER,
        fromto=[0.3, -0.3, 0.3, 0.3, 0.3, 0.3],
        size=[0.02, 0, 0],
    )
    body = spec.worldbody.add_body(name="rope")
    with mujoco.MjVfs() as vfs:
        # MjVfs keeps the asset in memory; make_flex resolves `file` against it.
        vfs["rope.obj"] = rope_obj
        flex = body.make_flex(
            name="rope",
            type="mesh",
            dim=1,
            file="rope.obj",
            vfs=vfs,
            radius=0.008,
            mass=0.05,
            equality=1,
        )
        flex.damping = 1e-3
        model = spec.compile()

    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=1000)
    pos_World_Vertices = data.flexvert_xpos  # Already (nflexvert, 3); no reshape needed.
    span = np.linalg.norm(pos_World_Vertices[-1] - pos_World_Vertices[0])
    print(
        f"make_flex_from_obj: {model.nflexvert} vertices, {model.nflexelem} edges, "
        f"straight length {0.04 * (nvert - 1):.2f} m, end-to-end span {span:.4f} m "
        f"and height range [{pos_World_Vertices[:, 2].min():.3f}, "
        f"{pos_World_Vertices[:, 2].max():.3f}] m once draped over the bar"
    )


def dense_inertia() -> None:
    """Get the joint-space inertia matrix as a dense array for your own linear algebra."""
    # mj_fullM now takes (model, data, dst); it used to be mj_fullM(m, dst, d.qM), part of
    # retiring mjData.qM in favour of the CSR-format mjData.M.
    xml = """
    <mujoco model="arm">
      <worldbody>
        <body pos="0 0 1">
          <joint name="shoulder" type="hinge" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 .4 0 0" size=".04"/>
          <body pos=".4 0 0">
            <joint name="elbow" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 .3 0 0" size=".03"/>
            <body pos=".3 0 0">
              <joint name="wrist" type="hinge" axis="0 1 0"/>
              <geom type="box" size=".05 .03 .02"/>
            </body>
          </body>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[:] = [0.3, -0.9, 0.5]
    mujoco.mj_forward(model, data)

    inertia = np.zeros((model.nv, model.nv))
    mujoco.mj_fullM(model, data, inertia)

    # Equivalent one-liner straight off the CSR storage, when you already have mjData.M.
    inertia_csr = np.zeros((model.nv, model.nv))
    mujoco.mju_sym2dense(inertia_csr, data.M, model.M_rownnz, model.M_rowadr, model.M_colind)

    # Inverse dynamics for a commanded acceleration, done by hand against the dense matrix.
    qacc_desired = np.array([1.0, -2.0, 0.5])
    torque = inertia @ qacc_desired + data.qfrc_bias
    reference = np.zeros(model.nv)
    mujoco.mj_mulM(model, data, reference, qacc_desired)

    print(
        f"dense_inertia: M diag {np.diag(inertia).round(5)}, "
        f"csr form matches {np.allclose(inertia, inertia_csr)}, "
        f"M@qacc matches mj_mulM {np.allclose(inertia @ qacc_desired, reference)}, "
        f"inverse-dynamics torque {torque.round(4)}"
    )


def main() -> None:
    # Engine warnings below are genuine; keep them from appending to MUJOCO_LOG.TXT in cwd.
    config = mujoco.MjLogConfig.get()
    config.logto_file = False
    config.set()

    threadpool()
    log_config()
    compile_warnings()
    attach_conflict()
    make_flex()
    make_flex_from_obj()
    dense_inertia()


if __name__ == "__main__":
    main()
