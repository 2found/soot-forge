import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archivePack } from './archive.mjs';
import { safePath } from './catalog.mjs';

export async function readGroups(root) {
  const catalog = JSON.parse(await readFile(join(root, 'groups.json'), 'utf8'));
  if (catalog.version !== 1 || catalog.repository !== '2found/soot-forge' || !Array.isArray(catalog.groups) || catalog.groups.length > 64 || Object.keys(catalog).some(k => !['version', 'repository', 'groups', 'companies'].includes(k))) throw new Error('Invalid group catalog');
  const ids = new Set();
  for (const entry of catalog.groups) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(entry.id) || ids.has(entry.id) || Object.keys(entry).some(k => !['id','name','description','source','stability','audience'].includes(k)) || !stability(entry)) throw new Error('Invalid group entry'); ids.add(entry.id);
    if (entry.source !== `groups/${entry.id}/group.source.json`) throw new Error('Invalid group source');
    const template = JSON.parse(await readFile(join(root, safePath(entry.source)), 'utf8'));
    validateGroup(template);
    if (entry.id !== template.id || entry.name !== template.name || entry.description !== template.description) throw new Error('Group catalog metadata mismatch');
  }
  // Company templates are listed apart from groups, and a catalog entry never offers one publicly: they are internal and
  // experimental until a founder decides otherwise (Soot's branding has no "company OS").
  for (const c of catalog.companies ?? []) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(c.id) || ids.has(c.id) || Object.keys(c).some(k => !['id','name','description','source','stability','audience'].includes(k)) || c.source !== `groups/${c.id}/company.source.json` || c.stability !== 'experimental' || c.audience !== 'internal') throw new Error('Invalid company entry');
    const template = JSON.parse(await readFile(join(root, safePath(c.source)), 'utf8'));
    if (template.id !== c.id) throw new Error('Company catalog metadata mismatch');
    ids.add(c.id);
  }
  return catalog;
}
const stability = e => (e.stability === undefined && e.audience === undefined) || (e.stability === 'experimental' && e.audience === 'internal');
// A member selects a pack whole ("id"), read-only ("id:read") or narrowed to named tools ("id:tools=a,b"), as the runtime's PackRef reads it.
const PACK_REF = /^[a-z0-9][a-z0-9_-]{0,47}(:read|:tools=[a-z0-9_]{1,64}(,[a-z0-9_]{1,64})*)?$/;
export const refPack = u => u.split(':')[0];
export const refTools = u => (u.split(':')[1] ?? '').startsWith('tools=') ? u.split(':')[1].slice(6).split(',') : null;
export function validateGroup(t) {
  const ident = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(v);
  const keys = (v, allowed) => { if (!v || Array.isArray(v) || typeof v !== 'object' || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Invalid group fields'); };
  const text = (v, max) => typeof v === 'string' && v.trim() && Buffer.byteLength(v) <= max && !v.includes('\0');
  keys(t,['api_version','id','name','description','root','members','default','packs','bindings','inputs','profiles','schedules','contract']);
  const v3 = t.api_version === 'soot/group-template/v3';
  const v2 = t.api_version === 'soot/group-template/v2' || v3;
  if ((t.api_version !== 'soot/group-template/v1' && !v2) || !ident(t.id) || !text(t.name,80) || !text(t.description,400) || !Array.isArray(t.members) || !t.members.length || t.members.length > 32 || !Array.isArray(t.packs) || t.packs.length > 32 || !Array.isArray(t.default) || !Array.isArray(t.bindings) || t.bindings.length > 128) throw new Error('Invalid group bounds');
  const packs = new Set();
  for (const p of t.packs) { keys(p,['id','archive','sha256']); if (!ident(p.id) || packs.has(p.id) || !/^[a-f0-9]{64}$/.test(p.sha256) || p.archive !== `dependencies/${p.id}.tar.gz`) throw new Error('Invalid group dependency'); packs.add(p.id); }
  const members = new Set();
  for (const m of t.members) {
    keys(m,['id','name','role','soul','mission','packs','channels']);
    if (!ident(m.id) || m.id === 'self' || members.has(m.id) || !text(m.name,80) || !text(m.role,300) || !text(m.soul,8192) || !text(m.mission,16384) || !Array.isArray(m.packs) || m.packs.length > 32 || m.packs.some(u => typeof u !== 'string' || !PACK_REF.test(u) || !packs.has(refPack(u))) || new Set(m.packs.map(refPack)).size !== m.packs.length) throw new Error('Invalid group member'); members.add(m.id);
    if (m.channels && (!Array.isArray(m.channels) || m.channels.length > 8 || new Set(m.channels.map(c => c.id)).size !== m.channels.length)) throw new Error('Invalid channels');
    for (const c of m.channels ?? []) { keys(c,['id','name']); if (!ident(c.id) || !text(c.name,80)) throw new Error('Invalid channel'); }
  }
  if ((!members.has(t.root) && !(v2 && t.root === '')) || new Set(t.default).size !== t.default.length || t.default.some(id => id === t.root || !members.has(id))) throw new Error('Invalid group roster');
  for (const b of t.bindings) { keys(b,['member','name','purpose']); if (!members.has(b.member) || !text(b.name,80) || !text(b.purpose,500)) throw new Error('Invalid binding requirement'); }
  validateV2(t, v2, v3, members, packs, ident, keys, text);
  return t;
}
// v2 adds what a lead asks for (inputs), the budgets it offers (profiles) and
// the cycles the team's lead runs (schedules); the runtime re-checks all of it.
const TIERS = ['flash', 'lite', 'pro', 'max'];
function validateV2(t, v2, v3, members, packs, ident, keys, text) {
  if (!v2) { if (t.inputs || t.profiles || t.schedules) throw new Error('inputs, profiles and schedules need soot/group-template/v2'); return; }
  if (!v3 && t.contract) throw new Error('a contract needs soot/group-template/v3');
  const list = (v, max) => v === undefined || (Array.isArray(v) && v.length <= max);
  if (!list(t.inputs,16) || !list(t.profiles,8) || !list(t.schedules,8)) throw new Error('Invalid group v2 bounds');
  const seen = new Set();
  for (const i of t.inputs ?? []) { keys(i,['id','label','ask','confirm']); if (!ident(i.id) || seen.has(i.id) || !text(i.label,80) || !text(i.ask,300) || (i.confirm !== undefined && typeof i.confirm !== 'boolean')) throw new Error(`Invalid input ${i.id}`); seen.add(i.id); }
  const schedules = new Set();
  for (const s of t.schedules ?? []) {
    keys(s,['id','name','every','at','timezone','text','cron','paused','input','output_schema',...(v3 ? ['member', 'tool', 'then', 'wake_when'] : [])]);
    if (!ident(s.id) || schedules.has(s.id) || !text(s.name,80) || !text(s.text,4096)) throw new Error(`Invalid schedule ${s.id}`);
    // The runtime takes exactly one of every (hours) or cron (five fields).
    if ((s.every === undefined) === (s.cron === undefined)) throw new Error(`Invalid schedule ${s.id}: give every or cron`);
    if (s.cron !== undefined) {
      if (typeof s.cron !== 'string' || s.cron.trim().split(/\s+/).length !== 5 || s.at !== undefined || (s.timezone !== undefined && !text(s.timezone,64))) throw new Error(`Invalid schedule ${s.id}`);
    } else {
      const hours = /^(\d+)h$/.exec(s.every)?.[1];
      if (!hours || +hours < 1 || +hours > 744 || (s.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) || (s.timezone !== undefined && (s.at === undefined || !text(s.timezone,64)))) throw new Error(`Invalid schedule ${s.id}`);
    }
    if ((s.paused !== undefined && typeof s.paused !== 'boolean') || (s.input !== undefined && (!s.input || typeof s.input !== 'object' || Array.isArray(s.input))) || (s.output_schema !== undefined && (!s.output_schema || typeof s.output_schema !== 'object' || Array.isArray(s.output_schema)))) throw new Error(`Invalid schedule ${s.id}`);
    if (v3) validateChain(s, members, packs, keys, text);
    schedules.add(s.id);
  }
  const profiles = new Set();
  for (const p of t.profiles ?? []) {
    keys(p,['id','label','cadence','members','schedules',...(v3 ? ['team_daily_tokens'] : [])]);
    if (p.team_daily_tokens !== undefined && (!Number.isInteger(p.team_daily_tokens) || p.team_daily_tokens < 0 || p.team_daily_tokens > 2 ** 40)) throw new Error(`Invalid profile ${p.id} team budget`);
    if (!ident(p.id) || profiles.has(p.id) || !text(p.label,80) || !text(p.cadence,300) || !p.members || typeof p.members !== 'object' || Object.keys(p.members).length !== members.size) throw new Error(`Invalid profile ${p.id}: name every member once`);
    profiles.add(p.id);
    for (const [id, m] of Object.entries(p.members)) { keys(m,['tier','daily_tokens']); if (!members.has(id) || !Number.isInteger(m.daily_tokens) || m.daily_tokens < 1 || m.daily_tokens > 2 ** 32 || (m.tier !== undefined && !TIERS.includes(m.tier))) throw new Error(`Invalid profile ${p.id} member ${id}`); }
    if ((p.schedules ?? []).some(id => !schedules.has(id))) throw new Error(`Profile ${p.id} names an unknown schedule`);
  }
  if (v3) { checkChainGrants(t); if (t.contract) validateContract(t.contract, packs, keys, text); }
}
// v3: a schedule may run a member's tool chain without a model turn. The chain runs with that member's own grants, so
// the member selects every pack (and, when narrowed, every tool) the chain calls; a v3 chain without a member is refused
// here because the lead (Kamaji) holds none of the team's packs.
const TOOL = /^[a-z0-9][a-z0-9_]{0,63}$/;
function validateChain(s, members, packs, keys, text) {
  const bad = why => { throw new Error(`Invalid schedule ${s.id}: ${why}`); };
  if (s.tool === undefined) { if (s.member !== undefined || s.then !== undefined || s.wake_when !== undefined) bad('member, then and wake_when need a tool'); return; }
  keys(s.tool, ['pack', 'name', 'input']);
  if (typeof s.member !== 'string' || !members.has(s.member)) bad('a tool chain names the member that runs it');
  if (s.tool.input !== undefined && (!s.tool.input || typeof s.tool.input !== 'object' || Array.isArray(s.tool.input))) bad('tool input is an object');
  if (s.then !== undefined && (!Array.isArray(s.then) || s.then.length > 8)) bad('then is at most 8 steps');
  const steps = [{ pack: s.tool.pack, tool: s.tool.name }];
  for (const step of s.then ?? []) {
    keys(step, ['pack', 'tool', 'label', 'input_from', 'input']);
    if (step.input_from !== undefined && step.input_from !== 'previous') bad('input_from is previous');
    if (step.input !== undefined && (!step.input || typeof step.input !== 'object' || Array.isArray(step.input))) bad('step input is an object');
    if (step.label !== undefined && !text(step.label, 80)) bad('step label');
    steps.push(step);
  }
  for (const step of steps) if (!packs.has(step.pack) || !TOOL.test(step.tool)) bad(`${step.pack}.${step.tool} is not a tool of a template pack`);
  if (s.wake_when !== undefined) {
    keys(s.wake_when, ['notify', 'path', 'equals']);
    if ((s.wake_when.notify !== undefined && typeof s.wake_when.notify !== 'boolean') || (s.wake_when.equals !== undefined && !s.wake_when.path)) bad('wake_when');
  }
}
// Selections a chain needs, checked once the roster is known (validateGroup).
function checkChainGrants(t) {
  for (const s of t.schedules ?? []) {
    if (!s.tool) continue;
    const refs = t.members.find(m => m.id === s.member).packs;
    for (const step of [{ pack: s.tool.pack, tool: s.tool.name }, ...(s.then ?? []).map(x => ({ pack: x.pack, tool: x.tool }))]) {
      const ref = refs.find(r => refPack(r) === step.pack);
      if (!ref) throw new Error(`Schedule ${s.id}: member ${s.member} does not select pack ${step.pack}`);
      const only = refTools(ref);
      if (only && !only.includes(step.tool)) throw new Error(`Schedule ${s.id}: member ${s.member} selects only ${only.join(',')} of ${step.pack}, not ${step.tool}`);
    }
  }
}
// The team contract (team-contract/v1). Edges (consumes, requests) are the company's: a group installed alone has no
// other team to read from, and the runtime refuses an edge to a team that is not there, so a group template carries none.
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}(@[a-z0-9][a-z0-9_-]{0,63})?$/;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const ON = ['input_starving', 'budget_80', 'queue_waiting', 'chain_failed'];
function validateContract(c, packs, keys, text) {
  const bad = why => { throw new Error(`Invalid contract: ${why}`); };
  keys(c, ['version', 'provides', 'decides', 'escalates', 'budget']);
  if (c.version !== 'team-contract/v1') bad('version');
  const fields = (f, req) => Array.isArray(f) && (!req || f.length) && f.length <= 64 && new Set(f).size === f.length && f.every(x => FIELD.test(x));
  if (c.provides !== undefined) {
    keys(c.provides, ['tables', 'queues', 'events']);
    const names = new Set();
    for (const tb of c.provides.tables ?? []) {
      keys(tb, ['name', 'pack', 'table', 'fields', 'note', 'tenant']);
      const name = tb.name ?? tb.table;
      if (!NAME.test(name) || names.has(name) || !packs.has(tb.pack) || !FIELD.test(tb.table ?? '') || !fields(tb.fields, true) || !text(tb.tenant ?? '', 64) || (tb.note !== undefined && !text(tb.note, 300))) bad(`table ${name}`);
      names.add(name);
    }
    const queues = new Set();
    for (const q of c.provides.queues ?? []) {
      keys(q, ['name', 'kind', 'pack', 'table', 'fields']);
      if (!NAME.test(q.name) || q.name.includes('@') || queues.has(q.name) || !['task', 'table'].includes(q.kind) || (q.kind === 'table' && (!packs.has(q.pack) || !FIELD.test(q.table ?? ''))) || (q.fields !== undefined && !fields(q.fields))) bad(`queue ${q.name}`);
      queues.add(q.name);
    }
    if (c.provides.events !== undefined && (!Array.isArray(c.provides.events) || !c.provides.events.every(e => NAME.test(e)))) bad('events');
  }
  if (c.decides !== undefined) {
    keys(c.decides, ['self', 'with_person', 'operations_with_person']);
    for (const l of Object.values(c.decides)) if (!Array.isArray(l) || !l.every(x => text(x, 300))) bad('decides');
  }
  for (const e of c.escalates ?? []) {
    keys(e, ['when', 'on', 'after']);
    if (!text(e.when, 300) || (e.on !== undefined && !ON.includes(e.on)) || (e.after !== undefined && !/^\d+h$/.test(e.after))) bad('escalates');
  }
  if (c.budget !== undefined) { keys(c.budget, ['daily_tokens']); if (!Number.isInteger(c.budget.daily_tokens) || c.budget.daily_tokens < 0) bad('budget'); }
}
// Release groups pin the exact pack archives emitted by this same release.
// Source templates contain no credentials and no install hooks.
export async function buildGroups(root, dist, work, version, packs) {
  const catalog = await readGroups(root), groups = [], sums = [];
  for (const entry of catalog.groups) {
    const template = JSON.parse(await readFile(join(root, entry.source), 'utf8'));
    const dir = join(work,'groups',entry.id); await mkdir(join(dir,'dependencies'),{recursive:true});
    for (const dep of template.packs) {
      const pack = packs.find(p => p.id === dep.id); if (!pack) throw new Error(`Missing group dependency ${dep.id}`);
      const bytes = await readFile(join(dist,`${dep.id}-pack_${version}.tar.gz`));
      dep.sha256 = createHash('sha256').update(bytes).digest('hex');
      if (dep.sha256 !== pack.archive.sha256) throw new Error('Dependency digest mismatch');
      await writeFile(join(dir,dep.archive),bytes);
    }
    await writeFile(join(dir,'group.json'),JSON.stringify(validateGroup(template),null,2)+'\n');
    const filename = `${entry.id}-group_${version}.tar.gz`; await archivePack(dir,join(dist,filename),entry.id);
    const sha256 = createHash('sha256').update(await readFile(join(dist,filename))).digest('hex');
    const archive = { url:`https://github.com/2found/soot-forge/releases/download/v${version}/${filename}`,sha256 };
    const {inputs,profiles,schedules,contract} = template;
    groups.push({...entry,members:template.members.map(({id,name,role,channels})=>({id,name,role,...(channels?{channels}:{})})),...(inputs?{inputs}:{}),...(profiles?{profiles}:{}),...(schedules?{schedules}:{}),...(contract?{contract}:{}),archive,install:`soot group add ${archive.url} --sha256 ${sha256}`});
    sums.push(`${sha256}  ${filename}`);
  }
  await writeFile(join(dist,'groups.json'),JSON.stringify({...catalog,groups},null,2)+'\n');
  return sums;
}
