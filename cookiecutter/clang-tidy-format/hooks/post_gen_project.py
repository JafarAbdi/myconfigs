import os
from pathlib import Path

import requests

if "{{cookiecutter.source}}" == "moveit":
    clang_tidy_result = requests.get(
        "https://raw.githubusercontent.com/ros-planning/moveit/master/.clang-tidy"
    )
    clang_format_result = requests.get(
        "https://raw.githubusercontent.com/ros-planning/moveit/master/.clang-format"
    )
    with open(".clang-format", "w", encoding="utf-8") as f:
        f.write(clang_format_result.text)
    with open(".clang-tidy", "w", encoding="utf-8") as f:
        f.write(clang_tidy_result.text)

os.chdir("..")
directory = Path("{{cookiecutter.project_name}}")
for file in directory.glob("*.*"):
    file.rename(directory.parent / file.name)
directory.rmdir()
