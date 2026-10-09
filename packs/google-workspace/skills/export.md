# Export the served document

Use `google-workspace_docs_export` with document ID, `format:pdf|docx|txt` and new local
output. Drive exports are bounded to 10 MiB. A missing scope, unavailable file,
expired host token, export limit or invalid response is an explicit failure;
never write an HTML error response as a PDF. Check the exported file's hash and
read/render it through Office/PDF tools if those capabilities are selected.
Export is a local write; it does not publish or alter Google sharing.
