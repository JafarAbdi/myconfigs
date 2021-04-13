#!/bin/bash -eu


# Show git branch at prompt:
# Show what git or hg branch we are in
function parse_vc_branch_and_add_brackets {
  gitbranch=`git branch --no-color 2> /dev/null | sed -e '/^[^*]/d' -e 's/* \(.*\)/\ \[\1\]/'`

  if [[ "$gitbranch" != '' ]]; then
    echo $gitbranch
  else
    hg branch 2> /dev/null | awk '{print $1 }'
  fi
}
function is_docker {
  if [[ -f /.dockerenv ]]; then
    echo "[🐳]"
  fi
}
function current_workspace {
  if [[ -n $CURRENT_ROS_WORKSPACE ]]; then
    echo "[$CURRENT_ROS_WORKSPACE]"
  fi
}
function current_schroot_session {
  if [[ -n $SCHROOT_SESSION_ID ]]; then
    echo "[$SCHROOT_SESSION_ID]"
  fi
}
export PS1_CURRENT_SCHROOT_SESSION="\[\033[38;5;6m\]\$(current_schroot_session)\[$(tput sgr0)\]"
export PS1_CURRENT_WORKSPACE="\[\033[38;5;214m\]\$(current_workspace)\[$(tput sgr0)\]"
export PS1_USER="\[\033[34m\][\u]\[$(tput sgr0)\]"
export PS1_IS_DOCKER="\[\033[38;5;2m\]\$(is_docker)\[$(tput sgr0)\]"
export PS1_GIT_BRANCH="\[\033[38;5;2m\]\$(parse_vc_branch_and_add_brackets)\[$(tput sgr0)\]"
export PS1="$PS1_IS_DOCKER"
export PS1+="$PS1_CURRENT_SCHROOT_SESSION"
export PS1+="$PS1_CURRENT_WORKSPACE"
export PS1+="$PS1_USER"
export PS1+="$PS1_GIT_BRANCH"
export PS1+=" \W$ "
# Shortcuts for using git

# Stages all modified and deleted files which are tracked
alias gitau='git add -u'
alias gitb='git branch'
alias gitbsort='git branch --sort=-committerdate' # list branches chronologically by last commit (most to least recent)
alias gitca='git commit --amend'
alias gitcan='git commit --amend --no-edit'
alias gitdiff='GIT_PAGER="" git diff --color-words'  # show the diff for unstaged files
alias gitdiffc='gitdiff --cached'  # show the diff for staged files
alias gitdiffa='gitdiff HEAD'  # show the diff for unstaged and staged files
alias gitdstat='git diff --stat' # show diffstat
alias gitdno='git diff --name-only' # list files modified
alias gitdno1="gitdno HEAD^" # git diff name-only @~1
alias gitdlist1="gitdlist HEAD^"
alias gitdstat1="gitdstat HEAD^"
alias githead="git rev-parse HEAD"
alias gitlg='git lg -p' # generate patches
alias gitorigin='git remote show -n origin'
alias gitr='git remote -v'
alias gitreadme='git commit README.md -m "Updated README" && git push'
alias gitreset='git reset --hard'
alias gitst='git status'
alias gitsub='git submodule update --init --recursive'

alias gitlogcompare="git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr)%Creset' --abbrev-commit --date=relative "

alias gitremoteswich="git remote rename origin upstream"
