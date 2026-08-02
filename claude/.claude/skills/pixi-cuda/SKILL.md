---
name: pixi-cuda
description: ALWAYS load before writing or editing a pixi.toml (or pyproject.toml [tool.pixi] section) for a CUDA/GPU project — declaring CUDA on a platform, toolkit dependency strategies, nvcc host-compiler compat, CUDA activation env vars, PyTorch/TensorRT CUDA wheel indices, and build-isolation for compiling CUDA extensions.
---

# Pixi + CUDA

Reference for configuring CUDA/GPU support in a pixi workspace. Copy a whole recipe rather than combining pieces from different sections — CUDA/gcc/torch/channel compatibility is a tightly coupled set, not independently choosable axes.

## Workflow

- **Adding CUDA to a project:** first decide whether anything actually needs `__cuda` declared at all (§1). If yes, declare it with the platform table, not `[system-requirements]` (§2). Pick a toolkit dependency strategy (§3). Match channels only if pulling conda `pytorch` (§4). Pin `gcc`/`gxx` and set activation env vars only if something compiles CUDA code (§5, §6).
- **"GPU not detected" / "wrong build installed":** run `pixi info` and check the resolved virtual packages, channel order, and minimum platform. Confirm `torch` isn't mixed between conda and PyPI (§7). Confirm `cuda` is actually declared on the platform the environment is solving for (§2).
- **Migrating a `[system-requirements]` manifest:** convert mechanically to the platform table (§2). Don't also restructure the feature/environment layout unless asked separately.
- **Adding a CPU/CUDA split:** default to named platforms + `target` blocks in one environment (§9). Only reach for a separate feature/environment when the CUDA variant needs a genuinely different dependency set or task list, not just a different torch build.
- **Compiling a CUDA extension** (setup.py, CMake, raw nvcc): pin the host compiler (§5), set `CUDA_HOME`/`LD_LIBRARY_PATH`/arch env vars (§6), and use `no-build-isolation` if the build imports torch (§8).
- Never invent a version pin or flag — copy it from the matching recipe below. Don't add a `cuda` platform declaration reflexively (§1) when nothing in the manifest checks `__cuda`.

## 1. Do you even need to declare `cuda` on the platform?

`cuda`/`__cuda` only matters to packages whose conda recipe branches on it: the conda `pytorch`/`pytorch-gpu` vs `pytorch-cpu` split, `vllm`'s `cpu_*`/`cuda129_*` build strings, an explicit `when = "__cuda>=12"` (§2). Plain CUDA toolkit packages (`cuda-nvcc`, `cuda-cudart-dev`, `libcublas-dev`, ...) are single-variant and install identically regardless of what's declared on the platform. PyPI `torch` (via `[pypi-dependencies]`) never consults `__cuda` either — PyPI wheels are selected by index URL/build tag, not conda virtual packages.

Manifest with no cuda platform declaration, and correctly so:
```toml
[workspace]
platforms = ["linux-64"]

[dependencies]
cuda-nvcc       = "12.8.*"
cuda-cudart-dev = "12.8.*"
libcublas-dev   = "*"
cuda-version    = "12.8.*"

[pypi-dependencies]
torch = "==2.5.1"   # PyPI torch, not the conda pytorch/pytorch-gpu package
```
Adding `cuda = "12.8"` here would be a no-op. Only declare it once a dependency that actually varies on `__cuda` enters the picture.

## 2. Declaring CUDA on a platform

### Current syntax: inline table on `workspace.platforms`

```toml
[workspace]
platforms = [
  "osx-arm64",
  { platform = "linux-64", cuda = "12.0", glibc = "2.28" },
  { name = "jetson-nano", platform = "linux-aarch64", cuda = "12.8" },
]
```

- `cuda = "12.0"` declares the `__cuda` virtual package at that version — a **solve-time floor**, not the exact installed version. Pin it low while a `cuda-version = "12.6.*"` dependency (§3) pins the real toolkit release; CUDA has minor-version runtime forward-compat, so a 12.6 build runs fine against a driver that only reports 12.2.
- `name` gives the entry a stable identifier for `feature.<name>.platforms`, target selectors, and CLI commands. Omit it and pixi synthesizes one from the subdir + virtual packages.
- `cuda` also accepts `{ driver, arch }` to pin GPU compute capability (`__cuda_arch`) alongside the driver version: `cuda = { driver = "12.0", arch = "8.6" }`. `arch` requires `driver`.
- Without a `cuda` declaration on the platform, pixi solves **CPU-only** builds of any `__cuda`-gated package.

CLI equivalents (keep `pixi.lock` in sync automatically):
```shell
pixi workspace platform add linux-64 --cuda 12.0
pixi workspace platform add --auto-detect               # detect this machine's subdir + virtual packages (CUDA included), inserted first
pixi workspace platform add --auto-detect --cuda 12.4    # override just one detected value
pixi workspace platform edit linux-64-cuda --cuda 12.1
pixi workspace platform list
```
After installing, `pixi info` reports each environment's **minimum platform** — the virtual packages some resolved dependency actually requires — use it to trim an over-specific auto-detected entry back down for portability.

### Legacy syntax (deprecated, still parses)

```toml
[system-requirements]
cuda = "12"
libc = { family = "glibc", version = "2.31" }
```
```toml
[feature.gpu.system-requirements]
cuda = "12"
```
Migrate mechanically: workspace-level `[system-requirements] cuda = "12"` → `platforms = [{ platform = "linux-64", cuda = "12" }]`; per-feature → add a named rich platform at the workspace level and point `feature.<name>.platforms` at it. `pixi workspace system-requirements add/list` is hidden/deprecated in favor of `pixi workspace platform add/edit/list`.

### Solving without a GPU present (CI)

These conda env vars override the detected virtual packages regardless of manifest syntax:
```shell
CONDA_OVERRIDE_CUDA=12.0 pixi install         # pretend a CUDA 12.0 driver is present
CONDA_OVERRIDE_CUDA_ARCH=8.6 pixi install     # pretend compute capability 8.6
CONDA_OVERRIDE_CUDA="" pixi install           # disable __cuda entirely, solve as if absent
```
Use these on CPU-only CI runners solving a CUDA-enabled lockfile, or to test as-if-absent.

### Emerging: `when =` conditional dependencies (repodata v3, beta — not yet on conda-forge)

```toml
[dependencies]
gpu-package = { version = "*", when = "__cuda>=12" }
triton      = { version = "*", when = { package = "pytorch", build = "*cuda*" } }
```
Cleaner than a `target` block for simple cases once packages ship v3 metadata, but conda-forge doesn't build with `--v3` yet — use platform/target blocks (§9) instead for now.

## 3. Getting the CUDA toolkit

**A. Meta-package — use when you just need nvcc + libs to build/run something generic:**
```toml
[dependencies]
cuda = "12.4.1"
```
or the lighter compiler-only meta-package:
```toml
[dependencies]
cuda-toolkit = "12.8.*"
cuda-version = "12.8.*"
```

**B. `cuda-version` as the cross-package anchor — always add this when pinning individual `cuda-*`/`lib*-dev` packages,** so the solver can't let nvcc and the runtime libs drift to different CUDA releases:
```toml
cuda-version = "12.8.*"
```

**C. Targeted dev libraries — use when building a specific PyTorch/pybind CUDA extension** (smaller env than the full toolkit):
```toml
[dependencies]
cuda-nvcc       = "12.8.*"
cuda-cudart-dev = "12.8.*"
cuda-nvtx-dev   = "*"
libcublas-dev   = "*"
libcurand-dev   = "*"
libcusolver-dev = "*"
libcusparse-dev = ">=12"
cuda-version    = "12.8.*"
```

**D. Full "batteries included" feature — use for projects with many independent GPU consumers** (compiler + libs together, defined once as a reusable `[feature.cuda]`):
```toml
[feature.cuda.dependencies]
cuda-compiler     = "*"
cuda-version      = "12.6.*"
cuda-cudart-dev   = "*"
cuda-crt          = "*"
cuda-driver-dev   = "*"
cuda-nvcc         = "*"
cuda-nvrtc-dev    = "*"
cuda-nvtx         = "*"
cuda-nvtx-dev     = "*"
cuda-nvml-dev     = "*"
cuda-profiler-api = "*"
libcusparse-dev   = "*"
cudnn             = "*"
libcublas-dev     = "*"
libcudss-dev      = "*"
libcufile-dev     = "*"
libcufft-dev      = "*"
libcurand-dev     = "*"
libcusolver-dev   = "*"
cusparselt        = "*"
libnvjitlink      = "*"
```

Force a CUDA build variant when conda-forge ships both CPU and CUDA build strings for the same version (e.g. vllm):
```toml
vllm = { version = ">=0.19.0", build = "cuda*" }   # conda-forge ships cpu_* and cuda129_* variants
```

## 4. Channels

Default (`conda-forge` only) covers most `cuda-*`/`lib*-dev` packages and is the recommended way to get PyTorch (`pytorch-gpu`/`pytorch-cpu`). Reach for the `pytorch`/`nvidia` channels only when you specifically need legacy `pytorch`-channel builds or a version-pinned NVIDIA toolkit release:

```toml
[feature.cuda]
channels = ["pytorch", "nvidia", "conda-forge"]
channel-priority = "strict"   # prevents conda-forge's same-named `pytorch` (often CPU-only) from winning

[feature.cuda.dependencies]
pytorch      = { version = ">=2.0",   channel = "pytorch" }
pytorch-cuda = { version = ">=12.1",  channel = "pytorch" }
```

**Priority mechanics:** priority is the array order in `workspace.channels` — the first channel wins for any package found there, and once a package is found in one channel, later channels are excluded for that package only (not globally). Force priority explicitly with the `priority` int key (higher wins); environment/feature channels are *prepended* to workspace channels by default:
```toml
[workspace]
channels = ["conda-forge"]

[environments.b]
channels = ["pytorch", { channel = "nvidia", priority = 1 }]   # resolves to: nvidia, pytorch, conda-forge
```
Check the resolved order with `pixi info`.

Worked nvidia+pytorch+conda-forge example:
```toml
[workspace]
channels = ["nvidia/label/cuda-11.8.0", "nvidia", "conda-forge", "pytorch"]
platforms = ["linux-64"]

[dependencies]
cuda         = { version = "*", channel = "nvidia/label/cuda-11.8.0" }
pytorch      = { version = "2.0.1.*", channel = "pytorch" }
torchvision  = { version = "0.15.2.*", channel = "pytorch" }
pytorch-cuda = { version = "11.8.*", channel = "pytorch" }
python       = "3.10.*"
```
`pytorch` is listed *last* even though every dependency from it is channel-pinned: conda-forge should supply everything else (e.g. `ffmpeg`), since the `pytorch` channel ships older versions of shared packages that can break a newer torch build. Putting `pytorch` first would let it win those non-pytorch packages too.

Pin the exact CUDA point-release via a **labeled channel**, not just a version string, when the toolkit must never silently drift:
```toml
channels = ["pytorch", "nvidia/label/cuda-12.1.0", "nvidia", "conda-forge"]

[dependencies]
cuda-toolkit = { version = "12.1.*", channel = "nvidia/label/cuda-12.1.0" }
cuda-nvcc    = { version = "12.1.*", channel = "nvidia/label/cuda-12.1.0" }
```

## 5. nvcc host-compiler pin (gcc/g++)

nvcc supports only a bounded gcc/g++ version range per CUDA release; the distro default is often too new (e.g. Ubuntu 24.04 ships gcc 13, which CUDA 12.1's `host_config.h` rejects). Pin conda's own compiler:

```toml
# Pin gcc/g++ 12 in the env so nvcc (CUDA 12.1) has a supported host compiler.
gcc = "12.*"
gxx = "12.*"
```

When a version pin alone isn't enough and a header needs patching, keep the patch idempotent and re-run it on every activation — reinstalling the conda package reverts the file:
```toml
# GCC 11 — headers patched for CUDA 12.8 nvcc via scripts/patch_shared_ptr.sh.
gcc = "11.*"
gxx = "11.*"

[activation]
scripts = ["scripts/patch_shared_ptr.sh"]
```

Point the build at conda's cross-compiler triplet explicitly if `gcc`/`g++` on `PATH` could still resolve to the system compiler:
```toml
[activation.env]
CXX = "$CONDA_PREFIX/bin/x86_64-conda-linux-gnu-g++"
CC  = "$CONDA_PREFIX/bin/x86_64-conda-linux-gnu-gcc"
```

Using the `pixi-build` preview backend (`workspace.preview = ["pixi-build"]`) instead of hand-pinning `gcc`/`gxx`: request the CUDA compiler through the variant system rather than a manual dependency.
```toml
[package.build.config]
compilers = ["cxx"]

[package.build.target.linux-64.config]
compilers = ["cxx", "cuda"]   # NVIDIA CUDA compiler, Linux/Windows only (limited macOS)

[workspace.build-variants]
c_compiler_version = ["11.4"]   # pin the version through the variant, not a manual gcc dependency
```

## 6. Activation env vars

```toml
[activation.env]
# CUDA toolkit headers/libs live under targets/<arch>/, not $CONDA_PREFIX directly.
CUDA_HOME = "$CONDA_PREFIX/targets/x86_64-linux"
CPATH     = "$CONDA_PREFIX/targets/x86_64-linux/include:$CPATH"
# nvvm (needed by nvcc/NVRTC) isn't on the default conda bin/.
PATH = "$CONDA_PREFIX/nvvm/bin:$PATH"
# Conda's CUDA runtime libs resolve ahead of any system/pip-bundled ones —
# lets a cu128 torch wheel run on an older host driver via forward-compat.
LD_LIBRARY_PATH = "$CONDA_PREFIX/lib"
```

Compute-capability targeting for building CUDA extensions — hardcode when the deployment GPU is known, autodetect when it isn't:
```toml
# Hardcode for a known deployment GPU (skips enumerating unsupported archs, faster build).
TORCH_CUDA_ARCH_LIST = "12.0"
```
```toml
# Autodetect at activation time so the same pixi.toml works on any machine.
CUDA_ARCH = "$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | tr -d '.')"
```
Feed the detected arch into CMake or raw nvcc:
```toml
[tasks]
configure = { cmd = ["cmake", "-GNinja", "-DGGML_CUDA=ON", "-DCMAKE_CUDA_ARCHITECTURES=$CUDA_ARCH", "-B", "build"] }
```
```toml
[tasks]
build-kernel = "nvcc kernel.cu -std=c++20 -O3 --use_fast_math -arch=sm_$CUDA_ARCH --generate-code arch=compute_$CUDA_ARCH,code=sm_$CUDA_ARCH --expt-extended-lambda -I$CONDA_PREFIX/include -L$CONDA_PREFIX/lib -o build/kernel"
```
(`8.9` → `89` via `tr -d '.'` to match nvcc's `sm_89` / CMake's numeric-only `CUDA_ARCHITECTURES`.)

## 7. PyTorch / CUDA wheels via PyPI

Pick **one** source for torch (conda-forge, PyPI, or the legacy `pytorch` channel) and don't mix — if torch comes from PyPI, every package that depends on torch must also come from PyPI, because conda deps resolve before PyPI deps and can't depend back on them.

Per-package index, version left open — only the CUDA build tag is pinned via the index:
```toml
[pypi-dependencies]
torch = { version = ">=2.5.1", index = "https://download.pytorch.org/whl/cu124" }
torchvision = { version = ">=0.20.1", index = "https://download.pytorch.org/whl/cu124" }
```
Known index URLs: `.../whl/cpu`, `.../whl/cu118`, `.../whl/cu121`, `.../whl/cu124`, `.../whl/rocm6.2`.

Cross-platform split — macOS has no CUDA, fall back to the cpu index via a target block:
```toml
[target.osx.pypi-dependencies]
torch = { version = ">=2.5.1", index = "https://download.pytorch.org/whl/cpu" }
torchvision = { version = ">=0.20.1", index = "https://download.pytorch.org/whl/cpu" }
```
Resolving CUDA PyPI torch from a macOS host doesn't work: pixi solves PyPI deps *inside* a conda solve environment, and macOS can't carry the CUDA conda virtual package needed for that solve step even when only targeting Linux/Windows for the actual install. Run that lock/install step from a Linux or Windows host instead.

Workspace-wide index, needed when *other* packages besides torch (e.g. torchcodec, xformers) must also resolve from the CUDA index:
```toml
[pypi-options]
extra-index-urls = ["https://download.pytorch.org/whl/cu128"]
index-strategy   = "unsafe-best-match"   # let uv pick best version across indices, not exhaust one first
```

NVIDIA's own PyPI index, for packages not on conda-forge or PyPI proper (e.g. TensorRT):
```toml
# TensorRT engines are machine-local artifacts; keep ONNX portable and
# rebuild engines per target GPU rather than baking one into the lock.
tensorrt-cu12 = { version = "==10.13.3.9", index = "https://pypi.nvidia.com" }
```

Direct wheel URL, when a prebuilt CUDA extension's compatibility is encoded in the filename and the resolver should be bypassed entirely:
```toml
flash-attn = { url = "https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1+cu12torch2.5cxx11abiFALSE-cp310-cp310-linux_x86_64.whl" }
```

### Diagnosing PyPI torch resolution failures

- **ABI tag mismatch** (`torch==X has no wheels with a matching Python ABI tag`) — the pinned `python` version has no matching torch wheel (e.g. torch not yet fully supporting 3.13); lower `requires-python`/`python`.
- **Platform tag mismatch** (`torch==X+cu124 has no wheels with a matching platform tag`) — a CUDA-tagged wheel was requested on a platform without one (e.g. `cu124` on osx); use the correct index per platform.
- Sanity-check the active env: `pixi run python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"`.
- Check what CUDA pixi actually detected: `pixi info` → "Virtual packages" should list `__cuda=...`. If missing, confirm the driver with `nvidia-smi` and the toolkit with `pixi run nvcc --version`.

## 8. Building CUDA extensions from source (setup.py / pip)

Extensions whose `setup.py` calls `torch.utils.cpp_extension` need torch importable *during* their own build — PEP 517 isolated builds hide it, so disable isolation just for those packages:
```toml
[pypi-options]
# MinkowskiEngine and pointnet2 need torch/numpy at build time.
no-build-isolation = ["minkowskiengine", "pointnet2"]
```

Prebuilt CUDA wheels often carry stale/over-conservative pins on transitive deps (numpy especially) — override with an explicit comment recording the risk:
```toml
# nvblox_torch's published wheel pins numpy <1.27, but another dep needs
# numpy >=2. Override the resolver and verify compatibility empirically.
[pypi-options.dependency-overrides]
numpy = ">=2,<3"
```

Optional CUDA-compiled deps can fail non-fatally with a fallback:
```toml
[feature.x.tasks]
post-install = { cmd = "CUDA_HOME=$CONDA_PREFIX python -m pip install --no-build-isolation flash-attn || echo 'flash-attn skipped, using SDPA fallback'" }
```

Treat a manual CUDA extension build as a cacheable pixi task (skips rebuild when sources are unchanged):
```toml
[feature.x.tasks.build-cuda-kernels]
cmd = "python setup.py build_ext --inplace"
inputs  = ["setup.py", "src/*.cpp", "src/*.cu", "include/*.h"]
outputs = ["mypkg/_backend*.so"]
```

## 9. Structuring CPU vs CUDA variants

### Preferred: named platforms + `target` blocks, one environment

For the common "same package, CPU build on some machines / CUDA build on others" case, declare two named platform variants and let a `target` block pick the right dependency per platform, all inside one environment:

```toml
[workspace]
platforms = [
  # Listed first, so it wins platform selection on a machine with a CUDA driver.
  { name = "linux-64-cuda", platform = "linux-64", cuda = "12.0" },
  { name = "linux-64-cpu", platform = "linux-64" },
]

[target.linux-64-cuda.dependencies]
cuda-version = "12.6.*"
pytorch-gpu  = "*"

[target.linux-64-cpu.dependencies]
pytorch-cpu = "*"
```
Both platforms belong to the same environment but are solved separately, so `pixi.lock` holds a CUDA *and* a CPU-only package set. Exercise one or the other with `pixi run --platform linux-64-cpu ...` / `--platform linux-64-cuda ...`.

**Gotcha:** name both variants explicitly. A bare `"linux-64"` entry combined with `[target.linux-64.dependencies]` matches *every* rich platform sharing that subdir, including `linux-64-cuda` — `pytorch-cpu` and `pytorch-gpu` would land in the same solve and conflict.

Several platforms sharing config can use a wildcard target selector instead of repeating blocks (matched against the platform *name*, later selector wins on overlap):
```toml
[workspace]
platforms = [
  { name = "cuda-win-64", platform = "win-64", cuda = "12" },
  { name = "cuda-linux-64", platform = "linux-64", cuda = "12" },
  "win-64", "linux-64",
]

[target."cuda-*".tasks]
test = "python test.py --cuda"
```

### Alternative: a genuinely separate `cuda` feature/environment

Reach for a real separate environment (not just a target block) when the CUDA variant needs a fundamentally different dependency set or task list, not just a different torch build — e.g. a heavier toolchain, different channels, or extra tools only relevant to GPU workflows:

```toml
[feature.cuda]
platforms = ["linux-64-cuda"]   # bind to the rich platform name declared in workspace.platforms

[feature.cuda.dependencies]
cuda-toolkit = ">=12.0,<13"
gcc = "12.*"
gxx = "12.*"

[environments]
default = { features = ["base"] }
cuda     = { features = ["base", "cuda"], solve-group = "cuda" }
```

Give a CPU-only variant of a torch-dependent feature when it only needs torch for a lightweight non-GPU computation, to avoid solving the entire CUDA stack for that environment:
```toml
[feature.metrics-only.dependencies]
pytorch-cpu = ">=2.8.0"   # no CUDA requirement — used only for CPU metrics
```

Multiple full CUDA-toolkit variants side by side, selected at install time (`pixi install -e cu118`):
```toml
[environments]
default = { features = ["base", "cu121", "vis"], solve-group = "cu121" }
cu118   = { features = ["base", "cu118", "vis"], solve-group = "cu118" }
```
`solve-group` batches sibling environments (e.g. a tool and its `-dev` variant) so they resolve to identical shared-dependency versions instead of drifting independently.

Cheap diagnostic task to confirm the active env actually got a CUDA-enabled build before running anything heavy:
```toml
[feature.cuda.tasks]
check-cuda = "python -c \"import torch; print(torch.__version__, torch.cuda.is_available(), torch.version.cuda)\""
```

Task-level (not global) opt-out of GPU-only tests, cheaper than a whole feature:
```toml
[tasks]
test-gpu = "EMBODIK_GPU_TESTS=1 pytest test/test_gpu_solver.py -v"
```

## 10. Document runtime GPU tuning in-line

Record the reasoning behind a serving config's numbers next to the flag, not just the number itself:
```toml
[feature.serve.tasks]
serve = { cmd = """vllm serve {{ model }} \
    --gpu-memory-utilization 0.92 \
    --max-num-batched-tokens 8192 \
    --max-model-len 16384""" }
    # 0.92 / 8192 / 16384 tuned for a single 24GB consumer GPU — see KV-cache
    # bytes/token math in docs/vllm-sizing.md; defaults assume ≥80GB server GPUs.
```

## Checklist

- Don't declare `cuda` on a platform reflexively — only packages that branch on `__cuda` need it (§1).
- `[system-requirements]` is deprecated (still parses) — write new manifests with rich `workspace.platforms` entries (§2); migrate existing ones with `pixi workspace platform add/edit`.
- `cuda = "X"` on a platform is a solve-time floor, not the installed version — don't confuse it with `cuda-version`, which pins the actual toolkit release.
- Always pair individual `cuda-*`/`lib*-dev` pins with a matching `cuda-version = "X.Y.*"` so the solver can't split them across releases.
- If nvcc build errors mention `host_config.h` or an unsupported GCC version, pin `gcc`/`gxx` down (not up) to the CUDA release's supported ceiling — check NVIDIA's official host-compiler support matrix for the exact bound, don't guess.
- `CUDA_HOME` from a conda `cuda-*` package lives at `$CONDA_PREFIX/targets/<arch>`, not `$CONDA_PREFIX` — plain `CUDA_HOME=$CONDA_PREFIX` breaks builds expecting the standard NVIDIA layout.
- `channel-priority = "strict"` plus explicit `pytorch`/`nvidia` channel order is required to avoid silently getting a CPU-only `pytorch` from conda-forge.
- Pick exactly one source for torch (conda-forge, PyPI, or legacy `pytorch` channel) — mixing conda torch with PyPI packages that depend on torch (or vice versa) fails because conda deps resolve before PyPI deps.
- A bare `"linux-64"` target block also matches named CUDA variants of that subdir (`linux-64-cuda`) — name both variants explicitly or you'll get conflicting torch builds in one solve.
- Packages needing torch at build time (CUDA `setup.py` extensions) need `no-build-isolation`, not just a `[build-system]` dependency.
- TensorRT/engine artifacts are GPU-specific compiled binaries — don't pin them into a portable lockfile; pull the library via pip and rebuild the engine as a separate task per target machine.
- Resolving CUDA PyPI torch from a macOS host doesn't work (the PyPI solve step needs a conda env that can't carry the CUDA virtual package on macOS) — do that lock/install step from Linux or Windows.
- Use `pixi info` to check what pixi actually detected/selected (virtual packages, channel order, minimum platform); use `CONDA_OVERRIDE_CUDA=...`/`CONDA_OVERRIDE_CUDA=""` to solve as a different or absent driver, e.g. on CPU-only CI.
