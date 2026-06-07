---
name: jaxtyping
description: ALWAYS load before writing, editing, or creating any JAX, PyTorch, NumPy, or other array/tensor code — do not write tensor code without loading it first. Typing conventions using jaxtyping + beartype for runtime type checking of array shapes. Despite the name "jaxtyping", it works with any array library.
---

# Array Typing Conventions (jaxtyping + beartype)

This project uses **[jaxtyping](https://github.com/google/jaxtyping)** combined with **[beartype](https://github.com/beartype/beartype)** for runtime type checking and documentation of array shapes.

## Core Libraries

- **`jaxtyping`**: Provides the type hints (e.g., `Float`, `Array`).
- **`beartype`**: Performs the runtime checking.

> Despite the name "jaxtyping", this works with **JAX**, **PyTorch**, **NumPy**, and other ML frameworks. The library is framework-agnostic — use `jaxtyping` annotations regardless of which tensor library you're working with.

## Dimension Glossary

We use specific single-letter (or short) string literals to denote semantic dimensions in `jaxtyping` annotations.

| Shortname | Meaning | Usage Example |
| :--- | :--- | :--- |
| **`B`** | Batch size | `Float[Array, "B H W C"]` |
| **`*B`** | Variadic Batch | `Float[Array, "*B H W C"]` (Matches `()`, `(B,)`, `(T, B)`, etc.) |
| **`T`** | Time / Sequence Length | `Float[Array, "B T C"]` |
| **`H`**, **`W`** | Height, Width (Input) | `Float[Array, "B H W 3"]` |
| **`h`**, **`w`** | Height, Width (Feature Map) | `Float[Array, "B h w D"]` (Often lower-case implies downsampled/processed) |
| **`C`** | Channels | `Float[Array, "B H W C"]` (Often 3) |
| **`D`**, **`_d`** | Dimension / Embeddings | `Float[Array, "B T D"]` |
| **`V`** | Views / Cameras | `Float[Array, "V B H W C"]` |
| **`Q`** | Query Points | `Float[Array, "B Q 2"]` (Used in TAP/Tracking) |
| **`A`** | Action Dimension | `Float[Array, "B T A"]` |
| **`P`** | Proprioception / Patches | `Float[Array, "B P"]` |
| **`N`** | Number of Entities/Tracks | `Float[Array, "B T N D"]` |
| **`L`** | Length (Generic) | `Float[Array, "B L D"]` |
| **`...`** | Any / Ellipsis | `Float[Array, "..."]` (Matches any number of dimensions) |

### Prefixes & Patterns

- **`*` (Variadic)**: E.g., `*B`. Indicates zero or more dimensions. Crucial for modules that support unbatched, batched, or time-batched inputs seamlessly.
- **`_` (Internal)**: E.g., `_d`, `_a`. A leading underscore usually implies a dimension that is internal, fixed, or derived, and doesn't need a strictly semantic name in that context.
- **String Interpolation**: You will often see Python f-string syntax in types, e.g., `Float[Array, "B {self.width}"]`. This enforces that the dimension matches the object's attribute at runtime.

## Usage Example

To enable runtime type checking, decorate functions with `@jaxtyped(typechecker=typechecker)`.

```python
from beartype import beartype as typechecker
from jaxtyping import Float, jaxtyped
from torch import Tensor

@jaxtyped(typechecker=typechecker)
def forward(self, x: Float[Tensor, "B T D"]) -> Float[Tensor, "B T A"]:
    ...
```

`jaxtyping` works equally well with `jax.Array`, `numpy.ndarray`, and `torch.Tensor`. Use it with whichever tensor library your project uses.
