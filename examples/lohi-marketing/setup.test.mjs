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

test('build: no default blog remote, --blog-remote writes only what it is given', async () => {
  const { build, HOST_ENV } = await import('./setup.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(HOST_ENV.LOHI_BLOG_REMOTE, undefined, 'the real blog repo is never a default');
  const none = build(tmp(), { env: true, video: false, connection: null, home: tmp() });
  assert.equal(none.hostEnv.LOHI_BLOG_REMOTE, undefined);
  assert.equal(JSON.parse(readFileSync(join(none.out, 'deployment.json'), 'utf8')).env.LOHI_BLOG_REMOTE, undefined);
  const set = build(tmp(), { env: true, video: false, connection: null, home: tmp(), blogRemote: '/tmp/scratch.git' });
  assert.equal(JSON.parse(readFileSync(join(set.out, 'deployment.json'), 'utf8')).env.LOHI_BLOG_REMOTE, '/tmp/scratch.git');
});
