# Soot browser adapter

Standalone executable implementation for the configuration-only browser-use pack.
Requires Node.js 24+. From the browser-use pack directory, install with `npm install -g --install-links ./adapter`.
The adapter pins agent-browser and CloakBrowser as its own dependencies. Run `npm test` for isolation and
command-boundary checks (for source development, first run `npm ci --ignore-scripts` in `adapter/`). No adapter code is imported into the Soot binary.

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


The `npm-shrinkwrap.json` pins transitive dependencies for the global install.
Do not install dependencies into a configuration snapshot. The host must resolve
`soot-browser` and Node 24+ on PATH; each call invokes the pinned native
agent-browser binary directly when available, with its official wrapper as a
platform fallback. Chromium and its daemon persist across calls. Verified launch
settings are cached per conversation and invalidated by package changes, missing
executables, or host CloakBrowser overrides.

Human input is ordered and guarded by the intended active tab. A matching
WebSocket Pong after input confirms that the peer read those messages; it does
not prove a website's business action succeeded. The small `ws` dependency is
loaded only for this path, with compression disabled and bounded payloads. A
missing Pong/disconnect after send is uncertain and is never retried. Always
inspect the page after a failed or uncertain mutation.

Desktop queues at most 64 pending inputs, coalesces adjacent unsent text/wheel
input, and preserves clicks/keys/tab changes as ordering barriers. The browser
stream supports host-mediated ACK pacing; see the Soot interface contract.
