import os
from pathlib import Path

os.chdir("..")
directory = Path("{{cookiecutter.project_name}}")
for file in directory.glob("*.*"):
    file.rename(directory.parent / file.name)
directory.rmdir()
