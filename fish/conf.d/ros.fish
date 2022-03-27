# Shortcuts for using ROS
set -xg CURRENT_ROS_WORKSPACE_FILE $HOME/.current_ros_workspace
# Console output prefix - hides timestamp. See http://wiki.ros.org/rosconsole
set -xg ROSCONSOLE_FORMAT "\${logger}: \${message}"
set -xg ROSCONSOLE_CONFIG_FILE ~/myconfigs/rosconsole.conf

# Rosdep shortcut
function rosdepinstall
  # rosdep update
  rosdep install --from-paths . --ignore-src --rosdistro $ROS_DISTRO -y
end

function rosdeplistdependencies
  rosdep install --reinstall --simulate --ignore-src --from-paths .
end

set -xg ROSOUT_DISABLE_FILE_LOGGING true
set -xg ROSCONSOLE_CONFIG_FILE ~/myconfigs/ros/rosconsole.conf
set -xg ROS_LANG_DISABLE "geneus;genlisp;gennodejs"

# TF
alias tfpdf='cd /var/tmp && rosrun tf view_frames && open frames.pdf &'

# ROS2 logger configs
set -xg RCUTILS_COLORIZED_OUTPUT 1
set -xg RCUTILS_CONSOLE_OUTPUT_FORMAT '[{name}]: {message}'
set -xg RCUTILS_LOGGING_CONFIG_FILE ~/myconfigs/ros/ros2console.conf
set -xg COLCON_LOG_PATH /tmp
set -xg ROS_DOMAIN_ID 16

function workon
  if test (count $argv) -ne 1
    echo "workon expects 1 input"
    return 1
  end
  if test (_workon_workspace.py --workspace-exists $argv[1]) = "false"
    echo "Unknown workspace '"$argv[1]"'"
    return
  end
  source_workspace $argv[1]
  set -l workspace_path (_workon_workspace.py --workspace-path $argv[1])
  cd $workspace_path
  set_current_ros_workspace $argv[1]
end

function source_workspace
  if test (count $argv) -ne 1
    echo "source_workspace expects 1 input"
    return 1
  end
  set --erase LD_LIBRARY_PATH
  set --erase CMAKE_PREFIX_PATH
  set --erase CMAKE_MODULE_PATH
  set --erase AMENT_PREFIX_PATH
  set --erase ROS_PACKAGE_PATH
  set --erase AMENT_CURRENT_PREFIX
  set --erase COLCON_PREFIX_PATH
  set --erase PATH
  set --erase PYTHONPATH
  fish_add_path -aP (get_path)
  set -xg PATH (get_path)
  set -xg PYTHONPATH (get_pythonpath)
  set -xg LD_LIBRARY_PATH (get_ld_library_path)
  set -xg CMAKE_PREFIX_PATH (get_cmake_prefix_path)
  set -l command (_workon_workspace.py --workspace-name $argv[1])
  eval "bass '$command'"
  set -xg CURRENT_ROS_WORKSPACE $argv[1]
end

function get_current_ros_workspace
  if test -e $CURRENT_ROS_WORKSPACE_FILE
    read -gx current_ros_workspace < $CURRENT_ROS_WORKSPACE_FILE
    echo $current_ros_workspace
    return 0
  end
  echo ""
end

function set_current_ros_workspace
  if test (count $argv) -ne 1
    echo "workon expects a workspace argument"
    return 1
  end
  echo "$argv[1]" > $CURRENT_ROS_WORKSPACE_FILE
  set -xg current_ros_workspace $argv[1]
end
