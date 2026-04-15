# Python Modern Features — Use These When Available

> Assume **Python 3.11+** unless a `pyproject.toml` or `.python-version` specifies otherwise.
> Always prefer modern syntax over legacy equivalents.

---

## 🐍 3.8 — Walrus Operator `:=` (always use when it reduces repetition)

```python
# ✅ Assign and test in one expression
if m := re.search(r"\d+", text):
    print(m.group())

# ✅ Avoid recomputing in while loops
while chunk := f.read(8192):
    process(chunk)

# ✅ Filter + transform in one pass
results = [y for x in data if (y := transform(x)) is not None]
```

---

## 🐍 3.10 — Structural Pattern Matching

```python
match command.split():
    case ["quit"]:
        quit()
    case ["go", direction]:
        move(direction)
    case ["get", obj] if obj in room.items:
        pick_up(obj)
    case _:
        print("Unknown command")

# Match on type + shape
match point:
    case Point(x=0, y=0): print("origin")
    case Point(x=0, y=y): print(f"y={y}")
    case Point(x=x, y=y): print(f"({x}, {y})")
```

---

## 🐍 3.11 — Exception Groups + `except*` + `TaskGroup`

```python
# ExceptionGroup: raise multiple exceptions at once
raise ExceptionGroup("validation", [
    ValueError("bad email"),
    TypeError("bad age"),
])

# except*: handle each type independently
try:
    raise ExceptionGroup("errs", [ValueError("a"), KeyError("b")])
except* ValueError as eg:
    for e in eg.exceptions: print("val:", e)
except* KeyError as eg:
    for e in eg.exceptions: print("key:", e)

# asyncio.TaskGroup: structured concurrency (replaces gather())
async with asyncio.TaskGroup() as tg:
    t1 = tg.create_task(fetch(url1))
    t2 = tg.create_task(fetch(url2))
# All tasks done here; exceptions surface as ExceptionGroup
```

**Also 3.11:** `Self` type, `tomllib`, `exception.add_note()`, fine-grained traceback locations.

```python
from typing import Self
class Builder:
    def set_name(self, name: str) -> Self:
        self.name = name
        return self
```

---

## 🐍 3.12 — Generic Syntax + `type` Aliases + f-string Power-ups

```python
# New generic syntax (no TypeVar boilerplate)
def first[T](items: list[T]) -> T:
    return items[0]

class Stack[T]:
    def push(self, item: T) -> None: ...
    def pop(self) -> T: ...

# type statement for aliases
type Vector = list[float]
type Matrix[T] = list[list[T]]

# f-strings now allow reused quotes, backslashes, and comments
name = "world"
msg = f"{'hello':>10}"                    # nested same-quote strings
dbg = f"{2 + 2 = }"                       # = for debug: "2 + 2 = 4"
multi = f"result: {
    some_long_expression    # inline comment ok
}"
```

---

## 🐍 3.13 — `@deprecated`, TypeVar Defaults, `__static_attributes__`

```python
from warnings import deprecated

@deprecated("Use new_api() instead")
def old_api(): ...

# TypeVar defaults (great for generic base classes)
from typing import TypeVar
T = TypeVar("T", default=str)   # defaults to str when unspecified

# inspect static attributes without instantiating
class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y
# Point.__static_attributes__ == ('x', 'y')
```

---

## 🐍 3.14 — t-strings, Deferred Annotations, `except` without parens

```python
# t-strings (PEP 750): structured template strings, NOT auto-interpolated
# Great for safe SQL, HTML, i18n — libraries receive the template + values
import templatelib
name = "Alice"; query = t"SELECT * FROM users WHERE name = {name}"
# query is a Template object, not a plain string — safe by design

# Deferred annotations (PEP 649): forward refs just work, no quotes needed
class Node:
    def children(self) -> list[Node]: ...   # ✅ no 'Node' string needed
    next: Node | None = None                 # ✅

# except without parens for multiple types (PEP 758)
try:
    connect()
except TimeoutError, ConnectionRefusedError:   # ✅ no parens needed
    retry()

# compression.zstd — new stdlib module
import compression.zstd as zstd
data = zstd.compress(b"hello world")
```

---

## 🐍 3.14 — asyncio Introspection (`ps` / `pstree`)

No code changes needed — inspect **live running processes** by PID.

```bash
# Flat task table: ID, name, coroutine stack, awaiter chain
python -m asyncio ps <PID>

# Hierarchical task tree: visualise TaskGroup nesting + blocked tasks
python -m asyncio pstree <PID>
```

```
# pstree example output
└── (T) Task-1
    ├── (T) Chill
    │   ├── (T) A  sleep -> play
    │   └── (T) B  sleep -> play
    └── (T) Jams
        ├── (T) C  sleep -> play
        └── (T) D  sleep -> play
```

**Use cases:** deadlock detection, hung task diagnosis, production debugging without restarting. Pairs with PEP 768 zero-overhead debugger attach.

> 💡 Agent tip: when debugging async code, suggest `pstree` before adding `print`/logging.

---

## ✅ Cheat Sheet: Prefer Modern Over Legacy

| Legacy | Modern (prefer this) |
|---|---|
| `Union[X, Y]` | `X \| Y` (3.10+) |
| `Optional[X]` | `X \| None` (3.10+) |
| `List[T]`, `Dict[K,V]` | `list[T]`, `dict[K,V]` (3.9+) |
| `TypeVar("T")` + Generic | `def fn[T](...)`  (3.12+) |
| `TypeAlias` | `type Alias = ...` (3.12+) |
| `asyncio.gather()` | `asyncio.TaskGroup` (3.11+) |
| `from __future__ import annotations` | Just write forward refs (3.14+) |
| Bare `except Exception:` | `except*` for grouped errors (3.11+) |
| Manual `re.match` then use | Walrus `:=` (3.8+) |
| `-> 'MyClass'` string annotation | `-> Self` (3.11+) |

---

## 🆕 New Capabilities (no legacy equivalent — just use them)

| Feature | Version | When to use |
|---|---|---|
| `f"{value=}"` | 3.8 | Quick debug prints — prints `value=42` |
| `dict_a \| dict_b` / `d \|= extra` | 3.9 | Merge dicts without `{**a, **b}` |
| `exception.add_note("hint")` | 3.11 | Enrich exceptions with runtime context |
| `tomllib.load(f)` | 3.11 | Parse TOML (stdlib, no install needed) |
| `@override` | 3.12 | Catch missed/mismatched method overrides at type-check time |
| `@deprecated("msg")` | 3.13 | Mark APIs for removal; emits `DeprecationWarning` automatically |
| `t"Hello {name}"` (t-strings) | 3.14 | Safe structured templates for SQL/HTML/i18n — NOT auto-interpolated |
| `python -m asyncio ps/pstree <PID>` | 3.14 | Inspect live async tasks without modifying code |
| `import compression.zstd` | 3.14 | Zstandard compression in stdlib |

### Quick examples

```python
# f"{value=}" — instant debug
x = [1, 2, 3]
print(f"{x=}")        # x=[1, 2, 3]
print(f"{len(x)=}")   # len(x)=3

# dict merge
defaults = {"timeout": 30, "retries": 3}
overrides = {"retries": 5}
config = defaults | overrides  # {"timeout": 30, "retries": 5}

# add_note: attach context at the raise site
try:
    load_config("prod.toml")
except FileNotFoundError as e:
    e.add_note("Hint: run `make setup` to generate config files")
    raise

# tomllib
import tomllib
with open("pyproject.toml", "rb") as f:
    config = tomllib.load(f)

# @override — typo in method name caught by type checker
from typing import override
class Animal:
    def speak(self) -> str: ...

class Dog(Animal):
    @override
    def speek(self) -> str: ...  # ❌ type checker error: no base method 'speek'

# @deprecated
from warnings import deprecated
@deprecated("Use connect_v2() instead")
def connect(): ...

# t-strings — library receives Template, not evaluated string
name = "Alice'; DROP TABLE users;--"
query = t"SELECT * FROM users WHERE name = {name}"
# Safe — the template engine handles escaping, not Python
```

---

## 🔧 Agent Rules

- **Check `pyproject.toml`** `requires-python` before choosing syntax.
- **Default to 3.11+** features if no constraint is set.
- **Never use** `typing.List`, `typing.Dict`, `typing.Optional` — use builtin generics.
- **Always use** `:=` walrus when it avoids re-computation or double lookup.
- **Prefer** `match` over long `if/elif` chains on structured data.
- **Use** `type` aliases and `[T]` generic syntax over `TypeVar` boilerplate in 3.12+.
- **Annotate** return types with `Self` instead of repeating the class name.
- **Use** `TaskGroup` over `asyncio.gather()` for structured concurrency.
