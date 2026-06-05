# /// script
# dependencies = ["pymupdf"]
# ///

import json
import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_form_field_info import get_field_info


def fill_pdf_fields(
    input_pdf_path: str,
    fields_json_path: str,
    output_pdf_path: str,
) -> None:
    with open(fields_json_path) as f:
        fields = json.load(f)

    doc = pymupdf.open(input_pdf_path)

    has_error = False
    field_info = get_field_info(doc)
    fields_by_ids = {f["field_id"]: f for f in field_info}
    for field in fields:
        existing_field = fields_by_ids.get(field["field_id"])
        if not existing_field:
            has_error = True
            print(f"ERROR: `{field['field_id']}` is not a valid field ID")
        elif field["page"] != existing_field["page"]:
            has_error = True
            print(
                f"ERROR: Incorrect page number for"
                f" `{field['field_id']}`"
                f" (got {field['page']},"
                f" expected {existing_field['page']})"
            )
        elif "value" in field:
            err = validation_error_for_field_value(existing_field, field["value"])
            if err:
                print(err)
                has_error = True
    if has_error:
        sys.exit(1)

    # Build a lookup of field_id -> value for filling.
    values_by_id: dict[str, str] = {}
    for field in fields:
        if "value" in field:
            values_by_id[field["field_id"]] = field["value"]

    # Set each widget's value and update its appearance.
    for page in doc:
        for widget in page.widgets():
            field_name = widget.field_name
            if field_name in values_by_id:
                widget.field_value = values_by_id[field_name]
                widget.update()

    doc.save(output_pdf_path)


def validation_error_for_field_value(field_info: dict, field_value: str) -> str | None:
    field_type = field_info["type"]
    field_id = field_info["field_id"]
    if field_type == "checkbox":
        checked_val = field_info["checked_value"]
        unchecked_val = field_info["unchecked_value"]
        if field_value != checked_val and field_value != unchecked_val:
            return (
                f'ERROR: Invalid value "{field_value}"'
                f' for checkbox field "{field_id}".'
                f' The checked value is "{checked_val}"'
                f" and the unchecked value"
                f' is "{unchecked_val}"'
            )
    elif field_type == "radio_group":
        option_values = [opt["value"] for opt in field_info["radio_options"]]
        if field_value not in option_values:
            return (
                f'ERROR: Invalid value "{field_value}"'
                f' for radio group field "{field_id}".'
                f" Valid values are: {option_values}"
            )
    elif field_type == "choice":
        choice_values = [opt["value"] for opt in field_info["choice_options"]]
        if field_value not in choice_values:
            return (
                f'ERROR: Invalid value "{field_value}"'
                f' for choice field "{field_id}".'
                f" Valid values are: {choice_values}"
            )
    return None


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(
            "Usage: fill_fillable_fields.py"
            " [input pdf] [field_values.json] [output pdf]"
        )
        sys.exit(1)
    input_pdf = sys.argv[1]
    fields_json = sys.argv[2]
    output_pdf = sys.argv[3]
    fill_pdf_fields(input_pdf, fields_json, output_pdf)
