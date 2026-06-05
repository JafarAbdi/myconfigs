# /// script
# dependencies = ["pymupdf"]
# ///

import sys

import pymupdf


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: check_fillable_fields.py <input.pdf>")
        sys.exit(1)

    doc = pymupdf.open(sys.argv[1])
    has_widgets = any(widget for page in doc for widget in page.widgets())

    if has_widgets:
        print("This PDF has fillable form fields")
    else:
        print(
            "This PDF does not have fillable form fields;"
            " you will need to visually determine"
            " where to enter data"
        )


if __name__ == "__main__":
    main()
