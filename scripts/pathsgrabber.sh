#!/usr/bin/env sh

pstdin="${TMPDIR:-/tmp}/fzf-pstdin-$$"

cleanup() {
  rm -f $pstdin
}
trap 'cleanup' EXIT

mkfifo "$pstdin"
# Regex copied from https://github.com/laktak/extrakto/blob/master/extrakto.conf#L39
tmux capture-pane -J -p | perl -lne "print "'"$1$2$3"'" if /(?:[ \\t\\n\\\"([<\':]|^)(~|\/)?([-~a-za-z0-9_+-,.]+\/[^ \\t\\n\\r|:\"\'$%&)>\\]]*)(:[0-9]+)?/" | tr -d ' ' | sed 's@^~/@'$HOME'/@g' | sort -u > "$pstdin" &
tmux popup -d '#{pane_current_path}' -xC -yC -w80% -h80% -E "fzf < $pstdin || true"
