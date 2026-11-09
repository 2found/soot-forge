// scoreboard_sync: read the product's frozen scoreboard contract (api
// GET /admin/analysis/scoreboard?from&to, version 1) for the last 7 full days, keep
// one row per period, and append each finished week once to the 2build company
// baseline (`bbs company scoreboard record`). Aggregate numbers only; the key goes
// to SCOREBOARD_URL and nowhere else.
import { eq, getState, setState, getJson, safeUrl, skippedFor, iso, lastSevenDays, lastFullWeek, short } from './base.mjs';
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
export const labelOf = (key, m) => METRICS[key]?.[0] || m?.label || key;

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

const rowOf = board => ({
  key: `${board.range.from}..${board.range.to}`,
  period_from: board.range.from, period_to: board.range.to, product: String(board.product ?? ''),
  metrics: board.metrics, support: board.support ?? null, sources: board.sources ?? [], comparison: board.comparison ?? null,
  cohorts: cleanCohorts(board.cohorts), plans: cleanPlans(board.plans),
});

const valid = b => b && b.version === 1 && b.metrics && typeof b.metrics === 'object' && !Array.isArray(b.metrics)
  && /^\d{4}-\d{2}-\d{2}$/.test(b.range?.from ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(b.range?.to ?? '')
  && Object.values(b.metrics).every(m => m && typeof m === 'object' && (m.value === null || Number.isFinite(m.value)) && (m.previous == null || Number.isFinite(m.previous)));

async function fetchBoard(deps, url, key, { from, to }) {
  const u = new URL(url.toString());
  u.searchParams.set('from', from); u.searchParams.set('to', to);
  const r = await getJson(deps, u, { 'X-API-Key': key }, WHY);
  if (r.error) return r;
  return valid(r.out) ? { board: r.out } : { error: { code: 'bad', host: u.host, message: WHY.bad(u.host) } };
}

async function save(store, board, now) {
  const row = rowOf(board);
  if (await store.update('scoreboard', [eq('key', row.key)], { ...row, fetched_at: iso(now) }) === 0) await store.insert('scoreboard', { ...row, fetched_at: iso(now) });
  return row;
}

/** The newest stored period (by its end day), or null. */
export async function latestBoard(store) {
  return (await store.query('scoreboard', [], { order: 'period_to', limit: 1 }))[0] ?? null;
}

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
async function baseline(store, deps, board) {
  const week = board.range.from;
  if (await getState(store, `baseline:${week}`)) return 'already';
  const product = String(board.product ?? '');
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
  await setState(store, `baseline:${week}`, { at: iso(deps.now), product });
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
  const n = board.support?.by_state?.waiting_human;
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

export async function scoreboard_sync(input, deps) {
  const { store, env, now } = deps;
  if (!env.PRODUCT_ADMIN_KEY) return skippedFor('PRODUCT_ADMIN_KEY');
  const url = safeUrl(env.SCOREBOARD_URL);
  if (!url) return skippedFor('SCOREBOARD_URL');
  const period = lastSevenDays(now);
  const got = await fetchBoard(deps, url, env.PRODUCT_ADMIN_KEY, period);
  if (got.error) {
    // One plain line; the card is filed by the runtime, once per incident (an incident ends at the next good read).
    const before = await getState(store, 'sync');
    const since = before?.code === got.error.code && before.since ? before.since : iso(now);
    await setState(store, 'sync', { ok: false, code: got.error.code, message: got.error.message, at: iso(now), since });
    const raise = got.error.code === 'forbidden'
      ? { id: `company:scoreboard:forbidden:${since.slice(0, 10)}`, group: 'company:scoreboard:forbidden', title: 'Soot chưa đọc được bảng số của sản phẩm', why: got.error.message, options: [{ id: 'fixed', label: 'Đã đổi khoá', recommended: true }, { id: 'later', label: 'Để sau' }], reraise_after_hours: 72 } : undefined;
    return { ok: false, reason_code: got.error.code, error: { code: got.error.code, message: got.error.message }, message: got.error.message, notify: false, wake: false, ...(raise ? { raise } : {}) };
  }
  const row = await save(store, got.board, now);
  const wasForbidden = (await getState(store, 'sync'))?.code === 'forbidden';
  await setState(store, 'sync', { ok: true, at: iso(now), period: row.key });
  // The finished Monday..Sunday week goes to the company baseline once; the rolling window is the same week on Mondays.
  const lw = lastFullWeek(now);
  let base = await getState(store, `baseline:${lw.from}`) ? 'already' : null;
  if (!base) {
    const same = got.board.range.from === lw.from && got.board.range.to === lw.to;
    const wk = same ? { board: got.board } : await fetchBoard(deps, url, env.PRODUCT_ADMIN_KEY, lw);
    base = wk.error ? 'week_unreadable' : await baseline(store, deps, wk.board);
  }
  if (input.for_digest) return { ok: true, synced: true, period: row.key, baseline: base };
  const need = waitingNeed(env, got.board);
  return { done: true, period: row.key, baseline: base, ...need, ...(wasForbidden ? { settle: [...(need.settle ?? []), 'company:scoreboard:forbidden'] } : {}) };
}
