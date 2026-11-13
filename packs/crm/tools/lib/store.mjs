// Pack storage client (contract pack-storage v1): POST {SOOT_STORAGE_URL}/{table}/{op}
// with the per-call token. The level always comes from the token, so this
// pack reads and writes only `pack:crm` of the runtime that runs the call.

export class CrmError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
export const fail = (code, message, extra) => { throw new CrmError(code, message, extra); };

export function storage(env, fetchImpl = fetch) {
  const url = env.SOOT_STORAGE_URL, token = env.SOOT_STORAGE_TOKEN;
  const call = async (table, op, body) => {
    if (!url || !token) fail('storage_unavailable', 'The host gave this call no pack storage.');
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/${table}/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (res.status === 409) fail('conflict', out.error || 'a unique value is already stored');
    if (!res.ok) fail(out.code || 'storage_failed', out.error || `pack storage answered ${res.status}`);
    return out;
  };
  return wrap(call);
}

/** The runtime's page cap (workspace.MaxPageRows). */
export const PAGE = 500;

/** Helpers over a raw `call(table, op, body)`; tests wrap an in-memory store the same way. */
export function wrap(call) {
  return {
    call,
    async query(table, where = [], { order = 'created_at', desc = true, limit = PAGE } = {}) {
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
    async search(table, query, where = [], limit = 20) { return (await call(table, 'search', { query, where, limit })).rows ?? []; },
  };
}

export const eq = (column, value) => ({ column, op: 'eq', value });
export const gte = (column, value) => ({ column, op: 'gte', value });
export const lte = (column, value) => ({ column, op: 'lte', value });
export const isNull = column => ({ column, op: 'is_null' });
export const inList = (column, values) => ({ column, op: 'in', values });
