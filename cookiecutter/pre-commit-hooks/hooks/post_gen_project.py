import os
from pathlib import Path
from shutil import move

os.chdir("..")
directory = Path("{{cookiecutter.project_name}}")

for file in directory.iterdir():
    move(file, directory.parent/ file.name)
directory.rmdir()
