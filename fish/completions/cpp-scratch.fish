set -l cpp_files (ls $CPP_SCREATCHES_DIR/*.cpp | xargs -n 1 basename)
complete -c cpp-scratch -x -a "$cpp_files"
