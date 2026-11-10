import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, symlinkSync, lstatSync, existsSync} from 'node:fs';
import {tmpdir, hostname} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, profileOwner, assertProfileFree, siblingSessions, sessionNames, pidAlive} from './profile.mjs';

const profileWith = target => {
  const dir = mkdtempSync(join(tmpdir(), 'soot-profile-'));
  if (target !== undefined) symlinkSync(target, join(dir, 'SingletonLock'));
  return dir;
};
// A pid that existed and is gone.
const deadPid = () => Number(spawnSync(process.execPath, ['-p', 'process.pid'], {encoding: 'utf8'}).stdout);

test('a daemon idles out after 30 minutes unless the host says otherwise', () => {
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(idleTimeoutMs(undefined), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutMs(''), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(idleTimeoutMs('60000'), 60000);
  assert.equal(idleTimeoutMs('0'), 0, 'never is possible only when asked for');
  for (const bad of ['-1', 'abc', '1e9', '12.5', '99999999999']) assert.equal(idleTimeoutMs(bad), DEFAULT_IDLE_TIMEOUT_MS, bad);
  assert.equal(idleTimeoutMs('999999999'), 24 * 60 * 60 * 1000, 'capped at a day');
});

test('a profile with no lock is free', async () => {
  const dir = profileWith();
  try { assert.equal(await profileOwner(dir), null); } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a live lock owner is reported with its pid', async () => {
  const dir = profileWith(`${hostname()}-${process.pid}`);
  try {
    assert.deepEqual(await profileOwner(dir), {pid: process.pid, host: hostname(), foreign: false});
    assert.ok(lstatSync(join(dir, 'SingletonLock')).isSymbolicLink(), 'a live lock is left alone');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a lock whose process is gone is cleaned up as Chrome would', async () => {
  const dir = profileWith(`${hostname()}-${deadPid()}`);
  try {
    symlinkSync('x', join(dir, 'SingletonSocket'));
    assert.equal(await profileOwner(dir), null);
    assert.equal(existsSync(join(dir, 'SingletonLock')) || lstatSyncSafe(join(dir, 'SingletonLock')), false);
    assert.equal(lstatSyncSafe(join(dir, 'SingletonSocket')), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
function lstatSyncSafe(p) { try { lstatSync(p); return true; } catch { return false; } }

test('a malformed lock target is no owner', async () => {
  for (const target of ['garbage', 'host-', 'host-abc', 'host-0']) {
    const dir = profileWith(target);
    try { assert.equal(await profileOwner(dir), null, target); } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('a lock from another host is never judged dead from here', async () => {
  const dir = profileWith(`other-host-${deadPid()}`);
  try {
    const owner = await profileOwner(dir, {host: 'this-host'});
    assert.equal(owner.foreign, true);
    assert.equal(owner.host, 'other-host');
    assert.ok(lstatSync(join(dir, 'SingletonLock')).isSymbolicLink());
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the sessions that name the same browser in another runtime are the ones to close', () => {
  const mine = 'sootp-aaaaaaaaaaaa-lohi-editor';
  const listed = [mine, 'sootp-bbbbbbbbbbbb-lohi-editor', 'sootp-bbbbbbbbbbbb-other', 'soot-bbbbbbbbbbbb-lohi-editor', 'sootn-cccccccccccc-lohi-editor', 'weird'];
  assert.deepEqual(siblingSessions(listed, mine), ['sootp-bbbbbbbbbbbb-lohi-editor']);
  assert.deepEqual(siblingSessions(listed, 'not-a-session'), []);
  assert.deepEqual(sessionNames({data: {sessions: ['a', {name: 'b'}, {session: 'c'}, 5, null]}}), ['a', 'b', 'c']);
  assert.deepEqual(sessionNames({}), []);
});

test('browser_profile_in_use names the pid and the exact session to close, and kills nothing', async () => {
  const dir = profileWith(`${hostname()}-${process.pid}`);
  try {
    const ctx = {profile: dir, session: 'sootp-aaaaaaaaaaaa-lohi-editor', label: 'the browser profile of soot-lohi-editor'};
    await assert.rejects(assertProfileFree(ctx, {listSessions: async () => ['sootp-bbbbbbbbbbbb-lohi-editor']}), error => {
      assert.match(error.message, /^browser_profile_in_use:/);
      assert.ok(error.message.includes(`pid ${process.pid}`));
      assert.ok(error.message.includes('agent-browser --session sootp-bbbbbbbbbbbb-lohi-editor close'));
      assert.doesNotMatch(error.message, /close-all|--all/);
      return true;
    });
    // No daemon of any runtime lists it: the pid is named with the manual way out.
    await assert.rejects(assertProfileFree(ctx, {listSessions: async () => []}), /pid \d+.*quit that browser yourself.*Nothing was stopped/s);
    assert.equal(pidAlive(process.pid), true, 'the holder still lives');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the profile held by this runtime\'s own daemon, or by no one, passes', async () => {
  const dir = profileWith(`${hostname()}-${process.pid}`);
  try {
    const ctx = {profile: dir, session: 'sootp-aaaaaaaaaaaa-lohi-editor', label: 'x'};
    await assertProfileFree(ctx, {listSessions: async () => [ctx.session]});
    // A session list that cannot be read does not block the launch.
    await assertProfileFree(ctx, {listSessions: async () => { throw new Error('boom'); }});
    await assertProfileFree({...ctx, profile: profileWith()}, {listSessions: async () => { throw new Error('not asked'); }});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
