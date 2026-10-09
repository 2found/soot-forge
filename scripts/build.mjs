import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCatalog, materialize, sourceLink, installCommand } from './catalog.mjs';
import { archivePack } from './archive.mjs';
import { buildGroups } from './groups.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: node scripts/build.mjs <stable-version>');
const root = resolve(import.meta.dirname, '..');
const catalog = await readCatalog(root);
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'soot-forge-build-'));
try {
  const sums = [], projected = [];
  for (const pack of catalog.packs) {
    const directory = await materialize(pack, root, work);
    const name = `${pack.id}-pack_${version}.tar.gz`;
    const archive = join(dist, name);
    await archivePack(directory, archive, pack.id);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    sums.push(`${sha256}  ${name}`);
    projected.push({ ...pack, source_url: sourceLink(pack, `v${version}`), install: installCommand(pack, `v${version}`),
      archive: { url: `https://github.com/2found/soot-forge/releases/download/v${version}/${name}`, sha256 } });
    console.log(`Packaged ${name} (${sha256})`);
  }
  await writeFile(join(dist, 'catalog.json'), JSON.stringify({ ...catalog, packs: projected }, null, 2) + '\n');
  sums.push(...await buildGroups(root, dist, work, version, projected));
  await writeFile(join(dist, 'SHA256SUMS'), sums.join('\n') + '\n');
} finally { await rm(work, { recursive: true, force: true }); }
