import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConnection } from './setup.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'conn-'));
const put = (dir, name = 'connection.yaml') => { mkdirSync(join(dir, '.2server'), { recursive: true }); writeFileSync(join(dir, '.2server', name), 'x'); return join(dir, '.2server', name); };

test('findConnection: the checkout above the forge wins, then ~/.2server, else null', () => {
  const repo = tmp(), home = tmp(), empty = tmp();
  const file = put(repo);
  const deep = join(repo, '2agent', 'soot-forge'); mkdirSync(deep, { recursive: true });
  assert.equal(findConnection({ repo: undefined, start: deep, home }), file);
  assert.equal(findConnection({ repo, start: empty, home }), file, 'LOHI_REPO first');
  const homeFile = put(home, 'connection.json');
  assert.equal(findConnection({ repo: undefined, start: empty, home }), homeFile);
  assert.equal(findConnection({ repo: undefined, start: empty, home: tmp() }), null);
});
