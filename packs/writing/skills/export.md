Use `writing_export` to turn a finished draft into a stored Markdown or
HTML artifact. The tool validates, sanitizes and stores — it does not
publish anywhere.

1. Input is exactly one of:
   - `ref`: an `art_…` artifact ref holding the draft (preferred for long
     drafts — create it via `artifacts_create` when available).
   - `text`: inline draft content, at most ~64 KiB. Never paste a longer
     draft; store it first.
   Supplying both or neither fails validation.
2. `format` is the output: `markdown` or `html`. `source_format` tells the
   tool how to read the draft (`markdown`, `html`, `text`); it defaults to
   `format`. Markdown → HTML uses a small built-in renderer (headings,
   lists, emphasis, links, code, quotes) — check the result for complex
   layouts (tables, footnotes are not rendered).
3. HTML output is sanitized: an allowlist of tags and attributes, links
   restricted to http/https, everything else escaped or dropped. Do not
   expect scripts, styles, iframes or custom classes to survive.
4. The tool returns `{"kind":"artifact","artifact":{ref,mimeType,sha256,
   bytes,name}}`. Report the ref and name to the operator; the artifact
   stays in the operator-bound store and is not a public URL.
5. Failures mean the draft was not stored — exit non-zero or an error
   field. Do not retry blindly on validation errors (fix the input); a
   storage error is safe to retry once.
