#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""Self-contained dot-to-ascii converter using graph-easy.

Installs graph-easy into ~/.cache/graph-easy/ on first run.
Requires: perl, curl (for one-time bootstrap).

Usage as CLI:

    python dot_to_ascii.py 'digraph { a -> b -> c }'
    echo 'digraph { a -> b -> c }' | python dot_to_ascii.py

Usage as library:

    from dot_to_ascii import convert

    result = convert("digraph { a -> b -> c }")
    print(result)

    # Plain ASCII instead of Unicode box-drawing characters.
    result = convert("digraph { a -> b -> c }", fancy=False)
"""

import os
import pathlib
import shutil
import subprocess
import sys

_INSTALL_DIR = pathlib.Path.home() / ".cache" / "graph-easy"
_PERL5LIB = _INSTALL_DIR / "lib" / "perl5"
_GRAPH_EASY = _INSTALL_DIR / "bin" / "graph-easy"


def _ensure_installed() -> None:
    """Bootstrap graph-easy into ~/.cache/graph-easy/ if not already present."""
    if _GRAPH_EASY.is_file():
        return

    if not shutil.which("perl"):
        print("Error: perl is required but not found.", file=sys.stderr)
        sys.exit(1)

    if not shutil.which("curl"):
        print("Error: curl is required but not found.", file=sys.stderr)
        sys.exit(1)

    print("Installing graph-easy locally (one-time)...", file=sys.stderr)
    _INSTALL_DIR.mkdir(parents=True, exist_ok=True)

    install_dir = str(_INSTALL_DIR)

    # Fetch the cpanm bootstrap script and pipe it into perl.
    cpanm_script = subprocess.run(
        [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "https://cpanmin.us",
        ],
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["perl", "-", "--local-lib", install_dir, "App::cpanminus"],
        input=cpanm_script.stdout,
        check=True,
    )

    # Install Graph::Easy using the locally-installed cpanm.
    cpanm = str(_INSTALL_DIR / "bin" / "cpanm")
    subprocess.run(
        [cpanm, "--local-lib", install_dir, "Graph::Easy"],
        check=True,
    )

    print("Done.", file=sys.stderr)


def convert(dot_source: str, *, fancy: bool = True) -> str:
    """Convert a Graphviz DOT string to ASCII art.

    Args:
        dot_source: A valid Graphviz DOT string.
        fancy: Use Unicode box-drawing characters instead of plain ASCII.

    Returns:
        The rendered ASCII diagram.

    Raises:
        SyntaxError: If graph-easy fails to parse the input.
    """
    _ensure_installed()

    output_format = "--as_boxart" if fancy else "--as_ascii"
    environment = {**os.environ, "PERL5LIB": str(_PERL5LIB)}

    result = subprocess.run(
        [str(_GRAPH_EASY), "--from=dot", output_format],
        input=dot_source,
        capture_output=True,
        text=True,
        timeout=10,
        env=environment,
    )

    if result.returncode != 0 or not result.stdout:
        raise SyntaxError(f"Conversion failed: {result.stderr}")

    return result.stdout


if __name__ == "__main__":
    if len(sys.argv) > 1:
        source = sys.argv[1]
    elif not sys.stdin.isatty():
        source = sys.stdin.read()
    else:
        print("Usage: python dot_to_ascii.py 'digraph { a -> b }'", file=sys.stderr)
        print(
            "       echo 'digraph { a -> b }' | python dot_to_ascii.py",
            file=sys.stderr,
        )
        sys.exit(1)

    print(convert(source))
