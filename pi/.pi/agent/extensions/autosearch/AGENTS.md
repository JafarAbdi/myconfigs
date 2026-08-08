# Project Contract

## Objective

Implement one small Pi extension whose parent session oversees fresh bounded child runs until one
explicit objective is verified, blocked, aborted, or errors.

## Requirements

- `/autosearch <objective>` starts the only workflow in interactive TUI mode.
- Continue exclusively from `agent_settled`.
- Reinject the immutable objective with `before_agent_start`.
- Enforce exactly one fresh delegated child per parent pass; let the parent select its role.
- Instruct the parent to remain non-mutating; it may inspect evidence read-only and run the objective's verifier.
- Provide one extension-owned model-facing tool: `finish_autosearch(outcome, evidence)`.
- Require one child before terminal completion and instruct the parent to use a fresh non-mutating verification child after the last mutation.
- Use ordinary Pi messages for steering and Escape for stopping.
- Show only a compact active status.
- Propagate terminal errors and blockers; never retry or substitute behavior.

## Invariants

- One autosearch owns one parent Pi session. Delegated children remain isolated; no project-directory locking is performed.
- Each parent pass starts one fresh child and each successful settled turn starts exactly one continuation.
- Completion, blocker, error, length limit, or abort starts none.
- The finish tool is available only while autosearch is active.
- Project files and verifier output remain authoritative.

## Constraints

- Reuse Pi's command, tool, event, compaction, and UI APIs.
- Keep runtime state in memory.
- Prefer one implementation file.
- Add no configuration or extension-owned state files.
- Keep control flow and failure paths explicit.

## Assumptions

- The objective identifies its verifier, stopping condition, and editable scope.
- The project owns any experiment log or research program.
- Pi completes retries, compaction, and queued messages before `agent_settled`.
- The existing `delegate` tool provides fresh bounded child runs and normalized reports.

## Non-Goals

- Benchmark or Git automation.
- Dashboards, browser servers, hooks, or custom compaction.
- Experiment databases or sidecar state.
- Automatic restart or session recovery.
- RPC, print mode, parent-side implementation, side conversations, or multiple concurrent searches in one Pi session.
- Compatibility with other autoresearch formats.

# Working Agreement

- Brevity. One way of doing things. Refactor rather than accumulate.
- If something fails, propagate the error or exit.
- No fallbacks or silent degradation.
- No backward-compatibility layers; this project has no released API.
