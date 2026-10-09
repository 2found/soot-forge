# DeepSeek OCR without heavyweight agent dependencies

Use `ocr_recognize` to produce page-attributed Markdown in a new `.md` output.
It reuses usable native PDF text unless `force:true`; scan/image pages are
rasterized and sent to a host-bound OpenAI-compatible **DeepSeek OCR** server.
At most eight distinct pages per call keeps cost, memory and output bounded.
Large documents need explicit batches with page identities preserved.

`OCR_BINDING` owns `base_url`, optional `api_key`, and the actual served model
ID (normally `deepseek-ai/DeepSeek-OCR-2`). The pack does not install vLLM,
PyTorch or model weights, start a server, or own provider credentials. A service
redirect is rejected. Native-text output is identified as such; inference
truncated by token limits fails instead of producing a seemingly complete file.

Check source-page comments and inspect names, numbers, signs, Vietnamese tones,
tables, equations and column order against the rendered pages. Record literal
uncertain spans for review; never reconstruct missing evidence from language
priors. Results contain no fabricated confidence. Missing server/model is a
setup blocker, not permission to use generic chat or Tesseract unnoticed.
