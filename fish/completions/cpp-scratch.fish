function __fish_cpp_scratch_files
  ls $CPP_SCREATCHES_DIR/*.cpp | xargs -n 1 basename
end
complete -c cpp-scratch -x -a "(__fish_cpp_scratch_files)"
