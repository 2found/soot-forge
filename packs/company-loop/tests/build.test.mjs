// The product handoff split across runtimes: the server records a Go as an approved handoff that carries the requirement
// (no repo write, no spawn); the runtime with the repo pulls it (builds_pull), starts the team as a local Go does, watches it
// from its own `builds` table and reports through the insight team's handoff_events queue; the server folds the events back
// (handoff_events_apply). The `soot` CLI is a stub (data query / insert against a file), `bbs` the usual fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, ITEM, DAY } from './world.mjs';
import { fakeBbs, scratchRepo } from './fixtures.mjs';

const TOKEN = 'srt_build-call-token-not-a-secret';
const RUNTIME = 'http://127.0.0.1:7788';

/** A `soot` stub: `data query` prints query.json, `data insert` appends its --row to inserts (fails while the file `fail-insert` exists); every argv is logged. */
function stubSoot() {
  const dir = mkdtempSync(join(tmpdir(), 'cl-build-soot-'));
  const bin = join(dir, 'soot');
  writeFileSync(join(dir, 'query.json'), JSON.stringify({ rows: [] }));
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)}, a = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'log'), JSON.stringify({ argv: a, token: process.env.SOOT_RUNTIME_TOKEN === ${JSON.stringify(TOKEN)}, url: process.env.SOOT_RUNTIME_URL }) + '\\n');
if (a[0] === 'data' && a[1] === 'query') { if (fs.existsSync(path.join(dir, 'fail-query'))) { console.error('data.read not granted'); process.exit(1); } process.stdout.write(fs.readFileSync(path.join(dir, 'query.json'), 'utf8')); process.exit(0); }
if (a[0] === 'data' && a[1] === 'insert') { if (fs.existsSync(path.join(dir, 'fail-insert'))) { console.error('queue unreachable'); process.exit(1); } fs.appendFileSync(path.join(dir, 'inserts'), a[a.indexOf('--row') + 1] + '\\n'); console.log('{"id":"r1"}'); process.exit(0); }
process.exit(1);
`);
  chmodSync(bin, 0o755);
  const lines = f => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : []);
  return {
    bin, rows: rows => writeFileSync(join(dir, 'query.json'), JSON.stringify({ rows })),
    flag: (name, on) => (on ? writeFileSync(join(dir, name), '') : rmSync(join(dir, name), { force: true })),
    calls: () => lines('log').map(l => JSON.parse(l)), inserts: () => lines('inserts').map(l => JSON.parse(l)),
  };
}

/** The server: no repo, decides and folds. */
async function server(extra = {}) {
  const w = world({ env: extra });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  return { w, ref, go: () => w.call('page_action', { op: 'go', id: ref, request_id: 'req-build0001' }, { page: { page: 'cong-ty' } }) };
}
/** The Mac: repo + bbs + soot with a runtime token. */
function mac(over = {}) {
  const b = fakeBbs(), cli = stubSoot(), repo = scratchRepo();
  const w = world({ env: { PRODUCT_REPO: repo, BBS_BIN: b.bin, LOOP_SOOT_BIN: cli.bin, SOOT_RUNTIME_URL: RUNTIME, SOOT_RUNTIME_TOKEN: TOKEN, ...over } });
  return { w, b, cli, repo };
}
const approvedRow = async s => { await s.go(); return { ...s.w.rows('handoffs')[0] }; };
const phase = (id, state, release = 'auto') => ({ id, title: id, release, state });

test('server: a product Go records an approved handoff with requirement, product and target outcome, and writes and spawns nothing', async () => {
  const s = await server({ BBS_BIN: fakeBbs().bin });
  const out = await s.go();
  assert.equal(out.handoff.state, 'approved');
  const h = s.w.rows('handoffs')[0];
  assert.equal(h.state, 'approved');
  assert.deepEqual([h.product, h.target_outcome, h.opportunity, h.repo], ['lohi', 'support_handoffs', s.ref, null]);
  assert.match(h.requirement, new RegExp(`^# REQ-${s.ref}: Hoàn tiền tự động`));
  assert.match(h.requirement, /approved by the founder with Go/);
  assert.ok(!existsSync(join(s.w.env.BABYSIT_HOME, 'requirements')), 'no requirement file on the server');
  assert.equal(s.w.rows('decisions').filter(d => d.decision === 'go').length, 1);
});

test('a run of another product (SOOT_PRODUCT) cannot file or decide this product\'s work, and its repo is never used for it', async () => {
  const b = fakeBbs(), repo = scratchRepo();
  const s = await server({ PRODUCT_REPO: repo, BBS_BIN: b.bin });
  s.w.env.SOOT_PRODUCT = '2novel';
  await assert.rejects(s.w.call('digest_save', { opportunities: [{ ...ITEM.product, title: 'Một cơ hội khác của lohi' }] }), /không phải 2novel/);
  await assert.rejects(s.w.call('decide', { id: s.ref, decision: 'go' }), /thuộc sản phẩm lohi, không phải 2novel/);
  assert.equal(b.calls().length, 0);
  assert.ok(!existsSync(join(s.w.env.BABYSIT_HOME, 'requirements')));
});

test('single runtime with a repo: a Go still spawns directly and team_watch owns the lifecycle (nothing goes through events)', async () => {
  const b = fakeBbs(), repo = scratchRepo();
  const s = await server({ PRODUCT_REPO: repo, BBS_BIN: b.bin });
  assert.equal((await s.go()).handoff.state, 'spawned');
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 1);
  b.tickets([{ id: 'bs-p1', assignee: s.w.rows('handoffs')[0].team_id, parent: '' }]);
  b.snapshot({ phases: [phase('p1', 'released', 'ask')] });
  const done = await s.w.call('team_watch');
  assert.equal(done.outcomes[0].id, 'requirement_shipped');
  assert.equal(s.w.rows('builds').length, 0);
  assert.equal(s.w.rows('handoff_events').length, 0);
});

test('builds_pull: starts the approved handoff like a local Go, keeps a builds row, reports started, and never pulls it twice', async () => {
  const s = await server();
  const row = await approvedRow(s);
  const m = mac();
  m.cli.rows([row]);
  const out = await m.w.call('builds_pull');
  assert.deepEqual(out.started, [{ handoff: s.ref, state: 'spawned' }]);
  // The query is the insight team's handoffs item, filtered to approved, through the call's own token.
  const q = m.cli.calls().find(c => c.argv[1] === 'query');
  assert.deepEqual(q.argv.slice(0, 9), ['data', 'query', '--team', 'insight', '--item', 'handoffs', '--filter', '{"state":"approved"}', '--limit']);
  assert.ok(m.cli.calls().every(c => c.token && c.url === RUNTIME));
  // The requirement is the server's text, written beside the tickets (not in the repo), and the team spawned once.
  const req = join(m.w.env.BABYSIT_HOME, 'requirements', m.repo.split('/').pop(), `REQ-${s.ref}.md`);
  assert.equal(readFileSync(req, 'utf8'), row.requirement);
  assert.equal(m.b.calls().filter(c => c.argv[1] === 'spawn').length, 1);
  const build = m.w.rows('builds')[0];
  assert.deepEqual([build.handoff, build.state, build.product, build.team_id, build.pushed], [s.ref, 'spawned', 'lohi', `loop-${s.ref.toLowerCase()}`, 'started']);
  assert.match(build.title, /Hoàn tiền tự động/);
  assert.deepEqual(m.cli.inserts().map(r => [r.handoff, r.state, r.team_id, r.product]), [[s.ref, 'started', build.team_id, 'lohi']]);
  const ins = m.cli.calls().find(c => c.argv[1] === 'insert');
  assert.deepEqual(ins.argv.slice(0, 6), ['data', 'insert', '--team', 'insight', '--queue', 'handoff_events']);
  // No second approval, no second spawn.
  const again = await m.w.call('builds_pull');
  assert.equal(again.done, true);
  assert.equal(m.b.calls().filter(c => c.argv[1] === 'spawn').length, 1);
  assert.equal(m.cli.inserts().length, 1);
});

test('builds_pull: INSIGHT_TEAM and the product filter reach the query; another product\'s row is never built here', async () => {
  const s = await server();
  const row = await approvedRow(s);
  const m = mac({ SOOT_PRODUCT: '2novel', INSIGHT_TEAM: 'insights' });
  m.cli.rows([row, { ...row, opportunity: 'OP-0000BEEF', product: '2novel' }]);
  const out = await m.w.call('builds_pull');
  const q = m.cli.calls().find(c => c.argv[1] === 'query');
  assert.equal(q.argv[3], 'insights');
  assert.equal(q.argv[7], '{"state":"approved","product":"2novel"}');
  assert.deepEqual(out.skipped.map(x => x.why), ['other_product']);
  assert.deepEqual(out.started.map(x => x.handoff), ['OP-0000BEEF'], 'the 2novel row has no usable requirement, so only the lohi row is excluded here');
});

test('builds_pull: refusals are quiet and spawn nothing (no repo, no token, no soot, unreadable data, a malformed row)', async () => {
  const s = await server();
  const row = await approvedRow(s);
  // No PRODUCT_REPO: this is the server.
  const server2 = world({ env: { LOOP_SOOT_BIN: stubSoot().bin, SOOT_RUNTIME_URL: RUNTIME, SOOT_RUNTIME_TOKEN: TOKEN } });
  assert.deepEqual([(await server2.call('builds_pull')).skipped, (await server2.call('builds_pull')).key], [true, 'PRODUCT_REPO']);
  // No runtime token: the grant is missing.
  const m = mac({ SOOT_RUNTIME_TOKEN: '' });
  m.cli.rows([row]);
  const noToken = await m.w.call('builds_pull');
  assert.deepEqual([noToken.skipped, noToken.reason_code, noToken.reason], [true, 'handoffs_unreadable', 'no_runtime_token']);
  assert.equal(m.cli.calls().length, 0);
  // No soot binary.
  const noSoot = mac({ LOOP_SOOT_BIN: '/nonexistent/soot' });
  assert.equal((await noSoot.w.call('builds_pull')).reason, 'no_soot');
  // data.read refused by the runtime.
  const m2 = mac();
  m2.cli.flag('fail-query', true);
  const bad = await m2.w.call('builds_pull');
  assert.deepEqual([bad.skipped, bad.reason, bad.notify], [true, 'data_failed', false]);
  assert.match(bad.detail, /data\.read not granted/);
  assert.equal(m2.b.calls().length, 0);
  // Malformed rows: a key that is not a ref, a requirement that is not ours, a row that is not approved.
  const m3 = mac();
  m3.cli.rows([{ ...row, opportunity: '../../etc' }, { ...row, requirement: 'rm -rf /' }, { ...row, state: 'spawned' }]);
  const out = await m3.w.call('builds_pull');
  assert.deepEqual(out.skipped.map(x => x.why), ['bad_key', 'bad_requirement', 'not_approved']);
  assert.equal(m3.b.calls().length, 0);
  assert.equal(m3.w.rows('builds').length, 0);
  assert.ok(!existsSync(join(m3.w.env.BABYSIT_HOME, 'requirements')));
});

test('builds_pull: bbs absent is draft_ready (no event yet, retried by the reminder); an unwritable repo is the one loud answer and is retried', async () => {
  const s = await server();
  const row = await approvedRow(s);
  const noBbs = mac({ BBS_BIN: '/nonexistent/bbs' });
  noBbs.cli.rows([row]);
  const out = await noBbs.w.call('builds_pull');
  assert.deepEqual(out.started, [{ handoff: s.ref, state: 'draft_ready' }]);
  assert.equal(noBbs.cli.inserts().length, 0, 'the team does not exist: nothing to report');
  assert.match(noBbs.w.rows('builds')[0].command, /bbs team spawn/);
  // A repo that is not a directory.
  const m = mac({ PRODUCT_REPO: '/nonexistent/repo' });
  m.cli.rows([row]);
  const loud = await m.w.call('builds_pull');
  assert.deepEqual([loud.failed[0].why, loud.notify], ['no_repo', true]);
  assert.equal(m.w.rows('builds')[0].state, 'no_repo');
  // Fixing the repo: the next pull starts it (a no_repo build is not "already pulled").
  m.w.env.PRODUCT_REPO = scratchRepo();
  const fixed = await m.w.call('builds_pull');
  assert.equal(fixed.started[0].state, 'spawned');
  assert.equal(m.w.rows('builds').length, 1);
});

test('team_watch on the Mac works from builds and reports progress, handover and shipped events; it records no outcome or topic', async () => {
  const s = await server();
  const row = await approvedRow(s);
  const m = mac();
  m.cli.rows([row]);
  await m.w.call('builds_pull');
  const team = m.w.rows('builds')[0].team_id;
  m.b.tickets([{ id: 'bs-parent01', assignee: team, parent: '', title: 'p' }]);
  m.b.snapshot({ phases: [phase('p1', 'building'), phase('p2', 'planned')] });
  const building = await m.w.call('team_watch');
  assert.deepEqual(building.changed, [{ ref: s.ref, state: 'building' }]);
  m.b.snapshot({ phases: [phase('p1', 'delivered', 'ask')] });
  const handover = await m.w.call('team_watch');
  assert.match(handover.raise[0].id, new RegExp(`^company:handover:${s.ref}:`));
  m.b.snapshot({ phases: [phase('p1', 'released', 'ask')] });
  const shipped = await m.w.call('team_watch');
  assert.equal(shipped.outcomes, undefined, 'the outcome is recorded on the server when the event is folded');
  assert.deepEqual(m.cli.inserts().map(r => r.state), ['started', 'progress', 'handover', 'shipped']);
  assert.equal(m.w.rows('topics').length, 0);
  assert.equal(m.w.rows('builds')[0].state, 'released');
  // A quiet tick sends nothing more.
  assert.deepEqual(await m.w.call('team_watch'), { done: true });
  assert.equal(m.cli.inserts().length, 4);
  // The server folds the same events.
  for (const r of m.cli.inserts()) await s.w.store.insert('handoff_events', r);
  const applied = await s.w.call('handoff_events_apply');
  assert.deepEqual(applied.outcomes.map(o => o.id), ['requirement_shipped']);
  const h = s.w.rows('handoffs')[0];
  assert.deepEqual([h.state, h.team_id], ['released', team]);
  assert.ok(h.released_at);
  assert.deepEqual(s.w.rows('topics').map(t => [t.kind, t.opportunity_ref]), [['launch', s.ref]]);
});

test('an event that could not be sent stays unsent and goes out on the next team_watch', async () => {
  const s = await server();
  const row = await approvedRow(s);
  const m = mac();
  m.cli.rows([row]);
  m.cli.flag('fail-insert', true);
  await m.w.call('builds_pull');
  assert.equal(m.w.rows('builds')[0].state, 'spawned');
  assert.equal(m.w.rows('builds')[0].pushed, null, 'not reported yet');
  const stuck = await m.w.call('team_watch');
  assert.deepEqual(stuck.events, { sent: 0, unsent: 1 });
  m.cli.flag('fail-insert', false);
  const sent = await m.w.call('team_watch');
  assert.deepEqual(sent.events, { sent: 1, unsent: 0 });
  assert.deepEqual(m.cli.inserts().map(r => r.state), ['started']);
});

test('handoff_events_apply folds in order, never goes backwards, treats released as final, skips strangers and replays safely', async () => {
  const s = await server();
  await s.go();
  const ev = (state, extra = {}) => s.w.store.insert('handoff_events', { handoff: s.ref, state, team_id: 'loop-x', at: new Date(s.w.now).toISOString(), ...extra });
  await ev('started');
  await ev('progress', { note: 'Xong 1/3 giai đoạn.' });
  await s.w.store.insert('handoff_events', { handoff: 'OP-FFFFFFFF', state: 'started' });
  await s.w.store.insert('handoff_events', { handoff: s.ref, state: 'exploded' });
  await s.w.store.insert('handoff_events', { handoff: s.ref, state: 'started', product: 'someone-else' });
  const first = await s.w.call('handoff_events_apply');
  assert.deepEqual(first.changed.map(c => c.state), ['spawned', 'building']);
  assert.deepEqual(first.skipped.map(x => x.why).sort(), ['bad_state', 'other_product', 'unknown_handoff']);
  assert.equal(first.notify, false);
  assert.equal(s.w.rows('handoffs')[0].detail, 'Xong 1/3 giai đoạn.');
  // A late `started` does not pull a building handoff back; a replay changes nothing.
  await ev('started');
  assert.equal((await s.w.call('handoff_events_apply')).done, true);
  assert.equal(s.w.rows('handoffs')[0].state, 'building');
  await ev('failed', { note: 'release_failed p1' });
  await s.w.call('handoff_events_apply');
  const h = () => s.w.rows('handoffs')[0];
  assert.deepEqual([h().state, h().detail], ['blocked', 'Đội dựng báo lỗi: release_failed p1']);
  s.w.now += DAY;
  await ev('shipped');
  const shipped = await s.w.call('handoff_events_apply');
  assert.deepEqual([shipped.changed[0].state, shipped.notify, shipped.outcomes.length], ['released', true, 1]);
  await ev('progress');
  await ev('shipped');
  assert.equal((await s.w.call('handoff_events_apply')).done, true, 'released is final');
  assert.equal(h().state, 'released');
  assert.equal(s.w.rows('topics').filter(t => t.kind === 'launch').length, 1);
});

test('a folded handoff has no repo of its own: a local team_watch on the server never reads it with bbs', async () => {
  const s = await server();
  await s.go();
  await s.w.store.insert('handoff_events', { handoff: s.ref, state: 'started', team_id: 'loop-x' });
  await s.w.call('handoff_events_apply');
  s.w.env.BBS_BIN = fakeBbs().bin;
  assert.equal(s.w.rows('handoffs')[0].state, 'spawned');
  assert.deepEqual(await s.w.call('team_watch'), { done: true });
  assert.equal(s.w.rows('handoffs')[0].state, 'spawned');
});
