# Project Contract

## Objective

One small Review extension resolves free-form operator intent into one exact Git candidate, audits
it, and hands it to one Pi-session-scoped Wiff review for one experienced operator's decision.

## Requirements

- R1: Every bounded `/review` request, including bare and `@`-prefixed requests, goes with bounded
  changed-path inventories to one fresh structured Luna resolver.
  The resolver chooses one view: `HEAD → index` for staged, `index → tracked working tree` for
  unstaged, `/dev/null → untracked files` for untracked, or final working tree versus `HEAD` plus
  untracked files for overall. Overall is the default for mixed, all, or unspecified layers. It
  returns `null` for the whole view or selected paths as exact inventory entries; an empty array
  fails without broadening. While Luna runs, Review shows Pi's cancellable bordered loader. After
  resolution it immediately appends one TUI-only expandable Pi entry naming the model, view,
  whole-view/subset mode, and every exact inventory path in scope. Review host-validates the result,
  forwards TEXT to every auditor as guidance, rejects an empty or larger-than-8-MiB candidate, and
  never mutates Git.
- R2: Every invocation runs four fresh read-only reviewers concurrently: contract, correctness,
  tests, and simplicity. Each concrete material finding is one plain sentence of at most 240
  characters. Progress identifies each reviewer; a reviewer failure publishes nothing.
- R3: A non-empty full Pi session ID deterministically names one Wiff project,
  `pi-review-<full-pi-session-id>`, passed to every Wiff command as `--project`. A fresh Pi session
  creates an independent review even for the same candidate; reloading the same session reuses the
  same project and trusts Wiff's active session inside it. `wiff session list --project <project>`
  distinguishes exact `No sessions.` (absent) from any other output (existing session); rows are
  never parsed, counted, or chosen among.
- R4: Review adds no argument hash, metadata encoding, or continuity enforcement across repeated
  `/review` calls against the same open review; the human-readable Wiff description is for
  operators only and is never parsed by Review.
- R5: After all four auditors succeed, Review revalidates freshness (I2); on a mismatch it fails
  before creating, refreshing, or publishing to Wiff, leaving any existing session untouched.
- R6: Review pipes exact non-empty patch bytes over stdin to
  `wiff new --no-tui --agent --author pi-review --project <project> --description <text>` on first
  use, or `wiff refresh --agent --author pi-review --project <project>` on a later round; Wiff's
  native Git capture is never used for a Review candidate.
- R7: After create/refresh, Review reads `wiff render --format json --project <project>` only for
  programmatic state, and validates `schema_version`, `session.id`/`session.project`, `comments`,
  and optional `verdicts` (each with author name, author kind, and disposition); it fails visibly
  on unsupported or malformed output.
- R8: Review publishes each finding in deterministic roster/result order with `wiff comment add`,
  passing `--agent --author review/<category> --session <id> --project <project> --file <path>
  --line <line>` and an optional `--side before` (default `after` side for additions, `before` for
  deletions), body over stdin, never through a shell. Audit findings never set a verdict, and every
  subprocess exit is checked.
- R9: Review hands the terminal to Wiff through Pi's external-editor pattern inside
  `ctx.ui.custom()`: `tui.stop()`, spawn `wiff resume --project <project>` with inherited stdio and
  the repository root as cwd, await the child exit, and in `finally` call `tui.start()` and
  `requestRender(true)`. A non-zero Wiff exit is an error that retains Wiff state; inherited stderr
  remains visible in the terminal. If Wiff removed its own session, Review reports the removal and
  ends without recreating it.
- R10: After every successful Wiff exit, Review re-renders JSON state, refuses if Wiff's active
  session ID differs from the session it opened, shows a compact human-verdict and comment
  summary, and offers exactly **Approve and remove**, **Discuss and plan**, **Fix feedback now**,
  **Keep for later**, **Reopen Wiff**. Cancelling the menu asks again. Reopen relaunches the same
  session with no recapture, audit, or refresh; Keep retains Wiff and ends without a Pi turn;
  Approve, Discuss, and Fix each revalidate freshness (I2) first. Approve then removes the
  JSON-reported session with `wiff session rm <id> --project <project>` and reports failure without
  claiming approval. Discuss and Fix each render ordinary `wiff render` Markdown, embed it verbatim
  in one deterministic user message with untrusted-review-data framing, and start one ordinary Pi
  turn. Discuss requires a read-only, one-material-question-per-turn interview, a concise confirmed
  plan, and a later explicit `proceed` before implementation. Fix authorizes immediate work and one
  material question only when blocked. Both instruct the implementing turn to add and immediately
  resolve one concise Wiff review note recording agreed decisions and changes, then resolve each
  addressed comment; every instructed Wiff command includes the session and project.

## Invariants

- I1: One invocation's resolved view plus its ordered exact path selection is its candidate boundary;
  changes outside the selected paths never make that candidate stale.
- I2: Freshness compares repository root, HEAD OID, view, ordered paths, and exact patch bytes
  against this invocation's captured snapshot. A mismatch before publication aborts with any
  existing Wiff state untouched; a mismatch at Approve, Discuss, or Fix rejects the decision,
  retains Wiff, and requires a new `/review` round.
- I3: Findings are advisory, bounded, category-attributed, and published only after all four
  auditors succeed. No finding automatically authorizes implementation work.
- I4: Review persists no workflow state in Pi or in a sidecar. Its Pi scope entry is presentation
  history only and never enters model context; Wiff is the sole owner of review state, comments,
  anchors, rebasing, dispositions, verdicts, and durable review history.
- I5: Review never edits code, runs tests or linters, mutates Git, commits, pushes, deploys, or
  owns a correction loop.
- I6: Review uses only Wiff's public CLI; it never reads or writes Wiff's journal files.

## Constraints

- C1: Candidate and audit data remain bounded; Review refuses rather than truncates them.
- C2: A non-empty full Pi session ID is mandatory; there is no fallback identity.
- C3: Wiff is resolved from `PATH`. Its JSON output is schema-checked and never parsed with regex,
  timers, random IDs, or hashes; its Markdown output is used verbatim in generated Pi turns and
  never parsed.
- C4: Publication failure stops the workflow, preserves existing Wiff state, and reports an
  actionable error without launching Wiff or accepting a decision.
- C5: Existing managed worktrees and unrelated Pi data remain untouched.

## Assumptions

- A1: One experienced operator owns an invocation and repeats the same intent while a review remains
  open; a materially different `/review` call during an open review is operator error.
- A2: The operator may mutate the selected candidate while Wiff is open; freshness checks (I2) turn
  that into a clean stale-decision failure rather than silent drift.

## Non-Goals

- N1: No browser, HTTP server, diff renderer, `@pierre/diffs` or other diff parser, review-state
  database, model-context Pi message, user-visible custom Pi tool, skill, or global Pi
  skill-settings change. The scope entry renderer is presentation-only; child-only structured
  result tools are protocol adapters, not user-facing capabilities.
- N2: No Review-specific implementation of comments, replies, anchors, navigation, dispositions,
  verdict aggregation, or history — Wiff owns all of it.
- N3: No automatic retry, deduplication, rollback, or misuse-protection machinery around Wiff's
  append-only history.
- N4: No Wiff source changes.
