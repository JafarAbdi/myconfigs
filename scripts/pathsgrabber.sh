#!/usr/bin/env sh

tmpfile=$(mktemp /tmp/path-grabber.XXXXXX)
pstdin="${TMPDIR:-/tmp}/fzf-pstdin-$$"

cleanup() {
  rm -f $pstdin
  rm -f $tmpfile
}
trap 'cleanup' 0 1 15

mkfifo "$pstdin"
# Regex copied from https://github.com/laktak/extrakto/blob/4179acea28f69853fda9ab15c7564cd73757856c/extrakto.conf#L40
# Check file exists (filename or filename:line_number)
cat \
  | grep -oP "(?:[ \\t\\n\\\"([<\':]|^)(~|\/)?([-~a-za-z0-9_+-,.]+\/[^ \\t\\n\\r|:\"\'$%&)>\\]]*)(:[0-9]+)?" \
  | tr -d ' ' \
  | sed 's@^~/@'$HOME'/@g' \
  | sort -u \
  | perl -ne 'chomp(); if (-e ((split("\\:", "$_"))[0])) {print "$_\n"}' \
  > "$tmpfile"

# background process will run in a different directory
cat $tmpfile > "$pstdin" &
tmux popup -d '#{pane_current_path}' -xC -yC -w80% -h80% -E "fzf < $pstdin || true"
