# Work with Google Sheets

Use `google-workspace_sheets_info` to discover actual tab names/grid metadata.
Read explicit ranges with `sheets_read`: `'Chi phí'!A1:C20`, never whole columns,
unbounded tabs or arbitrary URL input. The maximum is 2000 cells per call.
FORMULA is the default; formatted display and unformatted values are explicit
choices. A returned FORMULA snapshot can be used for an exact rectangle update.

Create a spreadsheet with title, optional unique named tabs and stable action_id.
For updates, author the value JSON spec through separately selected workspace
file tools. Rows must fill the requested rectangle. Empty text clears a cell;
null is rejected because Google treats it as skipped input. RAW preserves text
such as `=SUM(...)` literally. USER_ENTERED explicitly permits normal formulas
and locale interpretation; external-data formulas are outside this tool.

An update requires the snapshot from a current FORMULA read of exactly the same
range. The preflight protects against changes already visible at read time but
is not atomic: Google Sheets does not expose the Docs requiredRevisionId guard
through this endpoint. Re-read the result. Do not claim a concurrent editor was
locked out. For collaboration needing strict serialization, use host coordination.

Append uses Google's logical table detection and INSERT_ROWS. Read the reported
updatedRange; it can be beyond the search rectangle. Keep the search rectangle
covering the intended table and adjust it as the table grows. No invented row
number or duplicate replay. Persisted pending/unknown action receipts block
automatic retries after timeout, Stop or restart. Inspect the real sheet before
submitting a new action ID. Apps Script, permissions and arbitrary batch requests
are not implied. Use selected Drive export to obtain XLSX/PDF/CSV.
