# Project Contract

## Objective

Provide one small Review extension that audits one exact, explicitly scoped Git candidate and lets one human review it in a local browser.

## Requirements

- R1: `/review [staged|worktree|untracked] [--requirement FILE.md] [-- PATH...]` captures exactly one source: `HEAD → index` for staged (the default), `index → tracked working tree` for worktree, or `/dev/null → untracked files` for untracked. Repeated literal repository-relative files and directories after `--` select a subset; no paths select the whole source. The command keeps `/review [optional-requirements-or-plan.md]` compatibility, provides source-aware argument completion, rejects an empty or oversized candidate, and never mutates Git.
- R2: Every invocation runs four fresh focused reviewers concurrently through the shared subagent runner and Review-local `audit` agent: contract, correctness, tests, and simplicity. The contract reviewer covers intent, governing context, and implementation coherence. Every finding is one plain sentence of at most 240 characters naming the defect and concrete consequence. The static roster declares category, model, and high thinking/effort; provider-qualified models use Pi and recognized bare `claude-*` models use native local Claude. The TUI shows every reviewer's model and latest activity; Ctrl+O adds turn details without dumping call history.
- R3: One ephemeral browser review identifies the candidate source and selected scope and shows its immutable patch, advisory audit findings, editable human changed-line comments, and at most one editable candidate-wide human general comment; it provides previous/next hunk and audit-finding navigation, then accepts exactly one explicit Approve or Send Feedback decision.
- R4: The invoking TUI never opens a browser automatically; it waits with an `Open review ↗` link until a decision, cancellation, reload, or shutdown.
- R5: Send Feedback submits deterministic Markdown as an actual user message and starts an ordinary Pi turn. Approve only ends the review.
- R6: Both browser decisions re-capture the same source and literal path selection, revalidate the exact HEAD object ID and candidate patch bytes, and reject a stale candidate. Changes outside a selected subset do not make that candidate stale.

## Invariants

- I1: One source plus its literal path selection is the sole candidate boundary. Sources never mix within an invocation, and Review owns no task, branch, index, worktree, checkpoint, commit, lifecycle, or publication state.
- I2: Reviewer findings are advisory, causally attached to exact candidate changed lines, category-validated, and aggregated directly without a synthesis pass.
- I3: Browser and human-review state is process-local and in memory. Reload, shutdown, cancellation, or candidate drift discards an undecided review; only complete child session/debug traces persist in the standard parent `subagents/<parent-id>/` tree.
- I4: Review never edits code, runs tests or linters, stages, commits, pushes, publishes, deploys, or creates pull requests. The Review-local audit agent may use Bash and applicable skills for inspection; it cannot delegate.
- I5: Planning, research, implementation, fixes, verification, commits, publication, and configured subagents remain ordinary manual Pi work outside Review.

## Constraints

- C1: Bind only to `127.0.0.1` on an ephemeral port and protect every route with an unguessable capability path, strict origin/host checks, request bounds, and a restrictive CSP.
- C2: Render with pinned `@pierre/diffs@1.3.1`; keep diff text selectable and expose explicit `+` controls only on changed lines.
- C3: Findings and line comments target exact changed additions or deletions. Human ranges are contiguous changed lines in one file and side; the single candidate-wide human general comment has no line target.
- C4: Keep audit and browser state bounded. Refuse rather than truncate a candidate or silently degrade any reviewer failure; no browser server starts unless all four reviewers succeed.
- C5: Existing `~/.pi/agent/juruc/` data and managed worktrees are out of scope and must remain untouched.

## Assumptions

- A1: One experienced local operator owns an invocation and explicitly chooses the intended source and optional file/directory subset; staged remains the default.
- A2: The operator may mutate the selected candidate while Review is open; freshness checks turn that into a clean stale-review failure.
- A3: Firefox is primary, Chromium is the regression target, and Safari is unsupported until tested.

## Non-Goals

- N1: No durable browser/human review history, restart recovery, task migration, remote sharing, accounts, collaboration, or telemetry.
- N2: No browser editing, candidate selection, staging, committing, terminals, general-purpose threads, reactions, assignments, or review-platform features beyond the required comments and read-only navigation. Review does not select individual hunks or combine Git sources.
- N3: No automatic retrying, approval, publication, or Review-owned correction loop. Fixing starts only after the human explicitly chooses Send Feedback, and then proceeds as an ordinary Pi turn.
- N4: No Review-specific runtime or trace tree. The shared subagent runner is the only subagent runtime dependency; Review owns its focused audit policy. Pi session JSONL and native Claude raw stream/stderr use the standard parent `subagents/<parent-id>/` tree solely for auditability and debugging.
