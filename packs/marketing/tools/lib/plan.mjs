// The content engine's daily plan (friction W1). One tool, two calls:
//   {wake: true, ...config}  tool-only schedule: is a blog slot free? Wakes the Writer only then.
//   {}                       the woken Writer: the ready brief (topic, keyword, real novels, links).
// Product facts come from the catalog the recipe names; nothing is guessed.
import { eq } from './store.mjs';
import { nextSlot, localDay, DEFAULT_QUIET } from './time.mjs';
import { getSettings, setSetting, takenTimes, facts_sync, seo_brief, channel } from './ops.mjs';
import { fold } from './guard.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const OPEN = ['draft', 'checking', 'ready'];
const GENRE_TOPICS = [
  g => ({ title: `Truyện ${g} hay`, keyword: `truyện ${g.toLowerCase()} hay`, angle: 'Gợi ý vài bộ đang được đọc nhiều, mỗi bộ một lý do nên đọc.', sort: 'trending' }),
  g => ({ title: `Truyện ${g} mới cập nhật`, keyword: `truyện ${g.toLowerCase()} mới`, angle: 'Những bộ vừa có chương mới; nói rõ bộ nào đang ra, bộ nào đã đủ.', sort: 'new' }),
  g => ({ title: `Truyện ${g} full đã hoàn thành`, keyword: `truyện ${g.toLowerCase()} full`, angle: 'Bộ đã hoàn thành, đọc một mạch không phải chờ chương.', sort: 'trending', completed: true }),
];

/** The plan settings the schedule gave (kept for the woken Writer, who calls without them). */
async function planConfig(store, input) {
  const saved = (await store.one('settings', [eq('key', 'plan')]))?.value ?? {};
  const cfg = { ...saved };
  for (const k of ['channel', 'facts_url', 'catalog', 'depth']) if (input[k] !== undefined) cfg[k] = input[k];
  if (input.wake && JSON.stringify(cfg) !== JSON.stringify(saved)) await setSetting(store, 'plan', cfg);
  return cfg;
}

const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

async function getJSON(fetch, url, timeout = 15_000) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/** The catalog's novel rows, normalized; works on Lohi's feed shape and a plain {slug,title}. */
export function novelOf(n, cat) {
  const slug = n.slug;
  return {
    title: n.titleVi ?? n.title,
    author: n.authorNameVi ?? n.authorVi ?? n.author ?? null,
    slug,
    url: String(cat.page ?? '').replace('{slug}', slug),
    genres: n.genres ?? [],
    chapters: n.totalChapters ?? n.chapters ?? null,
    status: n.completionStatus ?? null,
    words: n.totalWords ?? null,
    reads: n.readCount ?? null,
    summary: short(n.synopsis, 150) || null,
  };
}

const slugsIn = text => new Set([...String(text ?? '').matchAll(/\/truyen\/([a-z0-9-]+)/g)].map(m => m[1]));

async function recentPosts(store, chKey) {
  return (await store.query('posts', [eq('channel', chKey)], { order: 'updated_at', limit: 60 })).filter(p => p.kind === 'article');
}

/** Why no slot is free (null when one is). All quiet reasons are plain Vietnamese. */
async function slotVerdict(store, ch, settings, now, depth) {
  if (settings.paused_all) return { code: 'paused_all', reason: 'Đang tạm dừng đăng mọi kênh.' };
  const posts = await recentPosts(store, ch.key);
  const open = posts.find(p => OPEN.includes(p.state) && now - Date.parse(p.updated_at) < DAY);
  if (open) return { code: 'draft_open', reason: `Đã có bài ${open.ref} đang ${open.state === 'ready' ? 'chờ xếp lịch' : 'viết dở'}; chưa viết thêm.` };
  const { times } = await takenTimes(store, ch.key, now, null, 'publish');
  const queued = await store.query('queue', [eq('channel', ch.key)], { limit: 50 });
  if (queued.filter(q => (q.action ?? 'publish') === 'publish').length >= depth) return { code: 'queued', reason: 'Đã có bài chờ đăng; chưa viết thêm.' };
  const refused = posts.filter(p => p.state === 'refused' && now - Date.parse(p.updated_at) < 36 * HOUR);
  if (refused.length >= 2) return { code: 'refused_streak', reason: `${refused.length} bài vừa bị từ chối (${refused[0].ref}: ${short(refused[0].reason, 80)}); dừng viết tới khi có người xem.` };
  const quiet = settings.quiet_hours ?? DEFAULT_QUIET;
  const at = nextSlot({ from: now, taken: times, cap: ch.cap_per_day ?? 1, spacingMin: ch.spacing_min ?? 0, quiet, horizonDays: 3 });
  if (at == null || at - now > 26 * HOUR) return { code: 'no_slot', reason: 'Kênh đã đủ bài; chưa có khung giờ trống trong 26 giờ tới.' };
  return null;
}

async function keepFactsFresh(store, cfg, now, fetch) {
  if (!cfg.facts_url) return { facts: 'no_source' };
  const facts = await store.query('facts', [], { limit: 1, order: 'fetched_at' });
  if (facts[0] && now - Date.parse(facts[0].fetched_at) < 20 * HOUR) return { facts: 'fresh' };
  try { await facts_sync({ url: cfg.facts_url }, { store, now, fetch }); return { facts: 'synced' }; } catch (e) { return { facts: 'unreadable', facts_error: short(e.message, 120) }; }
}

async function pickTopic(store, cfg, posts, now, fetch, input = {}) {
  const cat = cfg.catalog;
  const used = new Set(posts.map(p => fold(p.brief?.keyword ?? '')).filter(Boolean));
  const featured = new Set(posts.slice(0, 5).flatMap(p => [...slugsIn(p.body)]));
  const brief = {};
  let novels = [];
  // 1. A Search Console query close to page one, not yet written about.
  const seo = await seo_brief({}, { store, now });
  const q = seo.queries.find(x => !used.has(fold(x.query)));
  let genres = [];
  if (cat?.genres) { try { genres = (await getJSON(fetch, cat.genres)).filter(g => typeof g === 'string'); } catch { /* the rotation below copes */ } }
  const idx = posts.length;
  let topic;
  if (input.query) {
    // A requested subject ("viết về Tru Tiên"): the novels the catalog search finds for it.
    topic = { title: input.query, keyword: String(input.query).toLowerCase(), angle: `Bài về "${input.query}": nói đúng những gì danh mục cho biết về các bộ dưới đây.`, source: 'request', genre: null, sort: 'trending' };
    if (cat?.search) {
      try {
        const u = new URL(cat.search);
        u.searchParams.set('q', input.query); u.searchParams.set('limit', '6');
        const found = (await getJSON(fetch, u.toString())).matches ?? [];
        novels = found.filter(n => n.slug && n.hasChapters !== false).slice(0, 4).map(n => novelOf(n, cat));
      } catch (e) { brief.catalog_error = short(e.message, 120); }
    }
    return { topic, novels, brief };
  }
  if (q) {
    const hit = genres.find(g => fold(q.query).includes(fold(g)));
    topic = { title: q.query, keyword: q.query, angle: `Tìm kiếm "${q.query}" đang hiện ${q.impressions} lần, vị trí ${q.position ?? '?'}: bài trả lời đúng ý tìm.`, source: 'search_console', genre: hit ?? null, sort: 'trending' };
  } else if (genres.length) {
    // 2. Rotation: genre by genre, three angles each, skipping a keyword already written.
    for (let i = 0; i < genres.length * GENRE_TOPICS.length; i++) {
      const n = idx + i, g = genres[n % genres.length];
      const t = GENRE_TOPICS[Math.floor(n / genres.length) % GENRE_TOPICS.length](g);
      if (!used.has(fold(t.keyword))) { topic = { ...t, source: 'catalog', genre: g }; break; }
    }
  }
  if (cat?.feed && topic) {
    try {
      const url = new URL(cat.feed);
      url.searchParams.set('limit', '30');
      url.searchParams.set('sort', topic.sort ?? 'trending');
      if (topic.genre) url.searchParams.set('genres', topic.genre);
      let rows = await getJSON(fetch, url.toString());
      rows = rows.filter(n => n.slug && (n.access ?? 'open') === 'open' && (n.totalChapters ?? 1) > 0);
      if (topic.completed) rows = rows.filter(n => n.completionStatus === 'completed');
      const fresh = rows.filter(n => !featured.has(n.slug));
      novels = (fresh.length >= 3 ? fresh : rows).slice(0, 4).map(n => novelOf(n, cat));
    } catch (e) { brief.catalog_error = short(e.message, 120); }
  }
  if (!topic) topic = { title: 'Truyện hay nên đọc', keyword: 'truyện hay nên đọc', angle: 'Gợi ý chung; không nêu bộ cụ thể vì chưa đọc được danh mục.', source: 'default', genre: null };
  return { topic, novels, brief };
}

export async function plan(input, { store, now, fetch }) {
  const cfg = await planConfig(store, input);
  const ch = await channel(store, cfg.channel ?? 'blog-lohi');
  const settings = await getSettings(store);
  const tz = (settings.quiet_hours ?? DEFAULT_QUIET).tz;
  const today = localDay(now, tz);

  if (input.wake) {
    // The guard's facts are refreshed daily here, so no separate facts schedule is needed.
    const facts = await keepFactsFresh(store, cfg, now, fetch);
    const why = await slotVerdict(store, ch, settings, now, cfg.depth ?? 1);
    const stamp = (await store.one('settings', [eq('key', 'plan_wake')]))?.value;
    if (!why && stamp?.day === today) return { wake: false, notify: false, slot: false, code: 'planned_today', reason: 'Hôm nay đã gọi Writer một lần.' };
    if (why) return { wake: false, notify: false, slot: false, ...why };
    await setSetting(store, 'plan_wake', { day: today, at: iso(now) });
    return { wake: true, notify: true, slot: true, ...facts };
  }

  const posts = await recentPosts(store, ch.key);
  const f = await keepFactsFresh(store, cfg, now, fetch);
  const { topic, novels, brief } = await pickTopic(store, cfg, posts, now, fetch, input);
  const links = [...novels.map(n => n.url), ...(cfg.catalog?.links ?? [])].filter(Boolean);
  return {
    channel: ch.key, series: ch.rules?.series ?? 'truyen-hay', date: today,
    topic: topic.title, keyword: topic.keyword, angle: topic.angle, source: topic.source, genre: topic.genre,
    novels, internal_links: [...new Set(links)].slice(0, 8),
    avoid: posts.slice(0, 8).map(p => short(p.brief?.title ?? p.title, 70)).filter(Boolean),
    ...f, ...brief,
    note: novels.length ? undefined : 'Không có truyện cụ thể: viết bài tổng quan, không nêu tên truyện nào ngoài danh sách, và chỉ dùng internal_links.',
  };
}
