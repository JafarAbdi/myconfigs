function schroot-new-config
  set -l chroot_dir "/etc/schroot/chroot.d"
  read -P "Chroot name (example jammy, focal, or bionic): " name
  read -P "Description: " description -c name

  if test -e "/etc/schroot/chroot.d/$name"
    echo "$name already exists in /etc/schroot/chroot.d"
    return
  end
  echo "[$name]
description=$description
type=directory
directory=$SCHROOT_DIR/$name
users=jafar
groups=jafar
root-users=root
root-groups=root
union-type=overlay
personality=linux
preserve-environment=true
setup.fstab=jafar-default/fstab" | sudo tee "/etc/schroot/chroot.d/$name"
end

function schroot-begin-session
  # https://github.com/ntrrgc/schroot-scripts
  if test (count $argv) -eq 0
    echo "schroot-begin-seeions expects 2 inputs (name optional-session-name)"
    return 1
  end
  set -l name (perl -ne '/\[(.*)\]/ && print $1' "/etc/schroot/chroot.d/$argv[1]")
  set -l dir (perl -ne '/directory=(.*)/ && print $1' "/etc/schroot/chroot.d/$argv[1]")
  set -l session_name $name
  if set -q argv[2]
    set session_name $argv[2]
  end
  if ! test -d $dir
    echo "Directory doesn't exists"
    echo "Make sure to run `sudo debootstrap --variant=buildd DISTRO $dir http://archive.ubuntu.com/ubuntu/`"
    echo "Or `sudo debootstrap --variant=buildd DISTRO $dir https://deb.debian.org/debian`"
    echo "See /usr/share/debootstrap/scripts for available types"
    return 1
  end

  schroot --begin-session -c "$name" -n "$session_name"

  # TODO: Is this needed??
  # Allow X11 clients to use the server outside the chroot
  if test -e ~/.Xauthority && test -d $dir
    sudo cp -f "$HOME/.Xauthority" "$dir/" || true
    echo "\
  export XAUTHORITY=/.Xauthority
  export DISPLAY=\"\${DISPLAY:-}\"" | sudo tee "$dir/etc/profile.d/x11.sh" > /dev/null
  end

echo "\
chown jafar:jafar /home/jafar
apt update
apt install -y lsb-release
apt install -y sudo
apt install -y locales

echo \"export LANG='en_US.UTF-8'\" > /etc/profile.d/locale.sh

# We need some locales built because otherwise the system has no defined
# encoding and things can go wrong easily (e.g. Python crashes when opening
# in text mode any file that has non-ASCII characters).
sed -i '/^# en_US.UTF-8/s/^#//' /etc/locale.gen
locale-gen

if [[ \"\$(lsb_release -is)\" == \"Ubuntu\" ]];
then
  apt install -y software-properties-common
  add-apt-repository universe
  add-apt-repository multiverse
  apt-add-repository ppa:fish-shell/release-3
  apt update
elif [[ \"\$(lsb_release -is)\" == \"Debian\" ]];
then
  apt install -y libxft-dev libx11-dev
fi
apt install -y fish
chsh -s `which fish`
" | sudo schroot --run-session -c $session_name -d / bash

  echo "\

source ~/myconfigs/fish/conf.d/installs.fish
install-core
stow-configs
config-fish
install-difftastic
install-python-lsp

sudo apt install -y libglu1-mesa

sudo apt install -y python3-pip
pip3 install PyYAML
pip3 install argcomplete
" | schroot --run-session -c "$session_name"

  if test -d $HOME/.config/gh
    cp -r ~/.config/gh $dir/.config/gh
  end
end
