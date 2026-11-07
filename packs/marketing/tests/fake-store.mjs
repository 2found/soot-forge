// An in-memory pack store with the route semantics the tools rely on
// (contract pack-storage v1): declared tables and columns only, `where` as an
// object or a condition list, `update`/`delete` by id or by where (the claim's
// compare-and-set), `unique` → conflict, accent-insensitive search.
import { readFileSync } from 'node:fs';
import { wrap, MarketingError } from '../tools/lib/store.mjs';

const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

export function fakeStore({ clock = () => Date.now() } = {}) {
  const decl = Object.fromEntries(pack.storage.tables.map(t => [t.name, t]));
  const data = Object.fromEntries(pack.storage.tables.map(t => [t.name, []]));
  let seq = 0, tick = 0;
  const stamp = () => new Date(clock() + (tick++)).toISOString();
  const no = (code, msg) => { throw new MarketingError(code, msg); };
  const cols = t => new Set(['id', 'created_at', 'updated_at', ...decl[t].columns.map(c => c.name)]);
  const checkCols = (t, row) => { for (const k of Object.keys(row)) if (!cols(t).has(k)) no('invalid', `${t} has no column ${k}`); };
  const conds = (t, where) => {
    if (!where) return [];
    const list = Array.isArray(where) ? where : Object.entries(where).map(([column, value]) => ({ column, op: 'eq', value }));
    for (const c of list) if (!cols(t).has(c.column)) no('invalid', `${t} has no column ${c.column}`);
    return list;
  };
  const match = (row, list) => list.every(c => {
    const v = row[c.column] ?? null;
    switch (c.op) {
      case 'eq': return v === c.value;
      case 'ne': return v !== c.value && v !== null;
      case 'lt': return v !== null && v < c.value;
      case 'lte': return v !== null && v <= c.value;
      case 'gt': return v !== null && v > c.value;
      case 'gte': return v !== null && v >= c.value;
      case 'in': return c.values.includes(v);
      case 'is_null': return v === null;
      case 'not_null': return v !== null;
    }
    return no('invalid', `op ${c.op}`);
  });
  const unique = (t, row, self) => {
    for (const c of decl[t].columns.filter(c => c.unique)) {
      if (row[c.name] == null) continue;
      if (data[t].some(r => r !== self && r[c.name] === row[c.name])) no('conflict', `unique_violation ${t}.${c.name}`);
    }
  };
  const required = (t, row) => { for (const c of decl[t].columns.filter(c => c.required)) if (row[c.name] == null) no('invalid', `${t}.${c.name} is required`); };
  const copy = r => structuredClone(r);
  const targets = (t, body) => body.id ? data[t].filter(r => r.id === body.id) : data[t].filter(r => match(r, conds(t, body.where)));

  async function call(t, op, body = {}) {
    if (!decl[t]) no('table_not_found', t);
    switch (op) {
      case 'insert': {
        const row = body.row;
        checkCols(t, row); required(t, row); unique(t, row);
        const now = stamp();
        const full = { ...Object.fromEntries(decl[t].columns.map(c => [c.name, null])), ...copy(row), id: `r_${++seq}`, created_at: now, updated_at: now };
        data[t].push(full);
        return { id: full.id, affected: 1 };
      }
      case 'query': {
        let rows = data[t].filter(r => match(r, conds(t, body.where)));
        const order = body.order ?? 'created_at';
        rows = rows.slice().sort((a, b) => (a[order] ?? '') < (b[order] ?? '') ? -1 : (a[order] ?? '') > (b[order] ?? '') ? 1 : 0);
        if (body.desc) rows.reverse();
        return { rows: rows.slice(0, body.limit ?? 50).map(copy) };
      }
      case 'get': return { row: copy(data[t].find(r => r.id === body.id) ?? null) };
      case 'update': {
        checkCols(t, body.set);
        const hit = targets(t, body);
        for (const r of hit) { unique(t, { ...r, ...body.set }, r); Object.assign(r, copy(body.set), { updated_at: stamp() }); }
        return { affected: hit.length };
      }
      case 'delete': {
        const hit = new Set(targets(t, body));
        data[t] = data[t].filter(r => !hit.has(r));
        return { affected: hit.size };
      }
      case 'search': {
        const s = decl[t].columns.filter(c => c.search).map(c => c.name);
        const q = fold(body.query);
        return { rows: data[t].filter(r => match(r, conds(t, body.where)) && s.some(c => fold(r[c]).includes(q))).slice(0, body.limit ?? 50).map(copy) };
      }
    }
    return no('not_found', op);
  }
  return Object.assign(wrap(call), { data });
}
