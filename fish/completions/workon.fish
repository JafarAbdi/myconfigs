function __fish_workon_workspaces
  echo reset (_workon_workspace.py --workspaces) | tr '  ' '\n'
end
complete -c workon -x -a "(__fish_workon_workspaces)"
