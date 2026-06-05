# /// script
# dependencies = ["pymupdf"]
# ///

import json
import sys

import pymupdf


def transform_from_image_coords(
    bbox: list[float],
    image_width: float,
    image_height: float,
    pdf_width: float,
    pdf_height: float,
) -> pymupdf.Rect:
    """Scale image coordinates to PDF page coordinates.

    Both coordinate systems use y=0 at top, so only
    scaling is needed (no y-flip).
    """
    x_scale = pdf_width / image_width
    y_scale = pdf_height / image_height
    return pymupdf.Rect(
        bbox[0] * x_scale,
        bbox[1] * y_scale,
        bbox[2] * x_scale,
        bbox[3] * y_scale,
    )


def transform_from_pdf_coords(
    bbox: list[float],
    pdf_width: float,
    pdf_height: float,
) -> pymupdf.Rect:
    """Pass through PDF coordinates directly.

    The input coordinates from extract_form_structure use
    y=0 at top, matching PyMuPDF's coordinate system.
    """
    return pymupdf.Rect(bbox[0], bbox[1], bbox[2], bbox[3])


def parse_hex_color(
    hex_color: str,
) -> tuple[float, float, float]:
    """Convert a hex color string to an RGB float tuple."""
    hex_color = hex_color.lstrip("#")
    red = int(hex_color[0:2], 16) / 255.0
    green = int(hex_color[2:4], 16) / 255.0
    blue = int(hex_color[4:6], 16) / 255.0
    return (red, green, blue)


def fill_pdf_form(
    input_pdf_path: str,
    fields_json_path: str,
    output_pdf_path: str,
) -> None:
    with open(fields_json_path, "r") as f:
        fields_data = json.load(f)

    doc = pymupdf.open(input_pdf_path)

    annotation_count = 0
    for field in fields_data["form_fields"]:
        page_num = field["page_number"]
        page = doc[page_num - 1]
        pdf_width = page.rect.width
        pdf_height = page.rect.height

        page_info = next(
            p for p in fields_data["pages"] if p["page_number"] == page_num
        )

        if "pdf_width" in page_info:
            rect = transform_from_pdf_coords(
                field["entry_bounding_box"],
                pdf_width,
                pdf_height,
            )
        else:
            rect = transform_from_image_coords(
                field["entry_bounding_box"],
                page_info["image_width"],
                page_info["image_height"],
                pdf_width,
                pdf_height,
            )

        if "entry_text" not in field or "text" not in field["entry_text"]:
            continue
        entry_text = field["entry_text"]
        text = entry_text["text"]
        if not text:
            continue

        font_size = entry_text.get("font_size", 14)
        font_color = parse_hex_color(entry_text.get("font_color", "000000"))

        annot = page.add_freetext_annot(
            rect=rect,
            text=text,
            fontname="helv",
            fontsize=font_size,
            text_color=font_color,
            fill_color=None,
            border_width=0,
        )
        annot.update()
        annotation_count += 1

    doc.save(output_pdf_path)

    print(f"Successfully filled PDF form and saved to {output_pdf_path}")
    print(f"Added {annotation_count} text annotations")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "Usage: fill_pdf_form_with_annotations.py"
            " [input pdf] [fields.json] [output pdf]"
        )
        sys.exit(1)
    input_pdf = sys.argv[1]
    fields_json = sys.argv[2]
    output_pdf = sys.argv[3]

    fill_pdf_form(input_pdf, fields_json, output_pdf)
