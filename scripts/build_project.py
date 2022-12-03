#!/usr/bin/python3

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Final

import argcomplete
from utils import call, run_command


def python(file: Path):
    run_command(["python3", str(file)], dry_run=False)


def rust(file: Path):
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
                    ["cargo", "run", "--bin", target["name"]],
                    dry_run=False,
                    cwd=file.parent.resolve(),
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

    file_path = Path(" ".join(args.workspace_folder)) / Path(" ".join(args.file_path))
    if not file_path.exists():
        logging.error(f"File '{file_path}' doesn't exists.")
        sys.exit(1)
    file_type = file_path.suffix
    if (runner := runners.get(file_type)) is None:
        logging.error(f"Unsupported language '{file_type}' for path '{file_path}'")
        sys.exit(1)
    logging.info(f"Executing '{file_path}'")
    runner(file_path)


if __name__ == "__main__":
    main()
