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

## Install

1. **Add the packs.**
   ```sh
   soot add 2found/soot-forge/packs/live-chat
   soot add 2found/soot-forge/packs/team-cs
   ```
   Your product pack (tools for price, plan, account) is added the same way.
2. **Create the two Soots** from `soots/cs-triage/` and `soots/cs-escalation/`:
   copy each folder into your workspace's Soot sources and list its `soot.json`
   in the deployment's `soots`. Add your product pack to each Soot's `packs`.
   (When group templates carry `interaction`, this step becomes one
   `soot group add`; the files stay valid for it.)
3. **Grant a collection.** In Nest, open **Kho tài liệu**, create or pick the
   collection that holds your how-to and policy pages, and give both Soots read
   access. Then add its id to each Soot's `knowledge` and to the host's
   `data_pool.knowledge`. Do not put prices or plan terms there as the source of
   truth: the Soots read them from the product tool.
4. **Declare one binding.** In Nest's channel settings, add an `app` binding
   answered by `cs-triage`, or in `deployment.json`:
   ```json
   "channels": {
     "acme-app": { "platform": "app", "mode": "remote", "enabled": true, "soot": "cs-triage" }
   }
   ```
   Add `"admit": "asserted"` and a declared `"tenant"` once your server signs in
   its users, so a returning person keeps their memory across conversations.
5. **Mint the adapter secret.** On the binding's sheet in Nest, choose
   **Tạo khoá kết nối** (or `POST /v1/channel/bindings/acme-app/secrets` with an
   operator credential). The `scb_…` secret is shown once: put it straight into
   your server's secret store. Never commit it, paste it in chat or log it. A
   binding holds at most two active secrets, so you can rotate without downtime.
6. **First-message test.** With the runtime running, connect the SDK's channel
   demo adapter as the binding and send one message:
   ```sh
   SOOT_CHANNEL_HOST=http://127.0.0.1:<port> SOOT_CHANNEL_BINDING=acme-app \
   SOOT_CHANNEL_SECRET=<scb_ from step 5> bun examples/channel-demo/run.ts
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

## Evals

[`evals/team-cs/`](evals/team-cs/README.md): 8 cases covering triage, handoff,
direct message, out-of-scope decline, question-card answer, memory across two
conversations and a price answered from the tool, not the collection.
