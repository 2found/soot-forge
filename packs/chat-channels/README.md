# Chat channels

Lets the owner and paired members talk to the Đầu mối from Telegram or Discord.
The pack is only the adapter, `soot-channel` in [`adapter/`](adapter/): it adds
no tools, skills or grants, and installing or selecting it starts nothing.

What Soots, packs, grants and teams are is in the [Soot guide](../soot/skills/domain/SKILL.md); this pack is kept separate from it on purpose: it is an adapter binary, not knowledge.

The **deployment** starts it. A host binding in the deployment's `channels`
map (Nest: Cài đặt → Kênh chat) makes the Soot runtime supervise one
`soot-channel <telegram|discord>` process per enabled binding, with the bot
token read from the host vault just before start. The bot token is entered only
in Nest's form; it is never part of this pack, a chat or the adapter's state.

## Install

Nothing to install with Nest: Nest ships `soot-channel` next to its bundled
`soot`, and the runtime finds it there. A CLI-only install (`soot` without
Nest) puts the compiled adapter on the PATH the runtime inherits (one file, no
Node needed):

```sh
cd adapter && bun build --compile cli.mjs --outfile dist/soot-channel
install dist/soot-channel /usr/local/bin/soot-channel
```

or, with Node.js 22+, `npm install -g --install-links ./adapter`. Either way
the deployment starts it; you never run it yourself. When it is missing, Nest's
Kênh chat pane says so.

`soot-channel --version` prints the adapter and contract version
(`soot-channel 0.2.0 (channel-adapter.v1)`). The adapter has no dependencies.

## What it does

The adapter is a dumb, durable pipe for the host contract
`channel-adapter.v1` (Soot repository, `docs/contracts/channel-adapter.md`).
It owns the platform protocol (Telegram `getUpdates` long polling, Discord
Gateway), formatting and length limits, dedup and its delivery journal. The
host owns identity, pairing, admission, conversations, every fixed sentence
and every decision.

0.2.0 implements contract revision v1.1 (§9): a question or decision raised by
a conversation in a group or guild is asked in that chat, threaded under the
asker's message, and only the asker can answer it there; anyone else gets a
private "only the asker" toast or a threaded refusal. Approvals, grants,
briefs and every other item stay in DMs (the chat gets at most a one-line
pointer). Status reports name their cause (`reason`: token rejected, Message
Content intent off, webhook active, …). It still works with a 0.7.0 (v1.0) host,
which never sends the v1.1 fields. See [adapter/README.md](adapter/README.md) for the
environment, exit codes and guarantees.

Outbound connections only: no webhook, no public URL. Real Telegram/Discord
runs need an owner's bot token; CI uses fake runtime and platform servers.
