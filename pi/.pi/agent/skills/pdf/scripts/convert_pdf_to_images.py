# /// script
# dependencies = ["pymupdf"]
# ///

import os
import sys

import pymupdf


def convert(
    pdf_path: str,
    output_dir: str,
    target_dpi: int = 200,
    max_dim: int = 1000,
) -> None:
    doc = pymupdf.open(pdf_path)

    for page_index in range(len(doc)):
        page = doc[page_index]

        # Render at target DPI.
        pixmap = page.get_pixmap(dpi=target_dpi)

        # Re-render at reduced DPI if image exceeds max dimension.
        if pixmap.width > max_dim or pixmap.height > max_dim:
            scale_factor = min(
                max_dim / pixmap.width,
                max_dim / pixmap.height,
            )
            adjusted_dpi = target_dpi * scale_factor
            matrix = pymupdf.Matrix(adjusted_dpi / 72, adjusted_dpi / 72)
            pixmap = page.get_pixmap(matrix=matrix)

        image_path = os.path.join(output_dir, f"page_{page_index + 1}.png")
        pixmap.save(image_path)
        print(
            f"Saved page {page_index + 1} as {image_path}"
            f" (size: {pixmap.width}x{pixmap.height})"
        )

    print(f"Converted {len(doc)} pages to PNG images")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: convert_pdf_to_images.py [input pdf] [output directory]")
        sys.exit(1)
    pdf_path = sys.argv[1]
    output_directory = sys.argv[2]
    convert(pdf_path, output_directory)
