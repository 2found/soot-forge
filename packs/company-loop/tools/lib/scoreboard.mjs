// scoreboard_sync: read the product's frozen scoreboard contract (api
// GET /admin/analysis/scoreboard?from&to, version 1) for the last 7 full days, keep
// one row per period, and append each finished week once to the 2build company
// baseline (`bbs company scoreboard record`). Aggregate numbers only; the key goes
// to SCOREBOARD_URL and nowhere else.
import { eq, getState, setState, getJson, safeUrl, skippedFor, iso, lastSevenDays, lastFullWeek, short } from './base.mjs';
import { runBbs } from './bbs.mjs';

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

const rowOf = board => ({
  key: `${board.range.from}..${board.range.to}`,
  period_from: board.range.from, period_to: board.range.to, product: String(board.product ?? ''),
  metrics: board.metrics, support: board.support ?? null, sources: board.sources ?? [], comparison: board.comparison ?? null,
});

const valid = b => b && b.version === 1 && b.metrics && typeof b.metrics === 'object' && !Array.isArray(b.metrics)
  && /^\d{4}-\d{2}-\d{2}$/.test(b.range?.from ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(b.range?.to ?? '')
  && Object.values(b.metrics).every(m => m && typeof m === 'object' && Number.isFinite(m.value));

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

/** Append one finished week to `bbs company scoreboard record`; returns a short status code. */
async function baseline(store, deps, board) {
  const week = board.range.from;
  if (await getState(store, `baseline:${week}`)) return 'already';
  const product = String(board.product ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(product)) return 'bad_product';
  const v = k => (Number.isFinite(board.metrics[k]?.value) && board.metrics[k].value >= 0 ? board.metrics[k].value : null);
  const flags = [['--revenue', v('revenue_vnd')], ['--active-users', v('active_readers')], ['--support-cases', v('support_threads_new')]].filter(([, n]) => n !== null);
  if (!flags.length) return 'no_numbers';
  const args = ['company', 'scoreboard', 'record', '--product', product, '--week', week, ...flags.flatMap(([f, n]) => [f, String(n)]), '--note', 'company-loop scoreboard_sync'];
  const r = await runBbs(deps.env, args, { cwd: deps.env.PRODUCT_REPO || undefined, timeoutMs: 20_000 });
  if (r.missing) return 'bbs_missing';
  if (!r.ok) return `bbs_failed: ${short(r.stderr, 120)}`;
  await setState(store, `baseline:${week}`, { at: iso(deps.now), product });
  return 'recorded';
}

export async function scoreboard_sync(input, deps) {
  const { store, env, now } = deps;
  if (!env.PRODUCT_ADMIN_KEY) return skippedFor('PRODUCT_ADMIN_KEY');
  const url = safeUrl(env.SCOREBOARD_URL);
  if (!url) return skippedFor('SCOREBOARD_URL');
  const period = lastSevenDays(now);
  const got = await fetchBoard(deps, url, env.PRODUCT_ADMIN_KEY, period);
  if (got.error) {
    // One plain line, raised once per kind of failure; the page keeps showing it.
    const before = await getState(store, 'sync');
    const isNew = before?.code !== got.error.code;
    await setState(store, 'sync', { ok: false, code: got.error.code, message: got.error.message, at: iso(now) });
    const ask = isNew && got.error.code === 'forbidden'
      ? { keys: ['company:scoreboard:forbidden'], summary: 'Soot chưa đọc được bảng số của sản phẩm', missing: got.error.message, options: [{ label: 'Đã đổi khoá', recommended: true }, { label: 'Để sau' }] } : undefined;
    return { ok: false, reason_code: got.error.code, error: { code: got.error.code, message: got.error.message }, message: got.error.message, notify: isNew, wake: isNew, ...(ask ? { ask } : {}) };
  }
  const row = await save(store, got.board, now);
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
  return { done: true, period: row.key, baseline: base };
}
