// Footprint of every bundled pack: what the repository tracks, what a release
// archive installs, and how big the archive is. Use --json to save a baseline
// before slimming and --compare to print the before/after table; --compare fails
// when any pack, tool or skill id disappeared.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readCatalog, materialize } from './catalog.mjs';
import { archivePack, packFiles } from './archive.mjs';

const git = promisify(execFile);
const skillLimit = 8 * 1024; // the validator's hard limit is 128 KiB; prose beyond 8 KiB is worth a look

async function trackedFiles(root, path) {
  const { stdout } = await git('git', ['ls-files', '-z', '--', path], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean);
}
async function sizes(base, paths) {
  return Promise.all(paths.map(async path => (await stat(join(base, path))).size));
}
const sum = values => values.reduce((total, value) => total + value, 0);

// Tool and skill ids as the validator names them.
export function packIds(manifest) {
  const tools = (manifest.tools ?? []).map(tool => tool.name).sort();
  const skills = (manifest.skills ?? []).map(skill => skill.name || `${manifest.id}_${posix.basename(skill.file, posix.extname(skill.file))}`).sort();
  return { tools, skills };
}

// Files a manifest points at: skill files and tool programs/args that exist in the pack.
export async function referencedFiles(manifest, directory) {
  const referenced = [];
  for (const skill of manifest.skills ?? []) referenced.push(skill.file);
  for (const tool of manifest.tools ?? []) {
    if (!tool.run) continue;
    for (const candidate of [tool.run.program, ...(tool.run.args ?? [])]) {
      const path = posix.join(tool.run.directory ?? '.', candidate);
      if (await stat(join(directory, path)).then(info => info.isFile(), () => false)) referenced.push(path);
    }
  }
  return referenced;
}

// slim=false measures the pre-slimming shape (every non-skipped file ships).
export async function measure(root, { slim = true } = {}) {
  const catalog = await readCatalog(root);
  const work = await mkdtemp(join(tmpdir(), 'soot-forge-footprint-'));
  try {
    const packs = [], seen = new Map();
    for (const pack of catalog.packs.filter(entry => entry.source.kind === 'bundled')) {
      const tracked = await trackedFiles(root, pack.source.path);
      const directory = await materialize(pack, root, work);
      const files = await packFiles(directory, { slim });
      const archive = join(work, `${pack.id}.tar.gz`);
      await archivePack(directory, archive, pack.id, { slim });
      const manifest = JSON.parse(await readFile(join(directory, 'pack.json'), 'utf8'));
      const missing = (await referencedFiles(manifest, directory)).filter(path => !files.includes(path));
      if (missing.length) throw new Error(`${pack.id}: archive would drop files its manifest uses: ${missing.join(', ')}`);
      const fileSizes = await sizes(directory, files);
      const oversizedSkills = [];
      for (const [index, path] of files.entries())
        if (/(^|\/)skills?(\/|\.md$)/.test(path) && path.endsWith('.md') && fileSizes[index] > skillLimit) oversizedSkills.push(path);
      for (const [index, path] of files.entries()) {
        const digest = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
        const group = seen.get(digest) ?? { bytes: fileSizes[index], paths: [] };
        group.paths.push(`${pack.id}/${path}`);
        seen.set(digest, group);
      }
      packs.push({
        id: pack.id,
        tracked_bytes: sum(await sizes(root, tracked)), tracked_files: tracked.length,
        installed_bytes: sum(fileSizes), installed_files: files.length,
        archive_bytes: (await stat(archive)).size,
        archive_sha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
        oversized_skills: oversizedSkills,
        ids: packIds(manifest),
      });
    }
    // Packs must stay self-contained, so cross-pack copies are reported, not merged.
    const duplicates = [...seen.values()].filter(group => new Set(group.paths.map(path => path.split('/')[0])).size > 1)
      .map(group => ({ bytes: group.bytes, copies: group.paths.length, paths: group.paths.sort() }))
      .sort((a, b) => b.bytes * b.copies - a.bytes * a.copies);
    return { schema: 'soot-forge.footprint.v1', mode: slim ? 'release archive' : 'baseline (dev-only files included)', packs, cross_pack_duplicates: duplicates };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function removedIds(before, after) {
  const removed = [], now = new Map(after.packs.map(pack => [pack.id, pack]));
  for (const pack of before.packs) {
    const current = now.get(pack.id);
    if (!current) { removed.push(`pack ${pack.id}`); continue; }
    for (const [kind, label] of [['tools', 'tool'], ['skills', 'skill']])
      for (const id of pack.ids[kind]) if (!current.ids[kind].includes(id)) removed.push(`${label} ${pack.id}:${id}`);
  }
  return removed;
}

const kib = bytes => (bytes / 1024).toFixed(1);
const delta = (before, after) => before === after ? '0' : `${after < before ? '-' : '+'}${kib(Math.abs(after - before))}, ${(((after - before) / before) * 100).toFixed(1)}%`;

export function compareTable(before, after) {
  const was = new Map(before.packs.map(pack => [pack.id, pack]));
  const rows = ['| pack | tracked KiB | installed KiB | archive KiB | files |', '|---|---|---|---|---|'];
  const total = { tracked_bytes: [0, 0], installed_bytes: [0, 0], archive_bytes: [0, 0], installed_files: [0, 0] };
  for (const pack of after.packs) {
    const old = was.get(pack.id);
    if (!old) { rows.push(`| ${pack.id} | new | new | new | new |`); continue; }
    for (const key of Object.keys(total)) { total[key][0] += old[key]; total[key][1] += pack[key]; }
    if (['tracked_bytes', 'installed_bytes', 'archive_bytes', 'installed_files'].every(key => old[key] === pack[key])) continue;
    const cell = key => `${kib(old[key])} → ${kib(pack[key])} (${delta(old[key], pack[key]).split(',')[0]})`;
    rows.push(`| ${pack.id} | ${cell('tracked_bytes')} | ${cell('installed_bytes')} | ${cell('archive_bytes')} | ${old.installed_files} → ${pack.installed_files} |`);
  }
  const cell = key => `${kib(total[key][0])} → ${kib(total[key][1])} (${delta(...total[key])})`;
  rows.push(`| **total (${after.packs.length} packs)** | ${cell('tracked_bytes')} | ${cell('installed_bytes')} | ${cell('archive_bytes')} | ${total.installed_files[0]} → ${total.installed_files[1]} |`);
  const unchanged = after.packs.filter(pack => was.get(pack.id)?.archive_sha256 === pack.archive_sha256).length;
  return { table: rows.join('\n'), total, unchangedArchives: unchanged };
}

async function main() {
  const args = process.argv.slice(2), options = { slim: true, json: null, compare: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-dev') options.slim = false;
    else if (['--json', '--compare'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = resolve(args[++i]);
    else throw new Error('Usage: node scripts/footprint.mjs [--include-dev] [--json FILE] [--compare BASELINE.json]');
  }
  const root = resolve(import.meta.dirname, '..');
  const report = await measure(root, options);
  if (options.json) await writeFile(options.json, JSON.stringify(report, null, 2) + '\n');
  if (!options.compare) {
    for (const pack of report.packs)
      console.log(`${pack.id.padEnd(18)} tracked ${kib(pack.tracked_bytes).padStart(8)} KiB  installed ${kib(pack.installed_bytes).padStart(8)} KiB  archive ${kib(pack.archive_bytes).padStart(8)} KiB  files ${pack.installed_files}`);
    const dupes = sum(report.cross_pack_duplicates.map(group => group.bytes * (group.copies - 1)));
    console.log(`cross-pack duplicate bytes (kept: packs are self-contained): ${kib(dupes)} KiB in ${report.cross_pack_duplicates.length} groups`);
    const oversized = report.packs.flatMap(pack => pack.oversized_skills.map(path => `${pack.id}/${path}`));
    console.log(oversized.length ? `skills over ${skillLimit / 1024} KiB: ${oversized.join(', ')}` : `skills over ${skillLimit / 1024} KiB: none`);
    return;
  }
  const before = JSON.parse(await readFile(options.compare, 'utf8'));
  const { table, total, unchangedArchives } = compareTable(before, report);
  console.log(table);
  console.log(`\nunchanged archive digests: ${unchangedArchives}/${report.packs.length}`);
  const removed = removedIds(before, report);
  console.log(`ids removed: ${removed.length}${removed.length ? `\n  ${removed.join('\n  ')}` : ''}`);
  if (removed.length) process.exitCode = 1;
  else if (total.installed_bytes[1] >= total.installed_bytes[0]) { console.log('no installed-size reduction'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
