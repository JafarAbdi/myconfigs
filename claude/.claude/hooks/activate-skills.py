#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# ///
# SessionStart hook — inject configured skills as system context.
#
# Reads each skill's SKILL.md, strips YAML frontmatter, concatenates with a
# separator, and prints to stdout. Claude Code injects SessionStart hook
# stdout as hidden session context.
#
# Skills carry their own defaults (e.g., caveman's intensity is documented
# inline in its SKILL.md). This script does no per-skill filtering — keeps
# the wiring boringly uniform.

import re
import sys
from pathlib import Path

SKILLS: list[str] = [
    "caveman",
    "karpathy-guidelines",
]

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
FRONTMATTER = re.compile(r"\A---.*?---\s*", re.DOTALL)


def load_skill(name: str) -> str:
    assert name, "skill name must be non-empty"
    path = SKILLS_DIR / name / "SKILL.md"
    assert path.is_file(), f"skill file missing: {path}"
    body = FRONTMATTER.sub("", path.read_text())
    assert body, f"skill body empty after frontmatter strip: {path}"
    return body


sys.stdout.write("\n\n---\n\n".join(load_skill(name) for name in SKILLS))
