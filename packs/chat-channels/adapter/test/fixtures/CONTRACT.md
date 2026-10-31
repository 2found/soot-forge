# Contract fixtures (copy)

Verbatim copies of `docs/contracts/channel-adapter/fixtures/` from the Soot
repository (`2found/2agent`), contract `channel-adapter.v1` revision v1.2 (§10,
`contract_revision: 2`), 2agent commit `6f3908d`, digest `1af2be999f1d3158`.
The v1.0 and v1.1 files are unchanged from commit `c935108` (earlier digests
`16a8b91eab6fae76`, `7e0f1815a60312d5`, computed differently); `v1.2-*.json`
are new. Soot Forge tests never read a sibling checkout: when the contract
changes, copy the new fixtures here and update the commit and digest.
Fake secrets in `secrets.json` carry the `⟨⟩` split marker.

The digest is the first 16 hex characters of the SHA-256 of the `shasum -a 256`
listing of every file here except this one, in byte order; `test/v1_2.test.mjs`
checks it:

```sh
cd test/fixtures && export LC_ALL=C \
  && for f in *; do [ "$f" = CONTRACT.md ] || shasum -a 256 "$f"; done | shasum -a 256 | cut -c1-16
```
