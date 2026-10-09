import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const tool = join(import.meta.dirname, '../tools/status.mjs');
const observation = {
  release_source: 'npm', npm_package: '9router', phase: 'idle', category: 'current',
  current: '0.5.95', latest: '0.5.95', checked: '2026-10-09T00:00:00Z', digest: '',
};
const call = {
  api_version: 'soot/v1', hook: 'tool.call', operation: 'router-care_status',
  soot: 'reader', root: 'fixture', input: {},
  event: { id: 'check', source: 'maintenance', subject: 'router', text: 'Observe status' },
};
function invoke(path, value = call) {
  return spawnSync(process.execPath, [tool], {
    input: typeof value === 'string' ? value : JSON.stringify(value),
    env: path === undefined ? {} : { ROUTER_CARE_STATUS_FILE: path },
    encoding: 'utf8', timeout: 3000,
  });
}
async function fixture(t, content = observation) {
  const root = await mkdtemp(join(tmpdir(), 'router-care-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'status.json');
  await writeFile(path, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  return path;
}
function result(path, code) {
  const run = invoke(path);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const output = JSON.parse(run.stdout);
  if (code) assert.deepEqual(output, { error: { code } });
  return output;
}

test('reads the host observation and omits private journal or added fields', async t => {
  const path = await fixture(t, { ...observation, token: 'private-marker', data_copy: '/private/data', pending: { text: 'private-marker' } });
  assert.deepEqual(result(path), { status: observation });
  assert.equal(invoke(path).stdout.includes('private-marker'), false);
});

test('retains a fenced or unavailable observation without inventing success', async t => {
  const state = { ...observation, release_source: 'github', npm_package: '', phase: 'blocked', category: 'post_promotion_uncertain', current: '', latest: '0.0.0', checked: '0001-01-01T00:00:00Z', digest: 'decolua/9router@sha256:' + 'a'.repeat(64) };
  assert.deepEqual(result(await fixture(t, state)), { status: state });
});

test('fails closed for missing/relative bindings and an unreadable file without leaking paths', async t => {
  result(undefined, 'binding_unavailable');
  result('status.json', 'binding_unavailable');
  const path = await fixture(t);
  await rm(path);
  result(path, 'status_unavailable');
  assert.equal(invoke(path).stdout.includes(path), false);
});

test('rejects malformed, excessive, non-regular and symlink status', async t => {
  for (const value of ['{private-marker', 'x'.repeat(16 * 1024 + 1), Buffer.from([0xff]), { ...observation, checked: 'invalid' }, { ...observation, phase: 'private\nmarker' }, { ...observation, digest: 'unverified@' }]) {
    result(await fixture(t, value), 'invalid_status');
  }
  const path = await fixture(t);
  result(join(path, '..'), 'invalid_status');
  const link = join(path, '../link.json');
  await symlink(path, link);
  result(link, 'invalid_status');
});

test('rejects model-supplied paths, wrong envelope versions and excessive stdin', async t => {
  const path = await fixture(t);
  for (const input of [null, [], 'status', { path: '/private/secret' }]) {
    const run = invoke(path, { ...call, input });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'Soot tool invocation failed\n');
  }
  for (const value of [{ ...call, api_version: 'soot/v2' }, { input: {} }, 'private-marker', 'x'.repeat(128 * 1024 + 1)]) {
    const run = invoke(path, value);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, 'Soot tool invocation failed\n');
  }
});
