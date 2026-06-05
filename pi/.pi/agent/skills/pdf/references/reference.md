# PDF Processing Advanced Reference

This document contains advanced PDF processing features, detailed examples, and additional libraries not covered in the main skill instructions.

## PyMuPDF Advanced Features

### Rendering with Custom Resolution
```python
import pymupdf

doc = pymupdf.open("document.pdf")

for page_index in range(len(doc)):
    page = doc[page_index]

    # Render at 300 DPI for high quality.
    pixmap = page.get_pixmap(dpi=300)
    pixmap.save(f"page_{page_index + 1}.png")

    # Render at custom scale using a matrix.
    matrix = pymupdf.Matrix(2.0, 2.0)  # 2x zoom.
    pixmap = page.get_pixmap(matrix=matrix)
    pixmap.save(f"page_{page_index + 1}_2x.png")
```

### Extract Text with Coordinates
```python
import pymupdf

doc = pymupdf.open("document.pdf")
page = doc[0]

# Get words with bounding boxes.
words = page.get_text("words")
for word in words[:10]:
    # Each word: (x0, y0, x1, y1, text, block_no, line_no, word_no).
    print(f"Word: '{word[4]}' at ({word[0]:.1f}, {word[1]:.1f}, {word[2]:.1f}, {word[3]:.1f})")

# Get structured text as a dict.
text_dict = page.get_text("dict")
for block in text_dict["blocks"]:
    if block["type"] == 0:  # Text block.
        for line in block["lines"]:
            for span in line["spans"]:
                print(f"'{span['text']}' font={span['font']} size={span['size']}")
```

### Extract Text by Region
```python
import pymupdf

doc = pymupdf.open("document.pdf")
page = doc[0]

# Extract text from a specific rectangle (x0, y0, x1, y1).
rect = pymupdf.Rect(100, 100, 400, 200)
text = page.get_text("text", clip=rect)
print(text)
```

## Advanced Command-Line Operations

### poppler-utils Advanced Features

#### Extract Text with Bounding Box Coordinates
```bash
# Extract text with bounding box coordinates (essential for structured data)
pdftotext -bbox-layout document.pdf output.xml

# The XML output contains precise coordinates for each text element
```

#### Advanced Image Conversion
```bash
# Convert to PNG images with specific resolution
pdftoppm -png -r 300 document.pdf output_prefix

# Convert specific page range with high resolution
pdftoppm -png -r 600 -f 1 -l 3 document.pdf high_res_pages

# Convert to JPEG with quality setting
pdftoppm -jpeg -jpegopt quality=85 -r 200 document.pdf jpeg_output
```

#### Extract Embedded Images
```bash
# Extract all embedded images with metadata
pdfimages -j -p document.pdf page_images

# List image info without extracting
pdfimages -list document.pdf

# Extract images in their original format
pdfimages -all document.pdf images/img
```

### qpdf Advanced Features

#### Complex Page Manipulation
```bash
# Split PDF into groups of pages
qpdf --split-pages=3 input.pdf output_group_%02d.pdf

# Extract specific pages with complex ranges
qpdf input.pdf --pages input.pdf 1,3-5,8,10-end -- extracted.pdf

# Merge specific pages from multiple PDFs
qpdf --empty --pages doc1.pdf 1-3 doc2.pdf 5-7 doc3.pdf 2,4 -- combined.pdf
```

#### PDF Optimization and Repair
```bash
# Optimize PDF for web (linearize for streaming)
qpdf --linearize input.pdf optimized.pdf

# Remove unused objects and compress
qpdf --optimize-level=all input.pdf compressed.pdf

# Attempt to repair corrupted PDF structure
qpdf --check input.pdf
qpdf --fix-qdf damaged.pdf repaired.pdf

# Show detailed PDF structure for debugging
qpdf --show-all-pages input.pdf > structure.txt
```

#### Advanced Encryption
```bash
# Add password protection with specific permissions
qpdf --encrypt user_pass owner_pass 256 --print=none --modify=none -- input.pdf encrypted.pdf

# Check encryption status
qpdf --show-encryption encrypted.pdf

# Remove password protection (requires password)
qpdf --password=secret123 --decrypt encrypted.pdf decrypted.pdf
```

## Advanced Python Techniques

### PyMuPDF Advanced Features

#### Extract Text with Precise Character Coordinates
```python
import pymupdf

doc = pymupdf.open("document.pdf")
page = doc[0]

# Get individual characters with positions.
blocks = page.get_text("rawdict")["blocks"]
for block in blocks:
    if block["type"] == 0:
        for line in block["lines"]:
            for span in line["spans"]:
                print(f"Span: '{span['text']}' at x:{span['origin'][0]:.1f} y:{span['origin'][1]:.1f}")
```

#### pdfplumber for Complex Table Extraction

PyMuPDF is the primary PDF library, but pdfplumber excels at complex table extraction with custom settings:

```python
import pdfplumber
import pandas as pd

with pdfplumber.open("complex_table.pdf") as pdf:
    page = pdf.pages[0]

    # Extract tables with custom settings for complex layouts
    table_settings = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "snap_tolerance": 3,
        "intersection_tolerance": 15
    }
    tables = page.extract_tables(table_settings)

    # Visual debugging for table extraction
    img = page.to_image(resolution=150)
    img.save("debug_layout.png")
```

### reportlab Advanced Features

#### Create Professional Reports with Tables
```python
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

# Sample data
data = [
    ['Product', 'Q1', 'Q2', 'Q3', 'Q4'],
    ['Widgets', '120', '135', '142', '158'],
    ['Gadgets', '85', '92', '98', '105']
]

# Create PDF with table
doc = SimpleDocTemplate("report.pdf")
elements = []

# Add title
styles = getSampleStyleSheet()
title = Paragraph("Quarterly Sales Report", styles['Title'])
elements.append(title)

# Add table with advanced styling
table = Table(data)
table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('FONTSIZE', (0, 0), (-1, 0), 14),
    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
    ('BACKGROUND', (0, 1), (-1, -1), colors.beige),
    ('GRID', (0, 0), (-1, -1), 1, colors.black)
]))
elements.append(table)

doc.build(elements)
```

## Complex Workflows

### Extract Figures/Images from PDF

#### Method 1: Using pdfimages (fastest)
```bash
# Extract all images with original quality
pdfimages -all document.pdf images/img
```

#### Method 2: Using PyMuPDF
```python
import pymupdf

doc = pymupdf.open("document.pdf")
for page_index in range(len(doc)):
    page = doc[page_index]
    image_list = page.get_images(full=True)
    for img_index, img in enumerate(image_list):
        xref = img[0]
        base_image = doc.extract_image(xref)
        image_bytes = base_image["image"]
        image_ext = base_image["ext"]
        with open(f"image_p{page_index + 1}_{img_index}.{image_ext}", "wb") as f:
            f.write(image_bytes)
```

### Batch PDF Processing
```python
import os
import glob
import logging

import pymupdf

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def batch_process_pdfs(input_dir: str, operation: str = "merge") -> None:
    pdf_files = glob.glob(os.path.join(input_dir, "*.pdf"))

    if operation == "merge":
        merged = pymupdf.open()
        for pdf_file in pdf_files:
            try:
                doc = pymupdf.open(pdf_file)
                merged.insert_pdf(doc)
                logger.info(f"Processed: {pdf_file}")
            except Exception as e:
                logger.error(f"Failed to process {pdf_file}: {e}")
                continue
        merged.save("batch_merged.pdf")

    elif operation == "extract_text":
        for pdf_file in pdf_files:
            try:
                doc = pymupdf.open(pdf_file)
                text = ""
                for page in doc:
                    text += page.get_text()
                output_file = pdf_file.replace(".pdf", ".txt")
                with open(output_file, "w", encoding="utf-8") as f:
                    f.write(text)
                logger.info(f"Extracted text from: {pdf_file}")
            except Exception as e:
                logger.error(f"Failed to extract from {pdf_file}: {e}")
                continue
```

### PDF Cropping
```python
import pymupdf

doc = pymupdf.open("input.pdf")
page = doc[0]

# Crop page by setting the CropBox (left, top, right, bottom in points).
page.set_cropbox(pymupdf.Rect(50, 50, 550, 750))

doc.save("cropped.pdf")
```

## Performance Optimization Tips

### 1. For Large PDFs
- Use streaming approaches instead of loading entire PDF in memory
- Use `qpdf --split-pages` for splitting large files
- Process pages individually with PyMuPDF

### 2. For Text Extraction
- `pdftotext -bbox-layout` is fastest for plain text extraction
- Use pdfplumber for structured data and tables
- PyMuPDF's `page.get_text()` is fast for most use cases

### 3. For Image Extraction
- `pdfimages` is much faster than rendering pages
- Use low resolution for previews, high resolution for final output

### 4. For Form Filling
- PyMuPDF's Widget API handles most form field types natively
- Pre-validate form fields before processing

### 5. Memory Management
```python
import pymupdf

# Process PDFs in chunks.
def process_large_pdf(pdf_path: str, chunk_size: int = 10) -> None:
    doc = pymupdf.open(pdf_path)
    total_pages = len(doc)

    for start_index in range(0, total_pages, chunk_size):
        end_index = min(start_index + chunk_size, total_pages)
        chunk = pymupdf.open()
        chunk.insert_pdf(doc, from_page=start_index, to_page=end_index - 1)

        chunk.save(f"chunk_{start_index // chunk_size}.pdf")
```

## Troubleshooting Common Issues

### Encrypted PDFs
```python
import pymupdf

doc = pymupdf.open("encrypted.pdf")
if doc.is_encrypted:
    authenticated = doc.authenticate("password")
    if not authenticated:
        print("Failed to decrypt with provided password")
```

### Corrupted PDFs
```bash
# Use qpdf to repair
qpdf --check corrupted.pdf
qpdf --replace-input corrupted.pdf
```

### Text Extraction Issues
```python
# Fallback to OCR for scanned PDFs.
import pytesseract
import pymupdf
from PIL import Image
import io


def extract_text_with_ocr(pdf_path: str) -> str:
    doc = pymupdf.open(pdf_path)
    text = ""
    for page_index in range(len(doc)):
        page = doc[page_index]
        pixmap = page.get_pixmap(dpi=300)
        image = Image.open(io.BytesIO(pixmap.tobytes("png")))
        text += pytesseract.image_to_string(image)
    return text
```

## License Information

- **PyMuPDF**: AGPL-3.0 License
- **pdfplumber**: MIT License
- **reportlab**: BSD License
- **poppler-utils**: GPL-2 License
- **qpdf**: Apache License
