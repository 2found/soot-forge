// crawl_watch: the cli's local SQLite catalog (cli/data/catalog.db), opened read-only.
// Stuck and failed crawls, sources that stopped moving, radar finds not yet onboarded.
import { setupNeed, clearSetup, needCard, iso, short } from './base.mjs';

const HOUR = 3_600_000, DAY = 86_400_000;
const ms = s => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };

export async function openReadOnly(path) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path, { readOnly: true });
}

/** Group failure messages by their first words so one broken source reads as one line. */
export const errorKind = e => short(String(e ?? 'không rõ lỗi').replace(/\d+/g, 'N').replace(/https?:\/\/\S+/g, '<url>'), 80);

export async function crawl_watch(input, deps) {
  const { env, now, store } = deps;
  const path = env.CLI_CATALOG_DB;
  if (!path) return setupNeed(deps, 'CLI_CATALOG_DB');
  const stuckHours = Math.min(Math.max(Number(input.stuck_hours) || 6, 1), 168);
  const staleDays = Math.min(Math.max(Number(input.stale_days) || 7, 1), 90);
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  let db;
  try { db = await (deps.openDb ?? openReadOnly)(path); }
  catch { return { ok: false, error: { code: 'catalog_unreadable', message: `Không mở được cơ sở dữ liệu thu thập (${path}). Kiểm tra CLI_CATALOG_DB.` } }; }
  try {
    const perSource = db.prepare(`SELECT source_slug AS source, crawl_status AS status, count(*) AS n, max(crawled_at) AS last_crawled, max(radar_checked_at) AS last_radar
      FROM source_catalog GROUP BY source_slug, crawl_status`).all();
    const crawling = db.prepare(`SELECT s.source_slug AS source, s.novel_slug AS novel, s.crawled_at AS crawled_at, s.enriched_at AS enriched_at,
        (SELECT max(c.fetched_at) FROM chapters c WHERE c.source_slug = s.source_slug AND c.novel_slug = s.novel_slug) AS last_fetch
      FROM source_catalog s WHERE s.crawl_status = 'crawling' LIMIT 200`).all();
    const failedRows = db.prepare(`SELECT source_slug AS source, novel_slug AS novel, crawl_error AS error, crawled_at FROM source_catalog
      WHERE crawl_status = 'failed' ORDER BY crawled_at DESC LIMIT 500`).all();
    const backlog = db.prepare(`SELECT source_slug AS source, count(*) AS n FROM source_catalog WHERE has_new_chapters = 1 GROUP BY source_slug`).all();

    const sources = new Map();
    for (const r of perSource) {
      const s = sources.get(r.source) ?? { source: r.source, total: 0, pending: 0, enriched: 0, crawling: 0, done: 0, failed: 0, last_crawled_at: null, last_radar_at: null };
      s.total += r.n; if (r.status in s) s[r.status] += r.n;
      if (r.last_crawled && (!s.last_crawled_at || r.last_crawled > s.last_crawled_at)) s.last_crawled_at = r.last_crawled;
      if (r.last_radar && (!s.last_radar_at || r.last_radar > s.last_radar_at)) s.last_radar_at = r.last_radar;
      sources.set(r.source, s);
    }
    const stuck = crawling.map(r => {
      const last = Math.max(ms(r.last_fetch) ?? 0, ms(r.crawled_at) ?? 0, ms(r.enriched_at) ?? 0) || null;
      return { source: r.source, novel: r.novel, last_activity: last ? iso(last) : null, idle_hours: last ? Math.floor((now - last) / HOUR) : null };
    }).filter(r => r.idle_hours === null || r.idle_hours >= stuckHours).sort((a, b) => (b.idle_hours ?? 1e9) - (a.idle_hours ?? 1e9));
    const failedKinds = new Map();
    for (const r of failedRows) {
      const k = `${r.source}|${errorKind(r.error)}`;
      const g = failedKinds.get(k) ?? { source: r.source, error: errorKind(r.error), count: 0, example: r.novel, last_at: r.crawled_at };
      g.count++; if (r.crawled_at && (!g.last_at || r.crawled_at > g.last_at)) g.last_at = r.crawled_at;
      failedKinds.set(k, g);
    }
    const failed = [...failedKinds.values()].sort((a, b) => b.count - a.count).slice(0, limit);
    // A source with work left (pending/enriched/crawling) that has not crawled anything for stale_days.
    const staleSources = [...sources.values()].filter(s => {
      const last = ms(s.last_crawled_at);
      return s.pending + s.enriched + s.crawling > 0 && (last === null || now - last > staleDays * DAY);
    }).map(s => ({ source: s.source, last_crawled_at: s.last_crawled_at, waiting: s.pending + s.enriched + s.crawling }));
    const backlogRows = backlog.map(b => ({ source: b.source, novels_with_new_chapters: b.n })).sort((a, b) => b.novels_with_new_chapters - a.novels_with_new_chapters);

    const actionable = [
      ...stuck.map(s => ({ key: `stuck:${s.source}:${s.novel}`, line: `Đang thu thập nhưng đứng yên ${s.idle_hours ?? '?'} giờ: ${s.source}/${s.novel}` })),
      ...failed.filter(f => f.count >= 3).map(f => ({ key: `failed:${f.source}:${f.error}`, line: `${f.source}: ${f.count} truyện lỗi "${f.error}"` })),
      ...staleSources.map(s => ({ key: `stale:${s.source}`, line: `${s.source} còn ${s.waiting} truyện chờ nhưng ${s.last_crawled_at ? `lần thu thập cuối ${s.last_crawled_at.slice(0, 10)}` : 'chưa thu thập lần nào'}` })),
    ];
    const card = await needCard(store, 'crawl', {
      items: actionable.map(a => a.key), summary: `Thu thập truyện có ${actionable.length} điều cần xem`,
      lines: actionable.slice(0, 12).map(a => `• ${short(a.line, 140)}`),
    });
    return {
      ok: true, generated_at: iso(now), sources: [...sources.values()].sort((a, b) => b.total - a.total).slice(0, limit),
      stuck: stuck.slice(0, limit), failed, stale_sources: staleSources, backlog: backlogRows.slice(0, limit), actionable: actionable.length, ...card, ...((await clearSetup(deps, 'CLI_CATALOG_DB')).resolves_need ? { resolves_need: true } : {}),
    };
  } finally { try { db.close(); } catch { /* read-only handle */ } }
}
