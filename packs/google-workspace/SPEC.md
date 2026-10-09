# Google Workspace request specs

## Docs

A batch spec is `{"requests":[...]}`, at most 512 KiB and 100 requests. Supported
request bodies follow the official Google Docs REST shapes. The runner limits
request types, requires explicit tabs and precise style masks. Google's API
validates ranges, styles and indexes transactionally.

Read the document first. Reuse its actual document ID, tab ID and current
revision in `google-workspace_docs_batch_update`. These placeholders are not real IDs.

```json
{"requests":[
 {"insertText":{"endOfSegmentLocation":{"tabId":"TAB_ID"},"text":"Báo cáo tiếng Việt\n"}},
 {"replaceAllText":{"containsText":{"text":"{{name}}","matchCase":true},
   "replaceText":"Ngọc Anh","tabsCriteria":{"tabIds":["TAB_ID"]}}},
 {"updateParagraphStyle":{"range":{"tabId":"TAB_ID","startIndex":1,"endIndex":20},
   "paragraphStyle":{"namedStyleType":"HEADING_1"},"fields":"namedStyleType"}},
 {"updateTextStyle":{"range":{"tabId":"TAB_ID","startIndex":1,"endIndex":20},
   "textStyle":{"bold":true},"fields":"bold"}}
]}
```

Do not copy example numeric ranges blindly. Indexes are UTF-16 units; tab bodies
have independent index spaces. Insertions alter later indexes in the same batch,
so order dependent requests correctly or re-read between batches.

`requiredRevisionId` is supplied by the runner, not by model-authored JSON.
Mutation receipts are private files under `FILE_ROOT/google-workspace-receipts`.
The request hash and remote document ID support reconciliation; a pending
receipt is never permission to resend. Do not delete a pending receipt to force
a retry. Read the Google document and decide whether the intended change exists.

Auth types in the host-only `GOOGLE_WORKSPACE_BINDING` JSON:

Mutations also require stable `account_id` for receipt namespacing (for example
the authorized account's email or a host account UUID). Service accounts default
to their `client_email`. Tokens may rotate; account identity must stay stable.
Different accounts never reuse each other's action receipts under a shared root.

- `access_token`: `access_token` plus Unix `expires_at`; the host refreshes it.
- `oauth_refresh`: `client_id`, `client_secret`, `refresh_token`; Google auth
  performs refresh without logging tokens. The pack starts no OAuth consent flow.
- `service_account`: standard Google service-account JSON nested in
  `service_account`. Token URI must be Google's. The operator must share the
  document with the service account; this pack does not manage sharing.

Scopes are `documents` and `drive.file`, not full Drive. Access remains subject
to the actual token grants and Google's file permissions. No delegation, domain
impersonation, credential discovery or global service-account installation.

## Sheets

`sheets_info` takes spreadsheet_id. `sheets_read` takes spreadsheet_id and an
explicit A1 rectangle containing a tab, optionally render FORMULA (default),
FORMATTED_VALUE or UNFORMATTED_VALUE. Reads are bounded to 2000 cells. For
non-ASCII/punctuated tab names use quotes, e.g. `'Chi phí'!A1:B3`. Ranges such
as A:A, Sheet1 or named ranges are not supported. Trailing empty cells omitted
by Google are padded only for snapshot calculation, preserving actual values.

`sheets_create` takes title, optional 1..20 unique tabs and action_id.
Updates/appends take spreadsheet_id, range, local spec and action_id. An update
also requires expected_snapshot from a FORMULA read of the exact same range.

```json
{"input_option":"RAW","values":[["Hạng mục","VND"],["Máy chủ",1200000],["Âm thanh",450000]]}
```

For an exact update to `'Chi phí'!A1:B3`, provide exactly three rows/two columns.
For append the supplied rows/columns may be smaller than the bounded table
search rectangle. Cells are finite numbers, booleans or strings; use `""` to
clear. Null means skipped input in Google's API and is deliberately rejected.
RAW is the default. USER_ENTERED explicitly enables normal formulas and locale
interpretation, e.g. `{"values":[["=SUM(B2:B3)"]],"input_option":"USER_ENTERED"}`.
External-data formulas such as IMPORTXML/IMPORTRANGE/IMAGE/HYPERLINK are rejected.

The snapshot/version preflight is not a transaction or server revision guard.
A concurrent write after preflight remains possible. Re-read after mutation;
use host serialization when required. Append uses INSERT_ROWS and Google's
logical-table detection. Its returned updatedRange is the actual location.

## Drive

drive_list accepts limit 1..100, page_token, optional parent_id (`root` or exact
ID) and kind all/docs/sheets/slides/folders. It accepts no arbitrary Drive query
or name-search input. drive_get takes file_id. Metadata includes actual version,
parents, MIME and download capability.

drive_download takes file_id and new output, and supports binary files of
1 byte..64 MiB. drive_export takes file_id, format and new output. Supported:

| Google-native source | Export formats |
| --- | --- |
| Docs | pdf, docx, txt |
| Sheets | pdf, xlsx, csv (first sheet only) |
| Slides | pdf, pptx, txt |

Exports are bounded to 10 MiB. Office exports validate archive limits, required
document parts and CRCs before publication. Folder creation takes name, optional parent_id
and action_id. New upload takes local path, optional name/parent_id and action_id;
at most 5 MiB. Accepted input extensions: PDF, DOCX, XLSX, PPTX, TXT, MD, CSV,
PNG, JPG/JPEG, WAV and MP4. It uses multipart/related, derives MIME from the
extension, keeps exact bytes and does not convert or overwrite.

drive_update takes file_id, expected_version, action_id and name and/or parent_id.
It checks the current version before PATCH but has no atomic compare-and-set.
Moving replaces the current parent; folder permissions can be inherited.
Permission changes, trash/delete, shortcuts, shared-drive administration,
resumable uploads, Gmail, Calendar and native Slides editing are out of scope.

Sheets and Drive refreshes request only drive.file, an official supported Sheets
scope for app-accessible files; Docs refreshes also request documents. OAuth
tokens retain their actual operator-consented scopes. Configure Docs/Sheets/
Drive APIs and consent through the host; the pack performs no surprise setup.

All remote mutations use account-scoped `google-workspace-receipts`, stable
action IDs and complete-input hashes. Completed duplicates return receipts;
pending/unknown actions never replay. A failed preflight also requires a fresh
read/action ID. Renaming the old pack does not authorize replay of old actions.

Official contracts: [Sheets update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update),
[Sheets append](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[Drive export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export).
