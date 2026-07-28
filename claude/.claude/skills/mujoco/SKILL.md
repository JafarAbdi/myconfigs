---
name: mujoco
description: MuJoCo project utilities — frame utilities, body/geom tree traversal, MJCF asset/mesh extraction, model introspection, actuator factories, actuator physics, color utilities, interpolation, finite-difference derivatives, and runtime model modification (mjModel field edits vs MjSpec). Use when writing MuJoCo, mink, mjlab, or MJX code, when working with Jacobians, robot simulation, MjSpec models, MJCF assets, or runtime parameter edits (mass, gains, poses).
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
11. MuJoCo Jacobian Conventions
12. Runtime Model Modification (mjModel field edit vs MjSpec)
13. Reducing a Model to a Gravity-Only Model (inertials only)
14. MJCF Asset, Geometry, and Mesh Extraction Patterns
15. Versions

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
- This is a *structural* edit (the `MjSpec` side); for changing parameter
  *values* at runtime (mass, gains, poses) see §12

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

---

## 12. Runtime Model Modification (mjModel field edit vs MjSpec)

Two ways to change a compiled model; choose by *what* changes:

- **Value change** (a real-valued parameter: mass, gain, pose offset) → edit the
  `mjModel` field in place, then call `mj_setConst(m, d)` if the field requires
  it. The fast path.
- **Structural change** (counts, topology, add/remove bodies, geom sizes) → edit
  the `MjSpec` and recompile (`spec.compile()`, or `mj_recompile` which preserves
  sim state). The docs call this the *safe and recommended* way; runtime field
  edits exist mainly for **speed**.

`mj_setConst(m, d)` is the final compilation step: it propagates a few
real-valued fields to their derived fields (e.g. `body_mass` →
`body_subtreemass`, `dof_M0`, `dof_invweight0`). Several edits below are only
safe when followed by it.

### Modifiability quick reference

| Field(s) | Runtime modifiability |
|---|---|
| `body_mass`, `body_inertia`, `body_ipos`, `body_iquat`, `qpos0`, `qpos_spring`, `dof_armature`, `eq_data`, `hfield_size` | Safe **with `mj_setConst`** |
| `body_pos`, `body_quat` | Safe with `mj_setConst`; unsafe for static bodies (invalidates BVH) |
| `body_gravcomp` | Safe (`mj_setConst` only if count goes 0→nonzero) |
| `{site,cam,light}_{pos,quat}` | Mostly safe (`mj_setConst` for tracking/targeting cams) |
| `tendon_stiffness/damping`, `actuator_gainprm/biasprm` | Mostly safe (`mj_setConst` for to/from-zero, or position `dampratio`) |
| `tex_data`, `hfield_data`, visual `mesh_vert…` | Safe, but need GPU re-upload (`mjr_uploadTexture` / `mjr_uploadHField` / `mjr_uploadMesh`) |
| `geom_pos/quat/size/rbound/aabb`, colliding `mesh_vert…`, `bvh_aabb` | Unsafe |
| structural integers (counts, `*_adr`, `*_num`, `*_type`) | Unsafe → use `MjSpec` + `mj_recompile` |

General rule: real-valued parameters are usually safe; structural integer
parameters are not (wrong sizes/indexing → segfault or silent corruption).
Persist runtime edits with `mj_saveLastXML` / `mj_copyBack` (real-valued only)
or `mj_saveModel` (MJB, complete).

### body_mass value edit (fast path)

```python
# Perturb masses without recompiling the MJCF. mj_setConst propagates the
# change to body_subtreemass / dof_M0; the result then matches a full MjSpec
# recompile with these masses to ~1e-15.
model.body_mass[body_id] = new_mass
mujoco.mj_setConst(model, data)
mujoco.mj_forward(model, data)   # qfrc_bias etc. now reflect the new mass
```

For structural reduction (stripping geoms/meshes) see §10 — the `MjSpec` side of
the same coin.

Docs (mujoco.readthedocs.io, stable):
- Simulation, section "mjModel changes": https://mujoco.readthedocs.io/en/stable/programming/simulation.html
- Model Editing → In-place recompilation: https://mujoco.readthedocs.io/en/stable/programming/modeledit.html#in-place-recompilation
- `mj_setConst` API: https://mujoco.readthedocs.io/en/stable/APIreference/APIfunctions.html#mj-setconst

---

## 13. Reducing a Model to a Gravity-Only Model (inertials only)

Script: `scripts/reduce_model.py`

Strips a robot MJCF down to its body tree and explicit inertials, deleting every
massless element (geoms, meshes, materials, textures, sites, cameras, lights,
sensors, actuators, tendons, equalities, contacts, plugins, keyframes). The
result carries only mass, so `qfrc_bias` at zero velocity (the gravity hold
torque) is preserved exactly: it depends only on configuration, mass, and
inertials, none of which are touched.

```python
def reduced_spec(model_xml_path: pathlib.Path) -> mujoco.MjSpec:
    """Body tree + explicit inertials only; geometry and assets removed."""

def reduced_xml(model_xml_path: pathlib.Path) -> str:
    """Self-contained, mesh-free XML string; compiles with no mesh files on disk."""
```

Precondition: every body must already carry an explicit `<inertial>`. That is
what preserves the masses; compiled or exported MJCF satisfies it. If a body
instead relied on geom-inferred inertia, deleting its geoms removes its only
mass source: a body with a joint then fails to compile (the moving-body mass
check), and a static body silently drops to zero mass, lowering its parent's
subtree mass.

`inertiafromgeom` controls geom-to-inertia inference, so it only matters while
geoms are present. Once they are deleted there is nothing left to infer from,
and `mjINERTIAFROMGEOM_FALSE` is identical to the `auto` default; it neither
preserves mass nor catches a missing inertial.

---

## 14. MJCF Asset, Geometry, and Mesh Extraction Patterns

Sources: user-provided MJCF logging utility (MuJoCo parts only) and MuJoCo
docs: `modeling.rst` "Kinematic tree" / "Coordinate frames" / "Frame
orientations", `XMLreference.rst` `option/gravity`, `compiler/coordinate`,
`compiler/angle`, `compiler/eulerseq`, `compiler/discardvisual`,
`(world)body`, `geom`, `material`, and `programming/simulation.rst`
"Coordinate frames".

### IDs, names, and visual/collision geoms

MuJoCo uses `-1` as the sentinel for "no referenced object" for material,
texture, mesh, and similar IDs. Convert scalar fields with `.item()` when you
need plain Python integers.

```python
MJCF_NO_ID = -1
VISUAL_CONTYPE = 0
VISUAL_CONAFFINITY = 0
COLLISION_GROUP = 3


def body_name(body) -> str:
    return body.name if body.name else f"body_{body.id}"


def geom_name(geom) -> str:
    return geom.name if geom.name else f"geom_{geom.id}"


def is_visual_geom(geom) -> bool:
    return (
        geom.contype.item() == VISUAL_CONTYPE
        and geom.conaffinity.item() == VISUAL_CONAFFINITY
        and geom.group.item() != COLLISION_GROUP
    )
```

MuJoCo's compiler-level visual-geom criterion is `contype=0` and
`conaffinity=0`: `compiler/discardvisual` discards those geoms as purely visual
when they are not referenced elsewhere, preserving dynamics by adding explicit
inertials if needed.

Menagerie-style MJCF commonly also places collision geoms in group 3. Treat
`group=3` as a Menagerie convention, not a MuJoCo collision rule. In MuJoCo,
`geom.group` affects inertia inference at compile time and visualizer group
visibility at runtime; groups 0, 1, and 2 are visible by default, higher groups
are hidden by default.

`contype` and `conaffinity` are 32-bit contact-filter bitmasks. Two geoms can
collide when either geom's `contype` shares a set bit with the other's
`conaffinity`.

```python
def build_body_geoms(model: mujoco.MjModel) -> dict[int, tuple[list, list]]:
    visual: dict[int, list] = {body_id: [] for body_id in range(model.nbody)}
    collision: dict[int, list] = {body_id: [] for body_id in range(model.nbody)}

    for geom_id in range(model.ngeom):
        geom = model.geom(geom_id)
        body_id = geom.bodyid.item()
        if is_visual_geom(geom):
            visual[body_id].append(geom)
        else:
            collision[body_id].append(geom)

    return {
        body_id: (visual[body_id], collision[body_id])
        for body_id in range(model.nbody)
    }
```

### Geom pose and size conventions

`geom.pos` / `geom.quat` are the geom pose in its parent body frame. Body world
poses live in `data.xpos[body_id]` and `data.xquat[body_id]` after `mj_forward`.

Planes are infinite for collision, can only attach to the world body or static
children of the world, and are normal to local +Z. The default plane pose makes
a ground plane at world Z=0 with +Z as empty space. The first two `size` values
only control finite rendering size; zeros render an infinite plane.

Height-field geoms also attach only to the world body or static children of the
world. Mesh geom size comes from the mesh asset; `geom.size` is ignored for mesh
geoms.

| Geom type | `geom.size` convention |
|---|---|
| `mjGEOM_BOX` | `(half_x, half_y, half_z)` |
| `mjGEOM_SPHERE` | `(radius, _, _)` |
| `mjGEOM_ELLIPSOID` | `(radius_x, radius_y, radius_z)` |
| `mjGEOM_CAPSULE` | `(radius, half_length, _)` |
| `mjGEOM_CYLINDER` | `(radius, half_height, _)` |
| `mjGEOM_PLANE` | `(half_x, half_y, grid_spacing)` |
| `mjGEOM_MESH` | `geom.dataid` references `model.mesh(dataid)` |

### Materials, textures, and generated textures

A geom-local `rgba` value takes precedence over material color if it differs
from the internal default; remaining material properties still apply. Material
texture IDs are role-indexed; use `mjTEXROLE_RGB` for ordinary RGB textures.

```python
def get_geom_material(model: mujoco.MjModel, geom):
    mat_id = geom.matid.item()
    if mat_id == MJCF_NO_ID:
        return MJCF_NO_ID, MJCF_NO_ID, geom.rgba

    tex_id = model.mat_texid[mat_id, mujoco.mjtTextureRole.mjTEXROLE_RGB].item()
    return mat_id, tex_id, model.mat_rgba[mat_id]


def is_builtin_texture(model: mujoco.MjModel, tex_id: int) -> bool:
    if tex_id == MJCF_NO_ID:
        return False
    return model.tex_pathadr[tex_id].item() == MJCF_NO_ID
```

`tex_pathadr == -1` means the texture is MuJoCo-generated (`checker`,
`gradient`, `flat`), not file-backed. Generated checker textures need the same
UV convention as MuJoCo if you are exporting geometry to another renderer.

### Plane size and texture conventions

MuJoCo plane rendering uses:

- `geom.size[0]`, `geom.size[1]`: half extents for rendered plane geometry.
- `geom.size[2]`: grid spacing.
- zero half extents: derive the rendered plane extent from `model.stat.extent`.
- `model.mat_texrepeat[mat_id]`: texture repeats.
- `model.mat_texuniform[mat_id]`: repeats per spatial unit when true, across
  the whole plane when false.

For generated checker textures, MuJoCo's checker pattern contains a 2x2 square
pattern per UV tile. Its OpenGL-style plane UV generation is:

```python
CHECKER_TILES_PER_UV = 2
UV_CENTER_OFFSET = -0.5

# S = 0.5 * scale_x * x - 0.5
# T = -0.5 * scale_y * y - 0.5
```

Use standard `[0, texrepeat]` UVs for file textures such as PNGs; reserve the
checker-specific offset and divide-by-two behavior for generated checker
textures.

### Mesh extraction from compiled `MjModel`

MuJoCo stores mesh vertices, faces, normals, and texcoords in packed global
arrays with per-mesh address/count fields. Normals and texture coordinates are
per-face-corner, so exporters often need to "explode" a mesh: each face corner
gets its own output vertex.

```python
from einops import rearrange


def get_mesh_data(model: mujoco.MjModel, mesh_id: int):
    if mesh_id == MJCF_NO_ID:
        raise ValueError("Cannot extract mesh data for mesh_id=-1")
    if mesh_id >= model.nmesh:
        raise ValueError(f"Invalid mesh ID {mesh_id}; model has {model.nmesh} meshes")

    mesh = model.mesh(mesh_id)
    faceadr = mesh.faceadr.item()
    facenum = mesh.facenum.item()
    normaladr = model.mesh_normaladr[mesh_id]
    texcoordadr = mesh.texcoordadr.item()
    vertadr = mesh.vertadr.item()

    face_vert = model.mesh_face[faceadr : faceadr + facenum]
    face_norm = model.mesh_facenormal[faceadr : faceadr + facenum]

    vertices_by_corner = model.mesh_vert[vertadr + face_vert]
    normals_by_corner = model.mesh_normal[normaladr + face_norm]

    vertices = rearrange(vertices_by_corner, "face corner xyz -> (face corner) xyz")
    normals = rearrange(normals_by_corner, "face corner xyz -> (face corner) xyz")
    face_indices = np.arange(facenum * 3, dtype=np.int32)
    faces = rearrange(face_indices, "(face corner) -> face corner", corner=3)

    texcoords = None
    if texcoordadr != MJCF_NO_ID:
        face_tex = model.mesh_facetexcoord[faceadr : faceadr + facenum]
        texcoords_by_corner = model.mesh_texcoord[texcoordadr + face_tex]
        texcoords = rearrange(texcoords_by_corner, "face corner uv -> (face corner) uv")

    return vertices, faces, normals, texcoords
```

If the consumer can handle face-corner arrays directly, keep the
`vertices_by_corner` / `normals_by_corner` shape and avoid exploding until the
renderer or exporter boundary.

### MuJoCo world and frame conventions

MuJoCo spatial frames are right-handed. MJCF positions and orientations in the
kinematic tree are local: bodies are relative to their parent body; geoms,
joints, sites, cameras, and lights are relative to the containing body.
`compiler/coordinate="global"` is no longer supported.

The world body is body 0 and is automatically named `world`. It is the origin of
the world frame; it has no attributes, joints, or inertial child element, has
zero mass, and does not participate in mass computations.

The default world orientation is Z-up: `option.gravity` defaults to
`0 0 -9.81`, and the MuJoCo GUI is organized around this convention.

`mjData` fields prefixed with `x` are derived world/global-frame quantities.
Call `mj_resetData` and `mj_forward` before reading them from a fresh `MjData`.

- `data.xpos[body_id]`: body-frame origin position in the world frame.
- `data.xquat[body_id]`: body-frame orientation in the world frame.
- `data.geom_xpos[geom_id]`: geom-frame origin position in the world frame.
- `data.geom_xmat[geom_id]`: geom-frame orientation in the world frame.

MuJoCo stores quaternions scalar-first as `(w, x, y, z)` in `geom.quat`,
`body.quat`, `data.xquat`, `data.mocap_quat`, etc. MJCF `quat` defaults to
`1 0 0 0` and is normalized during compilation. When MuJoCo saves MJCF, all
frame orientations are written as quaternions.

MJCF `angle` defaults to degrees, while URDF is always radians; `mjModel` always
stores radians. `compiler/eulerseq` defaults to `xyz`; lowercase axes are
intrinsic, uppercase axes are extrinsic. URDF RPY corresponds to MJCF `XYZ`.

Copy MuJoCo arrays when buffering a trajectory; fields such as `data.xpos` and
`data.xquat` are mutable views updated by later steps.

---

## 15. Versions

Changelog: https://mujoco.readthedocs.io/en/stable/changelog.html

Worked examples of each release's features, pinned to the newest release and runnable:
`uv run --no-project ~/.claude/skills/mujoco/versions/<version>.py`. Every example runs
against the current MuJoCo, so anything a later release removed is already gone from here.

### 3.11.0 (July 27, 2026) — `versions/3.11.0.py`

- `surfacevel_conveyor` — Move a geom's surface without moving the geom: conveyors, treadmills and turntables.
- `adhesion_contacts` — Make contacts pull as well as push: tape, gecko feet, and -- combined with gap -- magnets.
- `implicitfast_gyroscopic` — Pick an integrator for free-flying bodies now that implicitfast handles gyroscopic terms.
- `body_simple_off` — Opt a body out of the simple-body mass matrix optimization to randomize its inertia.
- `setconst_sameframe` — Make a runtime site-pose edit actually take effect by recomputing site_sameframe.
- `gravcomp_fast_path_flags` — Toggle the gravcomp and surfacevel fast paths directly, instead of through ngravcomp.
- `mass_matrix_csr` — Read and use the joint-space inertia matrix now that only the CSR mjData.M remains.
- `inverse_fd_mass_jacobian` — Finite-difference the mass matrix alongside the inverse-dynamics Jacobians, in CSR.
- `orientation_servo` — Servo a ball joint or refsite to a full target orientation with one geodesic PD actuator.
- `actuator_control_blocks` — Slice mjData.ctrl and mjData.actuator_force per actuator now that the two can differ.
- `reset_ctrl` — Clear controls to neutral mid-episode without resetting the simulation state.
- `intvelocity_unclamped` — Let an intvelocity servo integrate past half a turn on a rotational transmission.
- `warmstart_zero_iterations` — Skip the constraint solve entirely on scenes that have settled.
- `self_attach` — Repeat a subtree inside one model with <attach>, no second file and no MjSpec code.
- `encode_model` — Serialize a spec or compiled model to any of MuJoCo's file formats through one call.

### 3.10.0 (June 22, 2026) — `versions/3.10.0.py`

- `threadpool` — Spread collision detection and per-island constraint solving over worker threads.
- `log_config` — Retarget MuJoCo's own error/warning/info stream and switch on per-topic tracing.
- `compile_warnings` — Inspect what the model compiler objected to, and fail a build on it if you want.
- `attach_conflict` — Decide what happens to clashing global options when a child spec is attached.
- `make_flex` — Build a deformable body procedurally, without emitting a <flexcomp> XML string.
- `make_flex_from_obj` — Load a 1D flex (rope, cable, suture) straight from OBJ line segments.
- `dense_inertia` — Get the joint-space inertia matrix as a dense array for your own linear algebra.

### 3.9.0 (May 27, 2026) — `versions/3.9.0.py`

- `exact_constraint_diagonal` — Fix soft or diverging constraints on models with anisotropic inertia or long chains.
- `compiler_timings` — Find out which asset is making model compilation slow.
- `margin_and_gap` — Detect near-contacts before they generate force, for adhesion or custom controllers.

### 3.8.1 (May 11, 2026) — `versions/3.8.1.py`

- `vfs_assets` — Feed in-memory assets to the compiler through a virtual file system.
- `spec_encode` — Serialize a spec through a registered encoder plugin, chosen by file extension.
- `dense_inertia_matrix` — Expand mjData.M (sparse CSR) into a dense inertia matrix for linear algebra.

### 3.8.0 (April 24, 2026) — `versions/3.8.0.py`

- `max_contacts_per_pair` — Ask the collider how many contacts a geom pair can ever produce, without simulating.
- `multiccd_by_default` — Recover the pre-3.8.0 single-point convex collisions by disabling multiccd.

### 3.7.0 (April 14, 2026) — `versions/3.7.0.py`

- `dcmotor_actuator` — Drive a joint from motor datasheet numbers instead of a hand-tuned torque source.
- `reflected_armature_and_damping` — Declare rotor inertia and viscous damping on the actuator and let gear^2 do the scaling.
- `polynomial_stiffness_and_damping` — Model progressive springs and quadratic (fluid) damping without a custom force callback.

### 3.6.0 (March 10, 2026) — `versions/3.6.0.py`

- `element_compiler_settings` — Resolve the compiler settings (meshdir, angle units, ...) that a spec element was authored under.
- `sparse_tendon_jacobian` — Map a tendon tension to joint torques through ten_J, which is now sparse with index arrays in mjModel.
- `flex_strain_equality` — Keep a fast trilinear/quadratic flex from stretching by constraining edge strain instead of edge length.
- `flex_sdf_collision` — Drape a flex over an analytic signed-distance geom instead of a mesh approximation of it.

### 3.5.0 (February 12, 2026) — `versions/3.5.0.py`

- `actuator_and_sensor_delays` — Give actuators command latency and sensors a slow sampling rate without hand-rolling ring buffers.
- `rangefinder_camera_scan` — Get a full range image out of the physics engine by attaching a rangefinder to a camera.
- `raycast_with_normals` — Sweep a planar lidar and get surface normals back from the same ray cast.
- `cloth_flexvert_equality` — Simulate cloth on a coarse mesh by constraining vertex positions rather than every edge length.
- `system_identification` — Fit physical parameters of a model to recorded sensor data with the sysid toolbox.
- `mjx_smooth_dynamics_fields` — Read transmission lengths and com-based motion axes straight off mjx.Data instead of recomputing them.

### 3.4.0 (December 5, 2025) — `versions/3.4.0.py`

- `sleeping_islands` — Let settled free bodies drop out of the pipeline so a scene full of passive props stays cheap.
- `kinematics_only_pipeline` — Refresh site poses and Jacobians for an IK iteration without paying for dynamics.
- `extract_state_components` — Pull a sub-state out of a serialized state vector without round-tripping it through mjData.
- `copy_state_between_data` — Checkpoint and restore an mjData for rollout-style planning without allocating state vectors.
- `tendon_path_wraps` — Walk a tendon's routing from Python to audit which sites, geoms and pulleys it passes through.
- `quadratic_flex_dof` — Simulate a deformable solid with curved deformation modes at a fraction of a full flex's dof count.

### 3.3.7 (October 13, 2025) — `versions/3.3.7.py`

- `spec_compiler_asset_dirs` — Give each spec its own mesh/texture search path so attached models keep resolving.
- `xml_dependencies` — List every asset file an MJCF pulls in, to package or preflight a model.

### 3.3.6 (September 15, 2025) — `versions/3.3.6.py`

- `constraint_islands` — Find which degrees of freedom are currently coupled by constraints.
- `disable_spring_and_damper` — Switch off joint/tendon springs and dampers independently to isolate passive forces.
- `forward_idempotence` — Warm-start the constraint solver explicitly now that mj_forward leaves state alone.
- `contact_sensor_subtree` — Report contacts between a whole kinematic subtree and an object as a fixed-size array.
- `mesh_default_material` — Give a mesh asset a fallback material instead of repeating it on every geom.
- `mjx_tendon_length` — Read tendon lengths straight off mjx.Data, without reaching into the private impl.

### 3.3.5 (August 8, 2025) — `versions/3.3.5.py`

- `contact_sensor` — Read contacts as a fixed-size array, so they can feed a policy or an env rule.
- `insidesite_sensor` — Trigger environment logic when an object enters a region of space.
- `tactile_sensor` — Measure per-taxel penetration depth and slip where a pad presses on an SDF geom.
- `builtin_meshes` — Generate mesh assets from parameters instead of shipping OBJ files with the model.

### 3.3.4 (July 8, 2025) — `versions/3.3.4.py`

- `spec_delete` — Remove a subtree from an MjSpec together with everything that references it.
- `spec_name_collisions` — Reject a duplicate element name where it is assigned, not at compile time.

### 3.3.3 (June 10, 2025) — `versions/3.3.3.py`

- `light_type` — Pick a light's kind from an enum instead of a boolean, in MJCF or on an MjSpec.
- `texture_colorspace` — Declare whether a texture's values are linear or sRGB so shading is not silently wrong.
- `mass_matrix` — Build the joint-space inertia matrix including tendon armature, and read its CSR layout.
- `fuse_static_bodies` — Collapse static bodies into their parent even in models that reference other elements.
- `flex_2d_elasticity` — Give a 2D flex membrane stretching and bending stiffness, without the old shell plugin.
- `mjx_tendon_armature` — Carry leadscrew/hydraulic inertia through a tendon on the MJX backend.

### 3.3.2 (April 28, 2025) — `versions/3.3.2.py`

- `mjx_inverse_dynamics` — Get the feedforward torque for a reference trajectory, batched on the MJX backend.
- `mjx_tendon_actuator_force_sensor` — Read the clamped total actuator force on a tendon from inside a jitted MJX rollout.

### 3.3.1 (Apr 9, 2025) — `versions/3.3.1.py`

- `spec_attach` — Graft a child MjSpec onto a parent at a frame or a site, with one call for both.
- `tendon_armature` — Model the reflected inertia of a leadscrew or hydraulic ram without extra dofs.
- `tendon_actuator_force_limits` — Clamp the total actuator force pulling on a tendon and read it back from a sensor.
- `save_inertial` — Bake compiled inertias into saved XML so a consumer reproduces them without the meshes.
- `composite_orientation` — Lay out a composite cable along an arbitrary direction, or inside a frame.
- `bind_unnamed_elements` — Read compiled model/data values for spec elements you never bothered to name.

### 3.3.0 (Feb 26, 2025) — `versions/3.3.0.py`

- `flexcomp_trilinear` — Simulate a deformable pad far cheaper by reducing it to 24 bounding-box dofs.
- `native_ccd` — A/B a model against both convex-collision pipelines when contacts change under 3.3.0.
- `energy_sensors` — Measure integrator energy drift without wiring up mjData.energy by hand.
- `spec_shallow_attach` — Keep editing a child spec through its own handle after attaching it to a parent.
- `mjx_tendon_wrapping` — Run spatial tendons that wrap around sphere and cylinder geoms on the MJX backend.

### 3.2.7 (Jan 14, 2025) — `versions/3.2.7.py`

- `rollout_threaded` — Score a batch of candidate control sequences on a reusable pool of worker threads.
- `inverse_inertia_at_site` — Get the 3x3 inverse inertia felt at a point, the half-solve the dual solvers use.

### 3.2.6 (Dec 2, 2024) — `versions/3.2.6.py`

- `bind_spec_to_model` — Reach mjModel/mjData fields through the MjSpec handle that created the element.
- `rollout_randomized_models` — Roll out one control sequence against a batch of perturbed models, one model per roll.
- `mjx_muscle_actuator` — Drive an MJX model with muscles: activation dynamics plus the force-length-velocity curve.

### 3.2.5 (Nov 4, 2024) — `versions/3.2.5.py`

- `mesh_inertia_modes` — Pick per mesh how mass properties are derived from geometry, instead of a global flag.
- `flexcomp_shell_types` — Build a deformable shell body from a primitive shape, the replacement for composite.
- `mjx_apply_cartesian_force` — Turn Cartesian forces at points on a body into generalized forces, inside a jitted step.
- `mjx_release_equality` — Switch a weld on and off during a jitted rollout, without recompiling the model.
- `mjx_ray_ellipsoid` — Cast a rangefinder ray in MJX and get the hit distance and geom, ellipsoids included.

### 3.2.4 (Oct 15, 2024) — `versions/3.2.4.py`

- `flex_elasticity` — Give a flex continuum stiffness with the engine's own elasticity, no plugin needed.
- `activate_plugin` — Enable an engine plugin for a spec assembled in Python, with no <extension> in the XML.
- `mjx_spatial_tendon` — Route a tendon over a wrapping geom and through a pulley, and run it in MJX.
- `mjx_tendon_sensors` — Measure tendon length and velocity in MJX with TENDONPOS / TENDONVEL sensors.
- `mjx_mocap_paddle` — Drive a mocap body along a scripted path inside a jitted MJX rollout.

### 3.2.3 (Sep 16, 2024) — `versions/3.2.3.py`

- `native_ccd_options` — Tune the native convex-collision solver — nativeccd plus ccd_tolerance / ccd_iterations.
- `equality_between_sites` — Connect two bodies through a pair of sites, retargetable at runtime via site_pos.
- `freejoint_alignment` — Align a free body's frame with its inertial frame to diagonalise its 6x6 inertia.
- `sameframe_shortcuts` — See why mj_kinematics can skip work for a child — the compiler's mjtSameFrame flags.
- `shell_inertia_for_any_geom` — Model thin-walled parts: shellinertia now works for every geom type, not just meshes.
- `jacobian_time_derivative` — Get the bias acceleration J-dot @ v for operational-space control, exactly.
- `spec_texture_from_buffer` — Ship a procedurally generated texture inside an MjSpec, with no PNG file anywhere.
- `keyframe_merge_on_attach` — Attach a sub-model and keep its keyframes, re-indexed into the parent's qpos layout.
- `mjx_sensors` — Read sensors straight off mjx.Data — position, velocity and force sensors run in MJX now.
- `mjx_tendon_site_wrapping` — Route a spatial tendon through intermediate sites and simulate it in MJX.

### 3.2.1 (Aug 5, 2024) — `versions/3.2.1.py`

- `autoreset_disable` — Keep a diverged state for post-mortem inspection instead of silently resetting to qpos0.
- `texture_data_repaint` — Rewrite a texture's pixels on a live model — mjModel.tex_data, once called tex_rgb.
- `material_texture_layers` — Attach several role-tagged textures to one material for a PBR-capable external renderer.
- `mjx_tendon_support` — Drive coupled joints with a fixed tendon in MJX — transmission, limits, equality.

### 3.2.0 (Jul 15, 2024) — `versions/3.2.0.py`

- `spec_build_model` — Build a model in Python instead of emitting MJCF text — mjSpec, the model editing API.
- `orthographic_camera` — Use an orthographic camera: parallel rays, and a scale that does not fall off with depth.
- `mesh_maxhullvert` — Cap the convex hull of a dense mesh so collision stays cheap — mesh maxhullvert.
- `set_keyframe` — Snapshot the live state into a model keyframe — mj_setKeyframe, not six array copies.
- `urdf_ball_joint` — Import a URDF that uses a spherical joint — mapped to a MuJoCo ball joint since 3.2.0.
- `quaternion_normalization` — Know when mjData.qpos quaternions get normalized: at use, not in place by mj_kinematics.
- `rotate_vector_by_matrix` — Re-express a vector between frames with mju_mulMatVec3 / mju_mulMatTVec3.
- `mjx_elliptic_cone` — Simulate with an elliptic friction cone in MJX — the physically correct cone.

### 3.1.6 (Jun 3, 2024) — `versions/3.1.6.py`

- `geom_clearance` — Shortest signed distance between two geoms and the segment realizing it.
- `collision_sensors` — Declare geom-geom clearance, contact normal and witness segment as sensors in the model.
- `position_actuator_shaping` — Tune a position actuator's damping in natural units and low-pass its setpoint.

### 3.1.5 (May 7, 2024) — `versions/3.1.5.py`

- `replicate_subtree` — Stamp out a repeated kinematic module without duplicating the MJCF by hand.
- `mesh_asset_scale` — Recover the compile-time scale that was applied to a mesh asset's vertices.
- `pbr_material_hints` — Carry PBR material and light-bulb parameters through mjModel for external renderers.
- `mjx_constraint_layout` — Read MJX's constraint block sizes and per-contact efc addresses back on device.
- `mjx_name_lookup` — Resolve MuJoCo names to ids directly against an mjx.Model, on either model type.

### 3.1.4 (April 10th, 2024) — `versions/3.1.4.py`

- `actuator_gravity_compensation` — Charge a joint's gravity compensation to the actuator so force clamps account for it.
- `euler_to_quat` — Convert an Euler-angle triple to a MuJoCo quaternion with an explicit rotation sequence.
- `least_squares_ik` — Solve a bounded nonlinear least-squares problem, here inverse kinematics.

### 3.1.3 (March 5th, 2024) — `versions/3.1.3.py`

- `inheritrange_actuators` — Derive a servo's ctrlrange (or actrange) from its transmission target's range.
- `angular_momentum_matrix` — Map generalized velocities to a subtree's angular momentum with the 3 x nv matrix H(q).

### 3.1.2 (February 05, 2024) — `versions/3.1.2.py`

- `hfield_elevation_in_xml` — Define height-field terrain inline in MJCF instead of shipping a PNG alongside it.
- `discard_visual_assets` — Strip render-only geoms and their assets at compile time without changing the dynamics.
- `rollout_batch` — Roll out a batch of open-loop trajectories on a thread pool and detect divergence.
- `mjx_ray_cast` — Cast a ray against MJX geoms on device, the way a lidar or a click-to-select would.
- `mjx_mass_matrix` — Get a dense mass matrix out of MJX whichever sparse/dense layout the model selected.

### 3.1.0 (December 12, 2023) — `versions/3.1.0.py`

- `frame_transform` — Apply a pose to a group of children without paying for an extra body.
- `pid_actuator_plugin` — Drive a joint with a true PID controller, including the integral term.
- `mjx_device_roundtrip` — Move a model and a full mjData to device, step there, and read the result back.

### 3.0.1 (November 15, 2023) — `versions/3.0.1.py`

- `passive_force_breakdown` — Attribute mjData.qfrc_passive to its individual sub-term sources.
- `disable_actuator_groups` — Switch whole sets of actuators on and off at runtime by their group id.
- `model_from_data` — Write helpers that take only mjData, using the mjData.model back-reference.
- `mjx_joint_equality` — Run a joint-coupling equality constraint under the MJX Newton solver, batched over worlds.

### 3.0.0 (October 18, 2023) — `versions/3.0.0.py`

- `mjx_batched_rollout` — Simulate many worlds at once on an accelerator with MJX and jax.vmap.
- `runtime_equality_toggle` — Grab and release a payload by flipping mjData.eq_active during a rollout.
- `exact_filter_actuator` — Model actuator lag without integration error using dyntype='filterexact' and actearly.
- `camera_projection_sensor` — Get the pixel coordinates of a tracked site from a calibrated camera, with no renderer.
- `discrete_inverse_dynamics` — Recover exactly the torques that produced a recorded trajectory, using the invdiscrete flag.
- `solver_statistics` — Read per-island solver convergence out of mjData and tune the linesearch with it.
- `joint_actuator_force_limits` — Cap the total actuator force reaching a joint with actuatorfrcrange.
