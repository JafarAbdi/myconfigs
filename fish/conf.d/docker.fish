function start_docker -d "Start docker image with gpu support"
  set -l user juruc
  if test (count $argv) -eq 0 ||
     test $argv[1] = "-h" ||
     test $argv[1] = "--help"
      echo "Usage: start_docker <image name> <optional container name>"
    return
  end
  if test -n $argv[2] && contains -- $argv[2] (docker container list --all --format "{{.Names}}")
    echo "'$argv[2]' correspond to already existing container"
    echo "Make sure to stop/remove it"
    return
  end
  set -l cid (docker run \
                     --detach \
                     --interactive \
                     --gpus all \
                     # --privileged \
                     # --cap-add=all \
                     # --cap-add sys_ptrace \
                     --userns=keep-id \
                     -v /tmp/.X11-unix:/tmp/.X11-unix \
                     -v $HOME/workspaces:$HOME/workspaces \
                     -v $HOME/myconfigs:$HOME/myconfigs:ro \
                     -v $HOME/.ssh:$HOME/.ssh:ro \
                     -e HOME \
                     -e USER \
                     -t \
                     --entrypoint=/bin/bash \
                     --name "$argv[2]" \
                     $argv[1])
  if test $status -ne 0
    echo "Failed to start docker container"
    return
  end
  docker exec --user root -it $cid bash -c "passwd $user"
  docker exec --user root $cid bash -c "apt update"
  docker exec --user root $cid bash -c "apt install -y sudo"
  docker exec --user root $cid bash -c "adduser $user sudo"
  docker exec --user root $cid bash -c "mkhomedir_helper $user"
  docker exec --user root $cid bash -c "chown $user:$user /home/$user"
  docker exec --workdir /home/$user --user $user -it $cid bash
end

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
