# My Configs

## New system setup

- Debian stable/unstable (sid)
  - install perf
    - sudo apt install linux-tools-$(uname -r) linux-tools-generic -y
    - sudo sh -c 'echo 1 > /proc/sys/kernel/perf_event_paranoid'
    - sudo sh -c 'echo 0 > /proc/sys/kernel/kptr_restrict'
- Create file named `~/.machine_name` inside it nameof_machine
- Create file `~/myconfigs/i3/i3_$nameof_machine`
- Disable 'Ctrl+Shift+u' binding: `ibus-setup` -> Emoji -> Unicode code point

## Installation

```bash
stow --target ~ --stow bazel \
                       cargo \
                       clangd \
                       i3 \
                       git \
                       neovim \
                       ruff \
                       schroot \
                       scripts \
                       stylua \
                       systemd \
                       tmux \
                       vscode \
                       yamllint
sudo stow --target / --stow schroot
```
