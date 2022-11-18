# don't put duplicate lines in the history. See bash(1) for more options
# ... or force ignoredups and ignorespace
set HISTCONTROL ignoredups:ignorespace

# https://cyb.org.uk/2021/05/03/bash-productivity.html
set -x HISTIGNORE 'pwd:exit:fg:bg:top:clear:history:ls:uptime:df'
# append to the history file, don't overwrite it
# TODO: shopt -s histappend
set -x HISTSIZE 100000
set -x HISTFILESIZE 100000

if test -d $HOME/myconfigs # Host machine case
  set -x MYCONFIGS_DIR ~/myconfigs
else if test -d /root/myconfigs # Docker image case
  set -x MYCONFIGS_DIR /root/myconfigs
else
  set_color red
  echo "Can't find myconfigs directory"
  set_color normal
end

set -g fish_function_path $fish_function_path $MYCONFIGS_DIR/fish/functions

set -x EDITOR 'nvim'
set -x TERMINAL '/usr/local/bin/st'
set -x WORKSPACE_DIR ~/workspaces
set -x ROS2_WS_DIR $WORKSPACE_DIR/ros2
set -x ROS_WS_DIR $WORKSPACE_DIR/ros
set fish_greeting
set MAMBA_LEFT_PROMPT
set -x SCHROOT_DIR /srv/chroot
set -x CPP_SCREATCHES_DIR $HOME/workspaces/cpp/scratches
set -x RUST_SCREATCHES_DIR $HOME/workspaces/rust/scratches/src/bin
set -x NPM_PACKAGES "$HOME/.npm-packages"
set -x MANPATH $NPM_PACKAGES/share/man $MANPATH

function get_path
    set -l path /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:$MYCONFIGS_DIR/scripts:$HOME/.local/bin
    if test -d /usr/lib/ccache
      set path /usr/lib/ccache:$path
    end

    if test -d $WORKSPACE_DIR/cling
      set path $WORKSPACE_DIR/cling/bin:$path
    end
    if test -d $WORKSPACE_DIR/heaptrack
      set path $WORKSPACE_DIR/heaptrack/install/bin:$path
    end
    if test -d $WORKSPACE_DIR/bloaty
      set path $WORKSPACE_DIR/bloaty/install/bin:$path
    end
    if test -d $WORKSPACE_DIR/easy_profiler
      set path $WORKSPACE_DIR/easy_profiler/install/bin:$path
    end
    if test -d $MYCONFIGS_DIR/optparse
      set path $MYCONFIGS_DIR/optparse:$path
    end
    if test -d $WORKSPACE_DIR/vcpkg
      set path $WORKSPACE_DIR/vcpkg:$path
    end
    if test -d /opt/drake/bin
      set path /opt/drake/bin:$path
    end
    if test -d $HOME/.cargo/bin
      export CARGO_NET_GIT_FETCH_WITH_CLI=true
      set path $HOME/.cargo/bin:$path
    end
    if test -d $HOME/.config/mold/bin
      set path $HOME/.config/mold/bin:$path
    end
    if test -d $HOME/.poetry/bin
      set path $HOME/.poetry/bin:$path
    end
    if test -d $HOME/.config/lua-lsp/bin
      set path $HOME/.config/lua-lsp/bin:$path
    end
    if test -d $HOME/.config/efm-lsp
      set path $HOME/.config/efm-lsp:$path
    end
    if test -d $NPM_PACKAGES/bin
      set path $NPM_PACKAGES/bin:$path
    end
    if test -d $HOME/.luarocks/bin
      set path $HOME/.luarocks/bin:$path
    end
    if test -d $HOME/.config/mosek/10.0/tools/platform/linux64x86/bin
      set path $HOME/.config/mosek/10.0/tools/platform/linux64x86/bin:$path
      if test -f $HOME/mosek/mosek.lic
        export MOSEKLM_LICENSE_FILE=$HOME/mosek/mosek.lic
      end
    end
    echo $path
end

function get_pythonpath
    set -l pythonpath $MYCONFIGS_DIR/scripts
    if test -d /opt/drake/lib
      set pythonpath "/opt/drake/lib/python"(python3 -c 'import sys; print("{0}.{1}".format(*sys.version_info))')"/site-packages"
    end
    echo $pythonpath
end

function get_ld_library_path
    set -l ld_library_path
    if test -d /opt/drake/lib
      set ld_library_path /opt/drake/lib
    end
    if test -d $WORKSPACE_DIR/easy_profiler
      set ld_library_path $WORKSPACE_DIR/easy_profiler/install/lib
    end
    echo $ld_library_path
end

function get_cmake_prefix_path
    set -l cmake_prefix_path
    if test -d $WORKSPACE_DIR/ws_osqp/install
      set cmake_prefix_path $WORKSPACE_DIR/ws_osqp/install
    end
    echo $cmake_prefix_path
end

set -xg PYTHONPATH (get_pythonpath)
set -xg PATH (get_path)
set -xg LD_LIBRARY_PATH (get_ld_library_path)
set -xg CMAKE_PREFIX_PATH (get_cmake_prefix_path)
set -xg BROWSER "firefox"

for config_file in $MYCONFIGS_DIR/fish/conf.d/*
  source $config_file
end

get_current_ros_workspace > /dev/null
if [ "$current_ros_workspace" != "" ]
  source_workspace $current_ros_workspace
end

if command -v rustup &> /dev/null
  export RUST_ANALYZER_BIN=(rustup which rust-analyzer)
end

alias myconfigs "cd $MYCONFIGS_DIR"
alias myconfigsr "source ~/.config/fish/config.fish"
alias cmaked 'cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
alias cmake 'cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'

if python3 -m jedi &> /dev/null
  export PYTHONSTARTUP=(python3 -m jedi repl)
end
export MYPYPATH=$HOME/.cache/python-stubs/stubs

register-argcomplete clang_tidy
register-argcomplete config_clangd
if test -e /usr/share/vcstool-completion/vcs.fish
  source /usr/share/vcstool-completion/vcs.fish
end
if test -e /opt/ros/noetic/share/rosbash/rosfish
  source /opt/ros/noetic/share/rosbash/rosfish
end
register-argcomplete ros_clang_tidy
register-argcomplete _workon_workspace.py
register-argcomplete ros_build
register-argcomplete ros_test
# TODO: Push upstream
register-argcomplete ros2
register-argcomplete rosidl
register-argcomplete ament_cmake
register-argcomplete colcon

for file in $MYCONFIGS_DIR/fish/completions/*
  source $file
end
for file in $HOME/.config/fish/completions/*
  source $file
end

# TODO: Remove
# This fixes a bug before 1.6.13
# Calling neovim serverstart() will print errors
if set -q SCHROOT_SESSION_ID
  if test ! -e /run/user/$SCHROOT_UID || test ! -w /run/user/$SCHROOT_UID
    set -e XDG_RUNTIME_DIR
  end
end
