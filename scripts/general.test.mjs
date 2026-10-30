import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCatalog } from './catalog.mjs';
import { deriveVersion, validatePreset, readGeneral, releaseArchive, buildGeneral } from './general.mjs';

const root = join(import.meta.dirname, '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const catalog = await readCatalog(root);

// Entries of an uncompressed tar: name, mode, mtime, uid/gid, type and content.
function tarEntries(tar) {
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136), 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    assert.equal(parseInt(field(148, 156), 8), checksum, 'valid header checksum');
    entries.push({ name: field(0, 100), mode: parseInt(field(100, 108), 8), uid: parseInt(field(108, 116), 8), gid: parseInt(field(116, 124), 8),
      mtime: parseInt(field(136, 148), 8), type: field(156, 157), content: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test('the release integer grows with the Forge version and refuses what it cannot order', () => {
  assert.equal(deriveVersion('0.1.0'), 1000);
  assert.equal(deriveVersion('0.3.0'), 3000);
  assert.equal(deriveVersion('1.2.3'), 1002003);
  assert.ok(deriveVersion('0.1.0') > 1, 'every release is newer than the legacy baseline version 1');
  assert.ok(deriveVersion('0.999.999') < deriveVersion('1.0.0'));
  for (const bad of ['0.1000.0', '0.0.1000', '1.2', 'v1.2.3', '1.2.3-rc.1', '01.2.3', '', undefined])
    assert.throws(() => deriveVersion(bad), /General/, String(bad));
});

test('General is the 2agent template, with 2build fetched from Forge', async () => {
  // Digests of general/* (the General Soot definition).
  const sources = { 'soot.json': '4287b895e06cbedf48e8f44e3a2baf34ad9855f550d9ba7960b575e0bf90c9ac',
    'SOUL.md': '43b7134ff212166c8960e356295f5b975f6f3e79cef528a20394a438ec63bed4',
    'mission.md': '8d117b67719b82bc1e60fa7c64e2acfc783198c6d0c5b2ccb4fc4d96ac3b62cb' };
  for (const [name, digest] of Object.entries(sources)) assert.equal(sha256(await readFile(join(root, 'general', name))), digest, name);
  const { preset } = await readGeneral(root, catalog);
  assert.deepEqual(Object.values(preset.sources).map(source => source.github_latest), Array(preset.install.length).fill('2found/soot-forge'));
  assert.deepEqual(preset.sources['2build'], { github_latest: '2found/soot-forge' });
  assert.ok(preset.install.includes('2build') && preset.packs.includes('2build'));
  assert.ok(preset.nest.packs.includes('nest-lead') && !preset.packs.includes('nest-lead'));
});

test('the creation preset must resolve from this repository alone', async () => {
  const { preset } = await readGeneral(root, catalog);
  const mutations = [
    p => { p.sources['2build'].github_latest = '2found/2build'; },
    p => { delete p.sources['2build']; },
    p => { p.sources.extra = { github_latest: '2found/soot-forge' }; },
    p => { p.install.push('not-in-the-catalog'); },
    p => { p.packs.push('not-installed'); },
    p => { p.packs.push('Bad Selector'); },
    p => { p.packs.push('nest-lead'); },
    p => { p.nest.packs.push('toolbox:write'); },
    p => { p.nest.packs.push('not-installed'); },
    p => { p.version = 2; },
    p => { p.sources.toolbox = null; },
    p => { p.install.push(p.install[0]); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(preset); mutate(copy);
    assert.throws(() => validatePreset(copy, catalog));
  }
});

test('the release archive is a bounded soot/release-v1 definition with no pack files, byte for byte reproducible', async () => {
  const { files, preset } = await readGeneral(root, catalog);
  const archive = releaseArchive('0.3.0', files, preset);
  assert.deepEqual(archive, releaseArchive('0.3.0', files, preset));
  assert.notDeepEqual(archive, releaseArchive('0.3.1', files, preset));

  const entries = tarEntries(gunzipSync(archive));
  assert.deepEqual(entries.map(entry => entry.name), ['release.json', 'files/soots/general/SOUL.md', 'files/soots/general/mission.md', 'files/soots/general/soot.json']);
  for (const entry of entries) assert.deepEqual([entry.type, entry.mode, entry.uid, entry.gid, entry.mtime], ['0', 0o600, 0, 0, 0], entry.name);

  const manifest = JSON.parse(entries[0].content);
  assert.deepEqual(Object.keys(manifest), ['api_version', 'id', 'version', 'source_version', 'packs_dir', 'soots', 'nest', 'files']);
  assert.deepEqual({ ...manifest, files: undefined }, { api_version: 'soot/release-v1', id: 'general', version: 3000, source_version: '0.3.0',
    packs_dir: 'packs', soots: ['soots/general/soot.json'], nest: preset.nest, files: undefined });
  assert.deepEqual(Object.keys(manifest.files), entries.slice(1).map(entry => entry.name.slice('files/'.length)));
  assert.ok(Object.keys(manifest.files).every(path => path.startsWith('soots/general/')), 'no pack files');
  for (const entry of entries.slice(1)) {
    const listed = manifest.files[entry.name.slice('files/'.length)];
    assert.deepEqual(listed, { sha256: sha256(entry.content), bytes: entry.content.length });
  }
  assert.equal(archive[9], 255, 'gzip header does not record the build host');
  assert.equal(archive.readUInt32LE(4), 0, 'gzip header carries no time');
});

test('a standard tar reader lists the release archive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-general-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'dist'); await mkdir(out);
  await buildGeneral(root, out, '0.3.0', catalog);
  const { stdout } = await promisify(execFile)('tar', ['-tzf', join(out, 'general-release_0.3.0.tar.gz')]);
  assert.deepEqual(stdout.trim().split('\n'), ['release.json', 'files/soots/general/SOUL.md', 'files/soots/general/mission.md', 'files/soots/general/soot.json']);
});

test('both assets are written, summed and identical across builds', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-general-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const [a, b] = [join(dir, 'a'), join(dir, 'b')];
  await mkdir(a); await mkdir(b);
  const first = await buildGeneral(root, a, '0.3.0', catalog), second = await buildGeneral(root, b, '0.3.0', catalog);
  assert.deepEqual(first, second);
  const names = ['general-release_0.3.0.tar.gz', 'general-preset_0.3.0.json'];
  assert.deepEqual(first, await Promise.all(names.map(async name => `${sha256(await readFile(join(a, name)))}  ${name}`)));
  const { preset } = await readGeneral(root, catalog);
  assert.deepEqual(JSON.parse(await readFile(join(a, names[1]), 'utf8')), preset);
  await assert.rejects(buildGeneral(root, a, '0.1000.0', catalog), /minor and patch/);
});

test('the package version in this checkout is one General can derive', async () => {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(deriveVersion(version) >= 1000);
});
