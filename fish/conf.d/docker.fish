function __start_docker_usage
  echo "Usage: start_docker <image or container name> <optional container name if the first argument is for an image>"
end

# work-around for https://github.com/moby/moby/issues/34096
# ensures that copied files are owned by the target user
function docker_cp -a src -a dst -a uid -a gid
  if test -z $uid
    set uid "root"
  end
  if test -z $gid
    set gid "root"
  end
  tar --numeric-owner --owner=$uid --group=$gid -c -f - -C (dirname $src) (basename $src) | docker cp - $dst
end

# TODO: Replace bash with fish
function start_docker -d "Start docker image with myconfigs & gpu support"
  if test (count $argv) -eq 0 ||
     test $argv[1] = "h" ||
     test $argv[1] = "help"
    __start_docker_usage
    return
  end
  # Check if the argument correspond to a running container
  if contains -- $argv[1] (__fish_print_docker_containers running)
    echo "Container '"$argv[1]"' is running"
    docker exec -it $argv[1] fish
    return
  # Check if the argument correspond to a stopped container
  else if contains -- $argv[1] (__fish_print_docker_containers stopped)
    echo "Container '"$argv[1]"' was stopped"]
    docker start $argv[1]
    docker exec -it $argv[1] fish
    return
  end
  # If the previous two cases are false and it's not an image print error
  if ! contains -- $argv[1] (__fish_print_docker_images)
    echo "Unknown image '"$argv[1]"'"
    __fish_print_docker_images
    return
  end
  if test -n $argv[2] && contains -- $argv[2] (__fish_print_docker_containers all)
    echo "'$argv[2]' correspond to already existing container"
    echo "Make sure to stop/remove it"
    return
  end
  set -l cid (docker run \
                     --detach \
                     --interactive \
                     --net=host \
                     --pid=host \
                     --gpus all \
                     --env=NVIDIA_VISIBLE_DEVICES=all \
                     --env=NVIDIA_DRIVER_CAPABILITIES=all \
                     --env=DISPLAY \
                     --env=QT_X11_NO_MITSHM=1 \
                     --env=HOME \
                     --env=USER \
                     --user=(id -u $USER):(id -g $USER) \
                     --group-add $(getent group sudo | cut -d: -f3) \
                     -v /tmp/.X11-unix:/tmp/.X11-unix \
                     -v $HOME/myconfigs:$HOME/myconfigs:ro \
                     -v $HOME/.ssh:$HOME/.ssh:ro \
                     -v /etc/passwd:/etc/passwd:ro \
                     -v /etc/group:/etc/group:ro \
                     -v /etc/shadow:/etc/shadow:ro \
                     --cap-add sys_ptrace \
                     -t \
                     --entrypoint=/bin/bash \
                     --name "$argv[2]" \
                     $argv[1])
  # Detect user inside container
  set -l docker_image (docker inspect --format='{{.Config.Image}}' $cid)
  set -l docker_uid (docker run --rm "$docker_image" id -u)
  set -l docker_gid (docker run --rm "$docker_image" id -g)
  # TODO: I have no idea what this line is doing!!!
  xhost +local:root &> /dev/null
  # docker start "$cid"
  docker exec --user root $cid bash -c "mkhomedir_helper jafar"
  docker exec --user root $cid bash -c "chown $USER:$USER $HOME"
  # Pass common credentials to container
  if test -e $HOME/.workspaces.yaml
    docker_cp $HOME/.workspaces.yaml $cid:$HOME/ $docker_uid $docker_gid
  end
  docker exec --user root $cid bash -c "apt update"
  docker exec --user root $cid bash -c "apt install -y sudo lsb-release curl wget"
  # TODO: Maybe add an option to install these packages???
  docker exec --user root $cid bash -c "apt install -y python3-pip"
  # docker exec $cid bash -c "pip3 install argcomplete PyYAML"
  docker exec $cid bash -c "eval \"$(ssh-agent -s && ssh-add ~/.ssh/id_rsa)\""
  docker exec --user root $cid bash -c "if [[ \"\$(lsb_release -is)\" == \"Ubuntu\" ]]; then
                                          apt install -y software-properties-common
                                          add-apt-repository universe
                                          add-apt-repository multiverse
                                          apt-add-repository ppa:fish-shell/release-3
                                          apt update
                                        elif [[ \"\$(lsb_release -is)\" == \"Debian\" ]];
                                        then
                                          apt install -y libxft-dev libx11-dev
                                        fi
                                        apt install -y fish
                                        chsh -s `which fish`"
  docker exec $cid fish -c "source ~/myconfigs/fish/conf.d/installs.fish && install-core && config-fish"
  docker exec $cid fish -c "install-core"
  docker exec -it $cid fish
  xhost -local:root 1>/dev/null 2>&1
end
