// goals_checkin: a goal whose metric.ref names another product's number (`2novel:activated_new`) gets its reading from
// that product's scoreboard (SCOREBOARD_URLS) or from recorded metrics, through the `soot` CLI. The CLI is a stub script
// that serves a goal list and logs every argv; it is never a real runtime.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world } from './world.mjs';
import { startBoardApi, KEY } from './fixtures.mjs';
import { parseRef } from '../tools/lib/goals.mjs';

const lohi = await startBoardApi();
const novel = await startBoardApi();
novel.over = { product: '2novel', metrics: {
  signups: { label: 'Đăng ký mới', unit: 'count', value: 64, previous: 58 },
  activated_new: { label: 'Người mới dịch chương đầu', unit: 'count', value: 22, previous: 20 },
  refunds: { label: 'Hoàn tiền', unit: 'count', value: 30, previous: 12, good: 'down' },
} };
const TOKEN = 'srt_test-call-token-not-a-secret';
const RUNTIME = 'http://127.0.0.1:7788';
const tmp = mkdtempSync(join(tmpdir(), 'cl-goals-'));
after(() => { lohi.close(); novel.close(); rmSync(tmp, { recursive: true, force: true }); });

/** A `soot` stub: `goals list` prints `goals` (a `checkin` answers 0, or 1 for ids in `refuse`); every argv is logged. */
function stubSoot(goals, { refuse = [] } = {}) {
  const dir = mkdtempSync(join(tmp, 's-'));
  const bin = join(dir, 'soot');
  writeFileSync(join(dir, 'goals.json'), JSON.stringify({ goals, total: goals.length }));
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${dir}/log"
echo "$SOOT_RUNTIME_URL $([ "$SOOT_RUNTIME_TOKEN" = "${TOKEN}" ] && echo token-ok || echo token-missing)" >> "${dir}/env"
if [ "$1 $2" = "goals list" ]; then cat "${dir}/goals.json"; exit 0; fi
if [ "$1 $2" = "goals checkin" ]; then case " ${refuse.join(' ')} " in *" $3 "*) echo '{"code":"goal_not_active"}'; exit 1;; esac; echo '{"goal":{}}'; exit 0; fi
exit 1
`);
  chmodSync(bin, 0o755);
  const envs = () => (existsSync(join(dir, 'env')) ? readFileSync(join(dir, 'env'), 'utf8').trim().split('\n') : []);
  const calls = () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n') : []);
  return { bin, dir, envs, checkins: () => calls().filter(l => l.startsWith('goals checkin')) };
}
const goal = (id, ref, extra = {}) => ({ id, product: '2novel', level: 'cycle', status: 'active', start: '2026-11-02', end: '2026-12-27', metric: { ref, good: 'up', baseline: 22, target: 35 }, guardrails: [], last_checkin: null, ...extra });
const mk = (cli, extra = {}) => world({ env: { SCOREBOARD_URL: lohi.url, SCOREBOARD_URLS: `2novel=${novel.url}`, SCOREBOARD_KEYS: `2novel=${KEY}`, PRODUCT_ADMIN_KEY: KEY, LOOP_SOOT_BIN: cli.bin, SOOT_RUNTIME_URL: RUNTIME, SOOT_RUNTIME_TOKEN: TOKEN, ...extra } });

test('parseRef: <product>:<key>, company-loop:<key> takes the goal product then the host, anything else is not ours', () => {
  assert.deepEqual(parseRef('2novel:activated_new', '', 'lohi'), { product: '2novel', key: 'activated_new' });
  assert.deepEqual(parseRef('company-loop:first_payers', 'sach-hay', 'lohi'), { product: 'sach-hay', key: 'first_payers' });
  assert.deepEqual(parseRef('company-loop:first_payers', '', 'lohi'), { product: 'lohi', key: 'first_payers' });
  assert.equal(parseRef('company-loop:first_payers', '', null), null);
  for (const bad of ['', 'activated_new', '2novel:', 'x:Y', '2novel:a b', null]) assert.equal(parseRef(bad, '2novel', 'lohi'), null, String(bad));
});

test('a 2Novel goal is checked in from the 2Novel scoreboard; the note names the product and period; a second run does nothing', async () => {
  const cli = stubSoot([goal('g_a', '2novel:activated_new'), goal('g_b', '2novel:signups')]);
  const w = mk(cli);
  await w.call('scoreboard_sync');
  const out = await w.call('goals_checkin');
  assert.equal(out.done, true);
  assert.deepEqual(out.checked.map(c => [c.goal, c.value]), [['g_a', 22], ['g_b', 64]]);
  assert.equal(cli.checkins().length, 2);
  // Every call to the runtime carries the per-call token and URL, never an operator --config.
  assert.ok(cli.envs().length >= 3 && cli.envs().every(l => l === `${RUNTIME} token-ok`), cli.envs().join('|'));
  assert.ok(!readFileSync(join(cli.dir, 'log'), 'utf8').includes('--config'));
  assert.match(cli.checkins()[0], /^goals checkin g_a --value 22 --confidence 5 --note bảng số 2novel \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}: 22 \(kỳ trước 20\) --json$/);
  // The runtime now reports the check-in; the same period is not written twice.
  const note = cli.checkins()[0].split('--note ')[1].split(' --json')[0];
  const cli2 = stubSoot([goal('g_a', '2novel:activated_new', { last_checkin: { at: 'x', value: 22, confidence: 5, note, by: 'x' } })]);
  const again = await mk(cli2).call('scoreboard_sync').then(() => mk(cli2));
  await again.call('scoreboard_sync');
  const out2 = await again.call('goals_checkin');
  assert.deepEqual(out2.skipped.map(s => s.why), ['already_checked_in']);
  assert.equal(cli2.checkins().length, 0);
});

test('non-happy paths: unknown product, a key the board lacks, not started yet, a plain-text ref, a refused check-in', async () => {
  const cli = stubSoot([
    goal('g_none', 'nobody:signups'), goal('g_key', '2novel:paying_users'), goal('g_future', '2novel:signups', { start: '2027-01-04' }),
    goal('g_text', 'tăng đăng ký'), goal('g_refused', '2novel:signups'),
  ], { refuse: ['g_refused'] });
  const w = mk(cli);
  await w.call('scoreboard_sync');
  const out = await w.call('goals_checkin');
  assert.deepEqual(Object.fromEntries(out.skipped.map(s => [s.goal, s.why])), { g_none: 'no_numbers_for_product', g_key: 'metric_not_in_board', g_future: 'period_before_start', g_text: 'not_scoreboard_ref' });
  assert.deepEqual(out.failed.map(f => [f.goal, f.code]), [['g_refused', 'goal_not_active']]);
  assert.equal(out.wake, true, 'a failed check-in is the only thing that wakes a model');
  assert.deepEqual(out.checked, []);
});

test('a Soot that records the numbers (metrics_record) feeds goals the same way, with no scoreboard address', async () => {
  const cli = stubSoot([goal('g_m', 'acme:mrr_usd', { product: 'acme' }), goal('g_c', 'company-loop:churn_pct', { product: 'acme' })]);
  const w = mk(cli, { SCOREBOARD_URL: '', SCOREBOARD_URLS: '' });
  await w.call('metrics_record', { product: 'acme', period: { from: '2026-11-02', to: '2026-11-08' }, metrics: [{ key: 'mrr_usd', value: 9900 }, { key: 'churn_pct', value: 2.9, previous: 3, good: 'down' }] });
  const out = await w.call('goals_checkin');
  assert.deepEqual(out.checked.map(c => [c.goal, c.value, c.period]), [['g_m', 9900, '2026-11-02..2026-11-08'], ['g_c', 2.9, '2026-11-02..2026-11-08']]);
});

test('guardrails are reported against their limit, not recorded; dry_run writes nothing', async () => {
  const cli = stubSoot([goal('g_a', '2novel:activated_new', { guardrails: [{ ref: '2novel:refunds', good: 'down', limit: 25 }] })]);
  const w = mk(cli);
  await w.call('scoreboard_sync');
  const out = await w.call('goals_checkin', { dry_run: true });
  assert.deepEqual(out.guardrails, [{ goal: 'g_a', ref: '2novel:refunds', value: 30, limit: 25, breached: true }]);
  assert.equal(out.checked[0].dry_run, true);
  assert.equal(cli.checkins().length, 0);
});

test('without a reachable soot CLI the tool answers a quiet skipped and touches nothing', async () => {
  const w = world({ env: { SCOREBOARD_URL: lohi.url, PRODUCT_ADMIN_KEY: KEY } });
  const out = await w.call('goals_checkin');
  assert.equal(out.skipped, true);
  assert.equal(out.wake, false);
  const broken = stubSoot([]);
  writeFileSync(broken.bin, '#!/bin/sh\nexit 1\n');
  const out2 = await mk(broken).call('goals_checkin');
  assert.equal(out2.reason_code, 'goals_unreadable');
});

test('a runtime that issues no token leaves the quiet goals_unreadable skip and never runs soot', async () => {
  const cli = stubSoot([goal('g_a', '2novel:activated_new')]);
  for (const missing of [{ SOOT_RUNTIME_TOKEN: '' }, { SOOT_RUNTIME_URL: '' }, { SOOT_RUNTIME_TOKEN: '', SOOT_RUNTIME_URL: '' }]) {
    const out = await mk(cli, missing).call('goals_checkin');
    assert.equal(out.skipped, true);
    assert.equal(out.reason_code, 'goals_unreadable');
    assert.equal(out.notify, false);
    assert.equal(out.wake, false);
  }
  // The operator's saved config is not a way in: LOOP_SOOT_CONFIG alone does not make the tool call soot.
  const out = await mk(cli, { SOOT_RUNTIME_TOKEN: '', LOOP_SOOT_CONFIG: join(cli.dir, 'deployment.json') }).call('goals_checkin');
  assert.equal(out.reason_code, 'goals_unreadable');
  assert.equal(cli.envs().length, 0);
});

test('the pack declares the runtime scopes goals_checkin uses, and only those', () => {
  const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
  assert.deepEqual(pack.needs.runtime, ['goals.read', 'goals.checkin']);
  assert.equal(pack.tools.find(t => t.name === 'goals_checkin').run.mode, 'write');
});
