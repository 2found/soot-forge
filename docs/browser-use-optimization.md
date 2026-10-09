# Browser-use: agent-first optimization

Implemented the input/adapter and viewer-stream recommendations from
[browser-use-orca-recon.md](browser-use-orca-recon.md). Browser automation remains
an optional pack. Tauri, CloakBrowser and agent-browser remain in place; agent
work does not require an open viewer. No Orca code was copied.

## Changes

- The host invokes the installed `soot-browser` executable directly, removing
  `npx` from every tool call. The adapter resolves its pinned native agent-browser
  executable, with the upstream JS wrapper as a platform fallback.
- Warm commands reuse the conversation daemon. A stream-status probe replaces
  the extra global session listing. Validated launch settings are cached, so a
  snapshot no longer imports the CloakBrowser/Playwright launch stack every time.
  Package changes, missing executables and host overrides invalidate/bypass it.
- Human input remains on the existing host authorization/effect-receipt path.
  Its queue is bounded at 64 requests; only adjacent unsent text/wheel input is
  merged. Clicks, keys and tab changes preserve ordering. Failed effects and
  pending input are never automatically replayed. An intended tab mismatch fails
  before dispatch. This guard is a preflight check, not an atomic upstream tab lock.
- Human WebSocket input uses a matching Pong after the sent messages, rather than
  an arbitrary delay or upstream's incomplete close handshake. This confirms
  transport receipt, **not website success**. Unicode text is split at code-point
  boundaries because CDP rejects long `char` payloads. `ws` 8.22.0 adds about
  151 KB unpacked, loads only for human input, and uses no compression/native
  addon. [Upstream ping/pong API](https://github.com/websockets/ws/blob/master/doc/ws.md).
- Viewer streams request `pacing=ack`, capped at 15 FPS. The host forwards only
  typed ACKs from the viewer's authenticated owner. Desktop ACKs after decoding
  and committing the image; one decode and one latest pending image bound work
  for older push streams. Hidden panels/documents disconnect the viewer while
  the browser remains alive. The existing 25-second authorization lease remains.
- Configuration snapshots exclude installed `node_modules` and `.browser`
  profiles. The live test found a 162 MB generation that could not be reopened
  when dependencies were captured. Authored source and lockfiles remain pinned
  and source edits still invalidate the fingerprint.

The browser daemon is persistent. Human assistance still uses one short-lived
adapter process/WebSocket per coalesced batch; no additional broker is introduced.
Frames remain base64/SSE through Rust IPC. Native webview embedding, binary video,
30–60 FPS targets, and a new browser engine are outside this change.

## Measurement

[Raw samples](browser-use-agent-benchmark.json): macOS arm64, Node 24.21.0,
20 warm DOM snapshots per mode after two warmups, alternating before/after order,
same local page and pinned Chromium, independent conversation profiles.

| Adapter invocation | Median | p95 |
| --- | ---: | ---: |
| Before: npx + JS CLI wrapper + repeated launch import/probe | 647.2 ms | 695.4 ms |
| After: direct Node entry + native CLI + launch cache | 61.9 ms | 65.7 ms |

About **10.5× faster** in this measured warm adapter path. This excludes model
latency, Soot HTTP/journal work and viewer paint; it is not an end-to-end speedup
claim. The installed executable's shebang enters the same Node adapter. Cold
Chromium downloads and first launch are not covered by these numbers.

Reproduce with `scripts/benchmark-browser-agent.mjs BASELINE_ADAPTER CURRENT_ADAPTER REPORT`,
using Node 24 and preinstalled pinned dependencies. Baseline is Forge commit
`6924617cf746aee6a424e872812fb1bb1f397705`; adapter hashes are in the report.

## Verification

- Adapter: 15 tests, including the real soot/v1 executable over a fixture
  WebSocket, Unicode, wrong tab/no dispatch, disconnect/uncertain/no retry,
  bounded state, cached executable invalidation and native-wrapper fallback.
- Desktop: 10 Node tests including slow decode/latest-frame behavior,
  disconnect/navigation invalidation, input ordering/coalescing, queue overflow
  and failed-send handling. UI check, TypeScript and production Vite build pass
  on the isolated browser change.
- Soot: full `go test -race ./...`, `go vet ./...`, macOS build and Linux/amd64
  cross-build pass. ACK integration exercises actual HTTP auth and WebSockets:
  invalid/foreign/expired viewer, invalid/future sequence, duplicates and cleanup.
- Native Rust: 24 tests, including scoped ACK credentials/body and interface
  actions. Native custom-protocol build embeds the production frontend.
- Forge: 19 root tests; all 25 catalog entries, including the pinned remote
  entry, validate and install with the real Soot binary.
- `scripts/live-browser.mjs`: real installed archive + operator dependency
  prefix + Soot + Devin `swe-2` + Chromium. The provider opens the fixture,
  snapshots refs, fills Vietnamese text, submits, and verifies the result.
  Independent assertions check the actual submitted value, animated stream
  backpressure before/after ACK, stale-tab rejection and Unicode input in DOM.

Soot verification uses an isolated checkout of
`b135f4f4624fe41eb521166c5c914d6f30ba5942` plus these changes. The shared working
checkout contains concurrent memory/settings/UI changes; its later frontend
build fails on unrelated `@tofound/ui` agent-component exports. Those changes
were not reverted or treated as passing.

Native Tauri/WebKit was exercised through Orca computer-use against the same
local Soot/provider fixture. The final build renders the actual browser, forwards
a physical key exactly once (independently read back from Chromium DOM), and
reconnects after hiding/showing the browser tab. Native checks
caught and fixed both incomplete WebSocket close handshakes and duplicate
keydown/input forwarding. `keydown` handles control keys; the textarea's `input`
path owns printable text/paste, with composition committed once at its end.

Local evidence: `/tmp/soot-browser-final/` (provider summary, native DOM/scroll
assertions, screenshots). The final native frontend was rebuilt from the isolated
Soot base plus the browser changes because concurrent agent-UI work broke the
shared checkout's TypeScript build. The human WebSocket wheel path moved Chromium
by 200 pixels, but Orca’s
synthetic native wheel produced no page scroll, so native trackpad/wheel remains
unverified. Real Google OAuth, OS IME composition, drag/selection and
cross-platform desktop behavior remain unverified; they are
not inferred from this fixture.

## Installation

On the Soot host, from the installed browser-use pack:

```sh
npm install -g --install-links ./adapter
```

Node 24+ and the chosen npm prefix's executable directory must be on the host
PATH. `npm-shrinkwrap.json` pins transitive dependencies for the copied global
install. This is an explicit operator step; pack installation executes nothing.
Do not install dependencies inside an immutable configuration generation.
Existing installations must reinstall the adapter when updating this pack.
