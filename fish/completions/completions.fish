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

function __fish_start_podman
  echo (podman image list --format "{{.Repository}}:{{.Tag}}") | tr ' ' '\n'
end
complete -c start_podman -x -a '(__fish_start_podman)'
