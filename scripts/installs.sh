#!/bin/bash -eu

setup_ssh_keys()
{
      sudo apt install -y openssh-server xclip || echo -e "\e[00;31mAPT-GET FAILED\e[00m"

      read -p "Your Github email: " gitUserName
      ssh-keygen -t rsa -b 4096 -C "$gitUserName"

      # Adding your SSH key to the ssh-agent
      eval "$(ssh-agent -s)"
      mkdir -p ~/.ssh
      ssh-add ~/.ssh/id_rsa

      # copy public key to various websites
      #cat ~/.ssh/id_rsa.pub | pbcopy  # OSX
      xclip -sel clip < ~/.ssh/id_rsa.pub # Linux

      firefox 'https://github.com/settings/ssh' &
      firefox 'https://bitbucket.org/' &
      echo "Your public SSH key has been copied to the clipboard - we recommend you add it to Github and optionally Bitbucket now."
      read -p "Press any key to continue."
}

################################################################################
# Setup Github
################################################################################

github_setup()
{
  echo "Running github_setup"
  git config --global include.path "$HOME/myconfigs/git/gitconfig"
}

################################################################################
# Install general tools that can be used on all versions of Ubuntu
################################################################################

install_schroot()
{
  sudo apt install -y schroot debootstrap
}

install_lsyncd()
{
  sudo apt install lua5.3-dev
  cd $WORKSPACE_DIR
  git clone https://github.com/axkibe/lsyncd.git
  cd lsyncd
  cmake -DCMAKE_INSTALL_PREFIX=./install .
}
install_core()
{
  sudo apt update
  sudo apt install -y git-core
  sudo apt install -y ssh
  sudo apt install -y colordiff
  sudo apt install -y tree
  sudo apt install -y bash-completion
  sudo apt install -y less
  sudo apt install -y lsb-release
  sudo apt install -y iputils-ping
  sudo apt install -y clang-tools
  sudo apt install -y clang-tidy
  sudo apt install -y htop
  sudo apt install -y clang
  sudo apt install -y gcc
  sudo apt install -y python3-pip
  sudo apt install -y cmake
  sudo apt install -y python3-argcomplete
  sudo apt install -y p7zip-full
  sudo apt install -y inotify-tools
  sudo apt install -y iwyu
  sudo apt install -y git-lfs
  sudo apt install -y fd-find
  sudo apt install -y bat
  sudo apt install -y curl
}

################################################################################
# Install Bloom Github oauth access token for releasing ROS packages
################################################################################

install_ros_github_token()
{
  pip install -U bloom
  read -p "Your Github username: " gitUserName
  read -p "A Github oauth token for your account: " oAuthToken

  rm -f $HOME/.config/bloom
  cat <<EOF >> $HOME/.config/bloom
{
    "github_user": "$gitUserName",
    "oauth_token": "$oAuthToken"
}
EOF
}

################################################################################
# Install gh
################################################################################
install_gh()
{
  sudo apt-key adv --keyserver keyserver.ubuntu.com --recv-key C99B11DEB97541F0
  sudo apt-add-repository https://cli.github.com/packages
  sudo apt update
  sudo apt install gh
  gh auth login
  gh config set git_protocol ssh
}

################################################################################
# Install Docker
################################################################################

install_docker()
{
  # Install Docker
  sudo apt install -y curl
  curl -sSL https://get.docker.com/ | sh
  sudo usermod -aG docker $(whoami)
  # Test:
  sudo docker run hello-world
  # Nvidia
  distribution=$(. /etc/os-release;echo $ID$VERSION_ID) \
   && curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add - \
   && curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
  sudo apt-get update
  sudo apt-get install -y nvidia-docker2
  sudo systemctl restart docker
}

install_podman()
{
  . /etc/os-release
  echo "deb https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_${VERSION_ID}/ /" | sudo tee /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list
  curl -L "https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_${VERSION_ID}/Release.key" | sudo apt-key add -
  sudo apt-get update
  sudo apt-get -y upgrade
  sudo apt-get -y install podman
}
################################################################################
# https://ccache.dev for more details
################################################################################

install_ccache()
{
  sudo apt install ccache
}

install_fzf()
{
  # https://raw.githubusercontent.com/junegunn/fzf/master/install
  FZF_TMP_DIR=$(mktemp -d -p /tmp fzf-XXXXXX)
  cd $FZF_TMP_DIR
  curl -s https://api.github.com/repos/junegunn/fzf/releases \
  | grep "https://github.com/junegunn/fzf/releases/download.*-linux_amd64.tar.gz" \
  | cut -d':' -f 2,3 \
  | tr -d \" \
  | head -n 1 \
  | wget -i -
  ex fzf-*
  mv fzf ~/.local/bin/
  mkdir ~/.config/fish/functions
  wget https://raw.githubusercontent.com/junegunn/fzf/master/shell/key-bindings.fish -O ~/.config/fish/functions/fzf_key_bindings.fish
  cd -
}

install_libtree()
{
  rm ~/.local/bin/libtree 2> /dev/null
  curl -s https://api.github.com/repos/haampie/libtree/releases \
  | grep "https://github.com/haampie/libtree/releases/download.*libtree_x86_64" \
  | grep -v ".tar.gz" \
  | cut -d':' -f 2,3 \
  | tr -d \" \
  | head -n 1 \
  | wget -O ~/.local/bin/libtree -i -
  chmod +x ~/.local/bin/libtree
}

################################################################################
# Install go & gdrive
################################################################################
install_vcpkg()
{
  # https://github.com/microsoft/vcpkg#quick-start-unix
  cd $WORKSPACE_DIR
  local VCPKG_DIR=$WORKSPACE_DIR/vcpkg
  git clone https://github.com/microsoft/vcpkg --origin upstream
  ./vcpkg/bootstrap-vcpkg.sh -disableMetrics
  cd $VCPKG_DIR
  git remote add origin git@github.com:JafarAbdi/vcpkg.git
  git fetch origin myconfigs
  git checkout -t origin/myconfigs
  git rebase master
}

install_pre_commit()
{
  pip3 install pre-commit
  pip3 install black
  pip3 install cmakelang
  pip3 install cpplint
}


install_heaptrack()
{
  sudo apt install -y elfutils libdwarf-dev libboost-all-dev gettext
  cd $WORKSPACE_DIR
  git clone git@github.com:KDE/heaptrack.git || true
  cd heaptrack
  sudo apt-get install -y extra-cmake-modules libunwind-dev libkchart-dev libkf5coreaddons-dev libkf5i18n-dev libkf5itemmodels-dev libkf5threadweaver-dev libkf5configwidgets-dev libkf5kio-dev
  mkdir -p build && cd build && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install ..
  make install -j$(nproc)
}

install_hotspot()
{
  sudo apt install -y hotspot linux-cloud-tools-generic linux-tools-generic linux-tools-`uname -r`
}

install_bloaty()
{
  git clone git@github.com:google/bloaty.git
  cd bloaty
  git submodule update --init --recursive
  mkdir build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install .. && make install -j$(nproc)
}

install_easy_profiler()
{
  git clone git@github.com:yse/easy_profiler.git
  cd easy_profiler
  mkdir build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install ..
  make install -j$(nproc)
}

install_rust()
{
  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
  # rustup +nightly component add rust-analyzer-preview
  mkdir -p ~/.local/bin
  curl -L https://github.com/rust-analyzer/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-unknown-linux-gnu.gz | gunzip -c - > ~/.local/bin/rust-analyzer
  chmod +x ~/.local/bin/rust-analyzer
}

install_i3()
{
  cd /tmp
  /usr/lib/apt/apt-helper download-file https://debian.sur5r.net/i3/pool/main/s/sur5r-keyring/sur5r-keyring_2021.02.02_all.deb keyring.deb SHA256:cccfb1dd7d6b1b6a137bb96ea5b5eef18a0a4a6df1d6c0c37832025d2edaa710
  sudo dpkg -i ./keyring.deb
  echo "deb [arch=amd64] http://debian.sur5r.net/i3/ $(grep '^DISTRIB_CODENAME=' /etc/lsb-release | cut -f2 -d=) universe" | sudo tee /etc/apt/sources.list.d/sur5r-i3.list
  sudo apt update
  sudo apt install -y i3
  mkdir -p ~/.config/i3/
  ln -s ~/myconfigs/i3/i3_config ~/.config/i3/config
  cd -
}

install_fish()
{
  sudo apt install -y software-properties-common
  sudo apt-add-repository ppa:fish-shell/release-3
  sudo apt update
  sudo apt install -y fish
}

install_nvim()
{
  test ! -d ~/myconfigs/nvim && ln -s ~/myconfigs/nvim ~/.config/nvim

  sudo add-apt-repository ppa:neovim-ppa/stable
  sudo apt-get update
  sudo apt-get install -y neovim

  echo """Run nvim and call
  :PackerInstall
  :TSInstall c cpp python rust fish bash make cmake lua vim markdown
  """

  # Python support
  pip install 'python-lsp-server[all]'
  pip install python-lsp-black
  pip install pyls-isort
  pip install pyls-flake8
  pip install pylsp-mypy
  pip install pylsp-rope

  # C++ support
  # sudo apt install clangd-12

  # Rust support
  install_rust

  # YAML + CMake +
  sudo apt  install -y golang-go
  go get github.com/mattn/efm-langserver

  mkdir $HOME/.config/efm-langserver/
  ln -s ~/myconfigs/efm-langserver/config.yaml $HOME/.config/efm-langserver/config.yaml


  sudo apt install -y yamllint
  sudo apt install -y bear
}
# sudo apt-get install ripgrep
