#!/usr/bin/python3

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


def lua(file: Path, args: list, cwd: Path, extra_args: dict):
    env = os.environ.copy()
    env.pop("NVIMRUNNING", None)
    run_command(
        ["nvim", "--headless", "-n", "-c", "source", str(file), "-c", "qall!"] + args,
        dry_run=False,
        cwd=cwd,
        env=env,
    )


def fish(file: Path, args: list, cwd: Path, extra_args: dict):
    run_command(["fish", str(file)] + args, dry_run=False, cwd=cwd)


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


def cpp(file: Path, args: list, cwd: Path, extra_args: dict):
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
            [str(file.with_suffix(".out"))] + args,
            dry_run=False,
            cwd=cwd,
        )
        return
    logging.error(f"Unsupported build system found for cpp file {file}")


def cmake(file: Path, args: list, cwd: Path, extra_args: dict):
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
        logging.error("No response for client-vscode")
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
        [str(target_info["path"])] + args,
        dry_run=False,
        cwd=cwd,
    )
    return True


runners: Final = {".lua": lua, ".py": python, ".rs": rust, ".cpp": cpp, ".fish": fish}


def main():
    parser = argparse.ArgumentParser()
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
            run_args["micromamba"] = file.read().splitlines()[0]
        logging.info(f"Using micromamba env {run_args['micromamba']}")

    runner(file_path, args, workspace_path, extra_args=run_args)


if __name__ == "__main__":
    main()
