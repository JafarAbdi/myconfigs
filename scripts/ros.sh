#!/bin/bash -eu

# Shortcuts for using ROS

# Console output prefix - hides timestamp. See http://wiki.ros.org/rosconsole
export ROSCONSOLE_FORMAT='${logger}: ${message}'
#export ROSCONSOLE_FORMAT='[${severity}] [${time}]: ${message}'
#export ROSCONSOLE_FORMAT='${time}, ${logger}: ${message}'
export ROSCONSOLE_CONFIG_FILE=~/myconfigs/ros/rosconsole.yaml
# Rosdep shortcut
function rosdepinstall {
  # rosdep update
  rosdep install --from-paths . --ignore-src --rosdistro ${ROS_DISTRO} -y
}
function rosdeplistdependencies {
  rosdep install --reinstall --simulate --ignore-src --from-paths .
}
export ROSOUT_DISABLE_FILE_LOGGING=true
export ROSCONSOLE_CONFIG_FILE=~/myconfigs/ros/rosconsole.yaml
export ROS_LANG_DISABLE="geneus;genlisp;gennodejs"
# Kill
alias killgazebo="killall -9 gazebo & killall -9 gzserver  & killall -9 gzclient"
alias killros="pkill -f rosmaster & pkill -f roscore & ps aux | grep ros"

# TF
alias tfpdf='cd /var/tmp && rosrun tf view_frames && open frames.pdf &'

# ROS2 logger configs
export RCUTILS_COLORIZED_OUTPUT=1
export RCUTILS_CONSOLE_OUTPUT_FORMAT='[{name}]: {message}'
export RCUTILS_LOGGING_CONFIG_FILE=~/myconfigs/ros/ros2console.yaml
export COLCON_LOG_PATH=/tmp
export ROS_DOMAIN_ID=16
#########################################################################################
# Switching between named workspaces with autocomplete
#
# These functions allow convenient switching between named ROS workspaces by calling.
#
# $: workon workspace_name
#
# For that, workspaces need to be specified inside a file ~/.ros_workspaces.
# The file should contain a list of workspace names and paths starting at $HOME.
# For example workspace_name at $HOME/ros/workspace_x matches the following entry:
#
# workspace_name: ros/workspace_x
#
# The current workspace is also stored in a file to make it available in new shells.
# By adding 'sourceCurrentWorkspace' to the .bashrc the workspace is sourced automatically.
###########################################################################################
# ROS_WORKSPACES_CONFIG: specify your workspaces here

# CURRENT_ROS_WORKSPACE_FILE: stores the current workspace and is generated automatically
CURRENT_ROS_WORKSPACE_FILE=$HOME/.current_ros_workspace

# write workspace name to file and update current_ros_workspace
setCurrentRosWorkspace() {
  local ws=${1:?"Please specifiy a ros workspace path"}
  echo $ws > $CURRENT_ROS_WORKSPACE_FILE
  current_ros_workspace="$ws"
}

# return the current workspace
getCurrentRosWorkspace() {
  if [[ -f "$CURRENT_ROS_WORKSPACE_FILE" ]]; then
    current_ros_workspace="$(< $CURRENT_ROS_WORKSPACE_FILE)"
    echo $current_ros_workspace
  fi
}

## New workon
if command -v register-python-argcomplete3 > /dev/null; then
  eval "$(register-python-argcomplete3 _workon_workspace.py)"
  eval "$(register-python-argcomplete3 ros_build)"
  eval "$(register-python-argcomplete3 ros_test)"
  eval "$(register-python-argcomplete3 clang_tidy)"
  eval "$(register-python-argcomplete3 ros_clang_tidy)"
  eval "$(register-python-argcomplete3 config_clangd)"
fi

source_workspace()
{
  unset LD_LIBRARY_PATH
  unset CMAKE_PREFIX_PATH
  unset CMAKE_MODULE_PATH
  unset AMENT_PREFIX_PATH
  unset ROS_PACKAGE_PATH
  unset AMENT_CURRENT_PREFIX
  unset COLCON_PREFIX_PATH
  unset PATH
  unset PYTHONPATH
  export PATH=$(get_path)
  export PYTHONPATH=$(get_pythonpath)
  export LD_LIBRARY_PATH=$(get_ld_library_path)
  export CMAKE_PREFIX_PATH=$(get_cmake_prefix_path)
  local command=$(_workon_workspace.py --workspace-name $1)
  echo $command
  eval $command
  export CURRENT_ROS_WORKSPACE=$1
}

workon()
{
  source_workspace $1
  local workspace_path=$(_workon_workspace.py --workspace-path $1)
  if [[ -n "$workspace_path" ]]; then
    cd $workspace_path
  fi
  setCurrentRosWorkspace $1
}

_workon()
{
  COMPREPLY=($(compgen -W "$(_workon_workspace.py --workspaces)" -- "${COMP_WORDS[1]}"))
}

complete -F _workon workon

is_ros1 () {
    local array=('melodic' 'noetic')
    local seeking=$ROS_DISTRO
    local in=1
    for element in "${array[@]}"; do
        if [[ $element == "$seeking" ]]; then
            in=0
            break
        fi
    done
    return $in
}

# TODO Add ROS1 support
__ros_pkgs() {
  # colcon list --names-only | sed 's/\t//' 2> /dev/null
  find src -name package.xml -exec grep -hoPm1 "(?<=<name>)[^<]+" {} +
}
__cmake_build_types()
{
  echo "Debug Release RelWithDebInfo MinSizeRel"
}


# TODO: Add catkin support
function rosclean
{
  if [[ -f $PWD/build/COLCON_IGNORE || -f $PWD/install/COLCON_IGNORE || -d $PWD/.catkin_tools ]]; then
    set -x
    if [[ -z "$1" ]]; then
      rm -r $PWD/log $PWD/install $PWD/build
    else
      rm -r $PWD/install/$1 $PWD/build/$1
    fi
    set +x
  else
    echo "ROS workspace not found"
  fi
}

_rosclean_completions()
{
    case $COMP_CWORD in
        1)
            COMPREPLY=($(compgen -W "$(__ros_pkgs)" -- "${COMP_WORDS[1]}"));;
    esac
}

complete -F _rosclean_completions rosclean

############# ROS2 cd ###############
_ros2cd_completions()
{
    case $COMP_CWORD in
        1)
            COMPREPLY=($(compgen -W "$(ros2 pkg list | sed 's/\t//')" -- "${COMP_WORDS[1]}"));;
    esac
}

ros2cd()
{
    PKG_ROS2_PATH="$(ros2 pkg prefix $1)"
    if [ "$PKG_ROS2_PATH" == "/opt/ros/$ROS_DISTRO" ]
    then
        COLC_PATH="/opt/ros/$ROS_DISTRO/share/$1"
    else
        if [[ "$PKG_ROS2_PATH" == *"install"* ]]
        then
            # Move to root of project
            COLC_ROOT_PATH="$PKG_ROS2_PATH/../.."
            cd "$COLC_ROOT_PATH"
            COLC_PATH="$COLC_ROOT_PATH/$(colcon list --packages-select "$1" --paths-only)"
        else
            return 2
        fi
    fi
    cd "$COLC_PATH"
}


complete -F _ros2cd_completions ros2cd

