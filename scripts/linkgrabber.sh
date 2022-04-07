#!/bin/sh
regex='(((http|https|ftp|gopher)|mailto)[.:][^ >"\t]*|www\.[-a-z0-9.]+)[^ .,;\t>">\):]'
url=$(grep -Po "$regex" | uniq | fzfmenu --preview="" | awk '{print $1}' | xargs -d '\n' -I{} -n1 -r xdg-open '{}') || exit 0
