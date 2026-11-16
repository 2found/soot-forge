// Which catalog novel a job is about, decided from the cli's own SQLite (cli/data/catalog.db, read-only) and never
// from a title search on the open web. The cli has no "URL -> source/novel" command and no source search: the
// catalog row (`source_catalog.landing_url`, `title`, `cn_title`) is the only map it keeps, so that is the one used.
// A match must be unambiguous; anything else answers `no_source` / `needs_source` and the caller decides (a vague
// request ends `failed` with cause `no_source`; a request link the catalog does not know is the one judgment step).
import { openReadOnly } from './crawl.mjs';
import { short } from './base.mjs';

/** Accent / case folded title: the same fold the api uses for request titles (api/src/lib/vietnamese.ts). */
export const foldTitle = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim();
/** A Chinese title: width-folded, no spaces or punctuation. */
export const foldCn = t => String(t ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
/** Titles this short or generic never identify a novel on their own. */
const MIN_TITLE_CHARS = 6;

/** Opens the catalog read-only; the caller closes it. */
export const openCatalog = async (deps, path) => (deps.openDb ?? openReadOnly)(path);

const COLS = 'source_slug AS source, novel_slug AS novel, title, cn_title, landing_url, is_prd_sync, copyright_issue, status';

/**
 * One source novel whose folded title equals the request title (or whose Chinese title equals it). Exactly one row
 * must match: two sources carrying the same title could be two different novels, so that is `ambiguous`, not a pick.
 */
export function resolveByTitle(db, title) {
  const folded = foldTitle(title), cn = foldCn(title);
  if (folded.replace(/ /g, '').length < MIN_TITLE_CHARS && !/[㐀-鿿]/.test(cn)) return { found: false, why: 'title_too_short' };
  const hits = db.prepare(`SELECT ${COLS} FROM source_catalog`).all().filter(r => (r.title && foldTitle(r.title) === folded) || (r.cn_title && cn && foldCn(r.cn_title) === cn));
  if (hits.length === 1) return { found: true, source: hits[0].source, novel: hits[0].novel, row: hits[0] };
  return { found: false, why: hits.length ? 'ambiguous' : 'no_match', candidates: hits.slice(0, 5).map(h => `${h.source}/${h.novel}`) };
}

/** A link normalised the way landing_url is compared: https, lower-case host, no www, no query / hash, no trailing slash. */
export function normUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/** The catalog row whose landing_url is the request's link (exactly one). */
export function resolveByUrl(db, url) {
  const want = normUrl(url);
  if (!want) return { found: false, why: 'bad_url' };
  const hits = db.prepare(`SELECT ${COLS} FROM source_catalog WHERE landing_url IS NOT NULL`).all().filter(r => normUrl(r.landing_url) === want);
  if (hits.length === 1) return { found: true, source: hits[0].source, novel: hits[0].novel, row: hits[0] };
  return { found: false, why: hits.length ? 'ambiguous' : 'unknown_link' };
}

/** The source pack whose base_url host is the link's host (the hint a person or the model resolves the novel from). */
export async function sourceForHost(url, { fsx, cliDir }) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  let slugs = [];
  try { slugs = await fsx.readdir(`${cliDir}/data/sources`); } catch { return null; }
  const hits = [];
  for (const s of slugs) {
    try {
      const cfg = JSON.parse(await fsx.readFile(`${cliDir}/data/sources/${s}/config.json`, 'utf8'));
      if (cfg.base_url && new URL(cfg.base_url).hostname.toLowerCase().replace(/^www\./, '') === host) hits.push(s);
    } catch { /* not a pack */ }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The catalog row behind a published Lohi novel (a refresh names the novel by its prod slug, which is the catalog slug
 * unless onboard ran with --prod-slug). Several sources: the one that holds the wanted chapters, if only one does.
 */
export function resolveByProdSlug(db, slug, chapters) {
  const rows = db.prepare(`SELECT ${COLS} FROM source_catalog WHERE novel_slug = ? AND is_prd_sync = 1`).all(String(slug));
  if (rows.length === 1) return { found: true, source: rows[0].source, novel: rows[0].novel, row: rows[0] };
  if (!rows.length) return { found: false, why: 'no_match' };
  const to = Number(/^\d+-(\d+)$/.exec(chapters ?? '')?.[1] ?? 0);
  const have = rows.filter(r => to > 0 && db.prepare('SELECT 1 AS x FROM chapters WHERE source_slug = ? AND novel_slug = ? AND chapter_number = ? AND content IS NOT NULL LIMIT 1').get(r.source, r.novel, to));
  if (have.length === 1) return { found: true, source: have[0].source, novel: have[0].novel, row: have[0] };
  return { found: false, why: 'ambiguous', candidates: rows.map(r => `${r.source}/${r.novel}`) };
}

/** Chapters of a catalog novel that hold text, inside a range. */
export const countChapters = (db, source, novel, from, to) => Number(db.prepare(
  'SELECT count(*) AS n FROM chapters WHERE source_slug = ? AND novel_slug = ? AND chapter_number BETWEEN ? AND ? AND content IS NOT NULL').get(source, novel, from, to)?.n ?? 0);
export const maxChapter = (db, source, novel) => Number(db.prepare(
  'SELECT max(chapter_number) AS n FROM chapters WHERE source_slug = ? AND novel_slug = ? AND content IS NOT NULL').get(source, novel)?.n ?? 0);
export const copyrightOf = (db, source, novel) => {
  const r = db.prepare('SELECT copyright_issue AS issue, copyright_reason AS reason FROM source_catalog WHERE source_slug = ? AND novel_slug = ?').get(source, novel);
  return { issue: Number(r?.issue ?? 0) === 1, reason: short(r?.reason ?? '', 300) };
};

/**
 * What a job's subject and request fields come to, in order: an explicit `<source>/<novel>`; a refresh's prod slug; the
 * request's link; the request's title. Answers {source, novel} or {unresolved, why, ...}.
 * `unresolved: 'needs_source'` is the one case that wants judgment (a link the catalog has never seen);
 * `unresolved: 'no_source'` ends the job (a vague title, an ambiguous match, nothing to go on).
 */
export async function resolveJob(job, parts, { db, fsx, cliDir }) {
  if (parts.source !== 'request') return { source: parts.source, novel: parts.novel };
  const slug = job.novel_slug;
  if (job.kind === 'refresh' && slug) {
    const r = resolveByProdSlug(db, slug, parts.chapters ?? job.chapters);
    return r.found ? r : { unresolved: 'no_source', why: `refresh:${r.why}`, ...(r.candidates ? { candidates: r.candidates } : {}) };
  }
  if (job.source_url) {
    const r = resolveByUrl(db, job.source_url);
    if (r.found) return r;
    // The cli cannot turn a link it has never crawled into a source and a novel slug: a person or the builder does,
    // and says it back with catalog_job_run {source, novel} (guarded against the link's own host).
    const hint = await sourceForHost(job.source_url, { fsx, cliDir });
    return { unresolved: 'needs_source', why: r.why, source_url: job.source_url, ...(hint ? { source_hint: hint } : {}) };
  }
  const t = resolveByTitle(db, job.title);
  return t.found ? t : { unresolved: 'no_source', why: `title:${t.why}`, ...(t.candidates ? { candidates: t.candidates } : {}) };
}
