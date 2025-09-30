"""Utility functions for the scripts in the repo."""

import json
import os
import subprocess
from collections.abc import KeysView
from pathlib import Path

import yaml

ROS_INSTALLATION_DIR = Path("/opt/ros")


def get_workspaces_yaml() -> dict:
    """A function to get the workspaces from the yaml file.

    Returns:
        A dictionary of workspaces
    """
    file_name = Path.home() / ".workspaces.yaml"
    workspaces = {}
    if file_name.exists():
        with Path(file_name).open() as f:
            workspaces = yaml.safe_load(f)
    if ROS_INSTALLATION_DIR.exists():
        for ros_distro in ROS_INSTALLATION_DIR.iterdir():
            workspaces[ros_distro.stem] = {"ros_distro": ros_distro.stem}
    return workspaces


def get_workspaces() -> KeysView[str]:
    """Get a list of the workspaces names.

    Returns:
        A list of the workspace names
    """
    return get_workspaces_yaml().keys()


def get_workspace_parameters(workspace: str) -> dict:
    """Get the parameters for a workspace.

    Args:
        workspace: The name of the workspace

    Returns:
        A dictionary of the parameters for the workspace
    """
    return get_workspaces_yaml().get(workspace, {})


def get_workspace_distro(workspace: str) -> str | None:
    """Get the ROS distro for a workspace.

    Args:
        workspace: The name of the workspace

    Returns:
        The ROS distro for the workspace
    """
    return get_workspace_parameters(workspace).get("ros_distro")


def get_workspace_path(workspace: str) -> str | None:
    """Get the path for a workspace.

    Args:
        workspace: The name of the workspace

    Returns:
        The path for the workspace relative to the home directory
    """
    return os.path.expanduser(get_workspace_parameters(workspace).get("path"))


def get_workspace_underlays(workspace: str) -> list[str] | None:
    """Get the underlays for a workspace.

    Args:
        workspace: The name of the workspace

    Returns:
        A list of the underlays for the workspace
    """
    return get_workspace_parameters(workspace).get("underlays")


def get_package_paths(package_name: str) -> tuple[str, Path]:
    """Get the source and build directories for a package.

    Args:
        package_name: Package name to get paths for

    Returns:
        A tuple of the source and build directories for the package
    """
    import rospkg  # noqa: PLC0415

    workspace_dir = Path.cwd()
    rospack = rospkg.RosPack([workspace_dir / "src"])
    return (
        rospack.get_path(package_name),
        (
            Path(workspace_dir)
            / f"build{get_colcon_postfix(workspace_dir)}"
            / package_name
        ).absolute(),
    )


def get_ros_package_path(directory: Path, package_name: str) -> str:
    """Get the source directory for a package.

    Args:
        directory: The directory to search for the package
        package_name: Package name to get the path for

    Returns:
        The source directory for the package
    """
    import rospkg  # noqa: PLC0415

    return rospkg.RosPack([directory]).get_path(package_name)


def get_ros_packages_path(directory: Path) -> list[tuple[str, str]]:
    """Get the source directories for all packages in a directory.

    Args:
        directory: The directory to search for packages

    Returns:
        A list of tuples of the package name and source directory
    """
    import rospkg  # noqa: PLC0415

    rospack = rospkg.RosPack([directory])
    packages = rospack.list()
    return [(package, rospack.get_path(package)) for package in packages]


def get_colcon_postfix(workspace_dir: Path) -> str:
    """Get the postfix for the colcon build/install directories.

    Args:
        workspace_dir: The workspace directory

    Returns:
        The postfix for the colcon build directory
    """
    # Assumes we don't have both build/build_rosdistro at the same time
    if (workspace_dir / "build").exists():
        return ""
    return f"_{os.environ.get('ROS_DISTRO')}"


def get_ros_packages(directory: Path) -> list[str]:
    """Get the names of all packages in a directory.

    Args:
        directory: The directory to search for packages

    Returns:
        List of package names
    """
    import rospkg  # noqa: PLC0415

    return rospkg.RosPack([directory]).list()


def run_command(
    cmd: list,
    dry_run: bool,  # noqa: FBT001
    cwd: str | None = None,
    env: dict | None = None,
) -> int | None:
    """Run a command.

    Args:
        cmd: Command to run
        dry_run: Whether to run only print the command or actually run it
        cwd: Current working directory
        env: Extra environment variables

    Returns:
        Exit code of the command
    """
    print(" ".join(str(x) for x in cmd))  # noqa: T201
    return None if dry_run else subprocess.call(cmd, cwd=cwd, env=env)  # noqa: S603


def create_cmake_query_files(build_dir: Path) -> None:
    """Create the cmake query files.

    Args:
        build_dir: The build directory to create the query files in
    """
    query_dir = Path(build_dir) / ".cmake" / "api" / "v1" / "query"
    query_dir.mkdir(parents=True, exist_ok=True)
    query_file = query_dir / "codemodel-v2"
    query_file.touch()


def create_vscode_config(
    build_dir: Path,
    output_dir: Path | None = None,
) -> None:
    """Create vscode config files for cmake, clangd, and codechecker.

    Args:
        build_dir: The build directory for the project
        output_dir: The directory to output the config files to
    """
    if output_dir is None:
        output_dir = Path()
    vscode_dir = Path(output_dir) / Path(".vscode")
    settings_file = "settings.json"
    vscode_dir.mkdir(parents=True, exist_ok=True)
    with (vscode_dir / settings_file).open("w", encoding="utf-8") as f:
        json.dump(
            {
                "cmake.buildDirectory": str(build_dir),
                # TODO: Add support for codechecker
                # "codechecker.backend.compilationDatabasePath": f"{build_dir}/compile_commands.json",
            },
            f,
            ensure_ascii=True,
            indent=4,
        )


def create_clangd_config(source_dir: Path, build_dir: Path) -> None:
    """Create a .clangd file for a package."""
    with (source_dir / ".clangd").open("w") as stream:
        yaml.safe_dump(
            {
                "CompileFlags": {
                    "CompilationDatabase": str(build_dir.absolute()),
                },
            },
            stream,
        )


def create_clangd_config_ros(workspace_dir: Path, build_path: Path) -> None:
    """Create a .clangd file for a list of packages.

    Args:
        workspace_dir: The workspace directory
        build_path: The path to build directory
    """
    packages = get_ros_packages_path(workspace_dir / "src")
    clangd_configs = []
    clangd_configs.extend(
        {
            "If": {"PathMatch": [f"{Path(path).relative_to(workspace_dir)}/.*"]},
            "CompileFlags": {
                "CompilationDatabase": str((build_path / package).absolute()),
            },
        }
        for package, path in packages
    )
    clangd_path = Path(workspace_dir) / ".clangd"
    with clangd_path.open("w") as stream:
        yaml.safe_dump_all(clangd_configs, stream)


def call(*args, **kwargs) -> str:
    """Call a subprocess and return the output.

    Args:
        *args: The arguments to pass to subprocess.check_output
        **kwargs: The keyword arguments to pass to subprocess.check_output

    Returns:
        Output of the subprocess
    """
    try:
        kwargs["encoding"] = "utf-8"
        output = subprocess.check_output(*args, **kwargs)  # noqa: S603
    except subprocess.CalledProcessError:
        output = ""
    return output
