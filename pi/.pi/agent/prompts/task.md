---
description: Implement with pi-subagents review loop
argument-hint: "<task>"
---

Run a parent-orchestrated pi-subagents review loop for:

$@

Context/style handling:
- Before launching implementation or review, get the authoritative context/style file list from this project cwd:

```bash
PI_OFFLINE=1 pi --mode json --no-session -p "/context-files" \
  | jq -r 'select(.type=="message_end" and .message.customType=="context-files") | .message.content'
```

- Do not pass `--no-extensions`; `/context-files` is provided by an extension.
- Use that output as the context/style file list for worker and reviewer tasks.
- Reviewers must inspect the current diff and read the listed context/style files directly.
- Reviewers must list the context/style files they checked.

Constraints:
- Use the parent session as controller and final decision-maker.
- Use one `worker` for implementation or fixes.
- Use fresh-context `reviewer` agents for review.
- Apply only concrete fixes worth doing now.
- Do not loop for optional polish or speculative improvements.
- Stop when reviewers find no blockers or fixes worth doing now, or after 3 review rounds.

Final response must include:
- rounds run
- files changed
- validation commands/results
- reviewer findings applied
- remaining deferred items, if any
