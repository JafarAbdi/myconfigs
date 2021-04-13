set -l files (ls $MYCONFIGS_DIR/nvim/lua/configs)
set files $files init.lua
complete -c nvim_config -x -a "$files"
