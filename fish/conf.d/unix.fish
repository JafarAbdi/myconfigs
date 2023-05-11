alias grep='grep --color=auto'

alias gitst='git status'
alias gitsub='git submodule update --init --recursive'
alias gitlogcompare="git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr)%Creset' --abbrev-commit --date=relative "

# Find and replace string in all files in a directory
#  param1 - old word
#  param2 - new word
function findreplace
  rg --files-with-matches "$argv[1]" | xargs sed -i "s/$argv[1]/$argv[2]/g" ;
end

function findreplacehidden
  rg --files-with-matches --glob '!.git' --hidden "$argv[1]" | xargs sed -i "s/$argv[1]/$argv[2]/g" ;
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

function file-extension
  echo (string split --right --max 1 . $argv[1])[2]
end

function ffmpeg-extract-images
  if test (count $argv) -ne 1
    echo "ffmpeg-extract-images expects one input ffmpeg-extract-images filename"
    return
  end
  ffmpeg -i $argv[1] -vsync 0 %d.png
end

function ffmpeg-remove-audio
  if test (count $argv) -ne 1
    echo "ffmpeg-remove-audio expects one input filename"
    return
  end
  ffmpeg -i $argv[1] -vcodec copy -an "no-audio-"$argv[1]
end

function ffmpeg-convert
  if test (count $argv) -ne 2
    echo "ffmpeg-convert expects two inputs ffmpeg-convert from to"
    return
  end
  set -l from_extension (file-extension $argv[1])
  set -l to_extension (file-extension $argv[2])
  if test "$from_extension" = "gif" && test "$to_extension" = "mp4"
    ffmpeg -i $argv[1] -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" $argv[2]
  else
    echo "Unsopprted conversion from '"$from_extension"' to '"$to_extension"'"
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
alias df 'df -h'
alias free 'free -h'
alias server 'python3 -m http.server'
alias xc="xclip" # copy
alias xv="xclip -o" # paste
alias pwdxc="pwd | xclip"
alias copy="xclip -sel clip"
alias paste="xclip -sel clip -o"
alias disk_usage="df -h"
if command -v batcat &> /dev/null
  alias bat="batcat"
  export BAT_PAGER="less -R"
end
if command -v difft &> /dev/null
  set -gx GIT_EXTERNAL_DIFF "difft --color=always --tab-width=2"
end
# gdb
alias gdbrun='gdb --ex run --args '
alias colorless='sed -r "s/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]//g"'

function lldb-attach
  set -l pids (pid_picker)
  if test (count $pids) -ne 0
    lldb --attach-pid $pids[1]
  end
end

function gdb-attach
  set -l pids (pid_picker)
  if test (count $pids) -ne 0
    gdb attach --ex continue $pids[1]
  end
end

function kill-all
  set -l pids (pid_picker)
  if test (count $pids) -ne 0
    kill -9 $pids
  end
end

function cookiecutter-file
  set -l template_directory $HOME/myconfigs/cookiecutter/
  set -l template_name (fd --type directory --full-path $template_directory --maxdepth 1 --base-directory=$template_directory --strip-cwd-prefix --exclude 'file-generator' |
                        sed 's#/##g'|
                        fzf --preview='')
  if test (count $template_name) -eq 1
    set -l temporary_directory (mktemp -d -p /tmp cookiecutter-XXXXX)
    micromamba run -n myconfigs cookiecutter $template_directory/$template_name --output-dir $temporary_directory project_name=$template_name
    fd --hidden --max-depth 1 --glob '*' $temporary_directory --exec mv {} .
  end
end

function cookiecutter-file-template
  set -l template_directory $HOME/myconfigs/cookiecutter/
  micromamba run -n myconfigs $template_directory/file-generator
end

function restart-zerotier-one
  sudo systemctl stop zerotier-one.service && sudo systemctl start zerotier-one.service
end

function set-timezone
  sudo timedatectl set-timezone $argv[1]
end

function sfs
  # We have to use allow_other if we want to mount it in a docker container. See https://stackoverflow.com/a/61686833
  sshfs -o identityfile=/home/juruc/.ssh/id_rsa,uid=(id -u),gid=(id -g),allow_other,reconnect,default_permissions,auto_cache,no_readahead,Ciphers=chacha20-poly1305@openssh.com $argv[1] $argv[2]
end

function rs-scratch
  nvim $RUST_SCREATCHES_DIR/$argv[1]
end

function cpp-scratch
  nvim $CPP_SCREATCHES_DIR/$argv[1]
end

# fzf settings
# Options to fzf command
set -l FZF_COMMANDS (command -v fd find | tr '\n' ':')
set -xg FD_OPTIONS "--follow"
set -xg FIND_OPTIONS '-not -path "*/\.git*" -not -path "*/.*" -not -path "*/\__pycache__*"'
set -xg FZF_ALT_C_COMMAND
set -xg FZF_DEFAULT_COMMAND

switch "$FZF_COMMANDS"
  case '*/fd:*'
    set FZF_ALT_C_COMMAND "fd  --type directory $FD_OPTIONS . \$dir"
    set FZF_DEFAULT_COMMAND "fd --type f $FD_OPTIONS . \$dir"
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
                         --bind='f3:become(nvim {+1} < /dev/tty > /dev/tty 2>&1)'"

set -xg FZF_CTRL_R_OPTS "--preview=''"

set -xg FZF_CTRL_T_OPTS "--prompt='Files> '" \
                        "--header='CTRL-D: Directories / CTRL-F: Files / CTRL-H: Show hidden files / CTRL-O: no-ignore'" \
                        "--bind='ctrl-d:change-prompt(Directories> )+reload(fd --type d)'" \
                        "--bind='ctrl-f:change-prompt(Files> )+reload($FZF_DEFAULT_COMMAND)'" \
                        "--bind='ctrl-h:change-prompt(Hidden files> )+reload($FZF_DEFAULT_COMMAND --hidden)'" \
                        "--bind='ctrl-o:change-prompt(Do not respect .(git|fd)ignore file> )+reload($FZF_DEFAULT_COMMAND --no-ignore)'"
set -xg FZF_CTRL_T_COMMAND "$FZF_DEFAULT_COMMAND"

function fzf-inline -d "List files and put them under current cursor"
  begin
    fzf | while read -l r; set result $result $r; end
  end
  if [ -z "$result" ]
    commandline -f repaint
    return
  else
    # Remove last token from commandline.
    commandline -t ""
  end
  for i in $result
    commandline -it -- $prefix
    commandline -it -- (string escape $i)
    commandline -it -- ' '
  end
  commandline -f repaint
end

function git-staged
  git status --short | grep 'M  ' | awk '{print $2}' | fzf-inline
end

function git-modified
  git status --short | grep ' M ' | awk '{print $2}' | fzf-inline
end

function git-conflicts
  git status --short | grep 'UU' | awk '{print $2}' | fzf-inline
end

function git-untracked
  git status --short | rg '\?\?' | awk '{print $2}' | fzf-inline
end

function ros_setup_wt
  if test (count $argv) -ne 1
    echo "Usage: ros_setup_wt <worktree name>"
    return 1
  end
  for worktree in (__fish_git_worktree_paths)
    if test (basename $worktree) = $argv[1]
      rm $worktree/COLCON_IGNORE 2> /dev/null || true
    else
      touch $worktree/COLCON_IGNORE
    end
  end
end

function ros_wt
  wt $argv[1] $argv[2]
  ros_setup_wt $argv[1]
end

function wt
  if test (count $argv) -lt 1 -o (count $argv) -gt 2
    echo "Usage: ros_wt <worktree name> [branch name]"
    return 1
  end
  set -l root_dir (dirname (git rev-parse --show-toplevel))
  if not contains -- $argv[1] (__fish_git_worktrees_names)
    if test (count $argv) -eq 1
      echo "Worktree $argv[1] does not exist and no branch name was provided."
      return 1
    else
      git worktree add $root_dir/$argv[1] $argv[2]
    end
  end
  cd $root_dir/$argv[1]
end

function __fish_git_worktree_paths
  git worktree list --porcelain 2> /dev/null | string replace --regex --filter '^worktree\s*' ''
end

function __fish_git_worktrees_names
  __fish_git_worktree_paths | xargs -n 1 basename 2> /dev/null
end

function __fish_wt
  set -l completions

  # Get the current word being completed
  set current_word (commandline -poc)

  # If the cursor is on the first argument
  if test (count $current_word) -eq 1
    set completions (__fish_git_worktrees_names)
  # If the cursor is on the second argument
  else if test (count $current_word) -eq 2
    set completions (git for-each-ref --format='%(refname:short)' refs/heads)
  end

  echo $completions | tr ' ' '\n'
end

function __fish_git_worktrees
    set -l worktrees (git worktree list 2> /dev/null)
    for worktree in $worktrees
      set -l tokens (echo $worktree | string split " " --no-empty)
      set -l path $tokens[1..-3] | string join " "
      set -l branch_name (echo $tokens[-1] | string match -r '\[(.*)\]' --groups-only)
      echo $branch_name\t$path
    end
end

function diffdir
  if test (count $argv) -ne 2
    echo "Usage: diffdir <dir1> <dir2>"
    return 1
  end
  difft --skip-unchanged --color=always $argv[1] $argv[2] | less -R
end

complete -c wt -x -a "(__fish_wt)"
complete -c ros_wt -x -a "(__fish_wt)"

complete -c sfs -w sshfs
complete -c set-timezone -a "(timedatectl list-timezones)"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
