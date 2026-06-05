# /// script
# dependencies = ["pymupdf"]
# ///

import json
import sys

import pymupdf


def make_widget_dict(
    widget: pymupdf.Widget,
    page_number: int,
    page_height: float,
) -> dict | None:
    """Build a field info dict for a non-radio widget.

    Returns None if the widget cannot be processed.
    Coordinates are converted to PDF-native format
    (y=0 at bottom) for output compatibility.
    """
    field_name = widget.field_name
    rect = [
        widget.rect.x0,
        page_height - widget.rect.y1,
        widget.rect.x1,
        page_height - widget.rect.y0,
    ]
    field_type = widget.field_type

    if field_type == pymupdf.PDF_WIDGET_TYPE_TEXT:
        return {
            "field_id": field_name,
            "type": "text",
            "page": page_number,
            "rect": rect,
        }

    if field_type == pymupdf.PDF_WIDGET_TYPE_CHECKBOX:
        on_state = widget.on_state()
        if not on_state:
            print(f"Cannot determine states for checkbox '{field_name}', skipping")
            return None
        return {
            "field_id": field_name,
            "type": "checkbox",
            "checked_value": on_state,
            "unchecked_value": "Off",
            "page": page_number,
            "rect": rect,
        }

    if field_type in (
        pymupdf.PDF_WIDGET_TYPE_COMBOBOX,
        pymupdf.PDF_WIDGET_TYPE_LISTBOX,
    ):
        choices = widget.choice_values
        return {
            "field_id": field_name,
            "type": "choice",
            "choice_options": [{"value": c, "text": c} for c in choices],
            "page": page_number,
            "rect": rect,
        }

    return {
        "field_id": field_name,
        "type": f"unknown ({field_type})",
        "page": page_number,
        "rect": rect,
    }


def get_field_info(doc: pymupdf.Document) -> list[dict]:
    """Extract field info from all form widgets."""
    assert len(doc) > 0, "Document has no pages."

    fields: list[dict] = []
    radio_groups: dict[str, dict] = {}

    for page_index in range(len(doc)):
        page = doc[page_index]
        page_number = page_index + 1
        page_height = page.rect.height

        for widget in page.widgets():
            if widget.field_type == pymupdf.PDF_WIDGET_TYPE_RADIOBUTTON:
                name = widget.field_name
                on_state = widget.on_state()
                rect = [
                    widget.rect.x0,
                    page_height - widget.rect.y1,
                    widget.rect.x1,
                    page_height - widget.rect.y0,
                ]
                if name not in radio_groups:
                    radio_groups[name] = {
                        "field_id": name,
                        "type": "radio_group",
                        "page": page_number,
                        "radio_options": [],
                    }
                if on_state:
                    radio_groups[name]["radio_options"].append(
                        {
                            "value": on_state,
                            "rect": rect,
                        }
                    )
                continue

            field_dict = make_widget_dict(widget, page_number, page_height)
            if field_dict:
                fields.append(field_dict)

    all_fields = fields + list(radio_groups.values())

    def sort_key(field: dict) -> list:
        if "radio_options" in field:
            options = field["radio_options"]
            rect = options[0]["rect"] if options else [0, 0, 0, 0]
        else:
            rect = field.get("rect") or [0, 0, 0, 0]
        return [
            field.get("page", 0),
            -rect[1],
            rect[0],
        ]

    all_fields.sort(key=sort_key)
    return all_fields


def write_field_info(pdf_path: str, json_output_path: str) -> None:
    doc = pymupdf.open(pdf_path)
    field_info = get_field_info(doc)
    with open(json_output_path, "w") as f:
        json.dump(field_info, f, indent=2)
    print(f"Wrote {len(field_info)} fields to {json_output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract_form_field_info.py [input pdf] [output json]")
        sys.exit(1)
    write_field_info(sys.argv[1], sys.argv[2])
