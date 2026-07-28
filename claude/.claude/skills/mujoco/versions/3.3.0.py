# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.3.0 (February 26, 2025)."""

import time

import jax
import mujoco
import numpy as np
from mujoco import mjx


def flexcomp_trilinear() -> None:
    """Simulate a deformable pad far cheaper by reducing it to 24 bounding-box dofs."""
    # flexcomp/dof="trilinear" replaces hand-rolled coarse-mesh proxies: collision geometry stays at
    # full resolution while the interior vertices are trilinearly interpolated from 8 free corners.
    xml = """
    <mujoco>
      <option timestep="0.0005" integrator="implicitfast"/>
      <worldbody>
        <geom name="floor" type="plane" size="1 1 .1"/>
        <flexcomp name="pad" type="grid" count="5 5 5" spacing=".02 .02 .02" pos="0 0 .15"
                  dim="3" dof="{dof}" radius=".002" mass=".3">
          <elasticity young="5e3" poisson=".2" damping=".01"/>
          <contact selfcollide="none" internal="false" solref="-2000 -50"/>
        </flexcomp>
      </worldbody>
    </mujoco>"""

    for dof in ("full", "trilinear"):
        model = mujoco.MjModel.from_xml_string(xml.format(dof=dof))
        data = mujoco.MjData(model)
        step_count = int(1.0 / model.opt.timestep)
        wall_start = time.perf_counter()
        mujoco.mj_step(model, data, nstep=step_count)
        wall = time.perf_counter() - wall_start

        pos_World_Vertices = data.flexvert_xpos
        height = pos_World_Vertices[:, 2].max() - pos_World_Vertices[:, 2].min()
        print(
            f"dof={dof:9s} nv={model.nv:3d}  collision vertices={model.nflexvert}  "
            f"settled height={height:.3f} m  {step_count} steps in {wall:.2f} s"
        )


def native_ccd() -> None:
    """A/B a model against both convex-collision pipelines when contacts change under 3.3.0."""
    # nativeccd (new in 3.2.3) became the default in 3.3.0; the old libccd path is now the
    # opt-out, via option/flag nativeccd="disable", i.e. the mjDSBL_NATIVECCD disable bit.
    # This toggle is the migration tool: run the same state through both and diff the contacts.
    xml = """
    <mujoco>
      <worldbody>
        <body name="table"><geom name="top" type="box" size=".2 .2 .05"/></body>
        <body name="can" pos=".01 .02 .09" euler="20 15 0">
          <freejoint/>
          <geom name="can" type="cylinder" size=".05 .06"/>
        </body>
      </worldbody>
    </mujoco>"""
    model = mujoco.MjModel.from_xml_string(xml)
    nativeccd = int(mujoco.mjtDisableBit.mjDSBL_NATIVECCD)
    print(f"nativeccd disabled out of the box? {bool(int(model.opt.disableflags) & nativeccd)}")

    for label, disabled in (("native (default)", False), ("legacy libccd", True)):
        flags = int(model.opt.disableflags)
        model.opt.disableflags = flags | nativeccd if disabled else flags & ~nativeccd
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        print(
            f"{label:17s} ncon={data.ncon}"
            f"  deepest={data.contact.dist[: data.ncon].min() * 1e3:.2f} mm"
        )


def energy_sensors() -> None:
    """Measure integrator energy drift without wiring up mjData.energy by hand."""
    # e_potential/e_kinetic sensors enable the energy computation themselves - no
    # option/flag energy="enable" needed - and land in sensordata like any other channel.
    xml = """
    <mujoco>
      <option timestep="{timestep}" integrator="{integrator}"/>
      <worldbody>
        <body name="upper" pos="0 0 1">
          <joint name="shoulder" type="hinge" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".03" mass="1"/>
          <body name="lower" pos="0 0 -.3">
            <joint name="elbow" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0 0 -.3" size=".025" mass=".6"/>
          </body>
        </body>
      </worldbody>
      <sensor>
        <e_potential name="potential"/>
        <e_kinetic name="kinetic"/>
      </sensor>
    </mujoco>"""

    for integrator, timestep in (("Euler", 0.002), ("Euler", 0.0005), ("RK4", 0.002)):
        model = mujoco.MjModel.from_xml_string(
            xml.format(integrator=integrator, timestep=timestep)
        )
        data = mujoco.MjData(model)
        data.qpos[:] = (1.2, -0.7)
        mujoco.mj_forward(model, data)
        energy_start = data.sensor("potential").data[0] + data.sensor("kinetic").data[0]
        mujoco.mj_step(model, data, nstep=int(5.0 / model.opt.timestep))
        potential, kinetic = data.sensor("potential").data[0], data.sensor("kinetic").data[0]
        drift = potential + kinetic - energy_start
        print(
            f"{integrator:5s} dt={timestep * 1e3:4.1f} ms  U={potential:+7.3f} J  "
            f"T={kinetic:6.3f} J  drift over 5 s={drift:+.4f} J"
        )


def spec_shallow_attach() -> None:
    """Keep editing a child spec through its own handle after attaching it to a parent."""
    # mjs_setDeepCopy, exposed as the write-only MjSpec.copy_during_attach property. Since 3.3.0
    # attach is shallow by default, so the child spec stays live; set it True for the old deep copy.
    def gripper() -> mujoco.MjSpec:
        return mujoco.MjSpec.from_string("""
        <mujoco>
          <worldbody>
            <body name="finger">
              <joint name="slide" type="slide" axis="1 0 0" range="0 .04"/>
              <geom name="pad" type="box" size=".01 .02 .03" mass=".05"/>
            </body>
          </worldbody>
        </mujoco>""")

    def arm() -> mujoco.MjSpec:
        return mujoco.MjSpec.from_string("""
        <mujoco>
          <worldbody>
            <body name="wrist" pos="0 0 .5">
              <joint name="roll" type="hinge" axis="0 0 1"/>
              <geom name="flange" type="cylinder" size=".03 .01" mass=".4"/>
              <frame name="tool" pos="0 0 .02"/>
            </body>
          </worldbody>
        </mujoco>""")

    for copy_during_attach in (False, True):
        parent, child = arm(), gripper()
        parent.copy_during_attach = copy_during_attach
        parent.attach(child, frame="tool", prefix="gripper_")
        # Tune the pad through the ORIGINAL child handle, after attachment.
        child.geoms[0].size[:] = (0.01, 0.02, 0.05)
        model = parent.compile()
        pad_size = model.geom("gripper_pad").size
        mode = "deep copy" if copy_during_attach else "shallow (default)"
        kept = "lost" if copy_during_attach else "kept"
        print(f"{mode:18s} gripper_pad half-size={pad_size} (edit {kept})")


def mjx_tendon_wrapping() -> None:
    """Run spatial tendons that wrap around sphere and cylinder geoms on the MJX backend."""
    xml = """
    <mujoco>
      <option timestep="0.002"/>
      <worldbody>
        <site name="anchor" pos="-.2 0 .5"/>
        <geom name="pulley" type="cylinder" size=".08 .02" pos="0 0 .5" zaxis="0 1 0"
              contype="0" conaffinity="0"/>
        <site name="pulley_side" pos="0 0 .6"/>
        <body name="load" pos=".2 0 .2">
          <joint name="lift" type="slide" axis="0 0 1" range="-.1 .3"/>
          <geom type="box" size=".05 .05 .05" mass="1"/>
          <site name="hook" pos="0 0 .05"/>
        </body>
      </worldbody>
      <tendon>
        <spatial name="cable" width=".005">
          <site site="anchor"/>
          <geom geom="pulley" sidesite="pulley_side"/>
          <site site="hook"/>
        </spatial>
      </tendon>
      <actuator><motor name="winch" tendon="cable" gear="1" ctrlrange="-40 0"/></actuator>
    </mujoco>"""
    model = mujoco.MjModel.from_xml_string(xml)
    model_mjx = mjx.put_model(model)
    data_mjx = mjx.make_data(model_mjx).replace(ctrl=jax.numpy.array([-25.0]))
    step = jax.jit(mjx.step)
    for _ in range(50):
        data_mjx = step(model_mjx, data_mjx)

    data = mujoco.MjData(model)
    data.ctrl[0] = -25.0
    mujoco.mj_step(model, data, nstep=50)

    print(
        f"mjx  cable length={float(data_mjx.ten_length[0]):.6f} m"
        f"  lift={float(data_mjx.qpos[0]):+.6f} m"
    )
    print(f"c    cable length={data.ten_length[0]:.6f} m  lift={data.qpos[0]:+.6f} m")
    print(f"max |mjx - c| qpos = {np.abs(np.asarray(data_mjx.qpos) - data.qpos).max():.2e}")


def main() -> None:
    for demo in (
        flexcomp_trilinear,
        native_ccd,
        energy_sensors,
        spec_shallow_attach,
        mjx_tendon_wrapping,
    ):
        print(f"\n=== {demo.__name__}: {demo.__doc__}")
        demo()


if __name__ == "__main__":
    main()
