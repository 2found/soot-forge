// Compiler from `soot-forge/company-template/v1` (groups/company-team/company.source.json plus a per-company overlay, the
// shape W2 wrote in L5) to `soot/company-template/v1`, the runtime's company file. It keeps no checks of its own: the
// runtime owns what a company is, so `check` hands the compiled file to `soot company check --json` and returns its
// diagnostics, and an overlay that removes a team a required edge needs is refused there (`company_edge_required`).
//
//   node scripts/company.mjs compile [--template file] [--overlay file]... [--mode create|adopt] [--groups dir] [--remotes file] [--out file]
//   node scripts/company.mjs check   [same flags] [--config deployment.json]
//
// What this file does, and nothing more:
//   * shapes the data an overlay patches or adds (team fields, contracts) before it is translated;
//   * translates teams, contracts and the company block into the runtime's fields (see the table in groups/company-team/README.md);
//   * hands `remove` and `rename` to the runtime as its own overlay, so the runtime applies them and refuses what it refuses.
// The runtime binary is found from LOOP_SOOT_BIN, else `soot` on PATH (SOOT_* names belong to the runtime).
//
// This file is deleted in the first Forge release whose minimum runtime is L6: company.source.json is then written in the
// runtime's own format and these two commands become `soot company check|create|adopt`.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const clone = x => structuredClone(x);
export const FORGE_VERSION = 'soot-forge/company-template/v1';
export const RUNTIME_VERSION = 'soot/company-template/v1';
const OVERLAY_KEYS = ['extends', 'id', 'name', 'description', 'remove', 'rename', 'teams', 'add', 'contracts', 'daily_token_ceiling', 'goals'];

/** A refusal with a stable code: the compiler's own (`company_input`) or the runtime's, carried through. */
export class CompanyError extends Error {
  constructor(code, message, diagnostics = []) { super(`${code}: ${message}`); this.code = code; this.diagnostics = diagnostics; }
}
const input = m => { throw new CompanyError('company_input', m); };

/**
 * Applies the overlay's data-shaping parts to a copy of the template: the company's own fields, patches of a team's
 * fields (soots, daily_tokens, decides, ...), added teams and added or removed contracts. `remove` and `rename` are not
 * applied here: they go to the runtime as its overlay (see compileCompany). Returns the shaped company and the ids of
 * teams whose budget the overlay set on purpose.
 */
export function shapeCompany(template, overlay = {}) {
  const c = clone(template), o = overlay ?? {};
  for (const k of Object.keys(o)) if (!OVERLAY_KEYS.includes(k)) input(`unknown overlay field ${k}`);
  if (o.extends && o.extends !== template.id) input(`overlay extends ${o.extends}, not ${template.id}`);
  for (const k of ['id', 'name', 'description', 'daily_token_ceiling']) if (o[k] !== undefined) c[k] = o[k];
  // The overlay's goals settings replace the template's key by key (a `cadence` list replaces the whole list).
  if (o.goals !== undefined) c.goals = { ...c.goals, ...o.goals };
  const explicit = new Set();
  for (const [id, patch] of Object.entries(o.teams ?? {})) {
    const t = c.teams.find(x => x.id === id);
    if (!t) throw new CompanyError('company_unknown_team', `patch names unknown team ${id}`);
    for (const [k, v] of Object.entries(patch)) t[k] = k === 'decides' ? { ...t.decides, ...v } : v;
    if (patch.daily_tokens !== undefined) explicit.add(id);
  }
  for (const t of o.add ?? []) {
    if (c.teams.some(x => x.id === t.id)) throw new CompanyError('company_invalid', `add repeats team ${t.id}`);
    c.teams.push(clone(t));
    if (t.daily_tokens) explicit.add(t.id);
  }
  for (const id of o.contracts?.remove ?? []) {
    if (!c.contracts.some(k => k.id === id)) throw new CompanyError('company_invalid', `contract ${id} unknown`);
    c.contracts = c.contracts.filter(k => k.id !== id);
  }
  for (const k of o.contracts?.add ?? []) {
    if (c.contracts.some(x => x.id === k.id)) throw new CompanyError('company_invalid', `contract ${k.id} repeated`);
    c.contracts.push(clone(k));
  }
  return { company: c, explicit };
}

/** Reads a built groups directory (what `buildGroups` writes): the pin of each group template. */
export async function readPins(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'groups.json'), 'utf8'));
  const pins = {};
  for (const g of manifest.groups) {
    if (!g.archive) continue;
    // A archive built next to the manifest is used from disk; otherwise the release URL is the source.
    const local = join(dir, basename(new URL(g.archive.url).pathname));
    const exists = await readFile(local).then(() => true, () => false);
    pins[g.id] = { source: exists ? resolve(local) : g.archive.url, sha256: g.archive.sha256 };
  }
  return pins;
}

async function groupSource(root, id) {
  try { return JSON.parse(await readFile(join(root, 'groups', id, 'group.source.json'), 'utf8')); } catch { return null; }
}

/**
 * Compiles a company. Options: mode `create` (teams are pinned group templates: needs `pins`) or `adopt` (teams are the
 * Soots a deployment already has), the repository root (for the group templates' packs and escalation triggers) and
 * `remotes`, a map from a forge team's external runtime to `{url, token_env, group?}`. An external team with no remote
 * entry has no runtime representation (build, which is Claude Code through `bbs team`); it is left out and named in notes.
 */
export async function compileCompany(template, overlay, { mode = 'create', root, pins = {}, remotes = {}, config } = {}) {
  if (template.api_version !== FORGE_VERSION) input(`api_version must be ${FORGE_VERSION}`);
  if (!['create', 'adopt'].includes(mode)) input('mode is create or adopt');
  const { company: c, explicit } = shapeCompany(template, overlay);
  const notes = [];
  // Adopting with the deployment at hand: a team the overlay gives no budget gets the sum of its members' caps, the
  // value `soot company adopt` derives itself (never more), so a budget_80 escalation has a budget to warn against.
  const caps = mode === 'adopt' && config ? await memberCaps(config) : null;
  const kept = [], dropped = new Set();
  for (const t of c.teams) {
    if (t.external && !remotes[t.external.runtime]) { dropped.add(t.id); notes.push(`team ${t.id} runs on ${t.external.runtime}, which has no runtime representation: left out with its edges`); } else kept.push(t);
  }
  const groups = {};
  for (const t of kept) if (t.group && !t.external) groups[t.group] = await groupSource(root, t.group) ?? input(`team ${t.id}: group ${t.group} is not in this repository`);
  // What each team provides: a table of a pack the group template does not ship cannot be owned in create mode yet (the
  // product's pack arrives with the product), so it is left out of the created team's contract and named in notes.
  const unowned = (t, g) => mode === 'create' && !t.external && !(groups[t.group]?.packs ?? []).some(p => p.id === g.pack);
  const items = t => t.gives_out.filter(g => g.table);
  const notYet = new Set(kept.flatMap(t => items(t).filter(g => unowned(t, g)).map(g => `${t.id}.${g.table}`)));
  for (const t of kept) for (const g of items(t)) if (unowned(t, g)) notes.push(`team ${t.id}: ${g.pack}.${g.table} is provided once the product's pack is installed (adopt)`);
  const contractsOf = id => c.contracts.filter(k => k.owner === id || k.reader === id);
  const teams = [];
  for (const t of kept) {
    const out = { id: t.id };
    if (t.description) out.description = t.description;
    const group = t.group ? groups[t.group] : null;
    const name = t.name ?? (group ? (await catalogName(root, t.group)) : undefined);
    if (name) out.name = name;
    if (t.external) {
      const r = remotes[t.external.runtime];
      out.remote = { runtime: t.external.runtime, group: r.group ?? t.id };
    } else if (mode === 'create') {
      const pin = pins[t.group] ?? input(`team ${t.id}: no pinned archive for group ${t.group}; pass --groups <dir with groups.json>`);
      out.template = pin; out.profile = 'lean';
      // The team's Đầu mối: a template member role (the standard teams each name one; Support's desk is first and its answerer joins as a second entry after install).
      if (t.coordinator) out.coordinator = t.coordinator;
    } else {
      out.members = t.soots.map(s => s.id);
      // The Soots people can chat to; without it the runtime makes every member an entry. The first is the Đầu mối.
      if (t.entries?.length) out.entries = t.entries;
    }
    const contract = { version: 'team-contract/v1' };
    const tables = items(t).filter(g => !unowned(t, g)).map(g => ({ name: g.table, pack: g.pack, table: g.table, fields: g.fields, ...(g.note ? { note: g.note } : {}), tenant: 'all' }));
    const queues = contractsOf(t.id).filter(k => k.mode === 'write' && k.owner === t.id && !dropped.has(k.reader))
      .map(k => ({ name: k.id, kind: 'table', pack: k.pack, table: k.table, fields: k.fields }));
    const events = t.gives_out.filter(g => g.event).map(g => g.event);
    if (tables.length || queues.length || events.length) contract.provides = { ...(tables.length ? { tables } : {}), ...(queues.length ? { queues } : {}), ...(events.length ? { events } : {}) };
    const consumes = [], requests = [];
    for (const k of c.contracts.filter(x => x.reader === t.id)) {
      if (dropped.has(k.owner)) continue;
      const why = (t.takes_in ?? []).find(i => i.contract === k.id);
      if (k.mode === 'write') { requests.push({ team: k.owner, queue: k.id }); continue; }
      if (notYet.has(`${k.owner}.${k.table}`)) continue; // the owner provides it once its pack is installed: nothing to read yet
      consumes.push({ team: k.owner, item: k.table, fields: k.fields, ...(why?.what ? { why: why.what } : {}), ...(k.optional || why?.optional ? { optional: true } : {}) });
    }
    if (consumes.length) contract.consumes = consumes;
    if (requests.length) contract.requests = requests;
    if (t.decides) contract.decides = { self: t.decides.alone ?? [], with_person: t.decides.with_founder ?? [] };
    if (t.escalates_when?.length) {
      // Text is the company's; a trigger comes along when the group template declares the same text with one.
      const known = new Map((group?.contract?.escalates ?? []).map(e => [e.when, e]));
      contract.escalates = t.escalates_when.map(w => (typeof w === 'string' ? (known.get(w) ?? { when: w }) : w));
    }
    if (t.daily_tokens > 0 && (mode === 'create' || explicit.has(t.id)) && !t.external) contract.budget = { daily_tokens: t.daily_tokens };
    else if (caps && !t.external) {
      const sum = t.soots.reduce((n, s) => n + (caps.get(s.id) ?? 0), 0);
      if (sum > 0) contract.budget = { daily_tokens: sum };
    }
    if (caps && !contract.budget && contract.escalates?.some(e => e.on === 'budget_80')) {
      // No member has a cap, so there is no budget to warn at 80% of: the warning goes, the budget is not invented.
      contract.escalates = contract.escalates.filter(e => e.on !== 'budget_80');
      if (!contract.escalates.length) delete contract.escalates;
      notes.push(`team ${t.id}: no member has a daily token cap, so its budget_80 escalation is left out`);
    }
    out.contract = contract;
    teams.push(out);
  }
  const lead = c.teams.find(t => t.lead && !dropped.has(t.id));
  const company = {
    api_version: RUNTIME_VERSION, id: c.id, name: c.name, ...(c.description ? { description: c.description } : {}),
    company: { name: c.name, ...(lead ? { lead_team: lead.id } : {}), ...(c.daily_token_ceiling ? { daily_token_ceiling: c.daily_token_ceiling } : {}), ...(c.goals ? { goals: c.goals } : {}) },
    ...(Object.keys(remotes).length && teams.some(t => t.remote) ? { remotes: Object.fromEntries(teams.filter(t => t.remote).map(t => [t.remote.runtime, { url: remotes[t.remote.runtime].url, token_env: remotes[t.remote.runtime].token_env }])) } : {}),
    teams,
  };
  // The runtime applies remove and rename itself, so it refuses a removal a required edge depends on.
  // A team this compiler left out (it has no runtime form) is not the runtime's to remove or rename.
  const o = overlay ?? {};
  const rt = {};
  const remove = (o.remove ?? []).filter(id => !dropped.has(id));
  const rename = Object.fromEntries(Object.entries(o.rename ?? {}).filter(([id]) => !dropped.has(id)));
  if (remove.length) rt.remove = remove;
  if (Object.keys(rename).length) rt.rename = rename;
  if (Object.keys(rt).length) company.overlay = rt;
  return { company, notes };
}

/** Each Soot's `execution.daily_tokens` (0 when it sets none), from the deployment's Soot files. */
async function memberCaps(config) {
  const host = JSON.parse(await readFile(config, 'utf8'));
  const caps = new Map();
  for (const rel of host.soots ?? []) {
    const def = JSON.parse(await readFile(resolve(dirname(config), rel), 'utf8'));
    if (def.id && !def.archived) caps.set(def.id, def.execution?.daily_tokens > 0 ? def.execution.daily_tokens : 0);
  }
  return caps;
}

async function catalogName(root, id) {
  try { return JSON.parse(await readFile(join(root, 'groups.json'), 'utf8')).groups.find(g => g.id === id)?.name; } catch { return undefined; }
}

/** The runtime binary: LOOP_SOOT_BIN, else `soot` on PATH. */
export const sootBin = (env = process.env) => env.LOOP_SOOT_BIN || 'soot';

/**
 * `soot company check --json` on a compiled company. Returns the runtime's report `{ok, teams, edges, diagnostics}`
 * as it is; a refusal before the report (a load or compose error) is the same shape with its diagnostic. The compiler
 * adds nothing to it.
 */
export async function checkCompiled(company, { config, bin = sootBin(), env = process.env } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-company-'));
  try {
    const file = join(dir, 'company.json');
    await writeFile(file, JSON.stringify(company, null, 2) + '\n');
    return await runtimeCheck(file, { config, bin, env });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function runtimeCheck(file, { config, bin = sootBin(), env = process.env } = {}) {
  let stdout = '';
  try {
    ({ stdout } = await run(bin, ['company', 'check', file, '--json', ...(config ? ['--config', config] : [])], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: env.PATH, HOME: env.HOME, ...(env.SOOT_HOME ? { SOOT_HOME: env.SOOT_HOME } : {}), ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}) } }));
  } catch (e) {
    if (typeof e.stdout !== 'string' || !e.stdout.trim()) throw new CompanyError('company_runtime', `cannot run ${bin} company check: ${e.stderr?.trim() || e.message}`);
    stdout = e.stdout; // a refusal exits non-zero with its diagnostics on stdout
  }
  let report;
  try { report = JSON.parse(stdout); } catch { throw new CompanyError('company_runtime', 'the runtime did not answer with JSON; is it older than L6?'); }
  // A refusal before the report (a load or compose error) answers with its diagnostics alone.
  return { ok: report.ok === true, teams: [], edges: [], ...report, diagnostics: report.diagnostics ?? [] };
}

/** Compiles and checks one company; returns `{ok, diagnostics, teams, edges, notes, company}`. */
export async function checkCompany(template, overlay, options = {}) {
  const { company, notes } = await compileCompany(template, overlay, options);
  const report = await checkCompiled(company, options);
  return { ...report, notes, company };
}

// ---- command line -------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { overlays: [], mode: 'create' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i] ?? input(`${k} needs a value`);
    if (k === '--template') a.template = v(); else if (k === '--overlay') a.overlays.push(v()); else if (k === '--mode') a.mode = v();
    else if (k === '--groups') a.groups = v(); else if (k === '--remotes') a.remotes = v(); else if (k === '--out') a.out = v();
    else if (k === '--config') a.config = v(); else if (k === '--json') a.json = true; else input(`unknown flag ${k}`);
  }
  return a;
}

export async function main(argv, root = resolve(import.meta.dirname, '..')) {
  const [cmd, ...rest] = argv;
  if (!['compile', 'check'].includes(cmd)) input('usage: company.mjs compile|check [--template f] [--overlay f]... [--mode create|adopt] [--groups dir] [--remotes f] [--out f] [--config deployment.json]');
  const a = parseArgs(rest);
  const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
  const template = await readJson(a.template ?? join(root, 'groups/company-team/company.source.json'));
  // Overlays apply in order; each is a forge overlay, so they merge into one before translation.
  let overlay = {};
  for (const f of a.overlays) overlay = mergeOverlays(overlay, await readJson(f));
  const options = {
    mode: a.mode, root, config: a.config,
    pins: a.mode === 'create' ? await readPins(a.groups ?? input('create mode needs --groups <dir with groups.json>')) : {},
    remotes: a.remotes ? await readJson(a.remotes) : {},
  };
  if (cmd === 'compile') {
    const { company, notes } = await compileCompany(template, overlay, options);
    const text = JSON.stringify(company, null, 2) + '\n';
    if (a.out) await writeFile(a.out, text); else process.stdout.write(text);
    for (const n of notes) console.error(`note: ${n}`);
    return 0;
  }
  const r = await checkCompany(template, overlay, options);
  for (const n of r.notes) console.error(`note: ${n}`);
  if (a.json) process.stdout.write(JSON.stringify({ ok: r.ok, teams: r.teams, edges: r.edges, diagnostics: r.diagnostics, notes: r.notes }, null, 2) + '\n');
  else if (r.ok) console.log(`ok: ${r.teams.length} teams, ${r.edges.length} edges`);
  else for (const d of r.diagnostics) console.error(`${d.code}: ${d.message}`);
  return r.ok ? 0 : 1;
}

/** Overlay files given in order: later keys win, the list-like keys add up, patches merge per team. */
export function mergeOverlays(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (['remove', 'add'].includes(k)) out[k] = [...(a[k] ?? []), ...v];
    else if (['rename', 'teams', 'goals'].includes(k)) out[k] = { ...(a[k] ?? {}), ...v };
    else if (k === 'contracts') out[k] = { add: [...(a.contracts?.add ?? []), ...(v.add ?? [])], remove: [...(a.contracts?.remove ?? []), ...(v.remove ?? [])] };
    else out[k] = v;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e.message); process.exit(2); });
}
