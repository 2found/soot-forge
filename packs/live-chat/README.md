# Live-chat Pack

Opt-in communication guidance for customer conversations. Select
`live-chat/conversation` in a Soot definition and instruct the Soot to read
`live-chat` before responding. The pack provides one skill, no executable tools,
ingress, identity, policy, credentials or permissions.

The host owns interactive/autonomous policy, durable acknowledgements, member
handoff, blocked reports, private projection and publication fences. Use the
[SDK live-chat module](https://github.com/2found/2agent/tree/main/contrib/sdk/typescript) for channel delivery and
[Nest supervision](../../CONTRIBUTING.md) for members.
Installing this pack alone does not enable any of those capabilities.

## Canonical Live-Chat Browser Widget

The live-chat pack contains the canonical standalone static browser widget under `widget/`:

- `loader.js`: Asynchronous embed script for the host website. Loads the sandboxed iframe, dynamically imports the browser SDK, manages Turnstile challenges, and establishes parent-frame RPC communication.
- `frame.html`: Clean, accessible iframe skeleton providing chat launcher, dialog headers, conversation options, transcript area, error alert bar, auto-growing composer, and accessibility compliance.
- `frame.js`: Widget presentation logic executing inside the iframe. Communicates exclusively via validated `postMessage` RPC with the parent embedding origin. No bearer tokens or credentials ever enter the iframe or its URL parameters.
- `widget.css`: Sandboxed styles for desktop and full-screen mobile viewports, including safe-area insets and touch targets.
- `theme.css`: Shared light/dark theme CSS variables aligned with Soot design tokens.
- `browser.js`: Browser SDK ES module bundle.

### Website Embedding

Place the following script tag on your public website:

```html
<script
  src="https://<soot-api-origin>/public/widget/loader.js"
  data-app="spk_live_your_app_key_here"
  async>
</script>
```

Host websites can programmatically control the widget via `window.SootChat[appKey]`:
- `window.SootChat[appKey].open()`: Open the chat dialog.
- `window.SootChat[appKey].close()`: Collapse the chat dialog into the floating launcher.
- `window.SootChat[appKey].reset()`: Open the reset confirmation; confirmed reset stops active runs and revokes the visitor session before clearing local state.
- `window.SootChat[appKey].retry()`: Reconnect and reconcile receipts. The widget's Resend button submits unresolved work using its already-persisted request ID.

The browser SDK source belongs to Soot's `contrib/sdk/typescript/src/browser.ts`; do not hand-edit the compiled `browser.js`. Build the SDK, then synchronize these canonical assets into Soot with `node scripts/sync-public-widget.mjs --source ../soot-forge/packs/live-chat/widget`. Soot serves the iframe at `/public/widget/frame/{appKey}?parent={exactOrigin}`; there is no `frame.html` route or Node gateway.

Loading appearance or opening a fresh widget does not create a visitor session.
The first explicit Send obtains any required proof and creates the session;
saved visitors reconcile their existing receipts. History polling runs only
while the chat is open and the page is visible. Changing the page language
updates the same widget without replacing its identity or unresolved work.
Read failures offer Reconnect and preserve editable drafts. An expired session
offers an explicit new-conversation confirmation before any state is cleared.
Only a foreground submission result acknowledges its draft; a delayed read
cannot clear a message still being sent.

### Shared agent UI

The widget uses the released `@tofound/ui@0.5.0` AgentComposer as a controlled React island, plus the shared agent styles and transcript behavior. The frame still owns draft acknowledgements, validation and retry receipts. Double Escape clears only editable text; pending requests stay locked. `@` filters a bounded set of files linked in the visitor's delivered messages. Anonymous visitors receive no private skill catalog. `widget/ui-manifest.json` records the imported
package version and SHA-256 hashes, including the composer bundle; never edit generated `widget-composer.js`, `agent.css` or
`agent-behavior.js` in place. From the Forge root, refresh explicitly:

```sh
(cd packs/live-chat/widget-src && pnpm install --frozen-lockfile && pnpm build)
node scripts/sync-widget-ui.mjs --package /absolute/path/to/installed/@tofound/ui
node --test scripts/widget-assets.test.mjs
node --test scripts/widget-loader.test.mjs scripts/widget-state.test.mjs
node scripts/widget-preview.mjs
```

Open <http://127.0.0.1:1439> for the real widget with a synthetic parent RPC.
Check draft-only suggestions, failed send/retry (same request ID), new-message
scrolling, compact layout and English/Vietnamese labels. This fixture does not
prove a live runtime/loader connection. Runtime embedding imports these assets
through Soot's explicit `sync-public-widget.mjs`; no sibling checkout is needed
by a distributed widget or runtime.
