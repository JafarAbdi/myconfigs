## CPP ##
function install-bloaty
  git clone git@github.com:google/bloaty.git
  cd bloaty
  git submodule update --init --recursive
  mkdir build && cd build
  cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=../install .. && make install -j(nproc)
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

function install-bazel
  sudo apt install -y bazel
  set -l TMP_DIR (mktemp -d -p /tmp install-XXXXXX)
  cd $TMP_DIR
  wget https://raw.githubusercontent.com/bazelbuild/bazel/master/scripts/generate_fish_completion.py
  python3 ./generate_fish_completion.py --bazel=(which bazel) --output=$HOME/.config/fish/completions/bazel.fish
  git clone git@github.com:grailbio/bazel-compilation-database.git ~/.config/bazel-compilation-database
  cd -
end

function install-pre-commit
  if test (lsb_release -sr) = "unstable"
    sudo apt install -y pre-commit black cpplint cmake-format
  else
    pip3 install pre-commit
    pip3 install cmakelang
    pip3 install cpplint
  end
end

function install-cpp-analyzers
  pip3 install -U codechecker
  sudo apt-get install cppcheck
end

## ROS ##
function install-colcon
  sudo apt install -y 'python3-colcon-*' python3-vcstool python3-rosdep
  colcon mixin add default https://raw.githubusercontent.com/colcon/colcon-mixin-repository/master/index.yaml
  colcon mixin update default
  sudo rosdep init
  rosdep update
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
