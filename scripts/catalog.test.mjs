import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCatalog, validatePack, checkPackModel, materialize, sourceLink, installCommand, readCatalog, tagCommit, checkRetiredTarget } from './catalog.mjs';
import { archivePack } from './archive.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const entry = { id: 'example', name: 'Example', description: 'Example pack.', tags: ['research'], source: { kind: 'bundled', path: 'packs/example' } };
function catalog(pack = entry) { return { version: 1, repository: '2found/soot-forge', packs: [structuredClone(pack)] }; }
const linked = { ...entry, source: { kind: 'github', repository: 'someone/repo', path: 'packs/example', ref: 'a'.repeat(40), version: '1.2.3' } };

test('validation rejects unknown flags and missing or duplicate installer options', async () => {
  const exec = promisify(execFile);
  for (const args of [['--unknown'], ['--soot'], ['--soot', '--remote'], ['--remote', '--remote'], ['--soot', 'soot', '--soot', 'soot']]) {
    await assert.rejects(exec(process.execPath, [join(import.meta.dirname, 'validate.mjs'), ...args]), error => error.code === 1 && /Usage:/.test(error.stderr));
  }
});

test('both contribution modes produce GitHub folder install commands', () => {
  validateCatalog(catalog()); validateCatalog(catalog(linked));
  assert.equal(sourceLink(entry), 'https://github.com/2found/soot-forge/tree/main/packs/example');
  assert.equal(installCommand(linked), `soot add https://github.com/someone/repo/tree/${'a'.repeat(40)}/packs/example`);
  assert.match(installCommand(entry, 'v1.2.3'), /tree\/v1\.2\.3\/packs\/example$/);
});

test('PR metadata rejects duplicate IDs, unknown fields, traversal and moving refs', () => {
  const mutations = [
    c => c.packs.push(c.packs[0]), c => c.version = 2, c => c.repository = 'other/repo',
    c => delete c.packs[0].id, c => c.packs[0].id = {}, c => c.packs[0].id = 'Bad Name', c => c.packs[0].unknown = true,
    c => c.packs[0].name = 'unsafe\nname', c => c.packs[0].source.path = 'packs/../private',
    c => c.packs[0].source.path = '/tmp/example', c => c.packs[0].source.path = 'packs/.git',
    c => c.packs[0].source.path = 'packs/other', c => c.packs[0].source.extra = true,
    c => c.packs[0].source = { ...linked.source, ref: 'main' },
    c => c.packs[0].source = { ...linked.source, repository: 'https://github.com/owner/repo' },
    c => c.packs[0].source = { ...linked.source, repository: 'owner/repo;echo' },
    c => c.packs[0].tags = ['tag', 'tag'], c => c.packs[0].tags = [1],
    c => c.packs[0].source = { ...linked.source, version: undefined }, c => c.packs[0].source = { ...linked.source, version: 'v1.2.3' },
    c => c.packs[0].source = { ...linked.source, version: '1.2' }, c => c.packs[0].source = { ...linked.source, version: '1.2.3-rc.1' },
    c => c.packs[0].source = { ...linked.source, version: 123 }, c => c.packs[0].source.version = '1.2.3',
  ];
  for (const mutate of mutations) {
    const value = catalog(); mutate(value);
    assert.throws(() => validateCatalog(value));
  }
});

test('a retired pack merges into a listed one by an explicit tool map', () => {
  const retired = { id: 'old', into: 'example', tools: { view: 'website_view' } };
  validateCatalog({ ...catalog(), retired: [retired] });
  for (const bad of [
    { ...retired, id: 'example' }, { ...retired, into: 'missing' },
    { ...retired, capabilities: { configure: 'website' } }, { ...retired, tools: ['view'] }, { ...retired, extra: true },
  ]) assert.throws(() => validateCatalog({ ...catalog(), retired: [bad] }), JSON.stringify(bad));
  assert.throws(() => validateCatalog({ ...catalog(), retired: [retired, retired] }));
  const manifest = { tools: [{ name: 'website_view' }] };
  checkRetiredTarget(retired, manifest);
  assert.throws(() => checkRetiredTarget({ ...retired, tools: { view: 'view' } }, manifest), /no tool view/);
});

test('the pack model: write tools are marked, and needs match the credentials tools read', () => {
  const need = { title: 'Key', description: 'The key.' };
  const tool = (name, mode, cred) => ({ name, run: { program: 'tools/run', mode, ...(cred ? { secret_env: { KEY: `{{cred:${cred}}}` } } : {}) } });
  const pack = { id: 'p', skills: [{ name: 's', file: 'skills/s.md' }], tools: [tool('list', 'read', 'KEY'), tool('save', 'write', 'KEY')], needs: { credentials: { KEY: need } } };
  checkPackModel(pack, 'p');
  const bad = (change, pattern) => assert.throws(() => checkPackModel(change(structuredClone(pack)), 'p'), pattern);
  bad(p => { delete p.tools[1].run.mode; return p; }, /run\.mode/);
  bad(p => { p.tools[1].run.mode = 'read'; return p; }, /named like a change/);
  bad(p => { delete p.needs; return p; }, /not declared/);
  bad(p => { p.needs.credentials.SPARE = need; return p; }, /declared but no tool/);
  bad(p => { p.needs.credentials.KEY.from = 'keychain'; return p; }, /unknown source/);
  bad(p => { p.tools[0].run.env = ['PATH']; return p; }, /run\.env/);
  bad(p => { p.tools.push(tool('list', 'read')); return p; }, /duplicate tool/);
});

test('materialization rejects symlink ancestors, missing skills, mismatched ID and forbidden or retired manifest fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'packs/example'); await mkdir(directory, { recursive: true });
  const manifest = { api_version: 'soot/v1', id: 'example', skills: [{ name: 'guide', file: 'guide.md' }] };
  await writeFile(join(directory, 'pack.json'), JSON.stringify(manifest));
  await assert.rejects(validatePack(directory, 'example'), /ENOENT/);
  await writeFile(join(directory, 'guide.md'), 'Read first.');
  await validatePack(directory, 'example');
  await assert.rejects(validatePack(directory, 'wrong'), /mismatch/);
  await writeFile(join(directory, 'pack.json'), JSON.stringify({ ...manifest, schedules: [] }));
  await assert.rejects(validatePack(directory, 'example'), /Invalid pack manifest/);
  for (const retired of [{ use: [] }, { capabilities: {} }]) {
    await writeFile(join(directory, 'pack.json'), JSON.stringify({ ...manifest, ...retired }));
    await assert.rejects(validatePack(directory, 'example'), /retired|Invalid pack manifest/);
  }
  await writeFile(join(directory, 'pack.json'), JSON.stringify(manifest));
  await symlink('guide.md', join(directory, 'link.md'));
  await assert.rejects(validatePack(directory, 'example'), /non-regular/);
  await rm(join(directory, 'link.md'));
  const escape = join(root, 'escape'); await mkdir(escape);
  await symlink('../packs', join(escape, 'packs'));
  await assert.rejects(materialize(entry, escape, join(root, 'work')), /regular directory/);
});

test('packaging is reproducible and preserves executable modes without running tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'example'); await mkdir(directory);
  await writeFile(join(directory, 'pack.json'), '{"id":"example"}');
  await writeFile(join(directory, 'never-run.sh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const a = join(root, 'a.tar.gz'), b = join(root, 'b.tar.gz');
  await archivePack(directory, a, 'example'); await archivePack(directory, b, 'example');
  assert.deepEqual(await readFile(a), await readFile(b));
});

test('the real catalog is standalone and every hosted pack validates', async t => {
  const root = join(import.meta.dirname, '..');
  const work = await mkdtemp(join(tmpdir(), 'forge-catalog-')); t.after(() => rm(work, { recursive: true, force: true }));
  const current = await readCatalog(root);
  assert.ok(current.packs.some(pack => pack.id === '2build' && pack.source.kind === 'github'));
  for (const pack of current.packs.filter(pack => pack.source.kind === 'bundled')) await materialize(pack, root, work);
});

test('an upstream tag must resolve to the pinned commit, peeled for annotated tags', () => {
  const ref = 'b'.repeat(40), tagObject = 'c'.repeat(40);
  assert.equal(tagCommit(`${tagObject}\trefs/tags/v1.2.3\n${ref}\trefs/tags/v1.2.3^{}\n`, '1.2.3'), ref);
  assert.equal(tagCommit(`${ref}\trefs/tags/v1.2.3\n`, '1.2.3'), ref);
  assert.equal(tagCommit(`${ref}\trefs/tags/v1.2.30\n${ref}\trefs/tags/1.2.3\n`, '1.2.3'), undefined);
  assert.equal(tagCommit('', '1.2.3'), undefined);
});

test('every external entry names the upstream release its pin belongs to', async () => {
  const current = await readCatalog(join(import.meta.dirname, '..'));
  const external = current.packs.filter(pack => pack.source.kind === 'github');
  assert.ok(external.length > 0);
  for (const pack of external) assert.match(pack.source.version, /^\d+\.\d+\.\d+$/);
});
