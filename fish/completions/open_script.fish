function __fish_open_script_files
  ls $MYCONFIGS_DIR/scripts
end
complete -c open_script -x -a "(__fish_open_script_files)"
