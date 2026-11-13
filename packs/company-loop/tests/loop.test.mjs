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
  assert.equal(card.raise.link, 'nest://page/company', 'a structured link, not text');
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

test('a product Go writes REQ-<id>.md in the shape bbs:team expects and spawns a team with --auto, nothing else', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  const out = await w.call('page_action', { op: 'go', id: ref, request_id: 'req-12345678' }, { page: { page: 'company' } });
  assert.equal(out.handoff.state, 'spawned');
  assert.equal(out.handoff.team_id, `loop-${ref.toLowerCase()}`);
  const path = w.reqPath(dir, ref);
  assert.equal(out.handoff.requirement_path, path);
  assert.ok(!existsSync(join(dir, 'docs', 'requirements')), 'the product working tree is not written');
  assert.match(out.handoff.note, /Bước tiếp: đội loop-op-.* terminal Orca của đội \(bbs ticket approval resolve/);
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
  assert.ok(existsSync(w.reqPath(dir, ref)), 'the requirement is still written');
  assert.equal(w.rows('opportunities').find(o => o.ref === ref).state, 'go');
  assert.match(out.handoff.note, /chưa có bbs/);
  // The page offers the command and a retry; the next step names what to do.
  const view = await w.call('page_view', {}, { page: { page: 'company' } });
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
  assert.equal((await w.call('page_view', {}, { page: 'company' })).next.code, 'release_go');
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
  assert.equal((await w.call('page_view', {}, { page: 'company' })).next.code, 'building');
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
  assert.equal(first.raise.length, 1);
  assert.equal(first.raise[0].title, `Bản bàn giao ${ITEM.product.title} chờ bạn duyệt phát hành`);
  assert.match(first.raise[0].why, /BABYSIT_TICKET=bs-phase002 bbs ticket approval resolve --action approve/);
  assert.match(first.raise[0].why, new RegExp(w.rows('handoffs')[0].team_id));
  assert.deepEqual([first.notify, first.wake], [false, false], 'a card needs no model');
  for (let i = 0; i < 3; i++) { w.now += 30 * 60_000; { const t = await w.call('team_watch'); assert.deepEqual([t.changed, t.notify, t.wake, t.raise.map(r => r.id)], [[], false, false, first.raise.map(r => r.id)], 'every tick restates the same card id and wakes nobody'); }; }
  assert.equal((await w.call('page_view', {}, { page: 'company' })).next.code, 'release_go');
  // The go is given; the release lands: the outcome and the launch topic, no second need.
  b.snapshot({ phases: [phase('p1', 'released'), phase('p2', 'released', 'ask')] });
  const out = await w.call('team_watch');
  assert.deepEqual([out.changed[0].state, out.outcomes[0].id, out.raise, out.settle], ['released', 'requirement_shipped', undefined, [`company:handover:${ref}`]]);
  assert.equal(w.rows('topics').filter(t => t.kind === 'launch').length, 1);
});

test('team_watch uses the linked ticket when the page links one, in the product repo', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = refOf(w, 'product');
  await w.call('decide', { id: ref, decision: 'go' });
  await assert.rejects(w.call('page_action', { op: 'link_ticket', id: ref, ticket: 'bad ticket!', request_id: 'req-11112222' }, { page: { page: 'company' } }), /ticket cha/);
  await w.call('page_action', { op: 'link_ticket', id: ref, ticket: 'bs-abc12345', request_id: 'req-11112223' }, { page: { page: 'company' } });
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
  kickoff(w, b);
  b.snapshot({ phases: [phase('p1', 'released')] });
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
