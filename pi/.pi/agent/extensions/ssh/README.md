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

## Upgrade

Install the remote requirements below, update these configs, and restart Pi. The extension no longer downloads remote tools.

Old SSH sessions containing the removed `version` field need one explicit reconnect:

```bash
pi --ssh host:/remote/path --resume
```

Old bootstrap caches are unused and may be removed:

```bash
rm -rf ~/.cache/pi/ssh-tools
ssh host 'rm -rf ~/.cache/pi/ssh-tools'
```

## Requirements

The remote must provide:

```text
bash
setsid
fd
rg
fzf
```

Its SSH server must enable the SFTP subsystem.

## Transport

Files use one persistent typed SFTP v3 session:

```text
ssh -s <target> sftp
```

Commands use ordinary OpenSSH sessions and clean, non-login Bash. Only `PI_*` execution variables are forwarded. OpenSSH connection reuse remains controlled by `~/.ssh/config`.

Cancellation sends `TERM` to the remote process group, then `KILL` if needed. Loss of termination confirmation is reported.

## Delegation

Delegated Pi and Claude MCP children inherit only `{ remote, remoteCwd }`; each opens its own OpenSSH command and SFTP processes. Malformed child state fails closed.

## Smoke test

```text
Use the bash tool to run exactly:
find . -maxdepth 1 -mindepth 1 -printf '%f\n' | sort
```

```text
Using only write, read, edit, and ls—never bash—create /tmp/pi-sftp-test.txt, read it, edit it, read it again, then list /tmp.
```
