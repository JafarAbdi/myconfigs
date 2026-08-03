# Project Contract

## Objective

Provide one small Questions → Research → Specification → Plan → Implementation → Review workflow with fresh bounded sessions, authoritative local state, extension-owned commits, advisory review, and mandatory human acceptance.

## Requirements

- R1: `/juruc` is the only task creation, picker, resume, and review-reopen entry point; managed sessions show one concise lifecycle line.
- R2: Questions resolves one material choice at a time, Research always runs, Specification stays implementation-neutral, and the explicitly accepted Plan is persisted before branch or worktree creation.
- R3: Every discovery stage, implementation phase, reviewer, and correction uses a fresh durable session with only its declared information diet and tools.
- R4: Each accepted Plan phase declares repository-relative Git pathspec scopes and exact verification commands. The implementer cannot commit or use unrestricted shell; JURUC reruns verification, stages the complete scoped candidate, and creates the local checkpoint commit.
- R5: Final review uses one fresh factual-deviation reviewer and one fresh bounded-correctness reviewer over the cumulative task-base-to-round-head patch. Reviewers are tool-free, single-call, non-retrying, advisory, and use Pi's normal context-file loading while all other project resources and settings remain disabled.
- R6: JURUC serves the pinned cumulative diff through a local capability URL, persists browser comments and decisions in `task.json`, and treats browser closure or comment absence as no decision.
- R7: `Approve` requires no saved comments and explicit human action. `Send Feedback` sends all saved comments in file/line order to one fresh correction session; JURUC verifies and commits the correction, freezes the round, and starts a fresh cumulative review round.
- R8: Completion means only that the local task branch is ready for the operator. JURUC never pushes, publishes, deploys, or creates a pull request.

## Invariants

- I1: Models investigate, specify, plan, implement, review, and correct; JURUC owns lifecycle identity, validation, durable transitions, verification execution, staging, and commits.
- I2: `task.json` is the sole authoritative lifecycle and executable state. The fixed task-directory `research.md` is the sole research artifact; Markdown plans, browser storage, review sidecars, and session transcripts are never authoritative.
- I3: The accepted Plan, recorded checkpoints, commits, and completed review rounds are immutable. Open-round comments follow their explicit edit/delete rules; later corrections append history and never rewrite or remap completed state.
- I4: Reviewers cannot edit, retry, block acceptance, approve, or initiate correction. Only saved human comments cause correction, and only explicit human approval reaches `done`.
- I5: JURUC validates persisted JSON, model output, filesystem results, Pi sessions, Git identity, patch identity, changed-line targets, verification evidence, and repository ownership at their boundaries.
- I6: Pi owns ordinary `AGENTS.md`/`CLAUDE.md` discovery from each session cwd. JURUC does not scan changed files, inject context, persist context metadata, or compensate for misplaced context files.

## Constraints

- C1: Lifecycle stages are exactly `questions`, `research`, `specification`, `plan`, `implementation`, `review`, and `done`; transitions move forward without blocking, backtracking, renewed research, or replanning.
- C2: Model workflow tools remain stage-specific, schema-validated, and unavailable outside the active task-owned session. Implementation and Correction have no unrestricted shell and cannot commit.
- C3: Plan acceptance precedes workspace side effects. Copy only root `.env*`, root `CLAUDE.local.md`, and `.claude/settings.local.json`; reject conflicting branches, worktrees, repositories, heads, registrations, or dirty candidates.
- C4: Git owns pathspec matching, staging identity, and cumulative diff semantics. Use fixed no-color histogram `TASK_BASE...ROUND_HEAD` diffs with rename detection and three context lines; do not add application patch hashes.
- C5: Save authoritative files atomically with mode `0600` and directory synchronization. Use strict current schemas without compatibility parsers or migrations.
- C6: The review server binds only to `127.0.0.1` on an ephemeral port, uses unguessable capability URLs, makes no outbound requests, and never silently truncates a review.
- C7: Render with pinned `@pierre/diffs@1.3.1` through Node SSR. Browser JavaScript stays application-owned and plain; do not ship Pierre's browser bundle or a React runtime.
- C8: Support changed-line comments and contiguous same-file/same-side ranges. Editing changes comment text only; targets, IDs, timestamps, completed rounds, and Git history remain fixed.

## Assumptions

- A1: One experienced operator owns a task and does not concurrently mutate its authoritative files, managed worktree, branch, or review while JURUC is operating.
- A2: The operator places repository context files according to Pi's normal cwd rules; JURUC does not repair user context placement.
- A3: Sessions and persisted files provide durable continuity, not an adversarial authorization boundary. Unexpected external interference may stop the workflow and require manual repair.
- A4: Review is local and offline. Firefox is primary, Chromium is the regression target, and Safari is unsupported until tested.

## Non-Goals

- N1: Remote review, sharing, accounts, collaboration, telemetry, update checks, publication, pull-request creation, pushing, or deployment.
- N2: Browser editing, staging, committing, terminals, general-purpose threads, reactions, assignments, or review-platform features.
- N3: Automatic approval, model-driven correction loops, independent per-phase audits, plan extension, compatibility migration, or speculative recovery machinery.
- N4: Custom context discovery, source diff algorithms, application patch hashes, arbitrary source selection, annotation remapping, or third-party browser build pipelines.
