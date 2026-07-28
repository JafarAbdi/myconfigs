# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.11.0 (July 27, 2026)."""

import pathlib
import tempfile

import mujoco
import numpy as np


def surfacevel_conveyor() -> None:
    """Move a geom's surface without moving the geom: conveyors, treadmills and turntables."""
    # This is the current way to build a conveyor. It replaces hand-rolled tricks -- a long
    # spinning cylinder, a recycled belt body, or a per-step qfrc_applied nudge -- with a
    # velocity field the contact solver sees directly, so the belt costs zero DoFs.
    xml = """
    <mujoco model="conveyor">
      <option timestep="0.002"/>
      <default>
        <geom friction="1 0.02 0.001"/>
      </default>
      <worldbody>
        <light pos="0 0 2"/>
        <!-- Linear field: 0.6 m/s along the belt's local +x, expressed in the geom frame. -->
        <geom name="belt" type="box" size="1 0.2 0.02" pos="0 0 0"
              surfacevel="0.6 0 0  0 0 0" rgba="0.2 0.2 0.25 1"/>
        <!-- Rotational field: 2 rad/s about the geom frame origin, so tangential speed grows
             with radius. condim=4 lets the same field also drive torsional friction. -->
        <geom name="turntable" type="cylinder" size="0.4 0.02" pos="0 1 0" condim="4"
              surfacevel="0 0 0  0 0 2" rgba="0.25 0.2 0.2 1"/>
        <body name="crate" pos="-0.6 0 0.07">
          <freejoint/>
          <geom type="box" size="0.05 0.05 0.05" mass="0.5"/>
        </body>
        <body name="puck_inner" pos="0.1 1 0.06">
          <freejoint/>
          <geom type="cylinder" size="0.03 0.02" mass="0.2" condim="4"/>
        </body>
        <body name="puck_outer" pos="0.25 1 0.06">
          <freejoint/>
          <geom type="cylinder" size="0.03 0.02" mass="0.2" condim="4"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    # The compiler sets this fast-path flag when any geom carries a nonzero surfacevel.
    print(f"surfacevel_conveyor: flg_surfacevel={model.flg_surfacevel}")

    mujoco.mj_step(model, data, nstep=1000)

    print(f"surfacevel_conveyor: crate carried to x={data.body('crate').xpos[0]:+.3f} m "
          f"at vx={data.qvel[0]:+.3f} m/s (belt runs at 0.600 m/s)")
    center_turntable = model.geom("turntable").pos
    # mjData.cvel is a com-based "c" quantity: its linear part is the velocity of a point at the
    # kinematic tree's com, not the body's own. mj_objectVelocity is the documented accessor; it
    # re-centers on the object and returns (rot:lin), so the linear part is [3:6].
    objectvel = np.zeros(6)
    for name in ("puck_inner", "puck_outer"):
        puck = data.body(name)
        radius = float(np.linalg.norm(puck.xpos[:2] - center_turntable[:2]))
        mujoco.mj_objectVelocity(model, data, mujoco.mjtObj.mjOBJ_BODY, puck.id, objectvel, 0)
        vel_World_Puck = objectvel[3:]
        speed = float(np.linalg.norm(vel_World_Puck[:2]))
        print(f"surfacevel_conveyor:   {name} at r={radius:.3f} m moves at {speed:.3f} m/s "
              f"(field predicts {2.0 * radius:.3f} m/s)")

    # surfacevel is a plain mjModel field, so the belt can be reversed at runtime with no
    # recompile -- useful for domain randomization and for scripted material handling.
    belt_id = model.geom("belt").id
    model.geom_surfacevel[belt_id, 0] = -0.6
    mujoco.mj_step(model, data, nstep=1000)
    print(f"surfacevel_conveyor: after reversing the belt, vx={data.qvel[0]:+.3f} m/s")


def adhesion_contacts() -> None:
    """Make contacts pull as well as push: tape, gecko feet, and -- combined with gap -- magnets."""
    # Unlike the adhesion *actuator* (a controlled vacuum-gripper force), geom/adhesion is a
    # material property of the contact itself: always on, and it widens the friction budget
    # to mu*(f_N + adhesion) so the surface resists sliding even under zero normal load.
    xml = """
    <mujoco model="magnet">
      <option timestep="0.002"/>
      <worldbody>
        <light pos="0 0 2"/>
        <geom name="floor" type="plane" size="2 2 0.05"/>
        <!-- An overhead magnet. gap=8mm lets adhesion act across a small separation, so the
             plate attracts before it touches; adhesion is per contact, and a box face on a
             plane makes four of them. -->
        <geom name="magnet" type="box" size="0.2 0.2 0.02" pos="0 0 0.5"
              adhesion="4" gap="0.008" rgba="0.6 0.2 0.2 1"/>
        <body name="keeper" pos="0 0 0.465">
          <freejoint/>
          <geom name="plate" type="box" size="0.06 0.06 0.01" mass="0.4"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    weight = float(model.body("keeper").mass[0] * -model.opt.gravity[2])

    mujoco.mj_step(model, data, nstep=1000)

    height = float(data.body("keeper").xpos[2])
    force_contact = np.zeros(6)
    mujoco.mj_contactForce(model, data, 0, force_contact)
    print(f"adhesion_contacts: plate held at z={height:.4f} m against its own "
          f"{weight:.2f} N weight ({data.ncon} contacts, adhesion="
          f"{data.contact[0].adhesion:.1f} N each)")
    # mj_contactForce reports the net interface force; its normal component is negative under
    # tension, which could not happen before adhesion existed.
    print(f"adhesion_contacts: mj_contactForce normal={force_contact[0]:+.3f} N "
          f"(negative = pulling), separation={data.contact[0].dist * 1e3:+.2f} mm")

    # An explicit contact pair overrides both geoms' adhesion, which is how you make one
    # material combination stickier (or weaker) than the geom defaults imply. Note that a pair
    # replaces the *whole* contact parameter set (friction, condim, solref, gap), not just
    # adhesion. Four contacts share the load, so pull-off is 4 x adhesion.
    xml_weak = xml.replace("</worldbody>", """</worldbody>
      <contact>
        <pair geom1="magnet" geom2="plate" adhesion="0.5" gap="0.008"/>
      </contact>""")
    model_weak = mujoco.MjModel.from_xml_string(xml_weak)
    data_weak = mujoco.MjData(model_weak)
    for _ in range(1000):
        mujoco.mj_step(model_weak, data_weak)
    print(f"adhesion_contacts: pair adhesion=0.5 N (4 x 0.5 N < {weight:.2f} N) overrides the "
          f"geoms, so the plate drops to z={data_weak.body('keeper').xpos[2]:.3f} m")


def implicitfast_gyroscopic() -> None:
    """Pick an integrator for free-flying bodies now that implicitfast handles gyroscopic terms."""
    # 3.11 applies the bias-force derivative of every standalone free body inside implicitfast,
    # which replaces the old midpoint-integration special case (that one needed vacuum and no
    # constraints; this works with contacts, fluid and constraints, and with mj_inverse).
    xml = """
    <mujoco model="tumbler">
      <option gravity="0 0 0" integrator="{integrator}" timestep="0.005">
        <flag energy="enable"/>
      </option>
      <worldbody>
        <body name="tbar">
          <freejoint/>
          <geom type="box" size="0.05 0.1 0.2" mass="1"/>
        </body>
      </worldbody>
    </mujoco>
    """
    # Intermediate-axis spin: the classic test where explicit integrators blow up. A free joint's
    # translational dofs are global but its rotational dofs are the identity rotation in the child
    # frame, so qvel[3:6] is the body-frame angular velocity, not the world-frame one.
    angvel_World_Tbar_Tbar = np.array([0.05, 8.0, 0.05])

    for integrator in ("Euler", "implicitfast", "implicit", "RK4"):
        model = mujoco.MjModel.from_xml_string(xml.format(integrator=integrator))
        data = mujoco.MjData(model)
        data.qvel[3:] = angvel_World_Tbar_Tbar
        mujoco.mj_forward(model, data)
        energy_kinetic_initial = float(data.energy[1])
        mujoco.mj_step(model, data, nstep=4000)
        drift = float(data.energy[1]) / energy_kinetic_initial - 1.0
        print(f"implicitfast_gyroscopic: {integrator:12s} kinetic energy drift {drift:+7.2%} "
              f"over 20 s")
    print("implicitfast_gyroscopic: implicitfast now matches implicit exactly for standalone "
          "free bodies; use RK4 when long-horizon energy conservation matters")


def body_simple_off() -> None:
    """Opt a body out of the simple-body mass matrix optimization to randomize its inertia."""
    xml = """
    <mujoco model="payload">
      <worldbody>
        <body name="payload" pos="0 0 1"{simple}>
          <freejoint/>
          <geom type="box" size="0.1 0.1 0.1" mass="1"/>
        </body>
      </worldbody>
    </mujoco>
    """
    quat_Payload_Inertial = np.zeros(4)
    axis = np.array([1.0, 1.0, 0.0]) / np.sqrt(2.0)
    mujoco.mju_axisAngle2Quat(quat_Payload_Inertial, axis, 0.6)
    inertia_diagonal = np.array([0.02, 0.005, 0.01])

    def randomize(simple: str) -> np.ndarray | None:
        label = simple.strip() or 'simple="auto"'
        model = mujoco.MjModel.from_xml_string(xml.format(simple=simple))
        data = mujoco.MjData(model)
        body_id = model.body("payload").id
        model.body_iquat[body_id] = quat_Payload_Inertial
        model.body_inertia[body_id] = inertia_diagonal
        try:
            # mj_setConst is what propagates a runtime inertia edit; it is also what now
            # notices that the simple-body assumption has been invalidated.
            mujoco.mj_setConst(model, data)
        except mujoco.FatalError as error:
            print(f"body_simple_off: {label} -> {error}")
            return None
        mujoco.mj_forward(model, data)
        mass_matrix = np.zeros((model.nv, model.nv))
        mujoco.mj_fullM(model, data, mass_matrix)
        print(f"body_simple_off: {label} -> body_simple={model.body_simple}, "
              f"nC={model.nC} (a full 6x6 block instead of a diagonal one)")
        return mass_matrix[3:, 3:]

    randomize("")
    rotational_block = randomize(' simple="false"')
    assert rotational_block is not None
    print("body_simple_off: randomized rotational block\n"
          f"{np.array2string(rotational_block, precision=6, suppress_small=True)}")


def setconst_sameframe() -> None:
    """Make a runtime site-pose edit actually take effect by recomputing site_sameframe."""
    xml = """
    <mujoco model="tool">
      <worldbody>
        <body name="tool" pos="0 0 0.5">
          <joint name="pitch" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.02" mass="0.5"/>
          <site name="tcp"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    site_id = model.site("tcp").id

    # The site was compiled at the body origin, so site_sameframe says "reuse the body frame"
    # and the kinematics never read site_pos. Editing site_pos alone is silently ignored.
    print(f"setconst_sameframe: site_sameframe={model.site_sameframe[site_id]} at compile time")
    model.site_pos[site_id] = [0.3, 0.0, 0.0]
    mujoco.mj_forward(model, data)
    print(f"setconst_sameframe: without mj_setConst, pos_World_Tcp={data.site_xpos[site_id]}")

    # 3.11 makes mj_setConst recompute body/geom/site_sameframe, so the fast-path flag now
    # follows the edited frames. This is the fix for runtime frame edits short of a recompile.
    mujoco.mj_setConst(model, data)
    mujoco.mj_forward(model, data)
    print(f"setconst_sameframe: site_sameframe={model.site_sameframe[site_id]} after "
          f"mj_setConst, pos_World_Tcp={data.site_xpos[site_id]}")


def gravcomp_fast_path_flags() -> None:
    """Toggle the gravcomp and surfacevel fast paths directly, instead of through ngravcomp."""
    xml = """
    <mujoco model="drone">
      <worldbody>
        <body name="drone" pos="0 0 1" gravcomp="1">
          <freejoint/>
          <geom type="sphere" size="0.1" mass="1"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    body_id = model.body("drone").id
    mujoco.mj_forward(model, data)
    print(f"gravcomp_fast_path_flags: as compiled, flg_gravcomp={model.flg_gravcomp}, "
          f"qacc_z={data.qacc[2]:+.3f} m/s^2")

    # flg_gravcomp and flg_surfacevel are real writeable booleans, so the fast path is now a
    # one-line switch: A/B a controller with and without gravity compensation, on one model,
    # without touching body_gravcomp or re-deriving anything with mj_setConst.
    model.flg_gravcomp = False
    mujoco.mj_forward(model, data)
    print(f"gravcomp_fast_path_flags: flg_gravcomp=False -> qacc_z={data.qacc[2]:+.3f} m/s^2 "
          f"(body_gravcomp is still {model.body_gravcomp[body_id]:.1f})")

    # Editing body_gravcomp instead is a *value* change, and like other value edits it needs
    # mj_setConst -- which is also what re-derives the flag (and the deprecated ngravcomp
    # count, which flg_gravcomp replaces and which will be removed in a future release).
    model.body_gravcomp[body_id] = 0.9
    mujoco.mj_setConst(model, data)
    mujoco.mj_forward(model, data)
    print(f"gravcomp_fast_path_flags: body_gravcomp=0.9 + mj_setConst -> flg_gravcomp="
          f"{model.flg_gravcomp}, ngravcomp={model.ngravcomp}, "
          f"qacc_z={data.qacc[2]:+.3f} m/s^2")


def mass_matrix_csr() -> None:
    """Read and use the joint-space inertia matrix now that only the CSR mjData.M remains."""
    xml = """
    <mujoco model="arm">
      <worldbody>
        <body pos="0 0 1">
          <joint name="shoulder" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="1"/>
          <body pos="0.3 0 0">
            <joint name="elbow" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="0.5"/>
            <site name="tcp" pos="0.3 0 0"/>
          </body>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[:] = [0.4, -0.7]
    mujoco.mj_forward(model, data)

    # The legacy ancestor-walk mjData.qM (nM entries) is gone: mjData.M, CSR over the lower
    # triangle and addressed by model.M_rownnz / M_rowadr / M_colind (nC entries), is now the
    # only joint-space inertia matrix. Code that indexed qM via model.dof_Madr must be ported.
    mass_matrix = np.zeros((model.nv, model.nv))
    mujoco.mj_fullM(model, data, mass_matrix)
    print(f"mass_matrix_csr: nv={model.nv}, nC={model.nC} stored entries, "
          f"has qM={hasattr(data, 'qM')}")
    for row in range(model.nv):
        start = model.M_rowadr[row]
        count = model.M_rownnz[row]
        columns = model.M_colind[start:start + count].tolist()
        print(f"mass_matrix_csr:   row {row} -> cols {columns} = "
              f"{np.array2string(data.M[start:start + count], precision=6)}")

    # Prefer the kernels over the dense matrix: mj_mulM and mj_solveM work on the CSR
    # factorization mj_forward already computed, and stay sparse for large models.
    velocity = np.array([1.0, -2.0])
    momentum = np.zeros(model.nv)
    mujoco.mj_mulM(model, data, momentum, velocity)

    # Operational-space inertia of the tool point: Lambda = (J M^-1 J^T)^-1.
    jacp_World_Tcp = np.zeros((3, model.nv))
    jacr_World_Tcp = np.zeros((3, model.nv))
    mujoco.mj_jacSite(model, data, jacp_World_Tcp, jacr_World_Tcp, model.site("tcp").id)
    minv_jacp_transpose = np.zeros_like(jacp_World_Tcp)
    mujoco.mj_solveM(model, data, minv_jacp_transpose, jacp_World_Tcp)
    inertia_task = np.linalg.pinv(jacp_World_Tcp @ minv_jacp_transpose.T)
    print(f"mass_matrix_csr: mj_mulM matches dense M @ v: "
          f"{np.allclose(momentum, mass_matrix @ velocity)}")
    print(f"mass_matrix_csr: apparent tool-point mass along x = {inertia_task[0, 0]:.4f} kg")


def inverse_fd_mass_jacobian() -> None:
    """Finite-difference the mass matrix alongside the inverse-dynamics Jacobians, in CSR."""
    xml = """
    <mujoco model="arm">
      <worldbody>
        <body pos="0 0 1">
          <joint name="shoulder" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="1"/>
          <body pos="0.3 0 0">
            <joint name="elbow" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.03" mass="0.5"/>
          </body>
        </body>
        <!-- A free-flying payload makes nM and nC differ: the simple-body optimization drops
             its zero off-diagonals from the CSR layout but not from the legacy one. -->
        <body name="payload" pos="1 0 1">
          <freejoint/>
          <geom type="sphere" size="0.05" mass="0.2"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.qpos[:2] = [0.3, -0.5]
    data.qvel[:2] = [0.2, 0.1]
    data.qacc[:2] = [1.0, -0.5]
    mujoco.mj_forward(model, data)

    # DmDq is now (nv x nC) -- one CSR-packed mass matrix per configuration DoF -- because
    # mjd_inverseFD switched off the removed nM-sized qM layout. Pass None for the outputs
    # you do not need; each one costs another sweep of finite differences.
    dfda = np.zeros((model.nv, model.nv))
    dmdq = np.zeros((model.nv, model.nC))
    mujoco.mjd_inverseFD(model, data, 1e-7, True, None, None, dfda, None, None, None, dmdq)

    print(f"inverse_fd_mass_jacobian: DmDq shape {dmdq.shape} = (nv, nC); it was "
          f"(nv, nM) = ({model.nv}, {model.nM}) before 3.11")
    # DfDa is the mass matrix itself, which is the cheapest way to sanity-check the sweep.
    mass_matrix = np.zeros((model.nv, model.nv))
    mujoco.mj_fullM(model, data, mass_matrix)
    print(f"inverse_fd_mass_jacobian: DfDa recovers M to "
          f"{np.abs(dfda - mass_matrix).max():.2e}")
    sensitivity = np.abs(dmdq).max(axis=1)
    print(f"inverse_fd_mass_jacobian: max |dM/dq| per DoF = "
          f"{np.array2string(sensitivity, precision=5, suppress_small=True)}")
    print(f"inverse_fd_mass_jacobian: only the elbow moves the inertia matrix "
          f"(shoulder rotates the whole arm rigidly, the free payload has no q-dependence)")


def orientation_servo() -> None:
    """Servo a ball joint or refsite to a full target orientation with one geodesic PD actuator."""
    # This replaces stacking three per-axis position servos on a ball joint, which has no exact
    # equilibrium away from the identity and slips by full turns past half a rotation. The
    # orientation actuator acts jointly on the relative orientation: kp*log(q^-1 q_target) - kv*w.
    xml = """
    <mujoco model="wrist">
      <option integrator="implicitfast" timestep="0.002"/>
      <worldbody>
        <light pos="0 0 2"/>
        <body name="wrist" pos="0 0 0.5">
          <joint name="wrist" type="ball" damping="0.01"/>
          <geom type="box" size="0.2 0.05 0.02" mass="1"/>
        </body>
      </worldbody>
      <actuator>
        <!-- input="quat" takes a 4-control block (w-first, normalized by the servo);
             the default input="expmap" takes a 3-control rotation vector instead.
             forcerange clamps the torque *norm*, so its lower bound must be 0. -->
        <orientation name="wrist_servo" joint="wrist" kp="50" dampratio="1"
                     input="quat" forcerange="0 20"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    # A target more than half a turn away: per-axis servos wind the short way, this one does not.
    quat_World_Target = np.zeros(4)
    mujoco.mju_axisAngle2Quat(quat_World_Target, np.array([0.0, 0.0, 1.0]), 2.5)
    data.ctrl[:] = quat_World_Target
    mujoco.mj_step(model, data, nstep=2000)

    # mju_subQuat is the geodesic difference log(q_cur^-1 q_tgt) that the actuator itself applies,
    # already reduced to the shortest arc. Composing negQuat/mulQuat and taking an arccos
    # re-derives it by hand, and the arccos loses the error's axis.
    rotvec_Wrist_Target = np.zeros(3)
    mujoco.mju_subQuat(rotvec_Wrist_Target, quat_World_Target, data.qpos)
    angle_error = float(np.linalg.norm(rotvec_Wrist_Target))
    print(f"orientation_servo: one actuator, {model.nu} controls -> {model.nout} force outputs "
          f"(nactuator={model.nactuator})")
    print(f"orientation_servo: quat_World_Wrist="
          f"{np.array2string(data.qpos, precision=4, suppress_small=True)} vs target "
          f"{np.array2string(quat_World_Target, precision=4)}")
    print(f"orientation_servo: geodesic error {np.degrees(angle_error):.4f} deg, "
          f"holding torque {np.linalg.norm(data.actuator_force):.3e} N*m "
          f"(exact equilibrium, no steady-state offset)")


def actuator_control_blocks() -> None:
    """Slice mjData.ctrl and mjData.actuator_force per actuator now that the two can differ."""
    xml = """
    <mujoco model="mixed">
      <option integrator="implicitfast"/>
      <worldbody>
        <body name="cart" pos="0 0 0.2">
          <joint name="slide" type="slide" axis="1 0 0"/>
          <geom type="box" size="0.1 0.1 0.05" mass="1"/>
          <body name="head" pos="0 0 0.1">
            <joint name="neck" type="ball" damping="0.02"/>
            <geom type="sphere" size="0.06" pos="0.12 0 0" mass="0.3"/>
          </body>
        </body>
      </worldbody>
      <actuator>
        <motor name="drive" joint="slide" gear="10"/>
        <orientation name="neck_servo" joint="neck" kp="5" kv="0.5" input="quat"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    # nactuator counts actuators; nu counts controls; nout counts force outputs. They coincide
    # for classic SISO actuators, so pre-3.11 code that assumed nu == number of actuators keeps
    # working -- but indexing ctrl by actuator id does not once a MIMO actuator is present.
    print(f"actuator_control_blocks: nactuator={model.nactuator}, nu={model.nu}, "
          f"nout={model.nout}")
    for actuator_id in range(model.nactuator):
        name = model.actuator(actuator_id).name
        ctrl_start = int(model.actuator_ctrladr[actuator_id])
        ctrl_count = int(model.actuator_ctrlnum[actuator_id])
        out_start = int(model.actuator_outadr[actuator_id])
        out_count = int(model.actuator_outnum[actuator_id])
        # mj_actuatorInputName labels each control of the block, or returns None for actuator
        # types that define no input names. This is how the viewers now label their sliders.
        labels = [mujoco.mj_actuatorInputName(model, actuator_id, i) or "-"
                  for i in range(ctrl_count)]
        print(f"actuator_control_blocks:   {name:11s} "
              f"ctrlspec={model.actuator_ctrlspec[actuator_id]} "
              f"ctrl[{ctrl_start}:{ctrl_start + ctrl_count}]={labels} -> "
              f"actuator_force[{out_start}:{out_start + out_count}]")

    # Every write to ctrl goes through actuator_ctrladr/ctrlnum, including the single-control
    # motor: an actuator id is not a ctrl index, it only happens to be one for actuator 0.
    def ctrl_block(name: str) -> slice:
        actuator_id = model.actuator(name).id
        start = int(model.actuator_ctrladr[actuator_id])
        return slice(start, start + int(model.actuator_ctrlnum[actuator_id]))

    data.ctrl[ctrl_block("neck_servo")] = [np.cos(0.3), 0.0, np.sin(0.3), 0.0]
    data.ctrl[ctrl_block("drive")] = 0.5
    mujoco.mj_step(model, data, nstep=500)
    forces = np.array2string(data.actuator_force, precision=4)
    print(f"actuator_control_blocks: actuator_force={forces} (1 from the motor, 3 from the servo)")


def reset_ctrl() -> None:
    """Clear controls to neutral mid-episode without resetting the simulation state."""
    xml = """
    <mujoco model="wrist">
      <option integrator="implicitfast" timestep="0.002"/>
      <worldbody>
        <body name="wrist" pos="0 0 0.5">
          <joint name="wrist" type="ball" damping="0.05"/>
          <geom type="box" size="0.2 0.05 0.02" mass="1"/>
        </body>
      </worldbody>
      <actuator>
        <motor name="spin" joint="wrist" gear="0 0 1"/>
        <orientation name="wrist_servo" joint="wrist" kp="20" dampratio="1" input="quat"/>
      </actuator>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    data.ctrl[:] = [0.7, 0.1, 0.2, 0.3, 0.4]
    mujoco.mj_step(model, data, nstep=200)

    # Zeroing data.ctrl by hand is wrong once quaternion inputs exist: (0,0,0,0) is not a
    # rotation. mj_resetCtrl writes the neutral value of each input -- zero, or the identity
    # quaternion -- and is what mj_resetData and the viewers' "Clear All" now call.
    qpos_before = data.qpos.copy()
    mujoco.mj_resetCtrl(model, data)
    print(f"reset_ctrl: ctrl={np.array2string(data.ctrl, precision=3)} "
          f"(motor -> 0, servo quat -> identity)")
    print(f"reset_ctrl: state untouched, qpos unchanged: "
          f"{np.array_equal(qpos_before, data.qpos)}")


def intvelocity_unclamped() -> None:
    """Let an intvelocity servo integrate past half a turn on a rotational transmission."""
    xml = """
    <mujoco model="turret">
      <option integrator="implicitfast" timestep="0.002"/>
      <worldbody>
        <body name="turret" pos="0 0 0.5">
          <joint name="yaw" axis="0 0 1" damping="0.05"/>
          <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02" mass="0.2"/>
        </body>
      </worldbody>
      <actuator>
        <!-- actlimited used to be hardcoded "true" here. It now defaults to "auto" like
             general actuators, so omitting actrange leaves the integrated setpoint unclamped
             -- which is what you want on a joint that wraps. -->
        <intvelocity name="yaw_rate" joint="yaw" kp="20" kv="2" ctrlrange="-2 2"{actrange}/>
      </actuator>
    </mujoco>
    """
    for actrange in ('', ' actrange="-3.1416 3.1416"'):
        model = mujoco.MjModel.from_xml_string(xml.format(actrange=actrange))
        data = mujoco.MjData(model)
        data.ctrl[0] = 2.0  # rad/s
        mujoco.mj_step(model, data, nstep=3000)
        label = "actrange set" if actrange else "actrange omitted"
        print(f"intvelocity_unclamped: {label:16s} actlimited={bool(model.actuator_actlimited[0])} "
              f"-> setpoint {data.act[0]:+.3f} rad, yaw {data.qpos[0]:+.3f} rad "
              f"({data.qpos[0] / (2 * np.pi):+.2f} turns)")
    print("intvelocity_unclamped: position/intvelocity setpoints on ball joints and rotational "
          "refsite transmissions are now read on the circle, so targets past pi keep tracking")


def warmstart_zero_iterations() -> None:
    """Skip the constraint solve entirely on scenes that have settled."""
    xml = """
    <mujoco model="pile">
      <option solver="Newton" timestep="0.002"/>
      <worldbody>
        <light pos="0 0 3"/>
        <geom type="plane" size="5 5 0.05"/>
        <body pos="0 0 0.05"><freejoint/><geom type="box" size="0.05 0.05 0.05" mass="1"/></body>
        <body pos="0.02 0 0.16"><freejoint/><geom type="box" size="0.05 0.05 0.05" mass="1"/></body>
        <body pos="0 0.02 0.27"><freejoint/><geom type="box" size="0.05 0.05 0.05" mass="1"/></body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    # CG and Newton now check a duality-gap certificate against the warmstart before doing any
    # work; if it already meets tolerance they exit with zero iterations, skipping Hessian
    # construction, factorization and line search. Watch solver_niter go to zero as the pile
    # settles -- this is free speed on quiescent scenes, no model change required.
    iterations = []
    for _ in range(2000):
        mujoco.mj_step(model, data)
        iterations.append(int(data.solver_niter[0]))

    settling = iterations[:200]
    settled = iterations[-200:]
    print(f"warmstart_zero_iterations: while settling, mean solver_niter="
          f"{np.mean(settling):.2f} (max {max(settling)})")
    print(f"warmstart_zero_iterations: once quiescent, mean solver_niter="
          f"{np.mean(settled):.2f}, zero-iteration steps "
          f"{100 * settled.count(0) / len(settled):.0f}% of the time")


def self_attach() -> None:
    """Repeat a subtree inside one model with <attach>, no second file and no MjSpec code."""
    # <attach> without a model attribute now attaches from the current model, and the new
    # frame attribute attaches a frame instead of a body. Together they replace copy-pasted
    # MJCF or a procedural spec.attach() round-trip for building modular/repeated structures.
    xml = """
    <mujoco model="tower">
      <worldbody>
        <light pos="0 0 3"/>
        <frame name="segment" pos="0 0 0.3">
          <body name="link">
            <joint name="hinge" axis="0 1 0" damping="0.1"/>
            <geom type="capsule" fromto="0 0 0 0 0 0.3" size="0.02" mass="0.1"/>
            <site name="top" pos="0 0 0.3"/>
          </body>
        </frame>
        <body name="stage2" pos="0 0 0.3">
          <!-- prefix is required: it keeps the copied names unique. -->
          <attach frame="segment" prefix="s2_"/>
        </body>
        <body name="stage3" pos="0 0 0.6">
          <attach frame="segment" prefix="s3_"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    print(f"self_attach: bodies={[model.body(i).name for i in range(model.nbody)]}")
    print(f"self_attach: joints={[model.joint(i).name for i in range(model.njnt)]}")
    for site_id in range(model.nsite):
        print(f"self_attach:   site {model.site(site_id).name:8s} "
              f"pos_World_Site={np.array2string(data.site_xpos[site_id], precision=3)}")


def encode_model() -> None:
    """Serialize a spec or compiled model to any of MuJoCo's file formats through one call."""
    xml = """
    <mujoco model="arm">
      <asset>
        <texture name="grid" type="2d" builtin="checker" width="64" height="64"
                 rgb1="0.1 0.2 0.3" rgb2="0.2 0.3 0.4"/>
        <material name="grid" texture="grid" texrepeat="4 4"/>
      </asset>
      <worldbody>
        <geom type="plane" size="2 2 0.05" material="grid"/>
        <body name="link" pos="0 0 0.5">
          <joint name="pitch" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.02" mass="0.5"/>
        </body>
      </worldbody>
    </mujoco>
    """
    spec = mujoco.MjSpec.from_string(xml)
    model = spec.compile()

    # spec.encode picks the format from the extension. 3.11 added .mjb and .txt, so this is
    # now the single entry point that used to be mj_saveXML / mj_saveModel / mj_printModel:
    #   .xml -- flattened MJCF (pass model to copy runtime edits back into the spec first)
    #   .mjz -- spec plus every referenced asset, in one zip archive
    #   .mjb -- compiled binary, fastest to load, version-specific (needs model)
    #   .txt -- human-readable dump, good for diffing two models (needs model)
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        for suffix, needs_model in ((".xml", False), (".mjz", False),
                                    (".mjb", True), (".txt", True)):
            path = root / f"arm{suffix}"
            nbytes = spec.encode(str(path), model if needs_model else None)
            print(f"encode_model: {path.name:8s} {nbytes:6d} bytes")
        reloaded = mujoco.MjModel.from_binary_path(str(root / "arm.mjb"))
        print(f"encode_model: reloaded arm.mjb -> nq={reloaded.nq}, nbody={reloaded.nbody}, "
              f"identical to source: {reloaded.nq == model.nq and reloaded.nbody == model.nbody}")


def main() -> None:
    surfacevel_conveyor()
    adhesion_contacts()
    implicitfast_gyroscopic()
    body_simple_off()
    setconst_sameframe()
    gravcomp_fast_path_flags()
    mass_matrix_csr()
    inverse_fd_mass_jacobian()
    orientation_servo()
    actuator_control_blocks()
    reset_ctrl()
    intvelocity_unclamped()
    warmstart_zero_iterations()
    self_attach()
    encode_model()


if __name__ == "__main__":
    main()
