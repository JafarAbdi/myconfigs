# yo

Yosh-style `yo` for Fish + WezTerm, powered by the Pi CLI.

Credit: [Yosh](https://github.com/pizlonator/yosh) is the original LLM-enabled
Bash/Readline shell. `yo` ports its core workflow to Fish: ask in natural
language, get a command prefilled for review or a chat answer printed inline.

## Assumptions

- Fish shell
- WezTerm with `$WEZTERM_PANE`
- `$XDG_RUNTIME_DIR`
- `pi`, `jq`, and `wezterm` in `PATH`

## Install

Add this to your Fish config:

```fish
source ~/myconfigs/yo/yo.fish
```

## Use

```fish
yo find files larger than 100MB
yo why did that command fail?
yo reset
```

Behavior:

- Commands are prefilled into Fish, never executed automatically.
- Chat answers print directly.
- Scrollback is only sent when the model requests it.
- Pending multi-step tasks auto-continue after the next command finishes.
- `yo reset` clears this pane's state and Pi session.
- `PI_CODING_AGENT_DIR` is passed only to the spawned Pi process.

Runtime files live in:

```text
$XDG_RUNTIME_DIR/yo-fish/
```

On failure, `yo` keeps the filtered Pi events and stderr under `$XDG_RUNTIME_DIR/yo-fish/`.
