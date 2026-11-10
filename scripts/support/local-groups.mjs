// Builds the group release (group archives with their pinned pack dependencies and groups.json) into a directory, the
// way scripts/build.mjs does, for tests and for `company.mjs --groups`. Only the packs the groups depend on are archived.
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivePack } from '../archive.mjs';
import { materialize, readCatalog } from '../catalog.mjs';
import { buildGroups, readGroups } from '../groups.mjs';

/**
 * `ledByFirstMember` builds the same groups from a mirror in which a team led by the host's lead (root "") is led by its
 * first member instead. Workaround for a runtime bug (L6 branch loop-l6-b): `soot company check` builds a team's group
 * before the lead joins it, so a lead-led team has no entries and the check refuses it with company_invalid ("entries must
 * name 1 to 32 members"); `company create` loads the lead first and is not affected.
 */
const MIRRORED = ['marketing', 'writing', 'browser-use', 'company-loop', 'team-rhythm'];
export async function buildLocalGroups(root, dist, version = '0.0.0', { ledByFirstMember = false } = {}) {
  await mkdir(dist, { recursive: true });
  if (ledByFirstMember) {
    const mirror = await mkdtemp(join(tmpdir(), 'forge-mirror-'));
    try {
      await cp(join(root, 'groups'), join(mirror, 'groups'), { recursive: true });
      const list = JSON.parse(await readFile(join(root, 'groups.json'), 'utf8'));
      list.groups = list.groups.filter(g => g.id.startsWith('team-')); // the company's teams; the others need packs the mirror leaves out
      await writeFile(join(mirror, 'groups.json'), JSON.stringify(list));
      const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
      catalog.packs = catalog.packs.filter(p => MIRRORED.includes(p.id)); delete catalog.retired;
      await writeFile(join(mirror, 'catalog.json'), JSON.stringify(catalog));
      await mkdir(join(mirror, 'packs'));
      for (const id of MIRRORED) await cp(join(root, 'packs', id), join(mirror, 'packs', id), { recursive: true, filter: f => !/node_modules/.test(f) });
      const groups = JSON.parse(await readFile(join(mirror, 'groups.json'), 'utf8'));
      for (const g of groups.groups) {
        const file = join(mirror, g.source), t = JSON.parse(await readFile(file, 'utf8'));
        if (t.root === '' && t.members?.length) { t.root = t.members[0].id; t.default = t.default.filter(id => id !== t.root); }
        await writeFile(file, JSON.stringify(t, null, 2) + '\n');
      }
      return await buildLocalGroups(mirror, dist, version);
    } finally { await rm(mirror, { recursive: true, force: true }); }
  }
  const catalog = await readCatalog(root), groups = await readGroups(root);
  const needed = new Set();
  for (const g of groups.groups) for (const p of JSON.parse(await readFile(join(root, g.source), 'utf8')).packs) needed.add(p.id);
  const work = await mkdtemp(join(tmpdir(), 'forge-local-groups-'));
  try {
    const projected = [];
    for (const pack of catalog.packs.filter(p => needed.has(p.id))) {
      const directory = await materialize(pack, root, work);
      const name = `${pack.id}-pack_${version}.tar.gz`;
      await archivePack(directory, join(dist, name), pack.id);
      const sha256 = createHash('sha256').update(await readFile(join(dist, name))).digest('hex');
      projected.push({ ...pack, archive: { url: `https://github.com/2found/soot-forge/releases/download/v${version}/${name}`, sha256 } });
    }
    await buildGroups(root, dist, work, version, projected);
  } finally { await rm(work, { recursive: true, force: true }); }
  return dist;
}
