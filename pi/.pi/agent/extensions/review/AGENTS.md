# Project Contract

## Objective

Provide one small Review extension that audits an exact staged Git candidate and lets one human review it in a local browser.

## Requirements

- R1: `/review [optional-requirements-or-plan.md]` captures exactly `git diff --cached HEAD --`, rejects an empty or oversized candidate, and never mutates Git.
- R2: Every invocation runs six fresh focused reviewers concurrently through the shared subagent runner and canonical `audit` agent: intent, correctness, tests, coherence, context, and simplicity. The static roster declares category, model, and high thinking/effort; provider-qualified models use Pi and recognized bare `claude-*` models use native local Claude.
- R3: One ephemeral browser review shows the immutable staged patch, advisory audit findings, and editable human changed-line comments, then accepts exactly one explicit Approve or Send Feedback decision.
- R4: The invoking TUI never opens a browser automatically; it waits with an `Open review ↗` link until a decision, cancellation, reload, or shutdown.
- R5: Send Feedback places deterministic Markdown in the invoking editor without submitting it. Approve only ends the review.
- R6: Both browser decisions revalidate the exact HEAD object ID and staged patch bytes and reject a stale candidate.

## Invariants

- I1: The staged index is the sole candidate boundary. Review owns no task, branch, worktree, checkpoint, commit, lifecycle, or publication state.
- I2: Reviewer findings are advisory, causally attached to exact changed lines, category-validated, and aggregated directly without a synthesis pass.
- I3: Browser and human-review state is process-local and in memory. Reload, shutdown, cancellation, or candidate drift discards an undecided review; only complete child session/debug traces persist in the standard parent `subagents/<parent-id>/` tree.
- I4: Review never edits code, runs tests or linters, stages, commits, pushes, publishes, deploys, or creates pull requests. The canonical audit agent may use Bash and applicable skills for inspection; it cannot delegate.
- I5: Planning, research, implementation, fixes, verification, commits, publication, and configured subagents remain ordinary manual Pi work outside Review.

## Constraints

- C1: Bind only to `127.0.0.1` on an ephemeral port and protect every route with an unguessable capability path, strict origin/host checks, request bounds, and a restrictive CSP.
- C2: Render with pinned `@pierre/diffs@1.3.1`; keep diff text selectable and expose explicit `+` controls only on changed lines.
- C3: Findings and comments target exact changed additions or deletions. Human ranges are contiguous changed lines in one file and side.
- C4: Keep audit and browser state bounded. Refuse rather than truncate a candidate or silently degrade any reviewer failure; no browser server starts unless all six reviewers succeed.
- C5: Existing `~/.pi/agent/juruc/` data and managed worktrees are out of scope and must remain untouched.

## Assumptions

- A1: One experienced local operator owns an invocation and explicitly stages the intended candidate.
- A2: The operator may mutate the candidate while Review is open; freshness checks turn that into a clean stale-review failure.
- A3: Firefox is primary, Chromium is the regression target, and Safari is unsupported until tested.

## Non-Goals

- N1: No durable browser/human review history, restart recovery, task migration, remote sharing, accounts, collaboration, or telemetry.
- N2: No browser editing, staging, committing, terminals, general-purpose threads, reactions, assignments, or review-platform features.
- N3: No automatic fixing, retrying, approval, submission, publication, or model-driven correction loop.
- N4: No Review-specific runtime, reviewer policy, or trace tree. The shared subagent runner and canonical `audit` agent are the only subagent dependencies; Pi session JSONL and native Claude raw stream/stderr use the standard parent `subagents/<parent-id>/` tree solely for auditability and debugging.
