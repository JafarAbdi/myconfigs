#!/bin/sh
tmpfile=$(mktemp /tmp/st-edit.XXXXXX)
trap  'rm "$tmpfile"' 0 1 15
cat > "$tmpfile"
tmux popup -d '#{pane_current_path}' -xC -yC -w80% -h80% -E "nvim +noswapfile +'setlocal buftype=nofile' +'setlocal bufhidden=hide' $tmpfile"
