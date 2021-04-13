set -l files (ls $MYCONFIGS_DIR/scripts)
complete -c open_script -x -a "$files"
