#!/usr/bin/python3

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Final

import argcomplete
from utils import call, run_command


def python(file: Path, args: list, cwd: Path, extra_args: dict):
    cmd = []
    if micromamba_env := extra_args.get("micromamba"):
        cmd.extend(["micromamba", "run", "-n", micromamba_env])
    cmd.extend(["python3", str(file)])
    run_command(cmd + args, dry_run=False, cwd=cwd)


def rust(file: Path, args: list, cwd: Path, extra_args: dict):
    output = call(
        ["cargo", "metadata", "--format-version=1"], cwd=file.parent.resolve()
    )
    output = json.loads(output)
    resolved_file_path = str(file.resolve())
    for package in output["packages"]:
        for target in package["targets"]:
            # TODO: Check kind, we should only run bin
            if resolved_file_path == target["src_path"]:
                run_command(
                    ["cargo", "run", "--bin", target["name"]] + args,
                    dry_run=False,
                    cwd=cwd,
                )
                return
    logging.error(f"Can't find a target for {file.resolve()}")


# TODO: Add cpp support
# https://github.com/JafarAbdi/myconfigs/commit/1d33a821c193c6abd11cb3aa6d474ccaa87aafec#diff-9b28a557022c67e167fe460a7b3f179c02469cc0dec165f7d9e30760e05a1c5f
runners: Final = {".py": python, ".rs": rust}


def main():
    parser = argparse.ArgumentParser()
    # TODO: Add an environment argument (To use micromamba as an example)
    # https://stackoverflow.com/a/26990349
    parser.add_argument("--workspace-folder", nargs="+", required=True)
    parser.add_argument("--file-path", nargs="+", required=True)

    argcomplete.autocomplete(parser)
    args = parser.parse_args()

    workspace_path = Path(" ".join(args.workspace_folder))
    file_path = workspace_path / Path(" ".join(args.file_path))
    if not file_path.exists():
        logging.error(f"File '{file_path}' doesn't exists.")
        sys.exit(1)
    file_type = file_path.suffix
    if (runner := runners.get(file_type)) is None:
        logging.error(f"Unsupported language '{file_type}' for path '{file_path}'")
        sys.exit(1)
    logging.info(f"Executing '{file_path}'")
    settings_path = workspace_path / ".vscode"
    args = []
    if (args_file := settings_path / file_path.stem).exists():
        with args_file.open("r") as file:
            args = file.readline().split(" ")
        logging.info(f"Load args file '{args_file} with {args}")
    run_args = {}
    if (micromamba_file := settings_path / "micromamba").exists():
        with micromamba_file.open("r") as file:
            run_args["micromamba"] = file.readline()
        logging.info(f"Using micromamba env {run_args['micromamba']}")

    runner(file_path, args, workspace_path, extra_args=run_args)


if __name__ == "__main__":
    main()
