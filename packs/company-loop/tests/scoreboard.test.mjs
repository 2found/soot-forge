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

test('a refused key is one plain line naming the key and its role, one card id per incident', async () => {
  reset();
  const w = live({ PRODUCT_ADMIN_KEY: 'a-reader-key' });
  const first = await w.call('scoreboard_sync');
  assert.equal(first.ok, false);
  assert.equal(first.reason_code, 'forbidden');
  assert.match(first.message, /PRODUCT_ADMIN_KEY/);
  assert.match(first.message, /agent_mod/);
  assert.doesNotMatch(first.message, /a-reader-key/);
  assert.deepEqual([first.notify, first.wake, first.raise.group], [false, false, 'company:scoreboard:forbidden']);
  assert.match(first.raise.id, /^company:scoreboard:forbidden:/);
  const again = await w.call('scoreboard_sync');
  assert.equal(again.raise.id, first.raise.id, 'the same incident is the same card id: the host files it once');
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

test('readers waiting for a person: one card id per bucket, settled by the sync that finds fewer than 5', async () => {
  reset();
  const w = live({ SUPPORT_QUEUE_URL: 'https://lohi2.com/admin/support' });
  const waiting = n => { api.over = { support: { by_state: { soot: 20, waiting_human: n, human: 1, resolved: 3 }, handoff_reasons: [] } }; };
  waiting(4);
  const quiet = await w.call('scoreboard_sync');
  assert.deepEqual([quiet.done, quiet.raise], [true, undefined]);
  waiting(22);
  const first = await w.call('scoreboard_sync');
  assert.ok(first.wake !== true && first.notify !== true, 'a card needs no model');
  assert.equal(first.raise.title, '22 bạn đọc đang chờ người trả lời');
  assert.equal(first.raise.group, 'company:support:waiting');
  assert.equal(first.raise.link, 'https://lohi2.com/admin/support');
  waiting(24);
  w.now += 86_400_000;
  assert.equal((await w.call('scoreboard_sync')).raise.id, first.raise.id, 'same bucket on the next day: same id, filed once');
  waiting(51);
  w.now += 86_400_000;
  assert.equal((await w.call('scoreboard_sync')).raise.title, '51 bạn đọc đang chờ người trả lời');
  waiting(2);
  w.now += 86_400_000;
  const closed = await w.call('scoreboard_sync');
  assert.deepEqual([closed.resolves_need, closed.done, closed.raise, closed.settle], [true, true, undefined, ['company:support:waiting']]);
  waiting(9);
  w.now += 86_400_000;
  assert.ok((await w.call('scoreboard_sync')).raise, 'and raised again when it climbs back');
  assert.doesNotMatch(JSON.stringify(first), /agent-mod|PRODUCT_ADMIN/);
  api.over = {};
});

test('the digest chain sync never raises or closes the waiting ask', async () => {
  reset();
  const w = live();
  api.over = { support: { by_state: { soot: 1, waiting_human: 30, human: 0, resolved: 0 }, handoff_reasons: [] } };
  const out = await w.call('scoreboard_sync', { for_digest: true });
  assert.deepEqual([out.synced, out.raise, out.resolves_need], [true, undefined, undefined]);
  api.over = {};
});

test('the baseline counts the week\'s release tags of the product repo; none readable leaves the cell empty', async () => {
  const { execFileSync } = await import('node:child_process');
  const { scratchRepo } = await import('./fixtures.mjs');
  const repo = scratchRepo();
  const git = (args, date) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], '2026-11-01T12:00:00+07:00');
  // Two in the week 2-8 Nov (ICT), one the Sunday before, one the Monday after, one that is not a release.
  for (const [tag, date] of [['api-v1.26.0', '2026-11-02T00:30:00+07:00'], ['web-v0.25.0', '2026-11-08T23:30:00+07:00'], ['api-v1.25.0', '2026-11-01T23:59:00+07:00'], ['api-v1.31.0', '2026-11-09T00:01:00+07:00'], ['backup', '2026-11-04T10:00:00+07:00']]) {
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'tag', '-a', tag, '-m', tag], date);
  }
  reset();
  const bbs = fakeBbs();
  const out = await live({ BBS_BIN: bbs.bin, PRODUCT_REPO: repo }).call('scoreboard_sync', { for_digest: true });
  assert.equal(out.baseline, 'recorded');
  const argv = bbs.calls().find(c => c.argv[0] === 'company').argv;
  assert.equal(argv[argv.indexOf('--releases') + 1], '2');
  // A repo git cannot read: no --releases, the week is still recorded.
  reset();
  const bbs2 = fakeBbs();
  const none = await live({ BBS_BIN: bbs2.bin, PRODUCT_REPO: '/nonexistent/repo' }).call('scoreboard_sync', { for_digest: true });
  assert.equal(none.baseline, 'recorded');
  assert.equal(bbs2.calls().find(c => c.argv[0] === 'company').argv.includes('--releases'), false);
});
