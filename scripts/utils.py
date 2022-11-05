#!/usr/bin/python3
# -*- coding: utf-8 -*-
import os
import pathlib
import subprocess
from enum import Enum
from pathlib import Path
from typing import Optional

import yaml

ROS_INSTALLATION_DIR = Path("/opt/ros")


class ROS_VERSIONS(Enum):
    ROS1 = 1
    ROS2 = 2
    UNKNOWN = 3


# def get_ros2_packages(directory):
#     import ament_index_python
#
#     get_packages_with_prefixes = ament_index_python.get_packages_with_prefixes()
#     packages = []
#     for package, path in get_packages_with_prefixes.items():
#         if path.startswith(directory):
#             packages.append(package)
#     return packages


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


def get_package_paths(package_name):
    import rospkg

    workspace_dir = os.path.abspath(os.curdir)
    rospack = rospkg.RosPack([workspace_dir + "/src"])
    return (
        rospack.get_path(package_name),
        (Path(workspace_dir) / "build" / f"{package_name}").absolute(),
    )


def get_ros_packages_path(directory):
    import rospkg

    rospack = rospkg.RosPack([directory])
    packages = rospack.list()
    return [(package, rospack.get_path(package)) for package in packages]


def get_ros_packages(directory):
    import rospkg

    rospack = rospkg.RosPack([directory])
    return rospack.list()


class PackagesCompleter(object):
    def __init__(self, choices):
        self.choices = choices

    def __call__(self, **kwargs):
        return self.choices


def run_command(
    cmd: list, dry_run: bool, cwd: Optional[str] = None, env: Optional[dict] = None
):
    print(" ".join(cmd))
    if dry_run:
        return
    subprocess.call(cmd, cwd=cwd, env=env)


def create_cmake_query_files(build_dir):
    QUERY_DIR = Path(build_dir) / ".cmake" / "api" / "v1" / "query"
    QUERY_DIR.mkdir(parents=True, exist_ok=True)
    QUERY_FILE = QUERY_DIR / "codemodel-v2"
    QUERY_FILE.touch()


def create_clangd_config(build_dir, output_dir=None):
    # https://clangd.llvm.org/config#compilationdatabase
    CLANGD_CONFIG_FILE = "{build_dir}"
    CLAND_FILE_PATH = Path(".clangd_config")
    if output_dir is None:
        output_dir = Path(".")
    with (output_dir / Path(CLAND_FILE_PATH)).open("w", encoding="utf-8") as f:
        f.write(CLANGD_CONFIG_FILE.format(build_dir=build_dir))


def get_ros_version():
    current = pathlib.Path(".").resolve()
    if (current / ".catkin_tools").is_dir():
        return ROS_VERSIONS.ROS1
    elif (current / "build/COLCON_IGNORE").exists():
        return ROS_VERSIONS.ROS2
    return ROS_VERSIONS.UNKNOWN


def call(*args, **kwargs):
    try:
        kwargs["encoding"] = "utf-8"
        return subprocess.check_output(*args, **kwargs)
    except subprocess.CalledProcessError:
        return ""
