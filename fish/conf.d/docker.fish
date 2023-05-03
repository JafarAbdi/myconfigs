function setup_container
  if test (count $argv) -eq 0 ||
     test $argv[1] = "-h" ||
     test $argv[1] = "--help"
      echo "Usage: setup_container <container name>"
    return
  end
  set -l container_name $argv[1]
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/myconfigs" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker cp $HOME/myconfigs $container_name:$HOME/myconfigs
  end
  docker exec $container_name mkdir -p $HOME/.config
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/.config/gh" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker cp $HOME/.config/gh $container_name:$HOME/.config/gh
  end
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/.config/github-copilot" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker cp $HOME/.config/github-copilot $container_name:$HOME/.config/github-copilot
  end
  docker exec -it $container_name bash -c "cd ~/myconfigs && make setup-fish core dev-core dev-cpp dev-python"
end

complete -c setup_container -x -a '(__fish_print_docker_containers running)'

function start_podman -d "Start a podman image with gpu support"
  set -l user $USER
  if test (count $argv) -eq 0 ||
     test $argv[1] = "-h" ||
     test $argv[1] = "--help"
      echo "Usage: start_podman <image name> <optional container name>"
    return
  end
  set -l podman_name
  if test -z $argv[2]
    while true
      set podman_name (shuf -n1 /usr/share/dict/words | grep -v "'s\$" | string lower)
      if test $podman_name
        echo "No input for container name, using '$podman_name'"
        break
      end
    end
  else
    set podman_name $argv[2]
  end
  if contains -- $podman_name (podman container list --all --format "{{.Names}}")
    echo "'$podman_name' correspond to already existing container"
    echo "Make sure to stop/remove it"
    return
  end
  podman pull $argv[1]
  if test $status -ne 0
    echo "Failed to pull image $argv[1]"
    return
  end
  set -l cid (podman run \
                     --detach \
                     --interactive \
                     --gpus all \
                     # --privileged \
                     # --cap-add=all \
                     --cap-add SYS_PTRACE \
                     # Next two lines fix an issue with using appimage in podman
                     # https://github.com/s3fs-fuse/s3fs-fuse/issues/647#issuecomment-392697838
                     --cap-add SYS_ADMIN \
                     --device /dev/fuse \
                     --userns=keep-id \
                     -v /tmp/.X11-unix:/tmp/.X11-unix \
                     -v $HOME/workspaces:$HOME/workspaces \
                     -v $HOME/myconfigs:$HOME/myconfigs:ro \
                     -v $HOME/.ssh:$HOME/.ssh:ro \
                     -v $HOME/.config/gh:$HOME/.config/gh:ro \
                     -e HOME \
                     -e USER \
                     -e PODMAN_NAME=$podman_name \
                     -t \
                     --entrypoint=/bin/bash \
                     --name "$podman_name" \
                     $argv[1])
  if test $status -ne 0
    echo "Failed to start podman container"
    return
  end
  podman exec --user root -it $cid bash -c "passwd $user" && \
  podman exec --user root $cid bash -c "apt update" && \
  podman exec --user root $cid bash -c "apt install -y sudo vim" && \
  podman exec --user root $cid bash -c "adduser $user sudo" && \
  podman exec --user root $cid bash -c "mkhomedir_helper $user" && \
  podman exec --user root $cid bash -c "chown $user:$user /home/$user" && \
  podman exec --user root $cid bash -c "chown $user:$user /home/$user/.config" && \
  # TODO: Why this's no longer working?
  # podman exec --user root $cid bash -c "usermod -d /home/$user $user"
  podman exec --user root -it $cid bash -c "vim /etc/passwd" && \
  podman exec --workdir /home/$user --user $user -it $cid bash
end

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
