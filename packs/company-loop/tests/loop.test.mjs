// The loop end to end in tests: digest_save (CL1.2), decide (Go / Để sau / Bỏ and the CL4.3 log), the
// requirement + bbs team handoff (CL2), team_watch (released -> outcome + launch topic), topic_next and
// review (hit rate, §7).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, ITEM, T0, DAY } from './world.mjs';
import { startBoardApi, fakeBbs, scratchRepo, KEY } from './fixtures.mjs';
import { isHit, hitRate } from '../tools/lib/review.mjs';

const api = await startBoardApi();
after(() => api.close());

/** A world with a scoreboard already read, a scratch repo and a fake bbs. */
async function ready({ bbs = true, repo = true } = {}) {
  const b = fakeBbs();
  const dir = scratchRepo();
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, BBS_BIN: bbs ? b.bin : '/nonexistent/bbs', ...(repo ? { PRODUCT_REPO: dir } : {}) } });
  await w.call('scoreboard_sync');
  return { w, b, dir };
}
const refOf = (w, kind) => w.rows('opportunities').find(o => o.kind === kind).ref;

// ---------- digest_save ----------
test('digest_save refuses an item without target_outcome, and saves nothing (all or none)', async () => {
  const { w } = await ready();
  const { target_outcome, ...noTarget } = ITEM.product;
  await assert.rejects(w.call('digest_save', { opportunities: [ITEM.content, noTarget] }), /#2 target_outcome/);
  assert.equal(w.rows('opportunities').length, 0);
  assert.equal(w.rows('topics').length, 0);
  assert.equal(w.rows('decisions').length, 0);
});

test('digest_save checks CL1.2 per item: kind, evidence, delta, days, a Vietnamese query for content, a summary for product', async () => {
  const { w } = await ready();
  const bad = [
    { ...ITEM.content, kind: 'ads' }, { ...ITEM.content, evidence_refs: [] }, { ...ITEM.content, expected_delta: 0 },
    { ...ITEM.content, check_after_days: 0 }, { ...ITEM.content, confidence: 2 }, { ...ITEM.content, query: 'một' }, { ...ITEM.content, query: undefined },
    { ...ITEM.product, summary: 'ngắn' }, { ...ITEM.product, target_outcome: 'Signups!' }, { ...ITEM.product, signal_count: 0 },
  ];
  for (const item of bad) await assert.rejects(w.call('digest_save', { opportunities: [item] }), /Chưa lưu cơ hội nào/, JSON.stringify(item).slice(0, 80));
  await assert.rejects(w.call('digest_save', { opportunities: [] }), /1–5/);
  await assert.rejects(w.call('digest_save', { opportunities: Array(6).fill(ITEM.content) }), /1–5/);
  await assert.rejects(w.call('digest_save', { opportunities: [ITEM.content, ITEM.content] }), /trùng nhau/);
  assert.equal(w.rows('opportunities').length, 0);
});

test('content opportunities go by themselves (decision by soot) and queue a topic; product ones wait with one Cần bạn ask', async () => {
  const { w } = await ready();
  const out = await w.call('digest_save', { opportunities: [ITEM.content, ITEM.product] });
  assert.deepEqual(out.saved.map(s => [s.kind, s.state]), [['content', 'go'], ['product', 'proposed']]);
  assert.deepEqual(out.outcomes, [{ id: 'opportunity_found', count: 2, ref: 'digest:2026-11-09' }]);
  // The content item is a queued topic and a logged decision with the scoreboard value as baseline.
  assert.deepEqual(w.rows('topics').map(t => [t.query, t.kind, t.state, t.opportunity_ref]), [['truyện tiên hiệp full', 'content', 'queued', refOf(w, 'content')]]);
  const d = w.rows('decisions');
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].decision, d[0].by, d[0].stage, d[0].baseline_value, d[0].target_outcome, d[0].expected_delta, d[0].check_after_days, d[0].actual_delta], ['go', 'soot', 'digest', 120, 'signups', 20, 7, null]);
  assert.deepEqual(d[0].evidence_refs, ITEM.content.evidence_refs);
  // The product one is only proposed: no requirement, no handoff, no decision, no spawn.
  assert.equal(w.rows('opportunities').find(o => o.kind === 'product').state, 'proposed');
  assert.equal(w.rows('handoffs').length, 0);
  // One card for N waiting.
  assert.equal(out.waiting, 1);
  assert.equal(out.ask.summary, '1 cơ hội chờ bạn chọn');
  assert.match(out.ask.keys[0], /^company:proposals:/);
  assert.match(out.ask.missing, /trang Công ty/);
  assert.match(out.ask.missing, /^nest:\/\/page\/cong-ty$/m, 'the card opens the page');
  assert.ok(out.ask.options.length >= 1);
  // The same waiting set is not asked twice.
  const again = await w.call('digest_save', { opportunities: [ITEM.product] });
  assert.equal(again.ask, undefined);
  assert.equal(w.rows('opportunities').length, 2, 'the same title is the same opportunity');
  assert.equal(again.outcomes, undefined);
});

test('a dropped or already-Go opportunity is not proposed again; one set aside returns to the founder', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'later' });
  const back = await w.call('digest_save', { opportunities: [ITEM.product] });
  assert.equal(back.saved[0].state, 'proposed');
  await w.call('decide', { id: ref, decision: 'drop' });
  const skipped = await w.call('digest_save', { opportunities: [ITEM.product] });
  assert.deepEqual(skipped.skipped.map(s => [s.ref, s.why]), [[ref, 'đã Bỏ']]);
  assert.equal(skipped.saved.length, 0);
});

// ---------- decide ----------
test('decide later and drop log the decision; a decided Go cannot be undone; unknown ids are refused', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await assert.rejects(w.call('decide', { id: 'OP-DEADBEEF', decision: 'go' }), /Không có cơ hội/);
  await assert.rejects(w.call('decide', { id: ref, decision: 'maybe' }), /go, later hoặc drop/);
  await w.call('decide', { id: ref, decision: 'later', note: 'quý sau' });
  assert.deepEqual(w.rows('decisions').map(d => [d.decision, d.by, d.stage, d.note]), [['later', 'operator', 'gate', 'quý sau']]);
  assert.equal((await w.call('decide', { id: ref, decision: 'later' })).already, true);
  assert.equal(w.rows('decisions').length, 1, 'repeating a decision logs nothing new');
});

test('a product Go writes REQ-<id>.md in the shape bbs:team expects and spawns a team with --auto, nothing else', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('page_action', { op: 'go', id: ref, request_id: 'req-12345678' }, { page: { page: 'cong-ty' } });
  assert.equal(out.handoff.state, 'spawned');
  assert.equal(out.handoff.team_id, `loop-${ref.toLowerCase()}`);
  const path = join(dir, 'docs', 'requirements', `REQ-${ref}.md`);
  assert.equal(out.handoff.requirement_path, path);
  const text = readFileSync(path, 'utf8');
  for (const heading of ['## Outcome', '## Audience', '## Scope', '## Non-goals', '## Constraints', '## Acceptance criteria', '## Evidence']) assert.ok(text.includes(heading), heading);
  assert.match(text, /Target outcome: `support_handoffs`, expected change -3 within 30 days of release \(baseline when approved: 7\)/);
  assert.match(text, /- reason:refund/);
  assert.match(text, /founder's go at handover|founder's go/);
  assert.match(text, /approved by the founder with Go/);
  const spawn = b.calls().filter(c => c.argv[1] === 'spawn');
  assert.equal(spawn.length, 1);
  const argv = spawn[0].argv;
  assert.deepEqual(argv.slice(0, 7), ['team', 'spawn', `loop-${ref.toLowerCase()}`, '--dir', dir, '--auto', '--command']);
  assert.match(argv[7], new RegExp(`^claude '/bbs:team --team-id loop-${ref.toLowerCase()} --auto ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`));
  assert.ok(spawn[0].cwd.endsWith(dir.split('/').pop()) || existsSync(spawn[0].cwd));
  // Never land / release / integrate / seal.
  const all = b.calls().flatMap(c => c.argv);
  for (const verb of ['land', 'release', 'integrate', 'seal']) assert.ok(!all.includes(verb), verb);
  // The decision is the founder's, with the metric value as baseline; Go twice does nothing more.
  assert.deepEqual(w.rows('decisions').map(d => [d.decision, d.by, d.stage, d.baseline_value]), [['go', 'founder', 'gate', 7]]);
  const h = w.rows('handoffs')[0];
  assert.deepEqual([h.state, h.opportunity, h.repo], ['spawned', ref, dir]);
  assert.equal((await w.call('decide', { id: ref, decision: 'go' })).already, true);
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 1);
});

test('an existing requirement file (maybe edited by the founder) is never overwritten', async () => {
  const { w, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'requirements', `REQ-${ref}.md`), 'EDITED BY A PERSON\n');
  await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(readFileSync(join(dir, 'docs', 'requirements', `REQ-${ref}.md`), 'utf8'), 'EDITED BY A PERSON\n');
});

test('a product Go with bbs absent is draft_ready with the exact command, never a silent drop', async () => {
  const { w, dir } = await ready({ bbs: false });
  w.env.PATH = '/nonexistent';
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(out.handoff.state, 'draft_ready');
  assert.match(out.handoff.command, new RegExp(`^cd '${dir}' && bbs team spawn loop-${ref.toLowerCase()} --dir '${dir}' --auto --command `));
  assert.match(out.handoff.command, /\/bbs:team --team-id/);
  assert.ok(existsSync(join(dir, 'docs', 'requirements', `REQ-${ref}.md`)), 'the requirement is still written');
  assert.equal(w.rows('opportunities').find(o => o.ref === ref).state, 'go');
  assert.match(out.handoff.note, /chưa có bbs/);
  // The page offers the command and a retry; the next step names what to do.
  const view = await w.call('page_view', {}, { page: { page: 'cong-ty' } });
  assert.equal(view.next.code, 'draft_ready');
  assert.equal(view.handoffs[0].command, out.handoff.command);
});

test('a spawn that fails (Orca not running) is draft_ready with the reason; Chạy lại spawns once it works', async () => {
  const { w, b } = await ready();
  b.failSpawn(true);
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(out.handoff.state, 'draft_ready');
  assert.match(out.handoff.note, /orca: not running/);
  b.failSpawn(false);
  const retry = await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: 'req-87654321' }, { page: { page: 'cong-ty' } });
  assert.equal(retry.handoff.state, 'spawned');
  assert.equal(w.rows('handoffs').length, 1, 'one handoff per opportunity');
});

test('a product Go with no PRODUCT_REPO says so (no_repo) and spawns nothing', async () => {
  const { w, b } = await ready({ repo: false });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const out = await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  assert.equal(out.handoff.state, 'no_repo');
  assert.match(out.handoff.note, /PRODUCT_REPO/);
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 0);
  assert.equal((await w.call('page_view', {}, { page: { page: 'cong-ty' } })).next.code, 'no_repo');
});

test('the decide tool needs the operator approval; the model tool list of the Lead never includes it', async () => {
  const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
  assert.equal(pack.tools.find(t => t.name === 'decide').run.approval, 'operator');
  assert.equal(pack.tools.find(t => t.name === 'page_action').run.approval, undefined, 'a page is never approval-gated: the operator-only page is the approval');
  assert.equal(pack.interface.pages[0].access, 'operator');
});

// ---------- topic_next ----------
test('topic_next gives the oldest queued topic once, marks it taken, and answers {} when none', async () => {
  const { w } = await ready();
  assert.deepEqual(await w.call('topic_next'), {});
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, title: 'Truyện ngôn tình hay', query: 'truyện ngôn tình hay' }] });
  const first = await w.call('topic_next');
  assert.deepEqual(first, { query: 'truyện tiên hiệp full', reason: ITEM.content.title, opportunity_ref: refOf(w, 'content') });
  assert.equal((await w.call('topic_next')).query, 'truyện ngôn tình hay');
  assert.deepEqual(await w.call('topic_next'), {});
  assert.deepEqual(w.rows('topics').map(t => t.state), ['taken', 'taken']);
});

test('in a chain topic_next is only the query (it merges into marketing plan) and at most one a day', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, title: 'Truyện ngôn tình hay', query: 'truyện ngôn tình hay' }] });
  assert.deepEqual(await w.call('topic_next', { chain: true }), { query: 'truyện tiên hiệp full' });
  assert.deepEqual(await w.call('topic_next', { chain: true }), {}, 'a second topic waits for the first to be written');
  w.now += 21 * 3_600_000;
  assert.deepEqual(await w.call('topic_next', { chain: true }), { query: 'truyện ngôn tình hay' });
});

// ---------- team_watch ----------
const phase = (id, state, release = 'auto') => ({ id, title: id, release, state });
/** What `bbs ticket find --json` lists once the kickoff created the parent ticket (assignee = the team id). */
const kickoff = (w, b, id = 'bs-parent01') => b.tickets([
  { id: 'bs-other0001', assignee: null, parent: '', title: 'unrelated' },
  { id: 'bs-child0001', assignee: w.rows('handoffs')[0].team_id, parent: id, title: 'child of the project' },
  { id, assignee: w.rows('handoffs')[0].team_id, parent: '', title: 'the project' },
]);

test('team_watch: nothing open, or nothing changed, is {done: true}; a snapshot that cannot be read changes nothing', async () => {
  const { w, b } = await ready();
  assert.deepEqual(await w.call('team_watch'), { done: true });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  kickoff(w, b);
  b.failSnapshot(true);
  assert.deepEqual(await w.call('team_watch'), { done: true });
  assert.match(w.rows('handoffs')[0].detail, /Chưa đọc được trạng thái đội/);
  assert.equal(w.rows('handoffs')[0].state, 'spawned');
  b.failSnapshot(false);
  const first = await w.call('team_watch');
  assert.deepEqual(first.changed, [{ ref: refOf(w, 'product'), state: 'building' }]);
  assert.equal(first.notify, false, 'progress alone never wakes a model');
  assert.deepEqual(await w.call('team_watch'), { done: true });
});

test('team_watch: delivered waits for the founder; released records requirement_shipped and queues one launch topic', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  kickoff(w, b);
  b.snapshot({ phases: [phase('p1', 'released'), phase('p2', 'building')] });
  assert.match((await w.call('team_watch')).changed[0].state, /building/);
  assert.equal(w.rows('handoffs')[0].detail, 'Xong 1/2 giai đoạn.');
  b.snapshot({ phases: [phase('p1', 'delivered', 'none'), phase('p2', 'delivered', 'none')] });
  const delivered = await w.call('team_watch');
  assert.deepEqual([delivered.changed[0].state, delivered.outcomes, delivered.notify], ['delivered', undefined, false]);
  assert.equal((await w.call('page_view', {}, { page: 'cong-ty' })).next.code, 'release_go');
  assert.equal(w.rows('topics').length, 0);
  b.snapshot({ phases: [phase('p1', 'delivered', 'none'), phase('p2', 'released')] });
  w.now += 3_600_000;
  const out = await w.call('team_watch');
  assert.deepEqual(out.outcomes, [{ id: 'requirement_shipped', count: 1, ref: `req:${ref}` }]);
  assert.deepEqual([out.notify, out.wake, out.changed[0].state], [true, true, 'released']);
  assert.deepEqual(w.rows('topics').map(t => [t.kind, t.state, t.opportunity_ref, t.reason.startsWith('Tính năng mới đã ra')]), [['launch', 'queued', ref, true]]);
  assert.equal(w.rows('handoffs')[0].released_at, new Date(w.now).toISOString());
  assert.deepEqual(await w.call('team_watch'), { done: true }, 'a released team is not watched or announced again');
  assert.equal(w.rows('topics').length, 1);
  // The launch topic reaches the marketing plan like any other.
  assert.equal((await w.call('topic_next')).query, ITEM.product.title);
});

test('team_watch: a failed release is blocked, and bbs missing is {done} (nothing to watch with)', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  kickoff(w, b);
  b.snapshot({ phases: [phase('p1', 'release_failed')] });
  assert.equal((await w.call('team_watch')).changed[0].state, 'blocked');
  w.env.BBS_BIN = '/nonexistent/bbs'; w.env.PATH = '/nonexistent';
  assert.equal((await w.call('team_watch')).done, true);
});

test('team_watch finds the parent ticket from the team id (assignee, no parent); a snapshot is read of that ticket in the product repo', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  kickoff(w, b, 'bs-parent77');
  b.snapshot({ phases: [phase('p1', 'building')] });
  await w.call('team_watch');
  const snap = b.calls().filter(c => c.argv[1] === 'snapshot').at(-1);
  assert.deepEqual(snap.argv, ['team', 'snapshot', 'bs-parent77', '--json']);
  assert.equal(snap.cwd, realpathSync(dir));
  assert.equal(w.rows('handoffs')[0].ticket, 'bs-parent77', 'remembered, so the next read skips the lookup');
  assert.equal(b.calls().filter(c => c.argv[0] === 'ticket').length, 1);
});

test('team_watch: the parent is not created yet (kickoff still clarifying) is starting with a plain next step, never an error', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  b.tickets([{ id: 'bs-other0001', assignee: 'someone-else', parent: '' }]);
  const out = await w.call('team_watch');
  assert.deepEqual(out.changed.map(c => c.state), ['starting']);
  assert.equal(out.notify, false);
  assert.equal(w.rows('handoffs')[0].detail, 'Đội đang đọc yêu cầu — chưa có việc cần bạn.');
  assert.equal(b.calls().filter(c => c.argv[1] === 'snapshot').length, 0);
  assert.deepEqual(await w.call('team_watch'), { done: true });
  assert.equal((await w.call('page_view', {}, { page: 'cong-ty' })).next.code, 'building');
  kickoff(w, b);
  b.snapshot({ phases: [] });
  assert.equal((await w.call('team_watch')).changed[0].state, 'building');
});

test('team_watch falls back to the ticket files when bbs ticket find has no answer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'babysit-home-'));
  const { w, b } = await ready();
  w.env.BABYSIT_HOME = home;
  await w.call('digest_save', { opportunities: [ITEM.product] });
  await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  const teamId = w.rows('handoffs')[0].team_id;
  mkdirSync(join(home, 'projects', 'p', 'tickets', 'bs-file0001'), { recursive: true });
  writeFileSync(join(home, 'projects', 'p', 'tickets', 'bs-file0001', 'index.json'), JSON.stringify({ id: 'bs-file0001', assignee: teamId, parent: null }));
  b.snapshot({ phases: [phase('p1', 'building')] });
  await w.call('team_watch');
  assert.deepEqual(b.calls().filter(c => c.argv[1] === 'snapshot').at(-1).argv, ['team', 'snapshot', 'bs-file0001', '--json']);
});

test('team_watch: a handover waiting for the release go files ONE Cần bạn need with the place and command, not again', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  kickoff(w, b);
  b.snapshot({ phases: [phase('p1', 'released'), { ...phase('p2', 'delivered', 'ask'), ticket: 'bs-phase002' }] });
  const first = await w.call('team_watch');
  assert.deepEqual(first.changed, [{ ref, state: 'delivered' }]);
  assert.equal(first.ask.summary, `Bản bàn giao ${ITEM.product.title} chờ bạn duyệt phát hành`);
  assert.match(first.ask.missing, /BABYSIT_TICKET=bs-phase002 bbs ticket approval resolve --action approve/);
  assert.match(first.ask.missing, new RegExp(w.rows('handoffs')[0].team_id));
  assert.deepEqual([first.notify, first.wake], [true, true]);
  for (let i = 0; i < 3; i++) { w.now += 30 * 60_000; assert.deepEqual(await w.call('team_watch'), { done: true }, 'every 30 minutes stays quiet'); }
  assert.equal((await w.call('page_view', {}, { page: 'cong-ty' })).next.code, 'release_go');
  // The go is given; the release lands: the outcome and the launch topic, no second need.
  b.snapshot({ phases: [phase('p1', 'released'), phase('p2', 'released', 'ask')] });
  const out = await w.call('team_watch');
  assert.deepEqual([out.changed[0].state, out.outcomes[0].id, out.ask], ['released', 'requirement_shipped', undefined]);
  assert.equal(w.rows('topics').filter(t => t.kind === 'launch').length, 1);
});

test('team_watch uses the linked ticket when the page links one, in the product repo', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  await assert.rejects(w.call('page_action', { op: 'link_ticket', id: ref, ticket: 'bad ticket!', request_id: 'req-11112222' }, { page: { page: 'cong-ty' } }), /ticket cha/);
  await w.call('page_action', { op: 'link_ticket', id: ref, ticket: 'bs-abc12345', request_id: 'req-11112223' }, { page: { page: 'cong-ty' } });
  await w.call('team_watch');
  const snap = b.calls().filter(c => c.argv[1] === 'snapshot').at(-1);
  assert.deepEqual(snap.argv, ['team', 'snapshot', 'bs-abc12345', '--json']);
  assert.ok(snap.cwd.length && existsSync(dir));
});

// ---------- review ----------
test('hit rate math: a hit is actual at least half of expected, in the direction expected points', () => {
  assert.equal(isHit(10, 20), true);
  assert.equal(isHit(9.99, 20), false);
  assert.equal(isHit(25, 20), true);
  assert.equal(isHit(-1.5, -3), true);
  assert.equal(isHit(-1, -3), false);
  assert.equal(isHit(-5, 20), false);
  const rows = [
    { decision: 'go', expected_delta: 20, actual_delta: 12 }, { decision: 'go', expected_delta: 20, actual_delta: 3 },
    { decision: 'go', expected_delta: -3, actual_delta: -2 }, { decision: 'go', expected_delta: 5, actual_delta: null },
    { decision: 'drop', expected_delta: 5, actual_delta: 5 },
  ];
  assert.deepEqual(hitRate(rows), { hits: 2, measured: 3, rate: 0.67 });
  assert.deepEqual(hitRate([]), { hits: 0, measured: 0, rate: null });
});

test('review fills actual_delta from the scoreboard (target_outcome is the metric) once check_after_days have passed', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, title: 'Truyện ngôn tình hay', query: 'truyện ngôn tình hay', target_outcome: 'first_payers', expected_delta: 4 }, { ...ITEM.content, title: 'Chủ đề đo bằng outcome', query: 'chủ đề lạ', target_outcome: 'lead' }] });
  assert.deepEqual(await w.call('review'), { done: true, waiting: 3, hit_rate: { hits: 0, measured: 0, rate: null } }, 'before the days pass: quiet');
  // 8 days later signups went 120 -> 150, first_payers 3 -> 4.
  w.now += 8 * DAY;
  api.over = { metrics: { ...(await (await fetch(`${api.url}?from=2026-11-09&to=2026-11-15`, { headers: { 'x-api-key': KEY } })).json()).metrics, signups: { value: 150, previous: 120 }, first_payers: { value: 4, previous: 3 } } };
  await w.call('scoreboard_sync');
  const out = await w.call('review');
  const by = Object.fromEntries(out.reviewed.map(r => [r.target, r]));
  assert.deepEqual([by.signups.actual, by.signups.hit], [30, true]);
  assert.deepEqual([by.first_payers.actual, by.first_payers.hit], [1, false]);
  assert.deepEqual(out.unmeasured.length, 1, 'an outcome that is not a scoreboard metric cannot be measured and is not counted');
  assert.deepEqual(out.hit_rate, { hits: 1, measured: 2, rate: 0.5 });
  const log = w.rows('decisions');
  assert.ok(log.every(d => d.reviewed_at));
  assert.deepEqual(log.map(d => d.actual_delta).sort(), [1, 30, null].sort());
  assert.deepEqual(await w.call('review'), { done: true, waiting: 0, hit_rate: { hits: 1, measured: 2, rate: 0.5 } }, 'each decision is reviewed once');
  api.over = {};
});

test('a product decision is measured from its release, not from the Go', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  w.now += 40 * DAY; // past 30 days, but nothing shipped yet
  assert.equal((await w.call('review')).waiting, 1);
  kickoff(w, b);
  b.snapshot({ phases: [phase('p1', 'released')] });
  await w.call('team_watch');
  assert.equal((await w.call('review')).waiting, 1, 'the clock starts at the release');
  w.now += 31 * DAY;
  const out = await w.call('review');
  assert.equal(out.waiting, 0);
  assert.equal(out.unmeasured.length + out.reviewed.length, 1);
});
