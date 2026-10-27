import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { readCatalog, run } from './catalog.mjs';

// Only bundled packs are slimmed: this repo authors them and keeps their manifest
// references out of the dev-only names (footprint.test.mjs). A pinned external
// pack (2build ships its skill at `qa/skill.md`) is archived exactly as pinned.
async function isBundled(id) {
  const catalog = await readCatalog(join(import.meta.dirname, '..'));
  return catalog.packs.some(pack => pack.id === id && pack.source.kind === 'bundled');
}

// Dev-only files stay in the repository (tests run from a checkout) but are not
// shipped in release archives. Runner source and go.mod are NOT dev-only: hosts
// build `runner/` after install. A directory rule matches at any depth.
const devDirs = new Set(['tests', 'test', 'testdata', 'qa', 'widget-src', '__pycache__', '.pytest_cache']);
const devFiles = [/_test\.go$/, /\.test\.(mjs|js)$/, /^test_.*\.py$/, /\.pyc$/, /^\.DS_Store$/];

// `path` is a pack-relative POSIX file path.
export function isDevOnly(path) {
  const parts = path.split('/');
  return parts.slice(0, -1).some(part => devDirs.has(part)) || devFiles.some(rule => rule.test(parts.at(-1)));
}

// Pack-relative POSIX files of a release archive, and the folders it keeps: those
// holding a kept file, plus folders that were already empty (the old archiver
// kept them). `slim: false` keeps dev-only files; footprint.mjs uses it to
// measure the pre-slimming baseline.
async function packEntries(root, { slim = true } = {}) {
  const files = [], dirs = [];
  async function walk(folder, prefix) {
    const entries = await readdir(folder, { withFileTypes: true });
    const before = files.length;
    for (const entry of entries) {
      const path = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(join(folder, entry.name), path);
      else if (!slim || !isDevOnly(path)) files.push(path);
    }
    if (prefix && (files.length > before || entries.length === 0)) dirs.push(prefix);
  }
  await walk(root, '');
  return { files: files.sort(), dirs: dirs.sort() };
}
export async function packFiles(root, options) { return (await packEntries(root, options)).files; }

// Entry order and metadata are unchanged from the pre-exclusion archiver, so a
// pack with nothing excluded keeps its digest across releases. `options.slim` forces slimming on or off; by default
// only a bundled catalog pack is slimmed.
export async function archivePack(directory, output, id, options = {}) {
  const work = await mkdtemp(join(tmpdir(), 'soot-forge-archive-'));
  try {
    const list = join(work, 'files.json');
    await writeFile(list, JSON.stringify(await packEntries(directory, { slim: options.slim ?? await isBundled(id) })));
    await run('python3', ['-c', `
import gzip, json, pathlib, sys, tarfile
root, output, name, listing = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
entries = json.load(open(listing))
keep = {root}
for rel in entries['files'] + entries['dirs']:
    keep.add(root / rel)
    for parent in pathlib.PurePosixPath(rel).parents:
        if str(parent) != '.': keep.add(root / parent)
with open(output, 'wb') as blob, gzip.GzipFile(filename='', mode='wb', fileobj=blob, mtime=0) as gz, tarfile.open(fileobj=gz, mode='w') as archive:
    for path in sorted(keep):
        item = archive.gettarinfo(str(path), arcname=name if path == root else name+'/'+str(path.relative_to(root)))
        item.uid = item.gid = item.mtime = 0
        item.uname = item.gname = ''
        item.mode = 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644
        if path.is_file():
            with path.open('rb') as content: archive.addfile(item, content)
        else: archive.addfile(item)
`, directory, output, id, list], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  } finally { await rm(work, { recursive: true, force: true }); }
}
