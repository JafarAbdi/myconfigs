# SSH extension

Remote SSH mode for pi tools.

## Start

```bash
pi --ssh desktop.local:/workspace
```

This extension auto-loads from `~/.pi/agent/extensions/ssh/` on every `pi` start. It registers execution-tool overrides only when `--ssh` or persisted SSH state is active.

`--ssh` accepts:

```text
user@host
user@host:/remote/path
host:/remote/path
```

## Behavior

- `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, and user `!` commands always run
  on the SSH remote.
- Relative paths resolve against the remote cwd selected at startup. Absolute paths are remote absolute paths.
- The remote cwd is fixed for the session; select it with `--ssh user@host:/remote/path`.
- `host_bash` runs on the host machine running Pi, with Pi's local cwd. It is available
  only while SSH mode is active. Use it for every host-local command or file, including Pi
  docs, extensions, skills, prompts, and agent config.
- Host and remote cwd are independent. Paths never select a machine implicitly.
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

SSH mode requires ownership of its execution tools so every tool has one unambiguous machine target. If another extension registers `read`, `write`, `edit`, `bash`, `host_bash`, `ls`, `find`, or `grep`, SSH startup fails with the conflicting owner path. Change those extensions to use policy hooks instead of registering execution tools.

## Tool bootstrap

If remote `fd`, `rg`, or `fzf` is missing, pi detects the remote's architecture (Linux `amd64` or `arm64`), downloads and caches that tool's binary on the host, then uploads it to the remote. `fzf` ranks `@` path autocomplete candidates. If remote `uv` is available, pi also installs Python command wrappers that route agents toward `uv`. Both host cache and remote install use:

```text
~/.cache/pi/ssh-tools/
  search-tools/
    linux_amd64/{fd,rg,fzf}
    linux_arm64/{fd,rg,fzf}
  python-uv-commands/
```

A cached tool is reused as-is once present, on both host and remote — bumping a pinned version has no effect until the cached file is removed by hand.

## Delegates

After SSH connects, `delegate` offers Pi models only. Omitting its `model` uses the current Pi model.
The parent bootstraps remote helper tools once; delegated Pi children inherit the resolved paths and
run their file and shell tools through SSH without installing anything remotely.

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
```
