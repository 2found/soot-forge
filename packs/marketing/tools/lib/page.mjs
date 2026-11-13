// Bài viết and Hàng đợi page models (page_view) and their actions
// (page_action). Page tools are never approval-gated: pages refuse those.
import { fail, eq, gte } from './store.mjs';
import { briefLint, platformOf, defaultsFor, internalLinks, HOLD_LABEL } from './guard.mjs';
import { videoView } from './video.mjs';
import { STATE_LABEL, ANSWERS, channel, getSettings, schedule, pause, totals, record, clearAttention } from './ops.mjs';
import { localDayStart, DEFAULT_QUIET, inQuiet, nextSlot } from './time.mjs';
import { campaignView, campaign_save, readReport, noKey } from './campaign.mjs';

const DAY = 86_400_000;
export const TABS = {
  all: null,
  // Cần bạn: computed (failed, uncertain, late), see needsYou.
  need: [],
  draft: ['draft', 'checking'],
  ready: ['ready'],
  waiting: ['scheduled', 'publishing', 'unpublishing'],
  published: ['published'],
  refused: ['refused'],
  removed: ['pulled', 'removed'],
};
const CHANNEL_LABEL = { 'blog-lohi': 'Blog', x: 'X', facebook: 'Facebook', reddit: 'Reddit', hub: 'Hub' };
export const PAUSED_LABEL = { signed_out: 'chưa đăng nhập', layout_changed: 'giao diện đổi', captcha: 'cần captcha', person: 'bạn dừng', signed_in: 'đã đăng nhập, chờ Bật' };
const channelLabel = key => CHANNEL_LABEL[key] ?? CHANNEL_LABEL[platformOf(key)] ?? key;
const URL_RE = /https?:\/\/\S+/g;
/** A post's name: its title; a social post or reply reads as its own words, never blank. */
const title = p => p.brief?.title || p.title || String(p.body ?? '').replace(URL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 80) || String(p.ref ?? '');
/** A social post on a queue row: its words without the link, and whether it carries one. */
const socialText = p => (p.kind === 'social' ? { text: String(p.body ?? '').replace(URL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 100), has_link: /https?:\/\/\S/.test(String(p.body ?? '')) } : {});
/** Blog first, then X, Facebook, Reddit: the order the founder reads the channels in. */
const ORDER = ['blog', 'x', 'facebook', 'reddit'];
const rank = key => { const i = ORDER.indexOf(platformOf(key) === 'blog-lohi' ? 'blog' : platformOf(key)); return i < 0 ? ORDER.length : i; };
// Posters share one budget per view (each data URI is up to 200 KB), so page_view stays under its 1 MiB cap.
const POSTER_BUDGET = 600 * 1024;
async function videoBlocks(store, posts) {
  const refs = posts.filter(p => p.kind === 'video').map(p => p.ref).slice(0, 50);
  if (!refs.length) return {};
  const rows = await store.query('assets', [{ column: 'post', op: 'in', values: refs }], { limit: 300 });
  const out = {};
  let budget = POSTER_BUDGET;
  for (const ref of refs) {
    const v = videoView(rows.filter(a => a.post === ref));
    if (!v) continue;
    if (v.poster && (budget -= v.poster.length) < 0) v.poster = null;
    out[ref] = v;
  }
  return out;
}
const hold = p => (p.kind === 'video' && p.brief?.hold ? { hold: p.brief.hold, hold_label: HOLD_LABEL[p.brief.hold] ?? null } : {});

export async function metricsRows(store, now) {
  const since = [eq('source', 'gsc'), gte('day', new Date(now - 30 * DAY).toISOString().slice(0, 10))];
  const [days, queries] = await Promise.all([
    store.query('metrics', [...since, eq('query', '')], { limit: 500 }),
    store.query('metrics', [...since, { column: 'query', op: 'ne', value: '' }], { order: 'impressions', limit: 500 }),
  ]);
  return [...days, ...queries];
}

export async function page_view(input, { store, now, page, env, soot }) {
  const id = input.page ?? page;
  if (id === 'posts') return input.id ? postDetail(input.id, { store, now, soot }) : postList(input.filter, { store, now, soot });
  if (id === 'queue') return queueView({ store, now, soot });
  if (id === 'channels') return { ...(await queueView({ store, now, soot })), page: 'channels' };
  if (id === 'campaigns') return campaignView(input, { store, now, env, soot });
  fail('invalid_request', 'page is posts, queue, channels or campaigns.');
}

const HOUR = 3_600_000;
const DRAFT_STALL = 30 * 60_000;
/** An item whose time has long passed with nothing sent: it is never sent on its own (Bài lỡ giờ). */
const isLate = (q, now, staleH) => !!q && !q.intent_id && q.action !== 'unpublish' && now - Date.parse(q.scheduled_at) >= (staleH ?? 6) * HOUR;

/**
 * The one next step of a post, as a code the page words in Vietnamese: what Soot does and when, or the one
 * thing the person does. {code, at?, reason?, channel_id, channel, do?}. `do` is the primary button:
 * schedule, post_now, sign_in, resume_channel, resume_all, retry, ask_writer, confirm, open, restore.
 */
export function nextStep(p, q, ch, settings, now) {
  const at = q?.scheduled_at ?? null;
  const base = { channel_id: p.channel, channel: channelLabel(p.channel) };
  const held = !q?.intent_id && (settings.paused_all ? 'all' : ch?.paused ? ch.paused_reason ?? 'person' : null);
  switch (p.state) {
    case 'draft': case 'checking':
      // A Writer saves and Editor checks within minutes; a draft left this long has no one working on it.
      return now - Date.parse(p.updated_at) > DRAFT_STALL ? { ...base, code: 'draft_stale', do: 'ask_writer' } : { ...base, code: 'draft' };
    case 'refused': return { ...base, code: 'refused', do: 'ask_writer' };
    case 'ready': return { ...base, code: 'ready', do: 'schedule' };
    case 'pulled': return { ...base, code: 'pulled', do: 'restore' };
    case 'removed': return { ...base, code: 'removed', do: 'restore' };
    case 'unpublishing': return { ...base, code: 'unpublishing' };
    case 'published': return { ...base, code: 'published', at: p.updated_at, do: p.url ? 'open' : null };
    case 'uncertain': return { ...base, code: 'uncertain', do: 'confirm' };
    case 'publishing': return { ...base, code: 'in_flight' };
    case 'failed': return Date.parse(at) > now
      ? { ...base, code: 'failed_retry', at, reason: q?.wait_reason || p.reason, do: 'retry' }
      : { ...base, code: 'failed', reason: q?.wait_reason || p.reason, do: 'retry' };
    case 'scheduled': {
      if (q?.intent_id) return { ...base, code: 'in_flight' };
      if (isLate(q, now, settings.stale_after_h)) return { ...base, code: 'late', at, do: 'post_now' };
      if (held === 'all') return { ...base, code: 'paused_all', at, do: 'resume_all' };
      if (held === 'signed_out') return { ...base, code: 'signed_out', at, do: 'sign_in' };
      if (held === 'signed_in') return { ...base, code: 'signed_in', at, do: 'resume_channel' };
      if (held === 'person') return { ...base, code: 'person_paused', at, do: 'resume_channel' };
      if (held) return { ...base, code: 'channel_held', at, reason: PAUSED_LABEL[held] ?? held };
      if (q?.wait_reason) return { ...base, code: 'waiting', at, reason: q.wait_reason };
      // The slot has come but it is quiet hours (an Đăng ngay at night): promise the first moment Soot may post, not the past time.
      const quiet = settings.quiet_hours ?? DEFAULT_QUIET;
      if (at && Date.parse(at) <= now && inQuiet(now, quiet)) {
        const open = nextSlot({ from: now, quiet, cap: 1e9 });
        if (open) return { ...base, code: 'waiting', at: new Date(open).toISOString(), reason: `giờ yên ${quiet.from}–${quiet.to}` };
      }
      return { ...base, code: 'scheduled', at };
    }
  }
  return { ...base, code: 'other' };
}
/** What waits for the person in Bài viết: a failed or unsure post, a late one. */
const needsYou = (p, q, now, staleH) => ['failed', 'uncertain'].includes(p.state) || (p.state === 'scheduled' && isLate(q, now, staleH));

async function postList(filter = 'all', { store, now, soot }) {
  if (!(filter in TABS)) fail('invalid_request', 'Unknown filter.');
  const [posts, queue, metrics, settings, channels] = await Promise.all([
    store.query('posts', [], { order: 'updated_at', limit: 200 }),
    store.query('queue', [], { order: 'scheduled_at', limit: 200 }),
    metricsRows(store, now),
    getSettings(store),
    store.query('channels', [], { limit: 50 }),
  ]);
  const q = Object.fromEntries(queue.map(r => [r.post, r]));
  const chOf = Object.fromEntries(channels.map(c => [c.key, c]));
  const need = p => needsYou(p, q[p.ref], now, settings.stale_after_h);
  const inTab = (k, p) => (k === 'all' ? true : k === 'need' ? need(p) : TABS[k].includes(p.state) && !need(p));
  const counts = Object.fromEntries(Object.keys(TABS).map(k => [k, posts.filter(p => inTab(k, p)).length]));
  const shown = posts.filter(p => inTab(filter, p));
  return {
    page: 'posts', filter, counts, writer: settings.writer, product: settings.product, editor: soot ?? null,
    items: shown.slice(0, 100).map(p => ({
      id: p.ref, kind: p.kind, title: title(p), channel: channelLabel(p.channel), state: p.state, label: STATE_LABEL[p.state], reason: p.reason, url: p.url, ...hold(p),
      scheduled_at: q[p.ref]?.scheduled_at ?? null, wait_reason: q[p.ref]?.wait_reason ?? null, updated_at: p.updated_at,
      unpublishing: q[p.ref]?.action === 'unpublish', next: nextStep(p, q[p.ref], chOf[p.channel], settings, now), late: isLate(q[p.ref], now, settings.stale_after_h),
      metrics_28: p.state === 'published' ? totals(metrics, p.url, 28, now) : null,
    })),
  };
}

/** "4 (lohi2.com/novel/…, 1 bài blog)": how many internal links, one product link and the blog count. */
function linkSummary(links) {
  if (!links.length) return '0';
  const blog = links.filter(u => new URL(u).hostname.startsWith('blog.')).length;
  const other = links.map(u => new URL(u)).find(u => !u.hostname.startsWith('blog.'));
  const parts = [other && `${other.hostname}${other.pathname.split('/')[1] ? `/${other.pathname.split('/')[1]}` : ''}/…`, blog && `${blog} bài blog`].filter(Boolean);
  return `${links.length} (${parts.join(', ')})`;
}

async function postDetail(id, { store, now, soot }) {
  const p = await store.one('posts', [eq('ref', id)]);
  if (!p) fail('not_found', `Không có bài ${id}.`);
  const ch = await channel(store, p.channel);
  const [checks, metrics, settings, q] = await Promise.all([
    store.query('checks', [eq('post', p.ref)], { order: 'at', limit: 1 }),
    metricsRows(store, now),
    getSettings(store),
    store.one('queue', [eq('post', p.ref)]),
  ]);
  const lint = briefLint(p, ch);
  const b = p.brief ?? {};
  const series = b.series ?? ch?.rules?.series;
  const fields = p.kind === 'article' ? [
    { field: 'brief.keyword', label: 'Từ khóa', value: b.keyword ?? '' },
    { field: 'title', label: 'Tiêu đề', value: `${[...String(b.title ?? '')].length} ký tự`, rule: '30–60' },
    { field: 'meta', label: 'Mô tả (meta)', value: `${[...String(b.meta ?? '')].length} ký tự`, rule: '120–160' },
    { field: 'slug', label: 'Đường dẫn', value: b.slug ? (series ? `/${series}/${b.slug}/` : b.slug) : '' },
    { field: 'body', label: 'Liên kết nội bộ', value: linkSummary(internalLinks(p.body, ch?.rules?.internal_hosts ?? [])), rule: '≥2' },
  ].map(f => ({ ...f, ok: !lint.some(l => l.field === f.field), message: lint.find(l => l.field === f.field)?.message ?? null })) : [];
  const check = checks[0] ?? null;
  const queries = p.url ? metrics.filter(r => r.url === p.url && r.query).sort((a, b) => b.impressions - a.impressions).slice(0, 5).map(r => ({ query: r.query, position: r.position, impressions: r.impressions })) : [];
  return {
    page: 'posts', id: p.ref, writer: settings.writer, product: settings.product, editor: soot ?? null,
    post: { id: p.ref, title: title(p), kind: p.kind, channel: channelLabel(p.channel), state: p.state, label: STATE_LABEL[p.state], reason: p.reason, url: p.url, revision: p.revision, body: p.body, updated_at: p.updated_at,
      scheduled_at: q?.scheduled_at ?? null, late: isLate(q, now, settings.stale_after_h), next: nextStep(p, q, ch, settings, now), ...hold(p) },
    video: p.kind === 'video' ? (await videoBlocks(store, [p]))[p.ref] ?? null : null,
    brief: fields,
    check: check && { verdict: check.verdict, revision: check.revision, at: check.at, current: check.content_hash === p.content_hash, auto: check.auto ?? [], reasons: check.reasons ?? [] },
    search_console: p.state === 'published' ? { last_7: totals(metrics, p.url, 7, now), last_28: totals(metrics, p.url, 28, now), queries, state: settings.gsc?.state ?? null, read_at: settings.gsc?.at ?? null } : null,
  };
}

async function queueView({ store, now, soot }) {
  const settings = await getSettings(store);
  // A view never writes (its storage token is read-only): an unset blog channel shows its defaults.
  const [stored, queue, log] = await Promise.all([
    store.query('channels', [], { limit: 50 }),
    store.query('queue', [], { order: 'scheduled_at', desc: false, limit: 200 }),
    store.query('publish_log', [gte('at', new Date(now - 7 * DAY).toISOString())], { order: 'at', limit: 20 }),
  ]);
  const channels = stored.some(c => c.key === 'blog-lohi') ? stored : [{ key: 'blog-lohi', ...defaultsFor('blog-lohi'), paused: false, paused_reason: null }, ...stored];
  // Today's use of each cap (posts and replies), the "X 2/4 · trả lời X 3/10" line.
  const start = new Date(localDayStart(now, settings.quiet_hours?.tz || DEFAULT_QUIET.tz)).toISOString();
  const today = await store.query('publish_log', [gte('at', start)], { limit: 500 });
  const used = (key, action) => today.filter(r => r.channel === key && r.action === action && ['published', 'intent'].includes(r.status)).length;
  const refs = [...new Set([...queue.map(q => q.post), ...log.map(r => r.post)])];
  const posts = refs.length ? await store.query('posts', [{ column: 'ref', op: 'in', values: refs.slice(0, 100) }], { limit: 200 }) : [];
  const byRef = Object.fromEntries(posts.map(p => [p.ref, p]));
  const parents = [...new Set(posts.filter(p => p.kind === 'reply' && p.parent).map(p => p.parent))];
  const readers = parents.length ? await store.query('replies', [{ column: 'ref', op: 'in', values: parents.slice(0, 100) }], { limit: 200 }) : [];
  const handle = Object.fromEntries(readers.map(r => [r.ref, r.author_handle]));
  const videos = await videoBlocks(store, queue.map(q => byRef[q.post]).filter(Boolean));
  const vparents = [...new Set(Object.keys(videos).map(r => byRef[r]?.parent).filter(Boolean))];
  const source = vparents.length ? Object.fromEntries((await store.query('posts', [{ column: 'ref', op: 'in', values: vparents }], { limit: 50 })).map(p => [p.ref, title(p)])) : {};
  return {
    page: 'queue', writer: settings.writer, product: settings.product, editor: soot ?? null,
    paused_all: settings.paused_all, paused_at: settings.paused_at, quiet_hours: settings.quiet_hours,
    channels: [...channels].sort((a, b) => rank(a.key) - rank(b.key)).map(c => ({ id: c.key, label: channelLabel(c.key), paused: !!c.paused, paused_reason: c.paused_reason ?? null, paused_label: c.paused ? PAUSED_LABEL[c.paused_reason] ?? null : null, cap_per_day: c.cap_per_day, spacing_min: c.spacing_min,
      reply_cap_per_day: c.reply_cap_per_day ?? 0, posts_today: used(c.key, 'publish'), replies_today: used(c.key, 'reply'),
      waiting: queue.filter(q => q.channel === c.key && q.action !== 'unpublish').length })),
    items: queue.map(q => {
      const p = byRef[q.post] ?? {};
      const late = isLate(q, now, settings.stale_after_h);
      return { id: q.post, channel_id: q.channel, next: p.ref ? nextStep(p, q, channels.find(c => c.key === q.channel), settings, now) : null, title: title(p), channel: channelLabel(q.channel), action: q.action, scheduled_at: q.scheduled_at, state: p.state ?? null, label: late ? 'Bài lỡ giờ' : STATE_LABEL[p.state] ?? '', reason: q.wait_reason ?? p.reason ?? null, in_flight: !!q.intent_id && p.state !== 'uncertain', late,
        reply_to: p.kind === 'reply' && p.parent ? handle[p.parent] ?? null : null, ...socialText(p), retry_at: p.state === 'failed' && Date.parse(q.scheduled_at) > now ? q.scheduled_at : null, ...(p.kind === 'video' ? { kind: 'video', video: videos[p.ref] ?? null, source_title: source[p.parent] ?? null } : {}) };
    }),
    // A failed try whose post is still queued shows once, on its queue row with the retry.
    recent: log.filter(r => r.status !== 'intent' && !(r.status === 'failed' && queue.some(q => q.post === r.post))).slice(0, 10).map(r => ({ id: r.post, title: title(byRef[r.post] ?? {}), channel: channelLabel(r.channel), action: r.action, status: r.status, live: r.status === 'published' && byRef[r.post]?.state === 'published', url: r.url, reason: r.status === 'needs_person' ? PAUSED_LABEL[r.reason] ?? r.reason : r.reason, at: r.at })),
    empty: queue.length === 0,
  };
}

export async function page_action(input, deps) {
  const { store } = deps;
  const op = input.op;
  const get = async () => {
    const p = await store.one('posts', [eq('ref', input.id)]);
    if (!p) fail('not_found', `Không có bài ${input.id}.`);
    return p;
  };
  switch (op) {
    case 'pull': {
      const p = await get();
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (q?.intent_id) fail('conflict', 'Bài đang được đăng; chờ xong rồi gỡ.');
      if (!['ready', 'scheduled', 'failed'].includes(p.state)) fail('conflict', `Bài đang ${STATE_LABEL[p.state]}.`);
      if (q) await store.remove('queue', [eq('post', p.ref)]);
      await store.update('posts', [eq('ref', p.ref)], { state: 'pulled', reason: 'Bạn đã kéo bài ra khỏi hàng đợi.' });
      return { id: p.ref, state: 'pulled' };
    }
    case 'restore': return { ...(await schedule({ id: input.id }, deps)), state: 'scheduled' };
    case 'reschedule': {
      if (typeof input.scheduled_at !== 'string') fail('invalid_request', 'scheduled_at is required.');
      return { ...(await schedule({ id: input.id, scheduled_at: input.scheduled_at }, deps)), state: 'scheduled' };
    }
    case 'unpublish': {
      const p = await get();
      if (p.state !== 'published') fail('conflict', 'Chỉ gỡ được bài đã đăng.');
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (!q) await store.insert('queue', { post: p.ref, channel: p.channel, action: 'unpublish', scheduled_at: new Date(deps.now).toISOString(), intent_id: null, intent_at: null, attempts: 0, wait_reason: null });
      return { id: p.ref, state: 'published', unpublish: 'queued' };
    }
    // The founder's answers to Cần bạn "Bài lỡ giờ" and "Không chắc đã đăng chưa".
    case 'post_now': {
      const p = await get();
      if (p.state === 'uncertain') fail('conflict', 'Bài chưa rõ đã lên chưa; chọn "Đã lên" hoặc "Chưa lên" trước.');
      const out = await schedule({ id: p.ref, scheduled_at: new Date(deps.now).toISOString() }, deps);
      return { ...out, state: 'scheduled' };
    }
    case 'drop': {
      const p = await get();
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (q?.intent_id && p.state !== 'uncertain') fail('conflict', 'Bài đang được đăng; chờ xong rồi bỏ.');
      if (!['ready', 'scheduled', 'failed', 'uncertain'].includes(p.state)) fail('conflict', `Bài đang ${STATE_LABEL[p.state]}.`);
      if (q?.intent_id) await store.update('publish_log', [eq('intent_id', q.intent_id)], { status: 'failed', reason: 'Bạn đã bỏ bài.' });
      if (q) await store.remove('queue', [eq('post', p.ref)]);
      await clearAttention(store, 'late', p.ref);
      await clearAttention(store, 'uncertain', p.ref);
      await store.update('posts', [eq('ref', p.ref)], { state: 'pulled', reason: 'Bạn đã bỏ bài.' });
      // A dropped answer closes the reader reply it was for; nothing answers it later on its own.
      if (p.kind === 'reply' && p.parent) await store.update('replies', [eq('ref', p.parent), eq('state', 'open')], { state: 'ignored' });
      return { id: p.ref, state: 'pulled' };
    }
    case 'confirm_posted': {
      const p = await get();
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (p.state !== 'uncertain' || !q?.intent_id) fail('conflict', 'Chỉ xác nhận bài đang "Chưa rõ".');
      if (typeof input.url !== 'string' || !/^https:\/\//.test(input.url)) fail('invalid_request', 'Dán liên kết https của bài đã lên.');
      return { id: p.ref, ...(await record({ intent_id: q.intent_id, url: input.url }, deps)) };
    }
    case 'confirm_not_posted': {
      // The founder looked and it is not live: only then may it go out again.
      const p = await get();
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (p.state !== 'uncertain' || !q?.intent_id) fail('conflict', 'Chỉ xác nhận bài đang "Chưa rõ".');
      await store.update('publish_log', [eq('intent_id', q.intent_id)], { status: 'failed', reason: 'Bạn xác nhận bài chưa lên.' });
      await store.update('queue', [eq('post', p.ref)], { intent_id: null, intent_at: null, verify: false, scheduled_at: new Date(deps.now).toISOString(), wait_reason: null });
      await store.update('posts', [eq('ref', p.ref)], { state: 'scheduled', reason: null });
      await clearAttention(store, 'uncertain', p.ref);
      return { id: p.ref, state: 'scheduled' };
    }
    // Hàng đợi: the channel's own limits, edited in place (the page asks the person to confirm first).
    case 'set_limits': {
      const ch = await channel(store, input.channel);
      const set = {};
      for (const [f, max] of [['cap_per_day', 50], ['spacing_min', 10080], ['reply_cap_per_day', 50]]) {
        if (input[f] === undefined) continue;
        if (!Number.isInteger(input[f]) || input[f] < 0 || input[f] > max) fail('invalid_request', `${f} là số nguyên từ 0 đến ${max}.`);
        set[f] = input[f];
      }
      if (!Object.keys(set).length) fail('invalid_request', 'Nêu ít nhất một giới hạn: cap_per_day, spacing_min hoặc reply_cap_per_day.');
      await store.update('channels', [eq('key', ch.key)], set);
      return { id: ch.key, ...set };
    }
    case 'pause': case 'resume':
      return pause({ channel: input.channel, paused: op === 'pause' }, deps);
    // Chiến dịch: save (and make missing links), then one read so the detail has numbers.
    // A page read never turns signups into lead outcomes: those stay the Soot's (campaign_report).
    case 'campaign_save': {
      // No key: say so before anything is saved (the founder cannot use a campaign without its links).
      const missing = noKey(deps);
      if (missing) return missing;
      if (!input.campaign || typeof input.campaign !== 'object' || Array.isArray(input.campaign)) fail('invalid_request', 'campaign is the campaign object.');
      const { name, goal, channels, starts, ends, token_budget, landing, state, id } = input.campaign;
      const saved = await campaign_save({ name, goal, channels, starts, ends, token_budget, landing, state, id }, deps);
      const c = await store.one('campaigns', [eq('key', saved.id)]);
      const report = await readReport(c, deps);
      return { ...saved, read: { ok: report.ok, error: report.error ?? null } };
    }
    case 'campaign_refresh': {
      const missing = noKey(deps);
      if (missing) return missing;
      const c = await store.one('campaigns', [eq('key', input.campaign_id ?? '')]);
      if (!c) fail('not_found', `Không có chiến dịch ${input.campaign_id ?? ''}.`);
      const report = await readReport(c, deps);
      return { id: c.key, read: { ok: report.ok, error: report.error ?? null } };
    }
  }
  fail('invalid_request', 'op is pull, restore, unpublish, set_limits, reschedule, post_now, drop, confirm_posted, confirm_not_posted, pause, resume, campaign_save or campaign_refresh.');
}

/** The person's pick on a Cần bạn item from `due.ask` (its key and one of its options), applied as
 *  the Hàng đợi page would: never a post on its own beyond what the pick says. */
export async function answer(input, deps) {
  const { store } = deps;
  const option = typeof input.option === 'string' ? input.option.trim() : '';
  let key = typeof input.key === 'string' ? input.key : '';
  if (!key) key = (await store.query('attention', [], { order: 'raised_at', limit: 50 })).find(r => r.reason !== 'signed_out' && !r.key.startsWith('woke:') && !r.key.startsWith('inc:'))?.key ?? '';
  const m = /^(channel|uncertain|late|reply):([A-Za-z0-9-]{1,64}):([a-z_]{1,32})$/.exec(key);
  if (!m || !option) fail('invalid_request', 'key is the due.ask key and option one of its options.');
  const [, kind, ref, reason] = m;
  const act = (op, rest = {}) => page_action({ op, id: ref, ...rest }, deps);
  const close = async out => { await clearAttention(store, kind, ref); return { key, option, ...out }; };
  if (kind === 'channel' && ['layout_changed', 'captcha'].includes(reason)) {
    const ch = await channel(store, ref);
    if (!(ch.paused && ch.paused_reason === reason)) fail('conflict', `Kênh ${ref} không còn chờ việc này.`);
    if (option.startsWith('Chạy lại')) return close({ ...(await pause({ channel: ref, paused: false }, deps)), state: 'resumed' });
    if (/^Để .+ dừng$/.test(option)) {
      await store.update('channels', [eq('key', ref)], { paused: true, paused_reason: 'person' });
      return close({ state: 'paused' });
    }
  }
  if (kind === 'reply' && option === ANSWERS.reply[0]) {
    await store.update('replies', [eq('ref', ref), eq('state', 'needs_person')], { state: 'done' });
    return close({ state: 'done' });
  }
  if (kind === 'uncertain') {
    if (option === ANSWERS.uncertain[0]) return close(await act('confirm_posted', { url: input.url }));
    if (option === ANSWERS.uncertain[1]) return close(await act('confirm_not_posted'));
    if (option === ANSWERS.uncertain[2]) return close(await act('drop'));
  }
  if (kind === 'late') {
    if (option === ANSWERS.late[0]) return close(await act('post_now'));
    if (option === ANSWERS.late[1]) return close(await act('restore'));
    if (option === ANSWERS.late[2]) return close(await act('drop'));
  }
  fail('invalid_request', `"${option}" is not an option of ${key}.`);
}
