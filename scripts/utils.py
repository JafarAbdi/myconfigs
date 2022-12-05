#!/usr/bin/python3
import os
import pathlib
import subprocess
from enum import Enum
from pathlib import Path
from typing import Optional

import yaml

ROS_INSTALLATION_DIR = Path("/opt/ros")


class RosVersions(Enum):
    ROS1 = 1
    ROS2 = 2
    UNKNOWN = 3


def get_workspaces_yaml():
    file_name = Path(os.getenv("HOME") + "/.workspaces.yaml")
    workspaces = yaml.safe_load(open(file_name)) if file_name.exists() else {}
    if ROS_INSTALLATION_DIR.exists():
        for ros_distro in os.listdir(ROS_INSTALLATION_DIR):
            workspaces[ros_distro] = {"ros_distro": ros_distro}
    return workspaces


def get_workspaces(delimiter=None):
    workspaces = get_workspaces_yaml().keys()
    if delimiter is None:
        return workspaces
    return " ".join(workspaces)


def get_workspace_parameters(workspace):
    return get_workspaces_yaml().get(workspace, {})


def get_workspace_distro(workspace):
    return get_workspace_parameters(workspace).get("ros_distro")


def get_workspace_path(workspace):
    return get_workspace_parameters(workspace).get("path")


def get_workspace_underlays(workspace):
    return get_workspace_parameters(workspace).get("underlays")


# TODO: Refactor packages to be a dictionary of packages name to src/build directories
def get_package_paths(package_name):
    import rospkg

    workspace_dir = os.path.abspath(os.curdir)
    rospack = rospkg.RosPack([workspace_dir + "/src"])
    return (
        rospack.get_path(package_name),
        (Path(workspace_dir) / "build" / f"{package_name}").absolute(),
    )


def get_ros_package_path(directory, package_name):
    import rospkg

    rospack = rospkg.RosPack([directory])
    return rospack.get_path(package_name)


def get_ros_packages_path(directory):
    import rospkg

    rospack = rospkg.RosPack([directory])
    packages = rospack.list()
    return [(package, rospack.get_path(package)) for package in packages]


def get_ros_packages(directory):
    import rospkg

    rospack = rospkg.RosPack([directory])
    return rospack.list()


class PackagesCompleter:
    def __init__(self, choices):
        self.choices = choices

    def __call__(self, **kwargs):
        return self.choices


def run_command(
    cmd: list,
    dry_run: bool,  # noqa: FBT001
    cwd: Optional[str] = None,  # noqa: U007
    env: Optional[dict] = None,  # noqa: U007
):
    print(" ".join(cmd))
    if dry_run:
        return
    subprocess.call(cmd, cwd=cwd, env=env)


def create_cmake_query_files(build_dir):
    query_dir = Path(build_dir) / ".cmake" / "api" / "v1" / "query"
    query_dir.mkdir(parents=True, exist_ok=True)
    query_file = query_dir / "codemodel-v2"
    query_file.touch()


def create_vscode_config(build_dir, output_dir=None):
    import json

    if output_dir is None:
        output_dir = Path(".")
    vscode_dir = Path(output_dir) / Path(".vscode")
    settings_file = "settings.json"
    vscode_dir.mkdir(parents=True, exist_ok=True)
    with (vscode_dir / settings_file).open("w", encoding="utf-8") as f:
        settings = {
            "cmake.configureOnOpen": True,
            "cmake.buildDirectory": f"{build_dir}",
            "clangd.arguments": [
                f"--compile-commands-dir={build_dir}",
                "--completion-style=detailed",
            ],
            "codechecker.backend.compilationDatabasePath": f"{build_dir}/compile_commands.json",
        }

        json.dump(settings, f, ensure_ascii=True, indent=4)


def get_ros_version():
    current = pathlib.Path(".").resolve()
    if (current / ".catkin_tools").is_dir():
        return RosVersions.ROS1
    if (current / "build/COLCON_IGNORE").exists():
        return RosVersions.ROS2
    return RosVersions.UNKNOWN


def call(*args, **kwargs):
    try:
        kwargs["encoding"] = "utf-8"
        return subprocess.check_output(*args, **kwargs)
    except subprocess.CalledProcessError:
        return ""
