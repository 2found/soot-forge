# Concurrent collection and duplicate-friendly ingestion

Use the shared service for many Soots. Direct mode opens a short-lived
PostgreSQL connection pool per connector call and is intended for one host's
small workloads. Shared mode supports up to 4,096 bound Soots/client tokens and
admits at most 256 active requests; overload returns 503 without retrying
mutations. One principal — a token plus the Soot it claims — may hold at most 16
of those at once; the 17th gets a generic 429, so one caller cannot occupy every
slot. These are bounds, not a promised production capacity.

Independent document writes, queries and `status` share policy admission and
reach PostgreSQL concurrently. Requests targeting one document serialize;
identical request IDs for one Soot serialize before checking the saved receipt.
`status` takes the same request key as the original write, then that write's
document key, so a status read never observes a half-published receipt.
Management and human UI operations retain exclusive policy admission.
A waiting revoke blocks new admissions and completes only after earlier responses
are flushed. Slow database work is bounded by existing request deadlines;
different documents do not wait behind a namespace-wide write mutex. Writes are
synchronous transactions: commit publishes the document, receipt and activity
together, and rollback publishes nothing.

The host Pack's `resource_fields` separates independent tool calls without
changing credentials or privileges. Write keys include the host-bound `@soot`
identity, pool, document and request ID; read keys include identity, pool, document
and query. A model cannot spoof `@soot` through its input. It requires a Soot runtime supporting that
field; upgrade runtime and Pack together. Existing runtimes reject the new field.
PostgreSQL remains authoritative for same-document concurrency even when host
resource keys differ.

## Append observations; update curated documents deliberately

```json
{
  "action": "append",
  "pool": "sources",
  "request_id": "collector-observation-42",
  "title": "New observation",
  "content": "A paraphrased observation from the source.",
  "source": "https://example.com/article"
}
```

Append generates a document ID from the authenticated Soot and request ID. Two
Soots may use the same request ID without colliding. Identical content under a new
request ID creates another document: the pool does not impose content deduplication.
Repeating the same request ID and exact input returns its original receipt and
ID. Reusing an ID with changed input is rejected. Append accepts neither a chosen
document ID nor `expected_revision`; it cannot overwrite a curated record.

Use `upsert` with an explicit document ID to maintain a canonical source, draft
or handbook. Without `expected_revision`, updates use latest-arrival-wins after
per-document serialization. Supply `expected_revision` when a caller must detect
an intervening change. Human interface edits continue to require both revision
and pool generation. `remove` remains explicit.

A successful response means the transaction committed the document, receipt and
activity. An error means it rolled back, so no asynchronous task is left behind.
A transport failure still provides no outcome; inspect the receipt with the
original request ID rather than inventing another ID. Append's acceptance of
duplicate content does not weaken request-ID deduplication.

## Evidence and limits

The 2agent marketing-pool E2E has a Docker load lane with 200 distinct Soot
credentials, concurrent duplicate-content appends, full hash/writer verification,
retry/conflict/revocation checks, and p50/p95/max latency reporting. Its scripted
team lane uses actual Soot delegation, forks and Pack tools; its live lane uses
Devin or Codex explicitly. Those measurements use disposable local infrastructure,
not hundreds of simultaneous paid model calls or a production capacity claim.

Unit tests hold 16 (one principal's cap) real gateway submissions at a
transport rendezvous; a global
write mutex fails that test. Competing guarded writes to one document admit
exactly one expected revision. Existing replay/restart/revocation tests remain.

Display metadata is optional: an omitted/blank title uses the provenance URL or
document ID as a bounded default. When inline `content` and `url` are both given,
content is stored and the URL becomes provenance without a network fetch. A
contradictory explicit `source` is rejected. Invalid pre-submission write fields
return an actionable `invalid_input` error with no mutation submitted; permission,
transport and unknown-outcome errors retain their separate conservative behavior.
