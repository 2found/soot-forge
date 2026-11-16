// The team contract is what the runtime enforces between teams: a queue or table row may carry only declared
// fields, and a Workshop that reads a table sees only declared fields. A tool that writes a column the contract does
// not name loses it silently on a live runtime (the builder then fails "no_source: title_too_short"). This test reads
// the pack's tool sources, finds every column written to the two contract-bound tables, and requires the repo's
// declared fields on both sides to cover them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const here = new URL('../', import.meta.url);
const soot = new URL('../../', here);
const json = u => JSON.parse(readFileSync(u, 'utf8'));
const LIB = new URL('tools/lib/', here);
const sources = readdirSync(LIB).filter(f => f.endsWith('.mjs')).map(f => ({ f, s: readFileSync(new URL(f, LIB), 'utf8') }));

/** Blank every string, template and comment so braces and colons inside them cannot confuse the scan. */
function blank(s) {
  let out = '', i = 0;
  const stack = []; // template depth: brace depth to return to
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === "'" || c === '"') { out += c; i++; while (i < s.length && s[i] !== c) { if (s[i] === '\\') { out += ' '; i++; } out += ' '; i++; } out += c; i++; continue; }
    if (c === '`') { out += c; i++; while (i < s.length && s[i] !== '`') { if (s[i] === '\\') { out += ' '; i++; } if (s[i] === '$' && s[i + 1] === '{') { let d = 0; do { if (s[i] === '{') d++; if (s[i] === '}') d--; out += ' '; i++; } while (d > 0 && i < s.length); continue; } out += ' '; i++; } out += c; i++; continue; }
    out += c; i++;
  }
  void stack;
  return out;
}

/** Keys of the object literal opened at s[open]: depth-1 keys, shorthand, and keys of `cond ? { k } : {}` spreads. */
function keysAt(raw, s, open, name) {
  const keys = new Set();
  let depth = 0, i = open;
  const prev = j => { j--; while (j >= 0 && /\s/.test(s[j])) j--; return s[j]; };
  let start = open + 1;
  const flush = (a, b, d) => {
    const seg = s.slice(a, b).trim();
    if (d !== 1) return;
    let m = /^\.\.\.\s*([A-Za-z_]\w*)\s*$/.exec(seg);
    if (m) { for (const k of assigned(s, m[1])) keys.add(k); return; }
    m = /^([A-Za-z_]\w*)\s*(?::|$)/.exec(seg);
    if (m) keys.add(m[1]);
  };
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      if (depth >= 1 && prev(i) === '?') { for (const k of keysAt(raw, s, i)) keys.add(k); }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { flush(start, i, 1); break; }
    } else if (c === ',' && depth === 1) { flush(start, i, 1); start = i + 1; }
    else if ((c === '(' || c === '[') ) { // skip nested parens/brackets as a unit, but keep scanning their `? {` spreads
      let d = 1; const a = i; i++;
      while (i < s.length && d > 0) { if (s[i] === '(' || s[i] === '[') d++; if (s[i] === ')' || s[i] === ']') d--; i++; }
      i--;
      const seg = s.slice(a, i + 1);
      for (const m of seg.matchAll(/\?\s*\{/g)) for (const k of keysAt(raw, s, a + m.index + m[0].length - 1)) keys.add(k);
    }
  }
  void name;
  return keys;
}
/** `NAME.key = ...` assignments and the keys of `const NAME = {...}`. */
function assigned(s, name) {
  const keys = new Set();
  for (const m of s.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_]\\w*)\\s*=(?!=)`, 'g'))) keys.add(m[1]);
  const d = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*\\{`).exec(s);
  if (d) for (const k of keysAt(null, s, d.index + d[0].length - 1)) keys.add(k);
  return keys;
}

/** Every column the pack's tools write to `table` (insert, update, or an insertItem into a queue). */
function written(table) {
  const out = new Map();
  const note = (k, where) => { if (!out.has(k)) out.set(k, where); };
  for (const { f, s: raw } of sources) {
    const s = blank(raw);
    // store.insert('t', {...}) / store.update('t', id, {...}) / insertItem(deps, 't', {...}|NAME)
    const re = new RegExp(`(?:insert|update|upsert|insertItem)\\([^;]*?'${table}'\\s*,`, 'g');
    for (const m of raw.matchAll(re)) {
      const at = m.index + m[0].length;
      const tail = s.slice(at, at + 4000);
      const lit = /^\s*(?:[A-Za-z_][\w.]*(?:\([^()]*\))?\s*,\s*)?\{/.exec(tail);
      if (lit) { for (const k of keysAt(raw, s, at + lit[0].length - 1)) note(k, f); continue; }
      const id = /^\s*(?:[A-Za-z_]\w*\s*,\s*)?([A-Za-z_]\w*)\s*\)/.exec(tail);
      if (id) for (const k of assigned(s, id[1])) note(k, f);
    }
  }
  return out;
}

const server = json(new URL('runtimes/server/config/flock.json', soot));
const mac = json(new URL('runtimes/mac/config/deployment.json', soot));
const ops = (Array.isArray(server.groups) ? server.groups.find(g => g.id === 'operations' || g.name === 'Operations') : server.groups.operations).contract;
const queue = ops.provides.queues.find(q => q.name === 'catalog_job_events');
const table = ops.provides.tables.find(t => t.name === 'catalog_jobs');
const consumed = JSON.stringify(mac).includes('"catalog_jobs"') ? (function find(o) { if (o && typeof o === 'object') { if (o.item === 'catalog_jobs' && o.team === 'operations') return o; for (const v of Object.values(o)) { const r = find(v); if (r) return r; } } return null; })(mac) : null;
// Columns the pack's own store adds (id, timestamps) are not row fields a team declares.
const OWN = new Set(['id', '_id', 'created_at', 'updated_at', 'key', 'value']);

test('the scanner sees what the tools write (guards the test itself)', () => {
  const jobs = [...written('catalog_jobs').keys()];
  for (const k of ['product', 'kind', 'state', 'approved_by', 'request_id', 'title', 'source_url', 'novel_slug', 'chapters', 'acked']) assert.ok(jobs.includes(k), `catalog_jobs write ${k} not found by the scanner: ${jobs}`);
  const ev = [...written('catalog_job_events').keys()];
  for (const k of ['job_id', 'state', 'detail', 'at', 'novel_slug', 'chapters', 'copyright']) assert.ok(ev.includes(k), `catalog_job_events write ${k} not found by the scanner: ${ev}`);
});

test('catalog_job_events: every field a tool writes is declared by the operations queue contract', () => {
  const declared = new Set(queue.fields);
  const missing = [...written('catalog_job_events')].filter(([k]) => !OWN.has(k) && !declared.has(k)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, [], `declare in flock.json operations provides.queues[catalog_job_events].fields: ${missing}`);
});

test('catalog_jobs: every field a tool writes is declared on the operations side and the Workshop side', () => {
  assert.ok(consumed, 'the Workshop consumes catalog_jobs');
  for (const [label, fields] of [['operations provides.tables[catalog_jobs]', table.fields], ['workshop consumes catalog_jobs', consumed.fields]]) {
    const declared = new Set(fields);
    const missing = [...written('catalog_jobs')].filter(([k]) => !OWN.has(k) && !declared.has(k)).map(([k, f]) => `${k} (${f})`);
    assert.deepEqual(missing, [], `declare in ${label}: ${missing}`);
  }
});

test('the two sides of the catalog_jobs contract declare the same fields', () => {
  assert.deepEqual([...consumed.fields].sort(), [...table.fields].sort());
});
