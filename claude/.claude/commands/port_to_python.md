---
description: Port code from another language to idiomatic Python
---
You are porting a library written in [SOURCE LANGUAGE] to a single, well-organized Python file. Your goal is to produce an idiomatic Python implementation that preserves all existing functionality while embracing Python's strengths — not a line-by-line translation.

## Requirements

1. **Preserves all functionality** — Every public API, algorithm, and behaviour from the original library must be faithfully reproduced.
2. **Idiomatic Python** — Do not transliterate source language idioms. Replace them with natural Python equivalents:
    - Manual loops → list/dict/set comprehensions or `itertools`
    - Manual memory or resource management → context managers, `with` statements
    - Static typed collections → `list`, `dict`, `set`
    - Operator overloading → `__dunder__` methods
    - Generics/templates → `typing` (`Generic[T]`, `TypeVar`) or duck typing where simpler
    - Null/nil/None checks → `Optional[T]`
    - Enums → `enum.Enum` or `enum.IntEnum`
    - Destructors / finalizers → `__enter__` / `__exit__` context managers
3. **Modern Python best practices** — Target Python 3.13+:
    - Full type hints on all public function signatures
    - `dataclasses` or `NamedTuple` in place of plain data-only structs/records
    - f-strings for formatting
    - `pathlib` over `os.path`
    - `match` / `case` where it replaces verbose `if/elif` chains
4. **Applies separation of concerns** — Organise the single file into clearly labelled sections:

    ```
    # Constants & Configuration# Data Structures# Core Logic# Public API# Entry Point
    ```

5. **Follows KISS** — Simplify where the original complexity existed purely to work around source language constraints (e.g. header files, forward declarations, manual reference counting, verbose boilerplate). If a 30-line pattern collapses to a one-liner in Python, write the one-liner.
6. **Clean and maintainable**:
    - Google-style or NumPy-style docstrings on all classes and non-trivial functions
    - PEP 8 throughout (88-char line length, `snake_case` names, `UPPER_CASE` constants)
    - No dead code, no TODO stubs, no placeholder comments
    - Remove any duplicate logic

## Technical Guidelines

- Organise imports: standard library → third-party → (none for local, since this is a single file)
- Use `__all__` to declare the public surface of the module
- Prefer `@staticmethod` / `@classmethod` over module-level functions only when they logically belong to a class
- If the original code uses threads or async, translate to `threading`, `asyncio`, or `concurrent.futures` as appropriate
- Map source language exceptions to the most appropriate Python built-in exception types, or define custom ones inheriting from a sensible base
- Avoid third-party dependencies unless strictly necessary; if you add any, list them clearly at the top of the file

## Process

Before writing any code, produce a `SPEC.md` scratchpad covering:

1. **Feature inventory** — List every class, function, and behaviour in the original library
2. **Source → Python mapping** — For each source language construct, note its Python equivalent
3. **API design decisions** — Where the source language forced a particular design, note the cleaner Python alternative
4. **Modernisation opportunities** — Algorithms or patterns that Python's standard library already provides
5. **File structure plan** — The section layout and class/function hierarchy for the output file

## Output

Your final output must be:

1. `SPEC.md` — the scratchpad analysis above
2. The single consolidated Python file — production-ready, fully functional, runnable as `python <filename>.py`

Begin the Python file with a module-level docstring:

```python
"""
<LibraryName>: <one-line description>.

Ported from [SOURCE LANGUAGE] to Python. Original library: <source/reference if known>.
Python 3.13+ required.
"""
```
