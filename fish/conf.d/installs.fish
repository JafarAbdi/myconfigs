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
  eval (ssh-agent -s)
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
  sudo apt install -y git-core
  sudo apt install -y ssh
  sudo apt install -y colordiff
  sudo apt install -y tree
  # sudo apt install -y bash-completion
  sudo apt install -y less
  sudo apt install -y lsb-release
  sudo apt install -y iputils-ping
  sudo apt install -y htop
  sudo apt install -y python3-pip
  sudo apt install -y python3-argcomplete
  sudo apt install -y p7zip-full
  sudo apt install -y zip
  sudo apt install -y wget
  # sudo apt install -y inotify-tools
  # sudo apt install -y iwyu
  # sudo apt install -y git-lfs
  sudo apt install -y fd-find
  ln -fs $HOME/myconfigs/fd/fdignore ~/.fdignore
  sudo apt install -y bat
  sudo apt install -y curl
  sudo apt install -y lld
  # Needed for st
  sudo apt install -y libxft-dev libx11-dev
  pip3 install argcomplete==2.0.0
  python3 -m pip install --user pipx
  github-setup
  install-ripgrep
end

function install-cpp-dev
  sudo apt install -y clang-tools
  sudo apt install -y clang-tidy
  sudo apt install -y clang
  sudo apt install -y gcc
  sudo apt install -y cmake
  sudo apt install -y dwarves
  # Documentation
  sudo apt install -y zeal
  open https://zealdocs.org/usage.html
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
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github "BurntSushi/ripgrep" "ripgrep_.*_amd64.deb"
  sudo dpkg -i ripgrep_*
  cd -
end

function install-vscode-cpptools
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  install-from-github "microsoft/vscode-cpptools" "cpptools-linux.vsix"
  unzip cpptools-linux.vsix
  chmod +x extension/debugAdapters/bin/OpenDebugAD7
  rm -rf ~/.config/vscode-cpptools
  mkdir -p ~/.config/vscode-cpptools
  mv extension/ ~/.config/vscode-cpptools/
  cd -
end

function install-fzf
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
  # No need to do this in schroot sessions since we mount the directory
  # if set -q $SCHROOT_SESSION_ID
  mkdir -p ~/.config/fish/functions || true
  wget https://raw.githubusercontent.com/junegunn/fzf/master/shell/key-bindings.fish -O ~/.config/fish/functions/fzf_key_bindings.fish
  # end
  cd -
end



function install-libtree
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

function install-pre-commit
  pip3 install pre-commit
  pip3 install black
  pip3 install cmakelang
  pip3 install cpplint
end

function install-heaptrack
  sudo apt install -y elfutils libdwarf-dev libboost-all-dev gettext
  cd $WORKSPACE_DIR
  git clone git@github.com:KDE/heaptrack.git || true
  cd heaptrack
  sudo apt-get install -y extra-cmake-modules libunwind-dev libkchart-dev libkf5coreaddons-dev libkf5i18n-dev libkf5itemmodels-dev libkf5threadweaver-dev libkf5configwidgets-dev libkf5kio-dev
  mkdir -p build && cd build && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install ..
  make install -j(nproc)
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
  mkdir -p ~/.config/i3/
  ln -fs ~/myconfigs/i3_config ~/.config/i3/config
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
  python3 -m pip install --user --upgrade pynvim
  pip3 install -U jedi-language-server
  pip3 install -U debugpy
  pip3 install python-lsp-black
  pip3 install pyls-isort
  pip3 install pylsp-mypy
end

function install-rust-lsp
  curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
  # rustup +nightly component add rust-analyzer-preview
  mkdir -p ~/.local/bin
  curl -L https://github.com/rust-analyzer/rust-analyzer/releases/latest/download/rust-analyzer-x86_64-unknown-linux-gnu.gz | gunzip -c - > ~/.local/bin/rust-analyzer
  chmod +x ~/.local/bin/rust-analyzer
end

function install-efm-lsp
  # YAML + CMake +
  sudo apt  install -y golang-go
  go get github.com/mattn/efm-langserver
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

# TODO: Add Debian support https://github.com/neovim/neovim/releases
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
  if test (lsb_release -is) = "Debian"
    cd /tmp
    if set -q argv[1] && test $argv[1] = "stable"
      install-from-github neovim/neovim "v.*nvim-linux64.deb"
    else
      install-from-github neovim/neovim "nvim-linux64.deb"
    end
    sudo apt install /tmp/nvim-linux64.deb
    cd -
  else
    if set -q argv[1] && test $argv[1] = "stable"
      sudo add-apt-repository ppa:neovim-ppa/stable
    else
      sudo apt-add-repository ppa:neovim-ppa/unstable
    end
    sudo apt-get update
    sudo apt-get install -y neovim
  end
  nvim -c "PackerInstall" -c "PackerCompite" -c "TSInstall fish c cpp python rust fish bash make cmake lua vim markdown"
end

function install-conan
  pipx install conan
end

function setup-cpp-screatches
  install-conan
  cd $CPP_SCREATCHES_DIR/..
  git clone https://github.com/JafarAbdi/cpp-scratches.git scratches
  cd scratches
  # TODO: Move to a script in cpp-scratches repo
  conan install .
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
  export CARGO_NET_GIT_FETCH_WITH_CLI=true
  cargo install difftastic
end

function install-docker
  # Install Docker
  if ! command -q docker &> /dev/null
    sudo apt install -y curl
    curl -sSL https://get.docker.com/ | sh
    sudo usermod -aG docker (whoami)
  end
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
end

function install-tmux
  # We need at least tmux3.3, the older versions have a bug with focus-events
  # https://github.com/tmux/tmux/releases
  # sudo apt install tmux
  sudo apt install libevent-dev
end

function install-nodejs
  sudo apt install nodejs
  mkdir -p $HOME/.npm-packages
  npm config set prefix $HOME/.npm-packages
  npm i -g corepack
end

function install-json-lsp
  install-nodejs
  npm i -g vscode-langservers-extracted
end

function install-yaml-lsp
  install-nodejs
  git clone --depth=1 git@github.com:redhat-developer/yaml-language-server.git ~/.config/yaml-lsp
  cd ~/.config/yaml-lsp
  yarn global add yaml-language-server
  cd -
end

function install-cmake-lsp
  cd ~/.config
  curl -sSL https://raw.githubusercontent.com/python-poetry/poetry/master/get-poetry.py | python3 -
  git clone git@github.com:JafarAbdi/cmake-language-server.git
  cd cmake-language-server
  poetry build
  pip install ./dist/cmake-language-server-0.1.3.tar.gz
  cd -
end
