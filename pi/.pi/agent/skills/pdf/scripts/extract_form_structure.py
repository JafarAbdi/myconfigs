# /// script
# dependencies = ["pymupdf"]
# ///
"""
Extract form structure from a non-fillable PDF.

This script analyzes the PDF to find:
- Text labels with their exact coordinates
- Horizontal lines (row boundaries)
- Checkboxes (small rectangles)

Output: A JSON file with the form structure that can be used
to generate accurate field coordinates for filling.

Usage: uv run extract_form_structure.py <input.pdf> <output.json>
"""

import json
import sys

import pymupdf


def extract_page_words(page: pymupdf.Page, page_number: int) -> list[dict]:
    """Extract words from a page with coordinates."""
    words = page.get_text("words")
    result = []
    for word in words:
        # Each word tuple: (x0, y0, x1, y1, text, block, line, word).
        result.append(
            {
                "page": page_number,
                "text": word[4],
                "x0": round(word[0], 1),
                "top": round(word[1], 1),
                "x1": round(word[2], 1),
                "bottom": round(word[3], 1),
            }
        )
    return result


def extract_page_drawings(
    page: pymupdf.Page,
    page_number: int,
    page_width: float,
) -> tuple[list[dict], list[dict]]:
    """Extract horizontal lines and checkbox rectangles."""
    lines = []
    checkboxes = []

    for path in page.get_drawings():
        for item in path["items"]:
            item_type = item[0]

            if item_type == "l":
                # Line item: ("l", start_point, end_point).
                start = item[1]
                end = item[2]
                line_width = abs(end.x - start.x)
                line_height = abs(end.y - start.y)
                is_horizontal = line_height < 2 and line_width > page_width * 0.5
                if is_horizontal:
                    lines.append(
                        {
                            "page": page_number,
                            "y": round(min(start.y, end.y), 1),
                            "x0": round(min(start.x, end.x), 1),
                            "x1": round(max(start.x, end.x), 1),
                        }
                    )

            elif item_type == "re":
                # Rectangle item: ("re", rect, ...).
                rect = item[1]
                rect_width = rect.width
                rect_height = rect.height
                is_checkbox = (
                    5 <= rect_width <= 15
                    and 5 <= rect_height <= 15
                    and abs(rect_width - rect_height) < 2
                )
                if is_checkbox:
                    checkboxes.append(
                        {
                            "page": page_number,
                            "x0": round(rect.x0, 1),
                            "top": round(rect.y0, 1),
                            "x1": round(rect.x1, 1),
                            "bottom": round(rect.y1, 1),
                            "center_x": round((rect.x0 + rect.x1) / 2, 1),
                            "center_y": round((rect.y0 + rect.y1) / 2, 1),
                        }
                    )

    return lines, checkboxes


def compute_row_boundaries(
    lines: list[dict],
) -> list[dict]:
    """Compute row boundaries from horizontal lines."""
    lines_by_page: dict[int, list[float]] = {}
    for line in lines:
        page = line["page"]
        if page not in lines_by_page:
            lines_by_page[page] = []
        lines_by_page[page].append(line["y"])

    row_boundaries = []
    for page, y_coords in lines_by_page.items():
        y_coords = sorted(set(y_coords))
        for i in range(len(y_coords) - 1):
            row_boundaries.append(
                {
                    "page": page,
                    "row_top": y_coords[i],
                    "row_bottom": y_coords[i + 1],
                    "row_height": round(y_coords[i + 1] - y_coords[i], 1),
                }
            )

    return row_boundaries


def extract_form_structure(pdf_path: str) -> dict:
    """Extract form structure from a non-fillable PDF."""
    structure: dict = {
        "pages": [],
        "labels": [],
        "lines": [],
        "checkboxes": [],
        "row_boundaries": [],
    }

    doc = pymupdf.open(pdf_path)
    for page_index in range(len(doc)):
        page = doc[page_index]
        page_number = page_index + 1
        page_width = page.rect.width
        page_height = page.rect.height

        structure["pages"].append(
            {
                "page_number": page_number,
                "width": round(page_width, 1),
                "height": round(page_height, 1),
            }
        )

        structure["labels"].extend(extract_page_words(page, page_number))

        page_lines, page_checkboxes = extract_page_drawings(
            page, page_number, page_width
        )
        structure["lines"].extend(page_lines)
        structure["checkboxes"].extend(page_checkboxes)

    structure["row_boundaries"] = compute_row_boundaries(structure["lines"])

    return structure


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: extract_form_structure.py <input.pdf> <output.json>")
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_path = sys.argv[2]

    print(f"Extracting structure from {pdf_path}...")
    structure = extract_form_structure(pdf_path)

    with open(output_path, "w") as f:
        json.dump(structure, f, indent=2)

    print("Found:")
    print(f"  - {len(structure['pages'])} pages")
    print(f"  - {len(structure['labels'])} text labels")
    print(f"  - {len(structure['lines'])} horizontal lines")
    print(f"  - {len(structure['checkboxes'])} checkboxes")
    print(f"  - {len(structure['row_boundaries'])} row boundaries")
    print(f"Saved to {output_path}")


if __name__ == "__main__":
    main()
