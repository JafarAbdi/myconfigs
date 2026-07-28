# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.9.0 (May 27, 2026)."""

import mujoco
import numpy as np

# A long, thin, heavy plank on a hinge, held far from qpos0: highly anisotropic inertia
# reached through a kinematic chain, exactly where the compile-time diagonal approximation
# of the constraint-space inertia is worst.
PLANK_XML = """
<mujoco model="plank">
  <option timestep="0.002" solver="Newton" cone="elliptic"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 .1"/>
    <body name="mast" pos="0 0 0.9">
      <joint name="yaw" type="hinge" axis="0 0 1"/>
      <geom type="capsule" fromto="0 0 0 0 0 -.4" size=".03" mass="1"/>
      <body name="plank" pos="0 0 -.4">
        <joint name="pitch" type="hinge" axis="0 1 0"/>
        <geom type="box" size=".6 .02 .02" mass="8"/>
      </body>
    </body>
  </worldbody>
</mujoco>
"""


def exact_constraint_diagonal() -> None:
    """Fix soft or diverging constraints on models with anisotropic inertia or long chains."""
    # mjENBL_DIAGEXACT replaces the qpos0-frozen, isotropy-assuming approximation of
    # diag(A) with the exact A_ii = ||Y_i||^2 at the current configuration, where the
    # whitened Jacobian Y = J M^(-1/2) now lives in mjData.efc_Y.
    model = mujoco.MjModel.from_xml_string(PLANK_XML)

    # Settle the plank onto the floor first, so both variants are compared at one state.
    data = mujoco.MjData(model)
    data.qpos[:] = [1.1, 1.4]  # Swung down and around, far from qpos0.
    mujoco.mj_step(model, data, nstep=400)
    qpos, qvel = data.qpos.copy(), data.qvel.copy()

    def evaluate(*, diagexact: bool) -> mujoco.MjData:
        model.opt.enableflags &= ~int(mujoco.mjtEnableBit.mjENBL_DIAGEXACT)
        if diagexact:
            model.opt.enableflags |= int(mujoco.mjtEnableBit.mjENBL_DIAGEXACT)
        evaluated = mujoco.MjData(model)
        evaluated.qpos[:] = qpos
        evaluated.qvel[:] = qvel
        mujoco.mj_forward(model, evaluated)
        return evaluated

    approximate = evaluate(diagexact=False)
    exact = evaluate(diagexact=True)
    assert exact.nefc > 0, "expected the plank to be in contact"

    # Constraint softness efc_R is (1-imp)/imp * efc_diagA (renamed from efc_diagApprox in
    # 3.10.0, since it is no longer necessarily approximate). Here the approximation
    # collapses to ~0 and clamps R at mjMINVAL: infinitely hard contacts, the divergence
    # case the "Exact diagonal" docs warn about.
    print(
        f"exact_constraint_diagonal: {exact.nefc} rows, "
        f"approximate diag(A) {approximate.efc_diagA[: exact.nefc].max():.3e} -> "
        f"efc_R {approximate.efc_R[: exact.nefc].max():.3e}; "
        f"exact diag(A) {exact.efc_diagA[: exact.nefc].max():.3e} -> "
        f"efc_R {exact.efc_R[: exact.nefc].max():.3e}"
    )

    # efc_Y is only allocated under diagexact or a dual solver (PGS, NoSlip). mj_isSparse is
    # what decides the layout of efc_J and efc_Y; a sparse Y is instead indexed through
    # efc_Y_{rownnz,rowadr,colind} and cannot simply be reshaped.
    assert not mujoco.mj_isSparse(model), "expected the dense constraint Jacobian layout"
    whitened_jacobian = exact.efc_Y.reshape(exact.nefc, model.nv)
    inertia = np.zeros((model.nv, model.nv))
    mujoco.mj_fullM(model, exact, inertia)
    jacobian = exact.efc_J.reshape(exact.nefc, model.nv)
    delassus = jacobian @ np.linalg.solve(inertia, jacobian.T)
    print(
        f"exact_constraint_diagonal: Y Y^T reproduces the Delassus matrix J M^-1 J^T: "
        f"{np.allclose(whitened_jacobian @ whitened_jacobian.T, delassus)}"
    )


def compiler_timings() -> None:
    """Find out which asset is making model compilation slow."""
    # mjSpec.timer, indexed by mjtCTimer, is filled in by mj_compile; before it the only
    # way to attribute compile cost was to time whole compiles of trimmed-down models.
    radius = 0.2
    latitudes = np.linspace(-np.pi / 2, np.pi / 2, 24)
    longitudes = np.linspace(0, 2 * np.pi, 48, endpoint=False)
    blob_obj = "".join(
        f"v {radius * np.cos(lat) * np.cos(lon):.5f} "
        f"{radius * np.cos(lat) * np.sin(lon):.5f} "
        f"{radius * np.sin(lat):.5f}\n"
        for lat in latitudes
        for lon in longitudes
    ).encode()

    spec = mujoco.MjSpec()
    texture = spec.add_texture(
        name="grid",
        type=mujoco.mjtTexture.mjTEXTURE_2D,
        builtin=mujoco.mjtBuiltin.mjBUILTIN_CHECKER,
        width=1024,
        height=1024,
    )
    spec.add_material(name="grid").textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = texture.name
    spec.worldbody.add_geom(type=mujoco.mjtGeom.mjGEOM_PLANE, size=[5, 5, 0.1], material="grid")
    with mujoco.MjVfs() as vfs:
        vfs["blob.obj"] = blob_obj
        spec.add_mesh(name="blob", file="blob.obj")
        body = spec.worldbody.add_body(name="blob", pos=[0, 0, 1])
        body.add_freejoint()
        body.add_geom(type=mujoco.mjtGeom.mjGEOM_MESH, meshname="blob")
        model = spec.compile(vfs)

    timings_ms = {
        name.removeprefix("mjCTIMER_").lower(): 1e3 * spec.timer[timer]
        for name, timer in mujoco.mjtCTimer.__members__.items()
        if timer != mujoco.mjtCTimer.mjNCTIMER and spec.timer[timer] > 0
    }
    breakdown = ", ".join(f"{name} {value:.2f}" for name, value in sorted(timings_ms.items()))
    print(f"compiler_timings: nmesh={model.nmesh}, ntex={model.ntex}, ms by category: {breakdown}")


def margin_and_gap() -> None:
    """Detect near-contacts before they generate force, for adhesion or custom controllers."""
    # 3.9.0 semantics: margin inflates the geom surface (forces below it) and gap is an
    # extra detection buffer on top (detection below margin + gap). To port a pre-3.9.0
    # model, keep gap and set margin_new = margin_old - gap_old.
    margin, gap = 0.01, 0.04
    xml = f"""
    <mujoco model="proximity">
      <worldbody>
        <geom name="floor" type="plane" size="2 2 .1"/>
        <body name="probe" pos="0 0 .3">
          <freejoint/>
          <geom name="probe" type="sphere" size=".1" margin="{margin}" gap="{gap}"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    for height in (0.16, 0.13, 0.105):
        data.qpos[:] = [0, 0, height, 1, 0, 0, 0]
        mujoco.mj_forward(model, data)
        match (data.ncon, data.nefc):
            case (0, _):
                regime = "not detected"
            case (_, 0):
                regime = f"detected at dist={data.contact.dist[0]:.3f}, no constraint row"
            case _:
                regime = f"detected at dist={data.contact.dist[0]:.3f}, force generated"
        print(
            f"margin_and_gap: surface separation {height - 0.1:.3f} m "
            f"(margin {margin} + gap {gap}) -> ncon={data.ncon}, nefc={data.nefc}, {regime}"
        )

    # Inactive contacts are still in mjData.contact, so a controller can read them.
    data.qpos[:] = [0, 0, 0.13, 1, 0, 0, 0]
    mujoco.mj_forward(model, data)
    contact = data.contact[0]
    # mj_contactForce is how a contact's force is meant to be read: 6D force:torque in the
    # contact frame, whose X axis is the normal. Reading qfrc_constraint instead would give
    # a generalized joint-space force, in a different frame and summed over every contact.
    wrench_Contact_Probe = np.zeros(6)
    mujoco.mj_contactForce(model, data, 0, wrench_Contact_Probe)
    print(
        f"margin_and_gap: inactive contact between "
        f"{model.geom(contact.geom[0]).name!r} and {model.geom(contact.geom[1]).name!r}, "
        f"efc_address={contact.efc_address} (-1 means no constraint row), "
        f"normal force={wrench_Contact_Probe[0]:.3f} N"
    )


def main() -> None:
    exact_constraint_diagonal()
    compiler_timings()
    margin_and_gap()


if __name__ == "__main__":
    main()
