import os
from pathlib import Path

os.chdir("..")
directory = Path({% raw %}"{{cookiecutter.project_name}}"{% endraw %})
for file in directory.glob("*.*"):
    file.rename(directory.parent / file.name)
directory.rmdir()
