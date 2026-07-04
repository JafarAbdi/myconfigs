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
- Worker must read relevant context/style files before editing and report which ones it used.
- Reviewers must inspect the current diff and read the listed context/style files directly.
- Reviewers must list the context/style files they checked.

Dynamic subagent model routing:
- Before launching any pi-subagent, run: `jq -r '.enabledModels[]?' ~/.pi/agent/settings.json`
- Choose only from returned models.
- Routing:
  - scout / simple recon / cheap review → `deepseek/deepseek-v4-flash`
  - worker / implementation / code edits → `openai-codex/gpt-5.5`
  - code-focused review → `openrouter/moonshotai/kimi-k2.7-code`
  - hard correctness / architecture / security / oracle → `deepseek/deepseek-v4-pro`
  - broad reasoning fallback → `openrouter/z-ai/glm-5.2`
  - local/offline coding, tool-use, multilingual, math/reasoning → `llama.cpp/qwen36`
  - local/offline doc review, image/multimodal, long-context, instruction-following, code repair/review → `llama.cpp/gemma4`
- If the preferred model is not enabled, choose the closest enabled model.
- If unsure, omit `model` and inherit parent.
- Always pass the chosen model via `model` in `subagent(...)`.
- Final response must mention models used per subagent lane.

Required reviewer lanes:
- Run at least one fresh-context `context-style-reviewer` focused only on context/style adherence.
- Pass it the context/style file list from `/context-files` when available.
- It defaults to reviewing the current git diff when no explicit scope is supplied.
- It must cite exact context/style files checked.
- It must return `PASS`, `FAIL`, or `NO_DIFF`.
- Do not finish until `context-style-reviewer` returns `PASS` or all blocking findings are fixed.

Constraints:
- Use the parent session as controller and final decision-maker.
- Use one `worker` for implementation or fixes.
- Use fresh-context `reviewer` agents for general review and fresh-context `context-style-reviewer` for context/style review.
- Apply only concrete fixes worth doing now.
- Do not loop for optional polish or speculative improvements.
- Stop when reviewers find no blockers or fixes worth doing now, or after 3 review rounds.

Final response must include:
- rounds run
- files changed
- context/style files checked
- context/style reviewer verdict
- validation commands/results
- reviewer findings applied
- remaining deferred items, if any
