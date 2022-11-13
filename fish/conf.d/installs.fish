source ~/myconfigs/fish/conf.d/unix.fish

function install-schroot
  sudo apt install -y schroot debootstrap
  sudo ln -fs ~/myconfigs/schroot/jafar-default /etc/schroot/
end

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

function github-setup
  echo "Running github_setup"
  git config --global include.path "$HOME/myconfigs/git/gitconfig"
end

function install-core
  sudo apt update
  sudo apt install -y python3-venv \
                      software-properties-common \
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
                      p7zip-full \
                      zip \
                      wget \
                      bat \
                      curl \
                      lld \
                      lldb \
                      ninja-build \
                      sshfs \
                      zathura \
                      # Needed for st
                      libxft-dev \
                      libx11-dev
  pip3 install argcomplete==2.0.0
  python3 -m pip install --user pipx
  ln -fs $HOME/myconfigs/fd/fdignore ~/.fdignore
  github-setup
  install-ripgrep
  install-fd
end

function install-cpp-dev
  sudo apt install -y clang-tools \
                      clang-tidy \
                      clang \
                      gcc \
                      cmake \
                      dwarves
  install-cpp-lsp
end

function install-gh
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch="(dpkg --print-architecture)" signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt update
  sudo apt install -y gh
  gh auth login
  gh config set git_protocol ssh
end

function install-ccache
  sudo apt install -y ccache
end

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

function install-languagetool
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  wget https://internal1.languagetool.org/snapshots/LanguageTool-latest-snapshot.zip
  unzip LanguageTool-latest-snapshot.zip
  rm -rf ~/.config/languagetool
  mkdir -p ~/.config/languagetool
  mv LanguageTool*SNAPSHOT/* ~/.config/languagetool/
  cd -
  sudo apt install default-jdk
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

function install-pre-commit
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y pre-commit black cpplint cmake-format
  else
    pip3 install pre-commit
    pip3 install black
    pip3 install cmakelang
    pip3 install cpplint
  end
end

function install-pyinstrument
  pip3 install -U pyinstrument
end

function install-heaptrack
  sudo apt install -y heaptrack heaptrack-gui
end

function install-hotspot
  sudo apt install -y hotspot linux-cloud-tools-generic linux-tools-generic linux-tools-`uname -r`
end

function install-bloaty
  git clone git@github.com:google/bloaty.git
  cd bloaty
  git submodule update --init --recursive
  mkdir build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install .. && make install -j(nproc)
end

function install-easy-profiler
  git clone git@github.com:yse/easy_profiler.git
  cd easy_profiler
  mkdir build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install ..
  make install -j(nproc)
end


function install-i3
  if test (lsb_release -is) = "Ubuntu"
    cd /tmp
    /usr/lib/apt/apt-helper download-file https://debian.sur5r.net/i3/pool/main/s/sur5r-keyring/sur5r-keyring_2021.02.02_all.deb keyring.deb SHA256:cccfb1dd7d6b1b6a137bb96ea5b5eef18a0a4a6df1d6c0c37832025d2edaa710
    sudo dpkg -i ./keyring.deb
    echo "deb [arch=amd64] http://debian.sur5r.net/i3/ " (grep '^DISTRIB_CODENAME=' /etc/lsb-release | cut -f2 -d=) " universe" | sudo tee /etc/apt/sources.list.d/sur5r-i3.list
    sudo apt update
  end
  sudo apt install -y i3
  ln -fs ~/myconfigs/i3 ~/.config/i3
  cd -
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
  fisher install wfxr/forgit
  chsh -s `which fish`
end

function install-fish
  if test (lsb_release -is) = "Ubuntu"
    sudo apt-add-repository ppa:fish-shell/release-3
    sudo apt update
  end
  sudo apt install -y fish
  config-fish
end

function install-cpp-lsp
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
  ln -s ~/myconfigs/clangd/config.yaml ~/.config/clangd/config.yaml
  cd -
end

function install-python-lsp
  pip3 install -U jedi-language-server
  pip3 install -U python-lsp-black
  pip3 install -U pylsp-mypy
  pip3 install -U pyls-isort
  pip3 install -U pylsp-rope
  pip3 install ruff

  # TODO: Add to efm
  # flake8 --extend-ignore D,E,F,C9
  # D -> pycodestyle
  # C9 mccabe
  # F -> pyflakes
  # E ??
  pip3 install -U flake8-bugbear
  pip3 install -U flake8-builtins
  pip3 install -U flake8-comprehensions
  pip3 install -U flake8-debugger
  pip3 install -U flake8-eradicate
  python3 -m pip install --user --upgrade pynvim
  pip3 install -U debugpy
  pip3 install -U jupyterlab
  pip3 install -U nbdev
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
  curl -s https://api.github.com/repos/sumneko/lua-language-server/releases \
     | grep "browser_download_url" \
     | grep "linux-x64" \
     | cut -d":" -f 2,3 \
     | tr -d \" \
     | head -n 1 \
     | wget -i -
  ex lua-language-server-*
end

function install-nvim
  set -l config_path ~/.config/nvim
  if test -e $config_path
    if test (readlink -f $config_path) != $HOME/myconfigs/nvim
      mv $config_path $config_path".bak"(date +_%Y_%m_%d)
      ln -sf ~/myconfigs/nvim $config_path
    end
  else
    ln -sf ~/myconfigs/nvim $config_path
  end
  cd /tmp
  if set -q argv[1] && test $argv[1] = "stable"
    install-from-github neovim/neovim "v.*nvim-linux64.deb"
  else
    install-from-github neovim/neovim "nvim-linux64.deb"
  end
  sudo apt install /tmp/nvim-linux64.deb
  cd -
end

function install-conan
  pip3 install conan
end

function setup-cpp-screatches
  install-conan
  mkdir -p $WORKSPACE_DIR/cpp
  cd $CPP_SCREATCHES_DIR/..
  git clone https://github.com/JafarAbdi/cpp-scratches.git scratches
  cd scratches
  # TODO: Move to a script in cpp-scratches repo
  conan install --build=missing .
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

function install-difftastic
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github Wilfred/difftastic difft-x86_64-unknown-linux-gnu.tar.gz
  ex difft-x86_64-unknown-linux-gnu.tar.gz
  mv difft ~/.local/bin
  cd -
end

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
  # TODO: Debian support https://nvidia.github.io/nvidia-docker/
  # It uses the latest stable version, there's release for sid
  # https://docs.docker.com/engine/install/debian/
  # https://nickjanetakis.com/blog/docker-tip-77-installing-docker-on-debian-unstable
  export distribution=(export (cat /etc/os-release |xargs -L 1);echo $ID$VERSION_ID) \
    && curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -  \
    && curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
  sudo apt-get update
  sudo apt-get install -y nvidia-docker2
  sudo systemctl restart docker
  wget https://raw.githubusercontent.com/docker/cli/master/contrib/completion/fish/docker.fish -O ~/.config/fish/completions/docker.fish
  wget https://raw.githubusercontent.com/docker/compose/master/contrib/completion/fish/docker-compose.fish -O ~/.config/fish/completions/docker-compose.fish
end

function install-tmux
  # We need at least tmux3.3, the older versions have a bug with focus-events
  # https://github.com/tmux/tmux/releases
  mkdir -p ~/.config/tmux
  ln -fs ~/myconfigs/tmux/tmux.conf ~/.config/tmux/tmux.conf
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

function install-json-lsp
  install-mamba
  git clone --depth=1 git@github.com:redhat-developer/yaml-language-server.git ~/.config/yaml-lsp
  cd ~/.config/yaml-lsp
  micromamba run -n nodejs npm install -g vscode-langservers-extracted
  micromamba run -n nodejs npm install -g dockerfile-language-server-nodejs
  micromamba run -n nodejs yarn global add yaml-language-server --cwd ~/.config/yaml-lsp
end

function install-cmake-lsp
  cd ~/.config
  pipx install poetry
  git clone git@github.com:JafarAbdi/cmake-language-server.git
  cd cmake-language-server
  poetry build
  pip3 install ./dist/cmake_language_server-0.1.3.tar.gz
  cd -
end

function install-catkin
  sudo sh \
    -c 'echo "deb http://packages.ros.org/ros/ubuntu `lsb_release -sc` main" \
        > /etc/apt/sources.list.d/ros-latest.list'
  wget http://packages.ros.org/ros.key -O - | sudo apt-key add -
  sudo apt-get update
  sudo apt-get install python3-catkin-tools
end

function install-colcon
  sudo apt install -y 'python3-colcon-*' python3-vcstool
  colcon mixin add default https://raw.githubusercontent.com/colcon/colcon-mixin-repository/master/index.yaml
  colcon mixin update default
end

function install-clang-build-analyzer
  cd ~/.local/bin
  install-from-github aras-p/ClangBuildAnalyzer ClangBuildAnalyzer-linux
  mv ClangBuildAnalyzer-linux ClangBuildAnalyzer
  chmod +x ClangBuildAnalyzer
  cd -
end

function install-quarto
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github quarto-dev/quarto-cli "quarto-.*-linux-amd64.deb"
  sudo apt install ./quarto*
  cd -
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

function install-markdown-lsp
  install-from-github artempyanykh/marksman marksman-linux
  chmod +x marksman-linux
  mv marksman-linux ~/.local/bin/marksman
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


function install-luacheck
  sudo apt install -y luarocks
  luarocks install luacheck --local
end

function install-fd
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github sharkdp/fd "fd-musl_.*_amd64.deb"
  sudo apt remove fd-find || true
  sudo dpkg -i ./fd-*.deb
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

function install-cpp-analyzers
  pip3 install -U codechecker
  sudo apt-get install cppcheck
end

function install-podman
  # TODO: https://podman.io/getting-started/installation#debian
  sudo apt install -y podman podman-toolbox podman-compose podman-docker
  sudo touch /etc/containers/nodocker
  podman completion -f ~/.config/fish/completions/podman.fish fish
end

function install-dev-tools
  install-gh
  install-nvim
  # LSP
  install-cpp-dev
  install-ccache
  install-python-lsp
  install-rust-lsp
  install-efm-lsp
  install-lua-lsp
  install-json-lsp
  install-yaml-lsp
  install-markdown-lsp
  install-cmake-lsp
  # Utilities
  install-libtree
  install-difftastic
  install-pre-commit
  install-mamba
end

function install-full-system
  install-core
  setup-ssh-keys
  install-schroot
  install-dev-tools
  # Dev
  setup-cpp-screatches
end

function install-mamba
  curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C ~/.local/bin/ --strip-components=1 bin/micromamba
  micromamba shell init --shell=fish --prefix=$HOME/micromamba
  myconfigsr
  fd --glob '*.yml' ~/myconfigs/micromamba --exec test ! -e ~/micromamba/envs/{/.} \; --exec micromamba create -y -f {}
end
