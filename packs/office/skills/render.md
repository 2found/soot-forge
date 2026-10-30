# Inspect a decoded PDF page

Use `office_render` with a zero-based `page` and new PNG `output`. PDFium renders
real page content without Chromium, Office or a language model. Inspect glyphs,
headers, margins, tables, form values and clipping at both readable zoom and
page scale. Sample the first/last page and every changed layout; a text check
cannot prove visual correctness. The runner limits scale and raster pixels.

DOCX/PPTX need a renderer first. Use the optional LibreOffice
conversion tool (`office_convert`) or a supplied PDF export, then render it. Never call an
extracted title or a generated file a visual verification.
