function fish_prompt
  if test -f /run/.toolboxenv
    set -l TOOLBOX_NAME (cat /run/.containerenv | grep -oP "(?<=name=\")[^\";]+")
    echo -n -s (set_color yellow) "($TOOLBOX_NAME)" (set_color normal)
  end
  if set -q SSH_CONNECTION
    if set -q MACHINE_NAME
      echo -n -s (set_color 877960 --italics) "($MACHINE_NAME)" (set_color normal)
    else
      echo -n -s (set_color 877960 --italics) "(ssh)" (set_color normal)
    end
  end
  if test -e /.dockerenv && ! set -q CONTAINER_NAME
    echo -n -s (set_color 85C1E9)"🐳"(set_color normal)
  end
  if set -q CONTAINER_NAME
    echo -n -s (set_color 85C1E9) "($CONTAINER_NAME)" (set_color normal)
  end
  if set -q CURRENT_ROS_WORKSPACE
    echo -n -s (set_color D68910) "($CURRENT_ROS_WORKSPACE)" (set_color normal)
  end
  if set -q PIXI_PROMPT
    echo -n -s (set_color yellow)$PIXI_PROMPT(set_color normal)
  end

  set -l worktrees_string ""
  if command -sq git
    set -l worktrees (git worktree list 2> /dev/null)
    set -l worktrees_count (count $worktrees)
    if test $worktrees_count -gt 1
      set worktrees_string "(W:$worktrees_count)"
    end
  end
  set -l git (set_color green)$worktrees_string(fish_git_prompt | string trim)(set_color normal)
  set -l user (set_color ff99ff)"($USER)"(set_color normal)
  echo "$user""$git" (basename (prompt_pwd))"\$ "
end
