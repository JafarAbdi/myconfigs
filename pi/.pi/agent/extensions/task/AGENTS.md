# Project Contract

## Objective

One command carries one task from an idea to finished phases: one persistent Pi session per planning
stage with the operator present, then one fresh implementer child per phase, with every gate a
keypress and every piece of task state a file the operator can edit.

## Requirements

- R1: A task moves through five stages — questions, research, design, phases, implement — and the
  stage is derived from which artifact is missing: `questions.md`, then any note in `research/`,
  then `plan.md`, then any file in `phases/`. `/task` enters the current stage; `/task <slug>`
  resumes an autocompleted task; `/task <slug> <stage> [new]` autocompletes every argument; bare
  `/task` resolves the session's task from its stage marker, else from the branch, else opens the
  picker.
- R1a: Each planning stage owns one persistent Pi session named `<slug> · <stage>`. First entry
  creates it and records standard model/reasoning entries plus a structured task/stage marker before
  sending that stage's brief. The replacement runtime restores those standard entries. Later
  `/task <slug> <stage>`
  searches Pi sessions with that name, switches to the newest matching marked session and sends no
  message. If it is already active, nothing runs. `/task <slug> <stage> new` always creates a fresh
  marked child session and sends the brief; older sessions remain in `/resume`. The session marker
  is identity only, never progress.
- R1b: A planning brief reads what is on disk, so a completed artifact asks for revision in place.
  An artifact is never deleted or moved aside, and the stage reports which later artifacts may no
  longer agree rather than changing them. Redoing one phase is `phase set-status <name> open`.
- R1c: When a planning turn starts with its own artifact missing and settles with the derived stage
  advanced exactly once, the widget repaints from disk but keeps its arrow on the active session,
  and an empty editor is prefilled with `/task <slug>`. The command is never submitted: the
  operator's Enter key remains the gate. A draft already in the editor is untouched, and later
  revisions do not pretend the task advanced.
- R1d: The idle widget starts with a one-line five-stage rail: completed stages are green with a
  check, the stage of the active session is yellow with an arrow, and incomplete stages are dim with
  a circle. Thus reopening an earlier stage moves the arrow there without hiding later artifacts
  that already exist. Whenever the worktree exists, a second line names the open phase and its
  position in the full phase list; a task with no open phase stays on one line. A live run keeps that
  position, the inherited model and reasoning level in its header above the recent steps. The task
  name and paths are left to pi and the picker rather than repeated.
- R2: The picker lists every readable task with its derived progress, creates a task only through
  an explicit `+ new task` entry, and deletes one only behind a confirmation naming the task
  directory, the worktree, and how much uncommitted work that worktree holds. A delete removes
  those two and nothing else — the branch is kept. Commits are never counted, because the branch
  survives; a worktree whose state cannot be read is reported as unknown rather than as clean.
- R3: A task directory has two halves. The extension's — `task.json` (repository, base branch,
  description; written once, at creation, and never updated) and `phases/`, one file per phase as a
  single JSON header line (`title`, `status`), a blank line, then prose — and the planning artifacts
  in `notes/`: `questions.md`, `research.md`, `plan.md`. A model submits complete artifact prose
  through `submit_stage`; the active stage chooses the path and the extension replaces that file.
  No brief names anything outside `notes/`, and the `phase` tool is the only way a model reaches a
  phase.
- R3a: The worktree is `../<repository>-<slug>` and is never recorded. Whether it exists is what
  separates planning from implementing, so that question is asked of the filesystem.
- R3b: Model-written Markdown uses plain human language, says each point once, and carries every
  fact or decision the next stage needs without using length as a substitute for completeness. It
  uses the smallest useful visual only when that is clearer than prose. Each visual sits
  beside the short text it supports; decorative or duplicate views are omitted.
- R4: Phase order is the `NN-` filename prefix; a phase is identified by its file stem. Adding,
  reordering, and removing phases with an editor is equivalent to doing it through the tool.
- R5: The `phase` tool (`list`, `show`, `create`, `set-status`) is registered unconditionally but
  active only in a matching marked phases-stage session. It remains active after the worktree exists
  so `set-status <name> open` can redo a completed phase. It resolves its task from the stage marker
  or working-directory branch. Every call has a compact single-line rendering; operator-requested
  expansion shows its persisted call-time detail without rereading task files or defining progress.
  Implementer children are given the phase prose directly and are not granted this tool.
- R6: A session is planning exactly while the task it drives has no worktree, and that is decided
  per tool call from `task.json` — no mode is entered or left, and no toolset is borrowed. A matching
  questions, research, or design stage marker exposes `submit_stage`; a matching phases marker
  exposes `phase`; neither task tool is exposed elsewhere. Worktree creation does not strip a
  marked stage's tool, so its artifact or a completed phase can still be revised. While planning,
  only read/grep/find/ls/bash/web_search/fetch_content/delegate and the active stage tool may run.
  `submit_stage` accepts only
  the complete Markdown content and derives its destination from the stage marker; `delegate`
  reaches only the research agents. Bash runs unchanged and the planning brief tells the model to
  use it only for exploration. Any other tool is refused by name, so one registered after the
  session started is governed too.
- R7: Each phase runs as one fresh implementer child with the phase prose in its brief, the worktree
  as its working directory, and the parent's model and thinking level. The child cannot change phase
  status, and the extension stops after every phase.
- R8: A phase is complete when its file says so. The widget responds immediately when a phase starts,
  then shows preparing, waiting, thinking, the running tool, or stopping with elapsed time and recent
  steps. When the child ends, one transcript entry carries the outcome, the child's report, every
  step it took, and the command that opens its own session. After a normal run, the operator is asked
  whether to mark the phase done: yes writes `done`, and no leaves it open. A stopped or failed run
  leaves status unchanged and asks nothing. Check results are reported, never interpreted by the
  extension. Neither the report nor the confirmation starts a model turn.
- R9: Escape during a phase run stops the child and is consumed, so it reaches nothing else. The
  phase stays open, its report says how far it got, and `/task` starts a fresh child from the tree
  as it then stands.

## Invariants

- I1: No model orchestrates the loop. Every transition is code, driven by an operator keypress;
  prefilling the next `/task` command never submits it, while resuming a stage sends no message.
- I2: Children cannot delegate (the runner never grants `delegate`), so no child can start a review,
  an audit, or another implementer.
- I3: The extension performs exactly two Git writes — `worktree add` at R1's worktree step and
  `worktree remove` at R2's delete — each behind its own confirmation. `--force` is passed exactly
  when the confirmation said what would be discarded. No branch is ever deleted, and nothing is
  staged, committed, merged, rebased, or pushed.
- I4: The extension runs no lint, test, or build command. Verification is whatever the repository
  documents, found during research, and written into the phase. The implementer runs the automated
  checks and reports every result plus any unperformed manual checks; the operator decides what is
  enough.
- I5: Progress is the task directory. A planning session stores only its task/stage identity and
  inherited runtime settings; nothing task-related is written into the repository under work.
- I7: What the extension parses, models reach only through validated tools. `task.json` is written
  only by the extension; planning models change `phases/` only through the `phase` tool; implementers
  receive phase prose but not that tool; and the completion confirmation changes only the selected
  phase's status. `submit_stage` writes prose only. The operator's editor still owns every file; a
  hand-edited header stops `/task` with the file and field named, and nothing else.
- I6: No state is decided by parsing. Structure from a model arrives through JSON-Schema-validated
  tool parameters; structure from disk is one `JSON.parse` and field checks that name what to fix.
  Bash command strings are neither parsed nor classified.

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

- A1: One worktree belongs to one task, and one session drives one task at a time. A task may have
  one current workspace session per planning stage plus older sessions created explicitly with
  `new`; ordinary entry resumes the newest. Task-stage session names are not manually renamed; the
  name is a lookup prefilter, while the marker confirms identity. Concurrent tasks are separate
  worktrees. Nothing locks a phase: two sessions told to run the same one will both run it, and
  that is operator error rather than a case to defend against.
- A2: `scout` and `researcher` are read-only by instruction, not by capability — both declare
  `bash`, and a delegated child is a separate process this extension's gate never sees. R6 fences
  which roles may be delegated to, which is what stops the planner reaching implementation; what a
  research child does inside its own run is its prompt's business.
- A5: Planning Bash discipline is instruction-based, as in OpenCode's Plan mode. The extension does
  not pretend arbitrary shell text can be classified reliably: it blocks the general mutation tools
  and gives artifact writes to `submit_stage`, but a model that ignores the brief can still mutate
  through Bash.
- A3: The operator edits the task directory freely, including fixing a phase whose child died after
  finishing the work. A broken header stops `/task` with the file and the field named.
- A4: What happens between phases — review, commit, test, nothing at all — is the operator's, and
  the extension neither prompts for it nor records it.

## Non-Goals

- N1: No opinion about reviewing, committing, or verifying between phases.
- N2: No budgets, step limits, retry, resume, or multi-phase batching.
- N3: No automatic merge, cleanup, or branch policy.
- N4: No second source of progress: no session entries, no checkboxes, no counters.
