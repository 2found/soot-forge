# Choose extraction from evidence

Use `ocr_assess` on a selected PDF page set or an image. It runs locally and
never calls a model. PDF pages use zero-based indexes; select at most eight.
A substantial text layer normally takes the native-text route. Sparse text,
scans, damaged glyphs, tiny text, tables or multi-column reading-order problems
justify a dedicated OCR pass after visual inspection.

There is no universal claim that GPT or Claude are poor at OCR, nor that
DeepSeek wins every language/document. Compare the requested pages against
source images and, for critical numbers/names, supplied ground truth. Preserve
uncertainty rather than invent text. Do not treat a model's claimed confidence
as calibrated accuracy. A text-layer threshold is a cheap routing heuristic,
not a benchmark or proof of completeness.

The dedicated route requires explicit `ocr/recognize` selection and a host
DeepSeek OCR binding. It is not the normal DeepSeek chat API and does not
silently fall back to a different model.
