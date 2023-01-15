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
sudo apt-add-repository ppa:fish-shell/release-3
sudo apt update
sudo apt install -y fish
setup-ssh-keys
source ~/myconfigs/fish/config.fish
install-fish
install-full-system
install-i3
stow-configs # Or stow-configs-host
```
