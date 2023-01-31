import os
from pathlib import Path
from shutil import move

os.chdir("..")
directory = Path({% raw %}"{{cookiecutter.project_name}}"{% endraw %})
for file in directory.iterdir():
    move(file, directory.parent/ file.name)
directory.rmdir()
