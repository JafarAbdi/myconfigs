alias grep='grep --color=auto'

# Find and replace string in all files in a directory
#  param1 - old word
#  param2 - new word
function findreplace
  grep -lr -e "$argv[1]" * | xargs sed -i "s/$argv[1]/$argv[2]/g" ;
end

function findreplacehidden
  grep -lr -e "$argv[1]" | xargs sed -i "s/$argv[1]/$argv[2]/g" ;
end

function findreplacehiddenexcludegit
  for f in $(find . -not -path '*/\.git*')
    grep --file=$f -lre "$argv[1]" | xargs sed -i "s/$argv[1]/$argv[2]/g" ;
  end
end

# get just the ip address
function myip
    echo "Public IP: " (curl ifconfig.me -s)
    if test (lsb_release -sr) = "20.04"
      ifconfig | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'
    else
      ip a | grep -Eo 'inet (addr:)?([0-9]*\.){3}[0-9]*' | grep -Eo '([0-9]*\.){3}[0-9]*' | grep -v '127.0.0.1'
    end
end

function ex
    if test -f $argv[1]
        switch $argv[1]
          case '*.tar.bz2'
            tar xjf $argv[1]
          case '*.tar.gz'
            tar xzf $argv[1]
          case '*.bz2'
            bunzip2 $argv[1]
          case '*.rar'
            rar x $argv[1]
          case '*.gz'
            gunzip $argv[1]
          case '*.tar'
            tar xf $argv[1]
          case '*.tbz'
            tar xjf $argv[1]
          case '*.tbz2'
            tar xjf $argv[1]
          case '*.tgz'
            tar xzf $argv[1]
          case '*.zip'
            unzip $argv[1]
          case '*.Z'
            uncompress $argv[1]
          case '*.7z'
            7z x $argv[1]
          case '*.tar.xz'
            tar xf $argv[1]
          case '*'
            echo "'$argv[1]' cannot be extracted via extract()"
        end
    else
        echo "'$argv[1]' is not a valid file"
    end
end

# Clipboard
alias xc="xclip" # copy
alias xv="xclip -o" # paste
alias pwdxc="pwd | xclip"
alias copy="xclip -sel clip"
alias paste="xclip -sel clip -o"
alias disk_usage="df -h"
if command -v batcat &> /dev/null
  alias bat="batcat"
end
if command -v difft &> /dev/null
  set -gx GIT_EXTERNAL_DIFF "difft --color=always --tab-width=2"
end
# gdb
alias gdbrun='gdb --ex run --args '
alias colorless='sed -r "s/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]//g"'

function gdb-attach
  set -l pids (pid_picker)
  if test (count $pids) -ne 0
    gdb attach --ex continue $pids[1]
  end
end

function get-ip
  echo "External IP:" (curl ifconfig.me -s)
  echo "Internal IP:" (hostname -I)
end

function kill-all
  set -l pids (pid_picker)
  if test (count $pids) -ne 0
    kill -9 $pids
  end
end
# TODO: Port to fish
# repeat()
# {
#   if [[ "$1" == "--help" ]]; then
#     echo "Usage: repeat [Number of time to repeat - default: 10] command"
#     return
#   fi
# 	local n="10"
# 	if [[ "$1" =~ ^[0-9]+$ ]]; then
# 		n="$1"
# 		shift
# 	fi
# 	echo "Running '$@' $n times"
# 	for ((i=1; i<="$n"; i++))
# 	do
# 		echo "Iteration $i/$n"
#     	"$@"
#     	if [[ $? -eq 1 ]]; then
# 			echo "Iteration $i failed"
# 			break
#     	fi
#   	done

# fzf settings
# Options to fzf command
if command -v fdfind &> /dev/null
  alias fd="fdfind"
end

set -l FZF_COMMANDS (command -v fd fdfind find | tr '\n' ':')
set -xg FD_OPTIONS "--follow"
set -xg FIND_OPTIONS '-not -path "*/\.git*" -not -path "*/.*" -not -path "*/\__pycache__*"'
set -xg FZF_ALT_C_COMMAND
set -xg FZF_DEFAULT_COMMAND

switch "$FZF_COMMANDS"
  case '*/fd:*'
    set FZF_ALT_C_COMMAND "fd --type directory $FD_OPTIONS . \$dir"
    set FZF_DEFAULT_COMMAND "fd --type f $FD_OPTIONS . \$dir"
  case '*/fdfind:*'
    set FZF_ALT_C_COMMAND "fdfind --type directory $FD_OPTIONS . \$dir"
    set FZF_DEFAULT_COMMAND "fdfind --type f $FD_OPTIONS . \$dir"
  case '*/find:*'
    set FZF_ALT_C_COMMAND "find -L \$dir -type d $FIND_OPTIONS"
    set FZF_DEFAULT_COMMAND "find -L \$dir -type f $FIND_OPTIONS"
end

function fzf_preview
  set -l filetype (file --mime --brief $argv[1])
  set -l batcat_args "--color=always" $argv[1]
  if test -n "$argv[2]"
    set batcat_args $batcat_args --highlight-line $argv[2]
  end
  string match -q "*binary" $filetype \
  && echo $argv[1] is a binary file $filetype \
  || batcat $batcat_args || cat $argv[1] 2> /dev/null \
  || head -300
end

set -xg FZF_DEFAULT_OPTS "--no-mouse --height 100% --reverse --multi --info=inline --preview 'fzf_preview {1} {2}' \
                         --color 'hl:-1:underline,hl+:-1:underline:reverse' \
                         --delimiter : \
                         --preview-window 'right,+{2}+3/3,~3'
                         --bind='alt-k:preview-up'
                         --bind='alt-j:preview-down'
                         --bind='f2:toggle-preview' \
                         --bind='f3:execute(nvim (echo {} | cut -d':' -f1,2) < /dev/tty > /dev/tty 2>&1)' \
                         --bind='ctrl-h:reload($FZF_DEFAULT_COMMAND --hidden)'"
set -xg FZF_CTRL_R_OPTS "--preview=''"
set -xg FZF_CTRL_T_COMMAND "$FZF_DEFAULT_COMMAND"
