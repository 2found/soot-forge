// scoreboard_sync: quiet skip without a key or address, one plain line for a refused key, the week
// written once to the company baseline (bbs), bbs missing a note and not a failure.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, T0 } from './world.mjs';
import { startBoardApi, fakeBbs, KEY } from './fixtures.mjs';

const api = await startBoardApi();
after(() => api.close());
const reset = () => { api.mode = 'ok'; api.calls.length = 0; api.over = {}; };
const live = (over = {}) => world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, ...over } });

test('no key or no address: a quiet skipped (never a failure), and nothing is sent', async () => {
  reset();
  const noKey = await world({ env: { SCOREBOARD_URL: api.url } }).call('scoreboard_sync');
  assert.deepEqual([noKey.skipped, noKey.reason_code, noKey.key, noKey.notify], [true, 'optional_credential', 'PRODUCT_ADMIN_KEY', false]);
  const noUrl = await world({ env: { PRODUCT_ADMIN_KEY: KEY } }).call('scoreboard_sync');
  assert.deepEqual([noUrl.skipped, noUrl.key], [true, 'SCOREBOARD_URL']);
  // The key goes over https or to this machine only.
  const plain = await world({ env: { SCOREBOARD_URL: 'http://example.com/admin/analysis/scoreboard', PRODUCT_ADMIN_KEY: KEY } }).call('scoreboard_sync');
  assert.deepEqual([plain.skipped, plain.key], [true, 'SCOREBOARD_URL']);
  assert.equal(api.calls.length, 0);
});

test('a sync stores one row per period, sends the key only as X-API-Key, asks for the last 7 full days and answers {done}', async () => {
  reset();
  const bbs = fakeBbs();
  const w = live({ BBS_BIN: bbs.bin });
  const out = await w.call('scoreboard_sync');
  assert.equal(out.done, true);
  assert.equal(out.period, '2026-11-02..2026-11-08');
  assert.deepEqual([api.calls[0].from, api.calls[0].to, api.calls[0].key, api.calls[0].auth], ['2026-11-02', '2026-11-08', KEY, null]);
  assert.equal(w.rows('scoreboard').length, 1);
  assert.equal(w.rows('scoreboard')[0].metrics.signups.value, 120);
  await w.call('scoreboard_sync'); // the same period again updates, never duplicates
  assert.equal(w.rows('scoreboard').length, 1);
  w.now += 86_400_000; // the next day: a new rolling period
  await w.call('scoreboard_sync');
  assert.equal(w.rows('scoreboard').length, 2);
});

test('for_digest answers the sync result; the finished week goes to `bbs company scoreboard record` once', async () => {
  reset();
  const bbs = fakeBbs();
  const w = live({ BBS_BIN: bbs.bin });
  const out = await w.call('scoreboard_sync', { for_digest: true });
  assert.deepEqual([out.ok, out.synced, out.baseline, out.done], [true, true, 'recorded', undefined]);
  const calls = bbs.calls().filter(c => c.argv[0] === 'company');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(0, 7), ['company', 'scoreboard', 'record', '--product', 'lohi', '--week', '2026-11-02']);
  const flags = Object.fromEntries(calls[0].argv.slice(7).reduce((a, x, i, all) => (i % 2 === 0 && x.startsWith('--') ? [...a, [x, all[i + 1]]] : a), []));
  assert.deepEqual([flags['--revenue'], flags['--active-users'], flags['--support-cases']], ['1200000', '900', '30']);
  // Idempotent: the week is recorded once, however often the daily sync runs.
  assert.equal((await w.call('scoreboard_sync')).baseline, 'already');
  w.now += 3 * 86_400_000; // Thursday: the rolling window moved, the last full week is still 2-8 Nov
  const thu = await w.call('scoreboard_sync');
  assert.equal(thu.baseline, 'already');
  assert.equal(bbs.calls().filter(c => c.argv[0] === 'company').length, 1);
  assert.equal(api.calls.some(c => c.from === '2026-11-02' && c.to === '2026-11-08'), true);
});

test('on a day the rolling window is not the last full week, that week is fetched for the baseline', async () => {
  reset();
  const bbs = fakeBbs();
  const w = live({ BBS_BIN: bbs.bin });
  w.now = T0 + 2 * 86_400_000; // Wednesday 11 Nov
  const out = await w.call('scoreboard_sync', { for_digest: true });
  assert.equal(out.baseline, 'recorded');
  assert.deepEqual(api.calls.map(c => [c.from, c.to]), [['2026-11-04', '2026-11-10'], ['2026-11-02', '2026-11-08']]);
});

test('bbs missing is a note, never a failure, and the week is tried again next time', async () => {
  reset();
  const w = live({ BBS_BIN: '/nonexistent/bbs', HOME: '/nonexistent-home', PATH: '/nonexistent' });
  const out = await w.call('scoreboard_sync', { for_digest: true });
  assert.deepEqual([out.ok, out.synced, out.baseline], [true, true, 'bbs_missing']);
  assert.equal(w.rows('state').some(r => r.key.startsWith('baseline:')), false);
});

test('a failing bbs is told in the note and the week is tried again; the scoreboard row is still kept', async () => {
  reset();
  const bbs = fakeBbs();
  bbs.failCompany(true);
  const w = live({ BBS_BIN: bbs.bin });
  const out = await w.call('scoreboard_sync', { for_digest: true });
  assert.deepEqual([out.ok, out.synced], [true, true]);
  assert.match(out.baseline, /^bbs_failed: .*invalid product/);
  assert.equal(w.rows('scoreboard').length, 1);
  bbs.failCompany(false);
  w.now += 3_600_000;
  assert.equal((await w.call('scoreboard_sync')).baseline, 'recorded');
});

test('a refused key is one plain line naming the key and its role, raised once as a Cần bạn ask', async () => {
  reset();
  const w = live({ PRODUCT_ADMIN_KEY: 'a-reader-key' });
  const first = await w.call('scoreboard_sync');
  assert.equal(first.ok, false);
  assert.equal(first.reason_code, 'forbidden');
  assert.match(first.message, /PRODUCT_ADMIN_KEY/);
  assert.match(first.message, /agent_mod/);
  assert.doesNotMatch(first.message, /a-reader-key/);
  assert.deepEqual([first.notify, first.ask?.keys], [true, ['company:scoreboard:forbidden']]);
  const again = await w.call('scoreboard_sync');
  assert.deepEqual([again.ok, again.notify, again.ask], [false, false, undefined], 'the same failure is not raised twice');
  assert.equal(w.rows('scoreboard').length, 0);
});

test('an unreachable or malformed answer keeps old numbers and says so without leaking the key', async () => {
  reset();
  const w = live();
  await w.call('scoreboard_sync');
  api.mode = 'error';
  const down = await w.call('scoreboard_sync');
  assert.deepEqual([down.ok, down.reason_code], [false, 'unreachable']);
  api.mode = 'bad';
  w.now += 86_400_000;
  const bad = await w.call('scoreboard_sync');
  assert.deepEqual([bad.ok, bad.reason_code], [false, 'bad']);
  assert.equal(w.rows('scoreboard').length, 1, 'the last good period stays');
  for (const o of [down, bad]) assert.doesNotMatch(JSON.stringify(o), new RegExp(KEY));
  const dead = await world({ env: { SCOREBOARD_URL: 'http://127.0.0.1:1/x', PRODUCT_ADMIN_KEY: KEY } }).call('scoreboard_sync');
  assert.equal(dead.reason_code, 'unreachable');
});
