# Browser use

A configuration and skill pack. It selects the standalone `soot-browser`
adapter, which drives [agent-browser](https://github.com/vercel-labs/agent-browser)
with [CloakBrowser](https://github.com/CloakHQ/cloakbrowser).
The standalone adapter source is bundled in `adapter/`; it runs separately from Soot. No desktop UI lives in this pack.

The simplest install needs nothing but Soot: click **Cài trình duyệt** in
Nest's browser panel, or run `soot browser install` on the host that runs the
Soot. Either downloads a prebuilt single-file `soot-browser` and the pinned
`agent-browser` (about 30 MB, checksum-pinned by the runtime) into the Soot
home, then Chromium (about 140 MB). Neither the app nor the CLI carries them,
so nobody pays for a browser they never open.

Or install it yourself with Node.js 24+:

```sh
npm install -g --install-links ./adapter
```

A `soot-browser` on PATH wins over the downloaded one. Until either exists, a
browser tool answers that the browser is not installed and how to install it;
nothing else about the Soot changes.

`soot spawn` selects browser-use for the general Soot from the latest stable Forge release.
Nest selects both browser-use and soot-nest. Existing customized Soot definitions
are preserved; opt them in with `packs: ["browser-use", "soot-nest"]` alongside
their existing selections. In the deployment, authorize PATH and HOME for both
`browser-use_control` and `browser-use_view` under `operation_env`.

The manifest's `interface.tool_area` declares label, renderer, read/action tools,
width/min/max, aspect width/height and resizability. Nest owns rendering. Installing
the pack alone grants nothing: both executable capabilities must be selected.
The manifest invokes the installed `soot-browser` directly; no per-call `npx` lookup or download. `--install-links` copies the adapter and pinned dependencies into the operator’s global prefix, outside the pack/configuration snapshot. Keep that prefix on the Soot host’s PATH.

One profile per conversation ID under the installed pack's private `.browser/`
directory; deployment path namespaces the daemon name. Persistent cookies and
storage survive browser close; session cookies follow the site/browser lifetime. Live tabs survive sidebar close and conversation
switches. Sessions stay alive until explicitly closed; terminate the exact
`soot-<deployment hash>-<conversation ID>` session during operator cleanup.
Never use global close-all. Keep `.browser/` private and out of backups/archives
shared with others: profiles contain website credentials.

Desktop subscribes to agent-browser's live WebSocket screencast through Soot's
authenticated stream endpoint. It shows navigation, typing, popups and tab changes
as they happen. Users can open tabs and complete OAuth directly in the sidebar.
Human click/key/paste/scroll input uses the same browser's input channel and
remains available while the agent waits. A popup closing can end an agent wait;
inspect the surviving tab before continuing.

Browser use attaches a resource to the conversation before the action starts.
The resource list records last use and last verified availability. `stale` means
not checked for two minutes; `unavailable` means a probe/stream failed. Checking
never starts a browser. Explicit close ends the process and retains the profile.
Frames are transient; user actions have durable receipts and are never retried
automatically. The stream endpoint and profile path remain on the host.

Viewer delivery is ACK-paced at up to 15 FPS on current Soot/Nest: a decoded,
presented frame releases the next frame. Hidden panels stop viewing without
closing the browser. Agent work uses snapshots and refs and needs no viewer.
See [implementation and measured verification](../../docs/browser-use-optimization.md).
