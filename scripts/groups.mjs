import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archivePack } from './archive.mjs';
import { safePath } from './catalog.mjs';

export async function readGroups(root) {
  const catalog = JSON.parse(await readFile(join(root, 'groups.json'), 'utf8'));
  if (catalog.version !== 1 || catalog.repository !== '2found/soot-forge' || !Array.isArray(catalog.groups) || catalog.groups.length > 64 || Object.keys(catalog).some(k => !['version', 'repository', 'groups'].includes(k))) throw new Error('Invalid group catalog');
  const ids = new Set();
  for (const entry of catalog.groups) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(entry.id) || ids.has(entry.id) || Object.keys(entry).some(k => !['id','name','description','source'].includes(k))) throw new Error('Invalid group entry'); ids.add(entry.id);
    if (entry.source !== `groups/${entry.id}/group.source.json`) throw new Error('Invalid group source');
    const template = JSON.parse(await readFile(join(root, safePath(entry.source)), 'utf8'));
    validateGroup(template);
    if (entry.id !== template.id || entry.name !== template.name || entry.description !== template.description) throw new Error('Group catalog metadata mismatch');
  }
  return catalog;
}
export function validateGroup(t) {
  const ident = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(v);
  const keys = (v, allowed) => { if (!v || Array.isArray(v) || typeof v !== 'object' || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Invalid group fields'); };
  const text = (v, max) => typeof v === 'string' && v.trim() && Buffer.byteLength(v) <= max && !v.includes('\0');
  keys(t,['api_version','id','name','description','root','members','default','packs','bindings','inputs','profiles','schedules']);
  const v2 = t.api_version === 'soot/group-template/v2';
  if ((t.api_version !== 'soot/group-template/v1' && !v2) || !ident(t.id) || !text(t.name,80) || !text(t.description,400) || !Array.isArray(t.members) || !t.members.length || t.members.length > 32 || !Array.isArray(t.packs) || t.packs.length > 32 || !Array.isArray(t.default) || !Array.isArray(t.bindings) || t.bindings.length > 128) throw new Error('Invalid group bounds');
  const packs = new Set();
  for (const p of t.packs) { keys(p,['id','archive','sha256']); if (!ident(p.id) || packs.has(p.id) || !/^[a-f0-9]{64}$/.test(p.sha256) || p.archive !== `dependencies/${p.id}.tar.gz`) throw new Error('Invalid group dependency'); packs.add(p.id); }
  const members = new Set();
  for (const m of t.members) {
    keys(m,['id','name','role','soul','mission','packs','channels']);
    if (!ident(m.id) || m.id === 'self' || members.has(m.id) || !text(m.name,80) || !text(m.role,300) || !text(m.soul,8192) || !text(m.mission,16384) || !Array.isArray(m.packs) || m.packs.length > 32 || m.packs.some(u => typeof u !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}(:read)?$/.test(u) || !packs.has(u.replace(/:read$/, ''))) || new Set(m.packs.map(u => u.replace(/:read$/, ''))).size !== m.packs.length) throw new Error('Invalid group member'); members.add(m.id);
    if (m.channels && (!Array.isArray(m.channels) || m.channels.length > 8 || new Set(m.channels.map(c => c.id)).size !== m.channels.length)) throw new Error('Invalid channels');
    for (const c of m.channels ?? []) { keys(c,['id','name']); if (!ident(c.id) || !text(c.name,80)) throw new Error('Invalid channel'); }
  }
  if ((!members.has(t.root) && !(v2 && t.root === '')) || new Set(t.default).size !== t.default.length || t.default.some(id => id === t.root || !members.has(id))) throw new Error('Invalid group roster');
  for (const b of t.bindings) { keys(b,['member','name','purpose']); if (!members.has(b.member) || !text(b.name,80) || !text(b.purpose,500)) throw new Error('Invalid binding requirement'); }
  validateV2(t, v2, members, ident, keys, text);
  return t;
}
// v2 adds what a lead asks for (inputs), the budgets it offers (profiles) and
// the cycles the team's lead runs (schedules); the runtime re-checks all of it.
const TIERS = ['flash', 'lite', 'pro', 'max'];
function validateV2(t, v2, members, ident, keys, text) {
  if (!v2) { if (t.inputs || t.profiles || t.schedules) throw new Error('inputs, profiles and schedules need soot/group-template/v2'); return; }
  const list = (v, max) => v === undefined || (Array.isArray(v) && v.length <= max);
  if (!list(t.inputs,16) || !list(t.profiles,8) || !list(t.schedules,8)) throw new Error('Invalid group v2 bounds');
  const seen = new Set();
  for (const i of t.inputs ?? []) { keys(i,['id','label','ask','confirm']); if (!ident(i.id) || seen.has(i.id) || !text(i.label,80) || !text(i.ask,300) || (i.confirm !== undefined && typeof i.confirm !== 'boolean')) throw new Error(`Invalid input ${i.id}`); seen.add(i.id); }
  const schedules = new Set();
  for (const s of t.schedules ?? []) {
    keys(s,['id','name','every','at','timezone','text']);
    const hours = /^(\d+)h$/.exec(s.every)?.[1];
    if (!ident(s.id) || schedules.has(s.id) || !text(s.name,80) || !text(s.text,4096) || !hours || +hours < 1 || +hours > 744 || (s.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) || (s.timezone !== undefined && (s.at === undefined || !text(s.timezone,64)))) throw new Error(`Invalid schedule ${s.id}`);
    schedules.add(s.id);
  }
  const profiles = new Set();
  for (const p of t.profiles ?? []) {
    keys(p,['id','label','cadence','members','schedules']);
    if (!ident(p.id) || profiles.has(p.id) || !text(p.label,80) || !text(p.cadence,300) || !p.members || typeof p.members !== 'object' || Object.keys(p.members).length !== members.size) throw new Error(`Invalid profile ${p.id}: name every member once`);
    profiles.add(p.id);
    for (const [id, m] of Object.entries(p.members)) { keys(m,['tier','daily_tokens']); if (!members.has(id) || !Number.isInteger(m.daily_tokens) || m.daily_tokens < 1 || m.daily_tokens > 2 ** 32 || (m.tier !== undefined && !TIERS.includes(m.tier))) throw new Error(`Invalid profile ${p.id} member ${id}`); }
    if ((p.schedules ?? []).some(id => !schedules.has(id))) throw new Error(`Profile ${p.id} names an unknown schedule`);
  }
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
    const {inputs,profiles,schedules} = template;
    groups.push({...entry,members:template.members.map(({id,name,role,channels})=>({id,name,role,...(channels?{channels}:{})})),...(inputs?{inputs}:{}),...(profiles?{profiles}:{}),...(schedules?{schedules}:{}),archive,install:`soot group add ${archive.url} --sha256 ${sha256}`});
    sums.push(`${sha256}  ${filename}`);
  }
  await writeFile(join(dist,'groups.json'),JSON.stringify({...catalog,groups},null,2)+'\n');
  return sums;
}
