# soot-channel

`soot-channel <telegram|discord>` — the chat adapter for `channel-adapter.v1`.
Started only by the Soot runtime's supervisor; never by a pack install, a
model or a request. Plain ES modules, no dependencies, Node.js 22+ or Bun
(`bun build --compile cli.mjs` makes one executable). No Soot code is imported.

## Environment (exactly contract §2)

| Variable | Use |
|---|---|
| `SOOT_CHANNEL_CONTRACT` | Must be `channel-adapter.v1`, else exit 78. |
| `SOOT_CHANNEL_API` | Runtime's loopback base URL; every call is `/v1/channel/*`. |
| `SOOT_CHANNEL_TOKEN` | Per-process `sca_` credential (Bearer). |
| `SOOT_CHANNEL_BINDING`, `SOOT_CHANNEL_PLATFORM` | Binding id; platform must equal argv. |
| `SOOT_CHANNEL_PLATFORM_TOKEN` | Bot token, sent only to the platform API. |
| `SOOT_CHANNEL_STATE_DIR` | Journal directory (0700). |

Neither token is ever logged, journaled or echoed. Logs on stderr are JSON
lines with codes and ids, never message text.

## Exit codes

- `0` — stopped (`SIGTERM`: finishes the in-flight call and ack, ≤ 10 s), the
  credential is dead (`401`), or another process holds the stream (`stream_taken`).
- `78` — configuration it cannot fix: unsupported contract, missing env, or the
  platform rejected the bot token (Telegram `getMe` 401, Discord 401 or Gateway
  close 4004/4010–4014 incl. 4014 "Message Content intent off"). Status
  `platform_token_invalid` is sent first.
- anything else — a crash; the supervisor restarts it with backoff.

## Guarantees (contract §6)

- **Inbound dedup.** `request_id` comes only from platform ids
  (`tg:<bot>:u:<update_id>`, `tg:<bot>:cb:<callback id>`,
  `dc:<app>:m:<message id>`, `dc:<app>:i:<interaction id>`). It is journaled
  after the host's final answer; the Telegram offset moves only after that.
- **Outbound dedup.** `receipt_id → platform message ids` is journaled right
  after the platform call and before the ack; a journaled receipt is acked from
  the journal, never posted again. The stream resumes with `Last-Event-ID` = the
  last seq whose ack the host accepted.
- **Per chat order**, acks batched (≤ 100), 45 s silence → reconnect, backoff
  1 s → 60 s on host and platform errors.
- **No content outside the pipe.** Unaddressed group/guild messages never reach
  the host. Pairing codes are claimed only in a DM (Telegram `/start <code>` too);
  in a group the person is told to use the DM. Suspected secrets (shared detector)
  are deleted where the platform allows (Telegram; not a Discord DM) and warned
  about, never sent. Files, stickers and voice are refused politely.
- **Rendering.** The Soot's Markdown subset becomes Telegram HTML or Discord
  markdown; everything else is escaped and Discord sends no pings. `nest://`
  links show the host's label (linked when it has a Nest web URL). Messages are
  never split: over 4096 / 2000 characters they are cut at a paragraph or
  sentence with the host's "còn tiếp" sentence and the Nest link. Choices become
  buttons (token → callback, url → link) or plain lines; a settled item's
  messages are edited (buttons removed) or the text re-posted.

## Tests

```sh
npm test    # node --test test/*.test.mjs
```

A fake runtime replays the contract fixtures (copied in `test/fixtures/`, see
[its note](test/fixtures/CONTRACT.md)); fake Telegram and Discord servers
(REST plus a minimal Gateway WebSocket) stand in for the platforms. No real bot
is needed.
