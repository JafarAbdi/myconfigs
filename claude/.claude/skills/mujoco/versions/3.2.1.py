# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.2.1 (Aug 5, 2024)."""

import jax
import mujoco
import numpy as np
from jax import numpy as jp
from mujoco import mjx


def autoreset_disable() -> None:
    """Keep a diverged state for post-mortem inspection instead of silently resetting to qpos0."""
    # A stiff spring integrated with an oversized timestep: the classic "my sim exploded" model.
    xml = """
    <mujoco>
      <option timestep="0.1" integrator="Euler"/>
      <worldbody>
        <body name="mass" pos="0 0 1">
          <joint name="slide" type="slide" axis="0 0 1" stiffness="1e7" damping="0"/>
          <geom type="sphere" size="0.05" mass="0.01"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)

    # Default behaviour: mj_step detects the bad qacc, warns, and resets the state.
    data = mujoco.MjData(model)
    data.qpos[0] = 0.1
    mujoco.mj_step(model, data, nstep=50)
    print(f"autoreset on : qpos={data.qpos[0]:+.3e} qvel={data.qvel[0]:+.3e} (state was reset)")

    # Disabling autoreset leaves the diverged numbers in mjData, which is what you want in a
    # debugger or when bisecting a controller that destabilises the model.
    model.opt.disableflags |= mujoco.mjtDisableBit.mjDSBL_AUTORESET
    data = mujoco.MjData(model)
    data.qpos[0] = 0.1
    mujoco.mj_step(model, data, nstep=50)
    print(f"autoreset off: qpos={data.qpos[0]:+.3e} qvel={data.qvel[0]:+.3e}")

    # mjWarningStat carries only a counter and an info integer, never a string. mju_warningText
    # turns that pair into the message the library prints; this is how simulate reports a bad step.
    warning = data.warning[mujoco.mjtWarning.mjWARN_BADQACC]
    text = mujoco.mju_warningText(mujoco.mjtWarning.mjWARN_BADQACC, warning.lastinfo)
    print(f"mjWARN_BADQACC raised {warning.number} times: {text}")


def texture_data_repaint() -> None:
    """Rewrite a texture's pixels on a live model — mjModel.tex_data, once called tex_rgb."""
    xml = """
    <mujoco>
      <asset>
        <texture name="gauge" type="2d" builtin="flat" width="64" height="64" rgb1="0.2 0.2 0.2"/>
        <material name="gauge" texture="gauge" texrepeat="1 1" texuniform="false"/>
      </asset>
      <worldbody>
        <geom name="panel" type="box" size="0.5 0.01 0.25" pos="0 0 0.25" material="gauge"/>
        <body name="probe" pos="0 0 1">
          <joint name="fall" type="slide" axis="0 0 1"/>
          <geom type="sphere" size="0.05" mass="1"/>
        </body>
      </worldbody>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    data = mujoco.MjData(model)

    texture_id = model.texture("gauge").id
    address = model.tex_adr[texture_id]
    width = model.tex_width[texture_id]
    height = model.tex_height[texture_id]
    channels = model.tex_nchannel[texture_id]
    # tex_data is one flat uint8 buffer for all textures; slice it with tex_adr and reshape.
    pixels = model.tex_data[address : address + width * height * channels]
    pixels = pixels.reshape(height, width, channels)
    print(f"texture 'gauge': {width}x{height}x{channels}, first pixel {pixels[0, 0]}")

    mujoco.mj_step(model, data, nstep=100)

    # Paint a bar gauge whose fill tracks how far the probe has dropped.
    fill = float(np.clip(-data.qpos[0] / 0.5, 0.0, 1.0))
    filled_rows = int(round(fill * height))
    pixels[:] = (40, 40, 40)
    pixels[height - filled_rows :] = (220, 60, 40)
    # The GPU copy is separate: after editing tex_data call mjr_uploadTexture(model, context, id).
    print(f"drop={-data.qpos[0]:.3f} m -> fill={fill:.2f}, {filled_rows}/{height} rows repainted")
    print(f"top row {pixels[0, 0]}, bottom row {pixels[-1, 0]}")


def material_texture_layers() -> None:
    """Attach several role-tagged textures to one material for a PBR-capable external renderer."""
    spec = mujoco.MjSpec()
    for name, gray in (("albedo", 0.7), ("rough", 0.3), ("metal", 0.9)):
        spec.add_texture(
            name=name,
            type=mujoco.mjtTexture.mjTEXTURE_2D,
            builtin=mujoco.mjtBuiltin.mjBUILTIN_FLAT,
            width=32,
            height=32,
            rgb1=[gray, gray, gray],
        )

    # Before 3.2.1 a material had a single texture; now mat.textures is indexed by mjtTextureRole,
    # mirroring the MJCF <material><layer role="..." texture="..."/></material> sub-element.
    material = spec.add_material(name="brushed_steel", roughness=0.3, metallic=0.9)
    material.textures[mujoco.mjtTextureRole.mjTEXROLE_RGB] = "albedo"
    material.textures[mujoco.mjtTextureRole.mjTEXROLE_ROUGHNESS] = "rough"
    material.textures[mujoco.mjtTextureRole.mjTEXROLE_METALLIC] = "metal"

    body = spec.worldbody.add_body(name="panel", pos=[0, 0, 0.5])
    body.add_geom(type=mujoco.mjtGeom.mjGEOM_BOX, size=[0.3, 0.02, 0.2], material="brushed_steel")
    model = spec.compile()

    # MuJoCo's own renderer only consumes mjTEXROLE_RGB; the rest ride along for USD/Blender export.
    material_id = model.material("brushed_steel").id
    for role_index in range(model.mat_texid.shape[1]):
        texture_id = model.mat_texid[material_id, role_index].item()
        if texture_id != -1:
            role = mujoco.mjtTextureRole(role_index)
            print(f"{role.name:<24} -> texture '{model.texture(texture_id).name}'")


def mjx_tendon_support() -> None:
    """Drive coupled joints with a fixed tendon in MJX — transmission, limits, equality."""
    xml = """
    <mujoco>
      <option timestep="0.002"/>
      <worldbody>
        <body name="proximal" pos="0 0 0.5">
          <joint name="knuckle" type="hinge" axis="0 1 0"/>
          <geom type="capsule" fromto="0 0 0 0.1 0 0" size="0.015" mass="0.05"/>
          <body name="distal" pos="0.1 0 0">
            <joint name="tip" type="hinge" axis="0 1 0"/>
            <geom type="capsule" fromto="0 0 0 0.07 0 0" size="0.012" mass="0.03"/>
          </body>
        </body>
      </worldbody>
      <tendon>
        <!-- Underactuated finger: one tendon length spans both joints. -->
        <fixed name="flexor" limited="true" range="-0.5 1.2">
          <joint joint="knuckle" coef="1"/>
          <joint joint="tip" coef="0.6"/>
        </fixed>
        <fixed name="coupler">
          <joint joint="knuckle" coef="1"/>
          <joint joint="tip" coef="-2"/>
        </fixed>
      </tendon>
      <actuator>
        <motor name="flexor" tendon="flexor" gear="1" ctrlrange="-2 2"/>
      </actuator>
      <equality>
        <!-- mjEQ_TENDON: hold the coupler length at zero, i.e. knuckle = 2 * tip. -->
        <tendon tendon1="coupler" polycoef="0 0 0 0 0"/>
      </equality>
    </mujoco>
    """
    model = mujoco.MjModel.from_xml_string(xml)
    assert model.eq_type[0] == mujoco.mjtEq.mjEQ_TENDON
    mjx_model = mjx.put_model(model)
    mjx_data = mjx.make_data(mjx_model)
    mjx_data = mjx_data.replace(ctrl=jp.array([0.4]))

    data = mujoco.MjData(model)
    data.ctrl[0] = 0.4
    # Always jit the MJX step; calling it eagerly in a Python loop is orders of magnitude slower.
    step = jax.jit(mjx.step)
    for _ in range(400):
        mujoco.mj_step(model, data)
        mjx_data = step(mjx_model, mjx_data)

    tendon_id = model.tendon("flexor").id
    print(
        f"tendon length  mujoco={data.ten_length[0]:+.6f}  mjx={float(mjx_data.ten_length[0]):+.6f}"
    )
    # mjCNSTR_LIMIT_TENDON is a soft constraint, so the length settles slightly past the range.
    print(f"tendon range   {model.tendon_range[tendon_id]} (soft limit, overshoot expected)")
    print(f"knuckle, tip   mujoco={np.array2string(data.qpos, precision=6)}")
    print(f"               mjx   ={np.array2string(np.asarray(mjx_data.qpos), precision=6)}")
    # MJX splits its constraint rows the way MuJoCo does: ne equality, nl limit, then contacts.
    # These counters live behind mjx.Data._impl, where the MJX-internal arrays moved.
    print(
        f"constraints    mujoco ne={data.ne} nl={data.nl}"
        f"  mjx ne={int(mjx_data._impl.ne)} nl={int(mjx_data._impl.nl)}"
    )


def main() -> None:
    for demo in (
        autoreset_disable,
        texture_data_repaint,
        material_texture_layers,
        mjx_tendon_support,
    ):
        print(f"\n=== {demo.__name__} ===")
        demo()


if __name__ == "__main__":
    main()
