# JURUC C5 Contract

## Objective

Run one strict Questions → Research → Specification → Plan → Implementation workflow with fresh bounded sessions, durable authoritative artifacts, deferred workspace activation, phase-declared verification, and extension-owned local commits. Provide isolated advisory deviation and correctness reviewer primitives without making review reachable from the task lifecycle.

## Lifecycle

- Stages are exactly `questions`, `research`, `specification`, `plan`, `implementation`, and `done`.
- `task.json` version 4 has no compatibility parser.
- Transitions move forward only. Plan has two valid states: planning with `plan: null`, and accepted activation-pending with an immutable plan. `activateTaskPlan` alone advances the accepted plan to Implementation.
- Plan acceptance is persisted before any task branch or worktree side effect. An activation failure leaves the accepted plan pending; `/juruc` retries workspace preparation directly and never asks the model to re-plan.
- Pending Plan displays `plan accepted · activation pending` and its old Plan session has zero active tools.
- Failed implementation verification leaves the active phase open and resumable. There is no blocked lifecycle, backtracking, replanning, renewed research, or plan extension.

## Artifacts

- Questions records confirmed shared understanding, unique decisions, accepted assumptions, and factual research targets.
- Research always runs. Exact UTF-8 synthesis bytes are atomically saved to fixed task-directory `research.md`; its current regular-file contents are authoritative.
- Specification records implementation-neutral summary, requirements, non-goals, constraints, acceptance criteria, and decisions.
- The explicitly accepted Plan is immutable and contains ordered final-shape phases with unique kebab-case IDs, titles, goals, safe repository-relative Git pathspec scopes, instructions, and exact verification commands.
- Completed phases are stored once in append-only `checkpoints`. Every checkpoint copies its accepted phase and adds ordered all-zero verification evidence, resolution, and commit OID.
- Session history is one append-only typed list with globally unique absolute paths and logical scopes.

## Information Diets and Tools

- Questions receives only the original request and read-only source repository access.
- Research receives only the request, confirmed Questions result and targets, and source repository; it is delegate-only and a synthesizer must be the sole call.
- Specification receives only the request, confirmed Questions result, and current research text. It runs from the task directory with only `juruc_set_specification`.
- Plan receives only validated Specification and read-only source repository access. It calls `juruc_set_plan` only after explicit human acceptance.
- Implementation receives only validated Specification, its authoritative phase, and relevant checkpoint facts. Its tools are read/edit/write/grep/find/ls, `juruc_run_verification`, and `juruc_finish_phase`; it has no unrestricted shell and cannot commit.
- Model workflow tools are exactly `juruc_set_questions`, `juruc_set_specification`, `juruc_set_plan`, `juruc_run_verification`, and `juruc_finish_phase`.
- Every workflow tool requires the active task-owned session, correct working directory, registration, and a sole tool call. Stale task sessions have zero tools and block every tool call with `/juruc` guidance; non-task sessions retain normal tools.
- `juruc_run_verification` runs only an exact command from the active human-accepted phase in the managed worktree, with bounded time and output. The model may rerun commands and then submit exact structured evidence to `juruc_finish_phase`; JURUC reruns every declared command in order and requires real zero exits immediately before staging.

## Deferred Workspace

- Task creation validates/prepares source Git and persists desired `branch` and `worktree` identities, but creates neither task branch nor worktree.
- After durable Plan acceptance, JURUC idempotently ensures the exact branch/worktree at `sourceHead`, copies approved local files, validates a clean activation workspace, persists activation, and only then creates phase 1's fresh session.
- Retry may adopt an exact branch-only interruption, prune an exact stale missing worktree registration, or reuse an exact prepared workspace. It never moves or deletes an existing branch/ref and rejects conflicting registrations, paths, repositories, branches, heads, or candidates.
- Local-file copying is limited to root regular `.env*`, root `CLAUDE.local.md`, and `.claude/settings.local.json`. It is non-recursive, rejects symlinks/non-files, preserves bytes and mode, preflights every path, syncs files before replacement and affected directories afterward. Any copy or final validation failure durably restores the exact prior destination set. Missing files and root `.env*` directories are skipped.
- After copying, ignored locals may exist but ordinary Git status must be clean at `sourceHead`, preventing later checkpoint staging from capturing unapproved local files.

## Persistence and Git Safety

- Persisted objects reject unknown fields, malformed values, duplicate normalized lists, unsafe scopes, duplicate phases/sessions, checkpoint drift, inconsistent stages, and repository descriptors not owned by the task slug/runtime worktree path.
- Save `task.json` and `research.md` durably with synced mode-0600 temporary files, atomic replacement, and containing-directory sync. Task-directory installation retries the tasks-parent sync without removing an installed directory; task-record deletion also syncs that parent.
- Every checkpoint requires a changed candidate, exact all-zero declared evidence, and every staged path matching active Git pathspec scopes. Rename inventories use `--no-renames`.
- JURUC alone stages and commits. It never pushes or publishes.
- Before implementation resumes, descendant commits absent from `task.json` reset mixed to the latest recorded task head, preserving file changes. After an uncertain checkpoint save, reload exact `task.json`: recover only an installed old document, retry durability for an installed new checkpoint, and never move history for ambiguous state. Divergence fails; recorded checkpoint commits remain immutable.
- Task deletion removes only an exact registered managed worktree, if present, then task state; the task branch is retained. Pre-workspace, branch-only, and unmanaged-path cases never delete unrelated paths.

## Advisory Reviewers

- C5 defines two reviewer kinds: factual deviation and bounded correctness. They are deliberately unreachable from `task.json`, `/juruc`, and extension tools until C6; there are no review stages, rounds, transitions, or index wiring.
- Deviation receives only validated Specification, accepted Plan authoritative phase fields, cumulative patch identity/text, and projected checkpoint verification evidence. It reports concrete divergence from required or accepted behavior, not style or speculation.
- Correctness receives only validated Specification, cumulative patch identity/text, and projected checkpoint verification evidence (phase id/title plus evidence). It receives no accepted Plan object, goals, scopes, or instructions and reports only concrete introduced correctness, security, data-loss, or error-handling defects.
- Each reviewer durably persists a fresh mode-0600 Pi session header and reviewer label before one model call, rooted at the task worktree with optional parent-session metadata. It loads no extensions/skills/prompts/themes/project context, has zero tools, uses normal configured model reasoning, and disables agent/provider retries and compaction only through non-persistent settings overrides.
- Patch content is untrusted data, never instructions. A reviewer emits exactly one final canonical JSON text block, optionally alongside normal thinking blocks. Parsing is byte-bounded, rejects duplicate object members and noncanonical escapes while allowing ordinary pretty whitespace/key order, is all-or-nothing and exact-field, and permits annotations only on exact changed-side lines in the immutable cumulative patch.
- Reviewer outcomes are advisory completed annotations or bounded `malformed-output`/`session-error` failures. Reviewers never retry, edit, execute, block, correct, or mutate task lifecycle state.

## Deferred Work

- Lifecycle-reachable review orchestration, authoritative review rounds, browser feedback, corrections, explicit final acceptance, and final review TUI remain C6+ work.
- No PR creation, push, deployment, publication, remote review, accounts, telemetry, or collaboration features.
