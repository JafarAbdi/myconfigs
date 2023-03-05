function start_podman -d "Start a podman image with gpu support"
  set -l user juruc
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
  set -l cid (podman run \
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
                     -e PODMAN_NAME=$podman_name \
                     -t \
                     --entrypoint=/bin/bash \
                     --name "$podman_name" \
                     $argv[1])
  if test $status -ne 0
    echo "Failed to start podman container"
    return
  end
  podman exec --user root -it $cid bash -c "passwd $user"
  podman exec --user root $cid bash -c "apt update"
  podman exec --user root $cid bash -c "apt install -y sudo"
  podman exec --user root $cid bash -c "adduser $user sudo"
  podman exec --user root $cid bash -c "mkhomedir_helper $user"
  podman exec --user root $cid bash -c "chown $user:$user /home/$user"
  podman exec --user root $cid bash -c "usermod -d /home/$user $user"
  podman exec --workdir /home/$user --user $user -it $cid bash
end

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
