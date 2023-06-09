source ~/myconfigs/fish/conf.d/unix.fish

function install-from-github
  if test (count $argv) -ne 2
    echo "install-from-github requires 2 inputs USER/REPO regex"
    return 1
  end
  curl -s https://api.github.com/repos/$argv[1]/releases \
    | grep "https://github.com/$argv[1]/releases/download.*$argv[2]" \
    | cut -d':' -f 2,3 \
    | tr -d \" \
    | head -n 1 \
    | wget -i -
end

function install-common-utils
  sudo apt update
  sudo apt install -y zathura \
                      texlive-latex-extra
end

function install-core
  sudo apt update
  sudo apt install -y python3-venv \
                      stow \
                      software-properties-common \
                      python-is-python3 \
                      git \
                      git-core \
                      git-lfs \
                      ssh \
                      colordiff \
                      tree \
                      less \
                      lsb-release \
                      iputils-ping \
                      htop \
                      python3-pip \
                      python3-argcomplete \
                      # Two dependencies for using AppImages
                      fuse3 \
                      libfuse2 \
                      p7zip-full \
                      zip \
                      wget \
                      bat \
                      curl \
                      file \
                      lld \
                      lldb \
                      ninja-build \
                      sshfs
  pip3 install argcomplete==2.0.0
  install-ripgrep
  install-fd
end

function config-fish
  rm -rf ~/.config/fish
  install-fzf
  echo "\
         function fish_user_key_bindings
         fzf_key_bindings
         end" | tee ~/.config/fish/functions/fish_user_key_bindings.fish
  echo "source ~/myconfigs/fish/config.fish" | tee ~/.config/fish/config.fish
  curl -sL https://git.io/fisher | source && fisher install jorgebucaran/fisher
  # To be able to source bash scripts
  fisher install edc/bass
  # Skip setting fish as the default shell if we are in a docker or podman containers
  if ! test -e /.dockerenv && test -z $PODMAN_NAME
    chsh -s /usr/bin/fish
  end
end

function install-cpp-lsp
  sudo apt install -y clang-tools \
                      clang-tidy \
                      clang \
                      gcc \
                      cmake \
                      dwarves
  sudo apt install -y bear
  set -l TMP_DIR (mktemp -d -p /tmp clangd-XXXXXX)
  cd $TMP_DIR
  curl -s https://api.github.com/repos/clangd/clangd/releases \
    | grep "https://github.com/clangd/clangd/releases/download.*clangd-linux-snapshot.*.zip" \
    | cut -d":" -f 2,3 \
    | tr -d \" \
    | head -n 1 \
    | wget -i -
  ex clangd-linux-snapshot*
  rm -rf ~/.config/clangd-lsp
  mv clangd_snapshot_* ~/.config/clangd-lsp
  mkdir -p ~/.config/clangd
  cd -
end

function install-rust
  if ! command -q rustup &> /dev/null
    curl --proto '=https' --tlsv1.3 https://sh.rustup.rs -sSf | sh
    myconfigsr
    rustup component add rust-analyzer
  else
    rustup update
  end
end

function install-nvim
  rm ~/.local/bin/nvim || true
  if set -q argv[1] && test $argv[1] = "nightly"
    wget https://github.com/neovim/neovim/releases/download/nightly/nvim.appimage -O ~/.local/bin/nvim
  else
    wget https://github.com/neovim/neovim/releases/latest/download/nvim.appimage -O ~/.local/bin/nvim
  end
  chmod +x ~/.local/bin/nvim
end

function install-tmux
  # We need at least tmux3.3, the older versions have a bug with focus-events
  # https://github.com/tmux/tmux/releases
  mkdir -p ~/.config/tmux
  sudo apt install -y libevent-dev libncurses-dev
  if set -q argv[1] && test $argv[1] = "unstable"
    set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
    cd $TMP_DIR
    install-from-github tmux/tmux "tmux.*.tar.gz"
    tar xzf tmux* --strip-components 1
    ./configure
    make && sudo make install
  else
    sudo apt install -y tmux
  end
end

function install-drake
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  sudo rm -rf /opt/drake
  sudo mkdir -p /opt/drake
  sudo chown $USER:$USER /opt/drake
  set -l ubuntu_release (lsb_release -cs)
  install-from-github RobotLocomotion/drake "drake.*"$ubuntu_release".tar.gz"
  tar xzf drake-*-$ubuntu_release.tar.gz -C /opt
  cd -
  # open https://drake.mit.edu/from_binary.html#stable-releases
  # sudo apt-get update
  # sudo apt-get install --no-install-recommends -y \
  #   ca-certificates gnupg lsb-release wget
  # wget -qO- https://drake-apt.csail.mit.edu/drake.asc | gpg --dearmor - \
  #   | sudo tee /etc/apt/trusted.gpg.d/drake.gpg >/dev/null
  # echo "deb [arch=amd64] https://drake-apt.csail.mit.edu/$(lsb_release -cs) $(lsb_release -cs) main" \
  #   | sudo tee /etc/apt/sources.list.d/drake.list >/dev/null
  # sudo apt-get update
  # sudo apt-get install --no-install-recommends drake-dev
end

## CPP ##

function install-bloaty
  git clone git@github.com:google/bloaty.git
  cd bloaty
  git submodule update --init --recursive
  mkdir build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install .. && make install -j(nproc)
end

function install-ccache
  sudo apt install -y ccache
end

function setup-cpp-screatches
  mkdir -p $WORKSPACE_DIR/cpp
  cd $CPP_SCREATCHES_DIR/..
  git clone https://github.com/JafarAbdi/cpp-scratches.git scratches
  cd scratches
  micromamba run -n conan conan profile detect
  micromamba run -n conan conan install --build=missing .
  cp conanbuildinfo.args compile_flags.txt
  sed -i 's/ /\n/g' compile_flags.txt
end

function install-vcpkg
  # https://github.com/microsoft/vcpkg#quick-start-unix
  cd $WORKSPACE_DIR
  set -l VCPKG_DIR $WORKSPACE_DIR/vcpkg
  git clone https://github.com/microsoft/vcpkg --origin upstream
  ./vcpkg/bootstrap-vcpkg.sh -disableMetrics
  cd $VCPKG_DIR
  git remote add origin git@github.com:JafarAbdi/vcpkg.git
  git fetch origin myconfigs
  git checkout -t origin/myconfigs
  git rebase master
  $VCPKG_DIR/vcpkg integrate x-fish
end

function install-clang-build-analyzer
  cd ~/.local/bin
  install-from-github aras-p/ClangBuildAnalyzer ClangBuildAnalyzer-linux
  mv ClangBuildAnalyzer-linux ClangBuildAnalyzer
  chmod +x ClangBuildAnalyzer
  cd -
end

function install-bazel
  sudo apt install -y bazel
  pip3 install -U absl-py
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  wget https://raw.githubusercontent.com/bazelbuild/bazel/master/scripts/generate_fish_completion.py
  python3 ./generate_fish_completion.py --bazel=(which bazel) --output=$HOME/.config/fish/completions/bazel.fish
end

## Utilities ##

function install-gh
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch="(dpkg --print-architecture)" signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt update
  sudo apt install -y gh
  gh auth login
  gh config set git_protocol ssh
end

function install-ripgrep
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y ripgrep
  else
    set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
    cd $TMP_DIR
    install-from-github "BurntSushi/ripgrep" "ripgrep_.*_amd64.deb"
    sudo dpkg -i ripgrep_*
    cd -
  end
end

function install-fzf
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y fzf
  else
    # https://raw.githubusercontent.com/junegunn/fzf/master/install
    set -l FZF_TMP_DIR (mktemp -d -p /tmp fzf-XXXXXX)
    cd $FZF_TMP_DIR
    curl -s https://api.github.com/repos/junegunn/fzf/releases \
    | grep "https://github.com/junegunn/fzf/releases/download.*-linux_amd64.tar.gz" \
    | cut -d':' -f 2,3 \
    | tr -d \" \
    | head -n 1 \
    | wget -i -
    ex fzf-*
    mkdir -p ~/.local/bin || true
    mv fzf ~/.local/bin/
    cd -
    wget https://raw.githubusercontent.com/junegunn/fzf/master/bin/fzf-tmux -O ~/.local/bin/fzf-tmux
    chmod +x ~/.local/bin/fzf-tmux
  end
  mkdir -p ~/.config/fish/functions || true
  wget https://raw.githubusercontent.com/junegunn/fzf/master/shell/key-bindings.fish -O ~/.config/fish/functions/fzf_key_bindings.fish
end

function install-libtree
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y libtree
  else
    rm ~/.local/bin/libtree 2> /dev/null
    curl -s https://api.github.com/repos/haampie/libtree/releases \
      | grep "https://github.com/haampie/libtree/releases/download.*libtree_x86_64" \
      | grep -v ".tar.gz" \
      | cut -d':' -f 2,3 \
      | tr -d \" \
      | head -n 1 \
      | wget -O ~/.local/bin/libtree -i -
    chmod +x ~/.local/bin/libtree
  end
end

function install-fd
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github sharkdp/fd "fd-musl_.*_amd64.deb"
  sudo apt remove fd-find || true
  sudo dpkg -i ./fd-*.deb
  cd -
end

function install-mamba
  if ! command -q micromamba &> /dev/null
    curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C ~/.local/bin/ --strip-components=1 bin/micromamba
    micromamba shell init --shell=fish --prefix=$HOME/micromamba
  else
    micromamba self-update
  end
  # micromamba creates a temporary file in cwd when install the pip dependencies,
  # so we need to be in a writable directory (not the case for docker containers)
  set -l TMP_DIR (mktemp -d -p /tmp mamba-envs-XXXXXX)
  cp ~/myconfigs/micromamba-envs/* $TMP_DIR
  cp ~/myconfigs/environment.yml $TMP_DIR
  fd --glob '*.yml' $TMP_DIR --threads=1 --exec test ! -e ~/micromamba/envs/{/.} \; --exec micromamba create -y -f {}
  myconfigsr
end

function install-mold
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y mold
  else
    set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
    cd $TMP_DIR
    install-from-github rui314/mold "mold-.*-x86_64-linux.tar.gz"
    tar -vxzf mold* -C ~/.local --strip-components=1
    cd -
  end
end

function install-difftastic
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github Wilfred/difftastic difft-x86_64-unknown-linux-gnu.tar.gz
  ex difft-x86_64-unknown-linux-gnu.tar.gz
  mv difft ~/.local/bin
  cd -
end

## LSPs + Linters ##

function install-pre-commit
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y pre-commit black cpplint cmake-format
  else
    pip3 install pre-commit
    pip3 install cmakelang
    pip3 install cpplint
  end
end

function install-rust-lsp
  install-rust
  # rustup +nightly component add rust-analyzer-preview
  mkdir -p ~/.local/bin
  mv ~/.local/bin/rust-analyzer{,.bak}
  curl -L https://github.com/rust-analyzer/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-unknown-linux-gnu.gz | gunzip -c - > ~/.local/bin/rust-analyzer
  chmod +x ~/.local/bin/rust-analyzer
end

function install-efm-lsp
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y efm-langserver
  else
    # YAML + CMake +
    mkdir -p ~/.config/efm-lsp
    rm -r "~/.config/efm-lsp/*" 2> /dev/null
    cd ~/.config/efm-lsp
    install-from-github mattn/efm-langserver "efm-langserver_.*_linux_amd64.tar.gz"
    tar xzf efm-langserver* --strip-components 1
    cd -
  end
  sudo apt install -y yamllint
end

function install-lua-lsp
  mkdir -p ~/.config/lua-lsp
  rm -r "~/.config/lua-lsp/*" 2> /dev/null
  cd ~/.config/lua-lsp
  curl -s https://api.github.com/repos/LuaLS/lua-language-server/releases \
     | grep "browser_download_url" \
     | grep "linux-x64" \
     | cut -d":" -f 2,3 \
     | tr -d \" \
     | head -n 1 \
     | wget -i -
  ex lua-language-server-*
end

function install-json-lsp
  git clone --depth=1 git@github.com:redhat-developer/yaml-language-server.git ~/.config/yaml-lsp
  cd ~/.config/yaml-lsp
  micromamba run -n nodejs npm install -g yarn
  micromamba run -n nodejs npm install -g vscode-langservers-extracted
  micromamba run -n nodejs npm install -g dockerfile-language-server-nodejs
  micromamba run -n nodejs npm install -g cspell
  micromamba run -n nodejs yarn global add yaml-language-server --cwd ~/.config/yaml-lsp
end

function install-cmake-lsp
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  git clone git@github.com:JafarAbdi/cmake-language-server.git -b myconfigs
  cd cmake-language-server
  micromamba run -n cmake-lsp pip3 install .
  cd -
end

function install-luacheck
  sudo apt install -y luarocks
  luarocks install luacheck --local
end

function install-markdown-lsp
  install-from-github artempyanykh/marksman marksman-linux
  chmod +x marksman-linux
  mv marksman-linux ~/.local/bin/marksman
end

function install-cpp-analyzers
  pip3 install -U codechecker
  sudo apt-get install cppcheck
end

function install-hadolint
  wget https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 -O ~/.local/bin/hadolint
  chmod +x ~/.local/bin/hadolint
end

## ROS ##

function install-catkin
  sudo sh \
    -c 'echo "deb http://packages.ros.org/ros/ubuntu `lsb_release -sc` main" \
        > /etc/apt/sources.list.d/ros-latest.list'
  wget http://packages.ros.org/ros.key -O - | sudo apt-key add -
  sudo apt-get update
  sudo apt-get install python3-catkin-tools
end

function install-colcon
  sudo apt install -y 'python3-colcon-*' python3-vcstool python3-rosdep
  colcon mixin add default https://raw.githubusercontent.com/colcon/colcon-mixin-repository/master/index.yaml
  colcon mixin update default
  sudo rosdep init
  rosdep update
end

function install-urdf-viz
  sudo apt install -y rospack-tools
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github openrr/urdf-viz urdf-viz-x86_64-unknown-linux-gnu.tar.gz
  ex urdf-viz-x86_64-unknown-linux-gnu.tar.gz
  mv urdf-viz ~/.local/bin
  cd -
end

function install-ros2
  if test (count $argv) -ne 1
    echo "install-ros2 expects 1 argument for the distribution name"
    return 1
  end

  set -l distros "foxy" "galactic" "humble" "rolling"
  if ! contains $argv[1] $distros
    echo "Invalid distro '"$argv[1]"'"
    return 1
  end

  locale  # check for UTF-8
  sudo apt update && sudo apt install locales
  sudo locale-gen en_US en_US.UTF-8
  sudo update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
  export LANG=en_US.UTF-8
  locale  # verify settings

  sudo apt install software-properties-common
  sudo add-apt-repository universe

  sudo apt update && sudo apt install curl
  sudo curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /usr/share/keyrings/ros-archive-keyring.gpg

  echo "deb [arch="(dpkg --print-architecture)" signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu "(export (cat /etc/os-release |xargs -L 1) && echo $UBUNTU_CODENAME)" main" | sudo tee /etc/apt/sources.list.d/ros2.list > /dev/null

  sudo apt update
  sudo apt upgrade
  sudo apt install ros-$argv[1]-desktop
  sudo apt install ros-dev-tools

  install-colcon
end

## Configs ##

function unstow-configs
  stow --target ~ --ignore=.mypy_cache --ignore=.ruff_cache --delete cargo \
                                                                     clangd \
                                                                     i3 \
                                                                     git \
                                                                     neovim \
                                                                     ruff \
                                                                     scripts \
                                                                     stylua \
                                                                     systemd \
                                                                     tmux \
                                                                     fd \
                                                                     ripgrep \
                                                                     wezterm \
                                                                     python \
                                                                     micromamba \
                                                                     sourcery \
                                                                     yamllint
end
function stow-configs
  stow --no-folding --target ~ --ignore=.mypy_cache --ignore=.ruff_cache --stow cargo \
                                                                                clangd \
                                                                                git \
                                                                                ruff \
                                                                                scripts \
                                                                                stylua \
                                                                                systemd \
                                                                                fd \
                                                                                ripgrep \
                                                                                micromamba \
                                                                                yamllint \
                                                                                sourcery \
                                                                                python \
                                                                                podman
  stow --target ~ --ignore=.mypy_cache --ignore=.ruff_cache --stow i3 \
                                                                   wezterm \
                                                                   neovim \
                                                                   tmux
end

##################
## Host Machine ##
##################

function setup-ssh-keys
  sudo apt install -y openssh-server xclip || echo -e "\e[00;31mAPT-GET FAILED\e[00m"

  read -P "Enter email associated with github account :" email
  ssh-keygen -t rsa -b 4096 -C $email

  # Adding your SSH key to the ssh-agent
  eval (ssh-agent -c)
  mkdir -p ~/.ssh
  ssh-add ~/.ssh/id_rsa

  # copy public key to various websites
  xclip -sel clip < ~/.ssh/id_rsa.pub # Linux

  firefox 'https://github.com/settings/ssh' &
  echo "Your public SSH key has been copied to the clipboard - we recommend you add it to Github and optionally Bitbucket now."
  read -P "Press any key to continue."
end

function install-ros-github-token
  pip install -U bloom
  read -P "Your Github username: " gitUserName
  read -P "A Github oauth token for your account: " oAuthToken

  rm -f $HOME/.config/bloom
  echo "\
{
    \"github_user\": \"$gitUserName\",
    \"oauth_token\": \"$oAuthToken\"
}" | tee $HOME/.config/bloom
end

## Utilities ##

function install-i3
  if test (lsb_release -is) = "Ubuntu"
    set -l TMP_DIR (mktemp -d -p /tmp i3-XXXXXX)
    cd $TMP_DIR
    /usr/lib/apt/apt-helper download-file https://debian.sur5r.net/i3/pool/main/s/sur5r-keyring/sur5r-keyring_2022.02.17_all.deb keyring.deb SHA256:52053550c4ecb4e97c48900c61b2df4ec50728249d054190e8a0925addb12fc6
    sudo dpkg -i ./keyring.deb
    echo "deb [arch=amd64] http://debian.sur5r.net/i3/ " (grep '^DISTRIB_CODENAME=' /etc/lsb-release | cut -f2 -d=) " universe" | sudo tee /etc/apt/sources.list.d/sur5r-i3.list
    sudo apt update
  end
  sudo apt install -y i3
  cd -
end

function install-inkscape
  sudo add-apt-repository ppa:inkscape.dev/stable
  sudo apt install inkscape
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github textext/textext "TexText-Linux.*.tar.gz"
  tar -vxzf TexText-Linux* -C . --strip-components=2
  python3 setup.py --skip-requirements-check --inkscape-executable (which inkscape)
end

## Virtualization ##

function install-docker-compose
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github docker/compose docker-compose-linux-x86_64
  chmod +x docker-compose-linux-x86_64
  mv docker-compose-linux-x86_64 ~/.local/bin/docker-compose
  cd -
end

function install-docker
  # Install lazydocker
  curl https://raw.githubusercontent.com/jesseduffield/lazydocker/master/scripts/install_update_linux.sh | bash
  # Install Docker
  if ! command -q docker &> /dev/null
    sudo apt install -y curl
    curl -sSL https://get.docker.com/ | sh
    sudo usermod -aG docker (whoami)
  end
  install-docker-compose
  # Test:
  sudo docker run hello-world
  # Nvidia
  # It uses the latest stable version, there's release for sid
  # https://docs.docker.com/engine/install/debian/
  # https://nickjanetakis.com/blog/docker-tip-77-installing-docker-on-debian-unstable
  if ! command -q nvidia-docker &> /dev/null
    export distribution=(export (cat /etc/os-release |xargs -L 1);echo $ID$VERSION_ID) \
      && curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -  \
      && curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
    sudo apt-get update
    sudo apt-get install -y nvidia-docker2
  end
  sudo systemctl restart docker
  wget https://raw.githubusercontent.com/docker/cli/master/contrib/completion/fish/docker.fish -O ~/.config/fish/completions/docker.fish
  wget https://raw.githubusercontent.com/docker/compose/master/contrib/completion/fish/docker-compose.fish -O ~/.config/fish/completions/docker-compose.fish
end

function install-podman-tui
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  wget https://github.com/containers/podman-tui/releases/latest/download/podman-tui-release-linux_amd64.zip
  ex podman-tui-release-linux_amd64.zip
  rm -f ~/.local/bin/podman-tui && mv (fd -t executable podman-tui) ~/.local/bin
  cd -
end

function install-podman
  sudo apt install -y podman podman-toolbox podman-compose podman-docker
  podman completion -f ~/.config/fish/completions/podman.fish fish
  toolbox completion fish > ~/.config/fish/completions/toolbox.fish
  wget https://raw.githubusercontent.com/docker/cli/master/contrib/completion/fish/docker.fish -O ~/.config/fish/completions/docker.fish
  install-podman-tui
end

function install-dev-core
  ## Utilities
  install-difftastic
  install-mold
  install-libtree
  install-gh
  install-ccache
  ## Linters
  install-pre-commit
  install-hadolint
  install-actionlint
end

function install-full-development
  # XML
  install-xml-lsp
  # Markdown
  install-markdown-lsp
  # Lua
  install-lua-lsp
  install-luacheck
  # Python
  install-efm-lsp
  # Rust
  install-rust-lsp
  # C/C++
  install-cpp-lsp
  # TODO: Add support by installing them to a virtualenv
  # install-cpp-analyzers
end

function install-wezterm
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  # Detect if we are on Debian or Ubuntu
  if test (lsb_release -si) = "Debian"
   wget https://github.com/wez/wezterm/releases/download/nightly/wezterm-nightly.Debian11.deb
  else
   wget https://github.com/wez/wezterm/releases/download/nightly/wezterm-nightly.Ubuntu(lsb_release -sr).deb
  end
  sudo dpkg -i wezterm-nightly.*.deb
  wezterm shell-completion --shell fish > ~/.config/fish/completions/wezterm.fish
  # Install terminfo
  set -l tempfile (mktemp)
  curl -o $tempfile https://raw.githubusercontent.com/wez/wezterm/master/termwiz/data/wezterm.terminfo
  tic -x -o ~/.terminfo $tempfile
  rm $tempfile
  cd -
end

function install-obsidian
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github obsidianmd/obsidian-releases "Obsidian-.*.AppImage"
  chmod +x Obsidian-*.AppImage
  mv Obsidian-*.AppImage ~/.local/bin/obsidian
  cd -
end

function install-actionlint
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github rhysd/actionlint "actionlint_.*_linux_amd64.tar.gz"
  ex actionlint*
  mv actionlint ~/.local/bin
  cd -
end

function install-stylua
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github "JohnnyMorganz/StyLua" "stylua-linux.zip"
  ex stylua-linux.zip
  mv stylua ~/.local/bin
  cd -
end

function install-xml-lsp
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github redhat-developer/vscode-xml lemminx-linux.zip
  ex lemminx-linux.zip
  mv lemminx-linux ~/.local/bin/lemminx
  cd -
end

function install-syncthing
  sudo curl -o /usr/share/keyrings/syncthing-archive-keyring.gpg https://syncthing.net/release-key.gpg
  echo "deb [signed-by=/usr/share/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable" | sudo tee /etc/apt/sources.list.d/syncthing.list
  sudo apt-get update && sudo apt-get install -y syncthing
  sudo systemctl enable syncthing@$USER.service && sudo systemctl start syncthing@$USER.service
end

function install-rattler
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github "prefix-dev/rattler-build" "rattler-build-.*-x86_64-unknown-linux-gnu.tar.gz"
  tar xzf rattler-build* --strip-components 1
  mv rattler-build ~/.local/bin
  sudo apt install -y patchelf
end

# Profilers
function install-pyinstrument
  pip3 install -U pyinstrument
end

function install-heaptrack
  sudo apt install -y heaptrack heaptrack-gui
end

function install-hotspot
  sudo apt install -y hotspot linux-cloud-tools-generic linux-tools-generic linux-tools-(uname -r)
end

function install-flamegraph
  cargo install flamegraph
  flamegraph --completions fish > ~/.config/fish/completions/flamegraph.fish
end

function install-omnisharp
  if test (lsb_release -si) = "Ubuntu"
    sudo gpg --homedir /tmp --no-default-keyring --keyring /usr/share/keyrings/mono-official-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys 3FA7E0328081BFF6A14DA29AA6A19B38D3D831EF
    echo "deb [signed-by=/usr/share/keyrings/mono-official-archive-keyring.gpg] https://download.mono-project.com/repo/ubuntu stable-focal main" | sudo tee /etc/apt/sources.list.d/mono-official-stable.list
    sudo apt update
    sudo apt install -y mono-devel dotnet-sdk-7.0
    rm -rf ~/.config/omnisharp-roslyn && mkdir -p ~/.config/omnisharp-roslyn
    cd ~/.config/omnisharp-roslyn
    install-from-github OmniSharp/omnisharp-roslyn "omnisharp-linux-x64.tar.gz"
    ex omnisharp-linux-x64.tar.gz
    cd -
    # Needed to generate config files
    install-vscode
  else
    echo "Not supported"
  end
end

function install-vscode
  if ! command -q code &> /dev/null
    set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
    cd $TMP_DIR
    wget 'https://code.visualstudio.com/sha/download?os=linux-deb-x64' -O vscode.deb
    sudo apt install ./vscode.deb
  end
  cd -
end
