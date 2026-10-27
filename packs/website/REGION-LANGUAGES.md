# Authored region languages — source handoff

**Source phase implemented; tests, build, actual Linux DAC and browser checks are pending operator QA.** Shell access remains fenced and was not bypassed. This is not evidence of deployment, migration of live state or an actual VI publication.

## Contract

`website_publish` accepts the existing `{id,title,intro,blocks}` plus optional `language:"en"|"vi"`. Omission means EN **without inserting a language key into canonical input or published content**. Explicit language presence/value participates in the fingerprint. Existing omitted-language EN IDs must replay with language omitted; adding `language:"en"` conflicts. Old raw-order JSON receipt fingerprints retain their original discipline. IDs remain globally unique and the shared 256-receipt capacity remains bounded. Replay of a historical identical receipt returns its original timestamp and does not change either current pointer. No uncertain-write retry was added.

`website_inspect {}` remains EN. `{language:"en"}` and `{language:"vi"}` inspect the exact locale. Missing VI returns `content:null`, never EN fallback. The envelope, marketer-only scope, modes, resource, timeouts, credential binding and grants are unchanged.

The CTA allowlist is exactly the five legacy destinations `/download`, `/blog`, `/#how-it-works`, `/#nest`, `/#showcase` and five necessary counterparts `/vi/download`, `/vi/blog`, `/vi#how-it-works`, `/vi#nest`, `/vi#showcase`. No arbitrary URLs, query strings, article paths, encoded aliases or traversal are accepted.

## Publication-owned storage transition

This concerns only `marketing.sqlite` / the legacy `marketing.json` and bounded publication receipts, **not** native conversations, vaults or private runtime data.

- Writer and stopped-startup preparation use `BEGIN IMMEDIATE`. Old schema import, the receipt language column (default EN), `current_locales` keyed by strict language, and the `locales-v1` marker commit atomically.
- Existing SQLite receipt hashes/timestamps and the old EN body remain intact. Valid old JSON receipt hashes/timestamps are retained; absent/torn current receipts can be repaired only from committed current content, as before. Old JSON/receipt files are never deleted.
- The EN locale pointer is seeded from the original current body without republishing or generating provenance. VI starts absent. A VI publication never writes the EN pointer or old English slot. EN updates leave VI untouched.
- Reads use one read-only SQLite snapshot for schema detection and both locale pointers. Old pre-migration SQLite and legacy JSON remain readable. Readers do not perform migrations, repairs, chmod or publication writes.
- Existing DELETE rollback journaling, FULL synchronization and 0640 database permissions are retained. Stopped runtime-UID preparation recovers any old WAL before the read-only Next UID starts. Schema migration adds no mounted filenames, native ports or configurations.
- Do not mix old/new publisher versions after migration or assume an older image is safe to restart against migrated state. The operator owns stopped startup and compatibility review; there is no automatic replay or restoration.

## Public API and UI

`GET /api/showcase/content` defaults to EN; `?language=en|vi` selects the authored snapshot. Language is validated before storage access: duplicate, unsupported, empty, extra and oversized queries return 400. Responses are private/no-store and carry `{content,requestedLanguage,language,fallback}`. Missing VI may return the EN snapshot with `language:"en",fallback:true`; missing EN is genuinely empty, not a reverse VI substitution. No request auth, cookies or secrets are forwarded, and no visitor publication endpoint is added.

`MarketingSpot` requests the selected language without credentials, resets the locale-bound view, aborts the old request/timer on a locale change or unmount, and ignores aborted completions. Authored text/CTA are not translated by the keeper. Their wrapper uses the actual authored `lang`; the VI page labels an absent VI publication as an original English fallback. Public author/id/timestamp remain displayed. No private marketing plan, drafts, conversations, raw prompt or tool results are rendered. Caro/streaming/layout source is untouched; the pending second Try Soot clarification is not implemented here.

## Existing EN publication boundary

The operator supplied publication ID `87f58d4b-39d4-4b65-89bf-a8d895d2d62d` and these separate fingerprints:

| Object | Supplied SHA-256 |
| --- | --- |
| Published content including author/timestamp | `f8ee6597cab03ff244e08ad54bedebbc9b9c9dbba9851f7fdc950e7d3b2a6f54` |
| Canonical input excluding author/timestamp | `c3a71e859ee57adbab0f574fa4bc8d0e3580b8f1f31586daab5ea7662f8700e3` |

These are supplied preservation targets, not newly calculated/live-verified results. Keeper did not read or modify the live EN publication, receipts or provenance. Source migration copies the committed EN body and retains fingerprints. Do not republish EN to manufacture a VI variant. After image deployment and an explicit root/operator task, VMmarketer inspects EN and VI, authors natural VI retaining meaning/agency/safe CTA intent, and publishes with `language:"vi"` and a **distinct fresh ID**. Until that succeeds, the UI truthfully labels EN fallback.

## Pending operator QA

Run only after the host shell fence is reconciled, never as a replay of an uncertain command. Use current source/package resolution (refresh the local file dependency if the operator's package installation has a stale copy). No keeper execution, test PASS or build PASS is claimed in this source phase.

| Check | Source coverage / pending command |
| --- | --- |
| Pack old and new fixtures | From `packs/website` in a Soot Forge checkout (release archives omit `tests/`): `pnpm test` (or `node --test tests/*.test.mjs`) |
| API and existing web units | From `web`: `pnpm test` |
| Types and production build | From `web`: `pnpm typecheck`, then `pnpm build` |
| Local authored-content browser fixture | From `web`: `node tests/marketing-language.mjs`; optional installed Chrome via `SOOT_QA_CHROME` |
| Existing Caro/streaming/locale regressions | Preserve and rerun the operator-owned `caro-activity.mjs`, `caro-browser.mjs`, `showcase-layout.mjs`, `locale-production.mjs --browser` fixtures as appropriate |

New synthetic fixtures cover EN/VI independence, fingerprints including language omission, exact CTAs, old SQLite/JSON receipt/body/provenance preservation, historical replay/conflict, migration interruption, kill/reopen, cold JSON and old-SQLite races, a global-ID cross-locale race, strict tool inspection, and API query validation/fallback. A Linux-root-only fixture drops to UID/GID 1001 for actual DAC read/write denial and sidecar checks; it explicitly skips on other hosts, so a macOS unit run is not Linux DAC evidence. The browser fixture intercepts all showcase traffic and tests EN/VI authored text/lang/provenance/CTAs, labeled English fallback, in-flight locale-navigation cancellation and 1440/390/320 responsive/focus/44px behavior. Its results will be saved under `web/qa/evidence/marketing-language/` only when the operator runs it.

No real publication, live CMS/model call, config/bundle/grant/provider change, artifact replacement, restart, deploy, commit or push occurred. Canonical consumer 0.3 and the staged Linux artifact were not edited; its supplied preservation SHA-256 is `8ee048dc77b27eda0ff977b345d80c69085c832395d4d99bc47ea4a9eca1d449`, to be reconfirmed by operator QA.
