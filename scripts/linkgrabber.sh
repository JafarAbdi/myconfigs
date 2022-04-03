#!/bin/sh
regex='(((http|https|ftp|gopher)|mailto)[.:][^ >"\t]*|www\.[-a-z0-9.]+)[^ .,;\t>">\):]'
url=$(tmux capture-pane -J -p | grep -Po "$regex" | uniq | dmenu -p "Go:" -w "$WINDOWID") || exit
$BROWSER "$url" > /dev/null
