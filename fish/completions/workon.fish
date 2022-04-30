set -l workspaces (_workon_workspace.py --workspaces)
set workspaces $workspaces reset
complete -c workon -x -a "$workspaces"
