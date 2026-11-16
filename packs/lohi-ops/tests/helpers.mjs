import { wrap } from '../tools/lib/base.mjs';

/** In-memory pack storage with the three operations the tools use (query/insert/update). */
export function fakeStore() {
  const tables = new Map();
  let seq = 0;
  const rows = t => tables.get(t) ?? tables.set(t, []).get(t);
  const match = (row, where = []) => where.every(w => (w.op === 'in' ? w.values.includes(row[w.column]) : w.op === 'gte' ? String(row[w.column] ?? '') >= String(w.value) : row[w.column] === w.value));
  const call = async (table, op, body) => {
    const list = rows(table);
    if (op === 'query') return { rows: list.filter(r => match(r, body.where)).slice(0, body.limit ?? 500).map(r => ({ ...r })) };
    if (op === 'insert') {
      const unique = ['key', 'reply_id', 'rid'].find(k => body.row[k] !== undefined);
      if (unique && list.some(r => r[unique] === body.row[unique])) { const e = new Error('dup'); e.code = 'conflict'; throw e; }
      const id = `row${++seq}`; list.push({ id, created_at: `2026-11-11T00:00:${String(seq).padStart(2, '0')}Z`, ...body.row }); return { id };
    }
    if (op === 'update') {
      const hit = list.filter(r => (body.id ? r.id === body.id : match(r, body.where)));
      hit.forEach(r => Object.assign(r, body.set));
      return { affected: hit.length };
    }
    throw new Error(`op ${op}`);
  };
  const store = wrap(call);
  store.tables = tables;
  return store;
}

export const KEYED = { PRODUCT_ADMIN_KEY: 'test-key-not-real', PRODUCT_API_URL: 'https://api.example.test' };

/** A fetch that answers per "METHOD /path" and records the calls (with the headers). */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const hit = routes[`${init.method} ${u.pathname}`];
    const [status, body] = typeof hit === 'function' ? hit(u) : hit ?? [404, {}];
    return { status, ok: status < 400, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

/** An in-memory cli catalog (node:sqlite) with just the columns the pack reads. */
export async function fakeCatalog(novels = [], chapters = []) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE source_catalog (source_slug TEXT, novel_slug TEXT, title TEXT, cn_title TEXT, landing_url TEXT, is_prd_sync INTEGER DEFAULT 0, copyright_issue INTEGER DEFAULT 0, copyright_reason TEXT, status TEXT, has_new_chapters INTEGER DEFAULT 0);
    CREATE TABLE chapters (source_slug TEXT, novel_slug TEXT, chapter_number INTEGER, content TEXT);`);
  const ins = db.prepare('INSERT INTO source_catalog (source_slug, novel_slug, title, cn_title, landing_url, is_prd_sync, copyright_issue, copyright_reason, status, has_new_chapters) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const n of novels) ins.run(n.source, n.novel, n.title ?? null, n.cn_title ?? null, n.landing_url ?? null, n.prd ?? 0, n.copyright ?? 0, n.reason ?? null, n.status ?? 'ongoing', n.fresh ?? 0);
  const c = db.prepare('INSERT INTO chapters VALUES (?,?,?,?)');
  for (const [s, n, from, to] of chapters) for (let i = from; i <= to; i++) c.run(s, n, i, 'text');
  const real = db.close.bind(db);
  db.close = () => {}; db.reallyClose = real; // the tools close what they open; the test keeps one db
  return db;
}
