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
