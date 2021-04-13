#!/bin/bash -eu

function open_script {
  nvim $MYCONFIGS_DIR/scripts/$1
}

function _open_script()
{
    local cur opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    opts=$(ls $MYCONFIGS_DIR/scripts)

    if [[ ${cur} == * ]] ; then
        COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
        return 0
    fi
}
complete -F _open_script open_script

if command -v register-python-argcomplete3 > /dev/null ; then
  eval "$(register-python-argcomplete3 mynotes)"
fi
# alias mynotes="cd $MYCONFIGS_DIR/mynotes"
# alias gr_mynotes="mynotes;gr"
alias mybashrc="nvim $MYCONFIGS_DIR/.bashrc"
alias mysetup="nvim $MYCONFIGS_DIR/install/setup.sh"
alias myreadme="nvim $MYCONFIGS_DIR/README.md"

function open_note {
  nvim $MYCONFIGS_DIR/mynotes/$1
}

function _open_note()
{
    local cur prev opts
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    opts=$(find $MYCONFIGS_DIR/mynotes -type f -name "*.md" -printf "%f\n")

    if [[ ${cur} == * ]] ; then
        COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
        return 0
    fi
}
complete -F _open_note open_note
