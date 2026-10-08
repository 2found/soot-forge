# Soot browser adapter

Standalone executable implementation for the configuration-only browser-use pack.
Requires Node.js 24+. Install with `npm install -g ./contrib/adapters/browser-use`.
The adapter pins agent-browser and CloakBrowser as its own dependencies. Run `npm test` for isolation and
command-boundary checks. No adapter code is imported into the Soot binary.

`soot-browser control|view` consumes the soot/v1 envelope on stdin, emits JSON,
and derives session identity only from host conversation context plus pack cwd.
The pack launches it with fixed argv. Model arguments never become shell text.
The adapter serializes agent commands per conversation. The authenticated host
sets `interaction: true` only for human interface calls; mouse/keyboard input
then uses the live WebSocket input channel, independently of agent waits.

`view` probes the private stream descriptor without acquiring the command lock
or launching a browser. Its host-only `stream_url` is numeric loopback. The
HTTP API removes it from public responses and proxies the read-only stream.
`resource.state` reports active, unavailable, or explicitly closed. Profiles,
stream descriptors and locks live under the installed pack's `.browser/`.

