// Shared helpers of the company-loop tools: errors, the pack-storage client
// (contract pack-storage v1), Asia/Ho_Chi_Minh days, and the one place that
// calls a product or CS address with a key.

export class LoopError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new LoopError(code, message); };

export const SETUP_LINK = 'nest://settings/setup';
/** An optional credential or env that is not set: nothing to do, said quietly (the runtime reads it as `skipped`). */
export const skippedFor = key => ({ ok: true, skipped: true, reason_code: 'optional_credential', key, notify: false, wake: false });

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
    async remove(table, target) {
      return (await call(table, 'delete', typeof target === 'string' ? { id: target } : { where: target })).affected ?? 0;
    },
  };
}

export const eq = (column, value) => ({ column, op: 'eq', value });
export const lte = (column, value) => ({ column, op: 'lte', value });
export const gte = (column, value) => ({ column, op: 'gte', value });
export const isNull = column => ({ column, op: 'is_null' });
export const inList = (column, values) => ({ column, op: 'in', values });

/** A small key/value row (`state` table): sync status, weekly baselines already written. */
export async function getState(store, key) { return (await store.one('state', [eq('key', key)]))?.value ?? null; }
export async function setState(store, key, value) {
  if (await store.update('state', [eq('key', key)], { value }) === 0) {
    try { await store.insert('state', { key, value }); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('state', [eq('key', key)], { value }); }
  }
}

// ---------- days (Asia/Ho_Chi_Minh, UTC+7, no DST) ----------
const DAY = 86_400_000, TZ_MS = 7 * 3_600_000;
export const iso = ms => new Date(ms).toISOString();
/** The ICT calendar day (YYYY-MM-DD) of a timestamp. */
export const ictDay = ms => new Date(ms + TZ_MS).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** The Monday of the ISO week containing the day. */
export const mondayOf = day => { const wd = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; return addDays(day, -wd); };
/** The last 7 full ICT days before `now`: {from, to}. */
export const lastSevenDays = now => { const to = addDays(ictDay(now), -1); return { from: addDays(to, -6), to }; };
/** The last complete Monday..Sunday week before `now`. */
export const lastFullWeek = now => { const mon = addDays(mondayOf(ictDay(now)), -7); return { from: mon, to: addDays(mon, 6) }; };

// ---------- addresses ----------
const HTTPS = /^https:\/\/[^/\s]+/, LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;
/** A key travels only over https (plain http only to this machine). Returns a URL or null. */
export function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || !(HTTPS.test(s) || LOCAL.test(s))) return null;
  try { return new URL(s); } catch { return null; }
}

/**
 * One GET with a key. {out} or {error:{code, host, message}}; never throws for the other side's failures.
 * `why` words each failure in one plain Vietnamese line.
 */
export async function getJson(deps, url, headers, why) {
  const host = url.host;
  let res;
  try { res = await deps.fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(deps.apiTimeoutMs ?? 10_000) }); }
  catch { return { error: { code: 'unreachable', host, message: why.unreachable(host) } }; }
  if (res.status === 401 || res.status === 403) return { error: { code: 'forbidden', host, message: why.forbidden(host) } };
  if (!res.ok) return { error: { code: res.status >= 500 ? 'unreachable' : 'failed', host, message: (res.status >= 500 ? why.unreachable : why.failed)(host, res.status) } };
  const out = await res.json().catch(() => null);
  return out && typeof out === 'object' ? { out } : { error: { code: 'bad', host, message: why.bad(host) } };
}

export const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
export const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
