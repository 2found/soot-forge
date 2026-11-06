# Team CS

A starter for a customer care team. On top of the [live-chat](../live-chat/README.md)
base it adds two role Soots and four generic skills:

| Soot | Role |
| --- | --- |
| `cs-triage` (CSKH tiếp nhận) | Faces customers first: answers from the team's collection, checks account and product facts with the product tool, asks one question, hands off, or declines. |
| `cs-escalation` (CSKH xử lý chuyên sâu) | Takes cases members send it and people who write to it directly: gathers facts, drafts the resolution, asks a member only for the decision. |

Both run with `interaction: {mode: "interactive", handoff: "members"}`, so
`report_blocker` (granted to every conversation run by the runtime) puts the case
in the members' queue instead of ending it blocked.

| Skill | What it decides |
| --- | --- |
| `cs-triage` | The one path a message takes. Price, plan, quota, limit and account facts come from the product tool, never from the collection. |
| `handoff-policy` | When to call `report_blocker`, what the report holds, what the customer hears, how to resume. |
| `tone` | Short, warm, plain, in the customer's language; no promise a result does not show. |
| `person-memory` | What to keep about a returning person, what never to keep, recall and forget. |

The pack names no product and imports no product skill. Product knowledge is a
Kho tài liệu collection you grant, and product facts and actions come from your
product pack (for Lohi, `lohi-cs` layers on this one).

## Install in 3 steps

1. **Add the pack.**
   ```sh
   soot pack add team-cs
   ```
   It brings `live-chat` with it. Your product pack (tools for price, plan,
   account) is added the same way.
2. **Create a binding in Nest.** Open the channel settings and add a `web/<name>`
   binding answered by `cs-triage`. The website chat widget is the anonymous
   level of that binding (SDK browser mode); sign your users in with an
   assertion (`admit: "asserted"`, a declared `tenant`, and the `bid` claim) so a
   returning person keeps their memory.
3. **Paste env.** On the binding's sheet choose **Tạo khoá kết nối** and put
   the `scb_…` secret and the binding id into your server's environment. The
   secret is shown once; never commit it, paste it in chat or log it. A binding
   holds two active secrets, so you can rotate without downtime.

Then give both Soots read access to a **Kho tài liệu** collection with your
how-to and policy pages (add its id to each Soot's `knowledge` and to the host's
`data_pool.knowledge`). Do not put prices or plan terms there: the Soots read
them from the product tool. The Soot sources are in `soots/cs-triage/` and
`soots/cs-escalation/`.

Advanced: the same binding can be declared in `deployment.json`:
```json
"channels": {
  "acme-web": { "platform": "web", "mode": "remote", "enabled": true, "soot": "cs-triage" }
}
```

Check it end to end:

**First-message test.** With the runtime running, connect the SDK's channel
   demo adapter as the binding and send one message:
   ```sh
   SOOT_CHANNEL_HOST=http://127.0.0.1:<port> SOOT_CHANNEL_BINDING=acme-web \
   SOOT_CHANNEL_SECRET=<scb_ from step 3> bun examples/channel-demo/run.ts
   ```
   (from `contrib/sdk/typescript` of the Soot repository). A reply from
   `cs-triage` arriving for the right sender means the agent is live. Then ask
   for a refund: the conversation should wait for a member, and the case appears
   in Nest's queue.

## Remove

Removing the Soot a channel binding targets (for example the `team-cs` Soot)
marks that binding `needs_target`: it stops answering until you point it at
another Soot. Deleting the deployment's `default_soot` is refused until
`default_soot` is changed. History (conversations, member replies and memory)
stays readable; nothing is deleted.

To uninstall the pack itself, deselect `team-cs` from every Soot (remove it
from each `soot.json` `packs`, or untick it in Nest), then run
`soot pack remove team-cs`. `team-cs` declares no `storage` and no tools, so
nothing else is removed: conversations, member replies, the `user` memory of
every person and the channel binding all stay with the host (P4.6, AC-P4-5).

## Evals

[`evals/team-cs/`](evals/team-cs/README.md): 8 cases covering triage, handoff,
direct message, out-of-scope decline, question-card answer, memory across two
conversations and a price answered from the tool, not the collection.
