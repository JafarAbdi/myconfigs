# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.6.0 (March 10, 2026)."""

import mujoco
import numpy as np

ARM_MJCF = """
<mujoco model="arm">
  <compiler meshdir="arm_assets" angle="degree" autolimits="true"/>
  <worldbody>
    <frame name="wrist" pos="0 0 0.4"/>
    <body name="upper">
      <joint name="shoulder" type="hinge" axis="0 1 0"/>
      <geom type="capsule" fromto="0 0 0 0 0 0.4" size="0.03"/>
    </body>
  </worldbody>
</mujoco>
"""

GRIPPER_MJCF = """
<mujoco model="gripper">
  <compiler meshdir="gripper_assets" angle="radian" autolimits="true"/>
  <worldbody>
    <body name="palm">
      <joint name="grasp" type="slide" axis="1 0 0" range="0 0.05"/>
      <geom type="box" size="0.03 0.02 0.01"/>
    </body>
  </worldbody>
</mujoco>
"""

TENDON_MJCF = """
<mujoco model="cable_driven_chain">
  <compiler autolimits="true"/>
  <worldbody>
    <site name="anchor" pos="0 0 0.6"/>
    <geom name="pulley" type="sphere" pos="0 0.08 0.5" size="0.03"/>
    <site name="pulley_side" pos="0 0.08 0.55"/>
    <body name="link1" pos="0 0 0.5">
      <joint name="j1" type="hinge" axis="0 1 0"/>
      <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02"/>
      <body name="link2" pos="0.2 0 0">
        <joint name="j2" type="hinge" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02"/>
        <site name="cable_end" pos="0.2 0 0"/>
        <body name="link3" pos="0.2 0 0">
          <joint name="j3" type="hinge" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02"/>
          <body name="link4" pos="0.2 0 0">
            <joint name="j4" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0.2 0 0" size="0.02"/>
          </body>
        </body>
      </body>
    </body>
  </worldbody>
  <tendon>
    <spatial name="cable" width="0.004">
      <site site="anchor"/>
      <geom geom="pulley" sidesite="pulley_side"/>
      <site site="cable_end"/>
    </spatial>
    <fixed name="wrist_coupler">
      <joint joint="j3" coef="1"/>
      <joint joint="j4" coef="-0.5"/>
    </fixed>
  </tendon>
</mujoco>
"""

STRAIN_FLEX_MJCF = """
<mujoco model="soft_beam">
  <option timestep="0.002" integrator="implicitfast"/>
  <worldbody>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <flexcomp name="beam" type="box" pos="0 0 0.5" dim="3"
              spacing="0.1 0.04 0.04" radius="0.001" mass="0.5" dof="trilinear">
      <edge equality="strain"/>
      <contact selfcollide="none" internal="false"/>
      <pin id="0 1 2 3"/>
    </flexcomp>
  </worldbody>
</mujoco>
"""


SDF_FLEX_MJCF = """
<mujoco model="cloth_on_torus">
  <extension>
    <plugin plugin="mujoco.sdf.torus">
      <instance name="torus">
        <config key="radius1" value="0.2"/>
        <config key="radius2" value="0.07"/>
      </instance>
    </plugin>
  </extension>
  <asset>
    <mesh name="torus"><plugin instance="torus"/></mesh>
  </asset>
  <option timestep="0.002" integrator="implicitfast"/>
  <worldbody>
    <geom name="floor" type="plane" size="2 2 0.1"/>
    <body pos="0 0 0.3">
      <geom name="torus" type="sdf" mesh="torus">
        <plugin instance="torus"/>
      </geom>
    </body>
    <body name="cloth_root" pos="0 0 0.6">
      <flexcomp name="cloth" type="grid" count="9 9 1" spacing="0.08 0.08 0.08"
                dim="2" radius="0.002" mass="0.2">
        <edge equality="true"/>
        <contact selfcollide="none" internal="false"/>
      </flexcomp>
    </body>
  </worldbody>
</mujoco>
"""


def element_compiler_settings() -> None:
    """Resolve the compiler settings (meshdir, angle units, ...) that a spec element was authored under."""
    arm = mujoco.MjSpec.from_string(ARM_MJCF)
    gripper = mujoco.MjSpec.from_string(GRIPPER_MJCF)
    arm.attach(gripper, frame="wrist", prefix="gripper_")

    # Every spec element now carries a read-only `compiler` view of the spec it
    # came from. Before, an attached subtree silently answered to the parent's
    # spec.compiler, so asset paths of attached models had to be tracked by hand.
    for body_name in ("upper", "gripper_palm"):
        compiler = arm.body(body_name).compiler
        print(
            f"{body_name}: meshdir={compiler.meshdir!r} "
            f"degree={compiler.degree} autolimits={compiler.autolimits}"
        )

    # The view follows the originating spec, not the element type.
    print("parent spec meshdir:", arm.compiler.meshdir)
    print("attached joint meshdir:", arm.joint("gripper_grasp").compiler.meshdir)


def sparse_tendon_jacobian() -> None:
    """Map a tendon tension to joint torques through ten_J, which is now sparse with index arrays in mjModel."""
    model = mujoco.MjModel.from_xml_string(TENDON_MJCF)
    data = mujoco.MjData(model)
    data.qpos[:] = [0.3, -0.4, 0.2, 0.1]
    mujoco.mj_forward(model, data)

    # ten_J is unconditionally sparse since 3.6.0, and ten_J_rownnz/rowadr/colind
    # moved from mjData to mjModel: they are fixed at compile time, so the
    # sparsity pattern can be hoisted out of the control loop.
    cable = model.tendon("cable").id
    nnz = model.ten_J_rownnz[cable]
    adr = model.ten_J_rowadr[cable]
    dof_ids = model.ten_J_colind[adr : adr + nnz]
    moment_arms = data.ten_J[adr : adr + nnz]
    print(f"nv={model.nv} nJten={model.nJten} cable row: {nnz} nonzeros on dofs {dof_ids}")

    # tau = -J^T f, applied only to the dofs the cable actually spans.
    tension = 50.0
    qfrc_cable = np.zeros(model.nv)
    qfrc_cable[dof_ids] = -tension * moment_arms
    print(f"joint torques from {tension} N of tension: {qfrc_cable}")

    # mju_sparse2dense reconstitutes the whole matrix when a dense row is wanted.
    ten_jac = np.zeros((model.ntendon, model.nv))
    mujoco.mju_sparse2dense(
        ten_jac, data.ten_J, model.ten_J_rownnz, model.ten_J_rowadr, model.ten_J_colind
    )
    print("dense ten_J:\n", ten_jac)


def flex_strain_equality() -> None:
    """Keep a fast trilinear/quadratic flex from stretching by constraining edge strain instead of edge length."""
    model = mujoco.MjModel.from_xml_string(STRAIN_FLEX_MJCF)
    data = mujoco.MjData(model)

    # `strain` is the equality type for reduced-dof flexes (trilinear/quadratic),
    # where the older per-edge `flex` equality has no independent vertex dofs to act on.
    eq_names = [mujoco.mjtEq(eq_type).name for eq_type in model.eq_type]
    print(f"neq={model.neq} types={eq_names} flex dofs nv={model.nv}")

    adr = model.flex_vertadr[0]
    vertices = slice(adr, adr + model.flex_vertnum[0])
    mujoco.mj_forward(model, data)
    rest_span = np.ptp(data.flexvert_xpos[vertices], axis=0)
    mujoco.mj_step(model, data, nstep=500)
    hung_span = np.ptp(data.flexvert_xpos[vertices], axis=0)

    print(f"equality constraints active: ne={data.ne} of nefc={data.nefc}")
    print(f"flex bounding box rest={rest_span.round(4)} after 1 s={hung_span.round(4)}")
    print(f"length stretch under gravity: {hung_span[0] / rest_span[0] - 1.0:+.4%}")


def flex_sdf_collision() -> None:
    """Drape a flex over an analytic signed-distance geom instead of a mesh approximation of it."""
    model = mujoco.MjModel.from_xml_string(SDF_FLEX_MJCF)
    data = mujoco.MjData(model)
    torus = model.geom("torus").id

    # Flexes now collide with sdf geoms, so an sdf plugin shape can be the
    # collision target of cloth or soft bodies, not just of rigid geoms.
    mujoco.mj_step(model, data, nstep=1000)

    # contact.geom is the (ncon, 2) pair view; the scalar geom1/geom2 fields it
    # replaced are deprecated.
    on_torus = np.count_nonzero((data.contact.geom[: data.ncon] == torus).any(axis=1))
    vertices = slice(model.flex_vertadr[0], model.flex_vertadr[0] + model.flex_vertnum[0])
    height = data.flexvert_xpos[vertices, 2]
    print(f"ncon={data.ncon}, of which {on_torus} are flex-vs-sdf contacts")
    print(f"cloth height after 2 s: min={height.min():.3f} max={height.max():.3f} m")
    print(f"penetration depth on the torus: {data.contact.dist[: data.ncon].min():.5f} m")


def main() -> None:
    element_compiler_settings()
    print()
    sparse_tendon_jacobian()
    print()
    flex_strain_equality()
    print()
    flex_sdf_collision()


if __name__ == "__main__":
    main()
