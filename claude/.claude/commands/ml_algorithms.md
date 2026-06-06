---
description: Implement core ML algorithms in clean Python
---
You will be summarizing an algorithm from a codebase into a single, clean Python file. The code you need to analyze and summarize is in the current directory

Your task is to create a clean, minimal Python implementation that captures the core algorithm from the provided code. Follow these requirements:

## General Requirements

1. **Single File**: Output must be a single Python file with no external dependencies (except standard libraries: pytorch, jaxtyping, beartype, einops)
2. **Modern Python**: Use Python 3.10+ features, type hints, and best practices
3. **KISS Principle**: Keep it simple and straightforward
4. **Separation of Concerns**: Organize code into logical functions/classes with clear responsibilities
5. **Minimal and Clean**: Remove unnecessary complexity, focus on the core algorithm

## Type Checking Requirements

You MUST use **jaxtyping** with **beartype** for all function signatures. Follow these conventions:

### Setup

```python
from beartype import beartype as typechecker
from jaxtyping import Array, Float, Int, jaxtyped
import jax.numpy as jnp
from einops import rearrange, reduce, repeat
```

### Common Type Aliases

Define these at the top of your file as needed:

```python
from jaxtyping import Array, Float, Int

ImageTensor = Float[Array, "*B H W C"]
EmbeddingTensor = Float[Array, "*B _d"]
MultiViewEmbedding = Float[Array, "V *B _d"]
ObservationTensor = Float[Array, "..."]
ObservationDict = dict[str, ObservationTensor]
Params = PyTree[Float[Array, "..."]]
RandomKey = jnp.ndarray
```

### Dimension Naming Conventions

Use these standard dimension names in your type annotations:

- **`B`**: Batch size
- **`*B`**: Variadic batch (matches `()`, `(B,)`, `(T, B)`, etc.)
- **`T`**: Time / Sequence length
- **`H`**, **`W`**: Height, Width (input)
- **`h`**, **`w`**: Height, Width (feature map, often downsampled)
- **`C`**: Channels
- **`D`**, **`_d`**: Dimension / Embeddings
- **`V`**: Views / Cameras
- **`Q`**: Query points
- **`A`**: Action dimension
- **`P`**: Proprioception / Patches
- **`N`**: Number of entities/tracks
- **`L`**: Length (generic)
- **`...`**: Any / Ellipsis (matches any dimensions)

### Function Decoration

Decorate ALL functions with type checking:

```python
@jaxtyped(typechecker=typechecker)
def process_images(
    images: Float[Array, "*B H W C"]
) -> Float[Array, "*B D"]:
    # Implementation
    pass
```

## Einops Requirement

Use **einops** (rearrange, reduce, repeat) for all tensor operations instead of manual reshaping. This makes the code more readable and self-documenting.

Example:

```python
# Good - using einops
features = rearrange(x, 'b h w c -> b (h w) c')

# Avoid - manual reshaping
features = x.reshape(b, h*w, c)
```

## Documentation Requirements

1. **ASCII Diagrams**: Include ASCII diagrams to illustrate:
   - Data flow through the algorithm
   - Tensor shape transformations
   - Architecture overview (if applicable)

2. **Explanations**: Add clear docstrings and comments explaining:
   - What the algorithm does (high-level overview)
   - Key steps in the algorithm
   - Shape transformations and why they occur
   - Any non-obvious design decisions

Example format:

```python
def algorithm_step(x: Float[Array, "B T D"]) -> Float[Array, "B D"]:
    """
    Aggregates temporal features into a single representation.

    Flow:
    ┌─────────────┐
    │  B T D      │  Input sequence
    └──────┬──────┘
           │ mean over T
    ┌──────▼──────┐
    │  B D        │  Aggregated features
    └─────────────┘

    Args:
        x: Temporal features with shape (batch, time, dim)

    Returns:
        Aggregated features with shape (batch, dim)
    """
    return reduce(x, 'b t d -> b d', 'mean')
```

## Process

Before writing the code, use a scratchpad to:

1. Identify the core algorithm and its purpose
2. List the main components/functions needed
3. Map out the data flow
4. Identify key tensor transformations

<scratchpad>
Think through the algorithm structure here:
- What is the main algorithm doing?
- What are the key functions/classes needed?
- What are the main data transformations?
- How should the code be organized?
</scratchpad>

Then write your implementation inside <implementation> tags.

## Final Output Requirements

Your final output should include:

1. All necessary imports at the top
2. Type aliases (if needed)
3. A high-level ASCII diagram showing the overall algorithm flow
4. A brief comment block explaining what the algorithm does
5. Clean, typed function definitions with docstrings
6. ASCII diagrams for complex transformations
7. The complete, runnable Python code

The implementation should be self-contained and ready to use. Focus on clarity and correctness over brevity.
