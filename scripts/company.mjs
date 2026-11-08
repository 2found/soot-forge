// A company is a set of teams, each an interface (what it takes in, gives out, decides alone or with the founder, its daily
// token budget and when it escalates). The runtime has no company object yet, so the composition lives here as data:
// `groups/company-team/company.source.json` is the template, a per-company overlay adds, removes, renames or patches teams
// and contracts, and `composeCompany` returns the resolved company. Nothing here edits a runtime; `setup` reads the result.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateGroup } from './groups.mjs';

const ident = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(v);
const lists = (v, max = 32) => Array.isArray(v) && v.length <= max;
const fail = m => { throw new Error(`Invalid company: ${m}`); };
const clone = x => structuredClone(x);

/** The template plus an overlay: {remove, rename, teams: {id: patch}, add, contracts: {add, remove}, daily_token_ceiling}. */
export function composeCompany(template, overlay = {}) {
  const c = clone(template);
  const o = overlay ?? {};
  for (const k of Object.keys(o)) if (!['extends', 'id', 'name', 'description', 'remove', 'rename', 'teams', 'add', 'contracts', 'daily_token_ceiling'].includes(k)) fail(`unknown overlay field ${k}`);
  if (o.extends && o.extends !== template.id) fail(`overlay extends ${o.extends}, not ${template.id}`);
  for (const k of ['id', 'name', 'description', 'daily_token_ceiling']) if (o[k] !== undefined) c[k] = o[k];
  const known = id => c.teams.some(t => t.id === id);
  for (const id of o.remove ?? []) { if (!known(id)) fail(`remove names unknown team ${id}`); c.teams = c.teams.filter(t => t.id !== id); }
  for (const [id, patch] of Object.entries(o.teams ?? {})) {
    const t = c.teams.find(x => x.id === id);
    if (!t) fail(`patch names unknown team ${id}`);
    for (const [k, v] of Object.entries(patch)) t[k] = k === 'decides' ? { ...t.decides, ...v } : v;
  }
  for (const t of o.add ?? []) { if (known(t.id)) fail(`add repeats team ${t.id}`); c.teams.push(clone(t)); }
  for (const [from, to] of Object.entries(o.rename ?? {})) {
    if (!known(from)) fail(`rename names unknown team ${from}`);
    if (known(to)) fail(`rename target ${to} exists`);
    c.teams.find(t => t.id === from).id = to;
    for (const k of c.contracts) { if (k.owner === from) k.owner = to; if (k.reader === from) k.reader = to; }
    for (const t of c.teams) for (const i of t.takes_in ?? []) if (i.from === from) i.from = to;
  }
  for (const id of o.contracts?.remove ?? []) { if (!c.contracts.some(k => k.id === id)) fail(`contract ${id} unknown`); c.contracts = c.contracts.filter(k => k.id !== id); }
  for (const k of o.contracts?.add ?? []) { if (c.contracts.some(x => x.id === k.id)) fail(`contract ${k.id} repeated`); c.contracts.push(clone(k)); }
  // A contract whose team was removed goes with it when it is optional; a required one makes the company invalid.
  const live = new Set(c.teams.map(t => t.id));
  c.contracts = c.contracts.filter(k => {
    if (live.has(k.owner) && live.has(k.reader)) return true;
    if (k.optional) return false;
    return fail(`contract ${k.id} needs ${live.has(k.owner) ? k.reader : k.owner}, which this company does not have`);
  });
  const cids = new Set(c.contracts.map(k => k.id));
  for (const t of c.teams) t.takes_in = (t.takes_in ?? []).filter(i => (!i.from || live.has(i.from)) && (!i.contract || cids.has(i.contract)));
  return c;
}

/**
 * Checks a resolved company against the Forge: every team has a group of this catalog (or declares an external runtime),
 * every contract names a table its owner gives out with only declared fields, and (given the packs' manifests) only columns
 * the pack really has. The total of daily budgets stays under the ceiling and a group-backed team's budget equals its lean profile.
 */
export async function validateCompany(c, { root, packs = {} } = {}) {
  if (c.api_version !== 'soot-forge/company-template/v1' || !ident(c.id) || !lists(c.teams, 24) || !c.teams.length || !lists(c.contracts, 64)) fail('shape');
  if (!Number.isInteger(c.daily_token_ceiling) || c.daily_token_ceiling < 1) fail('daily_token_ceiling');
  const catalog = root ? JSON.parse(await readFile(join(root, 'groups.json'), 'utf8')).groups : null;
  const ids = new Set();
  let total = 0;
  for (const t of c.teams) {
    if (!ident(t.id) || ids.has(t.id)) fail(`team id ${t.id}`);
    ids.add(t.id);
    if (!lists(t.soots, 16) || !t.soots.every(s => ident(s.id) && typeof s.role === 'string')) fail(`${t.id}: soots`);
    if (!lists(t.takes_in) || !lists(t.gives_out) || !t.decides || !lists(t.decides.alone) || !lists(t.decides.with_founder)) fail(`${t.id}: an interface declares takes_in, gives_out and decides`);
    if (!lists(t.escalates_when) || !t.escalates_when.length) fail(`${t.id}: says when it escalates`);
    if (!Number.isInteger(t.daily_tokens) || t.daily_tokens < 0) fail(`${t.id}: daily_tokens`);
    for (const g of t.gives_out) if (!ident(g.table) || !lists(g.fields, 32) || !g.fields.length) fail(`${t.id}: gives_out ${g.table}`);
    if (t.external) { if (t.group || t.daily_tokens) fail(`${t.id}: an external team has no group and no budget here`); continue; }
    if (!ident(t.group)) fail(`${t.id}: group`);
    total += t.daily_tokens;
    if (catalog) {
      const entry = catalog.find(e => e.id === t.group);
      if (!entry) fail(`${t.id}: group ${t.group} is not in groups.json`);
      const group = validateGroup(JSON.parse(await readFile(join(root, entry.source), 'utf8')));
      const lean = group.profiles.find(p => p.id === 'lean') ?? group.profiles[0];
      const sum = Object.values(lean.members).reduce((n, m) => n + m.daily_tokens, 0);
      if (!t.slot && !t.budget_override && sum !== t.daily_tokens) fail(`${t.id}: daily_tokens ${t.daily_tokens} is not its group's ${lean.id} profile (${sum})`);
    }
  }
  if (total > c.daily_token_ceiling) fail(`daily budgets total ${total}, over the ceiling ${c.daily_token_ceiling}`);
  const cids = new Set();
  for (const k of c.contracts) {
    if (!ident(k.id) || cids.has(k.id)) fail(`contract id ${k.id}`);
    cids.add(k.id);
    const owner = c.teams.find(t => t.id === k.owner), reader = c.teams.find(t => t.id === k.reader);
    if (!owner || !reader || owner === reader) fail(`${k.id}: owner and reader are two teams of this company`);
    if (!['read', 'write'].includes(k.mode)) fail(`${k.id}: mode`);
    const gives = owner.gives_out.find(g => g.table === k.table && g.pack === k.pack);
    if (!gives) fail(`${k.id}: ${owner.id} does not give out ${k.pack}.${k.table}`);
    const missing = k.fields.filter(f => !gives.fields.includes(f));
    if (!k.fields.length || missing.length) fail(`${k.id}: ${missing.join(', ') || 'no fields'} not given out by ${owner.id}`);
    const real = packs[k.pack]?.storage?.tables?.find(x => x.name === k.table);
    if (packs[k.pack] && !real) fail(`${k.id}: pack ${k.pack} has no table ${k.table}`);
    if (real) { const cols = new Set(real.columns.map(x => x.name)); const bad = k.fields.filter(f => !cols.has(f)); if (bad.length) fail(`${k.id}: ${k.pack}.${k.table} has no column ${bad.join(', ')}`); }
  }
  for (const t of c.teams) for (const i of t.takes_in) {
    if (i.from && !ids.has(i.from)) fail(`${t.id}: takes in from unknown team ${i.from}`);
    if (i.contract && !cids.has(i.contract)) fail(`${t.id}: takes in by unknown contract ${i.contract}`);
  }
  return { total, teams: c.teams.map(t => t.id), contracts: c.contracts.map(k => k.id) };
}
