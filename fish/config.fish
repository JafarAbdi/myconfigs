set fish_greeting

set -x EDITOR 'nvim'
set -x WORKSPACE_DIR ~/workspaces
set -x ROS2_WS_DIR $WORKSPACE_DIR/ros2
set -x ROS_WS_DIR $WORKSPACE_DIR/ros
set MAMBA_LEFT_PROMPT
set -x CPP_SCREATCHES_DIR $HOME/workspaces/cpp/scratches
set -x RUST_SCREATCHES_DIR $HOME/workspaces/rust/scratches/src/bin
set -x NPM_PACKAGES "$HOME/.npm-packages"
set -x MANPATH $NPM_PACKAGES/share/man $MANPATH
export PIXI_FROZEN=true

function get_path
    set -l path /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:$HOME/.local/bin
    if test -d /usr/lib/ccache
      set path /usr/lib/ccache:$path
    end

    if test -d $WORKSPACE_DIR/cling
      set path $WORKSPACE_DIR/cling/bin:$path
    end
    if test -d $WORKSPACE_DIR/heaptrack
      set path $WORKSPACE_DIR/heaptrack/install/bin:$path
    end
    if test -d $WORKSPACE_DIR/bloaty
      set path $WORKSPACE_DIR/bloaty/install/bin:$path
    end
    if test -d $WORKSPACE_DIR/easy_profiler
      set path $WORKSPACE_DIR/easy_profiler/install/bin:$path
    end
    if test -d $WORKSPACE_DIR/vcpkg
      set path $WORKSPACE_DIR/vcpkg:$path
    end
    if test -d /opt/drake/bin
      set path /opt/drake/bin:$path
    end
    if test -d $HOME/.cargo/bin
      export CARGO_NET_GIT_FETCH_WITH_CLI=true
      set path $HOME/.cargo/bin:$path
    end
    if test -d $HOME/.config/mold/bin
      set path $HOME/.config/mold/bin:$path
    end
    if test -d $HOME/.poetry/bin
      set path $HOME/.poetry/bin:$path
    end
    if test -d $HOME/.config/lua-lsp/bin
      set path $HOME/.config/lua-lsp/bin:$path
    end
    if test -d $HOME/.config/efm-lsp
      set path $HOME/.config/efm-lsp:$path
    end
    if test -d $NPM_PACKAGES/bin
      set path $NPM_PACKAGES/bin:$path
    end
    if test -d $HOME/.luarocks/bin
      set path $HOME/.luarocks/bin:$path
    end
    if test -d $HOME/.config/zig
      set path $HOME/.config/zig:$path
    end
    if test -d $HOME/.config/mosek/10.0/tools/platform/linux64x86/bin
      set path $HOME/.config/mosek/10.0/tools/platform/linux64x86/bin:$path
      if test -f $HOME/mosek/mosek.lic
        export MOSEKLM_LICENSE_FILE=$HOME/mosek/mosek.lic
      end
    end
    echo $path
end

function get_pythonpath
    set -l pythonpath ""
    if test -d /opt/drake/lib
      set pythonpath "/opt/drake/lib/python"(python3 -c 'import sys; print("{0}.{1}".format(*sys.version_info))')"/site-packages"
    end
    echo $pythonpath
end

function get_ld_library_path
    set -l ld_library_path
    if test -d /opt/drake/lib
      set ld_library_path /opt/drake/lib
    end
    if test -d $WORKSPACE_DIR/easy_profiler
      set ld_library_path $WORKSPACE_DIR/easy_profiler/install/lib
    end
    echo $ld_library_path
end

function get_cmake_prefix_path
    set -l cmake_prefix_path
    if test -d $WORKSPACE_DIR/ws_osqp/install
      set cmake_prefix_path $WORKSPACE_DIR/ws_osqp/install
    end
    echo $cmake_prefix_path
end

set -xg PYTHONPATH (get_pythonpath)
set -xg PATH (get_path)
set -xg LD_LIBRARY_PATH (get_ld_library_path)
set -xg CMAKE_PREFIX_PATH (get_cmake_prefix_path)
set -xg BROWSER "firefox"

# if command -v rustup &> /dev/null
#   export RUST_ANALYZER_BIN=(rustup which rust-analyzer)
# end

alias myconfigs "cd ~/myconfigs"
alias mynotes "cd $HOME/mynotes"
alias myconfigsr "source ~/.config/fish/config.fish"
alias cmaked 'cmake -DCMAKE_BUILD_TYPE=Debug -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
alias cmakerd 'cmake -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_EXPORT_COMPILE_COMMANDS=ON'
alias excalidraw 'docker run --rm -dit --name excalidraw -p 5000:80 excalidraw/excalidraw:latest'
alias bazel-generate-compilation-database '$HOME/.config/bazel-compilation-database/generate.py -s'
export MYPYPATH=$HOME/.cache/python-stubs/stubs
export SHELL=fish

if test -e ~/.terminfo/w/wezterm
  export TERM=wezterm
end

############
### Unix ###
############

alias rsync 'rsync -uaSHAXhP'
alias df 'df -h'
alias free 'free -h'
alias server 'python3 -m http.server'
alias xc="xclip" # copy
alias xv="xclip -o" # paste
alias pwdxc="pwd | xclip"
alias copy="xclip -sel clip"
alias paste="xclip -sel clip -o"
alias disk_usage="df -h"
alias grep='grep --color=auto'
alias pgrep='pgrep -af'
alias gitst='git status'
alias gitsub='git submodule update --init --recursive'
alias gitlogcompare="git log --graph --pretty=format:'%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr)%Creset' --abbrev-commit --date=relative "

function fzf-commit
  set -l commit_hash "HEAD"
  if test -n $argv[1]
    set commit_hash $argv[1]
  end
  set -l header "Select commit"
  if test -n $argv[2]
    set header $argv[2]
  end
  git log --pretty=format:'%Cred%h%Creset: %C(yellow)%d%Creset %s %Cgreen(%cr)%Creset' --abbrev-commit --date=relative --color $commit_hash \
    | fzf --preview '' --delimiter ':' --nth 2 --ansi --no-multi --header $header \
    | read --array --delimiter ':' commit
  if test -n "$commit[1]"
    echo $commit[1]
  end
end

function git-bisect
  set -l good_commit (fzf-commit "HEAD" "Select good commit")
  if test -z "$good_commit"
    echo "No good commit selected"
    return
  end
  set -l bad_commit (fzf-commit $good_commit "Select bad commit")
  if test -z "$bad_commit"
    echo "No bad commit selected"
    return
  end
  git bisect start
  git bisect new $good_commit
  git bisect old $bad_commit
end

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

function ex
  set -l file_extension (file-extension $argv[1] | string lower)
  if test "$file_extension" = "conda"
    pixi run --manifest-path ~/myconfigs/pixi.toml cph extract $argv[1]
  else
    atool -qx $argv[1]
  end
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
  set -l from_extension (file-extension $argv[1] | string lower)
  set -l to_extension (file-extension $argv[2] | string lower)
  if test "$from_extension" = "gif" && test "$to_extension" = "mp4"
    ffmpeg -i $argv[1] -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" $argv[2]
  else if test "$from_extension" = "mov" && test "$to_extension" = "mp4"
    ffmpeg -i $argv[1] -q:v 0 $argv[2]
  else
    echo "Unsopprted conversion from '"$from_extension"' to '"$to_extension"'"
  end
end

# Clipboard
if command -v batcat &> /dev/null
  alias bat="batcat"
  export BAT_PAGER="less -R"
end
if command -v difft &> /dev/null
  set -gx GIT_EXTERNAL_DIFF "difft --color=always --tab-width=2"
end
if command -v fzf &> /dev/null
  fzf --fish | source
end
# gdb
alias gdbrun='gdb --ex run --args '
alias colorless='sed -r "s/\x1B\[([0-9]{1,3}(;[0-9]{1,2})?)?[mGK]//g"'

function pid_picker
  ps -ef \
    | fzf --height 100% --border --header-lines 1 --info inline --layout reverse --multi --preview="" \
    | awk '{print $2}'
end

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

function restart-zerotier-one
  sudo systemctl stop zerotier-one.service && sudo systemctl start zerotier-one.service
end

function set-timezone
  sudo timedatectl set-timezone $argv[1]
end

function sfs
  # We have to use allow_other if we want to mount it in a docker container. See https://stackoverflow.com/a/61686833
  sshfs -o identityfile=$HOME/.ssh/id_rsa,uid=(id -u),gid=(id -g),allow_other,reconnect,default_permissions,auto_cache,no_readahead,Ciphers=chacha20-poly1305@openssh.com $argv[1] $argv[2]
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
  git status --porcelain | grep 'M  ' | awk '{print $2}' | fzf-inline
end

function git-modified
  git status --porcelain | grep ' M ' | awk '{print $2}' | fzf-inline
end

function git-conflicts
  git status --porcelain | grep 'UU' | awk '{print $2}' | fzf-inline
end

function git-untracked
  git status --porcelain | rg '\?\?' | awk '{print $2}' | fzf-inline
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

###########
### ROS ###
###########

# Shortcuts for using ROS
set -xg CURRENT_ROS_WORKSPACE_FILE $HOME/.current_ros_workspace
# Console output prefix - hides timestamp. See http://wiki.ros.org/rosconsole
set -xg ROSCONSOLE_FORMAT "\${logger}: \${message}"
set -xg ROSCONSOLE_CONFIG_FILE ~/myconfigs/rosconsole.conf

# Rosdep shortcut
function rosdepinstall
  # rosdep update
  rosdep install --from-paths . --ignore-src --rosdistro $ROS_DISTRO -y
end

function rosdeplistdependencies
  rosdep install --reinstall --simulate --ignore-src --from-paths .
end

set -xg ROSOUT_DISABLE_FILE_LOGGING true
set -xg ROSCONSOLE_CONFIG_FILE ~/myconfigs/ros/rosconsole.conf
set -xg ROS_LANG_DISABLE "geneus;genlisp;gennodejs"

# TF
alias tfpdf='cd /var/tmp && rosrun tf view_frames && open frames.pdf &'

# ROS2 logger configs
set -xg RCUTILS_COLORIZED_OUTPUT 1
set -xg RCUTILS_CONSOLE_OUTPUT_FORMAT '[{name}]: {message}'
set -xg RCUTILS_LOGGING_CONFIG_FILE ~/myconfigs/ros/ros2console.conf
set -xg COLCON_LOG_PATH /tmp
set -xg ROS_DOMAIN_ID 16

function workon
  if test (count $argv) -ne 1
    echo "workon expects 1 input"
    return 1
  end
  if test $argv[1] != "reset" && test (_workon_workspace.py --workspace-exists $argv[1]) = "false"
    echo "Unknown workspace '"$argv[1]"'"
    return
  end
  source_workspace $argv[1]
  if test $argv[1] = "reset"
    test -e $CURRENT_ROS_WORKSPACE_FILE && rm $CURRENT_ROS_WORKSPACE_FILE
    set --erase current_ros_workspace
  else
    set -l workspace_path (_workon_workspace.py --workspace-path $argv[1])
    cd $workspace_path
    set_current_ros_workspace $argv[1]
  end
end

function source_workspace
  if test (count $argv) -ne 1
    echo "source_workspace expects 1 input"
    return 1
  end
  set --erase LD_LIBRARY_PATH
  set --erase CMAKE_PREFIX_PATH
  set --erase CMAKE_MODULE_PATH
  set --erase AMENT_PREFIX_PATH
  set --erase ROS_PACKAGE_PATH
  set --erase AMENT_CURRENT_PREFIX
  set --erase COLCON_PREFIX_PATH
  set --erase PATH
  set --erase PYTHONPATH
  fish_add_path -aP (get_path)
  set -xg PATH (get_path)
  set -xg PYTHONPATH (get_pythonpath)
  set -xg LD_LIBRARY_PATH (get_ld_library_path)
  set -xg CMAKE_PREFIX_PATH (get_cmake_prefix_path)
  if test $argv[1] != "reset"
    set -l command (_workon_workspace.py --workspace-name $argv[1])
    set -xg ROS_PACKAGE_PATH (_workon_workspace.py --ros-package-path $argv[1] | tr ' ' '\n')
    eval "bass '$command'"
    set -xg CURRENT_ROS_WORKSPACE $argv[1]
  end
end

function get_current_ros_workspace
  if test -e $CURRENT_ROS_WORKSPACE_FILE
    read -gx current_ros_workspace < $CURRENT_ROS_WORKSPACE_FILE
    echo $current_ros_workspace
    return 0
  end
  echo ""
end

function set_current_ros_workspace
  if test (count $argv) -ne 1
    echo "workon expects a workspace argument"
    return 1
  end
  echo "$argv[1]" > $CURRENT_ROS_WORKSPACE_FILE
  set -xg current_ros_workspace $argv[1]
end

function ros_pkgs
  if test "$argv[1]" = "--ignored"
    fd --no-ignore --hidden --glob .git --exec test -e {//}/COLCON_IGNORE \; --exec echo {//}
    python3 -c '
import rospkg
from pathlib import Path
rospack = rospkg.RosPack(["."])
for pkg in rospack.list():
  if (Path(rospack.get_path(pkg)) / "COLCON_IGNORE").exists():
    print(pkg)'
  else
    fd --no-ignore --hidden --glob .git --exec test ! -e {//}/COLCON_IGNORE \; --exec echo {//}
    python3 -c '
import rospkg
from pathlib import Path
rospack = rospkg.RosPack(["."])
for pkg in rospack.list():
  if not (Path(rospack.get_path(pkg)) / "COLCON_IGNORE").exists():
    print(pkg)'
  end
end

function ros_pkg_path
  python3 -c '
import rospkg
rospack = rospkg.RosPack(["."])
print(rospack.get_path("'$argv[1]'"))'
end

function ros_ignore
  set -l pkgs (FZF_DEFAULT_COMMAND="ros_pkgs" fzf \
                --preview='' \
                --preview-window down,20% \
                --prompt='Not ignored> ' \
                --header='CTRL-F: Not ignored packages / CTRL-R: Ignored packages' \
                --bind='ctrl-f:change-prompt(Not ignored> )+reload(ros_pkgs)' \
                --bind='ctrl-r:change-prompt(Ignored> )+reload(ros_pkgs --ignored)')
  for pkg in $pkgs
    set -l pkg_path
    if test -d $pkg
      set pkg_path $pkg
    else
      set pkg_path (ros_pkg_path $pkg)
    end
    if test -e $pkg_path"/COLCON_IGNORE"
      rm $pkg_path"/COLCON_IGNORE"
    else
      touch $pkg_path"/COLCON_IGNORE"
    end
  end
end

function rcd
  fd --prune --search-path $HOME --type file --glob package.xml --exec bash -c 'echo -e "\033[0;35m"$(xmllint --xpath "//name/text()" "$1")"\033[0m":$(dirname "{}")' bash {} \
    | fzf --preview '' --delimiter ':' --nth 1 --ansi --no-multi \
    | read --array --delimiter=':' selected
  if test -n "$selected[2]"
    cd $selected[2]
  end
end

function ros_msgs
  if ! set -q ROS_DISTRO
    echo "ROS_DISTRO is not set"
    return 1
  end
  set -l selected (fd --type file --extension action --extension msg --extension srv --search-path /opt/ros/$ROS_DISTRO \
    | fzf --delimiter '/' --nth -1 --no-multi --preview 'less {}')
  if test -n "$selected"
    less $selected
  end
end

get_current_ros_workspace > /dev/null
if [ "$current_ros_workspace" != "" ]
  source_workspace $current_ros_workspace
end

##############
### Docker ###
##############

function setup_container
  if test (count $argv) -eq 0 ||
     test $argv[1] = "-h" ||
     test $argv[1] = "--help"
      echo "Usage: setup_container <container name>"
    return
  end
  set -l container_name $argv[1]
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/myconfigs" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker cp $HOME/myconfigs $container_name:$HOME/myconfigs
  end
  docker exec $container_name mkdir -p $HOME/.config
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/.config/gh" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker cp $HOME/.config/gh $container_name:$HOME/.config/gh
  end
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/.local/share/nvim" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker exec -it $container_name bash -c "mkdir -p $HOME/.local/share" && \
      docker cp $HOME/.local/share/nvim $container_name:$HOME/.local/share/nvim && \
      docker exec -it $container_name bash -c "chown -R $USER:$USER $HOME/.local"
  end
  docker exec --user root -it $container_name bash -c "apt update && apt install make"
  docker exec -it $container_name bash -c "cd ~/myconfigs && make setup-fish core dev-core dev-cpp dev-python"
end

complete -c setup_container -x -a '(__fish_print_docker_containers running)'

function start_container -d "Start a podman|docker image with gpu support"
  if test (count $argv) -eq 0 ||
     test $argv[1] = "-h" ||
     test $argv[1] = "--help"
      echo "Usage: start_container <podman|docker> <image name> <optional container name>"
    return
  end
  if test $argv[1] = "podman"
    set containerprg "podman"
    set extra_args "--device nvidia.com/gpu=all --userns=keep-id"
  else if test $argv[1] = "docker"
    set containerprg "docker"
    set extra_args "--runtime=nvidia --gpus=all --privileged -v /dev:/dev -v /usr/share/vulkan/icd.d:/usr/share/vulkan/icd.d"
  else
    echo "Usage: run_container <podman|docker> <image name> <optional container name>"
    return
  end
  set -l container_name
  if test -z $argv[3]
    while true
      set container_name (shuf -n1 /usr/share/dict/words | grep -v "'s\$" | string lower)
      if test $container_name
        echo "No input for container name, using '$container_name'"
        break
      end
    end
  else
    set container_name $argv[3]
  end
  if contains -- $container_name (eval '$containerprg container list --all --format "{{.Names}}"')
    echo "'$container_name' correspond to already existing container"
    echo "Make sure to stop/remove it"
    return
  end
  set -l user $USER
  # --privileged
  # --cap-add=all
  # --cap-add SYS_ADMIN --device /dev/fuse fixes an issue with using appimage in podman (+ --security-opt apparmor:unconfined for docker)
  # https://github.com/s3fs-fuse/s3fs-fuse/issues/647#issuecomment-392697838
  set -l audio_group_id (getent group audio | cut -d: -f3)
  set -l user_id (id -u)
  set -l run_command $containerprg run \
                     --detach \
                     --interactive \
                     --network host \
                     --cap-add SYS_PTRACE \
                     --cap-add SYS_ADMIN \
                     --device /dev/fuse \
                     --device /dev/snd \
                     -v /run/user/$user_id/pulse:/run/user/$user_id/pulse \
                     -e PULSE_SERVER=unix:$XDG_RUNTIME_DIR/pulse/native \
                     -v $XDG_RUNTIME_DIR/pulse/native:$XDG_RUNTIME_DIR/pulse/native \
                     # --group-add $audio_group_id
                     -v /tmp/.X11-unix:/tmp/.X11-unix \
                     -v $HOME/workspaces:$HOME/workspaces \
                     -v $HOME/myconfigs:$HOME/myconfigs:ro \
                     -v $HOME/.ssh:$HOME/.ssh:ro \
                     -v $HOME/.config/gh:$HOME/.config/gh:ro \
                     -v $HOME/.local/share/nvim:$HOME/.local/share/nvim \
                     -e QT_X11_NO_MITSHM=1 \
                     -e DISPLAY \
                     -e NVIDIA_VISIBLE_DEVICES=all \
                     -e NVIDIA_DRIVER_CAPABILITIES=all \
                     -e HOME \
                     -e USER \
                     -e CONTAINER_NAME=$container_name \
                     -t \
                     --entrypoint=/bin/bash \
                     --name $container_name \
                     $extra_args \
                     $argv[2]

  echo "Running '$run_command'"

  set -l cid (eval $run_command)

  if test $status -ne 0
    echo "Failed to start podman container"
    return
  end
  eval '$containerprg exec --user root $cid bash -c "apt update"'
  eval '$containerprg exec --user root $cid bash -c "apt install -y sudo vim adduser"'
  if test $containerprg = "docker"
    docker exec --user root -it $cid bash -c "groupadd --gid "(id -g)" $USER"
    docker exec --user root -it $cid bash -c "useradd --no-log-init --uid "(id -u)" --gid "(id -g)" -m $USER --groups sudo"
  end
  eval '$containerprg exec --user root $cid bash -c "passwd -d $user"'
  eval '$containerprg exec --user root $cid bash -c "chown $user:$user /home/$user"'
  eval '$containerprg exec --user root $cid bash -c "chown $user:$user /home/$user/.config"'
  eval '$containerprg exec --user root $cid bash -c "chown $user:$user /home/$user/.local"'
  if test $containerprg = "podman"
    # TODO: Why this's no longer working?
    # podman exec --user root $cid bash -c "usermod -d /home/$user $user"
    podman exec --user root -it $cid bash -c "vim /etc/passwd"
  end
  eval '$containerprg exec --workdir /home/$user --user $user -it $cid bash'
end

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

###################
### Completions ###
###################

function register-argcomplete
  if type -f register-python-argcomplete &> /dev/null
    set -l script_path ~/.config/fish/completions/$argv[1].fish
    if command -v $argv[1] &> /dev/null
      if ! test -e $script_path
        register-python-argcomplete --shell fish $argv[1] > $script_path
      end
    end
  end
end

register-argcomplete clang_tidy
register-argcomplete config_clangd
if test -e /usr/share/vcstool-completion/vcs.fish
  source /usr/share/vcstool-completion/vcs.fish
end
if test -e /opt/ros/noetic/share/rosbash/rosfish
  source /opt/ros/noetic/share/rosbash/rosfish
end
register-argcomplete ros_clang_tidy
register-argcomplete _workon_workspace.py
register-argcomplete ros_build
register-argcomplete ros_test
register-argcomplete ros2
register-argcomplete rosidl
register-argcomplete ament_cmake
register-argcomplete colcon

for file in $HOME/.config/fish/completions/*
  source $file
end

function __fish_workon_workspaces
  echo reset (_workon_workspace.py --workspaces) | tr '  ' '\n'
end
complete -c workon -x -a "(__fish_workon_workspaces)"

function __fish_rust_scratch_files
  test -d $RUST_SCREATCHES_DIR || mkdir -p $RUST_SCREATCHES_DIR
  ls $RUST_SCREATCHES_DIR
end
complete -c rs-scratch -x -a "(__fish_rust_scratch_files)"

function __fish_cpp_scratch_files
  ls $CPP_SCREATCHES_DIR/*.cpp | xargs -n 1 basename
end
complete -c cpp-scratch -x -a "(__fish_cpp_scratch_files)"

function __fish_start_container
  set -l completions

  # Get the current word being completed
  set current_word (commandline -poc)

  # If the cursor is on the first argument
  if test (count $current_word) -eq 1
    set completions "podman docker"
  # If the cursor is on the second argument
  else if test (count $current_word) -eq 2
    if test $current_word[2] = "podman"
      set completions (podman image list --format '{{.Repository}}:{{.Tag}}')
    else if test $current_word[2] = "docker"
      set completions (docker image list --format '{{.Repository}}:{{.Tag}}')
    end
  end
  echo $completions | tr ' ' '\n'
end

complete -c start_container -x -a '(__fish_start_container)'

############
### Fish ###
############

function fish_prompt
  if test -f /run/.toolboxenv
    set -l TOOLBOX_NAME (cat /run/.containerenv | grep -oP "(?<=name=\")[^\";]+")
    echo -n -s (set_color yellow) "($TOOLBOX_NAME)" (set_color normal)
  end
  if set -q SSH_CONNECTION
    if set -q MACHINE_NAME
      echo -n -s (set_color 877960 --italics) "($MACHINE_NAME)" (set_color normal)
    else
      echo -n -s (set_color 877960 --italics) "(ssh)" (set_color normal)
    end
  end
  if test -e /.dockerenv && ! set -q CONTAINER_NAME
    echo -n -s (set_color 85C1E9)"🐳"(set_color normal)
  end
  if set -q CONTAINER_NAME
    echo -n -s (set_color 85C1E9) "($CONTAINER_NAME)" (set_color normal)
  end
  if set -q CURRENT_ROS_WORKSPACE
    echo -n -s (set_color D68910) "($CURRENT_ROS_WORKSPACE)" (set_color normal)
  end
  if set -q PIXI_PROMPT
    echo -n -s (set_color yellow)$PIXI_PROMPT(set_color normal)
  end

  set -l worktrees_string ""
  if command -sq git
    set -l worktrees (git worktree list 2> /dev/null)
    set -l worktrees_count (count $worktrees)
    if test $worktrees_count -gt 1
      set worktrees_string "(W:$worktrees_count)"
    end
  end
  set -l git (set_color green)$worktrees_string(fish_git_prompt | string trim)(set_color normal)
  set -l user (set_color ff99ff)"($USER)"(set_color normal)
  echo "$user""$git" (basename (prompt_pwd))"\$ "
end
