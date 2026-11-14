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
  // The card is not the model's: digest_save returns the count; the cards tick raises it.
  assert.equal(out.waiting, 1);
  assert.equal(out.ask, undefined, 'no Cần bạn ask from the digest: the host raises the card');
  const card = await w.call('opportunities_card');
  assert.equal(card.raise.title, '1 cơ hội chờ bạn chọn');
  assert.match(card.raise.id, /^company:proposals:/);
  assert.equal(card.raise.link, 'nest://piece/company', 'a structured link, not text');
  assert.ok(card.raise.options.length >= 1);
  assert.deepEqual((await w.call('opportunities_card')).raise.id, card.raise.id, 'the same set is the same card id');
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

test('a product Go writes REQ-<id>.md as an agent-drafted requirement, opens a ticket and starts one autopilot session on it, nothing else', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('page_action', { op: 'go', id: ref, request_id: 'req-12345678' }, { page: { page: 'company' } });
  assert.deepEqual([out.handoff.state, out.handoff.ticket], ['spawned', 'bs-tkt00001']);
  const path = w.reqPath(dir, ref);
  assert.equal(out.handoff.requirement_path, path);
  assert.ok(!existsSync(join(dir, 'docs', 'requirements')), 'the product working tree is not written by the Go');
  assert.match(out.handoff.note, /Bước tiếp: phiên autopilot của ticket bs-tkt00001 .*bạn xem, commit và phát hành/);
  const text = readFileSync(path, 'utf8');
  for (const heading of ['## Outcome', '## Audience', '## Scope', '## Non-goals', '## Constraints', '## Acceptance criteria', '## Measured after release', '## Evidence']) assert.ok(text.includes(heading), heading);
  assert.match(text, /Target outcome: `support_handoffs`, expected change -3 within 30 days of release \(baseline when approved: 7\)/);
  assert.match(text, /- reason:refund/);
  assert.match(text, /approved by the founder with Go/);
  // What 2build's agent-drafted rule keys on: who drafted it, the appetite, and no after-release line among the QA criteria.
  assert.match(text, /^Status: draft written by Soot\. .*confirm the spec with them once/m);
  assert.match(text, /Estimate when proposed: effort M/);
  const [criteria, measured] = [text.split('## Acceptance criteria')[1].split('## Measured after release')[0], text.split('## Measured after release')[1].split('## Evidence')[0]];
  assert.ok(!/within 30 days/.test(criteria), 'a criterion QA cannot check before release is not a QA criterion');
  assert.match(measured, /`support_handoffs` moves by at least -1\.5 \(half of -3\) within 30 days of release, from 7/);
  // bbs is asked for exactly three things, in the product repo: a ticket from the file, the agent's unattended line, a terminal.
  const calls = b.calls().filter(c => c.argv[0] !== 'company');
  assert.deepEqual(calls.map(c => c.argv.slice(0, 2).join(' ')), ['ticket ensure', 'team worker-command', 'team spawn']);
  assert.deepEqual(calls[0].argv, ['ticket', 'ensure', '--from-input-file', path, '--no-branch']);
  assert.deepEqual(calls[1].argv, ['team', 'worker-command', '--agent', 'claude', '--skill', 'autopilot', '--prompt', '--auto builder bs-tkt00001', '--dir', dir]);
  assert.deepEqual(calls[2].argv, ['team', 'spawn', `loop-${ref.toLowerCase()}`, '--dir', dir, '--command', "AGENT_ROLE=dashboard BABYSIT_TICKET=bs-tkt00001 claude --dangerously-skip-permissions '/bbs:autopilot --auto builder bs-tkt00001'"]);
  for (const c of calls) assert.deepEqual([c.ticket, existsSync(c.cwd)], ['', true], 'never on a ticket this process inherited');
  // Never commit / land / release / integrate.
  const all = b.calls().flatMap(c => c.argv);
  for (const verb of ['land', 'release', 'integrate', 'seal', 'commit', 'push']) assert.ok(!all.includes(verb), verb);
  // The decision is the founder's, with the metric value as baseline; Go twice does nothing more.
  assert.deepEqual(w.rows('decisions').map(d => [d.decision, d.by, d.stage, d.baseline_value]), [['go', 'founder', 'gate', 7]]);
  const h = w.rows('handoffs')[0];
  assert.deepEqual([h.state, h.opportunity, h.repo, h.team_id], ['spawned', ref, dir, null]);
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

test('a product Go with bbs absent is draft_ready with what to do, never a silent drop', async () => {
  const { w, dir } = await ready({ bbs: false });
  w.env.PATH = '/nonexistent';
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(out.handoff.state, 'draft_ready');
  assert.ok(existsSync(w.reqPath(dir, ref)), 'the requirement is still written');
  assert.equal(w.rows('opportunities').find(o => o.ref === ref).state, 'go');
  assert.match(out.handoff.note, /chưa có bbs \(2build\).*Cài 2build rồi bấm Chạy lại/);
  // The page offers a retry; the next step names what to do.
  const view = await w.call('page_view', {}, { page: { page: 'company' } });
  assert.equal(view.next.code, 'draft_ready');
  assert.equal(view.handoffs[0].note, out.handoff.note);
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
  const retry = await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: 'req-87654321' }, { page: { page: 'company' } });
  assert.equal(retry.handoff.state, 'spawned');
  assert.equal(w.rows('handoffs').length, 1, 'one handoff per opportunity');
});

test('a product Go with no PRODUCT_REPO records the decision and an approved handoff with the requirement, spawns nothing, and task_done starts the outcome clock', async () => {
  const { w, b } = await ready({ repo: false });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(out.handoff.state, 'approved');
  assert.match(out.handoff.note, /PRODUCT_REPO/);
  const row = w.rows('handoffs')[0];
  assert.match(row.requirement, /^# REQ-OP-[0-9A-F]{8}: /);
  assert.deepEqual([row.product, row.target_outcome, row.repo, row.requirement_path], ['lohi', 'support_handoffs', null, null], 'no repo write: the requirement travels in the row');
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 0);
  assert.equal(w.rows('decisions').filter(d => d.decision === 'go' && d.opportunity_ref === ref).length, 1, 'the Go is in the decision log');
  const v = await w.call('page_view', {}, { page: { page: 'company' } });
  assert.deepEqual([v.next.code, v.next.n], ['task', 1]);
  assert.equal(v.handoffs[0].state, 'task');
  // Marking it done is the release: review measures from now, never from the Go.
  w.now += 86_400_000;
  await w.call('page_action', { op: 'task_done', id: ref, request_id: 'req-task0001' }, { page: { page: 'company' } });
  const h = w.rows('handoffs')[0];
  assert.equal(h.state, 'released');
  assert.equal(h.released_at, new Date(w.now).toISOString());
  assert.equal((await w.call('page_view', {}, { page: { page: 'company' } })).next.code, 'idle');
  await assert.rejects(w.call('page_action', { op: 'task_done', id: ref, request_id: 'req-task0002' }, { page: { page: 'company' } }), /Không có việc/);
  // A task row from before (no_repo with no repo) reads as a task too.
  await w.store.update('handoffs', h.id, { state: 'no_repo', repo: null, released_at: null });
  assert.equal((await w.call('page_view', {}, { page: { page: 'company' } })).handoffs[0].state, 'task');
});

test('the decide tool needs the operator approval; the model tool list of the Lead never includes it', async () => {
  const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
  assert.equal(pack.tools.find(t => t.name === 'decide').run.approval, 'operator');
  assert.equal(pack.tools.find(t => t.name === 'page_action').run.approval, undefined, 'a page is never approval-gated: the operator-only page is the approval');
  assert.deepEqual(pack.interface.pieces.map(p => [p.id, p.slot, p.access]), [['company', 'rail', 'operator']]);
});

// ---------- topic_next ----------
test('topic_next gives the oldest queued topic once, marks it handed, and answers {} when none', async () => {
  const { w } = await ready();
  assert.deepEqual(await w.call('topic_next'), {});
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, title: 'Truyện ngôn tình hay', query: 'truyện ngôn tình hay' }] });
  const first = await w.call('topic_next');
  assert.deepEqual(first, { query: 'truyện tiên hiệp full', awareness: 'problem', reason: ITEM.content.title, opportunity_ref: refOf(w, 'content') });
  assert.equal((await w.call('topic_next')).query, 'truyện ngôn tình hay');
  assert.deepEqual(await w.call('topic_next'), {});
  assert.deepEqual(w.rows('topics').map(t => t.state), ['handed', 'handed']);
});

test('in a chain topic_next is only the query (it merges into marketing plan), one handed topic at a time', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, title: 'Truyện ngôn tình hay', query: 'truyện ngôn tình hay' }] });
  assert.deepEqual(await w.call('topic_next', { chain: true }), { query: 'truyện tiên hiệp full', awareness: 'problem' });
  assert.deepEqual(await w.call('topic_next', { chain: true }), {}, 'a second topic waits for the first to be written');
  w.now += 21 * 3_600_000;
  assert.deepEqual(await w.call('topic_next', { chain: true }), {}, 'marketing still holds the first topic (48 h), a second would be lost');
  w.now += 28 * 3_600_000;
  assert.deepEqual(await w.call('topic_next', { chain: true }), { query: 'truyện ngôn tình hay', awareness: 'problem' }, 'after the hold the next topic goes');
});

// ---------- topic_sync (F-L6-6) ----------
const HOUR = 3_600_000;
test('topic_sync: handed until a post with the keyword exists, then written with the post id', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content] });
  await w.call('topic_next', { chain: true });
  // Marketing's plan reports the newest posts; none is about this topic yet.
  const plan = { wake: false, notify: false, code: 'planned_today', topic_posts: [{ keyword: 'truyện hiện đại hay', post: 'P-1' }] };
  const idle = await w.call('topic_sync', plan);
  assert.deepEqual(idle, plan, 'passes the plan verdict through unchanged');
  assert.deepEqual(w.rows('topics').map(t => [t.state, t.post ?? null]), [['handed', null]]);
  const v = await w.call('page_view', {}, { page: { page: 'company' } });
  assert.deepEqual([v.topics[0].state, v.topics[0].post, v.next.code], ['handed', null, 'topic_handed']);
  w.now += 20 * HOUR;
  const out = await w.call('topic_sync', { wake: true, topic_posts: [{ keyword: 'Truyện Tiên Hiệp full', post: 'P-9' }, ...plan.topic_posts] });
  assert.deepEqual(out.topic_sync, [{ query: 'truyện tiên hiệp full', state: 'written', post: 'P-9' }]);
  assert.equal(out.wake, true);
  assert.deepEqual(w.rows('topics').map(t => [t.state, t.post]), [['written', 'P-9']]);
  assert.deepEqual((await w.call('page_view', {}, { page: { page: 'company' } })).topics.map(t => [t.state, t.post]), [['written', 'P-9']]);
});

test('topic_sync: a topic still unwritten after the 48 h hold returns to the queue (and can be handed again)', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content] });
  await w.call('topic_next', { chain: true });
  w.now += 47 * HOUR;
  assert.equal((await w.call('topic_sync', {})).topic_sync, undefined, 'still within the hold');
  w.now += 2 * HOUR;
  assert.deepEqual((await w.call('topic_sync', {})).topic_sync, [{ query: 'truyện tiên hiệp full', state: 'queued' }]);
  assert.deepEqual(await w.call('topic_next', { chain: true }), { query: 'truyện tiên hiệp full', awareness: 'problem' });
});

test('a row already in the old state taken reads as handed, is written by topic_sync and expires like handed', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, title: 'Truyện ngôn tình hay', query: 'truyện ngôn tình hay' }] });
  for (const t of w.rows('topics')) await w.store.update('topics', t.id, { state: 'taken' });
  const v = await w.call('page_view', {}, { page: { page: 'company' } });
  assert.deepEqual(v.topics.map(t => t.state), ['handed', 'handed']);
  assert.equal(v.next.code, 'topic_handed');
  assert.equal((await w.call('topic_next', { chain: true })).query, undefined, 'an old taken row is a live hold too');
  const out = await w.call('topic_sync', { topic_posts: [{ keyword: 'truyện ngôn tình hay', post: 'P-2' }] });
  assert.deepEqual(out.topic_sync, [{ query: 'truyện ngôn tình hay', state: 'written', post: 'P-2' }]);
  w.now += 49 * HOUR;
  assert.deepEqual((await w.call('topic_sync', {})).topic_sync, [{ query: 'truyện tiên hiệp full', state: 'queued' }]);
});

// ---------- team_watch ----------
// The whole build leg (questions, answers, hand-back, queue, retries) is walked in handoff.test.mjs.
test('team_watch: nothing open, or nothing changed, is {done: true}; each open handoff is read on its own ticket in the product repo', async () => {
  const { w, b, dir } = await ready();
  assert.deepEqual(await w.call('team_watch'), { done: true });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  await w.call('decide', { id: refOf(w, 'product'), decision: 'go' });
  const first = await w.call('team_watch');
  assert.deepEqual([first.changed[0].state, first.notify, first.wake], ['starting', false, false]);
  assert.equal(w.rows('handoffs')[0].detail, 'Phiên dựng đang đọc yêu cầu — chưa có việc cần bạn.');
  assert.deepEqual(await w.call('team_watch'), { done: true });
  const reads = b.calls().filter(c => c.argv[1] === 'get').slice(-2);
  assert.deepEqual(reads.map(c => [c.argv, c.ticket, c.cwd.split('/').pop()]), [[['ticket', 'get', 'status'], 'bs-tkt00001', dir.split('/').pop()], [['ticket', 'get', 'approval'], 'bs-tkt00001', dir.split('/').pop()]]);
  w.env.BBS_BIN = '/nonexistent/bbs';
  assert.deepEqual(await w.call('team_watch'), { done: true }, 'bbs gone: nothing to read with, nothing changed');
  assert.equal(w.rows('handoffs')[0].state, 'starting');
});

test('team_watch: built is delivered and waits for the founder; shipped (their tap, or the ticket closed) records requirement_shipped and queues one launch topic', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  b.ticket('bs-tkt00001', { status: 'in_progress' });
  assert.equal((await w.call('team_watch')).changed[0].state, 'building');
  b.ticket('bs-tkt00001', { status: 'in_review' });
  const delivered = await w.call('team_watch');
  assert.deepEqual([delivered.changed[0].state, delivered.outcomes, delivered.notify], ['delivered', undefined, false]);
  assert.equal(w.rows('topics').filter(t => t.kind === 'launch').length, 0);
  b.ticket('bs-tkt00001', { status: 'done' });
  const out = await w.call('team_watch');
  assert.deepEqual(out.outcomes, [{ id: 'requirement_shipped', count: 1, ref: `req:${ref}` }]);
  assert.deepEqual([out.notify, out.wake], [true, true]);
  assert.equal(w.rows('handoffs')[0].released_at, new Date(w.now).toISOString());
  assert.deepEqual(await w.call('team_watch'), { done: true }, 'a released handoff is not watched or announced again');
  const launch = w.rows('topics').filter(t => t.kind === 'launch');
  assert.equal(launch.length, 1);
  assert.match(launch[0].reason, /Tính năng mới đã ra/);
});

test('link_ticket points a handoff at another ticket (the hidden manual override)', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  await w.call('page_action', { op: 'link_ticket', id: ref, ticket: 'bs-abc12345', request_id: 'req-link0001' }, { page: { page: 'company' } });
  b.ticket('bs-abc12345', { status: 'in_progress' });
  assert.equal((await w.call('team_watch')).changed[0].state, 'building');
  assert.equal(b.calls().filter(c => c.argv[1] === 'get').at(-1).ticket, 'bs-abc12345');
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

test('review fills actual_delta from the scoreboard (target_outcome is the metric) once check_after_days have passed since release', async () => {
  const { w } = await ready();
  const p = (title, extra) => ({ ...ITEM.product, title, check_after_days: 7, ...extra });
  await w.call('digest_save', { opportunities: [p('Tăng đăng ký', { target_outcome: 'signups', expected_delta: 20 }), p('Tăng người trả tiền', { target_outcome: 'first_payers', expected_delta: 4 }), p('Chủ đề đo bằng outcome', { target_outcome: 'lead', expected_delta: 3 })] });
  for (const o of w.rows('opportunities')) await w.call('decide', { id: o.ref, decision: 'go' });
  for (const h of w.rows('handoffs')) await w.store.update('handoffs', h.id, { state: 'released', released_at: new Date(w.now).toISOString() });
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
  const log = w.rows('decisions').filter(d => d.decision === 'go');
  assert.ok(log.every(d => d.reviewed_at));
  assert.deepEqual(log.map(d => d.actual_delta).sort(), [1, 30, null].sort());
  assert.deepEqual(await w.call('review'), { done: true, waiting: 0, hit_rate: { hits: 1, measured: 2, rate: 0.5 } }, 'each decision is reviewed once');
  api.over = {};
});

// F10: a content decision is measured on the post's own numbers from its publish day, not on the weekly total from the Go.
/** A content Go whose post exists: the topic is written, the post published `daysAgo` days before w.now with the given numbers. */
async function contentGo(w, { publishedDaysAgo = 10, ...own } = {}) {
  await w.call('digest_save', { opportunities: [{ ...ITEM.content, expected_delta: 30 }] });
  const ref = w.rows('opportunities')[0].ref;
  await w.call('topic_next', {});
  await w.call('topic_sync', { topic_posts: [{ keyword: 'truyện tiên hiệp full', post: 'P-1', url: 'https://lohi2.com/blog/x', published_at: new Date(w.now - publishedDaysAgo * DAY).toISOString(), ...own }] });
  return ref;
}

test('a content decision is scored on the post\'s own clicks from its publish date, not on total signups from the Go', async () => {
  const { w } = await ready();
  const ref = await contentGo(w, { publishedDaysAgo: 8, clicks: 21 });
  // The weekly total rises by 200 signups: it must not matter.
  api.over = { metrics: { ...(await (await fetch(`${api.url}?from=2026-11-09&to=2026-11-15`, { headers: { 'x-api-key': KEY } })).json()).metrics, signups: { value: 1000, previous: 800 } } };
  await w.call('scoreboard_sync');
  const out = await w.call('review');
  assert.deepEqual(out.reviewed.map(r => [r.ref, r.measured_by, r.actual, r.hit]), [[ref, 'clicks', 21, true]]);
  assert.equal(w.rows('topics')[0].post_clicks, 21);
  api.over = {};
});

test('a content post younger than check_after_days is waiting, even when the Go is old', async () => {
  const { w } = await ready();
  await contentGo(w, { publishedDaysAgo: 2, clicks: 50 });
  w.now += 3 * DAY; // 11 days after the Go, 5 after the post: still inside its 7 days
  assert.equal((await w.call('review')).waiting, 1);
});

test('a content post with no number of its own is "chưa đo": it waits a grace, then closes without scoring', async () => {
  const { w } = await ready();
  const ref = await contentGo(w, { publishedDaysAgo: 8 }); // no clicks, no signups: no Search Console, no campaign link
  assert.equal((await w.call('review')).waiting, 1, 'inside the grace');
  w.now += 15 * DAY;
  const out = await w.call('review');
  assert.deepEqual(out.unmeasured, [ref]);
  assert.match(out.unmeasured_note, /^chưa đo/);
  assert.deepEqual(out.hit_rate, { hits: 0, measured: 0, rate: null }, 'noise is never scored');
  assert.equal(w.rows('decisions').find(d => d.decision === 'go').actual_delta, null);
});

test('a content post not yet published keeps waiting, and a later topic_sync fills its numbers once Search Console reports', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.content] });
  await w.call('topic_next', {});
  await w.call('topic_sync', { topic_posts: [{ keyword: 'truyện tiên hiệp full', post: 'P-1' }] });
  w.now += 20 * DAY;
  assert.equal((await w.call('review')).waiting, 1, 'written but not published: nothing to measure');
  await w.call('topic_sync', { topic_posts: [{ keyword: 'truyện tiên hiệp full', post: 'P-1', published_at: new Date(w.now - 9 * DAY).toISOString(), clicks: 4 }] });
  const out = await w.call('review');
  assert.equal(out.reviewed[0].actual, 4);
  assert.equal(out.reviewed[0].hit, false, '4 clicks are below half of 20');
});

test('a product decision is measured from its release, not from the Go', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  w.now += 40 * DAY; // past 30 days, but nothing shipped yet
  assert.equal((await w.call('review')).waiting, 1);
  await w.call('page_action', { op: 'shipped', id: ref, request_id: 'req-ship0001' }, { page: { page: 'company' } });
  await w.call('team_watch');
  assert.equal((await w.call('review')).waiting, 1, 'the clock starts at the release');
  w.now += 31 * DAY;
  const out = await w.call('review');
  assert.equal(out.waiting, 0);
  assert.equal(out.unmeasured.length + out.reviewed.length, 1);
});

test('opportunities_card: closes itself when none is proposed, the count follows the table, a new set is a new card', async () => {
  const { w } = await ready();
  assert.deepEqual((await w.call('opportunities_card')).settle, ['company:proposals']);
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const one = (await w.call('opportunities_card')).raise;
  assert.equal(one.title, '1 cơ hội chờ bạn chọn');
  assert.equal(one.group, 'company:proposals');
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  const done = await w.call('opportunities_card');
  assert.deepEqual([done.raise, done.settle, done.wake, done.notify], [undefined, ['company:proposals'], undefined, undefined]);
});

// ---------- goal ref (L19) ----------
test('goal is optional on an opportunity, is carried to its decision and survives review', async () => {
  const { w } = await ready();
  await w.call('digest_save', { opportunities: [{ ...ITEM.product, goal: 'g_first_payers' }, { ...ITEM.content, title: 'Không gắn mục tiêu nào' }] });
  const [withGoal, without] = [w.rows('opportunities').find(o => o.kind === 'product'), w.rows('opportunities').find(o => o.kind === 'content')];
  assert.equal(withGoal.goal, 'g_first_payers');
  assert.equal(without.goal, null, 'a bet without a goal is valid');
  await w.call('decide', { id: withGoal.ref, decision: 'go' });
  const logged = w.rows('decisions').filter(d => d.opportunity_ref === withGoal.ref);
  assert.ok(logged.length && logged.every(d => d.goal === 'g_first_payers'), 'every decision of the bet points at its goal');
  assert.equal(w.rows('decisions').find(d => d.opportunity_ref === without.ref).goal, null);
  const sig = await w.call('signals');
  assert.equal(sig.packet.decisions.find(d => d.ref === withGoal.ref).g, 'g_first_payers', 'signals hands the ref on without reading any goal');
  // review fills actual_delta and leaves the goal where it was.
  const d = w.rows('decisions').find(x => x.opportunity_ref === withGoal.ref && x.decision === 'go');
  await w.store.update('decisions', d.id, { actual_delta: 5, reviewed_at: new Date(w.now).toISOString() });
  await w.call('review');
  assert.equal(w.rows('decisions').find(x => x.id === d.id).goal, 'g_first_payers');
});

test('a goal that is not a string id is refused with the field named, and nothing is saved', async () => {
  const { w } = await ready();
  for (const goal of [42, { id: 'g_1' }, ['g_1'], '', 'có dấu cách', 'x'.repeat(65)]) {
    await assert.rejects(w.call('digest_save', { opportunities: [{ ...ITEM.content, goal }] }), /Chưa lưu cơ hội nào.*#1 goal/, JSON.stringify(goal));
  }
  assert.equal(w.rows('opportunities').length, 0);
  assert.equal(w.rows('decisions').length, 0);
});
