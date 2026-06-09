# SSH extension

Remote SSH mode for pi tools.

## Start

```bash
pi -e packages/coding-agent/examples/extensions/ssh.ts --ssh desktop.local:/home/juruc
```

The extension is safe to install globally. It registers execution-tool overrides only when `--ssh` or persisted SSH state is active.

`--ssh` accepts:

```text
user@host
user@host:/remote/path
host:/remote/path
```

## Commands

```text
/ssh-cd <remote-dir>
```

`/ssh-cd` supports remote directory autocomplete.

## Behavior

- `read`, `ls`, `find`, and `grep` run on the remote, except host-local pi runtime paths
  are read locally.
- `write` and `edit` run on the remote, except `~/.pi/agent`, this extension root, and the
  global `skills`/`prompts` dirs from settings are written locally. Pi package install paths
  are read-only.
- Relative paths resolve against the remote cwd. Absolute paths are remote absolute paths.
- `bash` always runs on the remote.
- `--ssh-debug-routing` prints local roots at startup and per-tool route decisions.
- `@` autocomplete uses the remote cwd.
- Footer shows `ssh host:/remote/cwd`.
- Remote commands run with clean bash:

  ```bash
  env -u BASH_ENV bash --noprofile --norc -c ...
  ```

- Pi passes no multiplexing options; connection reuse is expected from `~/.ssh/config`. Without it, every remote command pays a full SSH handshake. Assumed config:

  ```text
  Host *
      ControlPath ~/.ssh/sockets/%r@%h:%p
      ControlMaster auto
      ControlPersist 10m
  ```

  Keep `ControlPersist` bounded: a long-lived master captures `SSH_AUTH_SOCK` at startup, so an immortal master outlives agent restarts (e.g. wezterm's pid-based agent proxy) and breaks agent forwarding with `Permission denied (publickey)`. Recover with `ssh -O exit <host>` or by removing the socket.

## Execution tool ownership

SSH mode requires ownership of execution tools so all execution runs on the remote host. If another extension registers `read`, `write`, `edit`, `bash`, `ls`, `find`, or `grep`, SSH startup fails with the conflicting owner path. Change those extensions to use policy hooks instead of registering execution tools.

## Tool bootstrap

If remote `fd`, `rg`, or `fzf` is missing, pi downloads and caches Linux `amd64`/`arm64` binaries on the host, then installs missing tools on the remote. `fzf` ranks path autocomplete candidates (`/ssh-cd` and `@` references). If remote `uv` is available, pi also installs Python command wrappers that route agents toward `uv`. Both host cache and remote install use:

```text
~/.cache/pi/ssh-tools/
  search-tools/
  python-uv-commands/
```

## Resume

Sessions started with `--ssh` persist SSH target and remote cwd. Resuming without `--ssh` reconnects automatically. If reconnect fails, startup fails.

## Test

Inside pi:

```text
!pwd
!echo "$BASH_ENV"
!shopt login_shell
!fd --version
!rg --version
!fzf --version
```

Expected:

```text
BASH_ENV is empty
login_shell off
```

Autocomplete:

```text
@.ssh/con<Tab>
/ssh-cd work<Tab>
```
