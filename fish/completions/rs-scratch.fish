function __fish_rust_scratch_files
  test -d $RUST_SCREATCHES_DIR || mkdir -p $RUST_SCREATCHES_DIR
  ls $RUST_SCREATCHES_DIR
end
complete -c rs-scratch -x -a "(__fish_rust_scratch_files)"
