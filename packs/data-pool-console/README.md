# Data pool console

The human interface for the [data-pool](../data-pool/README.md) pack: Nest's **Data**
area (`interface.tool_area`, kind `data-pool`, access `operator`). Two tools,
`view` (read) and `action` (write), forward to the data-pool service through the
`soot tool-forward` form; no binary is built or shipped here.

Select it only for a conversational Soot that is a namespace manager in the host
binding. It needs the operator's `DATA_POOL_UI` credential (`needs.credentials`),
a token distinct from the Soot's agent token and scoped to
`data-pool-console_view` and `data-pool-console_action`; see
[the shared service](../data-pool/docs/shared-service.md) and the
[interface contract](docs/nest-interface.md). Installing the pack grants nothing
and opens no database.
