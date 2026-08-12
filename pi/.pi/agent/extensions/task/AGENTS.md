# Project Contract

## Objective

One command carries one task from an idea to a branch of finished phases: research and design with
the operator present, then one fresh implementer per phase, with every gate a keypress and every
piece of state a file the operator can edit.

## Requirements

- R1: A task moves through five stages — questions, research, design, phases, implement — and the
  stage is derived from which artifact is missing: `questions.md`, then any note in `research/`,
  then `plan.md`, then any file in `phases/`. `/task` enters the current stage; `/task <slug>`
  resumes an autocompleted task; bare `/task` resolves the session's task from the branch of its
  working directory, else from the session name, else opens the picker.
- R1a: Each stage receives only its own brief and the paths of the artifacts before it, and starts
  from a clean context: every stage brief is marked in the session, and a later stage navigates back
  to the entry before the first mark. The anchor is therefore the session's own record and survives
  a resume. The abandoned branch remains in the session tree, and the session itself is never
  replaced — a replacement would arrive without R6's hold, because `session_start` fires before
  anything can tell the new extension instance which task it belongs to.
- R1b: `/task <slug> <stage>` enters any stage, finished or not. There is no redo mode: the brief
  reads what is on disk, so it asks for a revision exactly when the artifact is there. An artifact
  is never deleted or moved aside, and the stage reports which later artifacts may no longer agree
  rather than changing them. Redoing one phase is `phase set-status <name> open`.
- R2: The picker lists every readable task with its derived progress, creates a task only through
  an explicit `+ new task` entry, and deletes one only behind a confirmation naming the task
  directory, the worktree, and how much uncommitted work that worktree holds. A delete removes
  those two and nothing else — the branch is kept. Commits are never counted, because the branch
  survives; a worktree whose state cannot be read is reported as unknown rather than as clean.
- R3: A task directory has two halves. The extension's — `task.json` (repository, base branch,
  description; written once, at creation, and never updated) and `phases/`, one file per phase as a
  single JSON header line (`title`, `status`), a blank line, then prose — and the models' `notes/`,
  holding one file per stage: `questions.md`, `research.md`, `plan.md`. No brief names anything
  outside `notes/`, and the `phase` tool is the only way a model reaches a phase.
- R3a: The worktree is `../<repository>-<slug>` and is never recorded. Whether it exists is what
  separates planning from implementing, so that question is asked of the filesystem.
- R4: Phase order is the `NN-` filename prefix; a phase is identified by its file stem. Adding,
  reordering, and removing phases with an editor is equivalent to doing it through the tool.
- R5: The `phase` tool (`list`, `show`, `create`, `set-status`) is registered unconditionally and
  resolves its task from the working directory, so a planning session and an implementer child use
  the same one. Every call renders as a single transcript line.
- R6: A session is planning exactly while the task it drives has no worktree, and that is decided
  per tool call from `task.json` — no mode is entered or left, and no toolset is borrowed. While
  planning, only read/grep/find/ls/bash/write/edit/delegate/phase may run: `write` and `edit` are
  confined to `notes/`, `bash` to commands that do not obviously write or install, and
  `delegate` to the research agents. Any other tool is refused by name, so one registered after the
  session started is governed too.
- R7: Each phase runs as one fresh implementer child with the worktree as its working directory,
  the `phase` tool added to its declared tools, and the parent's model and thinking level. The
  extension stops after every phase.
- R8: A phase is complete when its file says so. While the child runs, its most recent steps appear
  in the widget; when it ends, one transcript entry carries the outcome, the child's report, every
  step it took, and the command that opens the child's own session. Neither starts a turn.
- R9: Escape during a phase run stops the child and is consumed, so it reaches nothing else. The
  phase stays open, its report says how far it got, and `/task` starts a fresh child from the tree
  as it then stands.

## Invariants

- I1: No model orchestrates the loop. Every transition is code, driven by an operator keypress.
- I2: Children cannot delegate (the runner never grants `delegate`), so no child can start a review,
  an audit, or another implementer.
- I3: The extension performs exactly two Git writes — `worktree add` at R1's worktree step and
  `worktree remove` at R2's delete — each behind its own confirmation. `--force` is passed exactly
  when the confirmation said what would be discarded. No branch is ever deleted, and nothing is
  staged, committed, merged, rebased, or pushed.
- I4: The extension runs no lint, test, or build command. Verification is whatever the repository
  documents, found during research, written into the phase, and run by the implementer.
- I5: State is the task directory. Nothing is stored in the session, and nothing task-related is
  ever written into the repository under work.
- I7: What the extension parses, the models cannot write. `task.json` is written only by the
  extension and `phases/` only through the `phase` tool, so a corrupt structured file cannot arrive
  from a model — and neither is named in any brief, so the confinement is a backstop rather than a
  refusal anyone meets. The operator's editor still owns every file; a hand-edited header stops
  `/task` with the file and field named, and nothing else.
- I6: No state is decided by parsing. Structure from a model arrives through JSON-Schema-validated
  tool parameters; structure from disk is one `JSON.parse` and field checks that name what to fix.
  Exactly one string is inspected — a planning-stage bash command, in `bash-guard.ts` — and it
  decides whether to allow a command, never what the state is.

## Constraints

- C1: `/task` requires the interactive TUI and an idle session.
- C2: A slug is lower-case letters, digits and single dashes, at most 48 characters. It is the
  directory name, the branch name and the task's identity at once, and it is claimed against both
  at creation. A name already taken is returned to the model with the reason, once; a second
  collision fails the command.
- C3: The worktree is `../<repository>-<slug>`, forked from the branch recorded at task creation.
- C4: One named model names the task, through one constrained tool call at low reasoning. An
  unavailable model, a failed request, an answer that is not that tool call, or a name that is not
  a free slug all fail the command and say so. There is no second model and no typed-name prompt:
  a repaired or substituted name is a different task wearing the same one.
- C5: `tasks.ts` and `git.ts` depend on `node:` builtins only, and are tested directly.

## Assumptions

- A1: One worktree belongs to one task, and one session drives one task at a time. Concurrent tasks
  are separate worktrees. Nothing locks a phase: two sessions told to run the same one will both run
  it, and that is operator error rather than a case to defend against.
- A2: `scout` and `researcher` are read-only by instruction, not by capability — both declare
  `bash`, and a delegated child is a separate process this extension's gate never sees. R6 fences
  which roles may be delegated to, which is what stops the planner reaching implementation; what a
  research child does inside its own run is its prompt's business.
- A5: R6's bash check is a drift guard, not a sandbox: it denies the commands that write rather
  than allowing a list of commands that read, so an unusual read-only command still runs and a
  command determined to get around it can. What cannot be got around is that `edit` and `write`
  reach only the task directory. An OS sandbox is available through pi's `createBashTool`
  `spawnHook`, at the cost of a dependency, and is the operator's decision rather than a default.
- A3: The operator edits the task directory freely, including fixing a phase whose child died after
  finishing the work. A broken header stops `/task` with the file and the field named.
- A4: What happens between phases — review, commit, test, nothing at all — is the operator's, and
  the extension neither prompts for it nor records it.

## Non-Goals

- N1: No opinion about reviewing, committing, or verifying between phases.
- N2: No budgets, step limits, retry, resume, or multi-phase batching.
- N3: No automatic merge, cleanup, or branch policy.
- N4: No second source of progress: no session entries, no checkboxes, no counters.
