function fish_prompt
  # if set -q VIRTUAL_ENV
  #   echo -n -s (set_color brmagenta) "("(basename (echo $VIRTUAL_ENV))")" (set_color normal)
  # end
  if test -f /run/.toolboxenv
    set -l TOOLBOX_NAME (cat /run/.containerenv | grep -oP "(?<=name=\")[^\";]+")
    echo -n -s (set_color yellow) "($TOOLBOX_NAME)" (set_color normal)
  end
  if set -q SSH_CONNECTION
    echo -n -s (set_color 877960 --italics) "(ssh)" (set_color normal)
  end
  if test -e /.dockerenv
    echo -n -s "(🐳)"
  end
  if set -q CURRENT_ROS_WORKSPACE
    echo -n -s (set_color D68910) "($CURRENT_ROS_WORKSPACE)" (set_color normal)
  end
  if set -q SCHROOT_SESSION_ID
    echo -n -s (set_color 85C1E9) "($SCHROOT_SESSION_ID)" (set_color normal)
  end

  set -l git (set_color green)(fish_git_prompt | string trim)(set_color normal)
  set -l user (set_color ff99ff)"($USER)"(set_color normal)
  echo "$user""$git" (basename (prompt_pwd))"\$ "
end
