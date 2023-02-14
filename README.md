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
sudo apt install -y software-properties-common && sudo apt-add-repository -y ppa:fish-shell/release-3
sudo apt install -y fish
fish
source ~/myconfigs/fish/conf.d/install.fish
config-fish
# Host machine
# setup-ssh-keys
install-core
myconfigs && stow-configs # Or stow-configs-host
install-nvim stable
install-mamba
install-python-lsp
install-efm-lsp
```
