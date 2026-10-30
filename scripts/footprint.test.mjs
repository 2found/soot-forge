import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCatalog } from './catalog.mjs';
import { archivePack, isDevOnly, packFiles } from './archive.mjs';
import { compareTable, packIds, referencedFiles, removedIds } from './footprint.mjs';

const exec = promisify(execFile);
const root = join(import.meta.dirname, '..');
async function tree(files) {
  const base = await mkdtemp(join(tmpdir(), 'footprint-test-'));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), body);
  }
  return base;
}
const listing = async archive => (await exec('tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean);

test('dev-only rule drops tests, QA and widget sources at any depth, never runtime files', () => {
  for (const path of ['tests/a.mjs', 'runner/main_test.go', 'runner/storage/store_test.go', 'adapter/launch.test.mjs',
    'qa/journey.py', 'widget-src/build.mjs', 'tools/__pycache__/x.pyc', 'x/testdata/golden.json', 'a/test_runner.py', '.DS_Store'])
    assert.equal(isDevOnly(path), true, path);
  for (const path of ['pack.json', 'runner/main.go', 'runner/go.mod', 'runner/contract/contract.go', 'tools/runner.py', 'widget/frame.js',
    'skills/test.md', 'tools/latest.mjs', 'docs/qa-notes.md', 'tools/attest.py'])
    assert.equal(isDevOnly(path), false, path);
});

test('archive omits dev-only files and emptied folders, is deterministic, and keeps everything else', async () => {
  const base = await tree({ 'pack.json': '{}', 'runner/main.go': 'package main', 'runner/main_test.go': 'package main',
    'runner/go.mod': 'module x', 'tests/only.test.mjs': 'x', 'skills/a.md': 'a', 'qa/j.py': 'x' });
  const out = await mkdtemp(join(tmpdir(), 'footprint-out-'));
  try {
    const first = join(out, 'one.tar.gz'), second = join(out, 'two.tar.gz');
    await archivePack(base, first, 'p', { slim: true });
    const names = await listing(first);
    assert.deepEqual(names.filter(name => !name.endsWith('/')).sort(), ['p/pack.json', 'p/runner/go.mod', 'p/runner/main.go', 'p/skills/a.md']);
    assert.equal(names.some(name => /tests|qa|_test/.test(name)), false, 'emptied tests/ and qa/ folders must vanish');
    await archivePack(base, second, 'p', { slim: true });
    assert.equal(await readFile(first, 'base64'), await readFile(second, 'base64'));
  } finally { await rm(base, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('a pack with nothing dev-only archives byte-identically with or without the rule', async () => {
  const base = await tree({ 'pack.json': '{}', 'skills/a.md': 'a', 'tools/run': 'x' });
  const out = await mkdtemp(join(tmpdir(), 'footprint-out-'));
  try {
    await archivePack(base, join(out, 'a.tgz'), 'p', { slim: true });
    await archivePack(base, join(out, 'b.tgz'), 'p', { slim: false });
    assert.equal(await readFile(join(out, 'a.tgz'), 'base64'), await readFile(join(out, 'b.tgz'), 'base64'));
    assert.deepEqual(await packFiles(base), ['pack.json', 'skills/a.md', 'tools/run']);
  } finally { await rm(base, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('every file a bundled manifest points at survives the dev-only rule', async () => {
  const catalog = await readCatalog(root);
  let checked = 0;
  for (const pack of catalog.packs.filter(entry => entry.source.kind === 'bundled')) {
    const directory = join(root, pack.source.path);
    const manifest = JSON.parse(await readFile(join(directory, 'pack.json'), 'utf8'));
    for (const path of await referencedFiles(manifest, directory)) { assert.equal(isDevOnly(path), false, `${pack.id}: ${path}`); checked++; }
  }
  assert.ok(checked > 50, `expected to check many references, saw ${checked}`);
});

test('folders emptied by slimming vanish but folders that were already empty are kept', async () => {
  const base = await tree({ 'pack.json': '{}', 'tests/a.test.mjs': 'x' });
  await mkdir(join(base, 'dependencies'));
  const out = await mkdtemp(join(tmpdir(), 'footprint-out-'));
  try {
    await archivePack(base, join(out, 'a.tgz'), 'p', { slim: true });
    assert.deepEqual((await listing(join(out, 'a.tgz'))).sort(), ['p/', 'p/dependencies/', 'p/pack.json']);
  } finally { await rm(base, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('only bundled catalog packs are slimmed by default; an external pack ships as pinned', async () => {
  const base = await tree({ 'pack.json': '{}', 'qa/skill.md': 'skill', 'runner/main_test.go': 'x' });
  const out = await mkdtemp(join(tmpdir(), 'footprint-out-'));
  try {
    await archivePack(base, join(out, 'unknown.tgz'), 'not-in-this-catalog'); // 2build-style: runtime skill under qa/
    assert.deepEqual((await listing(join(out, 'unknown.tgz'))).filter(name => !name.endsWith('/')).sort(),
      ['not-in-this-catalog/pack.json', 'not-in-this-catalog/qa/skill.md', 'not-in-this-catalog/runner/main_test.go']);
    await archivePack(base, join(out, 'bundled.tgz'), 'soot');
    assert.deepEqual((await listing(join(out, 'bundled.tgz'))).filter(name => !name.endsWith('/')), ['soot/pack.json']);
  } finally { await rm(base, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('compare fails closed when a pack, tool or skill id disappears', () => {
  const manifest = { id: 'p', tools: [{ name: 't' }], skills: [{ name: 's', file: 'skills/s.md' }, { file: 'skills/other.md' }] };
  assert.deepEqual(packIds(manifest), { tools: ['t'], skills: ['p_other', 's'] });
  const pack = (id, ids, bytes) => ({ id, ids, tracked_bytes: bytes, tracked_files: 1, installed_bytes: bytes, installed_files: 1, archive_bytes: bytes, archive_sha256: id });
  const full = packIds(manifest), before = { packs: [pack('p', full, 100), pack('q', full, 10)] };
  const slimmer = { packs: [pack('p', full, 60), pack('q', full, 10)] };
  assert.deepEqual(removedIds(before, slimmer), []);
  assert.deepEqual(removedIds(before, { packs: [pack('p', { ...full, tools: [] }, 60)] }),
    ['tool p:t', 'pack q']);
  const { table, total, unchangedArchives } = compareTable(before, slimmer);
  assert.deepEqual(total.installed_bytes, [110, 70]);
  assert.equal(unchangedArchives, 2); // the fake digest is the pack id, so both match
  assert.match(table, /\| p \| 0\.1 → 0\.1 \(-0\.0\)/);
  assert.doesNotMatch(table, /\| q \|/, 'unchanged packs are left out of the table');
});
