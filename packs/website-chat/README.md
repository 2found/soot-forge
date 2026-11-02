# Website chat

Configures the Live chat on the owner's websites from chat; the pack's own
settings page (**Cài đặt → Live chat**, `page/`, a soot-pages bundle on the
same two tools) edits the same gateway records. Tools: `website_view` (read) and
`website_action` (write), plus the `website-chat` skill. Select the pack for an
owner configurator Soot only; it is not part of Nest's general template.

`needs.credentials` asks the operator for `NO_CODE_URL` (the complete
`/admin/control` endpoint URL) and that owner's `NO_CODE_TOKEN`, entered per Soot
in Nest or bound from the host through the deployment `credentials` configuration
described in [pack authoring](../../CONTRIBUTING.md). The credential's tenant,
actor and role are selected by the gateway host, never by tool input.

Deploy the host-owned Live chat gateway and a trusted-backend runtime binding.
In Nest select the configurator, create a website, enter its HTTPS origins,
save and publish, then copy the embed snippet. From chat ask that same
configurator: “Đổi tên Live chat thành Mây Store và phát hành.” The skill reads
the latest revision and uses CAS; Nest keeps a dirty draft when chat changes the
configuration at the same time. Google Sheets export is the optional
[live-chat-sheets](../live-chat-sheets/README.md) pack.

The tools use the bundled `sdk/` public wire codec; there is no private npm or
sibling dependency. The control client permits only the configured HTTPS
endpoint (or explicit local HTTP), refuses redirects, bounds replies to 60 KiB
and applies one 12-second deadline to headers and body. A write with a lost or
invalid reply, or HTTP 5xx/408, exits 2 (unknown effect); inspect the stable
request ID before retrying. Vendor error bodies are not exposed, and a read
operation cannot dispatch a mutation. `tools/gateway.mjs` is a copy of
`scripts/support/owner_gateway.mjs` (`node scripts/sync-owner-support.mjs`).

Tests: `node --test tests/*.test.mjs` and `node --test page/tests/page.test.mjs`
(rebuild `page/app.js` from `page/src/` with `node page/tests/build.mjs`). The
page edits name, greeting, quick replies, allowed origins, theme, position and
the answering Soot; logo and Sheets settings are kept as they are and changed
from chat.

## Browser mode widget (`widget/`)

A product can host the chat itself on a `web` channel binding (channel-adapter
§11.17), instead of the host's `/public/widget` app-key widget. Serve this
folder from the product's own origin and embed:

```html
<script src="/soot/web-chat.js" async
  data-host="https://soot.example.com" data-binding="lohi-web"
  data-assertion-url="/api/soot/assertion"
  data-config='{"name":"Hỗ trợ","greeting":"Chào bạn!","position":"right"}'></script>
```

- `web-chat.js` frames `frame.html` beside it and runs `web-session.js`, which
  is the session the shared frame expects, over the SDK's `BrowserChannel`
  (`channel-browser.js`, vendored `@tofound/soot-sdk@0.6.0` `./channel/browser`).
- The frame files (`frame.js`, the composer, CSS) are byte copies of
  `live-chat/widget/`, so guests see the same UI on both widgets. `frame.html`
  is the same file with relative asset paths.
- **No secret enters the page.** A signed-in visitor is proven by a
  short-lived EdDSA assertion that the product backend signs, at
  `data-assertion-url`: same-origin `POST` with cookies, returning
  `{assertion}`; a 204 or 401 reply means anonymous. Anonymous visitors keep
  their conversation through the host's visitor key in `localStorage`.
- Appearance comes from `data-config`, never from the Soot host.
- **What the browser keeps:** the transcript it showed (last 200 lines), the
  draft and an unconfirmed send. The send is saved with its request id before
  the POST, and Resend reuses that id, so the host answers it once.
- **Known differences from the old widget:**
  - Question cards are not served in browser mode; an answer gets a `busy` reply.
  - An admitted message whose reply was lost settles on the visitor's Resend
    (the host replies `duplicate`), not silently on reload.

Refresh the copies with `node scripts/sync-web-chat.mjs` (add `--package
<sdk dir>` to re-vendor the SDK; then update the sha256 pinned in
`scripts/widget-assets.test.mjs`). `tests/widget-parity.test.mjs` replays one
guest fixture through the old session and this one and asserts the frame is
shown the same thing.
