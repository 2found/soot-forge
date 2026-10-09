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
  keys(t,['api_version','id','name','description','root','members','default','packs','bindings']);
  if (t.api_version !== 'soot/group-template/v1' || !ident(t.id) || !text(t.name,80) || !text(t.description,400) || !Array.isArray(t.members) || !t.members.length || t.members.length > 32 || !Array.isArray(t.packs) || t.packs.length > 32 || !Array.isArray(t.default) || !Array.isArray(t.bindings) || t.bindings.length > 128) throw new Error('Invalid group bounds');
  const packs = new Set();
  for (const p of t.packs) { keys(p,['id','archive','sha256']); if (!ident(p.id) || packs.has(p.id) || !/^[a-f0-9]{64}$/.test(p.sha256) || p.archive !== `dependencies/${p.id}.tar.gz`) throw new Error('Invalid group dependency'); packs.add(p.id); }
  const members = new Set();
  for (const m of t.members) {
    keys(m,['id','name','role','soul','mission','use','channels']);
    if (!ident(m.id) || m.id === 'self' || members.has(m.id) || !text(m.name,80) || !text(m.role,300) || !text(m.soul,8192) || !text(m.mission,16384) || !Array.isArray(m.use) || m.use.length > 32 || new Set(m.use).size !== m.use.length || m.use.some(u => { const parts = u.split('/'); return parts.length !== 2 || !packs.has(parts[0]) || !ident(parts[1]); })) throw new Error('Invalid group member'); members.add(m.id);
    if (m.channels && (!Array.isArray(m.channels) || m.channels.length > 8 || new Set(m.channels.map(c => c.id)).size !== m.channels.length)) throw new Error('Invalid channels');
    for (const c of m.channels ?? []) { keys(c,['id','name']); if (!ident(c.id) || !text(c.name,80)) throw new Error('Invalid channel'); }
  }
  if (!members.has(t.root) || new Set(t.default).size !== t.default.length || t.default.some(id => id === t.root || !members.has(id))) throw new Error('Invalid group roster');
  for (const b of t.bindings) { keys(b,['member','name','purpose']); if (!members.has(b.member) || !text(b.name,80) || !text(b.purpose,500)) throw new Error('Invalid binding requirement'); }
  return t;
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
    groups.push({...entry,members:template.members.map(({id,name,role,channels})=>({id,name,role,...(channels?{channels}:{})})),archive,install:`soot group add ${archive.url} --sha256 ${sha256}`});
    sums.push(`${sha256}  ${filename}`);
  }
  await writeFile(join(dist,'groups.json'),JSON.stringify({...catalog,groups},null,2)+'\n');
  return sums;
}
