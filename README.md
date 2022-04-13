# My Configs

## New system setup

- Debian stable/unstable (sid)
  - Wifi drivers
    - Edit `/etc/apt/sources.list` to enable non-free packages `deb http://deb.debian.org/debian/ ... main non-free`
    - su -
    - apt install firmware-misc-nonfree
    - adduser jafar sudo (optional)
    - Restart
  - NVidia drivers
    - https://wiki.debian.org/NvidiaGraphicsDrivers
  - Printer driver
    - printer-driver-brlaser
- core
  - github-setup
  - install-core
  - install-fish
  - install-nvim
  - install-nnn
- host machines
  - install-i3
  - install-schroot
  - setup-ssh-keys
- dev
  - install-cpp-dev
  - install-gh
  - install-vcpkg
  - install-ccache
  - install-clangd
  - install-rust
  - install-lua-lsp
  - install-libtree
  - install-pre-commit
  - (as needed?)
    - install-heaptrack
    - install-hotspot
    - install-bloaty
    - install-easy-profiler
    - install perf
      - sudo apt install linux-tools-$(uname -r) linux-tools-generic -y
      - sudo sh -c 'echo 1 > /proc/sys/kernel/perf_event_paranoid'
      - sudo sh -c 'echo 0 > /proc/sys/kernel/kptr_restrict'
- ros
  - install-ros-github-token

- Create file named `~/.machine_name` inside it nameof_machine
- Create file `~/myconfigs/i3/i3_$nameof_machine`
- Disable 'Ctrl+Shift+u' binding: `ibus-setup` -> Emoji -> Unicode code point

```bash
# TODO: No longer needed?
mv ~/.bashrc ~/.bashrc.bak
echo ". ~/myconfigs/.bashrc" >> ~/.bashrc
echo ". ~/myconfigs/.profile" >> ~/.profile
myconfigs && git submodule update --init --recursive
```
