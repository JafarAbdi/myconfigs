# noqa: INP001
"""Pandoc filter to convert svg files to pdf as suggested at:
https://github.com/jgm/pandoc/issues/265#issuecomment-27317316.
"""

import mimetypes
import os
import subprocess
import sys

from pandocfilters import Image, toJSONFilter

fmt_to_option = {
    "latex": ("--export-pdf", "pdf"),
    # use PNG because EMF and WMF break transparency
    "docx": ("--export-png", "png"),
}


def svg_to_any(key, value, fmt, meta):
    if key == "Image":
        attrs, alt, [src, title] = value
        mimet, _ = mimetypes.guess_type(src)
        option = fmt_to_option.get(fmt)
        if mimet == "image/svg+xml" and option:
            base_name, _ = os.path.splitext(src)  # noqa: PTH122
            eps_name = base_name + "." + option[1]
            try:
                mtime = os.path.getmtime(eps_name)
            except OSError:
                mtime = -1
            if mtime < os.path.getmtime(src):
                cmd_line = [
                    "inkscape",
                    src,
                    "--export-area-drawing",
                    "--export-type=pdf",
                    "--export-filename=" + eps_name,
                ]
                sys.stderr.write("Running %s\n" % " ".join(cmd_line))
                subprocess.call(cmd_line, stdout=sys.stderr.fileno())
            if attrs:
                return Image(attrs, alt, [eps_name, title])
            return Image(alt, [eps_name, title])
    return None


if __name__ == "__main__":
    toJSONFilter(svg_to_any)
