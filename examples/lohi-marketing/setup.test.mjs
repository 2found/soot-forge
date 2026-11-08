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

test('build: the Forge packs are copied exactly as the release archive ships them (so the runtime adopts them by digest)', async () => {
  const { build } = await import('./setup.mjs');
  const { packFiles } = await import('../../scripts/archive.mjs');
  const { join: j, resolve: r } = await import('node:path');
  const out = build(tmp(), { env: true, video: false, connection: null, home: tmp() }).out;
  for (const id of ['marketing', 'browser-use', 'company-loop']) {
    const want = (await packFiles(r(import.meta.dirname, '..', '..', 'packs', id))).sort();
    const got = (await packFiles(j(out, 'packs', id), { slim: false })).sort();
    assert.deepEqual(got, want, `${id}: installed files differ from the release archive's`);
  }
});

test('build: --product-repo has no default; the company loop gets the scoreboard address and the repo only when given', async () => {
  const { build, HOST_ENV } = await import('./setup.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(HOST_ENV.PRODUCT_REPO, undefined, 'the real checkout is never a default');
  assert.match(HOST_ENV.SCOREBOARD_URL, /^https:\/\/.+\/scoreboard$/);
  const none = build(tmp(), { env: true, video: false, connection: null, home: tmp() });
  const d0 = JSON.parse(readFileSync(join(none.out, 'deployment.json'), 'utf8'));
  assert.equal(d0.env.PRODUCT_REPO, undefined);
  assert.equal(d0.env.SCOREBOARD_URL, HOST_ENV.SCOREBOARD_URL);
  const set = build(tmp(), { env: true, video: false, connection: null, home: tmp(), productRepo: '/tmp/scratch-product' });
  assert.equal(JSON.parse(readFileSync(join(set.out, 'deployment.json'), 'utf8')).env.PRODUCT_REPO, '/tmp/scratch-product');
});
