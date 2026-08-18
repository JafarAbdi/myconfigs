# podman-static

Builds a **static, musl-linked, rootless `podman` and its full runtime stack** in a container and
drops a portable tarball in `./out`. Podman isn't a single binary — it shells out to an OCI
runtime (crun/runc), conmon, netavark, aardvark-dns, pasta and fuse-overlayfs. All are built static
and run on any x86_64 / arm64 Linux with no library dependencies.

The build host needs only `docker` (or `podman`) with BuildKit — no toolchains.

## Host requirements (rootless)

Rootless podman needs two things the tarball can't ship (both root-only): the setuid
`newuidmap`/`newgidmap` helpers, and sub-UID/GID ranges for your user.

```sh
sudo apt install --no-install-recommends uidmap   # Fedora: shadow-utils · Alpine: shadow-uidmap
grep "$USER" /etc/subuid /etc/subgid              # each needs a line: <user>:100000:65536
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"   # if missing
```

## GPU (rootless, optional)

`--device nvidia.com/gpu=all` is a CDI *name*, not a device path — Podman resolves it from specs
in `/etc/cdi`, which the tarball can't ship. Generate it once with the NVIDIA Container Toolkit
(`nvidia-ctk`), and again after any driver update:

```sh
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list   # lists nvidia.com/gpu=all on success
podman run --rm --device nvidia.com/gpu=all nvidia/cuda:11.0.3-base-ubuntu20.04 nvidia-smi
```

## Use

```sh
just build            # -> out/podman-static-<version>-linux-<arch>.tar.gz
just build v6.1.0     # a specific podman version
just install          # extract to ~/.local, write ~/.config/containers, wrap podman, register generator
just uninstall        # remove wrapper, configs, generator, prefix, storage

ENGINE=podman just build          # build with rootless podman instead of docker
PLATFORM=linux/arm64 just build   # cross-build (needs qemu binfmt)
```

The tarball is self-contained: extract it anywhere (e.g. `/usr/local` system-wide) and podman finds
its helpers by default.

## Systemd health timers

Upstream's `systemd` tag couples pure-Go health timers to dynamic journald
support. The pinned patch adds a `systemd_health` tag that exposes only the
timer code, keeping the binaries fully static. It carries no config forwarding:
config lives in the standard XDG path (below), so transient health-check
services find it on their own. `git apply --check` makes drift fail.

## What `install` does

Config goes in the standard rootless location, `~/.config/containers/`, so every podman call —
including the transient systemd health-check services — discovers it with no `CONTAINERS_*` env:

- `containers.conf` — absolute paths to the relocated conmon, runtimes, and helpers (incl. pasta).
- `storage.conf` — the isolated graphroot. No `mount_program`: podman keeps its default
  native-or-fuse decision and falls back to the bundled fuse-overlayfs where the kernel requires it.
- `policy.json` — written only if absent (image pulls require it; shared, never rewritten).

`~/.local/bin/podman` is a thin wrapper whose only job is putting the bundle's `bin` on `PATH` so
podman can find fuse-overlayfs. It sets no `CONTAINERS_*` variables.

`install` also registers the rootless Quadlet generator (systemd has no HOME-local generator dir in
its default search path): it links the bundled generator into
`~/.local/lib/systemd/user-generators/` and writes a `~/.config/systemd/user.conf.d/` drop-in that
points the user manager at it, then reloads the manager. If `uv` is present, `podman-compose` is
installed as an isolated tool.

## Bundled versions

Pinned as `ARG`s in the `Containerfile` (override with `--build-arg`): podman `v6.1.0`, crun `1.28`,
runc `v1.4.3`, conmon `v2.2.1`, netavark `v2.1.0`, aardvark-dns `2d364eb`, pasta `2026_06_11`,
fuse-overlayfs `v1.16`, catatonit `v0.2.1`. (aardvark is a commit pin — its `v2.1.0` tag doesn't
build static-musl; the `Containerfile` explains why.)

## Bumping the podman version

netavark and aardvark-dns are coupled to Podman's **major** version (Podman 6.x needs 2.x). A bare
`podman run` won't reveal a mismatch because rootless uses pasta. Test `podman network create` too.
When changing `PODMAN_VERSION`, re-pin helpers near its release, then smoke-test both paths:

```sh
podman network create t && podman network rm t     # netavark
podman run --rm docker.io/library/alpine echo ok   # runtime + conmon
```

## Credit

Recipe adapted from [mgoltzsche/podman-static](https://github.com/mgoltzsche/podman-static)
(Apache-2.0); this repo carries it forward for podman 6.x. Per-component specifics are in the
`Containerfile` comments.
