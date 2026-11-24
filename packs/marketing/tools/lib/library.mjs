// The marketing library: files under MARKETING_ROOT (the operator's folder),
// indexed into the pack table `library` so the desk never walks the disk on
// open. Layout (spec §8):
//   products.json                                   [{id, name, mark?, site?, hub_site?, video_channels?}]
//   content/<product>/<yyyy-mm-dd>-<slug>/meta.json one item: ref, format, langs, posts, hub ids
//     <lang>.md, <channel>.<lang>.txt                 the words, one file per language and channel
//   channels/<channel>/pack/series/<series>.json    mvf series overlays
//   channels/<channel>/campaigns/<campaign>/        campaign.json, 0N-stage folders, delivery
//   channels/<channel>/radar/<yyyy-mm-dd>.md        a table with an Onboard? column
//   channels/<channel>/metrics/videos.csv           posted videos and their numbers
// library_scan refreshes the index; item_save writes an item's files and its
// hub drafts (write-through). Codes, never prose, go to the page.
import { createHash } from 'node:crypto';
import { fail, eq, skippedFor, needsCredential, MarketingError } from './store.mjs';
import { libraryRoot, list, readText, writeText, exists, segments, mtimeOf, resolveInside } from './root.mjs';
import { stat } from 'node:fs/promises';
import { hubCall, hubBinding, WRITE_TIMEOUT_MS } from './hub.mjs';
import { localDay } from './time.mjs';

export const TZ = 'Asia/Ho_Chi_Minh';
export const ITEM_REF = /^MK-[0-9A-Z]{6}$/;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A desk channel key, `<product>:<channel>`. */
export const CHANNEL_KEY = /^([a-z0-9][a-z0-9-]{0,31}):(blog|x|facebook|tiktok|reddit|community|newsletter)$/;
const LANGS = new Set(['vi', 'en']);
const SOCIAL = new Set(['x', 'facebook', 'tiktok', 'reddit']);
export const FORMATS = new Set(['blog', 'social', 'video', 'community', 'newsletter', 'launch']);
/** Where a community post goes: a subreddit, Hacker News, dev.to, or a place the founder names. */
export const TARGET_KINDS = ['reddit', 'hn', 'devto', 'other'];
/** The longest title each community takes (Reddit 300, Show HN 80, dev.to 128); another place has none. */
export const TITLE_MAX = { reddit: 300, hn: 80, devto: 128 };
const MAX_ROWS = 500;

export const sha = (text) => createHash('sha256').update(String(text)).digest('hex');
/** A stable MK- ref from what makes an item itself (product, slug, a hub id): the same input, the same ref. */
export function refFor(seed) {
  const h = createHash('sha256').update(String(seed)).digest();
  let out = '';
  for (let i = 0; i < 6; i++) out += B32[h[i] % 32];
  return `MK-${out}`;
}
/** A UUID derived from a seed: the hub's request_id for a write that must not happen twice. */
export function uuidFor(seed) {
  const h = sha(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const textHash = (t) => sha(String(t ?? '').trim());
/** The hash of a social post's words and link: what an approval covers. */
export const postHash = (text, link) => textHash(String(text ?? '') + '\n' + (link ?? ''));
/** The hash of one blog language: title, summary and body. */
export const blogHash = (title, summary, body) => sha([title ?? '', summary ?? '', String(body ?? '').trim()].join('\n'));
/** The hash of a community post (title and body) and of a newsletter (subject, preheader, body): what an approval covers. */
export const communityHash = (title, body) => sha(['community', title ?? '', String(body ?? '').trim()].join('\n'));
export const newsletterHash = (subject, preheader, body) => sha(['newsletter', subject ?? '', preheader ?? '', String(body ?? '').trim()].join('\n'));
/** The local id of a part that has no hub id (a hand-off post, a community post, a newsletter): one per item and language. */
export const localId = (ref, lang) => `${ref}.${lang}`;

// ---------- products ----------

/** Products from products.json, else from what the hub and the store know. */
export async function loadProducts({ root, hubSites = [], campaignProducts = [] } = {}) {
  if (root) {
    try {
      const raw = JSON.parse(await readText(root, 'products.json', 64 * 1024));
      const list = (Array.isArray(raw) ? raw : raw?.products ?? []).filter(p => p && typeof p.id === 'string' && PRODUCT_ID.test(p.id)).slice(0, 12);
      if (list.length) return list.map(normalProduct);
    } catch (e) {
      if (e instanceof MarketingError && e.code === 'path_refused') throw e;
    }
  }
  const ids = [...new Set([...hubSites, ...campaignProducts].filter(id => typeof id === 'string' && PRODUCT_ID.test(id)))].slice(0, 12);
  return ids.map(id => normalProduct({ id }));
}
/** How a product's blog is published: its own setting, else through the hub when there is one and to the site folder when not. */
export const blogMode = (prod, hub) => prod?.blog ?? (hub ? 'hub' : 'folder');
export function normalProduct(p) {
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : p.id;
  const mark = typeof p.mark === 'string' && p.mark.trim() ? p.mark.trim().slice(0, 3) : markOf(name);
  // blog: "hub" (the hub posts it), {dir} (approved posts are written as Markdown into that folder), "none"; unset is the
  // way the desk runs (hub with a hub, the default folder without one).
  const dir = typeof p.blog?.dir === 'string' && p.blog.dir.trim() ? p.blog.dir.trim() : typeof p.blog_dir === 'string' && p.blog_dir.trim() ? p.blog_dir.trim() : null;
  const blog = p.blog === 'hub' ? 'hub' : p.blog === 'none' ? 'none' : (p.blog && typeof p.blog === 'object') || dir ? 'folder' : null;
  const langs = Array.isArray(p.langs) ? [...new Set(p.langs.filter(l => LANGS.has(l)))] : [];
  return { id: p.id, name, mark, site: typeof p.site === 'string' ? p.site.slice(0, 80) : null, hub_site: typeof p.hub_site === 'string' ? p.hub_site : p.id, video_channels: Array.isArray(p.video_channels) ? p.video_channels.filter(c => typeof c === 'string' && SLUG.test(c)).slice(0, 12) : [],
    // Accounts the product has on a channel the hub may not know yet ("Chưa nối" rather than "Chưa có tài khoản").
    accounts: Object.fromEntries(['x', 'facebook', 'tiktok'].filter(ch => typeof p.accounts?.[ch] === 'string' && p.accounts[ch].trim()).map(ch => [ch, p.accounts[ch].trim().slice(0, 80)])),
    blog, blog_dir: blog === 'none' || blog === 'hub' ? dir : dir ?? `${p.id}/site/posts`,
    targets: (Array.isArray(p.targets) ? p.targets : []).map(normalTarget).filter(Boolean).slice(0, 10),
    changelog: typeof p.changelog === 'string' && p.changelog.trim() ? p.changelog.trim().slice(0, 200) : null,
    langs: langs.length ? langs : null,
    newsletter: p.newsletter === true || p.channels?.newsletter === true };
}
/** A community target {id, kind, sub?, name?, rules?}, or null when it is not one. */
export function normalTarget(t) {
  if (!t || typeof t !== 'object' || !TARGET_KINDS.includes(t.kind)) return null;
  const sub = t.kind === 'reddit' && typeof t.sub === 'string' && /^[A-Za-z0-9_]{2,21}$/.test(t.sub.replace(/^\/?r\//, '')) ? t.sub.replace(/^\/?r\//, '') : null;
  if (t.kind === 'reddit' && !sub) return null;
  const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : null;
  if (t.kind === 'other' && !name) return null;
  const id = typeof t.id === 'string' && /^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(t.id) ? t.id : t.kind === 'reddit' ? `reddit:${sub.toLowerCase()}` : t.kind === 'other' ? `other:${slugify(name)}` : t.kind;
  return { id, kind: t.kind, ...(sub ? { sub } : {}), ...(name ? { name } : {}), ...(typeof t.rules === 'string' && t.rules.trim() ? { rules: t.rules.trim().slice(0, 300) } : {}) };
}
/** A target's proper name, as the founder knows it ("r/selfhosted", "Hacker News"). */
export const targetLabel = (t) => (!t ? null : t.kind === 'reddit' ? `r/${t.sub}` : t.kind === 'hn' ? 'Hacker News' : t.kind === 'devto' ? 'dev.to' : t.name ?? null);

/** How many people a product's newsletter goes to: the lines of <product>/newsletter/subscribers.csv that hold an
 *  address, or null when there is no list. Only the count leaves this function, never an address. */
export async function subscriberCount(root, product) {
  if (!root || !PRODUCT_ID.test(product ?? '')) return null;
  try {
    const text = await readText(root, `${product}/newsletter/subscribers.csv`, 8 * 1024 * 1024);
    return text.split(/\r?\n/).filter(l => /[^\s,;"]+@[^\s,;"]+\.[^\s,;"]+/.test(l)).length;
  } catch (e) {
    return null;
  }
}
/** Where a folder blog's posts go: the chosen folder, else <product>/site/posts (created at the first write). */
export const blogDirOf = (p) => p.blog_dir ?? `${p.id}/site/posts`;
const VERSION_HEAD = /^#{1,3}\s*\[?v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)\]?.*$/m;
/** The newest release section of a CHANGELOG: {version, text} (text bounded), or null. */
export async function changelogSection(root, path, max = 6000) {
  if (!root || !path) return null;
  try {
    const text = await readText(root, path, 512 * 1024);
    const head = VERSION_HEAD.exec(text);
    if (!head) return null;
    const rest = text.slice(head.index + head[0].length);
    const next = /^#{1,3}\s*\[?v?\d+\.\d+/m.exec(rest);
    const body = (next ? rest.slice(0, next.index) : rest).trim();
    return { version: head[1], text: body.length > max ? `${body.slice(0, max)}\n…` : body };
  } catch { return null; }
}
/** The newest version a CHANGELOG names ("## [0.9.0]" or "## 0.9.0"), or null. */
export async function changelogVersion(root, path) {
  if (!root || !path) return null;
  try {
    const text = await readText(root, path, 512 * 1024);
    return /^#{1,3}\s*\[?v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)\]?/m.exec(text)?.[1] ?? null;
  } catch { return null; }
}
const markOf = (name) => {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  if (/^\d/.test(name)) return name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).replace(/^./, c => c.toUpperCase());
};

// ---------- the index ----------

const fileMeta = async (root, rel) => {
  const text = await readText(root, rel, 2 * 1024 * 1024);
  return { text, sha: sha(text) };
};
const parseJSON = (text) => { try { return JSON.parse(text); } catch { return null; } };
const STAGE_DIR = /^(\d\d)-([a-z0-9-]+)$/;

/** The radar table of a radar file: header, rows [{n, cells}], the Onboard? column index. */
export function radarTable(text) {
  const lines = String(text).split('\n');
  let header = null, at = -1, col = -1;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) { if (header && rows.length) break; continue; }
    const cells = splitRow(line);
    if (!header) { header = cells; at = i; col = cells.findIndex(c => /^onboard\??$/i.test(c.trim())); continue; }
    if (cells.every(c => /^:?-{3,}:?$/.test(c.trim()))) continue;
    const n = Number.parseInt(cells[0], 10);
    rows.push({ line: i, n: Number.isFinite(n) ? n : rows.length + 1, cells });
  }
  return { header, at, col, rows, lines };
}
function splitRow(line) {
  // A table row: cells between pipes; a pipe inside a link or code is rare in these files and kept as written.
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '', depth = 0;
  for (const ch of body) {
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
/** What an Onboard? cell says: yes, no or null (not decided), and the note after it. */
export function onboardOf(cell) {
  const t = String(cell ?? '').trim();
  const m = /^(có|co|yes|không|khong|no|_)?\s*(.*)$/i.exec(t);
  const word = (m?.[1] ?? '').toLowerCase();
  const value = ['có', 'co', 'yes'].includes(word) ? 'yes' : ['không', 'khong', 'no'].includes(word) ? 'no' : null;
  return { value, note: (m?.[2] ?? '').trim() };
}

/** A CSV line split on commas, honouring double quotes. */
export function csvSplit(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
/** videos.csv rows as objects keyed by the header (English or Vietnamese names), plus a few common keys. */
export function videoRows(text) {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { header: [], rows: [] };
  const header = csvSplit(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const cells = csvSplit(l);
    const o = Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
    return { ...o, _posted: o.posted ?? o.ngay_dang ?? '', _slug: o.slug ?? '', _platform: (o.platform ?? o.nen_tang ?? '').toLowerCase(), _url: o.url ?? '', _views7: num(o.views_7d), _views48: num(o.views_48h), _series: o.series ?? '' };
  });
  return { header, rows };
}
const num = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : Number.isFinite(Number(String(v).replace(/[^\d.-]/g, ''))) ? Number(String(v).replace(/[^\d.-]/g, '')) : null);

/** Every library file the desk indexes, as rows of the `library` table. Reads only small files. */
/** A campaign folder name as a title: "hook-test-1" reads "Hook test 1" (the founder never sees a bare slug). */
export const slugTitle = (slug) => { const w = String(slug ?? '').replace(/[-_]+/g, ' ').trim(); return w ? w[0].toUpperCase() + w.slice(1) : String(slug ?? ''); };
const VIDEO_FILE = /\.(mp4|mov|m4v|webm)$/i;
/** The TikTok cut mvf delivered (08-delivery/<cut>/tiktok/): its video file and caption.txt, library-relative. */
async function tiktokDelivery(root, base) {
  for (const cut of (await list(root, base)).filter(x => x.dir).slice(0, 8)) {
    const dir = `${base}/${cut.name}/tiktok`;
    const files = await list(root, dir).catch(() => []);
    const video = files.find(f => !f.dir && VIDEO_FILE.test(f.name));
    if (!video) continue;
    const caption = files.some(f => f.name === 'caption.txt') ? (await readText(root, `${dir}/caption.txt`, 16 * 1024).catch(() => '')).trim().slice(0, 4000) : '';
    return { file: `${dir}/${video.name}`, caption: caption || null };
  }
  return null;
}

export async function collect(root) {
  const rows = [];
  const products = await loadProducts({ root });
  const channelProduct = new Map();
  for (const p of products) for (const c of p.video_channels) channelProduct.set(c, p.id);
  if (await exists(root, 'products.json')) {
    const f = await fileMeta(root, 'products.json');
    rows.push({ path: 'products.json', kind: 'products', product: null, channel: null, series: null, campaign: null, title: 'products.json', sha: f.sha, ref: null, meta: { count: products.length, products } });
  }
  for (const p of await list(root, 'content')) {
    if (!p.dir || !PRODUCT_ID.test(p.name)) continue;
    for (const d of await list(root, `content/${p.name}`)) {
      if (!d.dir) continue;
      const dir = `content/${p.name}/${d.name}`;
      const names = (await list(root, dir)).filter(e => !e.dir).map(e => e.name);
      if (!names.includes('meta.json')) continue;
      const f = await fileMeta(root, `${dir}/meta.json`);
      const meta = parseJSON(f.text);
      if (!meta || !ITEM_REF.test(meta.ref ?? '')) continue;
      rows.push({ path: `${dir}/meta.json`, kind: 'item', product: meta.product ?? p.name, channel: null, series: meta.series ?? null, campaign: meta.campaign ?? null, title: String(meta.title ?? d.name).slice(0, 300), sha: f.sha, ref: meta.ref, meta: { ...meta, dir, files: names.slice(0, 40) } });
    }
  }
  for (const c of await list(root, 'channels')) {
    if (!c.dir) continue;
    const ch = c.name, base = `channels/${ch}`;
    const camps = [];
    for (const e of await list(root, `${base}/campaigns`)) {
      if (!e.dir) continue;
      const dir = `${base}/campaigns/${e.name}`;
      const entries = await list(root, dir);
      const cj = entries.some(x => x.name === 'campaign.json') ? await fileMeta(root, `${dir}/campaign.json`).catch(() => null) : null;
      const json = cj ? parseJSON(cj.text) ?? {} : {};
      const stages = entries.filter(x => x.dir && STAGE_DIR.test(x.name)).map(x => x.name).sort();
      const delivery = stages.includes('08-delivery') ? (await list(root, `${dir}/08-delivery`)).map(x => x.name).slice(0, 20) : [];
      // How long a video has waited for its hand-off is the delivery folder's age, not when the desk indexed it.
      const delivered_at = delivery.length ? await mtimeOf(root, `${dir}/08-delivery`) : null;
      const tiktok = delivery.length ? await tiktokDelivery(root, `${dir}/08-delivery`) : null;
      const owner = entries.some(x => x.name === 'owner.json') ? parseJSON(await readText(root, `${dir}/owner.json`, 64 * 1024).catch(() => '')) : null;
      camps.push(json.product);
      rows.push({ path: `${dir}/campaign.json`, kind: 'campaign', product: typeof json.product === 'string' ? json.product : null, channel: ch, series: typeof json.series === 'string' ? json.series : null, campaign: e.name, title: String(json.title || slugTitle(json.slug ?? e.name)).slice(0, 300), sha: cj?.sha ?? null, ref: refFor(`video:${ch}/${e.name}`),
        meta: { platforms: Array.isArray(json.platforms) ? json.platforms.slice(0, 8) : [], delivered_at, goal: json.goal ?? null, languages: json.languages ?? null, stages, delivery, owner: owner && typeof owner === 'object' ? { approved: owner.approved ?? owner.ok ?? null, note: typeof owner.note === 'string' ? owner.note.slice(0, 500) : null, at: owner.at ?? null } : null, ai_label: json.ai_label ?? json.label_ai ?? null, ...(tiktok ? { tiktok } : {}) } });
    }
    const product = channelProduct.get(ch) ?? majority(camps);
    for (const r of rows) if (r.channel === ch && r.kind === 'campaign' && !r.product) r.product = product;
    for (const e of await list(root, `${base}/pack/series`)) {
      if (e.dir || !/\.(json|md)$/.test(e.name) || e.name.startsWith('_')) continue;
      const f = await fileMeta(root, `${base}/pack/series/${e.name}`);
      const json = e.name.endsWith('.json') ? parseJSON(f.text) ?? {} : {};
      const series = e.name.replace(/\.(json|md)$/, '');
      rows.push({ path: `${base}/pack/series/${e.name}`, kind: 'series', product, channel: ch, series, campaign: null, title: String(json.title ?? json.name ?? series).slice(0, 300), sha: f.sha, ref: null, meta: { about: typeof json._about === 'string' ? json._about.slice(0, 400) : null } });
    }
    for (const e of await list(root, `${base}/radar`)) {
      if (e.dir || !/^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) continue;
      const f = await fileMeta(root, `${base}/radar/${e.name}`);
      const t = radarTable(f.text);
      const marks = t.col >= 0 ? t.rows.map(r => onboardOf(r.cells[t.col]).value) : [];
      rows.push({ path: `${base}/radar/${e.name}`, kind: 'radar', product, channel: ch, series: null, campaign: null, title: e.name.replace(/\.md$/, ''), sha: f.sha, ref: null, meta: { rows: t.rows.length, yes: marks.filter(v => v === 'yes').length, no: marks.filter(v => v === 'no').length } });
    }
    if (await exists(root, `${base}/metrics/videos.csv`)) {
      const f = await fileMeta(root, `${base}/metrics/videos.csv`);
      const v = videoRows(f.text);
      rows.push({ path: `${base}/metrics/videos.csv`, kind: 'metrics', product, channel: ch, series: null, campaign: null, title: 'videos.csv', sha: f.sha, ref: null, meta: { rows: v.rows.length, posted: v.rows.filter(r => /^https:\/\//.test(r._url)).length, slugs: v.rows.slice(-200).map(r => ({ slug: r._slug || null, script: r.script || r.loai || null, posted: r._posted || null, url: /^https:\/\//.test(r._url) ? r._url : null, views_7d: r._views7, series: r._series || null })) } });
    }
  }
  return rows;
}
const majority = (list) => {
  const n = new Map();
  for (const v of list) if (typeof v === 'string' && v) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** Refresh the `library` index from disk: insert new paths, update changed ones, drop the gone (planned items stay). */
export async function library_scan(input, { store, env, now, fetch: fetchImpl, soot }) {
  const lr = await libraryRoot(env);
  if (!lr.ok) return lr.error === 'not_configured' ? skippedFor('MARKETING_ROOT') : { ok: false, error: { code: `library_${lr.error}`, message: 'MARKETING_ROOT is not a readable folder.' } };
  const { fresh, added, changed, removed } = await refreshIndex(store, lr.root, now);
  // U10: hub drafts of a product site that no library item names show as "chưa có tệp".
  const hubOnly = [];
  if (hubBinding(env).ok && input?.hub !== false) {
    const products = await loadProducts({ root: lr.root });
    const named = new Set(fresh.filter(r => r.kind === 'item').flatMap(r => (r.meta.langs ?? []).map(l => `${l.site}/${l.slug}`)));
    for (const p of products) {
      const res = await hubCall(env, 'cms_list', { site: p.hub_site, limit: 50 }, { fetchImpl, soot });
      if (!res.ok) continue;
      for (const post of res.data.posts ?? []) if (!named.has(`${p.hub_site}/${post.slug}`)) hubOnly.push({ product: p.id, site: p.hub_site, slug: post.slug, title: post.title, status: post.status });
    }
  }
  return { ok: true, files: fresh.length, added, changed, removed, hub_only: hubOnly.slice(0, 50), hub_only_count: hubOnly.length, notify: false, wake: false };
}

/** Refresh the index rows from disk (no hub). */
export async function refreshIndex(store, root, now) {
  const fresh = await collect(root);
  if (fresh.length > MAX_ROWS) fresh.length = MAX_ROWS;
  const old = await store.query('library', [], { order: 'path', desc: false, limit: MAX_ROWS });
  const byPath = new Map(old.map(r => [r.path, r]));
  const seen = new Set();
  let added = 0, changed = 0, removed = 0;
  const stamp = new Date(now).toISOString();
  for (const r of fresh) {
    seen.add(r.path);
    const prev = byPath.get(r.path);
    // A planned item keeps what the desk recorded (state, plan) over what an older meta.json says.
    if (r.kind === 'item' && prev?.meta) r.meta = { ...r.meta, state: newer(prev.meta, r.meta).state ?? r.meta.state };
    const row = { ...r, mtime: stamp };
    if (!prev) { try { await store.insert('library', row); added++; } catch (e) { if (e.code !== 'conflict') throw e; } continue; }
    if (prev.sha !== r.sha || JSON.stringify(prev.meta) !== JSON.stringify(r.meta) || prev.product !== r.product) { await store.update('library', [eq('path', r.path)], row); changed++; }
  }
  for (const r of old) if (!seen.has(r.path) && !(r.kind === 'item' && r.meta?.planned)) { await store.remove('library', [eq('path', r.path)]); removed++; }
  return { fresh, added, changed, removed };
}
const newer = (a, b) => (String(a.updated_at ?? '') > String(b.updated_at ?? '') ? a : b);

// ---------- items: create (desk) and item_save (Writer) ----------

/** The folder of an item: content/<product>/<day>-<slug>. */
export const itemDir = (product, day, slug) => `content/${product}/${day}-${slug}`;
export const slugify = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'muc';

/** The library row of an item, by ref. */
export async function itemRow(store, ref) {
  return store.one('library', [eq('ref', ref), eq('kind', 'item')]);
}

/** Record or refresh an item's row (and its meta.json when the library is set). */
export async function putItem(store, root, meta, { now }) {
  const path = `${meta.dir}/meta.json`;
  meta.updated_at = new Date(now).toISOString();
  let digest = null;
  if (root) {
    const { dir, files, ...file } = meta;
    const text = JSON.stringify(file, null, 2) + '\n';
    await writeText(root, path, text);
    digest = sha(text);
  }
  const row = { path, kind: 'item', product: meta.product, channel: null, series: meta.series ?? null, campaign: meta.campaign ?? null, title: String(meta.title ?? '').slice(0, 300), mtime: meta.updated_at, sha: digest, ref: meta.ref, meta: { ...meta, planned: !root } };
  const prev = await store.one('library', [eq('path', path)]);
  if (prev) await store.update('library', [eq('path', path)], row);
  else { try { await store.insert('library', row); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('library', [eq('path', path)], row); } }
  return row;
}

const str = (v, n, field) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail('invalid_request', `${field} is text.`);
  const t = v.trim();
  if (t.length > n) fail('invalid_request', `${field} is at most ${n} characters.`);
  return t || null;
};

/**
 * item_save: the Writer saves one item (a blog in one or two languages and the social posts made from it, a social
 * post on its own, a community post, a newsletter, or a launch pack: blog + X + Show HN): the files under
 * content/<product>/<day>-<slug>/ and, when MARKETING_HUB is set and the product's blog goes through it, the hub
 * drafts (cms_save per language, social_queue / social_update per post). Community posts and newsletters never go to
 * the hub. Effect-keyed: the same content saved again changes nothing; a changed text moves the item's revision (and
 * the hub revision), which withdraws an approval in waiting. `pretest` records a Micro Fish verdict on the revision.
 */
// ---------- file_read ----------
// The team reads the founder's own words (brand.md, notes, CHANGELOG, products.json) from the library with this, and
// nothing else: confined to MARKETING_ROOT by the root helpers (no `..`, no link that leaves it), never a dot-file
// or node_modules (where secrets and dependencies live), text only, and bounded per call. A folder answers its names.
export const FILE_READ_MAX = 256 * 1024;
const READ_CHUNK = 48 * 1024;

/** file_read {path, offset?, max_chars?}: {ok, path, text, size, offset, next_offset|null} or, for a folder, {ok, path, entries}. */
export async function file_read(input, { env }) {
  const lr = await libraryRoot(env);
  if (!lr.ok) {
    if (lr.error === 'not_configured') return needsCredential('MARKETING_ROOT', 'Chưa đặt thư mục marketing nên đội chưa đọc được tệp nào.');
    fail(`library_${lr.error}`, 'MARKETING_ROOT is not a readable folder.');
  }
  const rel = typeof input?.path === 'string' ? input.path.trim().replace(/^\.\/+/, '').replace(/\/+$/, '') : '';
  if (!rel || rel === '.') {
    return { ok: true, path: '', entries: (await list(lr.root)).slice(0, 200).map(e => (e.dir ? `${e.name}/` : e.name)) };
  }
  const parts = segments(rel);
  if (parts.some(p => p.startsWith('.') || p === 'node_modules')) fail('path_refused', `"${rel}" is a hidden file or inside a hidden folder; the team does not read those.`);
  const entries = await list(lr.root, rel).catch(e => { if (e instanceof MarketingError) throw e; return []; });
  if (entries.length) return { ok: true, path: rel, entries: entries.slice(0, 200).map(e => (e.dir ? `${e.name}/` : e.name)) };
  // A folder that exists and holds nothing readable answers no names; it is not a missing file.
  if ((await stat(await resolveInside(lr.root, rel)).catch(() => null))?.isDirectory()) return { ok: true, path: rel, entries: [] };
  const text = await readText(lr.root, rel, FILE_READ_MAX);
  if (text.includes('\0')) fail('not_text', `${rel} is not a text file.`);
  const offset = Number.isInteger(input?.offset) && input.offset > 0 ? input.offset : 0;
  const max = Number.isInteger(input?.max_chars) ? Math.min(Math.max(input.max_chars, 1), READ_CHUNK) : READ_CHUNK;
  const end = Math.min(text.length, offset + max);
  return { ok: true, path: rel, size: text.length, offset, text: text.slice(offset, end), next_offset: end < text.length ? end : null };
}

export async function item_save(input, { store, env, now, fetch: fetchImpl, soot }) {
  const lr = await libraryRoot(env);
  if (!lr.ok) fail('needs_credential', 'item_save writes the library: set MARKETING_ROOT (Cài đặt › Kết nối) first.');
  const product = str(input.product, 32, 'product');
  if (!product || !PRODUCT_ID.test(product)) fail('invalid_request', 'product is a product id (products.json).');
  const products = await loadProducts({ root: lr.root, hubSites: [product] });
  const prod = products.find(p => p.id === product);
  if (!prod) fail('invalid_request', `product "${product}" is not in products.json.`);
  let existing = null;
  if (input.ref !== undefined) {
    if (!ITEM_REF.test(input.ref)) fail('invalid_request', 'ref is MK-XXXXXX.');
    existing = await itemRow(store, input.ref);
    if (!existing) fail('not_found', `No item ${input.ref}; leave ref out to start one.`);
  }
  const slug = str(input.slug, 80, 'slug') ?? existing?.meta?.slug ?? null;
  if (!slug || !SLUG.test(slug)) fail('invalid_request', 'slug is lower-case words joined by "-" (a-z, 0-9).');
  // Saving the same product and slug again without a ref updates that item, never a second copy.
  if (!existing) existing = await itemRow(store, refFor(`item:${product}:${slug}`));
  // A save that names no format keeps the item's own (a pre-test verdict on a community post stays a community post).
  const format = input.format ?? existing?.meta?.format ?? 'blog';
  if (!FORMATS.has(format)) fail('invalid_request', `format is ${[...FORMATS].join(', ')}.`);
  const langs = Array.isArray(input.langs) ? input.langs : [];
  const posts = Array.isArray(input.posts) ? input.posts : [];
  if (langs.length > 2 || posts.length > 8) fail('invalid_request', 'At most 2 languages and 8 posts.');
  if (['community', 'newsletter'].includes(format) && (langs.length || posts.length)) fail('invalid_request', `A ${format} item has no langs or posts; send ${format} {…}.`);
  if (input.community !== undefined && !['community', 'launch'].includes(format)) fail('invalid_request', 'community is the Show HN / community part of a community or launch item.');
  if (input.newsletter !== undefined && format !== 'newsletter') fail('invalid_request', 'newsletter belongs to a newsletter item.');
  const first = !existing || (!(existing.meta?.langs ?? []).length && !(existing.meta?.posts ?? []).length && !existing.meta?.community && !existing.meta?.newsletter);
  if (format === 'blog' && !langs.length && !existing) fail('invalid_request', 'A blog item needs langs [{lang, title, summary, body}].');
  if (format === 'community' && input.community === undefined && first) fail('invalid_request', 'A community item needs community {target, title, body}.');
  if (format === 'newsletter' && input.newsletter === undefined && first) fail('invalid_request', 'A newsletter item needs newsletter {subject, preheader, body}.');
  const seenLang = new Set();
  const L = langs.map((l, i) => {
    if (!LANGS.has(l?.lang) || seenLang.has(l.lang)) fail('invalid_request', `langs[${i}].lang is vi or en, once each.`);
    seenLang.add(l.lang);
    const title = str(l.title, 200, `langs[${i}].title`), summary = str(l.summary, 500, `langs[${i}].summary`) ?? '', body = typeof l.body === 'string' ? l.body : '';
    if (!title || !body.trim()) fail('invalid_request', `langs[${i}] needs title and body.`);
    if (Buffer.byteLength(body) > 40000) fail('invalid_request', `langs[${i}].body is over 40000 bytes.`);
    // One language keeps the item slug; a pair gives each language its own (…-vi, …-en), as the hub asks.
    const kept = existing?.meta?.langs?.find(x => x.lang === l.lang)?.slug;
    const lslug = str(l.slug, 80, `langs[${i}].slug`) ?? kept ?? (langs.length > 1 ? `${slug}-${l.lang}` : slug);
    if (!SLUG.test(lslug)) fail('invalid_request', `langs[${i}].slug is lower-case words joined by "-".`);
    return { lang: l.lang, title, summary, body, slug: lslug, hash: blogHash(title, summary, body) };
  });
  const seenPost = new Set();
  const P = posts.map((p, i) => {
    if (!SOCIAL.has(p?.channel)) fail('invalid_request', `posts[${i}].channel is x, facebook, tiktok or reddit.`);
    if (!LANGS.has(p.lang)) fail('invalid_request', `posts[${i}].lang is vi or en.`);
    const key = `${p.channel}.${p.lang}`;
    if (seenPost.has(key)) fail('invalid_request', `One ${p.channel} post per language (${key} twice).`);
    seenPost.add(key);
    const text = str(p.text, 5000, `posts[${i}].text`);
    if (!text) fail('invalid_request', `posts[${i}].text is required.`);
    const link = str(p.link, 500, `posts[${i}].link`);
    if (link && !/^https:\/\//.test(link)) fail('invalid_request', `posts[${i}].link is an https:// link.`);
    return { channel: p.channel, lang: p.lang, text, link, key, hash: postHash(text, link) };
  });
  const prior = existing?.meta ?? {};
  const C = input.community === undefined ? null : communityInput(input.community, { prod, prior, format });
  const N = input.newsletter === undefined ? null : newsletterInput(input.newsletter, prior);
  const T = input.pretest === undefined ? undefined : pretestInput(input.pretest);
  // waiting: the one question the team cannot go on without the founder's answer (asked in Cần bạn too). null clears it.
  if (input.waiting !== undefined && input.waiting !== null && (typeof input.waiting !== 'string' || !input.waiting.trim() || input.waiting.length > 300)) fail('invalid_request', 'waiting is the question for the founder (1 to 300 characters), or null once answered.');
  const Q = input.waiting === undefined ? undefined : input.waiting === null ? null : input.waiting.trim();
  const day = prior.day ?? localDay(now, TZ);
  const ref = existing?.ref ?? refFor(`item:${product}:${slug}`);
  const dir = prior.dir ?? itemDir(product, day, slug);
  // What moved: a new or changed part is a new revision of the item; the same words again are not.
  const was = (list, k) => list.find(k)?.hash ?? null;
  const changed = L.some(l => was(prior.langs ?? [], x => x.lang === l.lang) !== l.hash)
    || P.some(p => was(prior.posts ?? [], x => x.channel === p.channel && x.lang === p.lang) !== p.hash)
    || (C && prior.community?.hash !== C.hash) || (N && prior.newsletter?.hash !== N.hash);
  const revision = changed ? (prior.revision ?? 0) + 1 : prior.revision ?? (first ? null : 1);
  const meta = {
    ...prior, ref, product, format, slug, day, dir,
    title: L[0]?.title ?? C?.title ?? N?.subject ?? str(input.title, 200, 'title') ?? prior.title ?? P[0]?.text.slice(0, 80) ?? slug,
    series: str(input.series, 80, 'series') ?? prior.series ?? null,
    campaign: str(input.campaign, 80, 'campaign') ?? prior.campaign ?? null,
    source: input.source && typeof input.source === 'object' ? { title: str(input.source.title, 200, 'source.title'), url: str(input.source.url, 500, 'source.url') } : prior.source ?? null,
    // A save of a pre-test verdict or a question alone keeps the item where it stands; any other save is the Writer drafting.
    state: prior.state === 'stopped' && input.reopen !== true ? 'stopped' : changed || (T === undefined && Q === undefined) || !prior.state ? 'drafting' : prior.state,
    created_at: prior.created_at ?? new Date(now).toISOString(),
    by: prior.by ?? (typeof soot === 'string' ? soot : null),
    langs: prior.langs ?? [], posts: prior.posts ?? [],
    ...(revision ? { revision } : {}),
  };
  if (meta.state === 'stopped') fail('stopped', `${ref} was stopped on the desk; only the Editor reopens it (item_save with reopen: true after the founder asked).`);
  // Files first: the library is the source, the hub mirrors it.
  for (const l of L) await writeText(lr.root, `${dir}/${l.lang}.md`, `---\ntitle: ${JSON.stringify(l.title)}\nsummary: ${JSON.stringify(l.summary)}\nslug: ${l.slug}\n---\n\n${l.body.trim()}\n`);
  for (const p of P) await writeText(lr.root, `${dir}/${p.channel}.${p.lang}.txt`, p.text + (p.link ? `\n\n${p.link}\n` : '\n'));
  if (C) await writeText(lr.root, `${dir}/community.md`, `---\ntitle: ${JSON.stringify(C.title)}\ntarget: ${JSON.stringify(targetLabel(C.target))}\n---\n\n${C.body.trim()}\n`);
  if (N?.body) await writeText(lr.root, `${dir}/newsletter.md`, `---\nsubject: ${JSON.stringify(N.subject)}\npreheader: ${JSON.stringify(N.preheader ?? '')}\n---\n\n${N.body.trim()}\n`);
  const hub = hubBinding(env).ok;
  // A product whose blog is a site folder (or none) keeps its blog off the hub: approved posts are written to the folder.
  const hubBlog = hub && !['folder', 'none'].includes(prod.blog);
  const site = prod.hub_site;
  const hubNotes = [];
  // A part saved only as files has a local revision: the item's, from the save that last changed it.
  const local = (old, hash) => ({ revision: old.hash === hash && Number.isInteger(old.revision) ? old.revision : revision, local: true });
  for (const l of L) {
    const old = meta.langs.find(x => x.lang === l.lang) ?? {};
    const entry = { ...old, lang: l.lang, title: l.title, slug: l.slug, site, file: `${l.lang}.md`, hash: l.hash };
    if (hubBlog && old.hash !== l.hash) {
      const res = await hubCall(env, 'cms_save', { site, slug: l.slug, request_id: uuidFor(`cms_save:${site}:${l.slug}:${l.hash}`), expected_revision: old.local ? 0 : old.revision ?? 0, title: l.title, summary: l.summary, body_markdown: l.body.trim(), language: l.lang, status: 'draft' }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot });
      if (!res.ok) fail(res.error === 'refused' ? 'hub_refused' : `hub_${res.error}`, `The hub did not save ${site}/${l.slug}: ${res.message ?? res.error}. The files are saved; save again after fixing it.`);
      entry.revision = res.data.revision;
      entry.preview_url = res.data.preview_url ?? null;
      entry.status = res.data.status;
      delete entry.local;
    } else if (!hubBlog) { Object.assign(entry, local(old, l.hash)); hubNotes.push(`${l.lang}: ${hub ? `the ${prod.blog} blog stays off the hub` : 'no hub'}, saved as files only`); }
    meta.langs = [...meta.langs.filter(x => x.lang !== l.lang), entry];
  }
  const blogFor = (lang) => meta.langs.find(x => x.lang === lang) ?? meta.langs[0];
  for (const p of P) {
    const old = meta.posts.find(x => x.channel === p.channel && x.lang === p.lang) ?? {};
    const entry = { ...old, channel: p.channel, lang: p.lang, file: `${p.channel}.${p.lang}.txt`, hash: p.hash, link: p.link };
    if (hub && old.hash !== p.hash) {
      const blog = blogFor(p.lang);
      const res = old.id
        ? await hubCall(env, 'social_update', { id: old.id, expected_revision: old.revision, text: p.text, link: p.link ?? null, status: 'draft' }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot })
        : await hubCall(env, 'social_queue', { request_id: uuidFor(`social_queue:${ref}:${p.key}:${p.hash}`), channel: p.channel, language: p.lang, text: p.text, ...(p.link ? { link: p.link } : {}), ...(blog && !blog.local ? { source: { site: blog.site, slug: blog.slug } } : {}) }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot });
      if (!res.ok) fail(res.error === 'refused' ? 'hub_refused' : `hub_${res.error}`, `The hub did not take the ${p.channel} ${p.lang} post: ${res.message ?? res.error}. The files are saved; save again after fixing it.`);
      const post = res.data.post ?? {};
      entry.id = post.id ?? old.id;
      entry.revision = post.revision;
      entry.status = post.status;
      delete entry.local;
    } else if (!hub) Object.assign(entry, local(old, p.hash));
    meta.posts = [...meta.posts.filter(x => !(x.channel === p.channel && x.lang === p.lang)), entry];
  }
  if (C) meta.community = { ...(prior.community ?? {}), ...C, file: 'community.md', id: prior.community?.id ?? localId(ref, C.lang), ...local(prior.community ?? {}, C.hash) };
  if (N) delete N.body;
  if (N) meta.newsletter = { ...(prior.newsletter ?? {}), ...N, file: 'newsletter.md', ...local(prior.newsletter ?? {}, N.hash), ...(N.sending ? { sending_at: new Date(now).toISOString() } : {}) };
  if (meta.newsletter) delete meta.newsletter.sending;
  if (T !== undefined) meta.pretest = T === null ? null : { ...T, at: new Date(now).toISOString(), revision: meta.revision ?? null };
  // New words without a question mean the answer came: the item is no longer waiting on the founder.
  if (Q) meta.waiting = { question: Q, at: prior.waiting?.question === Q ? prior.waiting.at : new Date(now).toISOString() };
  else if (Q === null || changed) delete meta.waiting;
  meta.channels = [...new Set([...(meta.langs.length ? ['blog'] : []), ...meta.posts.map(p => p.channel), ...(meta.community ? ['community'] : []), ...(meta.newsletter ? ['newsletter'] : [])])];
  // A changed text after a Từ chối is the Writer's revision: the desk shows it drafting again, not revising.
  if (changed) meta.revised_at = new Date(now).toISOString();
  await putItem(store, lr.root, meta, { now });
  return {
    ok: true, ref, dir, product, format, revision: meta.revision ?? null,
    blog: meta.langs.map(l => ({ lang: l.lang, site: l.site, slug: l.slug, revision: l.revision ?? null, preview_url: l.preview_url ?? null, ...(l.local ? { local: true } : {}) })),
    social: meta.posts.map(p => ({ channel: p.channel, lang: p.lang, id: p.id ?? null, revision: p.revision ?? null, ...(p.local ? { local: true } : {}) })),
    ...(meta.community ? { community: { lang: meta.community.lang, target: meta.community.target, revision: meta.community.revision } } : {}),
    ...(meta.newsletter ? { newsletter: { lang: meta.newsletter.lang, revision: meta.newsletter.revision } } : {}),
    ...(meta.waiting ? { waiting: meta.waiting.question } : {}),
    ...(hubNotes.length ? { notes: hubNotes } : {}),
    next: hub ? `Saved. The Editor reviews ${ref} and asks the founder once with publish_bundle.` : `Saved as files. With no hub the Editor still asks once with publish_bundle (revision ${meta.revision ?? 1}, no hub ids); approved blogs are written to the site folder and the rest is the founder's hand-off.`,
  };
}

function communityInput(c, { prod, prior, format }) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('invalid_request', 'community is {target, title, body, lang?}.');
  const lang = c.lang ?? prior.community?.lang ?? (format === 'launch' ? 'en' : prod.langs?.[0] ?? 'vi');
  if (!LANGS.has(lang)) fail('invalid_request', 'community.lang is vi or en.');
  const target = targetOf(c.target, prod, prior.community?.target ?? prior.target ?? null) ?? prior.community?.target ?? prior.target ?? (format === 'launch' ? { id: 'hn', kind: 'hn' } : prod.targets[0] ?? null);
  if (!target) fail('invalid_request', `community.target is one of ${prod.id}'s targets (${prod.targets.map(t => t.id).join(', ') || 'none yet'}) or {kind: "other", name}.`);
  const title = str(c.title, 300, 'community.title');
  const body = typeof c.body === 'string' ? c.body : '';
  if (!title || !body.trim()) fail('invalid_request', 'community needs title and body.');
  if (Buffer.byteLength(body) > 20000) fail('invalid_request', 'community.body is over 20000 bytes.');
  const max = TITLE_MAX[target.kind] ?? null;
  if (max && [...title].length > max) fail('invalid_request', `community.title is at most ${max} characters for ${targetLabel(target)}.`);
  return { lang, target, title, body: body.trim(), title_max: max, hash: communityHash(title, body) };
}
/** A target the input names: a target id of the product, or {kind, sub?, name?}. */
export function targetOf(v, prod, prior = null) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const t = prod.targets.find(x => x.id === v) ?? (v === 'hn' || v === 'devto' ? { id: v, kind: v } : prior?.id === v ? prior : null);
    if (!t) fail('invalid_request', `target "${v}" is not one of ${prod.id}'s targets (${prod.targets.map(x => x.id).join(', ') || 'none yet'}).`);
    return t;
  }
  const t = normalTarget(v);
  if (!t) fail('invalid_request', 'target is a target id, or {kind: reddit, sub} | {kind: hn} | {kind: devto} | {kind: other, name}.');
  return t;
}
function newsletterInput(n, prior) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) fail('invalid_request', 'newsletter is {subject, preheader?, body, lang?}.');
  const old = prior.newsletter ?? {};
  const lang = n.lang ?? old.lang ?? 'vi';
  if (!LANGS.has(lang)) fail('invalid_request', 'newsletter.lang is vi or en.');
  const subject = str(n.subject, 200, 'newsletter.subject') ?? old.subject ?? null;
  const preheader = n.preheader === undefined ? old.preheader ?? null : str(n.preheader, 200, 'newsletter.preheader');
  const body = typeof n.body === 'string' ? n.body : null;
  if (!subject) fail('invalid_request', 'newsletter.subject is required.');
  if (body === null && !old.hash) fail('invalid_request', 'newsletter.body is required.');
  if (body !== null && (!body.trim() || Buffer.byteLength(body) > 40000)) fail('invalid_request', 'newsletter.body is 1 to 40000 bytes.');
  // `sending: true` is the Editor's note that it asked email send for the approved newsletter; it changes no words.
  if (body === null) return { lang, subject: old.subject, preheader: old.preheader ?? null, hash: old.hash, sending: n.sending === true, body: null };
  return { lang, subject, preheader, body: body.trim(), hash: newsletterHash(subject, preheader, body), sending: n.sending === true };
}
const PRETEST_STATES = ['asked', 'done', 'failed', 'unavailable'];
function pretestInput(t) {
  if (t === null) return null;
  if (!t || typeof t !== 'object' || !PRETEST_STATES.includes(t.state)) fail('invalid_request', `pretest.state is ${PRETEST_STATES.join(', ')}.`);
  if (t.verdict !== undefined && !['go', 'fix', 'stop'].includes(t.verdict)) fail('invalid_request', 'pretest.verdict is go, fix or stop.');
  const int = (v, lo, hi, k) => { if (v === undefined || v === null) return undefined; if (!Number.isFinite(v) || v < lo || v > hi) fail('invalid_request', `pretest.${k} is a number from ${lo} to ${hi}.`); return v; };
  const out = { state: t.state };
  if (t.verdict) out.verdict = t.verdict;
  const n = int(t.n, 1, 10000, 'n'), score = int(t.score, 0, 10, 'score');
  if (n !== undefined) out.n = Math.round(n);
  if (score !== undefined) out.score = Math.round(score * 10) / 10;
  if (Array.isArray(t.reasons)) out.reasons = t.reasons.filter(r => typeof r === 'string' && r.trim()).slice(0, 3).map(r => r.trim().slice(0, 300));
  if (typeof t.conversation_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(t.conversation_id)) out.conversation_id = t.conversation_id;
  if (typeof t.reason === 'string' && /^[a-z_]{1,32}$/.test(t.reason)) out.reason = t.reason;
  return out;
}

/** What the desk asks the Editor for a new item. One function: a resend from the item sheet says the same words. */
export function askText({ ref, to, format, product, topic, channels = [], series = null, target = null, source = null, changelog = null, notes = null }) {
  const who = to === 'builder' ? 'Builder' : 'Writer';
  const what = { blog: 'bài blog', social: 'bài mạng xã hội', video: 'video', community: 'bài cộng đồng', newsletter: 'bản tin', launch: 'gói ra mắt (blog, X và Show HN)' }[format];
  return [
    `Giao ${who} làm ${what} cho ${product} (${ref}): ${topic}`,
    channels.length ? `Kênh: ${channels.join(', ')}.` : null,
    series ? `Series: ${series}.` : null,
    target ? `Nơi đăng: ${targetLabel(target)}${target.rules ? ` (luật: ${target.rules})` : ''}. Lưu bằng item_save community {target: ${JSON.stringify(target.id ?? target)}, title, body}.` : null,
    format === 'newsletter' ? `Nguồn: ${source === 'topic' ? 'chủ đề trên' : 'những gì đã lên trong tuần'}. Lưu bằng item_save newsletter {subject, preheader, body}.` : null,
    format === 'launch' ? `Nguồn: ${changelog ? `CHANGELOG ${changelog}` : 'ghi chú phát hành'}, chép ở cuối việc này. Chỉ viết điều ghi chú nói. Lưu blog (langs), bài X (posts) và Show HN (community) trong cùng một mục.` : null,
    to === 'writer' ? `Writer lưu bằng item_save với ref ${ref}, rồi Editor xem và xin duyệt một lần bằng publish_bundle.` : `Builder dựng theo series và để video trong thư mục chiến dịch; tôi đăng TikTok bằng tay.`,
    format === 'launch' && notes ? `Ghi chú phát hành:\n${notes}` : null,
  ].filter(Boolean).join('\n');
}

// ---------- library view ----------

/** The library tree: per product (Bài viết, then each video channel's series, campaigns, radars, numbers), then "Kênh khác". */
export function libraryTree(rows, products) {
  const known = new Set(products.map(p => p.id));
  const byChannel = new Map();
  for (const r of rows) if (r.channel) { if (!byChannel.has(r.channel)) byChannel.set(r.channel, []); byChannel.get(r.channel).push(r); }
  const channelNode = (ch, list) => ({
    id: `channel:${ch}`, kind: 'channel', label: ch, children: [
      ...list.filter(r => r.kind === 'series').map(r => ({ id: `series:${ch}/${r.series}`, kind: 'series', label: r.title, count: list.filter(c => c.kind === 'campaign' && c.series === r.series).length })),
      ...(list.some(r => r.kind === 'campaign') ? [{ id: `campaigns:${ch}`, kind: 'campaigns', label: null, count: list.filter(r => r.kind === 'campaign').length }] : []),
      ...list.filter(r => r.kind === 'radar').sort((a, b) => b.title.localeCompare(a.title)).slice(0, 8).map(r => ({ id: `radar:${ch}/${r.title}`, kind: 'radar', label: r.title, count: r.meta?.rows ?? 0 })),
      ...list.filter(r => r.kind === 'metrics').map(() => ({ id: `metrics:${ch}`, kind: 'metrics', label: null, count: null })),
    ],
  });
  const productOfChannel = (ch) => {
    const fromProducts = products.find(p => p.video_channels.includes(ch))?.id;
    if (fromProducts) return fromProducts;
    const own = byChannel.get(ch).find(r => r.product)?.product;
    return own && known.has(own) ? own : null;
  };
  const tree = products.map(p => ({
    id: `product:${p.id}`, kind: 'product', product: p.id, label: p.name, children: [
      { id: `posts:${p.id}`, kind: 'posts', label: null, count: rows.filter(r => r.kind === 'item' && r.product === p.id).length },
      ...[...byChannel.keys()].filter(ch => productOfChannel(ch) === p.id).sort().map(ch => channelNode(ch, byChannel.get(ch))),
    ],
  }));
  const others = [...byChannel.keys()].filter(ch => !productOfChannel(ch)).sort();
  if (others.length) tree.push({ id: 'other', kind: 'other', product: null, label: null, children: others.map(ch => channelNode(ch, byChannel.get(ch))) });
  return tree;
}

const NODE = /^(product|posts|channel|series|campaigns|campaign|radar|metrics|other):?([A-Za-z0-9._/-]{0,160})$/;
/** One node's detail: posts | series | campaigns | campaign | radar | metrics. Reads at most one file. */
export async function libraryDetail(node, { rows, root, items = [] }) {
  const m = NODE.exec(String(node ?? ''));
  if (!m) fail('invalid_request', 'node is an id from the library tree.');
  const [, kind, key] = m;
  if (key.split('/').some(p => p === '..' || p === '.')) fail('invalid_request', 'node is an id from the library tree.');
  const [ch, rest] = key.includes('/') ? [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)] : [key, ''];
  if (kind === 'posts') return { kind: 'posts', product: key, items: items.filter(i => i.product === key).slice(0, 60) };
  if (kind === 'campaigns' || kind === 'series') {
    const list = rows.filter(r => r.kind === 'campaign' && r.channel === ch && (kind === 'campaigns' || r.series === rest)).map(campaignRow);
    const series = kind === 'series' ? rows.find(r => r.kind === 'series' && r.channel === ch && r.series === rest) : null;
    return { kind, channel: ch, series: series ? { id: rest, title: series.title, about: series.meta?.about ?? null, path: series.path } : null, campaigns: list };
  }
  if (kind === 'campaign') {
    const r = rows.find(x => x.kind === 'campaign' && x.channel === ch && x.campaign === rest);
    if (!r) fail('not_found', 'That campaign is not in the library index; run library_scan.');
    return { kind: 'campaign', channel: ch, ...campaignRow(r) };
  }
  if (kind === 'radar') {
    const r = rows.find(x => x.kind === 'radar' && x.channel === ch && x.title === rest);
    if (!r) fail('not_found', 'That radar is not in the library index; run library_scan.');
    if (!root) return { kind: 'radar', channel: ch, date: rest, file: r.path, rows: null, why: 'library' };
    const t = radarTable(await readText(root, r.path));
    const cell = (cells, i) => (i >= 0 ? cells[i] ?? '' : '');
    const h = (re) => (t.header ?? []).findIndex(x => re.test(x));
    const ci = { title: h(/tên/i), genre: h(/thể loại/i), signal: h(/tín hiệu/i), length: h(/độ dài/i), kind: h(/kiểu/i) };
    return {
      kind: 'radar', channel: ch, date: rest, file: r.path, columns: t.header,
      rows: t.rows.slice(0, 120).map(x => ({ n: x.n, title: plain(cell(x.cells, ci.title >= 0 ? ci.title : 1)), genre: plain(cell(x.cells, ci.genre)), signal: plain(cell(x.cells, ci.signal)), length: plain(cell(x.cells, ci.length)), kind: plain(cell(x.cells, ci.kind)), onboard: onboardOf(cell(x.cells, t.col)).value, note: onboardOf(cell(x.cells, t.col)).note, link: firstLink(cell(x.cells, ci.title >= 0 ? ci.title : 1)) })),
    };
  }
  if (kind === 'metrics') {
    const r = rows.find(x => x.kind === 'metrics' && x.channel === ch);
    if (!r || !root) return { kind: 'metrics', channel: ch, rows: [], why: r ? 'library' : 'none' };
    const v = videoRows(await readText(root, r.path));
    return { kind: 'metrics', channel: ch, file: r.path, rows: v.rows.slice(-60).reverse().map(x => ({ posted: x._posted || null, series: x._series || null, slug: x._slug || null, platform: x._platform || null, url: /^https:\/\//.test(x._url) ? x._url : null, views_48h: x._views48, views_7d: x._views7 })) };
  }
  if (kind === 'channel') return { kind: 'channel', channel: key, counts: countKinds(rows.filter(r => r.channel === key)) };
  if (kind === 'product') return { kind: 'product', product: key, counts: countKinds(rows.filter(r => r.product === key)) };
  return { kind: 'other', counts: countKinds(rows.filter(r => r.channel && !r.product)) };
}
const countKinds = (rows) => Object.fromEntries(['item', 'series', 'campaign', 'radar', 'metrics'].map(k => [k, rows.filter(r => r.kind === k).length]));
function campaignRow(r) {
  const m = r.meta ?? {};
  return { id: r.campaign, title: r.title, product: r.product, series: r.series, path: r.path.replace(/\/campaign\.json$/, ''), platforms: m.platforms ?? [], stages: m.stages ?? [], delivered: (m.delivery ?? []).length > 0, owner: m.owner ?? null, ai_label: m.ai_label ?? null, ref: r.ref };
}
const plain = (s) => String(s ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
const firstLink = (s) => /\]\((https:\/\/[^)\s]+)\)/.exec(String(s ?? ''))?.[1] ?? null;

/** mark: write the Onboard? cell of one radar row (yes, no, or null to clear). Idempotent. */
export async function markRadar(root, file, row, onboard) {
  const parts = segments(file);
  if (parts.length !== 4 || parts[0] !== 'channels' || parts[2] !== 'radar' || !/^\d{4}-\d{2}-\d{2}\.md$/.test(parts[3])) fail('invalid_request', 'file is channels/<channel>/radar/<yyyy-mm-dd>.md.');
  if (!Number.isInteger(row) || row < 1 || row > 500) fail('invalid_request', 'row is the # of a radar row.');
  if (![null, 'yes', 'no'].includes(onboard)) fail('invalid_request', 'onboard is yes, no or null.');
  const text = await readText(root, file);
  const t = radarTable(text);
  if (t.col < 0) fail('conflict', 'That radar has no Onboard? column.');
  const r = t.rows.find(x => x.n === row);
  if (!r) fail('not_found', `No row ${row} in ${file}.`);
  const { value, note } = onboardOf(r.cells[t.col]);
  if (value === onboard) return { ok: true, row, onboard, changed: false };
  const word = onboard === 'yes' ? 'Có' : onboard === 'no' ? 'Không' : '_';
  const cells = r.cells.slice();
  cells[t.col] = note ? `${word} ${note}` : word;
  const lines = t.lines.slice();
  lines[r.line] = `| ${cells.join(' | ')} |`;
  await writeText(root, file, lines.join('\n'));
  return { ok: true, row, onboard, changed: true };
}

/** confirm on a video hand-off: append the posted link to the channel's videos.csv once. */
export async function appendVideo(root, channel, { slug, script, series, url, posted }) {
  if (!SLUG.test(channel)) fail('invalid_request', 'channel is a library channel.');
  const file = `channels/${channel}/metrics/videos.csv`;
  let text = '';
  try { text = await readText(root, file); } catch (e) { if (e.code !== 'not_found') throw e; }
  const v = videoRows(text);
  if (v.rows.some(r => r._url === url)) return { changed: false, file, row: 'same' };
  const header = v.header.length ? v.header : ['posted', 'series', 'slug', 'script', 'platform', 'url'];
  const value = (h) => ({ posted, ngay_dang: posted, series, slug, script, platform: 'tiktok', nen_tang: 'tiktok', url, loai: 'short' })[h] ?? '';
  // A row the Builder wrote for this video before it went up (same slug, no link yet) is filled in, not doubled.
  const lines = String(text).split(/\r?\n/);
  const at = v.header.length ? v.rows.findIndex(r => r._slug === slug && !r._url && (!r._platform || r._platform === 'tiktok')) : -1;
  if (at >= 0) {
    const r = v.rows[at];
    const cells = header.map(h => csvCell(h === 'url' ? url : (h === 'posted' || h === 'ngay_dang') && !r[h] ? posted : r[h] ?? ''));
    const idx = lines.map((l, i) => [l, i]).filter(([l]) => l.trim()).map(([, i]) => i)[at + 1];
    lines[idx] = cells.join(',');
    await writeText(root, file, lines.join('\n').replace(/\s*$/, '\n'));
    return { changed: true, file, row: 'updated' };
  }
  const line = header.map(h => csvCell(value(h))).join(',');
  const body = (v.header.length ? text.replace(/\s*$/, '\n') : header.join(',') + '\n') + line + '\n';
  await writeText(root, file, body);
  return { changed: true, file, row: 'added' };
}
