# yo

Yosh-style `yo` for Fish and WezTerm, backed directly by llama.cpp's
OpenAI-compatible Chat Completions API.

Credit: [Yosh](https://github.com/pizlonator/yosh) is the original LLM-enabled
Bash/Readline shell. `yo` asks in natural language, then either streams a short
answer or prefills a Fish command for review.

## Requirements

- Fish shell
- WezTerm with `$WEZTERM_PANE`
- [`uv`](https://docs.astral.sh/uv/)
- `llama-server` with `--jinja` and the `qwen38-instruct` alias

The server URL, model, sampling parameters, prompt, and OpenAI tool schemas live
in [`yo.py`](yo.py). The script has no Python package dependencies.

## Install

Add this to your Fish config:

```fish
source ~/myconfigs/yo/yo.fish
```

## Use

```fish
yo find files larger than 100MB
yo why did that command fail?
yo what does set -gx do?
```

Commands are prefilled but never executed automatically. Knowledge answers
stream directly. The model can request up to 200 recent lines from the current
WezTerm pane when a question depends on terminal context.

Each invocation is independent: there are no sessions, runtime files, shell
event hooks, or automatic multi-step continuations.
