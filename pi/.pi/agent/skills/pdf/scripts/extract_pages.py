# /// script
# dependencies = ["pymupdf"]
# ///

import sys

import pymupdf


def parse_page_spec(spec: str, total_pages: int) -> list[int]:
    """Parse page spec like '1-3,5,7-9' into sorted 0-indexed page numbers."""
    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start = int(start_s)
            end = int(end_s)
            for p in range(start, end + 1):
                if 1 <= p <= total_pages:
                    pages.add(p - 1)
        else:
            p = int(part)
            if 1 <= p <= total_pages:
                pages.add(p - 1)
    return sorted(pages)


def extract_pages(input_path: str, output_path: str, page_spec: str) -> None:
    doc = pymupdf.open(input_path)
    pages = parse_page_spec(page_spec, len(doc))
    if not pages:
        print(
            f"Error: no valid pages in spec '{page_spec}' (document has {len(doc)} pages)"
        )
        sys.exit(1)

    out = pymupdf.open()
    for page_index in pages:
        out.insert_pdf(doc, from_page=page_index, to_page=page_index)

    out.save(output_path)
    print(f"Extracted {len(pages)} pages to {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: extract_pages.py <input.pdf> <output.pdf> <page-spec>")
        print("  page-spec: '1-3,5,7-9' (1-indexed)")
        sys.exit(1)
    extract_pages(sys.argv[1], sys.argv[2], sys.argv[3])
