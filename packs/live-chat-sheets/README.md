# Live chat Sheets pack

Reusable Google Sheets sink for public Live chat transcripts. Optional integration for [Nest no code](../nest-no-code/README.md). Installing it does not start a worker or grant Google access. The host selects `live-chat-sheets/sync` for an owner configurator, installs the Node dependencies, then explicitly adds a tenant-scoped binding to the host-owned gateway. The adapter owns ingress, OAuth, vault and durable export queue; Soot retains canonical conversation history.

For an existing local installation, update the pack recipe path, select `live-chat-sheets/sync`, and explicitly rebind credentials to the renamed operations. The adapter's Sheets binding IDs, control actions and stored export data keep their existing names.

`tools/client.mjs` is the fixed-endpoint Google Sheets client used by the adapter. `tools/control.mjs` is a scoped executable SDK tool; bind `NO_CODE_URL` (the complete `/admin/control` endpoint URL) and `NO_CODE_TOKEN` to each granted operation through host credentials. No model-supplied URLs or Google secrets are accepted.

Run `pnpm install --frozen-lockfile && pnpm test` here. No real Google call is made by the tests. A live credentialed write/read/permission-revocation check is a separate release gate.

OAuth currently uses `https://www.googleapis.com/auth/spreadsheets` for a pasted existing file. This permits Sheets access across the consented account. A `drive.file` + Picker flow would narrow file access but is not implemented; do not advertise that boundary. Google documents [scope behavior](https://developers.google.com/workspace/sheets/api/scopes). Service-account deployments can narrow access by sharing only the intended file.

Owner tools use the bundled `sdk/` public wire codec; there is no private npm or sibling dependency. Installing never grants owner access or starts the gateway/export worker.

The standalone Live chat gateway formerly under Soot contrib has been removed. This pack does not bundle a gateway; the host must provide one implementing its control protocol.
