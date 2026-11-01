# Data pool console

The human interface for the [data-pool](../data-pool/README.md) pack: the
**Kho tài liệu** page (en: *Library*) in Nest's Data area. The manifest
declares it in `interface.pages` (id `kho-tai-lieu`, placement `data`, access
`operator`, bundle `page/`). Two tools, `view` (read, page view tool) and
`action` (write, page action tool), forward to the data-pool service through the
`soot tool-forward` form; no binary is built or shipped here.

**Requires a Soot with pack pages (pages-storage, Forge 0.10.0).** An older Soot
refuses this manifest as unknown fields (`label`, `keywords`, `interface.pages`).
Update Soot first, or stay on Forge 0.9.x, whose console used a tool area.

Select it only for a conversational Soot that is a namespace manager in the host
binding. It needs the operator's `DATA_POOL_UI` credential (`needs.credentials`),
a token distinct from the Soot's agent token and scoped to
`data-pool-console_view` and `data-pool-console_action`; see
[the shared service](../data-pool/docs/shared-service.md) and the
[interface contract](docs/nest-interface.md). Installing the pack grants nothing
and opens no database.

## The page

`page/` is a static bundle: `index.html`, `app.css` and one classic script
`app.js`, built from the ES modules in `page/src/` by `page/tests/build.mjs`
(no dependencies, deterministic; the tests fail when `app.js` is stale). Nest
frames it with `sandbox="allow-scripts"` under `connect-src 'none'`, so the page
never fetches: every read and write is a soot-pages bridge v1 `call`, and its
body is the data-pool `{kind, input}` body in [the contract](docs/nest-interface.md).

- Collections: list, open, create, delete (inline confirm).
- Documents: paged list, fuzzy search, add text, import a public URL, read in
  chunks, edit, delete. Every edit and delete carries the `generation` and
  `expected_revision` the person read.
- Conflict: the draft stays. View the latest, copy your version, or save over
  the latest.
- Lost answer: the page says the outcome is unknown, then resends the same
  `request_id` (the service answers with the earlier receipt, so nothing is
  saved twice) or checks it with `view` kind `status`.
- Read access: shown read-only. Changes go through the Soot's Quyền hạn page;
  a page grants nothing.
- Activity: bounded and paged.
- Recovery: only `{request_id, kind, action, pool, at}` goes to
  `sessionStorage`, never document content. Inside Nest's opaque-origin frame,
  storage is unavailable; the page then says so and asks the person not to
  reload until the request is checked.

Develop and check it locally (never against a live host):

```sh
node page/tests/build.mjs            # rebuild app.js after editing src/
node --test page/tests/page.test.mjs
node page/tests/serve.mjs 8765       # fake Nest + in-memory pool at /host/host.html
```

`page/tests/` is not shipped: release archives leave out `tests/` folders and `*.test.mjs`.
