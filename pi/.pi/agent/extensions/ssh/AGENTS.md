# Project Contract

## Objective

Give Pi's core file, search, and shell tools a transparent SSH-remote backend — one remote host
becomes the target for `read`/`write`/`edit`/`ls`/`find`/`grep`/`bash`/user `!` — alongside
independent host-local execution, with no per-invocation remote re-provisioning.

## Requirements

- R1: `--ssh user@host[:/path]`, or persisted session state when `--ssh` is omitted, establishes
  exactly one remote target at `session_start`. Absent both, SSH mode stays fully inactive and
  registers no tool overrides.
- R2: Once active, `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash`, and user `!` commands run
  only on the remote. `host_bash` runs only on the host machine, with the host's own cwd, and is
  available only while SSH mode is active.
- R3: SSH mode owns its execution tools exclusively: startup fails, naming the conflicting owner,
  if any other extension has already registered `read`/`write`/`edit`/`bash`/`host_bash`/`ls`/
  `find`/`grep`.
- R4: `/ssh-cd <dir>` changes and persists the remote cwd, supports remote-directory autocomplete
  (`-h` to include hidden entries), and only runs while the agent is idle.
- R5: `@`-mention autocomplete resolves against the remote filesystem, ranked through remote `fzf`.
- R6: A session resumed without `--ssh` reconnects automatically from persisted remote+cwd;
  reconnect failure fails startup rather than silently falling back to local execution.
- R7: A delegated child Pi process inherits its parent's already-bootstrapped connection (remote
  cwd, remote home, `fd`/`rg`/`fzf` paths, python-uv command dir) from an env-var descriptor, and
  never re-probes or re-installs remote tooling.
- R8: Missing remote `fd`/`rg`/`fzf` are downloaded (host-cached per platform, uploaded) and
  installed on demand; missing remote `uv` triggers installing `uv`-routed Python command wrappers.
  A tool already cached on the host, or already present on the remote, is reused as-is — bumping a
  pinned version has no effect until the stale cached file is removed by hand (matches pi's own
  local tool cache: existence, not version, is the only check).
- R9: The system prompt's cwd line is rewritten to show the remote cwd/host on a best-effort basis;
  a prompt-format mismatch must degrade to a clearly surfaced, non-silent warning — never a
  silently wrong cwd baked into the model's context for the rest of the session.

## Invariants

- I1: Host and remote cwd are always independent; no tool infers which machine a path targets —
  paths are never resolved ambiguously.
- I2: Every remote command runs under clean bash (`env -u BASH_ENV bash --noprofile --norc`),
  unaffected by the remote user's shell rc files.
- I3: A delegate child only ever reads a connection descriptor; it never publishes or clears one,
  and never re-bootstraps tools a parent already resolved.
- I4: Closing a connection terminates every local `ssh` child process it spawned; no subprocess
  outlives `session_shutdown`.
- I5: A cache-miss or connection-state signal is never inferred from matching an error-message
  substring — only from the actual, typed absence of the resource.

## Constraints

- C1: No SSH multiplexing options are passed by this extension; connection reuse is entirely the
  user's own `~/.ssh/config` responsibility (`ControlMaster`/`ControlPersist`).
- C2: Cache layout is fixed under `~/.cache/pi/ssh-tools/{search-tools,python-uv-commands}` on host
  and remote, plus `.../runs/` for remote PID files.
- C3: Remote tool versions are pinned constants in code; changing them is an explicit code change,
  never automatic discovery.
- C4: Error messages surfaced across the extension follow one shape (`"<action> failed:
  <target>\n<cause>"`); no call site invents its own template.

## Assumptions

- A1: The remote host is Linux, amd64 or arm64; any other OS/arch is rejected at bootstrap.
- A2: The remote accepts non-interactive, key-based `ssh <remote> <command>` and has a POSIX-ish
  `bash`.
- A3: Pi's system-prompt "Current working directory: <cwd>" line stays textually stable enough to
  pattern-match; there is currently no other seam in Pi to inject the remote cwd (confirmed:
  `buildSystemPrompt` is not part of Pi's extension-facing export surface).

## Non-Goals

- N1: No Windows/macOS remote support.
- N2: No SSH connection-multiplexing management by this extension — purely a documented
  user-config expectation, not a runtime check.
- N3: No mid-session transport health-check or auto-reconnect — every remote command is its own
  fresh `ssh` invocation, so there is no persistent connection to go stale.
- N4: No general remote package manager — only `fd`/`rg`/`fzf` and `uv`-wrapped Python commands are
  bootstrapped.
