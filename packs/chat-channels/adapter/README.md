# soot-channel

`soot-channel <telegram|discord>` — the chat adapter for `channel-adapter.v1`,
revision v1.2 (contract §10, `contract_revision: 2`). Version 0.3.0. Bundled inside Nest; a CLI-only
install puts the compiled binary on PATH.
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
  platform refused the bot's setup. Status `platform_token_invalid` is sent
  first, with its `reason` (§9.4): Telegram 401 / `getMe` 404 and Discord 401 /
  close 4004 → `platform_token_rejected`; close 4014 →
  `discord_intents_disallowed` (Message Content intent off); 4011 →
  `discord_sharding_required`; 4010/4012/4013 → `adapter_incompatible`.
  `detail` stays the low-level code (`discord_gateway_4014`, `telegram_getme_401`).
- anything else — a crash; the supervisor restarts it with backoff.

## Status

Every `StatusReport` carries `contract_revision: 2` (from the first
`connecting`). Retryable trouble is `degraded` with a `reason`:
`platform_unreachable` (network, 5xx), `platform_rate_limited` (429),
`telegram_webhook_active` / `telegram_poll_conflict` (`getUpdates` 409, retried
with backoff up to 5 min). A v1.0 host ignores both fields.

## Groups and guilds (v1.1, §9.2, §9.6)

- **Outbox lock.** Outside a DM the adapter posts only replies, notices,
  resolutions and an `attention` of kind `question`/`decision` that carries an
  `asker`; any other `attention` and every `brief` is acked `skipped` without
  posting (the host re-sends it to a DM). This is a refusal only: the buttons are
  always the item's own choices.
- **Threading.** `in_reply_to` threads every kind (Telegram `reply_parameters`,
  sent even if the target is gone; Discord `message_reference`, pinging only the
  replied user).
- **Answers.** A button press asks admission with `button: true`; a refused
  press shows the host's `toast` privately (Telegram `answerCallbackQuery`,
  Discord ephemeral response) and calls nothing else. A `not_asker` refusal from
  #10 is shown the same way; a typed reply's `reply` is posted threaded under the
  sender's message. Settled channel items are edited like DM ones.

## Places and the owner chat (v1.2, §10)

Every v1.2 behaviour is triggered by what the host sends, so a v1.1 host (no
`places` in its session) gets exactly the v1.1 adapter.

- **Anyone admitted talks.** `principal` and `place` on an admission are
  informational; the host re-checks every call. A `rate_limited` or
  `guest_budget` refusal's `notice` is posted, threaded, in a group too (the
  host sends it at most once per person per hour / place per UTC day); `blocked`
  is always silent, a blocked press gets an empty toast. `/new` outside a DM
  gets the host's `new_dm_only` reply, threaded.
- **Owner chat claim.** Outside a DM, a message matching the session's
  `places.claim_pattern` (`/owner ABCD-EFGH`, case-insensitive, after the bot
  mention is removed; Telegram `/owner@<bot>` too) is a command: it is claimed
  even when not addressed and never sent as a message. The host's `reply` is
  posted verbatim, threaded; a `429` is final, not retried.
- **Owner chat items.** The §9.6 lock is widened only for an `attention` with
  `place: "owner_chat"`: it is posted with its buttons as in a DM. Any other
  non-DM `attention` that is not an asker-bound question/decision is still acked
  `skipped`. A press refused with `not_authorized` shows the host's toast
  privately, like every refusal.
- **Left.** Telegram `my_chat_member` with the bot `left`/`kicked` in a group,
  Discord `CHANNEL_DELETE`, `THREAD_DELETE` and `GUILD_DELETE` (not an
  `unavailable` outage; one call per known chat of the guild, never a category,
  forum or media channel) → `POST /v1/channel/places/left`. Not journaled: the
  host applies it on every call.
- **Member count.** Admission and claim `chat` carry `member_count` when the
  platform reports it: Telegram `getChatMemberCount` (cached 10 min per chat),
  Discord the guild's `member_count` from `GUILD_CREATE` (no extra call). Discord
  guild chats carry `title` (`#channel`, thread name) when known.

## Guarantees (contract §6)

- **Inbound dedup.** `request_id` comes only from platform ids
  (`tg:<bot>:u:<update_id>`, `tg:<bot>:cb:<callback id>`,
  `dc:<app>:m:<message id>`, `dc:<app>:i:<interaction id>`; `dc:<app>:l:<chat id>`
  for a v1.2 left, which is not journaled). It is journaled
  after the host's final answer; the Telegram offset moves only after that.
- **Outbound dedup.** `receipt_id → platform message ids` is journaled right
  after the platform call and before the ack; a journaled receipt is acked from
  the journal, never posted again. The stream resumes with `Last-Event-ID` = the
  last seq whose ack the host accepted.
- **Per chat order**, acks batched (≤ 100), 45 s silence → reconnect, backoff
  1 s → 60 s on host and platform errors.
- **No content outside the pipe.** Unaddressed group/guild messages never reach
  the host (an owner chat claim is a command, see above). Pairing codes are claimed only in a DM (Telegram `/start <code>` too);
  in a group the person is told to use the DM. Suspected secrets (shared detector)
  are deleted where the platform allows (Telegram; not a Discord DM) and warned
  about, never sent. Files, stickers and voice are refused politely.
- **Rendering.** The Soot's Markdown subset becomes Telegram HTML or Discord
  markdown; everything else is escaped and Discord pings nobody but a replied-to user. `nest://`
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
