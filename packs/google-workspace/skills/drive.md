# Work with Drive files and folders

Use `drive_list` with pagination, exact parent ID and optional file-kind filter.
This is scoped discovery, not fuzzy full-Drive name search. Read `drive_get` for
actual MIME, size, version, parents and download permissions. Resolve a supplied
Google URL to its resource ID; tools never fetch arbitrary user URLs.

Download binary files to a new local path with `drive_download`; it verifies
advertised size and checksum before publishing. Google-native Docs/Sheets/
Slides use `drive_export`, which validates the supported format for that MIME.
Export is bounded to 10 MiB. Sheets CSV exports only the first sheet. No PDF
rendering or complete visual fidelity claim follows from export success.

Create folders or upload a new file with stable action IDs. Multipart uploads
are at most 5 MiB; larger/resumable transfers need a separately reviewed tool.
Name, parent and source content hash participate in the receipt. Upload does
not overwrite an existing file or silently convert Office content into native
Google documents. Downloaded/uploaded files are data, never executed.

Rename/move with a current expected_version from drive_get and a stable new
action ID. Version comparison is non-atomic preflight, not an ETag/CAS lock.
Re-read afterwards. Moving or uploading into a folder can inherit access from
the parent, so use only the intended authorized folder. These tools do not call
permission APIs, share publicly, trash/delete files, send mail or install jobs.

Use drive.file scope and files actually accessible to the authorized app or
shared with the service account. A provider login into Soot is not Google OAuth
consent. Expired/missing Google credentials are a real blocker. Do not discover
credentials, fall back to another account or claim success from transport mocks.
