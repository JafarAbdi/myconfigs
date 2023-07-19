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
  if test (docker exec $container_name sh -c 'if [ -d "$HOME/.local/share/nvim" ]; then echo "1"; else echo "0"; fi') -eq 0
    docker exec -it $container_name bash -c "mkdir -p $HOME/.local/share" && \
      docker cp $HOME/.local/share/nvim $container_name:$HOME/.local/share/nvim && \
      docker exec -it $container_name bash -c "chown -R $USER:$USER $HOME/.local"
  end
  docker exec -it $container_name bash -c "cd ~/myconfigs && make setup-fish core dev-core dev-cpp dev-python"
end

complete -c setup_container -x -a '(__fish_print_docker_containers running)'

function start_container -d "Start a podman|docker image with gpu support"
  if test (count $argv) -eq 0 ||
     test $argv[1] = "-h" ||
     test $argv[1] = "--help"
      echo "Usage: start_container <podman|docker> <image name> <optional container name>"
    return
  end
  if test $argv[1] = "podman"
    set containerprg "podman"
    set extra_args "--device nvidia.com/gpu=all --userns=keep-id"
  else if test $argv[1] = "docker"
    set containerprg "docker"
    set extra_args "--runtime=nvidia --gpus=all --privileged -v /dev:/dev -v /usr/share/vulkan/icd.d:/usr/share/vulkan/icd.d"
  else
    echo "Usage: run_container <podman|docker> <image name> <optional container name>"
    return
  end
  set -l container_name
  if test -z $argv[3]
    while true
      set container_name (shuf -n1 /usr/share/dict/words | grep -v "'s\$" | string lower)
      if test $container_name
        echo "No input for container name, using '$container_name'"
        break
      end
    end
  else
    set container_name $argv[3]
  end
  if contains -- $container_name (eval '$containerprg container list --all --format "{{.Names}}"')
    echo "'$container_name' correspond to already existing container"
    echo "Make sure to stop/remove it"
    return
  end
  set -l user $USER
  # --privileged
  # --cap-add=all
  # --cap-add SYS_ADMIN --device /dev/fuse fixes an issue with using appimage in podman (+ --security-opt apparmor:unconfined for docker)
  # https://github.com/s3fs-fuse/s3fs-fuse/issues/647#issuecomment-392697838
  set -l run_command $containerprg run \
                     --detach \
                     --interactive \
                     --network host \
                     --cap-add SYS_PTRACE \
                     --cap-add SYS_ADMIN \
                     --device /dev/fuse \
                     -v /tmp/.X11-unix:/tmp/.X11-unix \
                     -v $HOME/workspaces:$HOME/workspaces \
                     -v $HOME/myconfigs:$HOME/myconfigs:ro \
                     -v $HOME/.ssh:$HOME/.ssh:ro \
                     -v $HOME/.config/gh:$HOME/.config/gh:ro \
                     -v $HOME/.local/share/nvim:$HOME/.local/share/nvim \
                     -e QT_X11_NO_MITSHM=1 \
                     -e DISPLAY \
                     -e NVIDIA_VISIBLE_DEVICES=all \
                     -e NVIDIA_DRIVER_CAPABILITIES=all \
                     -e HOME \
                     -e USER \
                     -e CONTAINER_NAME=$container_name \
                     -t \
                     --entrypoint=/bin/bash \
                     --name $container_name \
                     $extra_args \
                     $argv[2]

  echo "Running '$run_command'"

  set -l cid (eval $run_command)

  if test $status -ne 0
    echo "Failed to start podman container"
    return
  end
  if test $containerprg = "docker"
    docker exec --user root -it $cid bash -c "useradd -s /bin/bash -d /home/$user -m -G sudo $user"
  end
  # Make the password empty
  eval '$containerprg exec --user root -it $cid bash -c "passwd -d $user"'
  eval '$containerprg exec --user root $cid bash -c "apt update"'
  eval '$containerprg exec --user root $cid bash -c "apt install -y sudo vim adduser"'
  eval '$containerprg exec --user root $cid bash -c "adduser $user sudo"'
  # podman exec --user root $cid bash -c "mkhomedir_helper $user" && \
  eval '$containerprg exec --user root $cid bash -c "chown $user:$user /home/$user"'
  eval '$containerprg exec --user root $cid bash -c "chown $user:$user /home/$user/.config"'
  if test $containerprg = "podman"
    # TODO: Why this's no longer working?
    # podman exec --user root $cid bash -c "usermod -d /home/$user $user"
    podman exec --user root -it $cid bash -c "vim /etc/passwd"
  end
  eval '$containerprg exec --workdir /home/$user --user $user -it $cid bash'
end

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
