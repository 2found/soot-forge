# Office JSON specs

Specs are UTF-8 JSON files under FILE_ROOT, up to 2 MiB. Pass their relative
path in `spec`. Their schemas below are the supported subsets, not arbitrary
Office XML. Compose and edit always publish a new destination.

## Word

```json
{"title":"Báo cáo", "blocks":[
  {"kind":"heading","level":1,"text":"Kết quả tháng này"},
  {"kind":"paragraph","runs":[{"text":"Doanh thu: ","bold":true},{"text":"{{revenue}}"}]},
  {"kind":"bullet","text":"Đã đối chiếu số liệu nguồn"},
  {"kind":"table","rows":[["Hạng mục","Giá trị"],["Doanh thu","125 triệu"]]},
  {"kind":"image","path":"assets/chart.png","width":5},
  {"kind":"page_break"}
]}
```

`runs` and nonempty `text` are mutually exclusive. Heading levels 0..9, image
width .1..7 inches. At most 1000 blocks, 500 table rows, 30 columns and 5000 cells.

Edit spec (Word and PowerPoint):

```json
{"replacements":[{"find":"{{revenue}}","replace":"125 triệu đồng","expected":1}]}
```

`expected` is optional but recommended. A mismatch publishes no file. Matching
preserves surrounding run styling; it does not implement Word redlining or
PPTX SmartArt editing.

## Excel

```json
{"sheets":[{"name":"Chi phí","freeze":"A2","widths":{"A":28,"B":18},"table":true,
  "rows":[["Hạng mục","VND"],["Máy chủ",1200000],["Âm thanh",450000],
          ["Tổng",{"formula":"=SUM(B2:B3)"}]]}]}
```

Values are null/bool/number/string, or an explicit formula object. Formula
objects are preserved, not calculated. Plain `=...` strings are literal. Sheet
names are unique, at most 31 characters, with no Excel-invalid characters.
At most 30 sheets, 10k rows/sheet, 100 columns/row and 100k cells/sheet.

Edit spec:

```json
{"cells":[{"sheet":"Chi phí","cell":"B2","value":1400000,"number_format":"#,##0","bold":true},
          {"sheet":"Chi phí","cell":"B4","value":{"formula":"=SUM(B2:B3)"}}]}
```

Existing styles remain except the explicitly changed fields. At most 5000
changes. Unsupported macro-rich workbooks should be processed with native Office
under a suitable host grant; this tool accepts `.xlsx` only.

## PowerPoint

```json
{"widescreen":true,"slides":[{"title":"Soot Forge","bullets":["Office và PDF","Giọng đọc OmniVoice"],
  "notes":"Exact presenter notes.","image":"assets/chart.png"}]}
```

At most 100 slides and 12 bullets/slide. This creates an editable draft. It does
not automate arbitrary corporate templates, animations or native charts.

## PDF

```json
{"title":"Báo cáo","font":"assets/NotoSans-Regular.ttf","blocks":[
 {"kind":"heading","text":"Báo cáo tiếng Việt"},
 {"kind":"paragraph","text":"Đọc được đầy đủ dấu tiếng Việt."},
 {"kind":"table","rows":[["Mục","Số lượng"],["Tài liệu",5]]},
 {"kind":"page_break"},{"kind":"paragraph","text":"Trang tiếp theo"}]}
```

Use a licensed TrueType font containing all required glyphs. PDF creation embeds
that font; it does not copy a proprietary font into the pack. For selection,
merging, rotation or form filling use `office_pdf_modify` directly, not a spec.
PDF field filling preserves interactive fields; it is not a flattening or
secure-redaction operation.
