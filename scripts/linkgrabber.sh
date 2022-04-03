#!/bin/sh
regex='(((http|https|ftp|gopher)|mailto)[.:][^ >"\t]*|www\.[-a-z0-9.]+)[^ .,;\t>">\):]'
url=$(grep -Po "$regex" | uniq | dmenu -p "Go:" -w "$WINDOWID") || exit 0
$BROWSER "$url" > /dev/null
