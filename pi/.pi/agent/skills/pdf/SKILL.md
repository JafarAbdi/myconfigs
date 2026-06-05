---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features and detailed examples, see {baseDir}/references/reference.md. If you need to fill out a PDF form, read {baseDir}/references/forms.md and follow its instructions.

## Quick Start

```python
import pymupdf

# Read a PDF
doc = pymupdf.open("document.pdf")
print(f"Pages: {len(doc)}")

# Extract text
text = ""
for page in doc:
    text += page.get_text()
```

## Python Libraries

### PyMuPDF - Reading, Manipulating, and Rendering PDFs

#### Merge PDFs
```python
import pymupdf

doc = pymupdf.open("doc1.pdf")
for pdf_file in ["doc2.pdf", "doc3.pdf"]:
    other = pymupdf.open(pdf_file)
    doc.insert_pdf(other)

doc.save("merged.pdf")
```

#### Split PDF
```python
import pymupdf

doc = pymupdf.open("input.pdf")
for page_index in range(len(doc)):
    new_doc = pymupdf.open()
    new_doc.insert_pdf(doc, from_page=page_index, to_page=page_index)
    new_doc.save(f"page_{page_index + 1}.pdf")
```

#### Extract Metadata
```python
import pymupdf

doc = pymupdf.open("document.pdf")
meta = doc.metadata
print(f"Title: {meta['title']}")
print(f"Author: {meta['author']}")
print(f"Subject: {meta['subject']}")
print(f"Creator: {meta['creator']}")
```

#### Rotate Pages
```python
import pymupdf

doc = pymupdf.open("input.pdf")
page = doc[0]
page.set_rotation(90)  # Rotate 90 degrees clockwise
doc.save("rotated.pdf")
```

#### Extract Text
```python
import pymupdf

doc = pymupdf.open("document.pdf")
for page in doc:
    text = page.get_text()
    print(text)
```

#### Extract Text with Coordinates
```python
import pymupdf

doc = pymupdf.open("document.pdf")
page = doc[0]

# Get structured text as a dict with blocks, lines, and spans.
text_dict = page.get_text("dict")
for block in text_dict["blocks"]:
    if block["type"] == 0:  # Text block.
        for line in block["lines"]:
            for span in line["spans"]:
                print(f"Text: '{span['text']}' at ({span['bbox'][0]:.1f}, {span['bbox'][1]:.1f})")
```

#### Extract Tables
For complex table extraction, pdfplumber remains an option:
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

#### Render PDF to Images
```python
import pymupdf

doc = pymupdf.open("document.pdf")
for page_index in range(len(doc)):
    page = doc[page_index]
    pixmap = page.get_pixmap(dpi=200)
    pixmap.save(f"page_{page_index + 1}.png")
```

#### Password Protection
```python
import pymupdf

doc = pymupdf.open("input.pdf")
doc.save(
    "encrypted.pdf",
    encryption=pymupdf.PDF_ENCRYPT_AES_256,
    user_pw="userpassword",
    owner_pw="ownerpassword",
)
```

### reportlab - Create PDFs

#### Basic PDF Creation
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

# Add text
c.drawString(100, height - 100, "Hello World!")
c.drawString(100, height - 120, "This is a PDF created with reportlab")

# Add a line
c.line(100, height - 140, 400, height - 140)

# Save
c.save()
```

#### Create PDF with Multiple Pages
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

# Add content
title = Paragraph("Report Title", styles['Title'])
story.append(title)
story.append(Spacer(1, 12))

body = Paragraph("This is the body of the report. " * 20, styles['Normal'])
story.append(body)
story.append(PageBreak())

# Page 2
story.append(Paragraph("Page 2", styles['Heading1']))
story.append(Paragraph("Content for page 2", styles['Normal']))

# Build PDF
doc.build(story)
```

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
```python
from reportlab.platypus import Paragraph
from reportlab.lib.styles import getSampleStyleSheet

styles = getSampleStyleSheet()

# Subscripts: use <sub> tag
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])

# Superscripts: use <super> tag
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

For canvas-drawn text (not Paragraph objects), manually adjust font the size and position rather than using Unicode subscripts/superscripts.

## Command-Line Tools

### pdftotext (poppler-utils)
```bash
# Extract text
pdftotext input.pdf output.txt

# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Extract specific pages
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf
```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf
qpdf input.pdf --pages . 6-10 -- pages6-10.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1  # Rotate page 1 by 90 degrees

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

### pdftk (if available)
```bash
# Merge
pdftk file1.pdf file2.pdf cat output merged.pdf

# Split
pdftk input.pdf burst

# Rotate
pdftk input.pdf rotate 1east output rotated.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs
```python
# Requires: pip install pytesseract pymupdf
import pytesseract
import pymupdf
from PIL import Image
import io

doc = pymupdf.open("scanned.pdf")

text = ""
for page_index in range(len(doc)):
    page = doc[page_index]
    pixmap = page.get_pixmap(dpi=300)
    image = Image.open(io.BytesIO(pixmap.tobytes("png")))

    text += f"Page {page_index + 1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"

print(text)
```

### Add Watermark
```python
import pymupdf

doc = pymupdf.open("document.pdf")
watermark = pymupdf.open("watermark.pdf")
watermark_page = watermark[0]

for page in doc:
    page.show_pdf_page(page.rect, watermark, pno=0)

doc.save("watermarked.pdf")
```

### Extract Images
```bash
# Using pdfimages (poppler-utils)
pdfimages -j input.pdf output_prefix

# This extracts all images as output_prefix-000.jpg, output_prefix-001.jpg, etc.
```

## Quick Reference

| Task | Best Tool | Command/Code |
|------|-----------|--------------|
| Merge PDFs | PyMuPDF | `doc.insert_pdf(other)` |
| Split PDFs | PyMuPDF | `new_doc.insert_pdf(doc, from_page=i, to_page=i)` |
| Extract text | PyMuPDF | `page.get_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | Canvas or Platypus |
| Render to images | PyMuPDF | `page.get_pixmap(dpi=200)` |
| Command line merge | qpdf | `qpdf --empty --pages ...` |
| OCR scanned PDFs | pytesseract + PyMuPDF | Render to image, then OCR |
| Fill PDF forms | PyMuPDF (see {baseDir}/references/forms.md) | See {baseDir}/references/forms.md |

## Next Steps

- For advanced PyMuPDF usage, see {baseDir}/references/reference.md
- If you need to fill out a PDF form, follow the instructions in {baseDir}/references/forms.md
- For troubleshooting guides, see {baseDir}/references/reference.md

---

Based on [anthropics/skills](https://github.com/anthropics/skills/), refactored to use PyMuPDF.
