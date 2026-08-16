# podman-static

Builds a **static, musl-linked, rootless `podman` and its full runtime stack** in a container and
drops a portable tarball in `./out`. podman isn't a single binary — it shells out to an OCI runtime
(crun/runc), conmon, netavark, aardvark-dns, pasta and fuse-overlayfs. All are built static and
bundled, so the binaries run on any x86_64 / arm64 Linux with no library dependencies.

The build host needs only `docker` (or `podman`) with BuildKit — no toolchains.

## Host requirements (rootless)

Rootless podman needs two things the tarball can't ship (both root-only): the setuid
`newuidmap`/`newgidmap` helpers, and sub-UID/GID ranges for your user.

```sh
sudo apt install --no-install-recommends uidmap   # Fedora: shadow-utils · Alpine: shadow-uidmap
grep "$USER" /etc/subuid /etc/subgid              # each needs a line: <user>:100000:65536
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"   # if missing
```

## Use

```sh
just build            # -> out/podman-static-<version>-linux-<arch>.tar.gz
just build v6.1.0     # a specific podman version
just install          # extract to ~/.local/lib/podman-static, wrap ~/.local/bin/podman
just uninstall        # remove wrapper, prefix, storage

ENGINE=podman just build          # build with rootless podman instead of docker
PLATFORM=linux/arm64 just build   # cross-build (needs qemu binfmt)
```

The tarball is self-contained: extract it anywhere (e.g. `/usr/local` system-wide) and podman finds
its helpers by default.

## What `install` does

`~/.local/bin/podman` is a small wrapper that points `CONTAINERS_CONF` / `STORAGE_CONF` /
`REGISTRIES_CONF` at the install prefix, so it's fully isolated from any other podman — its own
storage graph, its own config, nothing in `~/.config/containers/` rewritten. The sole exception is
`policy.json` (image pulls require it, no env override), written there only if absent. If `uv` is
present, `podman-compose` is also installed as an isolated tool.

## Bundled versions

Pinned as `ARG`s in the `Containerfile` (override with `--build-arg`): podman `v6.1.0`, crun `1.28`,
runc `v1.4.3`, conmon `v2.2.1`, netavark `v2.1.0`, aardvark-dns `2d364eb`, pasta `2026_06_11`,
fuse-overlayfs `v1.16`, catatonit `v0.2.1`. (aardvark is a commit pin — its `v2.1.0` tag doesn't
build static-musl; the `Containerfile` explains why.)

## Bumping the podman version

netavark and aardvark-dns are coupled to podman's **major** version (podman 6.x needs 2.x). A bare
`podman run` won't reveal a mismatch — rootless uses pasta — but `podman network create` / compose
does, failing with `netavark: unrecognized subcommand`. When you change `PODMAN_VERSION`, re-pin the
helpers to releases dated near it, then smoke-test both paths:

```sh
podman network create t && podman network rm t     # netavark
podman run --rm docker.io/library/alpine echo ok   # runtime + conmon
```

## Credit

Recipe adapted from [mgoltzsche/podman-static](https://github.com/mgoltzsche/podman-static)
(Apache-2.0); this repo carries it forward for podman 6.x. Per-component specifics are in the
`Containerfile` comments.
