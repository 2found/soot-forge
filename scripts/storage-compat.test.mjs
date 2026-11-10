import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareStorage, baseTag, storageRefusals } from './storage-compat.mjs';

const v1 = {version: 1, tables: [{name: 'bets', columns: [{name: 'title', type: 'text'}]}]};
const withCol = (version, col = {name: 'goal', type: 'text'}) => ({version, tables: [{name: 'bets', columns: [...v1.tables[0].columns, col]}]});

test('adding a column needs a higher storage.version; an unchanged one passes', () => {
  assert.equal(compareStorage(v1, structuredClone(v1)), null);
  assert.match(compareStorage(v1, withCol(1)), /version stayed 1/);
  assert.equal(compareStorage(v1, withCol(2)), null);
  assert.match(compareStorage(v1, {version: 1, tables: [{name: 'bets', columns: [{name: 'title', type: 'text', description: 'x'}]}]}), /version stayed/);
});

test('dropping or retyping storage is refused even with a version bump', () => {
  assert.match(compareStorage(v1, {version: 2, tables: []}), /table bets dropped/);
  assert.match(compareStorage(v1, {version: 2, tables: [{name: 'bets', columns: []}]}), /column bets.title dropped/);
  assert.match(compareStorage(v1, {version: 2, tables: [{name: 'bets', columns: [{name: 'title', type: 'json'}]}]}), /text → json/);
  assert.match(compareStorage(v1, {version: 2, tables: [{name: 'bets', columns: [{name: 'title', type: 'text', unique: true}]}]}), /made unique/);
  assert.equal(compareStorage(null, v1), null, 'a new pack has nothing to break');
});

test('every bundled pack keeps storage compatible with the previous release', async t => {
  const root = resolve(import.meta.dirname, '..');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const base = baseTag(root, version);
  if (!base) {
    if (process.env.CI) assert.fail('no earlier v* tag reachable: check out with fetch-depth: 0');
    return t.skip('no earlier release tag in this checkout');
  }
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'));
  const paths = catalog.packs.filter(p => p.source.kind === 'bundled').map(p => p.source.path);
  assert.deepEqual(await storageRefusals(root, base, paths), []);
});
