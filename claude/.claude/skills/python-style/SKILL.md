---
name: python-style
description: ALWAYS load before writing, editing, reviewing, renaming, or designing Python (.py) code. Covers general Python style, API shape, naming/import conventions, sum types, casting, assertions, formatting, and code review checks. Use python-modern separately for language feature/changelog guidance.
---

# Python Style

Use this skill for Python style and API shape. Do not duplicate `python-modern`: that skill governs
newer language features and syntax availability.

When a project provides `STYLE.md`, `NAMING.md`, `SUM_TYPES.md`, or similar local guidance, follow
that project guidance when it is stricter or more specific.

## Always Check Before Writing Python

- Keep control flow simple and explicit. Prefer boring code that is easy to verify.
- Use precise type hints and narrow public APIs.
- Import leaf modules and use them as namespaces.
- Choose names that expose the domain model and avoid redundant module prefixes.
- Model closed sets as dataclass variants plus a union alias.
- Dispatch closed sets with exhaustive `match` statements.
- Cast only at real boundaries and explain non-obvious casts.
- Add assertions for load-bearing invariants.
- Keep functions short enough to read without scrolling.

## Simplicity and Technical Debt

- Prefer the smallest API that solves the current problem. Simplicity is the hard revision: remove
  speculative abstractions until the domain shape is clear.
- Treat technical debt as a design failure to fix while the code is still hot. Do not leave known
  latency spikes, exponential algorithms, unclear invariants, or broken error handling for later.
- Ship solid increments. Missing features are acceptable; known fragile foundations are not.

## Safety

- Keep control flow simple and explicit. Avoid recursion unless the problem is inherently recursive
  and depth is bounded.
- Put limits on work: loops, queues, retries, and batches should have clear maximums or fail-fast
  checks.
- Use explicit types. Prefer precise annotations like `list[int]` over bare containers, and keep
  type checker/linter warnings at zero.
- Assert load-bearing invariants at function boundaries and near state transitions. Split compound
  assertions so failures identify the exact broken condition.
- Prefer positive invariants over negated conditions, especially around indexes, counts, and sizes.
- Handle operational errors explicitly. Do not hide or ignore errors.

## Performance

- Sketch performance before optimizing. Estimate network, disk, memory, and CPU costs, considering
  both bandwidth and latency.
- Optimize slow resources first: network, then disk, then memory, then CPU, adjusted for how often
  each cost is paid.
- Separate control plane from data plane. Keep decisions, validation, and scheduling distinct from
  hot data movement.
- Batch work to amortize network, disk, memory, and CPU costs.
- Use vectorized operations from the array library already in use when they make the data path
  simpler and faster; avoid Python loops in hot array paths.
- Be explicit in hot paths. Avoid hidden allocations, repeated conversions, and clever
  comprehensions that obscure cost.

## Cache Invalidation and State

- Do not duplicate state or create unnecessary aliases. One source of truth reduces drift.
- Shrink variable scope. Declare or compute values close to where they are used.
- Check values close to use to avoid place-of-check/place-of-use gaps.
- Prefer simple return types. `None` is simpler than `bool`; `bool` is simpler than `int`; `int` is
  simpler than `int | None`; `int | None` is simpler than raising when absence is expected.

## Imports

The module name provides context. Import the leaf module and use it as a namespace.

```python
import pathlib
import numpy as np
from collections.abc import Callable, Iterable, Mapping
from typing import Self

from mypkg import dataset
from mypkg.ml.algorithms import cnnmlp
from mypkg.ml.backbone import camera_embeddings, dinov3

path = pathlib.Path("/tmp/run")
array = np.zeros((10, 10))
config = dataset.Config(...)
encoder = dinov3.build(dinov3.Config())
policy = cnnmlp.Policy(...)
embedding = camera_embeddings.build(camera_embeddings.Config(num_cameras=2))
```

Rules:

1. Import the leaf module you need.
2. Use the module as the namespace at call sites.
3. Do not repeat the module name in symbols inside that module.
4. Do not import parent packages just to chain through them.
5. Do not create category modules that group unrelated things by type.
6. Direct imports are allowed for typing-only standard library names.

Avoid parent-package chaining:

```python
from mypkg.ml import algorithms

policy = algorithms.cnnmlp.Policy(...)
```

Avoid redundant symbols that repeat the module name:

```python
from mypkg.ml import backbone

config = backbone.CameraEmbeddingConfig(num_cameras=2)
embedding = backbone.build_camera_embedding(config)
```

Avoid direct imports that hide where names come from:

```python
from mypkg.ml.backbone.dinov3 import Config, build

encoder = build(Config())
```

## Naming

- Use `snake_case` for functions, variables, modules, and files.
- Use `PascalCase` for classes.
- Choose precise nouns and verbs. Prefer `batch`, `chunk`, `sample`, or `policy` over vague names
  like `data`, `thing`, or `obj`.
- Do not abbreviate unless the value is a primitive integer in a tight index/math context
  (`i`, `j`, `x`, `y`) or a domain-standard acronym.
- Use long CLI arguments: `--force`, not `-f`. Single-letter flags are for interactive use.
- Do not overload the same word with different meanings across contexts.
- Prefer noun names for stable concepts because they compose in docs and derived identifiers.

### Units and Qualifiers

- Put units or qualifiers last, sorted from most significant to least significant:
  - Good: `latency_ms_max`, `latency_ms_min`.
  - Bad: `max_latency_ms`, `min_latency_ms`.
- Omit suffixes for SI base units when the project assumes SI: meters, seconds, kilograms, radians.
- Add suffixes for non-SI units or representation-specific values:
  - `timeout_ms`, `angle_deg`, `distance_ft`, `mass_lb`.
  - `timeout`, `angle`, `distance`, `mass` when using SI units.

| Variable | Unit | Suffix? | Why |
| :--- | :--- | :--- | :--- |
| `timeout` | seconds (SI) | No | SI default |
| `timeout_ms` | milliseconds | Yes | Not SI base unit |
| `distance` | meters (SI) | No | SI default |
| `distance_ft` | feet | Yes | Not SI |
| `angle` | radians (SI) | No | SI default |
| `angle_deg` | degrees | Yes | Not SI |
| `mass` | kilograms (SI) | No | SI default |
| `mass_lb` | pounds | Yes | Not SI |

- Use `index`, `count`, and `size` deliberately. Index is 0-based, count is 1-based, size is in
  bytes or units.

### Related Names

- Choose related names with matching shape where possible:
  - Good: `source`, `target`; `source_offset`, `target_offset`.
  - Avoid unnecessary abbreviations like `src` and `dest`.
- When a function has a helper or callback used only by that function, prefix the helper with the
  caller name: `read_sector()` and `read_sector_callback()`.
- Put callbacks last in parameter lists.

## Symbols Inside Modules

- Module and file names are `snake_case` nouns: `camera_embeddings.py`, `dataset.py`, `cnnmlp.py`.
- Avoid broad category modules like `utils`, `helpers`, or `common` unless the project already has a
  narrow established meaning.
- Classes are `PascalCase` and should not repeat the module name:
  - Good: `cnnmlp.Policy`, `camera_embeddings.Config`, `dataset.Config`.
  - Bad: `cnnmlp.CNNMLPPolicy`, `camera_embeddings.CameraEmbeddingConfig`,
    `dataset.DatasetConfig`.
- Functions are `snake_case` verbs or verb phrases and should not repeat the module name:
  - Good: `dinov3.build()`.
  - Bad: `dinov3.build_dinov3_encoder()`.

## Summary

| Pattern | Good | Bad |
|---------|------|-----|
| Import | `from mypkg.ml.algorithms import cnnmlp` | `from mypkg.ml import algorithms` |
| Usage | `cnnmlp.Policy(...)` | `algorithms.cnnmlp.Policy(...)` |
| Config | `camera_embeddings.Config(...)` | `backbone.CameraEmbeddingConfig(...)` |
| Function | `dinov3.build(dinov3.Config())` | `build(Config())` |
| Class | `dataset.Config` | `dataset.DatasetConfig` |

## Rationale

1. Clarity: `module.Symbol()` makes the origin immediately clear.
2. Brevity: no redundant prefixes or suffixes once namespaced.
3. Consistency: the same pattern works everywhere.
4. Discoverability: IDE autocomplete shows all exports from a module.

## Ordering

- Put important definitions near the top because files are read top-down.
- For classes, use this order:
  1. class docstring,
  2. class attributes,
  3. `__init__`,
  4. public methods,
  5. private methods.
- When there is no stronger domain order, sort alphabetically or use big-endian naming.

## Sum Types

Model a closed set of variants as separate dataclasses. The union is the enum.

```python
from dataclasses import dataclass

@dataclass
class Whisper:
    variant: str = "whisper-large-v3"
    dim_model: int = 512

@dataclass
class Wav2Vec:
    variant: str = "wav2vec2-base"
    dim_model: int = 768

type EncoderConfig = Whisper | Wav2Vec
```

Rules:

- Use one dataclass per variant.
- Use `VariantA | VariantB` as the closed set.
- Prefer the Python 3.12 `type` statement when the project supports it; otherwise use a normal alias.
- Do not add a `kind`, `type`, or `tag` discriminant for internal dispatch. Match on class type.
- Only add serialization discriminants at external boundaries that require them.

## Exhaustive Pattern Matching

Dispatch with one `case` per variant and finish with a defensive catch-all.

```python
def build(config: EncoderConfig) -> Encoder:
    match config:
        case Whisper():
            return whisper.Encoder(config)
        case Wav2Vec():
            return wav2vec.Encoder(config)
        case _:
            raise ValueError(f"Unknown config: {config}")
```

Rules:

- Do not dispatch closed variants with string fields when class matching is possible.
- Keep one `case` per variant.
- Always end with `case _: raise ValueError(...)` so new variants fail loudly.
- Use guards only when matching values within a variant, not as a substitute for variant classes.

For user input, provide a separate `parse()` function. Keep parsing separate from internal dispatch.

```python
def parse(name: str, *, dim_model: int = 256) -> EncoderConfig:
    match name:
        case "whisper":
            return Whisper(dim_model=dim_model)
        case name if name.startswith("wav2vec"):
            return Wav2Vec(variant=name, dim_model=dim_model)
        case _:
            raise ValueError(f"Unknown encoder: {name}. Supported: whisper, wav2vec*")
```

Rules:

- Parse strings at the boundary.
- Return a typed variant from `parse()`.
- Use guard patterns for families of accepted strings.
- Include supported values in parse errors.

## Casting

Do not cast unless necessary. NumPy, JAX, and PyTorch propagate dtypes automatically through
arithmetic, indexing, and most operations. Redundant `dtype=` arguments and explicit `.astype()` /
`.to()` / `.float()` calls add noise and hide the real type boundaries.

Cast only when there is a genuine reason, and always make the reason clear with naming, locality, or
a short comment.

```python
# Good: no cast needed, result inherits dtype from inputs.
loss = (pred - target) ** 2

# Good: cast is necessary and justified.
# Half-precision accumulation loses too much precision for running stats.
running_mean += delta.to(torch.float32)

# Good: external API requires a specific dtype.
# OpenCV expects uint8 for imwrite.
cv2.imwrite(path, (image * 255).astype(np.uint8))
```

```python
# Bad: redundant, zeros already defaults to float64.
np.zeros((3, 3), dtype=np.float64)

# Bad: redundant, tensor is already float32 from the model.
output = model(x).float()

# Bad: pointless round-trip.
x = torch.tensor(data, dtype=torch.float32)
x = x.to(torch.float32)
```

Rules of thumb:

- Constructor defaults are fine. `np.zeros`, `torch.zeros`, and `jnp.zeros` all have well-known
  default dtypes. Do not restate them.
- Arithmetic preserves dtype. If both operands are float32, the result is float32.
- Cast at boundaries, not in the middle. Convert once when data enters or leaves your system, not on
  every intermediate step.
- Protobuf is a boundary. Convert NumPy scalars at protobuf/serialization boundaries with
  `float(value)`, `int(value)`, or `.tolist()` for repeated fields.
- If you must cast, comment why. A bare `.float()` with no comment is a code smell.

## Off-By-One Errors

- Treat `index`, `count`, and `size` as different concepts.
- `index` is 0-based position. `count` is 1-based quantity. `size` is bytes or units.
- Convert deliberately: `index` to `count` adds one; `count` to `size` multiplies by unit size.
- Use `//`, `math.ceil()`, or `math.floor()` to make rounding intent explicit.

## Dependencies and Tooling

- Minimize dependencies. Each dependency adds supply-chain, safety, performance, and install-time
  cost.
- Prefer the project’s standard tools before adding new ones. In Python projects, prefer existing
  Python, NumPy, JAX, ruff, and type-checker workflows when they are good enough.
- Add a dependency only when it removes more complexity than it introduces.

## Formatting and Comments

- Use the project formatter. Prefer `ruff format` for Python projects when no formatter is specified.
- Use 4 spaces for indentation.
- Keep line length at the project limit; prefer 100 columns when no limit is specified.
- Comments are sentences with a capital letter and punctuation.
- Avoid section banner comments like `# ---- Foo ----`; use ordering and small modules instead.

## Review Checklist

Before finishing a Python change, verify:

- Imports use leaf modules and namespaced call sites.
- Direct imports are limited to typing names or clear project exceptions.
- No symbol redundantly repeats its module name.
- Names expose the domain model and use units/qualifiers correctly.
- Config classes are named `Config` inside their module unless a more precise non-redundant noun is
  needed.
- Closed sets use dataclass variants plus a union alias.
- Pattern matches over variants are exhaustive and have `case _`.
- String parsing is separated from typed internal dispatch.
- Casts happen only at real boundaries or precision/interoperability points.
- Assertions protect load-bearing invariants.
