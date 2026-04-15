---
name: mujoco
description: MuJoCo project utilities — frame utilities, body/geom tree traversal, model introspection, actuator factories, actuator physics, color utilities, interpolation, and finite-difference derivatives. Use when writing MuJoCo, mink, mjlab, or MJX code, or when working with Jacobians, robot simulation, or MjSpec models.
---

# MuJoCo Project Utilities

Extracted from mink, mjlab, mujoco, and mujoco\_mpc. Use these patterns and utilities when writing MuJoCo-related code.

## Table of Contents

1. MuJoCo Frame Utilities
2. Body / Geom Tree Traversal
3. Model Introspection & Configuration
4. Actuator Factories (MjSpec)
5. Actuator Physics
6. Color Utilities
7. Interpolation
8. Finite-Difference Derivatives
9. C++ Utilities (commented, for porting)
10. Loading Model Without Meshes

---

## 1. MuJoCo Frame Utilities

Sources: `mink/src/mink/constants.py`, `mink/src/mink/utils.py`

```python
SUPPORTED_FRAMES = ("body", "geom", "site")

FRAME_TO_ENUM = {
    "body": mujoco.mjtObj.mjOBJ_BODY,
    "geom": mujoco.mjtObj.mjOBJ_GEOM,
    "site": mujoco.mjtObj.mjOBJ_SITE,
}
FRAME_TO_JAC_FUNC = {
    "body": mujoco.mj_jacBody,
    "geom": mujoco.mj_jacGeom,
    "site": mujoco.mj_jacSite,
}
FRAME_TO_POS_ATTR = {"body": "xpos", "geom": "geom_xpos", "site": "site_xpos"}
FRAME_TO_XMAT_ATTR = {"body": "xmat", "geom": "geom_xmat", "site": "site_xmat"}

def dof_width(joint_type: int) -> int:
    """Velocity-space dimension for a joint type."""
    return {mjJNT_FREE: 6, mjJNT_BALL: 3, mjJNT_SLIDE: 1, mjJNT_HINGE: 1}[joint_type]

def qpos_width(joint_type: int) -> int:
    """Configuration-space dimension for a joint type."""
    return {mjJNT_FREE: 7, mjJNT_BALL: 4, mjJNT_SLIDE: 1, mjJNT_HINGE: 1}[joint_type]

def move_mocap_to_frame(model, data, mocap_name, frame_name, frame_type):
    """Set a mocap body's pose to match a named frame (body/geom/site)."""
    mocap_id = model.body(mocap_name).mocapid[0]
    obj_id = mujoco.mj_name2id(model, FRAME_TO_ENUM[frame_type], frame_name)
    xpos = getattr(data, FRAME_TO_POS_ATTR[frame_type])[obj_id]
    xmat = getattr(data, FRAME_TO_XMAT_ATTR[frame_type])[obj_id]
    data.mocap_pos[mocap_id] = xpos.copy()
    mujoco.mju_mat2Quat(data.mocap_quat[mocap_id], xmat)

def get_frame_jacobian(model, data, frame_name, frame_type):
    """Get translational and rotational Jacobians for a named frame."""
    obj_id = mujoco.mj_name2id(model, FRAME_TO_ENUM[frame_type], frame_name)
    jacp = np.zeros((3, model.nv))
    jacr = np.zeros((3, model.nv))
    FRAME_TO_JAC_FUNC[frame_type](model, data, jacp, jacr, obj_id)
    return jacp, jacr
```

---

## 2. Body / Geom Tree Traversal

Source: `mink/src/mink/utils.py`

```python
def get_freejoint_dims(model) -> tuple[list[int], list[int]]:
    """Get all floating-joint q and v indices."""
    q_ids, v_ids = [], []
    for j in range(model.njnt):
        if model.jnt_type[j] == mujoco.mjtJoint.mjJNT_FREE:
            qa = model.jnt_qposadr[j]
            va = model.jnt_dofadr[j]
            q_ids.extend(range(qa, qa + 7))
            v_ids.extend(range(va, va + 6))
    return q_ids, v_ids

def get_body_children(model, body_id: int) -> list[int]:
    """Immediate child body IDs."""
    return [i for i in range(model.nbody) if model.body_parentid[i] == body_id and i != body_id]

def get_subtree_body_ids(model, body_id: int) -> list[int]:
    """All body IDs in the subtree rooted at body_id (DFS)."""
    result, stack = [], [body_id]
    while stack:
        bid = stack.pop()
        result.append(bid)
        stack.extend(get_body_children(model, bid))
    return result

def get_body_geom_ids(model, body_id: int) -> list[int]:
    """Geom IDs directly attached to a body."""
    start = model.body_geomadr[body_id]
    return list(range(start, start + model.body_geomnum[body_id]))

def get_subtree_geom_ids(model, body_id: int) -> list[int]:
    """All geom IDs in the kinematic subtree rooted at body_id."""
    geom_ids, stack = [], [body_id]
    while stack:
        bid = stack.pop()
        geom_ids.extend(get_body_geom_ids(model, bid))
        stack.extend(get_body_children(model, bid))
    return geom_ids
```

---

## 3. Model Introspection & Configuration

Sources: `mink/src/mink/utils.py`, `mjlab/src/mjlab/utils/spec.py`

```python
def custom_configuration_vector(model, key_name=None, **kwargs) -> np.ndarray:
    """Create a qpos vector with specific joint values, rest from keyframe or qpos0.
    Example: q = custom_configuration_vector(model, shoulder=0.5, elbow=-1.2)
    """
    ...

def get_free_joint(spec: mujoco.MjSpec) -> mujoco.MjsJoint | None: ...
def get_non_free_joints(spec: mujoco.MjSpec) -> tuple[mujoco.MjsJoint, ...]: ...

def disable_collision(geom: mujoco.MjsGeom) -> None:
    geom.contype = 0
    geom.conaffinity = 0

def is_joint_limited(jnt: mujoco.MjsJoint) -> bool:
    match jnt.limited:
        case mujoco.mjtLimited.mjLIMITED_TRUE: return True
        case mujoco.mjtLimited.mjLIMITED_AUTO: return jnt.range[0] < jnt.range[1]
        case _: return False
```

### Joint Index Patterns

```python
joint_indices = [model.joint(name).id for name in JOINT_NAMES]
qpos_indices = model.jnt_qposadr[joint_indices]
qvel_indices = model.jnt_dofadr[joint_indices]
qpos_range = model.jnt_range[joint_indices]
random_qpos = np.random.uniform(qpos_range[:, 0], qpos_range[:, 1])
```

### JointType (MJX)

```python
class JointType(enum.IntEnum):
    FREE = mujoco.mjtJoint.mjJNT_FREE    # qpos: (7,), dof: (6,)
    BALL = mujoco.mjtJoint.mjJNT_BALL     # qpos: (4,), dof: (3,)
    SLIDE = mujoco.mjtJoint.mjJNT_SLIDE   # qpos: (1,), dof: (1,)
    HINGE = mujoco.mjtJoint.mjJNT_HINGE   # qpos: (1,), dof: (1,)
```

### Rendering Flags

```python
viewer.user_scn.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = False
viewer.user_scn.flags[mujoco.mjtRndFlag.mjRND_REFLECTION] = False
```

---

## 4. Actuator Factories (MjSpec)

Source: `mjlab/src/mjlab/utils/spec.py`

```python
class TransmissionType(IntEnum):
    JOINT = 0
    TENDON = 1
    SITE = 2

def create_motor_actuator(spec, joint_name, *, effort_limit, gear=1.0,
                          armature=0.0, frictionloss=0.0,
                          transmission=TransmissionType.JOINT) -> mujoco.MjsActuator:
    """Force-controlled <motor> actuator."""
    act = spec.add_actuator(name=joint_name, target=joint_name)
    act.trntype = _TRANSMISSION_MAP[transmission]
    act.dyntype = mujoco.mjtDyn.mjDYN_NONE
    act.gaintype = mujoco.mjtGain.mjGAIN_FIXED
    act.biastype = mujoco.mjtBias.mjBIAS_NONE
    act.gear[0] = gear
    act.forcelimited = True
    act.forcerange[:] = [-effort_limit, effort_limit]
    act.ctrllimited = True
    act.ctrlrange[:] = [-effort_limit, effort_limit]
    return act

def create_position_actuator(spec, joint_name, *, stiffness, damping,
                             effort_limit=None, armature=0.0, frictionloss=0.0,
                             transmission=TransmissionType.JOINT) -> mujoco.MjsActuator:
    """PD <position> actuator. ctrllimited=False so setpoints can exceed joint limits."""
    act = spec.add_actuator(name=joint_name, target=joint_name)
    act.gaintype = mujoco.mjtGain.mjGAIN_FIXED
    act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
    act.gainprm[0] = stiffness
    act.biasprm[1] = -stiffness
    act.biasprm[2] = -damping
    act.ctrllimited = False
    if effort_limit is not None:
        act.forcelimited = True
        act.forcerange[:] = [-effort_limit, effort_limit]
    return act

def create_velocity_actuator(spec, joint_name, *, damping, effort_limit=None,
                             armature=0.0, frictionloss=0.0, inheritrange=1.0,
                             transmission=TransmissionType.JOINT) -> mujoco.MjsActuator:
    """<velocity> actuator."""
    act = spec.add_actuator(name=joint_name, target=joint_name)
    act.gaintype = mujoco.mjtGain.mjGAIN_FIXED
    act.biastype = mujoco.mjtBias.mjBIAS_AFFINE
    act.inheritrange = inheritrange
    act.ctrllimited = True
    act.gainprm[0] = damping
    act.biasprm[2] = -damping
    if effort_limit is not None:
        act.forcelimited = True
        act.forcerange[:] = [-effort_limit, effort_limit]
    return act
```

---

## 5. Actuator Physics

Source: `mjlab/src/mjlab/utils/actuator.py`

```python
def reflected_inertia(rotor_inertia: float, gear_ratio: float) -> float:
    """I_rotor * N^2"""
    return rotor_inertia * gear_ratio**2

def reflected_inertia_two_stage(rotor_inertia: tuple[float, float, float],
                                 gear_ratio: tuple[float, float, float]) -> float:
    """Two-stage planetary gearbox reflected inertia."""
    return (
        rotor_inertia[0] * (gear_ratio[1] * gear_ratio[2]) ** 2
        + rotor_inertia[1] * gear_ratio[2] ** 2
        + rotor_inertia[2]
    )

def rpm_to_rad(rpm: float) -> float:
    return rpm * 2.0 * math.pi / 60.0

class LinearJointProperties(NamedTuple):
    armature: float      # kg
    velocity_limit: float  # m/s
    effort_limit: float    # N

def reflect_rotary_to_linear(armature_rotary, velocity_limit_rotary,
                              effort_limit_rotary, transmission_ratio) -> LinearJointProperties:
    """Convert rotary motor specs to linear joint properties via transmission ratio [m/rad]."""
    return LinearJointProperties(
        armature=armature_rotary / transmission_ratio**2,
        velocity_limit=velocity_limit_rotary * transmission_ratio,
        effort_limit=effort_limit_rotary / transmission_ratio,
    )
```

---

## 6. Color Utilities

Source: `mjlab/src/mjlab/utils/color.py`

```python
class RGB(NamedTuple): r: float; g: float; b: float
class RGBA(NamedTuple): r: float; g: float; b: float; a: float
class HSV(NamedTuple): h: float; s: float; v: float

def rgb_to_hsv(rgb) -> HSV: ...
def hsv_to_rgb(hsv: HSV) -> tuple[float, float, float]: ...
def darken_rgba(rgba, factor=0.85) -> tuple[float, float, float, float]: ...
def lighten_rgba(rgba, factor=0.15) -> tuple[float, float, float, float]: ...
def adjust_saturation(rgb, factor) -> tuple[float, float, float]: ...
```

---

## 7. Interpolation

Source: `mujoco_mpc/mjpc/utilities.h` (ported to Python)

```python
def linear_range(t0, t_step, n) -> np.ndarray:
    return t0 + np.arange(n) * t_step

def find_interval(sequence, value) -> tuple[int, int]:
    """Find bounding indices in a sorted sequence. Clamps to valid range."""
    upper = int(np.searchsorted(sequence, value, side="right"))
    lower = upper - 1
    n = len(sequence)
    if lower < 0: return 0, 0
    if lower >= n: return n - 1, n - 1
    return max(lower, 0), min(upper, n - 1)

def zero_order_hold(x, xs, ys) -> np.ndarray: ...
def linear_interpolation(x, xs, ys) -> np.ndarray: ...
def cubic_interpolation(x, xs, ys) -> np.ndarray:
    """Catmull-Rom style cubic interpolation."""
    ...
```

---

## 8. Finite-Difference Derivatives

Source: `mujoco_mpc/mjpc/utilities.h` (ported to Python)

```python
def finite_difference_gradient(func, x, epsilon=1e-5) -> np.ndarray:
    """Central finite-difference gradient of a scalar function."""
    grad = np.empty_like(x)
    x_work = x.copy()
    for i in range(len(x)):
        x_work[i] = x[i] + epsilon
        fp = func(x_work)
        x_work[i] = x[i] - epsilon
        fm = func(x_work)
        grad[i] = (fp - fm) / (2.0 * epsilon)
        x_work[i] = x[i]
    return grad

def finite_difference_jacobian(func, x, epsilon=1e-5) -> np.ndarray:
    """Central finite-difference Jacobian. Returns (output_dim, input_dim)."""
    f0 = func(x)
    jac = np.empty((len(f0), len(x)))
    x_work = x.copy()
    for i in range(len(x)):
        x_work[i] = x[i] + epsilon
        fp = func(x_work)
        x_work[i] = x[i] - epsilon
        fm = func(x_work)
        jac[:, i] = (fp - fm) / (2.0 * epsilon)
        x_work[i] = x[i]
    return jac
```

---

## 9. C++ Utilities (for porting reference)

From `mujoco_mpc/mjpc/utilities.h`:

| Utility | Description | Use Case |
|---------|-------------|----------|
| `UniqueMjData/Model` | RAII smart pointers | Safe C++ resource management |
| `MakeDifferentiable` | Set `solimp[0]=0` for smooth gradients | Differentiable simulation |
| `SetState/GetState` | Pack qpos, qvel, act into flat vector | State serialization |
| `Ground(m, d, pos)` | Height of nearest geom below point | Terrain-aware control |
| `ProjectToSegment` | Point-to-segment projection | Geometry queries |
| `FootFrame` | Ground-aligned frame from 4 foot positions | Quadruped control |
| `Hull2D / NearestInHull` | 2D convex hull + nearest point | Support polygon / ZMP |
| `NormType + Norm()` | Cost norms with gradient/Hessian | Custom cost functions |
| `FiniteDifferenceHessian` | Class-based FD Hessian computation | Optimization |
| `SetBlockInMatrix / AddBlockInMatrix` | Block matrix assembly | QP Hessian construction |
| `SetBlockInBand / DenseToBlockBand` | Band matrix operations | Trajectory optimization |
| `Determinant3 / Inverse3 / Trace` | 3x3 matrix utilities | Low-level math |
| `PrincipalEigenVector4` | QUEST algorithm for 4x4 eigenvector | Quaternion estimation (Wahba) |
| `LogScale` | Log-spaced values | Line-search step sizes |

---

## 10. Loading Model Without Meshes

Source: Build MuJoCo model using MjSpec API with mesh/geom loading disabled for faster loading.

```python
def _get_model(model_path: pathlib.Path) -> mujoco.MjModel:
    spec = mujoco.MjSpec.from_file(str(model_path))
    while spec.meshes:
        spec.delete(spec.meshes[-1])
    while spec.geoms:
        spec.delete(spec.geoms[-1])
    return spec.compile()
```

Key points:
- Load spec from file, then delete meshes and geoms to skip rendering overhead
- Use `spec.delete()` to remove elements from the spec
- Useful when you only need the kinematic/dynamic model for computation

## 11. MuJoCo Jacobian Conventions

### MuJoCo (LOCAL\_WORLD\_ALIGNED)

- P is the origin of the moving frame (e.g., site position)
- Velocities are projected in the basis of the world frame
- `jacp` (3 x nv): linear velocity of point P in world frame
- `jacr` (3 x nv): angular velocity of the body in world frame

### Pinocchio Reference Frames

```
WORLD = 0              — P coincides with world origin, projected in world basis
LOCAL = 1              — P is moving frame origin, projected in moving frame basis
LOCAL_WORLD_ALIGNED = 2 — P is moving frame origin, projected in world basis (= MuJoCo convention)
```

### MuJoCo vs Drake Jacobian Notation

**Drake (Monogram Notation):** Explicit frame specification — `Jq_p_PQ_E` = Position Jacobian of Q from P, expressed in frame E, w.r.t. q

| MuJoCo Function | Drake Equivalent |
|-----------------|-----------------|
| `mj_jac(point, body)` | `Jv_v_WQ_W` (point Q on body, in world) |
| `mj_jacBody(body)` | `Jv_v_WBo_W` (body origin) |
| `mj_jacBodyCom(body)` | `Jv_v_WBcm_W` (body center of mass) |
| `mj_jacSite(site)` | `Jv_v_WS_W` (site frame origin) |
| `mj_jacDot(point, body)` | `d/dt[Jv_v_WQ]_W` (time derivative) |

**Key distinction — q̇ vs v:** For systems with quaternions, `dim(q) = nq > nv = dim(v)`. MuJoCo always uses v-space (3×nv or 6×nv). Drake explicitly distinguishes `JacobianWrtVariable::kQDot` vs `kV`.

### Constraint Jacobian

```
M · v̇ + c = τ + Jᵀ · f

J  maps: joint velocity   → constraint velocity  (J · v)
Jᵀ maps: constraint force → joint force          (Jᵀ · f)

mjData.efc_J       — constraint Jacobian (nc × nv)
mj_mulJacVec()     — computes J · v
mj_mulJacTVec()    — computes Jᵀ · f
```
