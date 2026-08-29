# SSH extension

Runs Pi against a remote machine through the system OpenSSH client.

## Use

```bash
pi --ssh desktop.local:/workspace
```

Targets may be `host`, `user@host`, or either followed by `:/remote/path`. The target is passed unchanged to OpenSSH; `~/.ssh/config` is the only source for aliases, authentication, host verification, proxies, and multiplexing.

In SSH mode:

- `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, and `!` target the remote.
- `host_bash` targets the machine running Pi.
- Relative paths use the fixed remote cwd selected at startup.
- `@` completion searches the remote cwd.
- Failed or malformed SSH state never falls back to local execution.

## Requirements

The remote must provide `bash` and `setsid`, and its SSH server must enable the SFTP subsystem.

Pi uses a remote-native `fd`, `rg`, or `fzf` when `command -v` finds it. Otherwise it reuses an executable in:

```text
<remoteHome>/.cache/pi/ssh-tools/{fd,rg,fzf}
```

If any lookup misses, the remote must be Linux on `x86_64`/`amd64` or `aarch64`/`arm64`. Pi downloads the pinned GitHub release directly into the corresponding host cache:

```text
~/.cache/pi/ssh-tools/linux_amd64/{fd,rg,fzf}
~/.cache/pi/ssh-tools/linux_arm64/{fd,rg,fzf}
```

The platform is the remote platform, not the host platform. Downloads use no release API or SHA checksum. The pinned release assets are:

- `fd`: `unknown-linux-musl` for both amd64 and arm64.
- `rg`: `unknown-linux-musl` for both architectures.
- `fzf`: static Go release binaries for both architectures.

Archives are temporary; only the executable is atomically placed. Uploads use the persistent SFTP connection and are atomically moved into the remote cache.

Both caches are existence-only: an existing executable is reused unchanged, regardless of its version. Pinned versions apply only when a host cache entry is absent. Remove an individual entry to replace it on the next connection. During parent and delegated-child startup, the existing `ssh` status reports `connecting`, `checking tools`, and any `downloading <tool>` or `uploading <tool>` phase live.

## Transport

Files use one persistent typed SFTP v3 session:

```text
ssh -s <target> sftp
```

Commands use ordinary OpenSSH sessions and clean, non-login Bash. `bash` and user `!` execution prepend the remote tool cache to `PATH`; only supplied `PI_*` local environment variables are forwarded. Internal find, grep, and autocomplete commands use the resolved absolute tool paths. OpenSSH connection reuse remains controlled by `~/.ssh/config`.

Cancellation sends `TERM` to the remote process group, then `KILL` if needed. Loss of termination confirmation is reported.

## Delegation

Delegated Pi and Claude MCP children inherit only `{ remote, remoteCwd }`; each opens its own OpenSSH command and SFTP processes. A child repeats the cheap native/cache lookup and normally reuses the populated remote cache. Malformed child state fails closed.

## Smoke test

```text
Use the bash tool to run exactly:
find . -maxdepth 1 -mindepth 1 -printf '%f\n' | sort
```

```text
Using only write, read, edit, and ls—never bash—create /tmp/pi-sftp-test.txt, read it, edit it, read it again, then list /tmp.
```
