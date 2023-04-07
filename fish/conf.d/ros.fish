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
  if test $argv[1] != "reset" && test (_workon_workspace.py --workspace-exists $argv[1]) = "false"
    echo "Unknown workspace '"$argv[1]"'"
    return
  end
  source_workspace $argv[1]
  if test $argv[1] = "reset"
    test -e $CURRENT_ROS_WORKSPACE_FILE && rm $CURRENT_ROS_WORKSPACE_FILE
    set --erase current_ros_workspace
  else
    set -l workspace_path (_workon_workspace.py --workspace-path $argv[1])
    cd $workspace_path
    set_current_ros_workspace $argv[1]
  end
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
  if test $argv[1] != "reset"
    set -l command (_workon_workspace.py --workspace-name $argv[1])
    set -xg ROS_PACKAGE_PATH (_workon_workspace.py --ros-package-path $argv[1] | tr ' ' '\n')
    eval "bass '$command'"
    set -xg CURRENT_ROS_WORKSPACE $argv[1]
  end
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

function ros_pkgs
  if test "$argv[1]" = "--ignored"
    fd --no-ignore --hidden --glob .git --exec test -e {//}/COLCON_IGNORE \; --exec echo {//}
    python3 -c '
import rospkg
from pathlib import Path
rospack = rospkg.RosPack(["."])
for pkg in rospack.list():
  if (Path(rospack.get_path(pkg)) / "COLCON_IGNORE").exists():
    print(pkg)'
  else
    fd --no-ignore --hidden --glob .git --exec test ! -e {//}/COLCON_IGNORE \; --exec echo {//}
    python3 -c '
import rospkg
from pathlib import Path
rospack = rospkg.RosPack(["."])
for pkg in rospack.list():
  if not (Path(rospack.get_path(pkg)) / "COLCON_IGNORE").exists():
    print(pkg)'
  end
end

function ros_pkg_path
  python3 -c '
import rospkg
rospack = rospkg.RosPack(["."])
print(rospack.get_path("'$argv[1]'"))'
end

function ros_ignore
  set -l pkgs (FZF_DEFAULT_COMMAND="ros_pkgs" fzf \
                --preview='' \
                --preview-window down,20% \
                --prompt='Not ignored> ' \
                --header='CTRL-F: Not ignored packages / CTRL-R: Ignored packages' \
                --bind='ctrl-f:change-prompt(Not ignored> )+reload(ros_pkgs)' \
                --bind='ctrl-r:change-prompt(Ignored> )+reload(ros_pkgs --ignored)')
  for pkg in $pkgs
    set -l pkg_path
    if test -d $pkg
      set pkg_path $pkg
    else
      set pkg_path (ros_pkg_path $pkg)
    end
    if test -e $pkg_path"/COLCON_IGNORE"
      rm $pkg_path"/COLCON_IGNORE"
    else
      touch $pkg_path"/COLCON_IGNORE"
    end
  end
end
