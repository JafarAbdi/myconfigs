# Project Contract

## Objective

Provide one small Review extension that audits an exact staged Git candidate and lets one human review it in a local browser.

## Requirements

- R1: `/review [optional-requirements-or-plan.md]` captures exactly `git diff --cached HEAD --`, rejects an empty or oversized candidate, and never mutates Git.
- R2: Every invocation runs exactly one fresh private in-memory audit with the active Pi model and thinking level, normal project-context discovery, read-only inspection tools, and one terminating structured submission tool.
- R3: One ephemeral browser review shows the immutable staged patch, advisory audit findings, and editable human changed-line comments, then accepts exactly one explicit Approve or Send Feedback decision.
- R4: The invoking TUI never opens a browser automatically; it waits with an `Open review ↗` link until a decision, cancellation, reload, or shutdown.
- R5: Send Feedback places deterministic Markdown in the invoking editor without submitting it. Approve only ends the review.
- R6: Both browser decisions revalidate the exact HEAD object ID and staged patch bytes and reject a stale candidate.

## Invariants

- I1: The staged index is the sole candidate boundary. Review owns no task, branch, worktree, checkpoint, commit, lifecycle, or publication state.
- I2: Audit findings are advisory, causally attached to changed lines, and limited to material intent, correctness, test-integrity, coherence, project-context, and deletion-first simplicity issues.
- I3: Browser state is process-local and in memory. Reload, shutdown, cancellation, or candidate drift discards an undecided review.
- I4: Review never edits code, runs implementation, stages, commits, pushes, publishes, deploys, or creates pull requests.
- I5: Planning, research, implementation, fixes, verification, commits, publication, and configured subagents remain ordinary manual Pi work outside Review.

## Constraints

- C1: Bind only to `127.0.0.1` on an ephemeral port and protect every route with an unguessable capability path, strict origin/host checks, request bounds, and a restrictive CSP.
- C2: Render with pinned `@pierre/diffs@1.3.1`; keep diff text selectable and expose explicit `+` controls only on changed lines.
- C3: Findings and comments target exact changed additions or deletions. Human ranges are contiguous changed lines in one file and side.
- C4: Keep audit and browser state bounded. Refuse rather than truncate a candidate or silently degrade a failed audit.
- C5: Existing `~/.pi/agent/juruc/` data and managed worktrees are out of scope and must remain untouched.

## Assumptions

- A1: One experienced local operator owns an invocation and explicitly stages the intended candidate.
- A2: The operator may mutate the candidate while Review is open; freshness checks turn that into a clean stale-review failure.
- A3: Firefox is primary, Chromium is the regression target, and Safari is unsupported until tested.

## Non-Goals

- N1: No durable review history, restart recovery, task migration, remote sharing, accounts, collaboration, or telemetry.
- N2: No browser editing, staging, committing, terminals, general-purpose threads, reactions, assignments, or review-platform features.
- N3: No automatic fixing, retrying, approval, submission, publication, or model-driven correction loop.
- N4: No dependency on the external subagent extension or its configured agents.
