#!/usr/bin/python3
import argparse
import os

import argcomplete
from utils import (
    get_workspace_distro,
    get_workspace_path,
    get_workspace_underlays,
    get_workspaces,
    get_workspaces_yaml,
)

# ~/.workspaces.yaml
# WORKSPACE_NAME:
# ros_distro: DISTRO
# path: path w.r.t. HOME (optional)
# underlays: [] (optional)
# moveit2:
# ros_distro: foxy
# path: workspaces/ros2/ws_moveit2
# underlays: []
# hello_robot:
# ros_distro: foxy
# path: workspaces/ros2/ws_hello_robot
# underlays: []
# moveit_studio:
# ros_distro: foxy
# path: workspaces/ros2/ws_moveit_studio
# underlays: []

parser = argparse.ArgumentParser()
parser.add_argument(
    "--workspace-exists", help="Check if a workspace is defined in ~/.workspaces.yaml"
)
parser.add_argument(
    "--workspaces", action="store_true", help="Get the list of the available workspaces"
)
parser.add_argument(
    "--workspace-name",
    help="Get the source commands we need to run to enable the input workspace",
)
parser.add_argument("--workspace-path", help="Get the path for the input workspace")
argcomplete.autocomplete(parser)
args = parser.parse_args()

home_dir = os.getenv("HOME")
workspaces = get_workspaces_yaml()

ROS1_VERSIONS = ["melodic", "noetic"]
# TODO: Should handle devel/install setup.bash
if args.workspaces:
    print(get_workspaces(" "))
elif args.workspace_name:
    workspace = args.workspace_name
    commands = []
    # TODO: nothing is no longer needed since we have reset
    if workspace != "nothing":
        rosdistro = get_workspace_distro(workspace)
        is_ros1 = rosdistro in ROS1_VERSIONS
        if rosdistro:
            commands.append(f"source /opt/ros/{rosdistro}/setup.bash")
        for underlay in get_workspace_underlays(workspace) or []:
            underlay_path = get_workspace_path(underlay)
            if is_ros1:
                commands.append(f"source {home_dir}/{underlay_path}/install/setup.bash")
            else:
                commands.append(
                    f"source {home_dir}/{underlay_path}/install/local_setup.bash"
                )
        workspace_path = get_workspace_path(workspace)
        if workspace_path:
            if is_ros1:
                commands.append(f"source {home_dir}/{workspace_path}/devel/setup.bash")
            else:
                commands.append(
                    f"source {home_dir}/{workspace_path}/install/local_setup.bash"
                )
    print(" && ".join(commands))
elif args.workspace_path:
    workspace_path = get_workspace_path(args.workspace_path)
    if workspace_path:
        print("{}".format(home_dir + "/" + workspace_path))
elif args.workspace_exists:
    if args.workspace_exists in get_workspaces():
        print("true")
    else:
        print("false")
