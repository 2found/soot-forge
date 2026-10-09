# Marketing workflow

This optional pack supplies role guidance and passive draft/plan/publication records. Soot's native delegation owns work; the ledger never starts agents or schedules jobs. Node.js 22+ is required. Install executes no scripts and grants nothing.

Use the [Marketing team template](../../groups/marketing-team/README.md) to prepare coordinator, Radar, creator, editor and optional Blog/X publishers. Research and shared data reuse the research, writing and data-pool packs. Build the data-pool connector explicitly as documented by that pack; infrastructure and grants are separate.

Bind `MARKETING_TEAM` per Soot/selected operation to a private JSON credential:

```json
{"soot":"acme-blog","directory":"/private/marketing-records","channels":{"blog":{"endpoint":"https://publisher.example.com","destination":"my-blog","token":"<gateway credential>"}}}
```

Creator/editor bindings omit channels. Publishers receive only their own channel, destination and credential. `directory` is shared by authorized local team members; different tenants need different directories. Do not grant shell/file tools to a publisher. This local filesystem boundary is not OS sandboxing.

Gateway contract: POST `/v1/publications`, with `Idempotency-Key` and the JSON `idempotency_key`, destination, channel and exact draft payload; GET `/v1/publications/{key}` reconciles a lost response without creating a post. Both require Bearer auth. A proven result is `{idempotency_key,status:"published",url:"https://…",receipt:"…"}`. The gateway must persist idempotency and platform receipts. It owns authenticated X/blog platform integration; this pack does not pretend a gateway exists or silently bypass X access restrictions. Bind a reviewed adapter before live publishing. Redirects are refused. Response bodies are bounded.

Default approval is operator-only. Inspect a draft and proposed plan first; create an approval JSON containing `{id,revision,plan_revision,hash,channel}`. With that publisher's private binding in the environment, run:

```sh
node tools/marketing.mjs approve /private/reviewed-approval.json
```

The command is deliberately absent from model tool grants. Approval binds the exact hash/revision, publisher, destination and planned time. Any content/plan change invalidates it. A host may explicitly set `automatic:true` on one channel; templates never do so. Future plan rows are not jobs: arrange the existing host schedule separately and never claim scheduled delivery from a ledger entry.

Publication writes an uncertain receipt before HTTP. A timeout, malformed response or HTTP error retains uncertainty; only a matching remote GET receipt resolves it. It never automatically retries. Successful channels remain recorded when another fails. Interrupted filesystem locks are preserved; the operator verifies no writer owns the directory before removing `.marketing.lock`. Do not remove records to clear uncertainty. Tests use a local fixture gateway and send no real posts.

Editor plans use `expected_plan_revision` from the inspected record in addition to the content `expected_revision`. An approval must include that observed `plan_revision`; stale plan approvals and stale editor writes are refused. If a destination or gateway changes while an attempt is uncertain, restore the original reviewed binding and reconcile that attempt before publishing again.
