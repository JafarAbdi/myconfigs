# /// script
# dependencies = ["mujoco==3.11.0", "mujoco-mjx==3.11.0"]
# ///
"""New in mujoco 3.2.4 (Oct 15, 2024)."""

import jax
import jax.numpy as jp
import mujoco
import numpy as np
from mujoco import mjx

CANTILEVER = """
<mujoco model="cantilever">
  <option solver="CG" tolerance="1e-6" timestep="{timestep}"/>
  <size memory="64M"/>
  <worldbody>
    <body name="wall" pos="0 0 .6">
      <flexcomp name="beam" type="grid" dim="3" count="13 3 3" spacing=".05 .05 .05"
                radius="0" mass="5" rgba=".3 .5 .8 1">
        <elasticity young="{young}" poisson=".2" damping=".002"/>
        <contact selfcollide="none"/>
        <pin id="{clamped}"/>
      </flexcomp>
    </body>
  </worldbody>
</mujoco>
"""

CABLE = """
<mujoco model="cable">
  <compiler autolimits="true"/>
  <option timestep=".002"/>
  <size memory="4M"/>
  <worldbody>
    <composite type="cable" curve="s" count="21 1 1" size=".8" offset="0 0 .6" initial="none">
      <plugin plugin="mujoco.elasticity.cable">
        <config key="twist" value="1e7"/>
        <config key="bend" value="4e6"/>
        <config key="vmax" value="0.05"/>
      </plugin>
      <joint kind="main" damping=".015"/>
      <geom type="capsule" size=".005" rgba=".8 .2 .1 1" condim="1"/>
    </composite>
  </worldbody>
</mujoco>
"""

HOIST = """
<mujoco model="hoist">
  <compiler autolimits="true"/>
  <option timestep=".002"/>
  <worldbody>
    <site name="anchor_fixed" pos="-.15 0 1"/>
    <site name="anchor_pulled" pos=".15 0 1"/>
    <geom name="sheave" type="cylinder" size=".06 .02" pos="0 0 .9" euler="90 0 0"
          contype="0" conaffinity="0"/>
    <site name="sheave_side" pos="0 0 .84"/>
    <body name="load" pos="0 0 .4">
      <freejoint/>
      <geom type="box" size=".06 .06 .06" mass="4"/>
      <site name="hook_left" pos="-.05 0 .06"/>
      <site name="hook_right" pos=".05 0 .06"/>
    </body>
  </worldbody>
  <tendon>
    <spatial name="hoist" width=".005" rgba=".9 .8 .2 1" limited="true" range="0 .83">
      <site site="anchor_fixed"/>
      <geom geom="sheave" sidesite="sheave_side"/>
      <site site="hook_left"/>
      <pulley divisor="2"/>
      <site site="anchor_pulled"/>
      <site site="hook_right"/>
    </spatial>
  </tendon>
  <sensor>
    <tendonpos name="hoist_pos" tendon="hoist"/>
    <tendonvel name="hoist_vel" tendon="hoist"/>
  </sensor>
</mujoco>
"""

COUPLED_FINGER = """
<mujoco model="coupled_finger">
  <compiler autolimits="true"/>
  <option timestep=".002"/>
  <worldbody>
    <body name="proximal" pos="0 0 .5">
      <joint name="mcp" axis="0 1 0" range="0 90" damping=".02"/>
      <geom type="capsule" fromto="0 0 0 .06 0 0" size=".01" mass=".05"/>
      <body name="distal" pos=".06 0 0">
        <joint name="pip" axis="0 1 0" range="0 90" damping=".02"/>
        <geom type="capsule" fromto="0 0 0 .04 0 0" size=".008" mass=".03"/>
      </body>
    </body>
  </worldbody>
  <tendon>
    <fixed name="coupler" stiffness="5" springlength="0">
      <joint joint="mcp" coef="2"/>
      <joint joint="pip" coef="-1"/>
    </fixed>
  </tendon>
  <actuator>
    <motor name="mcp" joint="mcp" gear=".05" ctrlrange="-1 1"/>
  </actuator>
  <sensor>
    <tendonpos name="coupler_pos" tendon="coupler"/>
    <tendonvel name="coupler_vel" tendon="coupler"/>
  </sensor>
</mujoco>
"""

PADDLE = """
<mujoco model="paddle">
  <option timestep=".004"/>
  <worldbody>
    <geom name="floor" type="plane" size="3 3 .1"/>
    <body name="paddle" mocap="true" pos="-.4 0 .06">
      <geom type="box" size=".02 .12 .06"/>
    </body>
    <body name="ball" pos="0 0 .06">
      <freejoint/>
      <geom type="sphere" size=".06" mass=".15"/>
    </body>
  </worldbody>
</mujoco>
"""


def flex_elasticity() -> None:
    """Give a flex continuum stiffness with the engine's own elasticity, no plugin needed."""
    # The solid and membrane elasticity plugins were folded into the engine: a flex
    # takes <elasticity young/poisson/damping> directly (plus thickness/elastic2d for
    # 2D flexes). Integration stays explicit, so a stiffer beam needs a finer timestep.
    clamped = " ".join(str(13 * j + 39 * k) for j in range(3) for k in range(3))
    print("flex elasticity: 0.6 m x 5 kg beam, one face clamped, settled under gravity")
    for young, timestep in ((2e4, 1e-3), (1e5, 5e-4), (5e5, 1e-4)):
        model = mujoco.MjModel.from_xml_string(
            CANTILEVER.format(young=young, timestep=timestep, clamped=clamped)
        )
        data = mujoco.MjData(model)
        mujoco.mj_forward(model, data)
        rest = data.flexvert_xpos[:, 2].min()

        steps = round(2.0 / timestep)
        mujoco.mj_step(model, data, nstep=steps)

        # A diverging beam trips a warning counter (and, unless mjDSBL_AUTORESET is
        # set, resets the model), which would silently fake a stiff beam. This is
        # the same signal rollout.cc watches to cut a trajectory short.
        assert not any(warning.number for warning in data.warning), (
            f"diverged at young {young:.0e}"
        )
        speed = np.abs(data.qvel).max()
        assert speed < 0.1, f"not settled at young {young:.0e}: {speed:.4f} m/s"
        assert model.nplugin == 0, "elasticity should need no plugin"

        sag = rest - data.flexvert_xpos[:, 2].min()
        print(f"  young {young:.0e} Pa, dt {timestep:.0e} s -> tip sag {sag * 1e3:6.2f} mm")
    print("  sag tracks 1/young, and the compiled model carries 0 plugins")


def activate_plugin() -> None:
    """Enable an engine plugin for a spec assembled in Python, with no <extension> in the XML."""
    spec = mujoco.MjSpec.from_string(CABLE)
    # Replaces mjs_setActivePlugins: plugins are activated one at a time, by name,
    # on the spec that needs them.
    spec.activate_plugin("mujoco.elasticity.cable")
    model = spec.compile()

    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    tip = model.body("B_last").id
    rest_tip_World = data.xpos[tip].copy()
    mujoco.mj_step(model, data, nstep=500)

    config = "".join(chr(c) for c in model.plugin_attr).split("\0")
    swing = np.linalg.norm(data.xpos[tip] - rest_tip_World)
    hosts = np.count_nonzero(model.body_plugin >= 0)
    print("cable plugin activated from Python:")
    print(f"  nplugin {model.nplugin}, bodies carrying it {hosts}")
    print(f"  config twist={config[0]} bend={config[1]} Pa")
    print(f"  anchored at {model.body(1).name!r}, free tip swung {swing:.4f} m in 1 s")


def mjx_spatial_tendon() -> None:
    """Route a tendon over a wrapping geom and through a pulley, and run it in MJX."""
    model = mujoco.MjModel.from_xml_string(HOIST)
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)

    model_mjx = mjx.put_model(model)
    data_mjx = mjx.put_data(model, data)
    step_mjx = jax.jit(mjx.step)
    for _ in range(200):
        data_mjx = step_mjx(model_mjx, data_mjx)
        mujoco.mj_step(model, data)

    # The tendon Jacobian row is how much rope a unit of load motion pays out: the
    # direct strand contributes 1, the divisor=2 branch contributes 1/2, and the
    # rope tension needed to hold the load is its weight divided by that ratio.
    # ten_J is stored sparse (nJten,) with its structure on mjModel, so it has to
    # be densified before it can be indexed by dof.
    ten_J = np.zeros((model.ntendon, model.nv))
    mujoco.mju_sparse2dense(
        ten_J, data.ten_J, model.ten_J_rownnz, model.ten_J_rowadr, model.ten_J_colind
    )
    load_z = model.body("load").dofadr[0] + 2
    ratio = abs(ten_J[model.tendon("hoist").id, load_z])
    weight = model.body_mass[model.body("load").id] * abs(model.opt.gravity[2])

    # MJX supports the full spatial tendon path: sphere/cylinder wrapping with a
    # sidesite, plus pulley branches that split the path into scaled strands.
    print("mjx spatial tendon (cylinder wrap + pulley branch), rope taut at its limit:")
    print(f"  length {float(data_mjx.ten_length[0]):.6f} m (mujoco {data.ten_length[0]:.6f})")
    print(f"  path entries {model.tendon_num[0]}, length limit {model.tendon_range[0]}")
    print(f"  d(length)/dz {ratio:.3f}: {weight:.2f} N of load, {weight / ratio:.2f} N of tension")
    print(f"  load hangs at z {float(data_mjx.qpos[2]):.4f} m (mujoco {data.qpos[2]:.4f})")


def mjx_tendon_sensors() -> None:
    """Measure tendon length and velocity in MJX with TENDONPOS / TENDONVEL sensors."""
    model = mujoco.MjModel.from_xml_string(COUPLED_FINGER)
    data = mujoco.MjData(model)
    data.ctrl[0] = 1.0
    mujoco.mj_forward(model, data)

    model_mjx = mjx.put_model(model)
    data_mjx = mjx.put_data(model, data)
    step_mjx = jax.jit(mjx.step)
    for _ in range(200):
        data_mjx = step_mjx(model_mjx, data_mjx)
        mujoco.mj_step(model, data)

    # The spring pulls 2*mcp - pip to zero, so tendonpos reads how far the coupling
    # is from its nominal 2:1 ratio and tendonvel reads how fast that error changes.
    sensordata = np.asarray(data_mjx.sensordata)
    mcp, pip = float(data_mjx.qpos[0]), float(data_mjx.qpos[1])
    print("mjx tendon sensors on a spring-coupled 2:1 finger:")
    print(f"  tendonpos {sensordata[0]:+.6f} rad (mujoco {data.sensordata[0]:+.6f})")
    print(f"  tendonvel {sensordata[1]:+.6f} rad/s (mujoco {data.sensordata[1]:+.6f})")
    print(f"  mcp {mcp:.4f}, pip {pip:.4f} rad -> ratio {pip / mcp:.3f} (nominal 2)")


def mjx_mocap_paddle() -> None:
    """Drive a mocap body along a scripted path inside a jitted MJX rollout."""
    model = mujoco.MjModel.from_xml_string(PADDLE)
    model_mjx = mjx.put_model(model)
    data_mjx = mjx.make_data(model_mjx)
    step_mjx = jax.jit(mjx.step)

    # mocap_pos/mocap_quat are read by MJX kinematics, so scripted or teleoperated
    # bodies work the same way they do in MuJoCo: write the field, then step.
    for i in range(250):
        pos_World_Paddle = jp.array([[-0.4 + 0.004 * i, 0.0, 0.06]])
        data_mjx = data_mjx.replace(mocap_pos=pos_World_Paddle)
        data_mjx = step_mjx(model_mjx, data_mjx)

    paddle_x = float(data_mjx.mocap_pos[0, 0])
    print("mjx mocap kinematics:")
    print(f"  paddle x {paddle_x:.3f} m, ball pushed to x {float(data_mjx.qpos[0]):.3f} m")
    print(f"  paddle body xpos {np.asarray(data_mjx.xpos[model.body('paddle').id])}")


def main() -> None:
    flex_elasticity()
    activate_plugin()
    mjx_spatial_tendon()
    mjx_tendon_sensors()
    mjx_mocap_paddle()


if __name__ == "__main__":
    main()
