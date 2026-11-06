# cs-console — Khách hàng

A `rail` page, **Khách hàng**, for the lead Soot of a care team. Each row is
one person: a verified sender (asserted by the product, or paired) of a
tenant. The page shows:

- their **timeline** across the team's bindings (web, Telegram, app…), read
  through the host's conversation API;
- **status**, a projection of each conversation's `control`: Cần người,
  Người đang trả lời, Soot đang trả lời, Đã xong;
- **memory**: their user bank, read-only (`GET /v1/conversations/{id}/principal`);
- **live product facts** from the product, fetched when the page opens and
  never stored.

The pack stores only **tags**, **notes** and **identity links**, in its own
`storage` tables, keyed by `<tenant>:<sub>` (`principal` columns, so a
principal erasure removes them), plus the ids (`jti`) of link proofs already (a UNIQUE `proof_claims.jti` column; older claims stay in `proofs`)
used, which hold no person and outlive an unlink so a proof is never
replayed. It keeps no copy of a conversation.

## Setup

Select `cs-console` on the CS lead Soot and enter one credential,
`CS_CONSOLE`, a JSON object:

```json
{
  "host": "https://soot.example.com",
  "keys": ["<member key>"],
  "link_keys": [{ "kid": "lohi-1", "iss": "https://lohi2.com", "x": "<Ed25519 public key, base64url>" }],
  "facts": { "url": "https://api.example.com/support/users/{sub}/facts", "key": "<read-only key>" }
}
```

- `keys`: 1–8 **member keys** with `conversations:read_team` and `control`,
  each issued for one binding tenant (`channel:<binding>`) and limited to the
  team's Soots: `soot auth issue --tenant channel:lohi-web --user cs-console
  --soot le-tan --permissions conversations:read_team,control`. The host
  enforces these grants: a conversation of another team or tenant never
  reaches the page.
- `link_keys` (optional): the product's public keys for identity links. Same
  key format as a `web` binding's `assertion_keys`.
- `facts` (optional): a GET endpoint with `{sub}` that answers
  `{facts: [{label, value}]}`. Without it the page says so.

## Identity links

Two principals are shown as one person only when:

1. they are the **same verified sub** of the tenant (for example a Lohi user
   asserted on the web and the same user paired on Telegram), or
2. a **product-signed link proof** says so. The product signs an EdDSA JWS
   with one of `link_keys`: `{iss, aud: "soot-identity-link", tenant, sub,
   alias, alias_tenant?, iat, exp (≤ 300 s after iat), jti}`, meaning "product
   user `sub` of `tenant` is also principal `alias` of `alias_tenant`" (default:
   `tenant`). A member pastes it under *Danh tính đã liên kết*.
   Expired, replayed, unknown-key, wrong-audience and conflicting proofs are
   refused. Two members pasting one proof at once: one link, the other is
   refused (`proof_replayed`).

Lists are read a page at a time (*Tải thêm khách*) and say when they are cut.

There is no way to link by name, email or anything a model or member types.

## Removing

Deselecting the pack removes the page at once: its URL answers 404 and Nest
drops the entry. The pack's tables are hidden for 30 days, then dropped, or at
once with `soot pack remove cs-console --purge`. Conversations and memory
belong to the host and are never touched.

## Tests

`node --test packs/cs-console/tests/*.test.mjs packs/cs-console/page/tests/*.test.mjs`
