#!/bin/bash

readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

current_date() {
  date +"%F %T"
}

error() {
  echo -e "[$(current_date)] [${RED}error${NC}]: ${1}" >&2
  exit 1
}

warning() {
  echo -e "[$(current_date)] [${YELLOW}warning${NC}]: ${1}" >&2
}

info() {
  echo -e "[$(current_date)] [${GREEN}info${NC}]: ${1}" >&2
}

readonly tailscale_ip=$(ip addr show tailscale0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)

# Define your package directories and session names
declare -A packages=(
    ["deep_learning"]="$HOME/workspaces/deep_learning_playground"
    ["robotics"]="$HOME/workspaces/robotics_playground"
)

info "Launching Jupyter sessions using IP: [$tailscale_ip]"

# Kill existing session if it exists
tmux kill-session -t playgrounds 2>/dev/null
tmux new-session -d -s playgrounds

for session_name in "${!packages[@]}"; do
    directory="${packages[$session_name]}"

    # Check if directory exists
    if [ ! -d "$directory" ]; then
        error "Directory '$directory' does not exist for session '$session_name'"
    fi

    info "Starting tmux session '$session_name' in directory '$directory'"

    tmux new-window -t playgrounds -n $session_name -c $directory
    tmux send-keys -t playgrounds:$session_name "uv run jupyter lab --no-browser --ip=$tailscale_ip" Enter

    info "Session '$session_name' started successfully"
done

info "All sessions launched!"
info "To attach to a session, use: tmux attach -t <session_name>"
info "To list all sessions, use: tmux list-sessions"
