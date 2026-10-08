import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCatalog, materialize, run } from './catalog.mjs';
import { archivePack } from './archive.mjs';

const args = process.argv.slice(2);
let remote = false, soot = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remote' && !remote) remote = true;
  else if (args[i] === '--soot' && soot === null && args[i + 1] && !args[i + 1].startsWith('--')) soot = resolve(args[++i]);
  else throw new Error('Usage: node scripts/validate.mjs [--remote] [--soot /path/to/soot]');
}
const root = resolve(import.meta.dirname, '..');
const catalog = await readCatalog(root);
const work = await mkdtemp(join(tmpdir(), 'soot-forge-validate-'));
try {
  const directories = (await readdir(join(root, 'packs'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  const bundled = catalog.packs.filter(pack => pack.source.kind === 'bundled');
  if (directories.some(id => !bundled.some(pack => pack.id === id))) throw new Error('Every bundled pack must be listed in catalog.json');
  for (const pack of catalog.packs) {
    if (pack.source.kind === 'github' && !remote) continue;
    const directory = await materialize(pack, root, work);
    if (soot) {
      const archive = join(work, `${pack.id}.tar.gz`);
      await archivePack(directory, archive, pack.id);
      const deployment = join(work, 'deployment.json');
      await writeFile(deployment, JSON.stringify({ packs_dir: `library-${pack.id}`, soots: [] }));
      await run(soot, ['add', archive, '--config', deployment, '--json'], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    }
    console.log(`Validated ${pack.id} (${pack.source.kind})`);
  }
  console.log(`Catalog valid: ${catalog.packs.length} entries; external content ${remote ? 'checked' : 'skipped (use --remote)'}`);
} finally { await rm(work, { recursive: true, force: true }); }
