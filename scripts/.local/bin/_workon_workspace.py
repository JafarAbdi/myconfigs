#!/usr/bin/python3
import argparse
import sys
from pathlib import Path

import argcomplete
from utils import (
    create_clangd_config_ros,
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

home_dir = Path.home()
workspaces = get_workspaces_yaml()

if args.workspaces:
    print(" ".join(get_workspaces()))  # noqa: T201
elif args.workspace_name:
    workspace = args.workspace_name
    commands = []
    rosdistro = get_workspace_distro(workspace)
    if rosdistro:
        commands.append(f"source /opt/ros/{rosdistro}/setup.bash")
    for underlay in get_workspace_underlays(workspace) or []:
        underlay_path = get_workspace_path(underlay)
        match rosdistro:
            case "melodic" | "noetic":
                if (
                    setup_path := home_dir
                    / underlay_path
                    / f"install_{rosdistro}"
                    / "setup.bash"
                ).exists() or (
                    setup_path := home_dir / underlay_path / "install" / "setup.bash"
                ).exists():
                    commands.append(
                        f"source {setup_path}",
                    )
            case _:
                if (
                    local_setup_path := home_dir
                    / underlay_path
                    / f"install_{rosdistro}"
                    / "local_setup.bash"
                ).exists() or (
                    local_setup_path := home_dir
                    / underlay_path
                    / "install"
                    / "local_setup.bash"
                ).exists():
                    commands.append(f"source {local_setup_path}")
    if workspace_path := get_workspace_path(workspace):
        match rosdistro:
            case "melodic" | "noetic":
                if (
                    setup_path := home_dir
                    / workspace_path
                    / f"devel_{rosdistro}"
                    / "setup.bash"
                ).exists() or (
                    setup_path := home_dir / workspace_path / "devel" / "setup.bash"
                ).exists():
                    commands.append(f"source {setup_path}")
            case _:
                if (
                    local_setup_path := home_dir
                    / workspace_path
                    / f"install_{rosdistro}"
                    / "setup.bash"
                ).exists() or (
                    local_setup_path := home_dir
                    / workspace_path
                    / "install"
                    / "setup.bash"
                ).exists():
                    commands.append(f"source {local_setup_path}")
        create_clangd_config_ros(Path.home() / workspace_path, rosdistro)
    print(" && ".join(commands))  # noqa: T201
elif args.ros_package_path:
    workspace = args.ros_package_path
    if workspace not in get_workspaces():
        sys.exit(0)
    rosdistro = get_workspace_distro(workspace)
    paths = [f"/opt/ros/{rosdistro}"]
    paths.extend(
        f"{home_dir}/{get_workspace_path(underlay)}"
        for underlay in get_workspace_underlays(workspace) or []
    )
    paths.append(f"{home_dir}/{get_workspace_path(workspace)}")
    print(" ".join(paths))  # noqa: T201
elif args.workspace_path:
    if workspace_path := get_workspace_path(args.workspace_path):
        print(home_dir / workspace_path)  # noqa: T201
elif args.workspace_exists:
    if args.workspace_exists in get_workspaces():
        print("true")  # noqa: T201
    else:
        print("false")  # noqa: T201
