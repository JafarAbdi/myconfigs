# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.3.3 (June 10, 2025)."""

import jax
import jax.numpy as jp
import mujoco
import numpy as np
from mujoco import mjx


def light_type() -> None:
    """Pick a light's kind from an enum instead of a boolean, in MJCF or on an MjSpec."""
    # light/type (mjtLightType) replaced the light/directional boolean in 3.3.3:
    # directional="false" -> type="spot", directional="true" -> type="directional".
    xml = """
    <mujoco>
      <worldbody>
        <geom type="plane" size="2 2 .1"/>
        <light name="sun" type="directional" dir="0 -.3 -1" diffuse=".7 .7 .65"/>
        <light name="lamp" type="spot" pos="0 0 1.5" dir="0 0 -1" cutoff="35" exponent="10"/>
      </worldbody>
    </mujoco>"""
    model = mujoco.MjModel.from_xml_string(xml)
    for i in range(model.nlight):
        light = model.light(i)
        print(f"{light.name:5s} type={mujoco.mjtLightType(light.type.item())!r} dir={light.dir}")
    print(f"all light types: {[t.name for t in mujoco.mjtLightType.__members__.values()]}")

    # On an MjSpec the field is an enum too, so lights can be switched after the fact.
    spec = mujoco.MjSpec.from_string('<mujoco><worldbody><light name="key"/></worldbody></mujoco>')
    spec.lights[0].type = mujoco.mjtLightType.mjLIGHT_DIRECTIONAL
    print(f"spec-edited light_type = {spec.compile().light_type}")

    try:
        mujoco.MjModel.from_xml_string(
            '<mujoco><worldbody><light type="spot" directional="true"/></worldbody></mujoco>'
        )
    except ValueError as error:
        print(f"mixing old and new -> {str(error).splitlines()[0]}")


def texture_colorspace() -> None:
    """Declare whether a texture's values are linear or sRGB so shading is not silently wrong."""
    # asset/texture/colorspace (mjtColorSpace) is new in 3.3.3, along with correct sRGB decoding
    # of PNGs. Migration: set colorspace="linear" on textures that should look as they did before.
    xml = """
    <mujoco>
      <asset>
        <texture name="{name}" type="2d" builtin="checker" width="64" height="64"
                 rgb1=".15 .2 .3" rgb2=".8 .8 .75"{colorspace}/>
        <material name="mat" texture="{name}" texrepeat="4 4"/>
      </asset>
      <worldbody><geom type="plane" size="2 2 .1" material="mat"/></worldbody>
    </mujoco>"""
    declarations = (("auto", ""), ("lin", ' colorspace="linear"'), ("srgb", ' colorspace="sRGB"'))
    for name, colorspace in declarations:
        model = mujoco.MjModel.from_xml_string(xml.format(name=name, colorspace=colorspace))
        resolved = mujoco.mjtColorSpace(model.tex_colorspace[0].item())
        print(f'colorspace={colorspace.strip() or "(unset)":22s} -> {resolved!r}')


def mass_matrix() -> None:
    """Build the joint-space inertia matrix including tendon armature, and read its CSR layout."""
    # mj_makeM is what you want, not mj_crb: since 3.3.5 mj_crb omits the tendon
    # armature term, so it no longer yields the full inertia matrix on its own.
    xml = """
    <mujoco>
      <worldbody>
        <site name="winch" pos="0 0 1.1"/>
        <body name="carriage" pos="0 0 .8">
          <joint name="lift" type="slide" axis="0 0 1"/>
          <geom type="box" size=".08 .08 .04" mass="3"/>
          <site name="eyelet" pos="0 0 .04"/>
          <body name="boom_left" pos="0 0 -.04">
            <joint name="left_swing" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 -.4 0 0" size=".02" mass="1"/>
            <body name="tool_left" pos="-.4 0 0">
              <joint name="left_wrist" type="hinge" axis="0 1 0"/>
              <geom type="capsule" fromto="0 0 0 -.15 0 0" size=".015" mass=".4"/>
            </body>
          </body>
          <body name="boom_right" pos="0 0 -.04">
            <joint name="right_swing" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 .4 0 0" size=".02" mass="1"/>
            <body name="tool_right" pos=".4 0 0">
              <joint name="right_wrist" type="hinge" axis="0 1 0"/>
              <geom type="capsule" fromto="0 0 0 .15 0 0" size=".015" mass=".4"/>
            </body>
          </body>
        </body>
      </worldbody>
      <tendon>
        <spatial name="hoist" armature="5">
          <site site="winch"/>
          <site site="eyelet"/>
        </spatial>
      </tendon>
    </mujoco>"""
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    # mj_makeM is the whole inertia step: mj_crb alone stops at the composite rigid body inertia
    # and misses the tendon armature term, so call mj_makeM when recomputing M by hand.
    mujoco.mj_crb(model, data)
    m_crb = data.M.copy()
    mujoco.mj_makeM(model, data)
    print(f"mj_crb   M[lift,lift] = {m_crb[model.M_rowadr[0]]:.3f} kg")
    print(f"mj_makeM M[lift,lift] = {data.M[model.M_rowadr[0]]:.3f} kg"
          f" (+ tendon armature {model.tendon_armature[0]:.1f})")

    # mjData.M is compressed sparse row: nC nonzeros, M_rownnz/M_rowadr/M_colind describe them.
    # The two booms are independent branches, so their dofs never share a row - that is the
    # structural sparsity the CSR layout keeps and a dense lower triangle would waste.
    print(f"nv={model.nv} nC={model.nC} (dense {model.nv**2},"
          f" dense lower triangle {model.nv * (model.nv + 1) // 2})")
    print(f"M_rownnz={model.M_rownnz} M_rowadr={model.M_rowadr}")
    print(f"M_colind={model.M_colind}")
    dense = np.zeros((model.nv, model.nv))
    mujoco.mj_fullM(model, data, dense)
    print(f"dense M =\n{dense.round(4)}")


def fuse_static_bodies() -> None:
    """Collapse static bodies into their parent even in models that reference other elements."""
    # Before 3.3.3 fusestatic gave up entirely on any model containing references; it now fuses
    # every unreferenced static body and leaves the referenced ones alone.
    xml = """
    <mujoco>
      <compiler fusestatic="{fusestatic}"/>
      <worldbody>
        <body name="bench" pos="0 0 .5">
          <geom name="bench_top" type="box" size=".4 .3 .02" mass="15"/>
          <body name="load_cell" pos="0 0 .025">
            <geom type="box" size=".05 .05 .005" mass=".1"/>
          </body>
        </body>
        <body name="box" pos="0 0 .8">
          <freejoint/><geom type="box" size=".05 .05 .05" mass="2"/>
        </body>
      </worldbody>
      <sensor><framepos name="cell_pos" objtype="body" objname="load_cell"/></sensor>
    </mujoco>"""
    for fusestatic in ("false", "true"):
        model = mujoco.MjModel.from_xml_string(xml.format(fusestatic=fusestatic))
        bodies = [model.body(i).name for i in range(model.nbody)]
        print(f"fusestatic={fusestatic:5s} nbody={model.nbody} {bodies}")
    print("'bench' is unreferenced and fuses into world;"
          " 'load_cell' is named by a sensor and stays")


def flex_2d_elasticity() -> None:
    """Give a 2D flex membrane stretching and bending stiffness, without the old shell plugin."""
    # The `shell` elasticity plugin was removed in 3.3.3; flex/elasticity/elastic2d
    # ("none" | "bend" | "stretch" | "both") is the replacement and is off by default.
    xml = """
    <mujoco>
      <option timestep="0.001" integrator="implicitfast"/>
      <worldbody>
        <flexcomp name="sail" type="grid" count="9 9 1" spacing=".04 .04 .04" pos="0 0 1"
                  dim="2" radius=".002" mass=".2">
          <elasticity young="5e4" poisson=".3" thickness="1e-3" damping=".01" elastic2d="{mode}"/>
          <pin id="0 8"/>
          <contact selfcollide="none" internal="false"/>
        </flexcomp>
      </worldbody>
    </mujoco>"""
    for mode in ("none", "bend", "stretch", "both"):
        model = mujoco.MjModel.from_xml_string(xml.format(mode=mode))
        data = mujoco.MjData(model)
        mujoco.mj_step(model, data, nstep=int(2.0 / model.opt.timestep))
        pos_World_Vertices = data.flexvert_xpos
        drop = 1.0 - pos_World_Vertices[:, 2].min()
        print(f'elastic2d="{mode:7s}" lowest vertex is {drop:7.3f} m below the pinned corners')
    print("only the stretch term carries the load; without it the unpinned vertices just fall")


def mjx_tendon_armature() -> None:
    """Carry leadscrew/hydraulic inertia through a tendon on the MJX backend."""
    xml = """
    <mujoco>
      <option timestep="0.002" gravity="0 0 0"/>
      <worldbody>
        <site name="cylinder_base" pos="0 0 .8"/>
        <body name="ram" pos="0 0 .3">
          <joint name="stroke" type="slide" axis="0 0 1" range="-.3 .3"/>
          <geom type="cylinder" size=".03 .1" mass="2"/>
          <site name="rod_end" pos="0 0 .1"/>
        </body>
      </worldbody>
      <tendon>
        <spatial name="leadscrew" armature="{armature}">
          <site site="cylinder_base"/>
          <site site="rod_end"/>
        </spatial>
      </tendon>
      <actuator><motor name="drive" tendon="leadscrew" gear="1" ctrlrange="-30 30"/></actuator>
    </mujoco>"""
    step = jax.jit(mjx.step)
    for armature in (0.0, 6.0):
        model = mujoco.MjModel.from_xml_string(xml.format(armature=armature))
        model_mjx = mjx.put_model(model)
        data_mjx = mjx.make_data(model_mjx).replace(ctrl=jp.array([-10.0]))
        data = mujoco.MjData(model)
        data.ctrl[0] = -10.0
        for _ in range(100):
            data_mjx = step(model_mjx, data_mjx)
            mujoco.mj_step(model, data)
        print(
            f"armature={armature:3.1f} kg  mjx stroke={float(data_mjx.qpos[0]):.6f} m"
            f"  c stroke={data.qpos[0]:.6f} m"
            f"  |diff|={abs(float(data_mjx.qpos[0]) - data.qpos[0]):.2e}"
        )


def main() -> None:
    for demo in (
        light_type,
        texture_colorspace,
        mass_matrix,
        fuse_static_bodies,
        flex_2d_elasticity,
        mjx_tendon_armature,
    ):
        print(f"\n=== {demo.__name__}: {demo.__doc__}")
        demo()


if __name__ == "__main__":
    main()
