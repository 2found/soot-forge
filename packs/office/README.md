# Office

Read, create and edit Word, Excel, PowerPoint and PDF files with bounded local tools.

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/office
# From the installed pack directory, explicitly prepare the selected tools:
uv venv --python 3.12 /absolute/host-runtimes/office
uv pip sync --python /absolute/host-runtimes/office/bin/python --require-hashes requirements.lock
```

Python 3.12+ and uv. Native Python Office libraries, pypdf/PDFium and ReportLab. LibreOffice is optional. Bind `PYTHON_EXECUTABLE` to that environment's absolute `bin/python` path.
Keep environments outside `packs_dir`: Soot snapshots pack source; virtualenv
certificates, large native libraries and runtime caches are not pack source.
Direct and transitive client dependencies are pinned with hashes in
`requirements.lock`; installation never executes a setup script.

Select only the capabilities you need in your Soot definition:

```json
{
  "use": [
    "office/read",
    "office/write",
    "office/render",
    "office/convert"
  ]
}
```

The example lists available capabilities, not a recommended blanket grant.
The default recipe is read/plan-only or empty; mutation capabilities are explicit.
Then run `soot check --show --secrets`. Provider/model settings remain host-owned.
To author JSON specs, separately select `toolbox/write` and `toolbox/read` if
needed; there is no implicit dependency or grant.

All files are relative to a host-bound absolute `FILE_ROOT`. Each output must
be new, and its parent must already exist. Traversal, hidden paths and symlinks
are rejected. New artifacts are privately staged and atomically published with
SHA-256/byte receipts. This is path validation, not an OS sandbox. The tool uses
the public `soot/v1` stdin envelope and fixed argv; no model-controlled shell.
Dependency setup is an operator action; `soot add` and tools never install it.

See each [skill](skills/) for workflow, limitations and operation semantics.
PowerPoint inspection includes text inside grouped shapes. Table previews are
bounded to 30 rows × 20 columns and 500 characters per cell; inspect
`table_dimensions` for original dimensions and truncation. Word table creation
rejects invalid/non-finite or overlong cells instead of silently dropping text.
Operation IDs: `office_inspect`, `office_compose`, `office_edit`, `office_pdf_modify`, `office_render`, `office_convert`.

Bindings use `secret_env` references and host credentials scoped to operation IDs.
A complete consumer example is in the repository
[`examples/media-workspace`](../../examples/media-workspace/); it is not inside the pack.
Use placeholder files only in Git. Credentials and endpoint URLs are never model inputs.


## Host binding

`FILE_ROOT` is an existing absolute workspace path. Optional `OFFICE_BINDING`
JSON contains `{"libreoffice":"/absolute/path/to/soffice"}`. Every secret must
be scoped to the operations actually selected. Native tools need no network.

See [SPEC.md](SPEC.md) for supported file and edit contracts. No binary legacy
Office, macros, arbitrary native charts, tracked-change automation or secure PDF
redaction is promised. Layout-sensitive work requires a renderer and visual QA.
