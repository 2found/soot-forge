// Builds society-sim-group.tar.gz from a soot-forge checkout, for use before a
// release carries it. Prints the archive's sha256.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const [forge, out] = process.argv.slice(2);
if (!forge || !out) throw new Error('Usage: node build-local.mjs <soot-forge checkout> <output dir>');
const { archivePack } = await import(join(forge, 'scripts/archive.mjs'));
const { validateGroup } = await import(join(forge, 'scripts/groups.mjs'));
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const dir = join(out, 'society-sim');
await rm(dir, { recursive: true, force: true });
await mkdir(join(dir, 'dependencies'), { recursive: true });
const template = JSON.parse(await readFile(join(forge, 'groups/society-sim/group.source.json'), 'utf8'));
for (const dep of template.packs) {
  const archive = join(dir, dep.archive);
  await archivePack(join(forge, 'packs', dep.id), archive, dep.id);
  dep.sha256 = await sha(archive);
}
await writeFile(join(dir, 'group.json'), JSON.stringify(validateGroup(template), null, 2) + '\n');
await archivePack(dir, join(out, 'society-sim-group.tar.gz'), 'society-sim');
console.log(await sha(join(out, 'society-sim-group.tar.gz')));
