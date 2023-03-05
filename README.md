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
- Make sure to remove `sudo apt remove fonts-noto-color-emoji` if installed,
  otherwise st will segfault [See](https://git.suckless.org/st/file/FAQ.html#l168).

## Installation

```bash
make setup-fish core
make host # Host specific configs
make dev
```
