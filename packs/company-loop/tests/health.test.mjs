// cohorts/plans (additive scoreboard fields) and the loop-health view. The soot CLI is a stub script, never a real runtime.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world } from './world.mjs';
import { startBoardApi, KEY } from './fixtures.mjs';

const api = await startBoardApi();
const tmp = mkdtempSync(join(tmpdir(), 'cl-health-'));
after(() => { api.close(); rmSync(tmp, { recursive: true, force: true }); });
const mk = (extra = {}) => world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, ...extra } });

const COHORTS = [{ cohort: '2026-W44', signups: 50, active_w1: 20, active_w2: 12, active_w4: 5, first_payers: 3 }];
const PLANS = [{ tier: 'pro', active: 10, started: 2, revenue_vnd: 500000 }];

function stubSoot(files) {
  const bin = join(tmp, 'soot-' + Math.random().toString(36).slice(2));
  const body = Object.entries(files).map(([k, v]) => `[ "$1 $2" = "${k}" ] && { cat <<'J'\n${JSON.stringify(v)}\nJ\nexit 0; }`).join('\n');
  writeFileSync(bin, `#!/bin/sh\n${body}\nexit 1\n`);
  chmodSync(bin, 0o755);
  return bin;
}
const ago = h => new Date(Date.parse('2026-11-09T01:30:00Z') - h * 3_600_000).toISOString();

test('cohorts and plans reach the packet and the page; absent is null, malformed is dropped', async () => {
  const w = mk();
  api.over = { cohorts: COHORTS, plans: PLANS };
  await w.call('scoreboard_sync');
  const v = await w.call('page_view', {}, { page: { page: 'company' } });
  const view = v.output ?? v;
  assert.equal(view.scoreboard.cohorts[0].cohort, '2026-W44');
  assert.equal(view.scoreboard.plans[0].tier, 'pro');
  api.over = { cohorts: [{ cohort: 'bad' }, 5], plans: 'x' };
  const w2 = mk();
  await w2.call('scoreboard_sync');
  const v2 = (await w2.call('page_view', {}, { page: { page: 'company' } }));
  const s2 = (v2.output ?? v2).scoreboard;
  assert.equal(s2.cohorts ?? null, null);
  assert.equal(s2.plans ?? null, null);
  api.over = {};
});

test('health_sync on a runtime before teams: per stage last run, tokens, starving inputs; a missing scoreboard field is named', async () => {
  const bin = stubSoot({
    'schedules list': { schedules: [
      { id: 'company-scoreboard', last: ago(2), last_status: 'ok' },
      { id: 'marketing-report', last: ago(1), last_status: 'ok' },
      { id: 'blog-publish', last: ago(3), last_status: 'skipped', skip_reason: { key: 'GSC_GOOGLE' }, conversation_id: 'c-1' },
    ] },
    'traces list': { traces: [
      { run: 'chain:marketing-report:1', conversation: 'schedule:marketing-report', weighted_tokens: 0 },
      { run: 'r-9', conversation: 'c-1', weighted_tokens: 4000 },
      { run: 'r-10', conversation: 'x', origin: 'direct', weighted_tokens: 900 },
    ] },
    'attention list': { items: [{}, {}] },
  });
  api.over = {};
  const w = mk({ LOOP_SOOT_BIN: bin, LOOP_SOOT_CONFIG: join(tmp, 'deployment.json') });
  await w.call('scoreboard_sync');
  const out = await w.call('health_sync', { inputs: [{ key: 'gsc', label: 'GSC', starving: true, detail: 'GSC 0 dòng', rows: 0 }, { key: 'bad key!', label: 'x' }] });
  assert.equal(out.ok, true);
  assert.equal(out.runtime, true);
  const v = (await w.call('page_view', {}, { page: { page: 'company' } }));
  const h = (v.output ?? v).health;
  const mkt = h.stages.find(s => s.key === 'marketing');
  assert.equal(mkt.tokens_7d, 4000);
  assert.equal(mkt.model_wakes_7d, 1);
  assert.ok(mkt.starving.some(i => i.key === 'gsc' && i.detail === 'GSC 0 dòng'));
  assert.ok(!h.inputs.some(i => i.key === 'bad key!'));
  const ins = h.stages.find(s => s.key === 'insight');
  assert.ok(ins.starving.some(i => i.key === 'cohorts'), 'absent cohorts reads as starving');
  assert.equal(h.effort.chat_instructions_7d, 1);
  assert.equal(h.effort.cards_open, 2);
});

test('health_sync on the teams CLI: one row per team from `teams health`, answers from `attention answers`, no schedule-id guessing', async () => {
  const bin = stubSoot({
    'teams health': { teams: [
      { team: 'insight', name: 'Insight', schedules: [
        { id: 'weird-id-1', name: 'Digest', last: ago(2), ok: true }, { id: 'weird-id-2', last: ago(5), ok: false, error: 'x' }],
        starving_inputs: [{ team: 'marketing', item: 'metrics', reason: 'stale' }, { team: 'marketing', item: 'signals', reason: 'never_ran', optional: true }],
        tokens: { day: '2026-11-09', spent: 40000, budget: 130000, percent: 30.8, last_7_days: [1000, 2000, 0, 0, 0, 0, 40000] }, founder_effort: {} },
      { team: 'marketing', name: 'Marketing', schedules: [{ id: 'anything', last: ago(1), ok: true, skip: 'GSC_GOOGLE' }], starving_inputs: [], tokens: { spent: 0, last_7_days: [] } },
      { team: 'cs', name: 'Hỗ trợ', remote: { runtime: 'cs-server', group: 'support' }, schedules: [], starving_inputs: [], tokens: { spent: 0, last_7_days: [] } },
    ] },
    'attention answers': { answers: [], effort: { answered: 4, per_week: 4, median_seconds_to_answer: 90, window_days: 7, open_unanswered: 1 } },
  });
  api.over = {};
  const w = mk({ LOOP_SOOT_BIN: bin, LOOP_SOOT_CONFIG: join(tmp, 'deployment.json') });
  await w.call('scoreboard_sync');
  assert.equal((await w.call('health_sync', { inputs: [] })).runtime, true);
  const h = ((await w.call('page_view', {}, { page: { page: 'company' } })).output ?? {}).health ?? (await w.call('page_view', {}, { page: { page: 'company' } })).health;
  assert.deepEqual(h.stages.map(s => s.key), ['insight', 'marketing', 'cs']);
  const ins = h.stages[0];
  assert.equal(ins.tokens_7d, 43000);
  assert.equal(ins.budget_daily, 130000);
  assert.equal(ins.schedules, 2);
  assert.equal(ins.last_run.schedule, 'weird-id-1');
  assert.deepEqual(ins.failing, ['weird-id-2']);
  assert.ok(ins.starving.some(i => i.key === 'marketing.metrics' && i.detail.includes('lâu')));
  assert.ok(!ins.starving.some(i => i.key === 'marketing.signals'), 'optional inputs are not hunger');
  assert.deepEqual(h.stages[1].skipped, [{ schedule: 'anything', key: 'GSC_GOOGLE' }]);
  assert.equal(h.stages[2].external, true, 'a remote team is said to run on its own server, never "Chưa có lần chạy nào"');
  assert.equal(h.stages.length, 3, 'the remote team is the Support row, not a second one');
  assert.equal(h.effort.cards_answered_7d, 4);
  assert.equal(h.effort.median_answer_s, 90);
  assert.equal(h.effort.cards_open, 1);
});

test('health_sync without a reachable soot CLI still stores the inputs and says why the runtime part is empty', async () => {
  for (const env of [{}, { LOOP_SOOT_BIN: join(tmp, 'missing'), LOOP_SOOT_CONFIG: join(tmp, 'd.json') }, { LOOP_SOOT_BIN: stubSoot({}), LOOP_SOOT_CONFIG: join(tmp, 'd.json') }]) {
    const w = mk(env);
    const out = await w.call('health_sync', { inputs: [{ key: 'tiktok', label: 'TikTok', starving: true, detail: 'chưa có số TikTok' }] });
    assert.equal(out.runtime, false);
    const h = ((await w.call('page_view', {}, { page: { page: 'company' } })).output ?? {}).health ?? (await w.call('page_view', {}, { page: { page: 'company' } })).health;
    assert.ok(h.runtime.reason);
    assert.ok(h.stages.find(s => s.key === 'marketing').starving.some(i => i.key === 'tiktok'));
  }
});

test('page_view names every outcome key an opportunity is measured by', async () => {
  const w = mk({});
  const v = await w.call('page_view', {}, { page: { page: 'company' } });
  const labels = (v.output ?? v).metric_labels;
  assert.equal(labels.support_threads_new, 'Hỗ trợ mới');
  assert.equal(labels.waiting_human, 'Bạn đọc chờ người');
  assert.ok(Object.values(labels).every(l => !/_/.test(l)), 'no raw key reaches the page');
});
