# Cloudflare DNS (`dns_create`, `dns_list`, `dns_delete`)

Bounded record management inside the host-bound zone — enough to point a
hostname at a Worker, an origin IP, or a verification TXT.

## Operations

- `dns_create {type, name, content, ttl?, proxied?}` — `type` is one of
  `A|AAAA|CNAME|TXT`. `ttl` 1 = automatic. `proxied` only matters for
  A/AAAA/CNAME. Returns `receipt.remoteIds.record` (record id — keep it for
  delete).
- `dns_list {}` — the first 100 records in the bound zone (no pagination in this version) (`id`, `type`, `name`,
  `content`).
- `dns_delete {record}` — delete by the record id from create/list.

## Rules

- The zone is fixed by the operator (`zone_id` inside `CF_BINDING`); this
  pack cannot create zones or touch other zones.
- Content is shape-checked (IPv4/IPv6 for A/AAAA); CNAME/TXT just reject
  control characters.
- DNS propagation is not instant — a succeeded record may take seconds to
  minutes to resolve publicly.
