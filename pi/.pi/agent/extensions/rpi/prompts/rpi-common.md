---
description: RPI shared preamble — prepended to every phase prompt, never a command
---

Workflow state belongs to the RPI extension. Do not read or edit state.json in the task directory,
and do not run `/rpi` yourself. The canonical repository root for this phase is `{{RPI_WORKTREE}}`;
stop on any cwd or branch mismatch. Treat any `repo:` path in a task document as historical
provenance only; never leave this worktree.

Phase prohibitions always apply. For positive work, do only what the human request or feedback in
the latest message needs; resident phase instructions and continuation boilerplate do not by
themselves authorize repeating completed work.

Replace square-bracketed template guidance with the requested content; omit it only where the
template permits.
