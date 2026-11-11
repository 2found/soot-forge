// scoreboard_sync: read the product's frozen scoreboard contract (api
// GET /admin/analysis/scoreboard?from&to, version 1) for the last 7 full days, keep
// one row per period, and append each finished week once to the 2build company
// baseline (`bbs company scoreboard record`). Aggregate numbers only; the key goes
// to SCOREBOARD_URL / SCOREBOARD_URLS and nowhere else. A company without an
// address has a Soot write its numbers with metrics_record (the `metrics` table);
// the page reads both through boardFor.
import { eq, fail, getState, setState, getJson, safeUrl, skippedFor, iso, lastSevenDays, lastFullWeek, short, addDays } from './base.mjs';
import { scoreboardSources, scoreboardKeys, keyFor, syncKey, baselineKey, productId, rememberHost, adoptProducts, northStarOf, scopeProduct, hostProduct } from './products.mjs';
import { runBbs } from './bbs.mjs';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

const isDir = p => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

/** Metric keys of the contract with their Vietnamese label and which way is better. */
export const METRICS = {
  revenue_vnd: ['Doanh thu', 'up'], topups: ['Lượt nạp', 'up'], payers: ['Người nạp', 'up'], first_payers: ['Nạp lần đầu', 'up'],
  subscriptions_started: ['Gói mới', 'up'], subscriptions_active: ['Gói đang chạy', 'up'], signups: ['Đăng ký mới', 'up'],
  active_readers: ['Người đọc', 'up'], support_threads_new: ['Hỗ trợ mới', 'down'], support_handoffs: ['Chuyển người', 'down'],
};
/** The words of a metric: the contract's default label for its keys, else the data's own label, else its key. */
export const labelOf = (key, m) => METRICS[key]?.[0] || (typeof m?.label === 'string' && m.label.trim() ? short(m.label, 40) : key);
/** Its unit: the data's, else the contract's (revenue in VND, the rest counts). */
export const unitOf = (key, m) => (typeof m?.unit === 'string' && m.unit.trim() ? short(m.unit, 12) : key === 'revenue_vnd' ? 'vnd' : 'count');
/** Which way is better: the data's, else the contract's, else up. */
export const goodOf = (key, m) => (m?.good === 'down' || m?.good === 'up' ? m.good : METRICS[key]?.[1] ?? 'up');

const WHY = {
  forbidden: host => `${host} từ chối khoá quản trị: hãy nhập khoá có vai trò agent_mod (hoặc admin) cho PRODUCT_ADMIN_KEY ở Thiết lập.`,
  unreachable: host => `${host} không trả lời bảng số; Soot thử lại hôm sau.`,
  failed: (host, status) => `${host} trả lỗi ${status} khi đọc bảng số.`,
  bad: host => `${host} trả bảng số không đúng dạng (cần version 1 có metrics).`,
};

const int = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
/** Anonymous cohorts by ISO week of signup (counts only, no ids). Anything that is not that shape is dropped: absent means "chưa có". */
export function cleanCohorts(list) {
  if (!Array.isArray(list)) return null;
  const out = list.filter(c => c && typeof c === 'object' && /^\d{4}-W\d{2}$/.test(String(c.cohort))).slice(0, 12)
    .map(c => ({ cohort: c.cohort, signups: int(c.signups), active_w1: int(c.active_w1), active_w2: int(c.active_w2), active_w4: int(c.active_w4), first_payers: int(c.first_payers) }));
  return out.length ? out : null;
}
/** Subscription plans: one row per tier key of the product (the api serves them; this pack never lists tiers). */
export function cleanPlans(list) {
  if (!Array.isArray(list)) return null;
  const out = list.filter(p => p && typeof p === 'object' && /^[a-z0-9_-]{1,16}$/.test(String(p.tier))).slice(0, 12)
    .map(p => ({ tier: p.tier, started: int(p.started), active: int(p.active), revenue_vnd: int(p.revenue_vnd) }));
  return out.length ? out : null;
}

// The single SCOREBOARD_URL keeps its row key; a mapped source keys by its product too, and its product wins.
const rowOf = (board, source) => ({
  key: source && !source.legacy ? `${source.product}|${board.range.from}..${board.range.to}` : `${board.range.from}..${board.range.to}`,
  period_from: board.range.from, period_to: board.range.to, product: source && !source.legacy ? source.product : String(board.product ?? ''),
  metrics: board.metrics, support: board.support ?? null, sources: board.sources ?? [], comparison: board.comparison ?? null,
  cohorts: cleanCohorts(board.cohorts), plans: cleanPlans(board.plans),
});

const valid = b => b && b.version === 1 && b.metrics && typeof b.metrics === 'object' && !Array.isArray(b.metrics)
  && /^\d{4}-\d{2}-\d{2}$/.test(b.range?.from ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(b.range?.to ?? '')
  && Object.values(b.metrics).every(m => m && typeof m === 'object' && (m.value === null || Number.isFinite(m.value)) && (m.previous == null || Number.isFinite(m.previous)));

// A mapped source names its product when its key is refused: each product API has its own key.
const whyFor = source => (source.legacy ? WHY : { ...WHY, forbidden: host => `${host} từ chối khoá của sản phẩm ${source.product}: nhập dòng ${source.product}=<khoá agent_mod> cho SCOREBOARD_KEYS ở Thiết lập.` });

async function fetchBoard(deps, source, key, { from, to }) {
  const u = new URL(source.url.toString());
  u.searchParams.set('from', from); u.searchParams.set('to', to);
  const r = await getJson(deps, u, key ? { 'X-API-Key': key } : {}, whyFor(source));
  if (r.error) return r;
  return valid(r.out) ? { board: r.out } : { error: { code: 'bad', host: u.host, message: WHY.bad(u.host) } };
}

async function save(store, board, now, source) {
  const row = rowOf(board, source);
  if (await store.update('scoreboard', [eq('key', row.key)], { ...row, fetched_at: iso(now) }) === 0) await store.insert('scoreboard', { ...row, fetched_at: iso(now) });
  return row;
}

/**
 * The newest stored HTTP period (by its end day), or null. With a product: that product's newest, where a row without
 * a product label (the single SCOREBOARD_URL before it named one) counts as the host's.
 */
export async function latestBoard(store, product, host) {
  if (!product) return (await store.query('scoreboard', [], { order: 'period_to', limit: 1 }))[0] ?? null;
  return (await httpRows(store, product, host, 1))[0] ?? null;
}
async function httpRows(store, product, host, limit) {
  const own = await store.query('scoreboard', [eq('product', product)], { order: 'period_to', limit });
  if (product !== host) return own;
  const bare = (await Promise.all([store.query('scoreboard', [eq('product', '')], { order: 'period_to', limit }), store.query('scoreboard', [isNullP('product')], { order: 'period_to', limit })])).flat();
  return [...own, ...bare].sort((a, b) => (a.period_to < b.period_to ? 1 : a.period_to > b.period_to ? -1 : 0)).slice(0, limit);
}
const isNullP = column => ({ column, op: 'is_null' });

/** Products the stored numbers name (HTTP rows and recorded metrics). */
export async function dataProducts(store) {
  const [http, table] = await Promise.all([store.query('scoreboard', [], { order: 'period_to', limit: 200 }), store.query('metrics', [], { order: 'period_to', limit: 500 })]);
  return [...new Set([...http, ...table].map(r => productId(r.product)).filter(Boolean))];
}

/** Recorded metrics of a product grouped by period, newest first: [{from, to, metrics:{key: {...}}, at, source}]. */
async function tablePeriods(store, product) {
  const rows = await store.query('metrics', [eq('product', product)], { order: 'period_to', limit: 500 });
  const by = new Map();
  for (const r of rows) {
    const k = `${r.period_from}..${r.period_to}`;
    if (!by.has(k)) by.set(k, { from: r.period_from, to: r.period_to, metrics: {}, at: r.recorded_at, source: r.source });
    const p = by.get(k);
    if (!(r.metric in p.metrics)) p.metrics[r.metric] = { value: r.value, previous: r.previous, label: r.label, unit: r.unit, good: r.good, target: r.target, north_star: r.north_star === true };
    if (r.recorded_at > p.at) p.at = r.recorded_at;
  }
  return [...by.values()].sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
}

const finite = v => (Number.isFinite(v) ? v : null);
/**
 * One product's scoreboard for the page: the newest period from either source (an HTTP board wins a tie, and recorded
 * metrics of that same period fill keys it lacks). Every tile carries its label, unit, direction and target from the
 * data, the contract's words as the defaults; the north star is NORTH_STAR, else a recorded `north_star`, else revenue, else
 * the first. `trend` is the north star at the same weekday over up to 8 weeks. Null when the product has no numbers.
 */
export async function boardFor(store, env, product, host) {
  const [http, table] = await Promise.all([product ? httpRows(store, product, host, 60) : store.query('scoreboard', [], { order: 'period_to', limit: 60 }), product ? tablePeriods(store, product) : []]);
  const h = http[0], t = table[0];
  if (!h && !t) return null;
  const useHttp = h && (!t || h.period_to >= t.to);
  const head = useHttp ? { from: h.period_from, to: h.period_to, metrics: { ...h.metrics } } : { from: t.from, to: t.to, metrics: { ...t.metrics } };
  let source = useHttp ? 'http' : 'table';
  if (useHttp && t && t.from === h.period_from && t.to === h.period_to) {
    for (const [k, m] of Object.entries(t.metrics)) if (!(k in head.metrics)) { head.metrics[k] = m; source = 'both'; }
  }
  // A recorded metric without its previous number takes it from the period before, recorded the same way.
  const before = table.find(p => p.to < head.from);
  const tiles = Object.entries(head.metrics).slice(0, 30).map(([key, m]) => {
    const value = finite(m?.value), previous = finite(m?.previous) ?? finite(before?.metrics?.[key]?.value);
    return { key, label: labelOf(key, m), unit: unitOf(key, m), value, previous, pct: pct(value, previous), good: goodOf(key, m), target: finite(m?.target), north_star: m?.north_star === true };
  });
  const wanted = northStarOf(env, product) ?? tiles.find(x => x.north_star)?.key ?? (tiles.some(x => x.key === 'revenue_vnd') ? 'revenue_vnd' : tiles[0]?.key);
  const north = tiles.find(x => x.key === wanted) ?? tiles[0] ?? null;
  // The same metric a week apart: rolling HTTP rows and recorded periods alike.
  const at = new Map();
  for (const r of http) { const v = finite(r.metrics?.[north?.key]?.value); if (v !== null && !at.has(r.period_to)) at.set(r.period_to, v); }
  for (const p of table) { const v = finite(p.metrics?.[north?.key]?.value); if (v !== null && !at.has(p.to)) at.set(p.to, v); }
  const trend = [];
  for (let k = 7; k >= 0; k--) { const v = at.get(addDays(head.to, -7 * k)); if (v !== undefined) trend.push(v); }
  return {
    product: product ?? (productId(h?.product) || null), from: head.from, to: head.to, source,
    recorded_at: useHttp ? h.fetched_at : t.at, recorded_source: !useHttp ? short(t.source ?? '', 60) || null : null,
    north: north ? { ...north, trend: trend.length >= 3 ? trend : null } : null,
    // Every metric, the north star too (the page lifts it out by key).
    tiles,
    comparison: useHttp ? h.comparison ?? null : null, cohorts: useHttp ? h.cohorts ?? null : null, plans: useHttp ? h.plans ?? null : null,
    sources: useHttp ? (h.sources ?? []).slice(0, 8) : [], reasons: useHttp ? (h.support?.handoff_reasons ?? []).slice(0, 6) : [],
  };
}
const pct = (v, p) => (Number.isFinite(v) && Number.isFinite(p) && p > 0 ? Math.round(((v - p) / p) * 100) : null);

/** Releases shipped in an ICT week: tags of PRODUCT_REPO matching RELEASE_TAGS
 * (git patterns, comma separated; default `v*,*-v*`) created inside it. Null when
 * there is no repo or git cannot read it, so the baseline leaves the cell empty. */
export function releasesIn(env, { from, to }) {
  const repo = env.PRODUCT_REPO;
  if (!repo || !isAbsolute(repo)) return Promise.resolve(null);
  const patterns = String(env.RELEASE_TAGS || 'v*,*-v*').split(',').map(x => x.trim()).filter(x => /^[A-Za-z0-9*._/-]{1,64}$/.test(x)).map(x => `refs/tags/${x}`);
  if (!patterns.length) return Promise.resolve(null);
  const start = Date.parse(`${from}T00:00:00+07:00`) / 1000, end = Date.parse(`${to}T00:00:00+07:00`) / 1000 + 86_400;
  return new Promise(resolve => execFile('git', ['-C', repo, 'for-each-ref', '--format=%(refname) %(creatordate:unix)', ...patterns],
    { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const seen = new Set();
      for (const line of String(stdout).split('\n')) {
        const [ref, at] = line.trim().split(' ');
        if (ref && Number(at) >= start && Number(at) < end) seen.add(ref);
      }
      resolve(seen.size);
    }));
}

/** Append one finished week to `bbs company scoreboard record`; returns a short status code. */
async function baseline(store, deps, board, source) {
  const week = board.range.from;
  if (await getState(store, baselineKey(source, week))) return 'already';
  const product = source.legacy ? String(board.product ?? '') : source.product;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(product)) return 'bad_product';
  const v = k => (Number.isFinite(board.metrics[k]?.value) && board.metrics[k].value >= 0 ? board.metrics[k].value : null);
  const flags = [['--revenue', v('revenue_vnd')], ['--active-users', v('active_readers')], ['--support-cases', v('support_threads_new')]].filter(([, n]) => n !== null);
  if (!flags.length) return 'no_numbers';
  const releases = await releasesIn(deps.env, board.range);
  if (releases !== null) flags.push(['--releases', releases]);
  const args = ['company', 'scoreboard', 'record', '--product', product, '--week', week, ...flags.flatMap(([f, n]) => [f, String(n)]), '--note', 'company-loop scoreboard_sync'];
  // A repo path that is gone must not cost the week: bbs then runs from where the tool runs.
  const r = await runBbs(deps.env, args, { cwd: isDir(deps.env.PRODUCT_REPO) ? deps.env.PRODUCT_REPO : undefined, timeoutMs: 20_000 });
  if (r.missing) return 'bbs_missing';
  if (!r.ok) return `bbs_failed: ${short(r.stderr, 120)}`;
  await setState(store, baselineKey(source, week), { at: iso(deps.now), product });
  return 'recorded';
}

// Readers waiting for a person: one Cần bạn card per count bucket, closed when it falls below WAITING_MIN.
export const WAITING_MIN = 5;
export const waitingBucket = n => (!Number.isFinite(n) ? 0 : n >= 50 ? 50 : n >= 20 ? 20 : n >= 10 ? 10 : n >= WAITING_MIN ? WAITING_MIN : 0);
export const WAITING_GROUP = 'company:support:waiting';

/**
 * {} (nothing to say), {settle, resolves_need} (back under the line) or {raise}. The runtime files the card itself, with no model:
 * its id carries the bucket, so the same bucket is one card (the count in it stays current) and a new bucket replaces it.
 * Nothing is remembered here, so a card that could not be filed is filed on the next sync. Counts only, never a reader.
 */
function waitingNeed(env, board) {
  const n = waitingCount(board);
  if (!Number.isFinite(n)) return {};
  const bucket = waitingBucket(n);
  if (!bucket) return { settle: [WAITING_GROUP], resolves_need: true };
  const where = safeUrl(env.SUPPORT_QUEUE_URL)?.toString();
  return { raise: {
    id: `${WAITING_GROUP}:${bucket}`, group: WAITING_GROUP, title: `${n} bạn đọc đang chờ người trả lời`,
    why: `${where ? `Mở ${where}` : 'Mở trang hỗ trợ trong quản trị sản phẩm'}, vào các cuộc đang chờ người và trả lời từng bạn. Thẻ này tự đóng khi còn dưới ${WAITING_MIN} bạn đọc chờ; số tăng sang mức mới sẽ nêu lại một lần.`,
    ...(where && /^https?:/.test(where) ? { link: where, link_label: 'Mở hàng chờ hỗ trợ' } : {}),
    options: [{ id: 'handled', label: 'Đã xử lý', recommended: true }, { id: 'later', label: 'Để sau' }],
    reraise_after_hours: 72,
  } };
}

/**
 * Readers waiting for a person. A product may serve `support.readers_waiting` (threads waiting for a person whose
 * reader spoke last); it wins over `by_state.waiting_human`, which also counts threads a person already answered
 * outside the queue (a direct message) and so overstates who waits.
 */
export function waitingCount(board) {
  const s = board?.support;
  if (Number.isFinite(s?.readers_waiting)) return s.readers_waiting;
  return s?.by_state?.waiting_human;
}

/** One source: read, keep the period, record the finished week. {ok, period, baseline, board} or {ok:false, error, since}. */
async function syncSource(deps, source, key) {
  const { store, now } = deps;
  const period = lastSevenDays(now);
  const got = await fetchBoard(deps, source, key, period);
  const sk = syncKey(source);
  if (got.error) {
    // An incident lasts until the next good read: `since` keeps its first day, so one card is filed per incident.
    const before = await getState(store, sk);
    const since = before?.code === got.error.code && before.since ? before.since : iso(now);
    await setState(store, sk, { ok: false, code: got.error.code, message: got.error.message, at: iso(now), since });
    return { ok: false, error: got.error, since };
  }
  const row = await save(store, got.board, now, source);
  const wasForbidden = (await getState(store, sk))?.code === 'forbidden';
  await setState(store, sk, { ok: true, at: iso(now), period: row.key });
  if (source.legacy) await rememberHost(store, got.board.product);
  // The finished Monday..Sunday week goes to the company baseline once; the rolling window is the same week on Mondays.
  const lw = lastFullWeek(now);
  let base = await getState(store, baselineKey(source, lw.from)) ? 'already' : null;
  if (!base) {
    const same = got.board.range.from === lw.from && got.board.range.to === lw.to;
    const wk = same ? { board: got.board } : await fetchBoard(deps, source, key, lw);
    base = wk.error ? 'week_unreadable' : await baseline(store, deps, wk.board, source);
  }
  return { ok: true, period: row.key, baseline: base, board: got.board, wasForbidden };
}

export async function scoreboard_sync(input, deps) {
  const { store, env } = deps;
  const all = scoreboardSources(env).sources;
  const { keys } = scoreboardKeys(env);
  // One product (input, else the run's SOOT_PRODUCT): its mapped source, and the single SCOREBOARD_URL only when it is that
  // product's (the host's, or not known yet and the product has no source of its own). No product: every source, as before.
  const want = scopeProduct(input, env);
  const host = want ? await hostProduct(store, null) : null;
  const mapped = want && all.some(s => s.product === want);
  const sources = want ? all.filter(s => (s.legacy ? host === want || (!host && !mapped) : s.product === want)) : all;
  if (!env.PRODUCT_ADMIN_KEY && !keys.size) return skippedFor('PRODUCT_ADMIN_KEY');
  if (!sources.length) return { ...skippedFor('SCOREBOARD_URL'), ...(want ? { product: want, reason: 'no_source_for_product' } : {}) };
  const results = [];
  // A source with no key of its own sends none (the product answers 401/403 and the refusal names it).
  for (const source of sources) results.push({ source, ...(await syncSource(deps, source, keyFor(source, env, keys))) });
  // Rows from before products get their product once the host is known.
  await adoptProducts(store, await getState(store, 'host_product'));
  const first = results[0];
  const list = results.map(r => (r.ok ? { product: r.source.product ?? productId(r.board.product), ok: true, period: r.period, baseline: r.baseline } : { product: r.source.product, ok: false, code: r.error.code }));
  const failed = results.filter(r => !r.ok);
  if (failed.length === results.length) {
    // One plain line; the card is filed by the runtime, once per incident (an incident ends at the next good read).
    const f = results.find(r => r.error.code === 'forbidden') ?? first;
    const raise = f.error.code === 'forbidden'
      ? { id: `company:scoreboard:forbidden:${f.since.slice(0, 10)}`, group: 'company:scoreboard:forbidden', title: 'Soot chưa đọc được bảng số của sản phẩm', why: f.error.message, options: [{ id: 'fixed', label: 'Đã đổi khoá', recommended: true }, { id: 'later', label: 'Để sau' }], reraise_after_hours: 72 } : undefined;
    return { ok: false, reason_code: f.error.code, error: { code: f.error.code, message: f.error.message }, message: f.error.message, notify: false, wake: false, ...(results.length > 1 ? { sources: list } : {}), ...(raise ? { raise } : {}) };
  }
  const good = results.find(r => r.ok);
  if (input.for_digest) return { ok: true, synced: true, period: good.period, baseline: good.baseline, ...(results.length > 1 ? { sources: list } : {}) };
  // Readers waiting for a person: the first source that reports support numbers files the card.
  const need = waitingNeed(env, (results.find(r => r.ok && Number.isFinite(waitingCount(r.board))) ?? good).board);
  const settled = results.some(r => r.ok && r.wasForbidden) && !results.some(r => !r.ok && r.error.code === 'forbidden');
  return { done: true, period: good.period, baseline: good.baseline, ...(results.length > 1 ? { sources: list } : {}), ...need, ...(settled ? { settle: [...(need.settle ?? []), 'company:scoreboard:forbidden'] } : {}) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (2026-02-31 and 2026-13-01 are not). */
const isDay = s => typeof s === 'string' && DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const dayOk = s => { try { return isDay(s); } catch { return false; } };
const UNITS = /^[\p{L}\p{N} %$€£¥₫/.-]{1,12}$/u;
/**
 * metrics_record: a Soot writes one product's numbers for one period (no scoreboard address needed). One row per
 * product, period and metric; writing again replaces it. Aggregates only: a key is a metric name, never a person.
 */
export async function metrics_record(input, deps) {
  const { store, now, soot } = deps;
  const product = scopeProduct(input, deps.env) ?? fail('invalid_request', 'product là mã sản phẩm (a-z, 0-9, -, _).');
  const period = input.period ?? lastSevenDays(now);
  if (!dayOk(period?.from) || !dayOk(period?.to) || period.from > period.to || Date.parse(period.to) - Date.parse(period.from) > 31 * 86_400_000) fail('invalid_request', 'period là {from, to} dạng YYYY-MM-DD, tối đa 31 ngày.');
  const list = Array.isArray(input.metrics) ? input.metrics : [];
  if (!list.length || list.length > 30) fail('invalid_request', 'metrics là danh sách 1–30 số liệu.');
  const problems = [];
  const keys = new Set();
  for (const [i, m] of list.entries()) {
    if (!m || typeof m !== 'object' || !/^[a-z][a-z0-9_]{0,47}$/.test(String(m.key))) problems.push(`#${i + 1} key là tên số liệu (a-z, 0-9, _)`);
    else if (keys.has(m.key)) problems.push(`#${i + 1} ${m.key} trùng`);
    else keys.add(m.key);
    if (!Number.isFinite(m?.value)) problems.push(`#${i + 1} value là một số`);
    for (const f of ['previous', 'target']) if (m?.[f] !== undefined && !Number.isFinite(m[f])) problems.push(`#${i + 1} ${f} là một số`);
    if (m?.unit !== undefined && !(typeof m.unit === 'string' && UNITS.test(m.unit))) problems.push(`#${i + 1} unit tối đa 12 ký tự`);
    if (m?.good !== undefined && !['up', 'down'].includes(m.good)) problems.push(`#${i + 1} good là up hoặc down`);
  }
  if (list.filter(m => m?.north_star === true).length > 1) problems.push('chỉ một số liệu là north_star');
  if (problems.length) fail('invalid_request', `Chưa ghi số nào (tất cả hoặc không): ${problems.join('; ')}.`);
  const at = iso(now), source = typeof input.source === 'string' ? short(input.source, 60) : null;
  for (const m of list) {
    const row = {
      key: `${product}|${period.from}..${period.to}|${m.key}`, product, period_from: period.from, period_to: period.to, metric: m.key,
      label: typeof m.label === 'string' ? short(m.label, 40) : null, unit: m.unit ?? null, value: m.value, previous: m.previous ?? null,
      target: m.target ?? null, good: m.good ?? null, north_star: m.north_star === true, source, recorded_by: typeof soot === 'string' ? short(soot, 64) : null, recorded_at: at,
    };
    if (await store.update('metrics', [eq('key', row.key)], row) === 0) await store.insert('metrics', row);
  }
  return { ok: true, saved: list.length, product, period: `${period.from}..${period.to}` };
}
