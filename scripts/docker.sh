#!/bin/bash


display_usage() {
    printf "Usage:\n start_docker <name_of_the_container> <name_of_the_image (optional)> <volume_path (optional)>\n"
}

# work-around for https://github.com/moby/moby/issues/34096
# ensures that copied files are owned by the target user
function docker_cp {
  set -o pipefail
  tar --numeric-owner --owner="${docker_uid:-root}" --group="${docker_gid:-root}" -c -f - -C "$(dirname "$1")" "$(basename "$1")" | docker cp - "$2"
  set +o pipefail
}

start_docker()
{
    if [ -z "$1" ]
    then
        display_usage
        return
    else
        IMAGE_NAME=$1
        if [ -z "$1" ]
        then
            printf "Can't find docker with the given name, need image name\n"
            display_usage
            return
        else
            local cid
            set -x
            cid=$(docker create \
                    --net=host \
                    --pid=host \
                    --gpus all \
                    --env=NVIDIA_VISIBLE_DEVICES=all \
                    --env=NVIDIA_DRIVER_CAPABILITIES=all \
                    --env=DISPLAY \
                    --env=QT_X11_NO_MITSHM=1 \
                    -v /tmp/.X11-unix:/tmp/.X11-unix \
                    -v $HOME/myconfigs:/root/myconfigs:ro \
                    -v $HOME/.local/share/JetBrains:/root/.local/share/JetBrains:ro \
                    --cap-add sys_ptrace \
                    "${@:2}" \
                    -t \
                    "$IMAGE_NAME")
            set +x
            # detect user inside container
            local docker_image
            docker_image=$(docker inspect --format='{{.Config.Image}}' "$cid")
            docker_uid=$(docker run --rm "$docker_image" id -u)
            docker_gid=$(docker run --rm "$docker_image" id -g)
            # pass common credentials to container
            if [ -d "$HOME/.ssh" ]; then
              docker_cp "$HOME/.ssh" "$cid:/root/"
              docker_cp "$HOME/.workspaces.yaml" "$cid:/root/"
            fi
            xhost +local:root &> /dev/null
            docker start "$cid"
            docker exec $cid bash -c "eval \"$(ssh-agent -s && ssh-add ~/.ssh/id_rsa)\""
            docker exec $cid bash -c "rm ~/.bashrc && echo \". /root/myconfigs/.bashrc\" >> ~/.bashrc"
            docker exec $cid bash -c "git config --global include.path \"/root/myconfigs/.gitconfig\""
            docker exec $cid bash -c "mkdir -p /root/.local/bin"
            docker cp "$HOME/.local/bin/clion" "$cid:/root/.local/bin/clion"
            docker exec $cid bash -c "mkdir -p /root/.config/clion_configs"
            docker_cp "$HOME/.config/clion_configs" "$cid:/root/.config/"
            docker exec $cid bash -c "apt update"
            docker exec $cid bash -c "apt install -y libnss3 libglu1-mesa"
            docker exec $cid bash -c "apt install -y python3-pip"
            docker exec $cid bash -c "pip3 install argcomplete PyYAML"
            docker exec -it $cid bash
            xhost -local:root 1>/dev/null 2>&1
        fi
    fi
}
#!/usr/bin/env bash

_start_docker_completions()
{
    local IFS=$'\n'
    local LASTCHAR=' '
    case $COMP_CWORD in
        1)
            COMPREPLY=($(compgen -W "$(docker image ls --format "{{.Repository}}:{{.Tag}}" | sed 's/\t//')" -- "${COMP_WORDS[1]}"));;
    esac
}

complete -o nospace -F _start_docker_completions start_docker
