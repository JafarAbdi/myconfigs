# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.2.7 (Jan 14, 2025)."""

import os
import time

import mujoco
import numpy as np
from mujoco import rollout

CARTPOLE = """
<mujoco model="cartpole">
  <option timestep=".002"/>
  <worldbody>
    <geom name="rail" type="capsule" fromto="-1 0 1 1 0 1" size=".02"
          contype="0" conaffinity="0"/>
    <body name="cart" pos="0 0 1">
      <joint name="slider" type="slide" axis="1 0 0" range="-1 1" damping=".1"/>
      <geom type="box" size=".1 .05 .05" mass="1"/>
      <body name="pole">
        <joint name="hinge" type="hinge" axis="0 1 0" damping=".01"/>
        <geom type="capsule" fromto="0 0 0 0 0 .6" size=".02" mass=".1"/>
        <site name="tip" pos="0 0 .6"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <motor name="slide" joint="slider" gear="10" ctrlrange="-1 1"/>
  </actuator>
  <sensor>
    <framepos name="tip" objtype="site" objname="tip"/>
  </sensor>
</mujoco>
"""

ARM = """
<mujoco model="arm">
  <compiler autolimits="true"/>
  <worldbody>
    <body name="upper" pos="0 0 1">
      <joint name="shoulder" axis="0 1 0"/>
      <geom type="capsule" fromto="0 0 0 .3 0 0" size=".04" density="900"/>
      <body name="fore" pos=".3 0 0">
        <joint name="elbow" axis="0 1 0"/>
        <geom type="capsule" fromto="0 0 0 .25 0 0" size=".03" density="900"/>
        <body name="hand" pos=".25 0 0">
          <joint name="wrist" axis="0 1 0"/>
          <geom type="box" size=".04 .02 .02" density="900"/>
          <site name="tcp" pos=".04 0 0"/>
        </body>
      </body>
    </body>
  </worldbody>
</mujoco>
"""


def rollout_threaded() -> None:
    """Score a batch of candidate control sequences on a reusable pool of worker threads."""
    model = mujoco.MjModel.from_xml_string(CARTPOLE)
    nbatch, nstep = 512, 300
    nthread = min(8, os.cpu_count() or 1)

    # Start from hanging-down, the classic swing-up problem.
    data = mujoco.MjData(model)
    data.qpos[1] = np.pi
    mujoco.mj_forward(model, data)
    nstate = mujoco.mj_stateSize(model, mujoco.mjtState.mjSTATE_FULLPHYSICS)
    state_initial = np.empty(nstate)
    mujoco.mj_getState(model, data, state_initial, mujoco.mjtState.mjSTATE_FULLPHYSICS)

    rng = np.random.default_rng(0)
    control = rng.uniform(-1.0, 1.0, (nbatch, nstep, model.nu))

    # rollout parallelizes over the batch as soon as it is handed a sequence of
    # nthread MjData; the Rollout object owns the pool so it survives across calls.
    # Before 3.2.7 the caller had to shard the batch over a ThreadPoolExecutor.
    data_pool = [mujoco.MjData(model) for _ in range(nthread)]
    with rollout.Rollout(nthread=nthread) as pool:
        start = time.perf_counter()
        state_batch, sensordata = pool.rollout(
            model,
            data_pool,
            state_initial,  # singleton: tiled over the batch
            control,
            chunk_size=nbatch // (nthread * 10),
        )
        threaded = time.perf_counter() - start

        # Second call on the same pool: no thread creation cost.
        best = np.argmax(sensordata[:, -1, 2])
        state_best, _ = pool.rollout(
            model, data_pool, state_initial, control[best : best + 1]
        )

    with rollout.Rollout(nthread=0) as serial_pool:
        start = time.perf_counter()
        serial_pool.rollout(model, mujoco.MjData(model), state_initial, control)
        serial = time.perf_counter() - start

    tip_height = sensordata[:, -1, 2]
    print(f"rollout: {nbatch} x {nstep} steps, state {state_batch.shape}")
    print(f"  {nthread} threads {threaded * 1e3:.0f} ms vs serial {serial * 1e3:.0f} ms")
    print(f"  best candidate {best}, tip height {tip_height[best]:.3f} m")
    print(f"  replayed alone -> final [cart, pole] {state_best[0, -1, 1:3]}")


def inverse_inertia_at_site() -> None:
    """Get the 3x3 inverse inertia felt at a point, the half-solve the dual solvers use."""
    model = mujoco.MjModel.from_xml_string(ARM)
    data = mujoco.MjData(model)
    data.qpos[:] = [0.3, -0.6, 0.2]
    mujoco.mj_forward(model, data)  # factorizes M into qLD / qLDiagInv

    nv = model.nv
    jacp_World_Tcp = np.zeros((3, nv))
    jacr_World_Tcp = np.zeros((3, nv))
    mujoco.mj_jacSite(model, data, jacp_World_Tcp, jacr_World_Tcp, model.site("tcp").id)

    # 3.2.7 removed mjData.qLDiagSqrtInv: sqrt(1/D) is now a caller argument,
    # computed on demand from qLDiagInv.
    sqrt_inv_d = np.sqrt(data.qLDiagInv)
    half = np.zeros((3, nv))
    mujoco.mj_solveM2(model, data, half, jacp_World_Tcp, sqrt_inv_d)

    # x = sqrt(D^-1) (L^T)^-1 J^T, so x x^T = J M^-1 J^T with half the work
    # and a factorization that stays symmetric positive definite.
    inv_inertia = half @ half.T

    full = np.zeros((3, nv))
    mujoco.mj_solveM(model, data, full, jacp_World_Tcp)
    residual = np.abs(inv_inertia - jacp_World_Tcp @ full.T).max()

    print("mj_solveM2 at site tcp:")
    # The arm is planar (three hinges about y), so the y row of the tip inverse
    # inertia is exactly zero: no joint can move the tip sideways.
    print(f"  inverse inertia diag {np.diag(inv_inertia)}")
    print(f"  effective mass along x {1 / inv_inertia[0, 0]:.3f} kg")
    print(f"  max deviation from mj_solveM {residual:.2e}")
    print(f"  qLDiagSqrtInv still on MjData: {hasattr(data, 'qLDiagSqrtInv')}")


def main() -> None:
    rollout_threaded()
    inverse_inertia_at_site()


if __name__ == "__main__":
    main()
