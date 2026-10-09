# Google Workspace

Work with Google Docs, Sheets and Drive through scoped, bounded REST tools.

```sh
soot add https://github.com/2found/soot-forge/tree/main/packs/google-workspace
# From the installed pack directory, explicitly prepare the selected tools:
uv venv --python 3.12 /absolute/host-runtimes/google-workspace
uv pip sync --python /absolute/host-runtimes/google-workspace/bin/python --require-hashes requirements.lock
```

Python 3.12+ and uv. Google auth is the only SDK; Docs/Sheets/Drive use bounded REST. Bind `PYTHON_EXECUTABLE` to that environment's absolute `bin/python` path.
Keep environments outside `packs_dir`: Soot snapshots pack source; virtualenv
certificates, large native libraries and runtime caches are not pack source.
Direct and transitive client dependencies are pinned with hashes in
`requirements.lock`; installation never executes a setup script.

Select only the capabilities you need in your Soot definition:

```json
{"use":["google-workspace/docs-read","google-workspace/sheets-read","google-workspace/drive-read"]}
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
Capabilities: `docs-read`, `docs-write`, `docs-export`, `sheets-read`,
`sheets-write`, `drive-read`, `drive-download`, `drive-write`. Default selection
is empty. The manifest lists each typed operation and its exact binding scope.

Bindings use `secret_env` references and host credentials scoped to operation IDs.
A complete consumer example is in the repository
[`examples/media-workspace`](../../examples/media-workspace/); it is not inside the pack.
Use placeholder files only in Git. Credentials and endpoint URLs are never model inputs.


## Google credentials

Bind `GOOGLE_WORKSPACE_BINDING` to host-only JSON with an expiring access token, OAuth
refresh credential or a standard service account. See [SPEC.md](SPEC.md) for
exact shapes, scopes and tabbed request examples. Credentials must be operation
scoped; they are never stored in pack/config examples. OAuth consent and file
sharing happen through the host/operator, not a tool's surprise login flow.

Docs uses `documents` and `drive.file` scopes. Sheets/Drive refreshes request
only `drive.file`; they do not request full Drive or all-spreadsheets scope. Service accounts can read documents
shared with them, not arbitrary users' Drive. Export limit is 10 MiB. Docs writes use
requiredRevisionId; all mutations use private durable receipts. A pending receipt is a blocker
for automatic retry, including after Stop/restart. Sheets updates and Drive renames/moves check a preflight snapshot/version;
these APIs have no Docs-style revision guard here, so that check is non-atomic.
No sharing, trash/delete, mail or calendar tool.

REST endpoints are fixed Docs, Sheets and Drive origins; model-authored URLs are not accepted. There is no browser consent
automation, arbitrary HTTP URL or hidden credential discovery. Moving/uploading
into a folder can inherit its existing permissions; no permission API is called.

## Docs, Sheets and Drive

- Docs: tab-aware reads, creation, guarded text/style/table edits, PDF/DOCX/TXT export.
- Sheets: tab metadata, bounded A1 cell/formula reads, creation with named tabs,
  exact-rectangle updates and append rows. Default RAW writes preserve literal
  strings. USER_ENTERED is an explicit choice for formulas/locale interpretation.
- Drive: paginated files/folders, metadata, binary download up to 64 MiB,
  Docs/Sheets/Slides export up to 10 MiB, new-file multipart upload up to 5 MiB,
  folder creation and version-preflight rename/move.

Live Google account access has not been verified without host credentials.
Transport/regression tests are not a claim of live vendor success.

## Rename from google-doc

This replaces the unreleased `google-doc` source folder/catalog identity.
Install `google-workspace` separately; existing installed packs are not renamed
or overwritten. Update host definitions explicitly:

- `google-doc/read|write|export` → `google-workspace/docs-read|docs-write|docs-export`.
- Tools now have `google-workspace_docs_*` IDs; Sheets/Drive have their own IDs.
- Bind `GOOGLE_WORKSPACE_BINDING` and the renamed operation scopes.
- Receipts now use `google-workspace-receipts`; reconcile any outstanding old
  action before issuing a new one. The rename is not permission to resend it.

The historical media verification record retains its old identity/hashes.
