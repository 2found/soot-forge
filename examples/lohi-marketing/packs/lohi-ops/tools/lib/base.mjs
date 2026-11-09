// Shared helpers of the lohi-ops tools: errors, the pack-storage client (contract pack-storage v1),
// Asia/Ho_Chi_Minh days, and the one place that calls the Lohi api with the operator's key.

export class OpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new OpsError(code, message); };

export const SETUP_LINK = 'nest://settings/setup';
/** An optional credential or env that is not set: nothing to do, said quietly (the runtime reads it as `skipped`). */
export const skippedFor = key => ({ ok: true, skipped: true, reason_code: 'optional_credential', key, notify: false, wake: false });
/** A credential the action itself needs and the host did not give: a decided answer that names the key, never a crash. */
export const needsCredential = (key, why) => {
  const message = `${why} Mở Thiết lập để nhập ${key} (${SETUP_LINK}).`;
  return { ok: false, reason_code: 'needs_credential', key, message, link: SETUP_LINK, error: { code: 'needs_credential', message } };
};

const SETUP_WHAT = {
  PRODUCT_ADMIN_KEY: { for: 'đọc sức khoẻ kho truyện', how: 'Khoá API vai trò agent_mod của Lohi; dùng chung khoá đã nhập cho marketing.' },
  PRODUCT_API_URL: { for: 'gọi api sản phẩm', how: 'Địa chỉ https của api sản phẩm, ví dụ https://api.lohi2.com.' },
  CLI_CATALOG_DB: { for: 'theo dõi thu thập truyện', how: 'Đường dẫn tới cli/data/catalog.db trên máy chạy Soot.' },
};
/**
 * A key or path the pack cannot work without, not set. Schedules stay quiet (the run is a plain skip), but the person is
 * asked ONCE, with the exact next step: which key, and where in Nest it goes. The card clears itself when a run
 * finds the key (clearSetup).
 */
export async function setupNeed(deps, key) {
  const quiet = skippedFor(key);
  if (!deps.store) return quiet;
  const what = SETUP_WHAT[key] ?? { for: 'chạy gói lohi-ops', how: '' };
  const card = await needCard(deps.store, `setup:${key}`, {
    items: [key], sig: key, summary: `Thiếu ${key} để ${what.for}`,
    lines: [`Mở Nest, vào Cài đặt, chọn Thiết lập, tìm ${key} và nhập giá trị (${SETUP_LINK}). ${what.how}`.trim(), 'Nhập xong, lịch tự chạy lại ở lần tới; không cần báo lại.'],
    options: [{ label: 'Đã nhập, kiểm tra lại' }],
  });
  return { ...quiet, notify: card.notify, wake: card.wake, ...(card.ask ? { ask: card.ask } : {}) };
}
/** The key is there now: close its card, once. Returns {resolves_need: true} or {}. */
export async function clearSetup(deps, ...keys) {
  if (!deps.store) return {};
  let cleared = false;
  for (const key of keys) {
    const r = await needCard(deps.store, `setup:${key}`, { items: [], summary: '', lines: [] });
    cleared = cleared || r.resolves_need === true;
  }
  return cleared ? { resolves_need: true } : {};
}

export function storage(env, fetchImpl = fetch) {
  const url = env.SOOT_STORAGE_URL, token = env.SOOT_STORAGE_TOKEN;
  const call = async (table, op, body) => {
    if (!url || !token) fail('storage_unavailable', 'The host gave this call no pack storage.');
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/${table}/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) fail(out.code || 'storage_failed', out.error || `pack storage answered ${res.status}`);
    return out;
  };
  return wrap(call);
}

export function wrap(call) {
  return {
    call,
    async query(table, where = [], { order = 'created_at', desc = true, limit = 500 } = {}) {
      return (await call(table, 'query', { where, order, desc, limit })).rows ?? [];
    },
    async one(table, where) { return (await call(table, 'query', { where, limit: 1 })).rows?.[0] ?? null; },
    async insert(table, row) { return (await call(table, 'insert', { row })).id; },
    async update(table, target, set) {
      const body = typeof target === 'string' ? { id: target, set } : { where: target, set };
      return (await call(table, 'update', body)).affected ?? 0;
    },
  };
}

export const eq = (column, value) => ({ column, op: 'eq', value });
export const inList = (column, values) => ({ column, op: 'in', values });

export async function getState(store, key) { return (await store.one('state', [eq('key', key)]))?.value ?? null; }
export async function setState(store, key, value) {
  if (await store.update('state', [eq('key', key)], { value }) === 0) {
    try { await store.insert('state', { key, value }); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('state', [eq('key', key)], { value }); }
  }
}
/** Insert, or update the row that already holds this unique key. */
export async function upsert(store, table, keyColumn, row) {
  if (await store.update(table, [eq(keyColumn, row[keyColumn])], row) === 0) {
    try { await store.insert(table, row); } catch (e) { if (e.code !== 'conflict') throw e; await store.update(table, [eq(keyColumn, row[keyColumn])], row); }
  }
}

// ---------- time (Asia/Ho_Chi_Minh, UTC+7, no DST) ----------
const DAY = 86_400_000, TZ_MS = 7 * 3_600_000;
export const iso = ms => new Date(ms).toISOString();
export const ictDay = ms => new Date(ms + TZ_MS).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ---------- addresses and the api ----------
const HTTPS = /^https:\/\/[^/\s]+/, LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;
/** A key travels only over https (plain http only to this machine). Returns a URL or null. */
export function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !(HTTPS.test(s) || LOCAL.test(s))) return null;
  try { return new URL(s); } catch { return null; }
}

export const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

/**
 * One call to the Lohi api with the agent_mod key, sent only to PRODUCT_API_URL as `X-API-Key`.
 * Answers {out} or {error:{code, status?, message}}; never throws for the other side's failures.
 * A missing key or address is {skipped} (the tool answers the quiet skip).
 */
export async function lohiApi(deps, method, path, { query, body } = {}) {
  const key = deps.env?.PRODUCT_ADMIN_KEY;
  if (!key) return { skipped: 'PRODUCT_ADMIN_KEY' };
  const base = safeUrl(deps.env?.PRODUCT_API_URL);
  if (!base) return { skipped: 'PRODUCT_API_URL' };
  const url = new URL(path.replace(/^\/+/, ''), base.toString().replace(/\/*$/, '/'));
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await deps.fetch(url.toString(), {
      method, redirect: 'error', signal: AbortSignal.timeout(deps.apiTimeoutMs ?? 20_000),
      headers: { Accept: 'application/json', 'X-API-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { return { error: { code: 'unreachable', message: `Không gọi được ${base.host}.` } }; }
  if (res.status === 401 || res.status === 403) return { error: { code: 'forbidden', status: res.status, message: `${base.host} từ chối khoá PRODUCT_ADMIN_KEY (cần vai trò agent_mod).` } };
  if (res.status === 404) return { error: { code: 'not_found', status: 404, message: `${base.host} không có ${url.pathname}.` } };
  if (!res.ok) return { error: { code: res.status >= 500 ? 'unreachable' : 'failed', status: res.status, message: `${base.host} trả lời ${res.status}.` } };
  const out = await res.json().catch(() => null);
  return out && typeof out === 'object' ? { out } : { error: { code: 'bad', message: `${base.host} trả lời không đúng dạng JSON.` } };
}

/**
 * The Cần bạn card shape shared by the tools: `ask` is filed by the runtime itself as a card (the same ask is one
 * card, a changed one replaces it), so nothing wakes a model to relay it. `resolves_need` closes it once, when the
 * items are gone.
 */
export async function needCard(store, key, { items, summary, lines, options = [{ label: 'Đã xong, kiểm tra lại' }], sig }) {
  const last = (await getState(store, `need:${key}`))?.sig ?? '';
  const signature = sig ?? items.slice().sort().join(',');
  const next = items.length ? signature : '';
  if (next !== last) await setState(store, `need:${key}`, { sig: next });
  if (!items.length) return { wake: false, notify: false, ...(last ? { resolves_need: true } : {}) };
  return { wake: false, notify: false, ask: { keys: [`ops:${key}`], summary, missing: lines.join('\n'), options } };
}
