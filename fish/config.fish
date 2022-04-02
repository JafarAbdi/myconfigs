# don't put duplicate lines in the history. See bash(1) for more options
# ... or force ignoredups and ignorespace
set HISTCONTROL ignoredups:ignorespace

# https://cyb.org.uk/2021/05/03/bash-productivity.html
set -x HISTIGNORE 'pwd:exit:fg:bg:top:clear:history:ls:uptime:df'
# append to the history file, don't overwrite it
# TODO: shopt -s histappend
set -x HISTSIZE 100000
set -x HISTFILESIZE 100000


if status is-interactive
and not set -q TMUX
and command -v tmux &> /dev/null
  exec tmux new-session -s %self
end

if test -d $HOME/myconfigs # Host machine case
  set -x MYCONFIGS_DIR ~/myconfigs
else if test -d /root/myconfigs # Docker image case
  set -x MYCONFIGS_DIR /root/myconfigs
else
  set_color red
  echo "Can't find myconfigs directory"
  set_color normal
end


set -x EDITOR 'nvim'
set -x TERMINAL '/usr/local/bin/st'
set -x WORKSPACE_DIR ~/workspaces
set -x ROS2_WS_DIR $WORKSPACE_DIR/ros2
set -x ROS_WS_DIR $WORKSPACE_DIR/ros
set fish_greeting
set -x SCHROOT_DIR /srv/chroot
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
    if test -d $HOME/go
      set path $HOME/go/bin:$path
    end
    if test -d $MYCONFIGS_DIR/optparse
      set path $MYCONFIGS_DIR/optparse:$path
    end
    if test -d $WORKSPACE_DIR/vcpkg
      set path $WORKSPACE_DIR/vcpkg:$path
      alias cmake_vcpkg="cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_TOOLCHAIN_FILE=$WORKSPACE_DIR/vcpkg/scripts/buildsystems/vcpkg.cmake"
    end
    if test -d $WORKSPACE_DIR/ws_drake/install/bin
      set path $WORKSPACE_DIR/ws_drake/install/bin:$path
    end
    if test -d $HOME/.cargo/bin
      export CARGO_NET_GIT_FETCH_WITH_CLI=true
      set path $HOME/.cargo/bin:$path
    end
    if test -d $HOME/.config/lua-lsp/bin
      set path $HOME/.config/lua-lsp/bin:$path
    end
    echo $path
end

function get_pythonpath
    set -l pythonpath $MYCONFIGS_DIR/scripts
    if test -d $WORKSPACE_DIR/ws_drake/install/lib/python3.8/site-packages
      set pythonpath $WORKSPACE_DIR/ws_drake/install/lib/python3.8/site-packages:$pythonpath
    end
    echo $pythonpath
end

function get_ld_library_path
    set -l ld_library_path
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
set -xg BROWSER "google-chrome"
export LYNX_LSS="$MYCONFIGS_DIR/lynx/lynx.lss"

for config_file in $MYCONFIGS_DIR/fish/conf.d/*
  source $config_file
end

get_current_ros_workspace > /dev/null
if [ "$current_ros_workspace" != "" ]
  source_workspace $current_ros_workspace
end

# eval (python -m virtualfish) &> /dev/null
alias myconfigs "cd $MYCONFIGS_DIR"
alias myconfigsr "source ~/.config/fish/config.fish"
alias ce "cd $WORKSPACE_DIR/compiler-explorer;make dev EXTRA_ARGS='--language C++'"
alias jpnb_tmp "jupyter-notebook /tmp/"
alias cmaked 'cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
alias cmake 'cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
alias bat 'batcat'

bind \ef nnn-cd

set -g fish_complete_path $fish_complete_path $MYCONFIGS_DIR/fish/completions
set -g fish_function_path $fish_function_path $MYCONFIGS_DIR/fish/functions
