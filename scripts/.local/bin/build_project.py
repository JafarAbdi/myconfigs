#!/usr/bin/python3
"""Run a file in a workspace."""


import argparse
import json
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Final

import argcomplete
from utils import call, run_command

CMAKE_REPLY_DIR: Final = Path(".cmake") / "api" / "v1" / "reply"


def lua(file: Path, args: list, cwd: Path, extra_args: dict, *, is_test: bool) -> None:
    """Run a lua file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Whether the file is a test or not
    """
    env = os.environ.copy()
    env.pop("NVIMRUNNING", None)
    run_command(
        ["nvim", "--headless", "-n", "-c", "source", str(file), "-c", "qall!", *args],
        dry_run=False,
        cwd=cwd,
        env=env,
    )


def fish(file: Path, args: list, cwd: Path, extra_args: dict, *, is_test: bool) -> None:
    """Run a fish file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Whether the file is a test or not
    """
    run_command(["fish", str(file), *args], dry_run=False, cwd=cwd)


def python(
    file: Path,
    args: list,
    cwd: Path,
    extra_args: dict,
    *,
    is_test: bool,
) -> None:
    """Run a python file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Whether the file is a test or not
    """
    cmd = []
    if micromamba_env := extra_args.get("micromamba.env"):
        cmd.extend(["micromamba", "run", "-n", micromamba_env])
    cmd.extend(["python3", str(file)])
    run_command(cmd + args, dry_run=False, cwd=cwd)


def rust(file: Path, args: list, cwd: Path, extra_args: dict, *, is_test: bool) -> None:
    """Run a rust file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Whether the file is a test or not
    """
    if (cwd / "Cargo.toml").exists():
        output = call(
            ["cargo", "metadata", "--format-version=1"],
            cwd=file.parent.resolve(),
        )
        output = json.loads(output)
        resolved_file_path = str(file.resolve())
        workspace_root = output["workspace_root"]
        for package in output["packages"]:
            for target in package["targets"]:
                if target["kind"] == ["lib"] and is_test:
                    run_command(
                        ["cargo", "test", "--lib", *args],
                        dry_run=False,
                        cwd=workspace_root,
                    )
                    return
                if resolved_file_path == target["src_path"]:
                    match target["kind"]:
                        case ["bin"]:
                            run_command(
                                ["cargo", "run", "--bin", target["name"], *args],
                                dry_run=False,
                                cwd=workspace_root,
                            )
                        case ["example"]:
                            run_command(
                                ["cargo", "run", "--example", target["name"], *args],
                                dry_run=False,
                                cwd=workspace_root,
                            )
                        case _:
                            logging.error(f"Unsupported target kind {target['kind']}")
                    return
        logging.error(f"Can't find a target for {file.resolve()}")
        return
    if (
        run_command(
            ["rustc", str(file), "-o", str(file.with_suffix(".out"))],
            dry_run=False,
            cwd=cwd,
        )
        != 0
    ):
        logging.error(f"Failed to build '{file}'")
        return
    run_command(
        [str(file.with_suffix(".out")), *args],
        dry_run=False,
        cwd=cwd,
    )


def cpp(file: Path, args: list, cwd: Path, extra_args: dict, *, is_test: bool) -> None:
    """Run a cpp file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Whether the file is a test or not
    """
    if (cwd / "CMakeLists.txt").exists():
        cmake(file, args, cwd, extra_args)
        return
    if (cwd / "conanbuildinfo.args").exists():
        cmd = ["clang++", str(file), "-o", str(file.with_suffix(".out"))]
        if shutil.which("mold"):
            cmd.append("-fuse-ld=mold")
        cmd.append("@conanbuildinfo.args")
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
            [str(file.with_suffix(".out")), *args],
            dry_run=False,
            cwd=cwd,
        )
        return
    logging.error(f"Unsupported build system found for cpp file {file}")


def cmake(file: Path, args: list, cwd: Path, extra_args: dict) -> None:
    """Run a cmake target associated with a file.

    Args:
        file: File to run the target for
        args: Arguments to pass to the target when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
    """
    settings_path = cwd / ".vscode" / "settings.json"
    with settings_path.open("r") as settings_file:
        settings = json.load(settings_file)
        build_dir = Path(settings["cmake.buildDirectory"])
    reply_dir = build_dir / CMAKE_REPLY_DIR
    indices = sorted(reply_dir.glob("index-*.json"))
    if not indices:
        logging.error("No cmake reply")
        return False
    with indices[-1].open() as fp:
        index = json.load(fp)
    try:
        responses = index["reply"]["client-vscode"]["query.json"]["responses"]
    except KeyError:
        logging.exception("No response for client-vscode")
        return False
    targets = {}
    for response in responses:
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


def xacro(
    file: Path,
    args: list,
    cwd: Path,
    extra_args: dict,
    *,
    is_test: bool,
) -> None:
    """Run a urdf/xaacro file.

    Args:
        file: File to run
        args: Arguments to pass to the file when running it
        cwd: Current working directory
        extra_args: Generic arguments to be used by the runner
        is_test: Weather the file is a test or not
    """
    run_command(
        ["curl", "-X", "POST", "http://127.0.0.1:7777/set_reload_request"],
        dry_run=False,
    )


runners: Final = {
    "lua": lua,
    "python": python,
    "rust": rust,
    "cpp": cpp,
    "fish": fish,
    "xml": xacro,
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
    if (micromamba_file := settings_path / "settings.json").exists():
        with micromamba_file.open("r") as file:
            run_args = json.load(file)
        if micromamba_env := run_args.get("micromamba.env"):
            logging.info(f"Using micromamba env {micromamba_env}")

    runner(
        file_path,
        settings_args,
        workspace_path,
        extra_args=run_args,
        is_test=args.test,
    )


if __name__ == "__main__":
    main()
