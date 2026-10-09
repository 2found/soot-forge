# Revision-guarded Google Docs edits

Only use mutations for the user's authorized document work. `google-workspace_docs_create`
creates one document with title and stable `action_id`; it does not share it.
Keep the returned document ID. Read it again to obtain tab IDs and a revision.

`google-workspace_docs_batch_update` requires the **current** `revision_id`, document ID,
new stable `action_id` and a workspace JSON `spec:{requests:[...]}`. See
[examples](../SPEC.md). It uses `requiredRevisionId`, never an unconditional
write. Supported requests are insertText, replaceAllText, updateTextStyle,
updateParagraphStyle, insertTable, deleteContentRange, insertPageBreak,
createParagraphBullets and deleteParagraphBullets. Every request targets a
specific tab; replaceAllText needs `tabsCriteria.tabIds`. Styles need precise
field masks. More complex edits require a new reviewed tool, not arbitrary HTTP.

An action ID is bound to the complete request. A completed duplicate returns
its durable receipt without another POST. Pending/unknown actions never replay.
A timeout, interrupted run, invalid success response or 5xx can mean the write
already happened: inspect the document and receipt before any new action.
A revision conflict means re-read, compare changes and prepare a new reviewed
request, not remove writeControl or blindly repeat old indexes. The tool does
not share documents, email users, install schedules or read unrelated Drive files.
