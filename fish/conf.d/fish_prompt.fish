function fish_prompt
  if set -q VIRTUAL_ENV
    echo -n -s (set_color white) "(" (basename "$VIRTUAL_ENV") ")" (set_color normal) " "
  end
  if test -e ~/.current_ros_workspace
    read -x current_workspace < ~/.current_ros_workspace
    echo -n -s (set_color D68910) "($current_workspace)" (set_color normal)
  end
  if test -e /.dockerenv
    echo -n -s "(🐳)"
  end
  if set -q SCHROOT_SESSION_ID
    echo -n -s (set_color 85C1E9) "($SCHROOT_SESSION_ID)" (set_color normal)
  end

  set -l git (set_color green)(fish_git_prompt | string trim)(set_color normal)
  set -l user (set_color ff99ff)"($USER)"(set_color normal)
  echo "$user""$git" (basename (prompt_pwd))"\$ "
end
