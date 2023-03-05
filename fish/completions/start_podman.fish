function __fish_start_podman
  echo (podman image list --format "{{.Repository}}:{{.Tag}}") | tr ' ' '\n'
end
complete -c start_podman -x -a '(__fish_start_podman)'
