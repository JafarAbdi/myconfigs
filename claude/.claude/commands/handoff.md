---
description: Compact the current conversation into a handoff document for another agent.
argument-hint: "[what the next session will focus on]"
---

Write a handoff document summarising the current conversation so a fresh agent can continue. Save to the user's OS temp directory — **not** the workspace.

Include:
- What was attempted, decided, deferred
- Current state (files touched, branch, open questions)
- A **Suggested skills** section listing skills the next agent should invoke
- References to existing artifacts (PRDs, plans, ADRs, issues, commits, diffs) by path/URL — do not duplicate their content

Redact sensitive info (API keys, passwords, PII).

If `$ARGUMENTS` is non-empty, treat it as a description of what the next session will focus on and tailor the doc accordingly.
