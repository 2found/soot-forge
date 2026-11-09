// F4: the build leg proven end to end with a fake bbs: proposed -> Go -> spawned | draft_ready -> building -> delivered ->
// released. The requirement never lands in the product working tree; a draft_ready handoff is watched and reminded once.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { world, ITEM, DAY } from './world.mjs';
import { startBoardApi, fakeBbs, scratchRepo, KEY } from './fixtures.mjs';
import { NUDGE_AFTER_MS } from '../tools/lib/watch.mjs';

const api = await startBoardApi();
after(() => api.close());

async function ready({ bbs = true } = {}) {
  const b = fakeBbs();
  const dir = scratchRepo();
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, BBS_BIN: bbs ? b.bin : '/nonexistent/bbs', PRODUCT_REPO: dir } });
  await w.call('scoreboard_sync');
  return { w, b, dir };
}
const phase = (id, state, release = 'auto') => ({ id, title: id, release, state });
const gitStatus = dir => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });

test('walk: proposed -> Go -> spawned -> building -> delivered -> released, repo untouched, next step stated', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const opp = w.rows('opportunities')[0];
  assert.equal(opp.state, 'proposed');
  const out = await w.call('page_action', { op: 'go', id: opp.ref, request_id: 'req-aaaaaaaa' }, { page: { page: 'cong-ty' } });
  assert.equal(out.handoff.state, 'spawned');
  assert.equal(gitStatus(dir), '', 'the founder working tree is clean after a Go');
  assert.ok(!existsSync(`${dir}/docs/requirements`));
  assert.ok(existsSync(out.handoff.requirement_path) && out.handoff.requirement_path.startsWith(w.env.BABYSIT_HOME));
  assert.match(out.handoff.note, /terminal Orca của đội/);
  assert.match(out.handoff.note, /không làm ở Nest/);
  // The team starts: its kickoff creates the parent ticket.
  const team = out.handoff.team_id;
  b.tickets([{ id: 'bs-parent01', assignee: team, parent: '', title: 'the project' }]);
  b.snapshot({ phases: [phase('p1', 'building')] });
  assert.equal((await w.call('team_watch')).changed[0].state, 'building');
  b.snapshot({ phases: [phase('p1', 'delivered', 'ask')] });
  const delivered = await w.call('team_watch');
  assert.equal(delivered.changed[0].state, 'delivered');
  assert.match(delivered.raise[0].why, /bbs ticket approval resolve --action approve/);
  b.snapshot({ phases: [phase('p1', 'released', 'ask')] });
  const done = await w.call('team_watch');
  assert.deepEqual([done.changed[0].state, done.outcomes[0].id], ['released', 'requirement_shipped']);
  assert.equal(w.rows('handoffs')[0].state, 'released');
  assert.equal(gitStatus(dir), '');
});

test('bbs missing: draft_ready is watched, reminded once after the wait, and advances when the founder ran the command', async () => {
  const { w, b } = await ready({ bbs: false });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  const out = await w.call('page_action', { op: 'go', id: ref, request_id: 'req-bbbbbbbb' }, { page: { page: 'cong-ty' } });
  assert.equal(out.handoff.state, 'draft_ready');
  assert.match(out.handoff.note, /theo dõi/);
  // Soon after the Go: quiet (the founder may be about to run it), and the row is still draft_ready.
  assert.deepEqual(await w.call('team_watch'), { done: true });
  assert.equal(w.rows('handoffs')[0].state, 'draft_ready');
  // Past the wait: ONE reminder carrying the command, even though bbs is not on this machine.
  w.now += NUDGE_AFTER_MS + 60_000;
  const remind = await w.call('team_watch');
  assert.equal(remind.raise[0].id, `company:unstarted:${ref}`);
  assert.ok(remind.raise[0].why.includes(w.rows('handoffs')[0].command));
  assert.deepEqual([remind.notify, remind.wake], [false, false], 'the host files the card; no model');
  w.now += 30 * 60_000;
  const again = await w.call('team_watch');
  assert.deepEqual(again.raise.map(c => c.id), [`company:unstarted:${ref}`], 'the same card id: the host files it once');
  // The founder runs the command: bbs is there, the team's ticket exists, the row moves on by itself.
  w.env.BBS_BIN = b.bin;
  b.tickets([{ id: 'bs-parent02', assignee: w.rows('handoffs')[0].team_id, parent: '', title: 'the project' }]);
  b.snapshot({ phases: [phase('p1', 'building')] });
  const moved = await w.call('team_watch');
  assert.deepEqual(moved.changed, [{ ref, state: 'building' }]);
  assert.ok(moved.settle.includes(`company:unstarted:${ref}`), 'the reminder card is settled once the team exists');
  assert.equal(w.rows('handoffs')[0].ticket, 'bs-parent02');
});

test('bbs present but no ticket yet for a draft_ready row: still watched, other handoffs keep being read', async () => {
  const { w, b } = await ready();
  b.failSpawn(true);
  await w.call('digest_save', { opportunities: [ITEM.product, { ...ITEM.product, title: 'Gợi ý đọc tiếp theo thể loại' }] });
  const [one, two] = w.rows('opportunities').map(o => o.ref);
  await w.call('decide', { id: one, decision: 'go' });
  b.failSpawn(false);
  await w.call('decide', { id: two, decision: 'go' });
  assert.deepEqual(w.rows('handoffs').map(h => h.state), ['draft_ready', 'spawned']);
  b.tickets([{ id: 'bs-parent03', assignee: w.rows('handoffs')[1].team_id, parent: '', title: 'p' }]);
  b.snapshot({ phases: [phase('p1', 'building')] });
  const out = await w.call('team_watch');
  assert.deepEqual(out.changed, [{ ref: two, state: 'building' }]);
  assert.equal(w.rows('handoffs')[0].state, 'draft_ready', 'the unstarted one stays and waits');
});

test('no ticket home: the Go says why instead of falling back to the product tree', async () => {
  const { w, dir } = await ready();
  delete w.env.BABYSIT_HOME; w.env.HOME = '';
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const out = await w.call('decide', { id: w.rows('opportunities')[0].ref, decision: 'go' });
  assert.equal(out.handoff.state, 'no_repo');
  assert.match(out.handoff.note, /BABYSIT_HOME/);
  assert.equal(gitStatus(dir), '');
});
