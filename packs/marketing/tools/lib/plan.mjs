// The content engine's daily plan (friction W1). One tool, two calls:
//   {wake: true, ...config}  tool-only schedule: is a blog slot free? Wakes the Writer only then.
//   {}                       the woken Writer: the ready brief (topic, keyword, real novels, links).
// Product facts come from the catalog the recipe names; nothing is guessed.
// Friction r2 adds, all inside this one tool and none of them a model turn:
//   - a `ready` draft nobody scheduled is scheduled here after an hour (it used to hold the plan forever);
//   - once a blog post is published, one draft per signed-in, unpaused social channel is asked of the Writer;
//   - the next topic is chosen by how the published posts did (insight.mjs).
import { eq } from './store.mjs';
import { nextSlot, localDay, DEFAULT_QUIET } from './time.mjs';
import { getSettings, setSetting, takenTimes, facts_sync, seo_brief, channel, schedule } from './ops.mjs';
import { fold, platformOf, defaultsFor } from './guard.mjs';
import { performance, rank, topPosts } from './insight.mjs';
import { targetOf } from './campaign.mjs';
import { keptSignals } from './radar.mjs';

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

/**
 * A topic the company loop handed to the wake call (`input.query` with `wake`): kept until a post
 * is written about it (or 48 hours pass), so the Writer's own plan call, which carries no query,
 * sees the same one even when the blog slot opens later.
 */
async function keepTopic(store, input, now, posts) {
  const kept = (await store.one('settings', [eq('key', 'plan_topic')]))?.value;
  const live = kept?.query && now - Date.parse(kept.at) < 48 * HOUR && !posts.some(p => fold(p.brief?.keyword ?? '') === fold(kept.query));
  if (input.wake && input.query && !live) { await setSetting(store, 'plan_topic', { query: input.query, at: iso(now) }); return input.query; }
  return live ? kept.query : null;
}

/** The keyword and id of the newest article posts (at most 20), for the company loop to match a handed topic against. */
function writtenKeywords(posts) {
  return posts.filter(p => p.brief?.keyword).slice(0, 20).map(p => ({ keyword: String(p.brief.keyword), post: p.ref }));
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

/** A draft the Editor passed (`ready`) but nobody put in the queue, older than an hour: schedule it now. */
async function rescueReady(store, ch, now, deps) {
  const out = [];
  const stuck = (await store.query('posts', [eq('channel', ch.key), eq('state', 'ready')], { order: 'updated_at', limit: 10 })).filter(p => p.kind === 'article' && now - Date.parse(p.updated_at) >= HOUR);
  for (const p of stuck) {
    try { out.push({ id: p.ref, ...(await schedule({ id: p.ref }, deps)) }); } catch (e) { out.push({ id: p.ref, error: e.code ?? 'failed' }); }
  }
  return out;
}

/** The social channels that may post now: social, not paused, and the whole team not paused. */
async function liveSocial(store, settings) {
  if (settings.paused_all) return [];
  return (await store.query('channels', [], { limit: 50 })).filter(c => c.kind === 'social' && !c.paused);
}

/**
 * Published blog posts (last 7 days) with no draft yet on a live social channel: one item per post,
 * the newest first, one channel-draft per channel. Nothing at all while every channel is paused or
 * signed out, so the Writer is never woken for work that cannot go out.
 */
export async function socialPending(store, cfg, settings, now) {
  const live = await liveSocial(store, settings);
  if (!live.length) return [];
  const blog = (await store.query('posts', [eq('channel', cfg.channel ?? 'blog-lohi'), eq('state', 'published')], { order: 'updated_at', limit: 20 }))
    .filter(p => p.kind === 'article' && p.url && now - Date.parse(p.updated_at) < 7 * DAY);
  const have = new Set();
  for (const c of live) for (const p of await store.query('posts', [eq('channel', c.key)], { order: 'updated_at', limit: 100 })) if (p.brief?.from) have.add(`${p.brief.from}:${c.key}`);
  const items = [];
  for (const b of blog) {
    const channels = live.filter(c => !have.has(`${b.ref}:${c.key}`)).map(c => {
      const platform = c.platform ?? platformOf(c.key);
      const rules = { ...(defaultsFor(c.key)?.rules ?? {}), ...(c.rules ?? {}) };
      return { channel: c.key, platform, account: c.account ?? null, link: targetOf(b.url, `blog-${b.brief?.slug ?? b.ref}`, c.key),
        max_chars: rules.max_chars ?? null, link_chars: rules.link_chars ?? null, subreddits: rules.subreddits ?? undefined, kind: 'social' };
    });
    if (channels.length) items.push({ post: b.ref, title: b.brief?.title ?? b.title, summary: short(b.brief?.meta, 160), url: b.url, keyword: b.brief?.keyword ?? null, channels });
  }
  return items;
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

const BASIS = { gsc: 'Search Console', utm: 'số chiến dịch' };
function insightNote(perf, r, pick, angle) {
  const top = topPosts(perf, 3).map(p => ({ title: p.title, clicks: p.clicks, impressions: p.impressions }));
  const v = r.value(pick.g, angle);
  const why = r.losers.length && r.losers.includes(pick.g) ? 'Mọi thể loại khác đã viết rồi; lặp lại thể loại này.'
    : v > 0 ? `${pick.g} (${angle === 'new' ? 'mới cập nhật' : angle === 'full' ? 'full' : 'hay'}) đang được đọc nhiều nhất trong các bài đã đăng.` : `Chưa thử ${pick.g} theo hướng này.`;
  return { basis: BASIS[perf.basis], top, avoid: r.losers, why };
}

async function pickTopic(store, cfg, posts, now, fetch, input = {}) {
  const cat = cfg.catalog;
  const perf = await performance(store, cfg.channel ?? 'blog-lohi', now);
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
    // 2. Rotation: genre by genre, three angles each, skipping a keyword already written ...
    const cands = [];
    for (let i = 0; i < genres.length * GENRE_TOPICS.length; i++) {
      const n = idx + i, g = genres[n % genres.length];
      const t = GENRE_TOPICS[Math.floor(n / genres.length) % GENRE_TOPICS.length](g);
      if (!used.has(fold(t.keyword))) cands.push({ t, g, i });
    }
    // ... ordered by how the published posts did: a genre and angle that earned clicks first, one never
    // tried next, one written twice to no effect last. Without numbers the rotation order stands.
    const r = rank(perf, genres);
    const angleOf = t => (/\bmới\b/.test(t.keyword) ? 'new' : /\bfull\b/.test(t.keyword) ? 'full' : 'hay');
    cands.sort((a, b) => (r.value(b.g, angleOf(b.t)) - r.value(a.g, angleOf(a.t))) || a.i - b.i);
    const pick = cands[0];
    if (pick) {
      topic = { ...pick.t, source: perf.basis === 'none' ? 'catalog' : 'insight', genre: pick.g };
      if (perf.basis !== 'none') brief.insight = insightNote(perf, r, pick, angleOf(pick.t));
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

/** Pending social items worth a wake now: not yet woken for, or woken more than 6 hours ago (at most twice). */
async function socialToWake(store, cfg, settings, now) {
  const items = await socialPending(store, cfg, settings, now);
  const seen = (await store.one('settings', [eq('key', 'social_wake')]))?.value ?? {};
  return items.filter(it => it.channels.some(c => {
    const w = seen[`${it.post}:${c.channel}`];
    return !w || (w.n < 2 && now - Date.parse(w.at) >= 6 * HOUR);
  }));
}
async function stampSocial(store, items, now) {
  const seen = (await store.one('settings', [eq('key', 'social_wake')]))?.value ?? {};
  for (const it of items) for (const c of it.channels) {
    const k = `${it.post}:${c.channel}`;
    seen[k] = { at: iso(now), n: (seen[k]?.n ?? 0) + 1 };
  }
  // Keep the memory small: only the last 60 keys.
  const keys = Object.keys(seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete seen[k];
  await setSetting(store, 'social_wake', seen);
}

export async function plan(input, deps) {
  const { store, now, fetch } = deps;
  const cfg = await planConfig(store, input);
  const ch = await channel(store, cfg.channel ?? 'blog-lohi');
  const settings = await getSettings(store);
  const tz = (settings.quiet_hours ?? DEFAULT_QUIET).tz;
  const today = localDay(now, tz);

  if (input.wake) {
    // The guard's facts are refreshed daily here, so no separate facts schedule is needed.
    const facts = await keepFactsFresh(store, cfg, now, fetch);
    // A draft that passed and was never queued is queued here: no model, no waiting for a person.
    const scheduled = await rescueReady(store, ch, now, deps);
    const social = await socialToWake(store, cfg, settings, now);
    const why = await slotVerdict(store, ch, settings, now, cfg.depth ?? 1);
    const recent = await recentPosts(store, ch.key);
    await keepTopic(store, input, now, recent);
    // The posts' keywords, so the company loop can tell a handed topic is written (topic_sync); read before anything is kept.
    const topicPosts = writtenKeywords(recent);
    const posted = topicPosts.length ? { topic_posts: topicPosts } : {};
    const stamp = (await store.one('settings', [eq('key', 'plan_wake')]))?.value;
    const extra = { ...(scheduled.length ? { scheduled } : {}), ...(social.length ? { social: social.length } : {}) };
    const slotFree = !why && stamp?.day !== today;
    if (!slotFree && !social.length) {
      if (!why) return { wake: false, notify: false, slot: false, code: 'planned_today', reason: 'Hôm nay đã gọi Writer một lần.', ...extra, ...posted };
      return { wake: false, notify: false, slot: false, ...why, ...extra, ...posted };
    }
    if (slotFree) await setSetting(store, 'plan_wake', { day: today, at: iso(now) });
    if (social.length) await stampSocial(store, social, now);
    return { wake: true, notify: true, slot: slotFree, ...(social.length ? { kind: slotFree ? 'blog+social' : 'social' } : { kind: 'blog' }), ...extra, ...posted, ...facts };
  }

  const posts = await recentPosts(store, ch.key);
  const f = await keepFactsFresh(store, cfg, now, fetch);
  const social = await socialPending(store, cfg, settings, now);
  // A social-only call (the blog has no free slot): the posts to share, no new article to write.
  if (social.length && !input.query && await slotVerdict(store, ch, settings, now, cfg.depth ?? 1)) {
    return { channel: ch.key, date: today, mode: 'social', social, ...f, note: 'Không viết bài blog mới. Mỗi mục trong social: một bản nháp cho từng kênh (kind social, link đúng như đã cho, brief.from là mã bài blog), rồi check và schedule.' };
  }
  const handed = input.query ? null : await keepTopic(store, input, now, posts);
  const { topic, novels, brief } = await pickTopic(store, cfg, posts, now, fetch, handed ? { ...input, query: handed } : input);
  const links = [...novels.map(n => n.url), ...(cfg.catalog?.links ?? [])].filter(Boolean);
  return {
    channel: ch.key, series: ch.rules?.series ?? 'truyen-hay', date: today,
    topic: topic.title, keyword: topic.keyword, angle: topic.angle, source: topic.source, genre: topic.genre,
    novels, internal_links: [...new Set(links)].slice(0, 8),
    avoid: posts.slice(0, 8).map(p => short(p.brief?.title ?? p.title, 70)).filter(Boolean),
    ...f, ...brief,
    ...(social.length ? { social } : {}),
    // Market signals the Radar kept (an angle readers ask about); the Writer may lean on one, never quotes it.
    ...await (async () => { const sig = await keptSignals(store); return sig.length ? { signals: sig } : {}; })(),
    note: novels.length ? undefined : 'Không có truyện cụ thể: viết bài tổng quan, không nêu tên truyện nào ngoài danh sách, và chỉ dùng internal_links.',
  };
}
