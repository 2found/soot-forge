# Produce editable Office files and safe copies

Use `office_compose` for a new file and `office_edit` for a changed copy.
Keep the original. Every output must be new with an existing parent folder;
returned SHA-256 binds the actual artifact. Inputs over tool limits belong in
workspace JSON files, written only through a separately granted file tool
(such as the `toolbox` pack); don't assume the pack grants shell or file editing.

Read [the exact spec examples](../SPEC.md). Compose accepts:

- DOCX: `blocks` of heading, paragraph, bullet, number, table, image and
  page_break. Paragraph `runs` preserve bold/italic. Images reference local files.
- XLSX: named `sheets`, rectangular/padded `rows`, optional freeze cell,
  column widths and table headers. Plain strings, even beginning `=`, stay
  literal. A formula is explicit: `{"formula":"=SUM(B2:B5)"}`. External workbook
  links, network formulas and DDE are rejected. Formulas remain unevaluated.
- PPTX: widescreen slides with title, bullets, notes and optional image.
  These are editable draft slides. Overflow, charts and visual fidelity need
  subsequent rendering and inspection; don't claim a polished deck from XML.
- PDF: blocks and a workspace TrueType `font` with the target language's glyphs.
  The font is embedded so Vietnamese accents do not fall back to missing glyphs.

Edit DOCX/PPTX with `replacements:[{find,replace,expected}]`. Matches can span
styled runs; replacement inherits the first matched run's style. Text around
matches retains its styling. Prefer `expected` to detect stale templates. Word
headers, footers and table paragraphs and slide notes/table paragraphs are
included. Complex Word fields, tracked revisions, linked text boxes, grouped
shapes and SmartArt are not fully supported: inspect the actual file and report
the gap instead of silently rebuilding it. Edit Excel with explicit
`cells:[{sheet,cell,value,number_format?,bold?}]`; formulas use formula objects.

`office_pdf_modify` merges `paths`, selects zero-based `pages` from one PDF,
rotates all selected pages or fills named existing fields. It preserves editable
fields and does not claim flattening or cryptographic redaction. For a form,
read field names/types first and inspect the final rendered appearance. Deleting
text or drawing a rectangle is not secure PDF redaction.

Verify by reading the output again, check replacement counts and formulas,
then render representative pages/slides when layout matters. Distinguish
structural checks from visual approval. Conversion/recalculation through
LibreOffice is optional and requires `office_convert`.
