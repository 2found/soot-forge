// Campaigns (design §7, AC7 Soot side): the campaign row, one UTM short link
// per channel made through the product api, the api's clicks and attributed
// signups stored for Chiến dịch, `lead` outcomes for new signups, and the
// 80 % token-budget note. The api shapes are frozen (§7): POST /admin/links
// → {code, url}; GET /admin/analysis/campaigns/:id?from&to → {clicks, signups}.
// The admin key goes only to PRODUCT_API_URL, an env the operator grants
// (the Lohi recipe: https://api.lohi2.com); never to an address from input.
import { fail, eq, inList } from './store.mjs';
import { fold, platformOf } from './guard.mjs';
import { channel, getSettings } from './ops.mjs';

export const LANDING_DEFAULT = 'https://lohi2.com/';
export const GOAL_METRICS = ['signups', 'first_topups', 'clicks', 'published'];
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const TZ = 'Asia/Ho_Chi_Minh';
const TIMEOUT_MS = 8000;
/** The api reads at most 62 days per report (REVENUE_MAX_DAYS). */
export const MAX_DAYS = 62;

/** "Lohi tháng 12: truyện mới" → "lohi-thang-12-truyen-moi" (also the utm_campaign). */
export const slugOf = name => fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
/** The utm_source / api channel of a channel key: blog-lohi → blog, x-lohi → x. */
export const platform = key => (String(key).startsWith('blog') ? 'blog' : platformOf(key) ?? key);
/** A local calendar day (Asia/Ho_Chi_Minh) of a timestamp. */
export const localDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
const dayStart = d => new Date(Date.parse(`${d}T00:00:00+07:00`)).toISOString();
const dayEnd = d => new Date(Date.parse(`${d}T23:59:59+07:00`)).toISOString();

/** The link target: the landing page tagged for this campaign and channel. */
export function targetOf(landing, id, key) {
  const u = new URL(landing);
  const p = platform(key);
  u.searchParams.set('utm_source', p);
  u.searchParams.set('utm_medium', p === 'blog' ? 'blog' : 'social');
  u.searchParams.set('utm_campaign', id);
  return u.toString();
}

const API_WHY = {
  no_api: () => 'Soot chưa được đặt địa chỉ api (PRODUCT_API_URL)',
  no_key: () => 'Chưa có khoá PRODUCT_ADMIN_KEY trong Nest',
  forbidden: host => `${host} từ chối khoá PRODUCT_ADMIN_KEY (khoá cần quyền tạo liên kết và đọc báo cáo chiến dịch)`,
  api_unreachable: host => `${host} không trả lời`,
  api_failed: host => `${host} trả lỗi`,
  api_bad: host => `${host} trả dữ liệu không đúng dạng`,
};
const apiHost = deps => { try { return new URL(String(deps.env?.PRODUCT_API_URL)).host; } catch { return 'api'; } };
const apiError = (code, host, detail = '') => ({ code, host, message: API_WHY[code](host) + (detail ? ` (${detail})` : '') + '.' });

/** One product api call: {out} or {error:{code, host, message}}; never throws for the api's own failures. */
async function api(deps, method, path, body) {
  const base = String(deps.env?.PRODUCT_API_URL ?? '').replace(/\/+$/, '');
  // The admin key travels only over https (plain http only to this machine, for a local api).
  if (!/^https:\/\/[^/\s]+$/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(base)) return { error: apiError('no_api', 'api') };
  const host = new URL(base).host;
  const key = deps.env?.PRODUCT_ADMIN_KEY;
  if (!key) return { error: apiError('no_key', host) };
  let res;
  try {
    res = await deps.fetch(base + path, {
      method, signal: AbortSignal.timeout(deps.apiTimeoutMs ?? TIMEOUT_MS),
      headers: { 'X-API-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { return { error: apiError('api_unreachable', host) }; }
  if (res.status === 401 || res.status === 403) return { error: apiError('forbidden', host) };
  if (!res.ok) {
    // The api's own error code (e.g. target_not_allowed) says why; keep it, never its free text.
    const code = await res.json().then(b => (typeof b?.error === 'string' && /^[a-z_]{1,40}$/.test(b.error) ? ` ${b.error}` : ''), () => '');
    return { error: apiError(res.status >= 500 ? 'api_unreachable' : 'api_failed', host, `${res.status}${code}`) };
  }
  const out = await res.json().catch(() => null);
  return out && typeof out === 'object' ? { out } : { error: apiError('api_bad', host) };
}

async function campaignRow(store, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('invalid_request', 'id is a campaign code (a-z, 0-9, -).');
  const row = await store.one('campaigns', [eq('key', id)]);
  if (!row) fail('not_found', `Không có chiến dịch ${id}.`);
  return row;
}
export const campaignExists = async (store, id) => typeof id === 'string' && ID_RE.test(id) && !!(await store.one('campaigns', [eq('key', id)]));
export const linksOf = (store, ids) => store.query('links', [inList('campaign', ids)], { limit: 500 });

/** campaign_save: create or update a campaign, then make each missing channel link. */
export async function campaign_save(input, deps) {
  const { store, now } = deps;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120) fail('invalid_request', 'name is 1–120 characters.');
  const goal = input.goal ?? {};
  if (!GOAL_METRICS.includes(goal.metric) || !Number.isInteger(goal.target) || goal.target < 1) fail('invalid_request', `goal is {metric: ${GOAL_METRICS.join('|')}, target ≥ 1}.`);
  if (!DAY_RE.test(input.starts ?? '') || !DAY_RE.test(input.ends ?? '') || Number.isNaN(Date.parse(input.starts)) || Number.isNaN(Date.parse(input.ends))) fail('invalid_request', 'starts and ends are YYYY-MM-DD.');
  if (input.ends < input.starts) fail('invalid_request', 'ends is on or after starts.');
  if ((Date.parse(input.ends) - Date.parse(input.starts)) / DAY + 1 > MAX_DAYS) fail('invalid_request', `Một chiến dịch dài tối đa ${MAX_DAYS} ngày (api chỉ đọc số trong ${MAX_DAYS} ngày); chia thành hai chiến dịch.`);
  const budget = input.token_budget ?? 0;
  if (!Number.isInteger(budget) || budget < 0) fail('invalid_request', 'token_budget is a whole number ≥ 0.');
  if (input.state !== undefined && !['active', 'stopped'].includes(input.state)) fail('invalid_request', 'state is active or stopped.');
  const keys = [...new Set(Array.isArray(input.channels) ? input.channels : [])];
  if (!keys.length || keys.length > 10) fail('invalid_request', 'channels lists 1–10 channel ids.');
  for (const k of keys) await channel(store, k); // an unknown channel is refused here
  // One link and one row per platform: two channels on one platform would share the api's numbers.
  const dup = keys.find((k, i) => keys.findIndex(o => platform(o) === platform(k)) !== i);
  if (dup) fail('invalid_request', `Mỗi nền tảng một kênh trong một chiến dịch (${dup} trùng nền tảng ${platform(dup)}).`);
  const settings = await getSettings(store);
  const id = input.id ?? slugOf(name);
  if (!ID_RE.test(id)) fail('invalid_request', 'Tên cần ít nhất 2 chữ hoặc số để làm mã chiến dịch.');
  const cur = await store.one('campaigns', [eq('key', id)]);
  // A new name that folds to another campaign's code must not overwrite it.
  if (cur && !input.id && cur.name !== name) fail('conflict', `Đã có chiến dịch mã ${id} ("${cur.name}"); đặt tên khác.`);
  const landing = input.landing ?? cur?.landing ?? settings.landing ?? LANDING_DEFAULT;
  if (typeof landing !== 'string' || !/^https:\/\/[^\s]+$/.test(landing) || landing.length > 300) fail('invalid_request', 'landing is an https address.');
  const row = { name, goal: { metric: goal.metric, target: goal.target }, channels: keys, starts: dayStart(input.starts), ends: dayEnd(input.ends), token_budget: budget, landing, state: input.state ?? cur?.state ?? 'active' };
  // A changed budget gets its own 80 % note.
  if (cur) await store.update('campaigns', [eq('key', id)], { ...row, ...((cur.token_budget ?? 0) !== budget ? { budget_told: false } : {}) });
  else {
    try { await store.insert('campaigns', { key: id, ...row, tokens_used: 0, leads: 0, budget_told: false, report: null }); }
    catch (e) { if (e.code !== 'conflict') throw e; await store.update('campaigns', [eq('key', id)], row); }
  }
  // Links: one per channel, made once; a failed call stops the rest (same cause) and a later save fills them.
  const have = await linksOf(store, [id]);
  let links_error = null;
  for (const key of keys) {
    if (have.some(l => l.channel === key)) continue;
    const target = targetOf(landing, id, key);
    const r = await api(deps, 'POST', '/admin/links', { product: String(settings.product ?? 'lohi').toLowerCase(), campaign: id, channel: platform(key), target });
    const ok = r.out && typeof r.out.code === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(r.out.code) && typeof r.out.url === 'string' && /^https?:\/\//.test(r.out.url);
    if (!ok) { links_error = r.error ?? apiError('api_bad', apiHost(deps)); break; }
    try { await store.insert('links', { code: r.out.code, campaign: id, channel: key, post: null, target, url: r.out.url }); have.push({ channel: key, code: r.out.code, url: r.out.url }); }
    catch (e) { if (e.code !== 'conflict') throw e; }
  }
  const links = have.filter(l => keys.includes(l.channel)).map(l => ({ channel: l.channel, code: l.code, url: l.url }));
  const missing = keys.filter(k => !links.some(l => l.channel === k));
  return { id, name, state: row.state, created: !cur, links, ...(missing.length ? { links_missing: missing, links_error } : {}), at: new Date(now).toISOString() };
}

/** Read the api numbers of one campaign and store them as its report; never moves `leads`. */
export async function readReport(c, deps) {
  const from = localDay(Date.parse(c.starts)), to = localDay(Date.parse(c.ends));
  const r = await api(deps, 'GET', `/admin/analysis/campaigns/${encodeURIComponent(c.key)}?from=${from}&to=${to}`);
  const at = new Date(deps.now).toISOString();
  const shaped = r.out && Array.isArray(r.out.clicks) && Array.isArray(r.out.signups);
  const n = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const report = shaped
    ? { at, ok: true,
      clicks: r.out.clicks.slice(0, 50).map(x => ({ channel: String(x?.channel ?? ''), clicks: n(x?.clicks) })),
      signups: r.out.signups.slice(0, 50).map(x => ({ source: String(x?.source ?? ''), registrations: n(x?.registrations), firstTopups: n(x?.firstTopups), revenue30dVnd: n(x?.revenue30dVnd) })) }
    : { at, ok: false, error: r.error ?? apiError('api_bad', apiHost(deps)) };
  await deps.store.update('campaigns', [eq('key', c.key)], { report });
  return report;
}
export const registrations = report => (report?.ok ? report.signups.reduce((s, x) => s + x.registrations, 0) : null);

/** A campaign worth reading today: active, started, and not past its end plus 30 days. */
const running = (c, now) => c.state !== 'stopped' && Date.parse(c.starts) <= now && now <= Date.parse(c.ends) + 30 * DAY;

/** campaign_report: read the api for running campaigns (or one), turn new signups into
 * `lead` outcomes the Soot records with host `outcome`, and keep the token budget. */
export async function campaign_report(input, deps) {
  const { store, now } = deps;
  if (input.tokens_used !== undefined && (!input.id || !Number.isInteger(input.tokens_used) || input.tokens_used < 0)) fail('invalid_request', 'tokens_used is a whole number ≥ 0 and needs id.');
  const list = input.id ? [await campaignRow(store, input.id)] : (await store.query('campaigns', [], { limit: 100 })).filter(c => running(c, now));
  const outcomes = [], tell = [], out = [];
  for (const c of list) {
    const report = await readReport(c, deps);
    const set = {};
    const total = registrations(report);
    if (total !== null && total > (c.leads ?? 0)) {
      outcomes.push({ id: 'lead', count: total - (c.leads ?? 0), ref: `utm:${c.key}:${localDay(now)}` });
      set.leads = total;
    }
    const used = input.tokens_used ?? c.tokens_used ?? 0;
    if (input.tokens_used !== undefined) set.tokens_used = used;
    const budget = c.token_budget ?? 0;
    // 80 % is said once; spending stays the founder's call, so nothing stops.
    if (budget > 0 && used >= 0.8 * budget && !c.budget_told) {
      set.budget_told = true;
      tell.push({ campaign: c.key, used, budget, pct: Math.round((used / budget) * 100), message: `Chiến dịch "${c.name}" đã dùng ${used.toLocaleString('vi-VN')} / ${budget.toLocaleString('vi-VN')} token (${Math.round((used / budget) * 100)}%). Soot không tự dừng; chi thêm hay dừng là bạn quyết.` });
    }
    if (Object.keys(set).length) await store.update('campaigns', [eq('key', c.key)], set);
    out.push({ id: c.key, ok: report.ok, ...(report.ok ? { registrations: total, clicks: report.clicks.reduce((s, x) => s + x.clicks, 0) } : { error: report.error }), token_budget: budget, tokens_used: used });
  }
  // The Đầu mối wakes for outcomes to record, a budget note, or a budget to update.
  const tokens_due = input.tokens_used === undefined ? list.filter(c => (c.token_budget ?? 0) > 0).map(c => c.key) : [];
  const notify = outcomes.length > 0 || tell.length > 0 || tokens_due.length > 0;
  return { campaigns: out, outcomes, tell, tokens_due, notify, wake: notify };
}

/** The campaign a draft names, its channel checked and its link for that channel. */
export async function draftCampaign(store, id, chKey) {
  const c = await campaignRow(store, id);
  if (!(c.channels ?? []).includes(chKey)) fail('invalid_request', `Kênh ${chKey} không thuộc chiến dịch ${id} (${(c.channels ?? []).join(', ')}).`);
  const link = await store.one('links', [eq('campaign', id), eq('channel', chKey)]);
  return { campaign: c, link: link?.url ?? null };
}

// ---------- Chiến dịch page model (read-only: a view's storage token cannot write) ----------

const CHANNEL_LABEL = { blog: 'Blog', x: 'X', facebook: 'Facebook', reddit: 'Reddit' };
const ORDER = ['blog', 'x', 'facebook', 'reddit'];
const label = key => CHANNEL_LABEL[platform(key)] ?? key;
const byRank = (a, b) => (ORDER.indexOf(platform(a)) + 1 || 99) - (ORDER.indexOf(platform(b)) + 1 || 99);
const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);

/** Đang chạy / Sắp chạy / Đã xong / Đã dừng. */
export function phase(c, now) {
  if (c.state === 'stopped') return { phase: 'stopped', phase_label: 'Đã dừng' };
  if (now < Date.parse(c.starts)) return { phase: 'planned', phase_label: 'Sắp chạy' };
  if (now > Date.parse(c.ends)) return { phase: 'done', phase_label: 'Đã xong' };
  return { phase: 'running', phase_label: 'Đang chạy' };
}

/** Numbers of one campaign: Soot-side (published, reach) always; api-side (clicks, signups) only after a good read. */
function numbers(c, posts, metrics) {
  const mine = posts.filter(p => p.campaign === c.key && p.state === 'published');
  const since = localDay(Date.parse(c.starts));
  const reachOf = urls => sum(metrics.filter(m => urls.has(m.url) && !m.query && m.day >= since), m => (m.impressions ?? 0) + (m.views ?? 0));
  const r = c.report?.ok ? c.report : null;
  const rows = [...(c.channels ?? [])].sort(byRank).map(key => {
    const p = platform(key), ps = mine.filter(x => x.channel === key);
    const signups = r ? r.signups.filter(s => s.source === p) : null;
    return { channel: key, label: label(key), published: ps.length, reach: reachOf(new Set(ps.map(x => x.url).filter(Boolean))),
      clicks: r ? sum(r.clicks.filter(x => x.channel === p), x => x.clicks) : null,
      signups: signups ? sum(signups, s => s.registrations) : null, first_topups: signups ? sum(signups, s => s.firstTopups) : null };
  });
  const totals = { published: mine.length, reach: reachOf(new Set(mine.map(x => x.url).filter(Boolean))),
    clicks: r ? sum(r.clicks, x => x.clicks) : null, signups: r ? sum(r.signups, s => s.registrations) : null, first_topups: r ? sum(r.signups, s => s.firstTopups) : null };
  const goal = c.goal ?? { metric: 'signups', target: 0 };
  return { rows, totals, goal: { ...goal, value: totals[goal.metric] ?? null } };
}

const summary = (c, now) => ({ id: c.key, name: c.name, starts: c.starts, ends: c.ends, channels: [...(c.channels ?? [])].sort(byRank).map(label), ...phase(c, now) });

export async function campaignView(input, { store, now, env }) {
  const settings = await getSettings(store);
  const head = { page: 'chien-dich', product: settings.product ?? null, api_host: apiHost({ env }) === 'api' ? null : apiHost({ env }) };
  const all = await store.query('campaigns', [], { order: 'starts', limit: 100 });
  const known = await store.query('channels', [], { limit: 50 });
  const choices = [...new Set(['blog-lohi', ...known.map(k => k.key)])].sort(byRank).map(key => ({ id: key, label: label(key) }));
  const ids = input.campaign ? [input.campaign] : all.map(c => c.key);
  const posts = ids.length ? await store.query('posts', [inList('campaign', ids), eq('state', 'published')], { limit: 500 }) : [];
  const urls = [...new Set(posts.map(p => p.url).filter(Boolean))];
  const metrics = urls.length ? await store.query('metrics', [inList('url', urls.slice(0, 200))], { order: 'day', limit: 2000 }) : [];
  if (input.campaign) {
    const c = all.find(x => x.key === input.campaign);
    if (!c) fail('not_found', `Không có chiến dịch ${input.campaign}.`);
    const links = await linksOf(store, [c.key]);
    const n = numbers(c, posts, metrics);
    return {
      ...head, campaign: { ...summary(c, now), goal: n.goal, token_budget: c.token_budget ?? 0, tokens_used: c.tokens_used ?? 0, landing: c.landing,
        channel_ids: c.channels ?? [], state: c.state },
      totals: n.totals, rows: n.rows,
      read: c.report ? { at: c.report.at, ok: c.report.ok, error: c.report.ok ? null : c.report.error } : null,
      links: links.sort((a, b) => byRank(a.channel, b.channel)).map(l => ({ channel: l.channel, label: label(l.channel), url: l.url })),
      links_missing: (c.channels ?? []).filter(k => !links.some(l => l.channel === k)).sort(byRank).map(label),
      choices,
    };
  }
  const rank = { running: 0, planned: 1, done: 2, stopped: 3 };
  const items = all.map(c => ({ ...summary(c, now), goal: numbers(c, posts, metrics).goal, published: posts.filter(p => p.campaign === c.key).length }))
    .sort((a, b) => rank[a.phase] - rank[b.phase] || Date.parse(b.starts) - Date.parse(a.starts));
  return { ...head, items, choices, empty: !items.length };
}
