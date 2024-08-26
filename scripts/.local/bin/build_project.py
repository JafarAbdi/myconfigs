#!/usr/bin/python3
"""Run a file in a workspace."""

import argparse
import json
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Final

import argcomplete
from utils import run_command

CMAKE_REPLY_DIR: Final = Path(".cmake") / "api" / "v1" / "reply"


def find_rootdir(filename: Path) -> Path:
    """Find the root directory of a file.

    Args:
        filename: File to find the root directory of

    Returns:
        Root directory of the file
    """

    def _find_rootdir(path: Path) -> Path:
        if (path / filename).exists():
            return path
        return None if path.parent == path else _find_rootdir(path.parent)

    return _find_rootdir


def cpp(file: Path, args: list, cwd: Path, extra_args: dict, *, is_test: bool) -> None:
    """Run a cpp file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Whether the file is a test or not
    """

    def compile_cpp(file: Path, extra_args: list | None = None) -> None:
        output = Path(
            tempfile.gettempdir(),
            next(tempfile._get_candidate_names()),  # noqa: SLF001
        )
        cmd = ["clang++", str(file), "-o", str(output)]
        if shutil.which("mold"):
            cmd.append("-fuse-ld=mold")
        if extra_args is not None:
            cmd.extend(extra_args)
        if (
            run_command(
                cmd,
                dry_run=False,
                cwd=cwd,
            )
            != 0
        ):
            logging.error(f"Failed to build '{file}'")
            return
        run_command(
            [str(output), *args],
            dry_run=False,
            cwd=cwd,
        )
        output.unlink()

    if vscode_dir := find_rootdir(".vscode")(file):
        cmake(file, args, vscode_dir, extra_args)
    elif (cwd / "conanbuildinfo.args").exists():
        compile_cpp(file, ["@conanbuildinfo.args"])
    else:
        compile_cpp(file)


def cmake(file: Path, args: list, cwd: Path, extra_args: dict) -> None:
    """Run a cmake target associated with a file.

    Args:
        file: File to run the target for
        args: Arguments to pass to the target when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
    """
    ros_distro = os.environ.get("ROS_DISTRO")
    settings_path = cwd / ".vscode" / "settings.json"
    with settings_path.open("r") as settings_file:
        settings = json.load(settings_file)
        build_dir = Path(
            (
                settings[f"cmake.buildDirectory.{ros_distro}"]
                if ros_distro
                else settings["cmake.buildDirectory"]
            ),
        )
    reply_dir = build_dir / CMAKE_REPLY_DIR
    indices = sorted(reply_dir.glob("index-*.json"))
    if not indices:
        logging.error(f"No cmake reply in {reply_dir}")
        return False
    with indices[-1].open() as fp:
        index = json.load(fp)
    targets = {}
    response = index["reply"]["codemodel-v2"]
    if response["kind"] == "codemodel":
        with (reply_dir / response["jsonFile"]).open() as fp:
            codemodel = json.load(fp)
        config = codemodel["configurations"][0]
        for target_config in config["targets"]:
            with (reply_dir / target_config["jsonFile"]).open() as target_file:
                target = json.load(target_file)
                if target["type"] == "EXECUTABLE":
                    targets[cwd / target["sources"][0]["path"]] = {
                        "name": target["name"],
                        "path": build_dir / target["artifacts"][0]["path"],
                    }
    if (target_info := targets.get(file)) is None:
        logging.error(f"Can't find an executable corresponding to {file}")
        return False
    logging.info(f"Running executable '{target_info['name']}'")
    if (
        run_command(
            [
                shutil.which("cmake"),
                "--build",
                str(build_dir),
                "--target",
                target_info["name"],
            ],
            dry_run=False,
            cwd=cwd,
        )
        != 0
    ):
        logging.error(f"Failed to build '{target_info['name']}'")
        return False
    run_command(
        [str(target_info["path"]), *args],
        dry_run=False,
        cwd=cwd,
    )
    return True


runners: Final = {
    "cpp": cpp,
}


def main() -> None:
    """Main function to run the script."""
    parser = argparse.ArgumentParser()
    # https://stackoverflow.com/a/26990349
    parser.add_argument("--workspace-folder", nargs="+", required=True)
    parser.add_argument("--file-path", nargs="+", required=True)
    parser.add_argument("--test", action="store_true")
    parser.add_argument("--filetype", required=True)

    argcomplete.autocomplete(parser)
    args = parser.parse_args()

    workspace_path = Path(" ".join(args.workspace_folder))
    file_path = workspace_path / Path(" ".join(args.file_path))
    if not file_path.exists():
        logging.error(f"File '{file_path}' doesn't exists.")
        sys.exit(1)

    if (runner := runners.get(args.filetype)) is None:
        logging.error(f"Unsupported language '{args.filetype}' for path '{file_path}'")
        sys.exit(1)
    logging.info(f"Executing '{file_path}'")
    settings_path = workspace_path / ".vscode"
    settings_args = []
    if (args_file := settings_path / file_path.stem).exists():
        with args_file.open("r") as file:
            settings_args = file.read().splitlines()[0].split(" ")
        logging.info(f"Load args file '{args_file} with {settings_args}")
    run_args = {}

    runner(
        file_path,
        settings_args,
        workspace_path,
        extra_args=run_args,
        is_test=args.test,
    )


if __name__ == "__main__":
    main()
