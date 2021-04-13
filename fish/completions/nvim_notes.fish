set -l notes (ls $MYCONFIGS_DIR/mynotes)
complete -c nvim_notes -x -a "$notes"
