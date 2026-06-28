---
name: robotics-conventions
description: ALWAYS load before writing, editing, reviewing, or designing robotics code, robot simulation code, kinematics/dynamics utilities, frame transforms, quaternions, poses, twists, wrenches, Jacobians, MuJoCo/MJX/mink code, or robot-control interfaces. Enforces robotics notation, frame naming, quaternion conventions, Jacobian conventions, and MuJoCo frame conventions.
---

# Robotics Notation & Conventions Style Guide

This document defines the naming conventions and notation standards for robotics code in this codebase. Adapted from Drake's monogram notation for MuJoCo conventions.

---

## 1. Variable Naming Pattern

All robotics quantities follow a structured naming pattern:

```
{type}_{Reference}_{Target}[_{ExpressedIn}]
```

| Component | Description | Example |
| :--- | :--- | :--- |
| **type** | What kind of quantity (see §2) | `pose`, `vel`, `quat` |
| **Reference** | Frame you're measuring in/from | `World`, `Base`, `Body` |
| **Target** | Frame or point you're describing | `EndEffector`, `Camera`, `Tool` |
| **ExpressedIn** | Frame whose unit vectors are used (omit if same as Reference) | `Body`, `Sensor` |

### Examples

```python
pose_World_Camera         # Camera's pose in World frame
pos_World_Tool_Body       # Tool position from World origin, expressed in Body frame
vel_Base_EndEffector      # End-effector velocity in Base frame
twist_World_Tool_Body     # Tool spatial velocity in World, expressed in Body frame
```

---

## 2. Type Prefixes

| Prefix | Description | Contents | Size |
| :--- | :--- | :--- | :--- |
| `pose_` | Pose (quaternion) | `(x, y, z, qw, qx, qy, qz)` | 7 |
| `poseeuler_` | Pose (Euler) | `(x, y, z, rx, ry, rz)` | 6 |
| `hmat_` | Homogeneous matrix | 4×4 SE(3) | 16 |
| `pos_` | Position vector | `(x, y, z)` | 3 |
| `quat_` | Quaternion | `(qw, qx, qy, qz)` | 4 |
| `rmat_` | Rotation matrix | 3×3 SO(3) | 9 |
| `rotvec_` | Rotation vector | `(rx, ry, rz)`, angle = ‖r‖ | 3 |
| `axisangle_` | Axis-angle | `(ax, ay, az, theta)` | 4 |
| `vel_` | Linear velocity | `(vx, vy, vz)` | 3 |
| `angvel_` | Angular velocity | `(wx, wy, wz)` | 3 |
| `twist_` | Spatial velocity | `(vx, vy, vz, wx, wy, wz)` | 6 |
| `wrench_` | Spatial force | `(fx, fy, fz, tx, ty, tz)` | 6 |
| `jac_` | Spatial Jacobian | 6 × nv | - |
| `jacp_` | Translational Jacobian | 3 × nv | - |
| `jacr_` | Rotational Jacobian | 3 × nv | - |

---

## 3. Conventions

### Quaternion Convention
**Scalar-first**: `(qw, qx, qy, qz)`

### Euler Convention
Default is **XYZ extrinsic**. Specify sequence if different:

```python
poseeuler_zyx_World_Robot  # ZYX Euler angles
```

### Twist/Wrench Convention
**Linear-first** (MuJoCo convention):

```
twist = [vx, vy, vz, wx, wy, wz]
         ─────────  ─────────
          linear    angular
```

Note: This differs from Drake which uses angular-first.

### Units
**SI units**: meters, kilograms, seconds, radians.

---

## 4. Common Frames

| Frame | Symbol | Description |
| :--- | :--- | :--- |
| World | `W`, `World` | Inertial frame, non-rotating, non-accelerating |
| Base | `B`, `Base` | Robot base frame |
| Body | `Body` | Attached to a rigid body, moves with it |
| Sensor | `S`, `Sensor` | Attached to sensor (camera, IMU, etc.) |
| EndEffector | `EE`, `EndEffector` | Robot end-effector frame |
| Tool | `Tool` | Tool center point frame |

### Frame vs Body
- Use the same symbol for a body and its body frame.
- Body B's location is defined by Bo (origin of body frame).
- Body B's center of mass is Bcm (not necessarily at Bo).

---

## 5. Rotation Matrix Usage

Columns of `mat_A_B` are B's basis vectors expressed in A:

```
         ---- ---- ----
        |    |    |    |
 R_AB = |Bx_A|By_A|Bz_A|
        |    |    |    |
         ---- ---- ----
```

**Re-express vector from B to A:**
```python
r_A = mat_A_B @ r_B
```

**Properties:**
```python
mat_B_A = mat_A_B.T  # Inverse equals transpose for rotation matrices
```

**Composition (match adjacent frames):**
```python
mat_A_D = mat_A_B @ mat_B_C @ mat_C_D
```

---

## 6. Homogeneous Transform Usage

```
         --------- ----
        |         |    |
        | mat_A_B |p_AB|
 X_AB = |         |    |
        | 0  0  0 | 1  |
         --------- ----
```

**Transform point from B to A:**
```python
p_A = hmat_A_B @ np.append(p_B, 1)  # Homogeneous coordinates
```

**Composition:**
```python
hmat_A_D = hmat_A_B @ hmat_B_C @ hmat_C_D
```

---

## 7. Jacobian Conventions

### MuJoCo Frame Convention: LOCAL_WORLD_ALIGNED
- **Point P**: On the moving body (local)
- **Expressed-in**: World frame basis (world aligned)

This is sometimes called "hybrid" or "body-point, world-axes" convention.

### What `mj_jac` Computes

| Function | jacp output | jacr output | Point/Frame |
| :--- | :--- | :--- | :--- |
| `mj_jac` | `jacp_W_P` | `jacr_W_B` | arbitrary point P |
| `mj_jacBody` | `jacp_W_Bo` | `jacr_W_B` | body origin |
| `mj_jacBodyCom` | `jacp_W_Bcm` | `jacr_W_B` | body COM |
| `mj_jacSite` | `jacp_W_S` | `jacr_W_S` | site origin |
| `mj_jacGeom` | `jacp_W_G` | `jacr_W_G` | geom center |

### Usage
```python
twist_A_B  = jac_A_B  @ v   # 6D spatial velocity
vel_A_B    = jacp_A_B @ v   # 3D linear velocity
angvel_A_B = jacr_A_B @ v   # 3D angular velocity
```

---

## 8. Time Derivatives

**For scalars:**
```python
xdot   # or x_dot   : First derivative dx/dt
xddot  # or x_ddot  : Second derivative d²x/dt²
```

**For vectors (specify differentiation frame):**
```python
DtA_v_E  # Time derivative of vector v in frame A, expressed in E
```

Note: The derivative frame matters. A vector can change in one frame while being constant in another.

---

## 9. Naming Examples

### Poses
```python
pose_World_Robot              # Robot pose in World
pose_World_CameraCurrent      # Current camera pose in World
pose_World_CameraDesired      # Desired camera pose in World
pose_CameraCurrent_CameraDesired  # Relative pose (current → desired)
hmat_Base_EndEffector         # End-effector pose in Base (4×4)
```

### Rotations
```python
quat_Body_Camera              # Camera orientation in Body frame
mat_World_Body                # Body orientation in World (3×3)
rotvec_Imu_Camera             # IMU-to-camera rotation as rotation vector
axisangle_Parent_Child        # Parent-to-child as axis-angle
```

### Positions
```python
pos_World_EndEffector         # EE position from World origin
pos_Base_Target               # Target position in Base frame
pos_World_Gripper_Body        # Gripper pos from World origin, in Body frame
```

### Velocities
```python
vel_World_EndEffector         # EE linear velocity in World
angvel_World_Drone            # Drone angular velocity in World
twist_Base_EndEffector        # EE spatial velocity in Base (6D)
twist_World_Tool_Body         # Tool spatial vel in World, expressed in Body
```

### Jacobians
```python
jac_World_EndEffector         # 6×nv spatial Jacobian
jacp_World_EndEffector        # 3×nv translational Jacobian
jacr_World_EndEffector        # 3×nv rotational Jacobian
jacp_World_Tool_Body          # 3×nv, expressed in Body frame
```

---

## 11. MuJoCo vs Drake Jacobian Notation

```python
"""
1. NOTATION SYSTEMS
--------------------------------------------------------------------------------

DRAKE (Monogram Notation)
-------------------------
Explicit frame specification using sub/superscripts:

    Typeset:  [J_q^{ᴾp^Q}]_E
    Code:     Jq_p_PQ_E

    Meaning:  Position Jacobian of point Q from point P,
              expressed IN frame E, with respect to q

Components:
    - Quantity type : J (Jacobian)
    - Derivative var: q, q̇, or v (subscript after J)
    - Kinematic qty : p_PQ (position from P to Q)
    - Expressed-in  : E (final subscript)

Examples:
    Jv_v_BQ   = ∂(v_BQ)/∂v     Translational velocity Jacobian of Q in B wrt v
    Jv_w_BC   = ∂(w_BC)/∂v     Angular velocity Jacobian of C in B wrt v
    Jq_p_BoQ_B = ∂(p_BoQ)/∂q   Position Jacobian from Bo to Q, in frame B wrt q


MUJOCO (Implicit Convention)
----------------------------
Function-based API with implicit world frame:

    mj_jac(m, d, jacp, jacr, point, body)

    - point : 3D point in world coordinates
    - body  : body to which point is attached
    - jacp  : output 3×nv translational Jacobian
    - jacr  : output 3×nv rotational Jacobian

Implicit convention:
    - Expressed-in frame: world-aligned, centered at body COM
    - Always differentiates w.r.t. v (generalized velocities)


2. KEY DISTINCTION: q̇ vs v
--------------------------------------------------------------------------------

For systems with quaternions (ball joints, free joints):

    dim(q) = nq  >  nv = dim(v)

DRAKE explicitly distinguishes:

/// Enumeration that indicates whether the Jacobian is partial differentiation
/// with respect to q̇ (time-derivatives of generalized positions) or
/// with respect to v (generalized velocities).
enum class JacobianWrtVariable {
  kQDot,  ///< J = ∂V/∂q̇
  kV      ///< J = ∂V/∂v
};

    JacobianWrtVariable::kQDot   →  J = ∂X/∂q̇
    JacobianWrtVariable::kV      →  J = ∂X/∂v

MUJOCO always uses v-space:

    All Jacobians are 3×nv or 6×nv
    Quaternion handling is internal


3. API COMPARISON
--------------------------------------------------------------------------------

MUJOCO Functions              │ DRAKE Equivalent (monogram)
──────────────────────────────┼────────────────────────────────────
mj_jac(point, body)           │ Jv_v_WQ_W  (point Q on body, in world)
mj_jacBody(body)              │ Jv_v_WBo_W (body origin Bo)
mj_jacBodyCom(body)           │ Jv_v_WBcm_W (body center of mass)
mj_jacSite(site)              │ Jv_v_WS_W  (site frame origin)
mj_jacDot(point, body)        │ d/dt[Jv_v_WQ]_W (time derivative)


4. CONSTRAINT JACOBIAN
--------------------------------------------------------------------------------

Both use the same fundamental relationship:

    Equations of motion:   M · v̇ + c = τ + Jᵀ · f

    where:
        M : mass matrix (nv × nv)
        c : bias forces (Coriolis, gravity)
        τ : applied forces
        J : constraint Jacobian (nc × nv)
        f : constraint forces (nc × 1)

    J   maps:  joint velocity   →  constraint velocity    (J · v)
    Jᵀ  maps:  constraint force →  joint force            (Jᵀ · f)

MUJOCO storage:
    mjData.efc_J        : constraint Jacobian (nc × nv)
"""
```
