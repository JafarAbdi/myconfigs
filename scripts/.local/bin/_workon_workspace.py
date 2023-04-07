#!/usr/bin/python3
import argparse
import os
import sys

import argcomplete
from utils import (
    get_workspace_distro,
    get_workspace_path,
    get_workspace_underlays,
    get_workspaces,
    get_workspaces_yaml,
)

parser = argparse.ArgumentParser()
parser.add_argument(
    "--workspace-exists",
    help="Check if a workspace is defined in ~/.workspaces.yaml",
)
parser.add_argument(
    "--workspaces",
    action="store_true",
    help="Get the list of the available workspaces",
)
parser.add_argument(
    "--workspace-name",
    help="Get the source commands we need to run to enable the input workspace",
)
parser.add_argument("--workspace-path", help="Get the path for the input workspace")
parser.add_argument(
    "--ros-package-path",
    help="Get the paths for ROS_PACKAGE_PATH for the input workspace",
)
argcomplete.autocomplete(parser)
args = parser.parse_args()

home_dir = os.getenv("HOME")
workspaces = get_workspaces_yaml()

ROS1_VERSIONS = ["melodic", "noetic"]
if args.workspaces:
    print(" ".join(get_workspaces()))  # noqa: T201
elif args.workspace_name:
    workspace = args.workspace_name
    commands = []
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
                f"source {home_dir}/{underlay_path}/install/local_setup.bash",
            )
    workspace_path = get_workspace_path(workspace)
    if workspace_path:
        if is_ros1:
            commands.append(f"source {home_dir}/{workspace_path}/devel/setup.bash")
        else:
            commands.append(
                f"source {home_dir}/{workspace_path}/install/local_setup.bash",
            )
    print(" && ".join(commands))  # noqa: T201
elif args.ros_package_path:
    workspace = args.ros_package_path
    if workspace not in get_workspaces():
        sys.exit(0)
    rosdistro = get_workspace_distro(workspace)
    paths = [f"/opt/ros/{rosdistro}"]
    for underlay in get_workspace_underlays(workspace) or []:
        paths.append(f"{home_dir}/{get_workspace_path(underlay)}")
    paths.append(f"{home_dir}/{get_workspace_path(workspace)}")
    print(" ".join(paths))  # noqa: T201
elif args.workspace_path:
    workspace_path = get_workspace_path(args.workspace_path)
    if workspace_path:
        print("{}".format(home_dir + "/" + workspace_path))  # noqa: T201
elif args.workspace_exists:
    if args.workspace_exists in get_workspaces():
        print("true")  # noqa: T201
    else:
        print("false")  # noqa: T201
