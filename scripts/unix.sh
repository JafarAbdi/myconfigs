#!/bin/bash -eu

# get just the ip address
function myip
{
    ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'
}

ex () {
    if [ -f $1 ] ; then
        case $1 in
            *.tar.bz2)   tar xjf $1     ;;
            *.tar.gz)    tar xzf $1     ;;
            *.bz2)       bunzip2 $1     ;;
            *.rar)       rar x $1       ;;
            *.gz)        gunzip $1      ;;
            *.tar)       tar xf $1      ;;
            *.tbz)       tar xjf $1     ;;
            *.tbz2)      tar xjf $1     ;;
            *.tgz)       tar xzf $1     ;;
            *.zip)       unzip $1       ;;
            *.Z)         uncompress $1  ;;
            *.7z)        7z x $1        ;;
            *.tar.xz)    tar xf $1      ;;
            *)           echo "'$1' cannot be extracted via extract()" ;;
        esac
    else
        echo "'$1' is not a valid file"
    fi
}

# Clipboard
alias xc="xclip" # copy
alias xv="xclip -o" # paste
alias pwdxc="pwd | xclip"
alias copy="xclip -sel clip"
alias paste="xclip -sel clip -o"
alias open="xdg-open"
alias disk_usage="df -h"
if command -v batcat > /dev/null; then
    alias bat="batcat"
    alias cat='bat --paging=never'
fi
# gdb
alias gdbrun='gdb --ex run --args '
alias colorless='sed -r "s/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]//g"'
repeat()
{
  if [[ "$1" == "--help" ]]; then
    echo "Usage: repeat [Number of time to repeat - default: 10] command"
    return
  fi
	local n="10"
	if [[ "$1" =~ ^[0-9]+$ ]]; then
		n="$1"
		shift
	fi
	echo "Running '$@' $n times"
	for ((i=1; i<="$n"; i++))
	do
		echo "Iteration $i/$n"
    	"$@"
    	if [[ $? -eq 1 ]]; then
			echo "Iteration $i failed"
			break
    	fi
  	done
}

kill_all()
{
    if [[ -z "$1" ]]; then
        echo "You need to specify the a name as an argument"
        return
    fi
    ps aux | grep $1 | awk '{print $2}' | xargs kill -9
}

# fzf settings
# Options to fzf command
if command -v fdfind > /dev/null; then
  alias fd="fdfind"
fi
FZF_COMMANDS="$(command -v fd fdfind find | tr '\n' ':')"
export FD_OPTIONS="--follow"
export FIND_OPTIONS='-not -path "*/\.git*" -not -path "*/.*" -not -path "*/\__pycache__*"'

case "${FZF_COMMANDS}" in
  */fd:*)     FZF_ALT_C_COMMAND="fd --type directory $FD_OPTIONS"
              FZF_DEFAULT_COMMAND="fd --type f $FD_OPTIONS";;
  */fdfind:*) FZF_ALT_C_COMMAND="fdfind --type directory $FD_OPTIONS"
              FZF_DEFAULT_COMMAND="fdfind --type f $FD_OPTIONS";;
  */find:*)   FZF_ALT_C_COMMAND="find . -type d $FIND_OPTIONS"
              FZF_DEFAULT_COMMAND="find . -type f $FIND_OPTIONS";;
esac
export FZF_ALT_C_COMMAND
export FZF_DEFAULT_COMMAND

export FZF_DEFAULT_OPTS="--no-mouse --height 80% --reverse --multi --info=inline --preview \
                         '[[ \$(file --mime {}) =~ binary ]] && echo {} is a binary file || \
                         (batcat --style=numbers --color=always {} || cat {}) 2> /dev/null || \
                         head -300' \
                         --preview-window='right:50%:wrap' \
                         --bind='f2:toggle-preview' \
                         --bind='f3:execute-silent(subl {} || $EDITOR {})' \
                         --bind='f4:execute(nvim {} < /dev/tty > /dev/tty 2>&1)' \
                         --bind='ctrl-h:reload($FZF_DEFAULT_COMMAND --hidden)'"
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
# export FZF_ALT_C_COMMAND="fdfind --type d $FD_OPTIONS"
if command -v _fzf_setup_completion &> /dev/null; then
    _fzf_setup_completion path subl clion bat nvim
fi
