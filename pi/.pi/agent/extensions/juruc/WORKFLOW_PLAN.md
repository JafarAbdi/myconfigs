# JURUC Workflow Plan

Status: the local diff-review surface and its QRSPI workflow integration are explicitly approved for implementation. The standalone demo entry point has been removed; production review state will be integrated directly into authoritative `task.json` rounds.

## Goal

Take one task through bias-resistant discovery, planning, isolated implementation, bounded review, and extension-owned local commits, then require explicit human acceptance before the branch is considered ready.

## Core Workflow

- Keep separate QRSPI stages: questions, research, specification/design, plan, and implementation.
- Give every stage, implementation phase, correction round, and reviewer a fresh Pi session with a deliberately limited information diet.
- Let JURUC perform valid stage transitions automatically; fresh context must not require the operator to start the next session.
- Validate all model output that JURUC executes. Never parse model-authored Markdown to discover build phases or transitions.
- Keep `task.json` authoritative for lifecycle and executable state. Session transcripts are never authoritative.
- Never push, publish, or create a pull request. `done` means only that the local branch is ready for the operator's next action.

## Questions Stage

Adapt the interview behavior from `claude/.claude/commands/grill.md` rather than generating a static questionnaire.

- Start one fresh, persistent Questions session from the original request and read-only source checkout.
- Establish the target first; if it is ambiguous, make that the first question.
- Investigate facts available from the repository or tools instead of asking the operator.
- Ask exactly one unresolved material choice per turn and wait for its answer.
- Include a recommended answer and its main reason with every question.
- Recompute the next question after every answer. Do not persist or follow a precomputed question queue.
- Challenge only assumptions, scope, trade-offs, failure modes, edge cases, and success criteria that can affect the outcome.
- Do not edit files or create implementation artifacts during Questions.
- When no material question remains, present a concise shared understanding and ask the operator to confirm it.
- Continue questioning if confirmation is withheld. Only confirmed understanding may transition automatically to a fresh Research session.

The validated Questions result in `task.json` contains only:

- `sharedUnderstanding`
- explicit `decisions`
- `acceptedAssumptions`
- factual `researchTargets`

Individual questions and dialogue remain in the session transcript. Unresolved operator choices prevent completion; researchable factual uncertainty becomes a research target.

## Information Diets and Artifacts

| Session | Receives |
| --- | --- |
| Questions | Original request and read-only repository |
| Research | Request, confirmed Questions result, research targets, repository, and web |
| Specification | Request, confirmed Questions result, and completed research |
| Plan | Validated specification and repository |
| Implementation phase | Specification, authoritative current phase, and relevant checkpoint facts |
| Deviation review | Specification, accepted plan, cumulative diff, and verification evidence |
| Correctness review | Specification, cumulative diff, and verification evidence; not the plan rationale |
| Correction | Specification, human comments, colocated agent context, current repository, and relevant prior verification |

No session receives prior chat transcripts or unrelated raw artifacts.

- Store Questions, specification, plan, execution, and review structures in `task.json`.
- Keep the full research report as authoritative prose in `research.md`; record its path and digest in `task.json`.
- Store the specification as validated `summary`, `requirements`, `nonGoals`, `constraints`, `acceptanceCriteria`, and `decisions`.
- Store plan phases as validated identifiers, titles, goals, file scopes, instructions, and runnable verification commands.
- Do not create an authoritative `plan.md` or duplicate review sidecar.

## Workspace and Planned Implementation

- Create the task worktree only after the operator accepts the plan and immediately before the first implementation phase.
- After creating it, copy any existing matches for `.env*`, `.claude/settings.local.json`, and `CLAUDE.local.md` from the source checkout, preserving relative paths and silently skipping missing matches.
- Do not add `setupCommand`, multi-repository workspace support, or arbitrary source-`HEAD` and clean-checkout gates.
- Start every implementation phase in a fresh session.
- The implementer runs only the verification declared by that phase and returns structured command results.
- After successful verification, JURUC stages the phase changes and creates a local checkpoint commit.
- Start the next phase automatically after the checkpoint commit.
- Remove JURUC's independent per-phase audits without removing shared audit infrastructure used by other extensions.

## Correction Verification

Follow the observed Factories distinction between planned implementation and follow-on fixes:

- Planned phases run only their phase-declared verification.
- A correction cannot have fully predeclared commands because its human feedback was unknown during planning.
- The fresh correction session first verifies the feedback against the current code, then applies only the requested fix.
- It runs the smallest existing tests plus non-mutating lint/typecheck commands relevant to the touched code, reusing applicable phase commands where useful.
- It must not invent an unrelated repository-wide gate or a speculative `finalVerification` suite.
- Persist each command, exit status, and concise result in `task.json`; this improves on Factories, which reports but does not retain the evidence structurally.
- There is no independent correction audit. JURUC commits the correction only after its reported verification succeeds, then starts a new review round.

## Final Agent Review

- Enter `review` after all planned implementation commits exist locally.
- For each human-review round, run one fresh factual deviation reviewer and one fresh bounded correctness reviewer, exactly once each.
- Reviewers inspect the cumulative task-base-to-round-`HEAD` change. Neither reviewer may retry work, edit code, block acceptance, or start a correction loop.
- Validate reviewer output as changed-line annotations containing `filePath`, `side`, `line`, `summary`, and optional `rationale`.
- Require one concrete, independently actionable issue per annotation. Consolidate duplicate manifestations; impose no arbitrary finding-count limit.
- Persist reviewer annotations before opening the browser review.
- A failed or malformed advisory reviewer is recorded and omitted; it does not block human review or trigger an automatic retry.
- Treat all agent annotations as advisory. Only human comments are actionable correction instructions.

## Local Browser Review Surface

JURUC will own a small, local-only review surface rather than depend on Hunk or Plannotator.

### Diff source

Git remains the source of truth. Generate each cumulative review patch with the equivalent of:

```bash
git diff \
  --no-color \
  --no-ext-diff \
  --no-textconv \
  --diff-algorithm=histogram \
  --find-renames \
  --unified=3 \
  "$TASK_BASE...$ROUND_HEAD"
```

- Do not implement a source diff algorithm.
- Pin every review round to exact base and head commits; those commits and the fixed Git command identify the cumulative patch without a redundant application hash.
- Let Git determine additions, deletions, hunks, line numbers, and renames.
- Do not request Git word-diff output; the renderer owns intra-line presentation.

### Renderer decision

Use `@pierre/diffs@1.3.1` as a normal runtime dependency, but do not ship its browser bundle.

- Give JURUC a `package.json`, exact lockfile, and Pi manifest. Put `@pierre/diffs` in `dependencies` and Pi-provided imports in `peerDependencies`.
- Pi installs runtime dependencies automatically for npm and git packages. This local-path development copy requires one explicit `npm install` in the JURUC directory because Pi references local packages in place.
- Import `parsePatchFiles` from `@pierre/diffs` and the official pre-rendering API from `@pierre/diffs/ssr` inside Pi's Node process.
- Render each file to local HTML, CSS, syntax highlighting, and annotation slots on the server, then place it in declarative Shadow DOM. Cache the immutable result for the pinned review round.
- Serve only a small extension-authored browser script for comment editing, explicit decisions, and changed-line/range selection. Editing changes comment text only; its target, ID, and creation time stay fixed. It has no third-party browser imports and needs no bundler.
- Use Pierre's public annotation slots for agent and saved human comments. Keep the small Shadow-DOM line-target adapter behind a fixture test because its click mapping depends on the pinned renderer's DOM attributes.
- Group multiple agent and human annotations for one target in one application-owned annotation element.
- Support changed-line comments and contiguous changed-line ranges; do not implement arbitrary source selection.
- Do not add a frontend framework for the initial review surface. If later requirements genuinely justify one, use SolidJS—not React.
- Fix the visual presentation to the approved subdued dark theme, bar indicators, and `word-alt` intra-line highlighting; do not add preferences for them.
- Do not add an editor, staging, file mutation, comment threads, accounts, sharing, AI, or other review-platform features.

The approved prototype verified that the SSR output creates its shadow root without client library code, exposes changed-line clicks through `composedPath()`, and assigns inline annotations to the expected Pierre slots.

### Local server and privacy

- Use a small extension-owned server built on Node standard-library HTTP APIs.
- Bind only to `127.0.0.1` on an ephemeral port and use an unguessable task-scoped capability URL.
- Serve a restrictive Content Security Policy permitting only local HTML, the extension-authored script, and local API requests.
- Make no telemetry, update-check, font, image, AI, sharing, or other outbound requests.
- Keep the API limited to loading review state, saving/editing/deleting human comments, and submitting an explicit decision.
- Route every production mutation through the extension-owned `task.json` writer; do not keep a review sidecar or a second source of truth.
- Pi owns the server process. Automatically open the system-default browser and show the exact URL in a TUI notification when review starts or resumes.
- While the server is live, render a compact OSC 8 `Open review ↗` hyperlink in the status widget. WezTerm can open it directly; terminals without hyperlink support see ordinary text and retain the exact-URL notification fallback.
- Keep `/juruc` as the only resume path. Enter on an open review starts the server if needed, issues a new capability URL after process restart, displays it, and reopens the browser.
- Persist every saved comment atomically before the UI reports success. Keep unsaved textarea drafts in task/round-scoped browser local storage so a closed tab can be reopened safely.
- Never silently truncate. Show binary files and pure renames with a clear no-text-diff result, do not hide generated files, and refuse an oversized review with a clear Pi error at limits established by implementation measurements.
- Support Firefox as the primary browser and Chromium as a regression target; test the Shadow-DOM line-selection contract in both. Do not promise Safari until it is tested.
- Infer syntax languages using only Pierre's bundled local highlighter. Never download language packs; unknown languages or highlighting failures fall back to plain text.

### Human decisions and corrections

- Show agent annotations as labelled context and human comments as a distinct author-controlled layer.
- Provide exactly two completion actions: `Approve` and `Send Feedback`.
- `Approve` records explicit acceptance and moves the task to `done`; absence of comments or browser closure never implies acceptance. Disable it while any saved human comment remains, so the operator must send or delete every comment first.
- `Send Feedback` requires at least one saved human comment and starts one fresh correction session containing all comments ordered by file and line.
- Closing the browser, losing the server, or exiting Pi leaves the round open and resumable.
- Correction prompts quote any colocated agent annotation as context, followed by the human comment as the only actionable instruction. Unmatched human comments remain standalone instructions.
- After correction verification, JURUC creates one additional local commit without rewriting checkpoint history, freezes the completed round, then starts a new cumulative review round with no carried-over human comments and fresh advisory reviews.
- Keep prior comments and decisions only in immutable `task.json` round history; never remap them onto changed lines.
- Repeat only when directed by a human `Send Feedback`; there is no model-driven retry loop.

## Authoritative Review State

Persist immutable completed rounds and the current open round in `task.json`. A round records at least:

- exact base and head commits
- deviation and correctness reviewer annotations or recorded reviewer failure
- saved human comments and explicit decision
- correction session path, verification results, and resulting commit when applicable

Browser local storage may retain unsaved draft text only. It is never authoritative workflow state.

## TUI

Keep the terminal surface to one managed-session widget and the existing picker. The browser alone displays diffs, annotations, comments, and review decisions.

### Status widget

Render one width-safe line from `task.json`, using `✓` for completed, `●` for current, and `·` for future stages. Always spell out the active context after the compact rail:

```text
Q✓ R✓ S● P· I· · specification
Q✓ R✓ S✓ P✓ I● · phase 2/4 · Connect workflow
Q✓ R✓ S✓ P✓ I✓ · review 2 · awaiting decision · Open review ↗
Q✓ R✓ S✓ P✓ I✓ · correction 2 · verifying
Q✓ R✓ S✓ P✓ I✓ · done
```

Truncate phase titles to width. `Open review ↗` is an OSC 8 link to the current capability URL and updates whenever the Pi-owned server restarts. Do not show the full URL, blocker text, paths, hashes, comments, findings, reviewer rationale, or counts that do not change the next action.

### Picker

Reuse `DynamicBorder`, `Input`, `fuzzyFilter`, and `SelectList`. Keep each task to a title and one muted context line:

```text
Task title
slug · implement 2/4 · 2h ago
```

- Enter resumes the single authoritative next action; an open review reopens its browser.
- Keep only New task, resume, cancel, and confirmed delete interactions.
- Do not add stage-specific menus, tabs, filters, badges, sidebars, or a custom footer.
- A completed task opens one compact read-only summary containing branch, worktree, and short `HEAD`; it never reopens Planning.

## Non-Goals

- Remote review, sharing, accounts, telemetry, or update checks
- Pull-request creation, pushing, or publication
- Code editing, staging, committing, or terminal access from the browser
- General-purpose review threads, reactions, assignment, or collaboration
- Remapping old annotations onto a changed patch; completed rounds remain pinned and immutable
- Special image, binary, or generated-file review beyond clearly reporting Git's result
- Large-diff platform features, language-pack management, or a third-party browser build pipeline

## Implementation Checkpoints

Each checkpoint must leave one authoritative lifecycle schema, pass the complete JURUC test suite, create one extension-owned local commit, and never push.

1. Replace per-phase audits with phase-declared verification, persisted command evidence, and extension-owned checkpoint commits; delete only JURUC's local audit runner.
2. Replace fixed research/planning/build session slots with final stage slots plus append-only typed fresh-session runs; adapt ownership and tool gates once.
3. Cut discovery over to Questions, Research, Specification, and Plan with strict validated artifacts, read-only source-checkout sessions, automatic fresh transitions, and the compact QRSPI rail. Research always runs; Plan no longer invokes canonical `/grill`.
4. Defer branch/worktree creation until plan acceptance, copy only the fixed local-file set, and activate phased implementation with the final schema.
5. Add the factual-deviation and bounded-correctness reviewer prompts, validated annotation/failure outcomes, fresh-session runner, and fixtures without making reviews reachable yet.
6. Add immutable authoritative review rounds to `task.json`; replace the prototype sidecar writer with task-backed browser mutations and ingest both advisory reviewer outcomes.
7. Add Pi-owned review-server lifecycle, Firefox/Chromium checks, measured fail-clear resource limits, explicit decisions, all-comments correction sessions, focused verification, correction commits, and fresh cumulative rounds.
8. Finish the OSC 8 review link, `/juruc` review resume, compact picker/status behavior, completed-task summary, and end-to-end QRSPI interruption/restart coverage.
