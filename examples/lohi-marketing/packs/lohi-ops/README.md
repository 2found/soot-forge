# lohi-ops

Lohi operations beyond marketing, as one local pack (not a catalog row). Six jobs, ten tools.
Everything reads aggregate or public data; no tool changes a price, a plan or a reader.

| Job | Tools | Source | Acts? |
| --- | --- | --- | --- |
| Catalog health | `catalog_health` | api `GET /admin/analysis/catalog-health` | Findings table; one Cần bạn card for stale >= 30 days, gaps >= 5 chapters, empty chapters, >= 50% untranslated |
| Crawl watch | `crawl_watch` | the cli SQLite (`CLI_CATALOG_DB`), opened read-only | Card for stuck, repeated failures, stalled sources |
| Comment moderation | `comments_pull`, `comments_decide`, `comments_resolve` | api `/admin/moderation/replies` | Hides only spam/abuse/scam at confidence >= 0.9 (max 15 per call); the unsure go to a person |
| App Store reviews | `appstore_sync`, `appstore_draft`, `appstore_drafts`, `appstore_post` | Apple's public feed; posting needs the founder's `ASC_API_KEY` | Drafts; `appstore_drafts` puts the batch in one Cần bạn card (no model) whose Đăng wakes the Soot to post; posting without the key answers `needs_credential` |
| Novel-page SEO | `seo_report` | Search Console (`GSC_GOOGLE`, same sign-in as marketing) | Report plus up to 3 `digest_save`-shaped content opportunities |
| Pricing | `pricing_report` | api `GET /admin/analysis/scoreboard` (`plans`, `cohorts`) | Read-only; every suggestion is `decision: founder` |

## Wiring

- Env: `PRODUCT_API_URL` (https://api.lohi2.com), `CLI_CATALOG_DB` (absolute path to `cli/data/catalog.db`; Node >= 22.5 for `node:sqlite`), `APPSTORE_APP_ID` (default 6795186131), `APPSTORE_COUNTRY` (default vn), `GSC_SITE` (default sc-domain:lohi2.com), `SITE_URL` (default https://lohi2.com).
- Credentials, all optional (a missing one is a quiet `skipped` on schedules; `catalog_health` and `crawl_watch` also raise ONE Cần bạn item naming the key and where it goes (Nest, Cài đặt, Thiết lập), closed when a run finds it; except posting a reply, which names `ASC_API_KEY`):
  `PRODUCT_ADMIN_KEY` (an `agent_mod` api key; sent only to `PRODUCT_API_URL`, only over https),
  `GSC_GOOGLE`, `ASC_API_KEY` (JSON `{key_id, issuer_id, private_key}`).
- Suggested schedules: `catalog_health` daily; `crawl_watch` every 2 to 6 hours; `comments_pull` every 30 to 60 minutes (the Soot classifies, then `comments_decide`); `appstore_sync` daily, then `appstore_drafts` (no model) half an hour later; `seo_report` and `pricing_report` weekly.
- Put `appstore_post` and `comments_resolve` behind operator approval.
- Reviewer names are never stored. Comment text is stored only as a 160-character excerpt with an opaque id.

Tests: `node --test examples/lohi-marketing/packs/lohi-ops/tests/ops.test.mjs` (mocks only; the real api is never called).
