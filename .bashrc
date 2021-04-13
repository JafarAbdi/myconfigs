#!/bin/bash

# If not running interactively, don't do anything
[ -z "$PS1" ] && return

# Clear the screen
clear

# don't put duplicate lines in the history. See bash(1) for more options
# ... or force ignoredups and ignorespace
HISTCONTROL=ignoredups:ignorespace

# https://cyb.org.uk/2021/05/03/bash-productivity.html
export HISTIGNORE='pwd:exit:fg:bg:top:clear:history:ls:uptime:df'
# append to the history file, don't overwrite it
shopt -s histappend
export HISTSIZE=100000
export HISTFILESIZE=100000

# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)
HISTSIZE=1000
HISTFILESIZE=2000

# check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

if [[ -d $HOME/myconfigs ]]; then # Host machine case
  export MYCONFIGS_DIR=~/myconfigs
  export OPT_PARSE_DIR=$MYCONFIGS_DIR/optparse
elif [[ -d /root/myconfigs ]]; then # Docker image case
  export MYCONFIGS_DIR=/root/myconfigs
else
  console_red
  echo "Can't find myconfigs directory"
  console_nored
fi

export EDITOR='nvim'
export WORKSPACE_DIR=~/workspaces
export ROS2_WS_DIR=$WORKSPACE_DIR/ros2
export ROS_WS_DIR=$WORKSPACE_DIR/ros

get_path()
{
    local path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:$MYCONFIGS_DIR/scripts:$HOME/.local/bin
    if [[ -d /usr/lib/ccache ]]; then #Only will use if installed
      export path=/usr/lib/ccache:$path
    fi

    if [[ -d $WORKSPACE_DIR/cling ]]; then
      export path=$WORKSPACE_DIR/cling/bin:$path
    fi

    if [[ -d $WORKSPACE_DIR/heaptrack ]]; then
      export path=$WORKSPACE_DIR/heaptrack/install/bin:$path
    fi
    if [[ -d $WORKSPACE_DIR/bloaty ]]; then
      export path=$WORKSPACE_DIR/bloaty/install/bin:$path
    fi
    if [[ -d $WORKSPACE_DIR/easy_profiler ]]; then
      export path=$WORKSPACE_DIR/easy_profiler/install/bin:$path
    fi
    if [[ -d $WORKSPACE_DIR/lsyncd ]]; then
      export path=$WORKSPACE_DIR/lsyncd/install/bin:$path
    fi
    if [[ -d ~/go ]]; then
      export path=~/go/bin:$path
    fi
    test -d "$MYCONFIGS_DIR/optparse" && export path="$MYCONFIGS_DIR/optparse:$path"
    test -d "$WORKSPACE_DIR/vcpkg" && export path="$WORKSPACE_DIR/vcpkg:$path"
    test -d "$WORKSPACE_DIR/ws_drake/install/bin" && export path="$WORKSPACE_DIR/ws_drake/install/bin:$path"
    echo $path
}

get_pythonpath()
{
    local pythonpath=$MYCONFIGS_DIR/scripts
    test -d "$WORKSPACE_DIR/ws_drake/install/lib/python3.8/site-packages" && export pythonpath="$WORKSPACE_DIR/ws_drake/install/lib/python3.8/site-packages:$pythonpath"
    echo $pythonpath
}

get_ld_library_path()
{
    local ld_library_path
    if [[ -d $WORKSPACE_DIR/easy_profiler ]]; then
      export ld_library_path=$WORKSPACE_DIR/easy_profiler/install/lib
    fi
    echo $ld_library_path
}

get_cmake_prefix_path()
{
    local cmake_prefix_path
    if [[ -d $WORKSPACE_DIR/ws_osqp/install ]]; then
      export cmake_prefix_path=$WORKSPACE_DIR/ws_osqp/install
    fi
    echo $cmake_prefix_path
}

export PYTHONPATH=$(get_pythonpath)
export PATH=$(get_path)
export LD_LIBRARY_PATH=$(get_ld_library_path)
export CMAKE_PREFIX_PATH=$(get_cmake_prefix_path)

# set variable identifying the chroot you work in (used in the prompt below)
if [ -z "$debian_chroot" ] && [ -r /etc/debian_chroot ]; then
    debian_chroot=$(cat /etc/debian_chroot)
fi

# set a fancy prompt (non-color, unless we know we "want" color)
case "$TERM" in
    xterm-color) color_prompt=yes;;
esac

# uncomment for a colored prompt, if the terminal has the capability; turned
# off by default to not distract the user: the focus in a terminal window
# should be on the output of commands, not on the prompt
force_color_prompt=yes

if [ -n "$force_color_prompt" ]; then
    if [ -x /usr/bin/tput ] && tput setaf 1 >&/dev/null; then
    # We have color support; assume it's compliant with Ecma-48
    # (ISO/IEC-6429). (Lack of such support is extremely rare, and such
    # a case would tend to support setf rather than setaf.)
    color_prompt=yes
    else
    color_prompt=
    fi
fi

# enable color support of ls and also add handy aliases
if [ -x /usr/bin/dircolors ]; then
    test -r $HOME/.dircolors && eval "$(dircolors -b $HOME/.dircolors)" || eval "$(dircolors -b)"
    alias ls='ls --color=auto'
    alias dir='dir --color=auto'
    alias vdir='vdir --color=auto'

    alias fgrep='fgrep --color=auto'
    alias egrep='egrep --color=auto'
fi

# Remove line numbers in history
alias history="history | sed 's/^[ ]*[0-9]\+[ ]*//'"

# enable programmable completion features (you don't need to enable
# this, if it's already enabled in /etc/bash.bashrc and /etc/profile
# sources /etc/bash.bashrc).
if [ -f /etc/bash_completion ] && ! shopt -oq posix; then
    . /etc/bash_completion
fi

if [[ -d ~/.bash_completion.d ]]; then
  for bash_completion_file in ~/.bash_completion.d/* ; do
    [ -f "$bash_completion_file" ] && . $bash_completion_file
  done
fi

alias myconfigs="cd $MYCONFIGS_DIR"
alias myconfigsr=". ~/.bashrc"
alias ce="cd $WORKSPACE_DIR/compiler-explorer;make dev EXTRA_ARGS='--language C++'"
alias jpnb_tmp="jupyter-notebook /tmp/"

# if [[ -f /.dockerenv ]]; then
#     alias sudo=""
# fi

# TODO: Add support for podman
# if command -v podman > /dev/null; then
#     alias docker=podman
# fi

# install scripts
source $MYCONFIGS_DIR/scripts/installs.sh

# moving around filesystem
source $MYCONFIGS_DIR/scripts/unix.sh

# compressing files e.g. zip
source $MYCONFIGS_DIR/scripts/compress.sh

# git aliases and functions
source $MYCONFIGS_DIR/scripts/git.sh

# helpers for searching through files
source $MYCONFIGS_DIR/scripts/search.sh

# Formatting shortcuts
source $MYCONFIGS_DIR/scripts/formatting.sh

# ROS
source $MYCONFIGS_DIR/scripts/ros.sh

# VCPKG
source $MYCONFIGS_DIR/scripts/vcpkg.sh

# Docker
source $MYCONFIGS_DIR/scripts/docker.sh

# Ament
# source $MYCONFIGS_DIR/scripts/ament.sh

# My configs helpers
source $MYCONFIGS_DIR/scripts/myconfigs.sh

# Cling
# source $MYCONFIGS_DIR/scripts/cling.sh

# Autocomplete for gh
if command -v gh &> /dev/null
then
    eval "$(gh completion -s bash)"
fi

# https://unix.stackexchange.com/questions/73498/how-to-cycle-through-reverse-i-search-in-bash
# stty -ixon

function parse_catkin_profile {
  catkin_profile=`catkin profile list --active -u`
  if [[ "$catkin_profile" != "A catkin workspace must be initialized before profiles can be managed." ]]; then
    echo $catkin_profile
  fi
}
getCurrentRosWorkspace > /dev/null
if [[ -n "$current_ros_workspace" ]]; then
  source_workspace $current_ros_workspace 2> /dev/null
fi

alias cmake='cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
