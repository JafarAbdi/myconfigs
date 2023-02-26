function __fish_start_docker
  echo (docker image list --format "{{.Repository}}:{{.Tag}}") | tr ' ' '\n'
end
complete -c start_docker -x -a '(__fish_start_docker)'
