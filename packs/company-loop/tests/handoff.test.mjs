// F4: the build leg proven end to end with a fake bbs: proposed -> Go -> spawned | draft_ready -> asking -> answered ->
// building -> delivered -> (the founder ships) -> released. The session talks through its ticket; committing and
// releasing stay a person's. The requirement never lands in the product working tree.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { world, ITEM } from './world.mjs';
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
const PAGE = { page: { page: 'company' } };
const gitStatus = dir => execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
const ask = (note, at = '2026-11-09T02:00:00Z', kind = 'spec') => ({ state: 'pending', kind, note, at });
const T1 = 'bs-tkt00001';

test('walk: Go -> spawned -> the session asks -> the founder answers on the page -> building -> delivered -> shipped by the founder -> released', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  const out = await w.call('page_action', { op: 'go', id: ref, request_id: 'req-aaaaaaaa' }, PAGE);
  assert.deepEqual([out.handoff.state, out.handoff.ticket], ['spawned', T1]);
  assert.equal(gitStatus(dir), '', 'a Go writes nothing in the product working tree');
  assert.ok(existsSync(out.handoff.requirement_path) && out.handoff.requirement_path.startsWith(w.env.BABYSIT_HOME));
  assert.match(out.handoff.note, /hỏi bạn xác nhận đặc tả/);
  assert.match(out.handoff.note, /không commit và không phát hành/);
  // Nothing on the ticket yet: the session is reading.
  assert.deepEqual((await w.call('team_watch')).changed, [{ ref, state: 'starting' }]);
  // The session asks the founder to confirm the spec: one card, restated (same id) on every tick, nobody woken.
  b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec: /t/requirement.md. Có gồm hoàn tiền một phần không?') });
  const asked = await w.call('team_watch');
  assert.deepEqual(asked.changed, [{ ref, state: 'asking' }]);
  assert.equal(asked.raise[0].id, `company:ask:${ref}:2026-11-09T02:00:00Z`);
  assert.match(asked.raise[0].why, /Xác nhận đặc tả: Confirm the spec.*hoàn tiền một phần/);
  assert.deepEqual([asked.notify, asked.wake], [false, false]);
  const again = await w.call('team_watch');
  assert.deepEqual([again.changed, again.raise.map(c => c.id)], [[], asked.raise.map(c => c.id)]);
  const view = await w.call('page_view', {}, PAGE);
  assert.deepEqual([view.next.code, view.handoffs[0].state], ['answer', 'asking']);
  assert.match(view.handoffs[0].detail, /hoàn tiền một phần/);
  // A redirect needs words; with them it reaches the ticket as the founder's verdict.
  await assert.rejects(w.call('page_action', { op: 'answer', id: ref, action: 'redirect', request_id: 'req-aaaaaaab' }, PAGE), /Góp ý cần nói rõ/);
  const said = await w.call('page_action', { op: 'answer', id: ref, action: 'redirect', note: 'Chỉ hoàn toàn bộ, bỏ hoàn một phần', request_id: 'req-aaaaaaac' }, PAGE);
  assert.equal(said.handoff.state, 'answered');
  const resolve = b.calls().filter(c => c.argv[2] === 'resolve').at(-1);
  assert.deepEqual([resolve.argv, resolve.ticket, resolve.cwd.split('/').pop()], [['ticket', 'approval', 'resolve', '--action', 'redirect', '--note', 'Chỉ hoàn toàn bộ, bỏ hoàn một phần'], T1, dir.split('/').pop()]);
  await assert.rejects(w.call('page_action', { op: 'answer', id: ref, action: 'approve', request_id: 'req-aaaaaaad' }, PAGE), /Không có câu hỏi nào/);
  const moved = await w.call('team_watch');
  assert.deepEqual(moved.changed, [{ ref, state: 'building' }]);
  assert.deepEqual(moved.settle, [`company:ask:${ref}`], 'the question card is done once it was answered');
  // It asks again with the fixed spec (a new card), the founder approves, it builds.
  b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec: chỉ hoàn toàn bộ.', '2026-11-09T03:00:00Z') });
  assert.equal((await w.call('team_watch')).raise[0].id, `company:ask:${ref}:2026-11-09T03:00:00Z`);
  await w.call('page_action', { op: 'answer', id: ref, action: 'approve', request_id: 'req-aaaaaaae' }, PAGE);
  b.ticket(T1, { status: 'in_progress', approval: { state: 'approved', kind: 'spec' } });
  assert.deepEqual((await w.call('team_watch')).changed, [{ ref, state: 'building' }]);
  assert.match(w.rows('handoffs')[0].detail, /Đang dựng/);
  // Done: reviewed, QA'd, left uncommitted. Soot says so and stops; it never commits or releases.
  b.ticket(T1, { status: 'in_review', approval: { state: 'approved', kind: 'spec' } });
  const delivered = await w.call('team_watch');
  assert.deepEqual(delivered.changed, [{ ref, state: 'delivered' }]);
  assert.equal(delivered.raise[0].id, `company:handover:${ref}`);
  assert.match(delivered.raise[0].why, new RegExp(`chưa commit trong ${dir}.*commit rồi phát hành.*Đã phát hành`));
  assert.equal((await w.call('page_view', {}, PAGE)).next.code, 'release_go');
  assert.equal(delivered.outcomes, undefined, 'built is not shipped');
  for (const verb of ['land', 'release', 'integrate', 'commit', 'push']) assert.ok(!b.calls().some(c => c.argv.includes(verb)), verb);
  // The founder ships it and says so: the outcome and the launch topic follow, once.
  w.now += 3_600_000;
  await w.call('page_action', { op: 'shipped', id: ref, request_id: 'req-aaaaaaaf' }, PAGE);
  const done = await w.call('team_watch');
  assert.deepEqual([done.changed, done.outcomes, done.settle], [[{ ref, state: 'released' }], [{ id: 'requirement_shipped', count: 1, ref: `req:${ref}` }], [`company:handover:${ref}`]]);
  assert.deepEqual([w.rows('handoffs')[0].state, w.rows('handoffs')[0].released_at], ['released', new Date(w.now).toISOString()]);
  assert.equal(w.rows('topics').filter(t => t.kind === 'launch').length, 1);
  assert.deepEqual(await w.call('team_watch'), { done: true }, 'a released handoff is not read or announced again');
  await assert.rejects(w.call('page_action', { op: 'shipped', id: ref, request_id: 'req-aaaaaab0' }, PAGE), /Không có bản dựng/);
});

test('Dừng on the question drops the handoff; a session that stopped is blocked with one card and Chạy lại reopens it on the same ticket', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product, { ...ITEM.product, title: 'Gợi ý đọc tiếp theo thể loại' }] });
  const [one, two] = w.rows('opportunities').map(o => o.ref);
  await w.call('decide', { id: one, decision: 'go' });
  b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec') });
  await w.call('team_watch');
  await w.call('page_action', { op: 'answer', id: one, action: 'drop', request_id: 'req-bbbbbbb1' }, PAGE);
  const dropped = await w.call('team_watch');
  assert.deepEqual(dropped.changed, [{ ref: one, state: 'dropped' }]);
  assert.deepEqual(await w.call('team_watch'), { done: true }, 'a dropped handoff is closed');
  // The checkout is free again: the next Go starts at once, on its own ticket.
  const out = await w.call('decide', { id: two, decision: 'go' });
  assert.deepEqual([out.handoff.state, out.handoff.ticket], ['spawned', 'bs-tkt00002']);
  b.ticket('bs-tkt00002', { status: 'blocked' });
  const stuck = await w.call('team_watch');
  assert.deepEqual([stuck.changed, stuck.raise.map(c => c.id)], [[{ ref: two, state: 'blocked' }], [`company:blocked:${two}`]]);
  const retry = await w.call('page_action', { op: 'retry_handoff', id: two, request_id: 'req-bbbbbbb2' }, PAGE);
  assert.equal(retry.handoff.state, 'spawned');
  assert.equal(b.calls().filter(c => c.argv[1] === 'ensure').length, 2, 'no third ticket: the retry resumes bs-tkt00002');
  assert.match(b.calls().filter(c => c.argv[1] === 'spawn').at(-1).argv.at(-1), /BABYSIT_TICKET=bs-tkt00002 .*builder bs-tkt00002'$/);
});

test('one build at a time per checkout: a second Go is queued and starts by itself when the first has shipped', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product, { ...ITEM.product, title: 'Gợi ý đọc tiếp theo thể loại' }] });
  const [one, two] = w.rows('opportunities').map(o => o.ref);
  await w.call('decide', { id: one, decision: 'go' });
  const second = await w.call('decide', { id: two, decision: 'go' });
  assert.equal(second.handoff.state, 'queued');
  assert.match(second.handoff.note, new RegExp(`thay đổi khác chưa phát hành \\(${one}\\)`));
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 1);
  b.ticket(T1, { status: 'in_review' });
  await w.call('team_watch');
  assert.equal(w.rows('handoffs').find(h => h.opportunity === two).state, 'queued', 'built but not shipped still holds the checkout');
  await w.call('page_action', { op: 'shipped', id: one, request_id: 'req-ccccccc1' }, PAGE);
  const out = await w.call('team_watch');
  assert.deepEqual(out.changed, [{ ref: one, state: 'released' }, { ref: two, state: 'spawned' }]);
  assert.equal(w.rows('handoffs').find(h => h.opportunity === two).ticket, 'bs-tkt00002');
});

test('bbs missing: draft_ready says to install it, is reminded once after the wait, and Chạy lại starts it once bbs is there', async () => {
  const { w, b } = await ready({ bbs: false });
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  const out = await w.call('page_action', { op: 'go', id: ref, request_id: 'req-ddddddd1' }, PAGE);
  assert.equal(out.handoff.state, 'draft_ready');
  assert.match(out.handoff.note, /chưa có bbs/);
  assert.ok(existsSync(w.reqPath(w.env.PRODUCT_REPO, ref)), 'the requirement is still written');
  assert.deepEqual(await w.call('team_watch'), { done: true }, 'soon after the Go: quiet');
  w.now += NUDGE_AFTER_MS + 60_000;
  const remind = await w.call('team_watch');
  assert.equal(remind.raise[0].id, `company:unstarted:${ref}`);
  assert.deepEqual([remind.notify, remind.wake], [false, false], 'the host files the card; no model');
  w.env.BBS_BIN = b.bin;
  const retry = await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: 'req-ddddddd2' }, PAGE);
  assert.deepEqual([retry.handoff.state, w.rows('handoffs')[0].ticket], ['spawned', T1]);
  assert.ok((await w.call('team_watch')).settle.includes(`company:unstarted:${ref}`), 'the reminder is settled once the session exists');
});

test('Orca not running: the ticket exists, the command to run by hand is shown, and the row moves on when the founder ran it', async () => {
  const { w, b, dir } = await ready();
  b.failSpawn(true);
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  const out = await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(out.handoff.state, 'draft_ready');
  assert.match(out.handoff.note, /orca: not running/);
  assert.equal(out.handoff.command, `cd '${dir}' && AGENT_ROLE=dashboard BABYSIT_TICKET=${T1} claude --dangerously-skip-permissions '/bbs:autopilot --auto builder ${T1}'`);
  assert.equal((await w.call('page_view', {}, PAGE)).next.code, 'draft_ready');
  assert.deepEqual(await w.call('team_watch'), { done: true });
  // The founder ran it in a terminal of their own: its first question shows up like any other.
  b.ticket(T1, { status: 'backlog', approval: ask('Confirm the spec') });
  assert.deepEqual((await w.call('team_watch')).changed, [{ ref, state: 'asking' }]);
});

test('an agent that would stop on a prompt nobody sees is refused before any terminal opens; a ticket that cannot be read changes nothing', async () => {
  const { w, b } = await ready();
  b.fail('worker');
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  const out = await w.call('decide', { id: ref, decision: 'go' });
  assert.equal(out.handoff.state, 'draft_ready');
  assert.match(out.handoff.note, /has not been told to trust/);
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 0);
  b.fail('worker', false);
  await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: 'req-eeeeeee1' }, PAGE);
  b.fail('get');
  assert.deepEqual(await w.call('team_watch'), { done: true });
  assert.match(w.rows('handoffs')[0].detail, /Chưa đọc được ticket bs-tkt00001/);
  assert.equal(w.rows('handoffs')[0].state, 'spawned');
});

test('a handoff opened for bbs:team before is no longer read; the founder closes it with Đã phát hành', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  await w.call('decide', { id: ref, decision: 'go' });
  const h = w.rows('handoffs')[0];
  await w.store.update('handoffs', h.id, { team_id: `loop-${ref.toLowerCase()}`, ticket: 'bs-parent01', state: 'building' });
  const before = b.calls().length;
  assert.deepEqual(await w.call('team_watch'), { done: true });
  assert.equal(b.calls().length, before, 'bbs is not asked about a team');
  await w.call('page_action', { op: 'shipped', id: ref, request_id: 'req-fffffff1' }, PAGE);
  assert.deepEqual((await w.call('team_watch')).changed, [{ ref, state: 'released' }]);
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

test('each product builds in its own project: a PRODUCT_REPOS path or a bbs workspace name, resolved on this machine', async () => {
  const { w, b, dir } = await ready();
  const other = scratchRepo(), third = scratchRepo();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  const product = w.rows('opportunities')[0].product;
  // A workspace with two repos needs the folder named; one the machine does not know says so. Neither falls back to PRODUCT_REPO.
  b.workspace('acme', [other, third]);
  for (const [project, why] of [['acme', /có 2 kho/], ['nope', /không có workspace nope/], [`acme/missing`, /không có kho missing/]]) {
    w.env.PRODUCT_REPOS = `khac=/tmp/x, ${product}=${project}`;
    const out = (await w.call('page_view', {}, PAGE)).handoffs.length ? await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: `req-${project.replace(/\W/g, '')}aaaa` }, PAGE) : await w.call('page_action', { op: 'go', id: ref, request_id: 'req-gggggggg' }, PAGE);
    assert.equal(out.handoff.state, 'no_repo', project);
    assert.match(out.handoff.note, why);
  }
  w.env.PRODUCT_REPOS = `${product}=acme/${other.split('/').pop()}`;
  const out = await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: 'req-hhhhhhhh' }, PAGE);
  assert.equal(out.handoff.state, 'spawned');
  assert.equal(w.rows('handoffs')[0].repo, other);
  assert.equal(b.calls().find(c => c.argv[1] === 'ensure').cwd.split('/').pop(), other.split('/').pop(), 'the ticket is opened in the product\'s own checkout');
  assert.equal(gitStatus(dir), '');
  const view = await w.call('page_view', {}, PAGE);
  assert.equal(view.handoffs[0].build, true);
});

test('Go: giao người làm records a task and starts nothing, even with a project; the task can go back to Soot', async () => {
  const { w, b } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product] });
  const ref = w.rows('opportunities')[0].ref;
  assert.equal((await w.call('page_view', {}, PAGE)).opportunities[0].build, true);
  const out = await w.call('page_action', { op: 'go', id: ref, build: 'person', request_id: 'req-pppppppp' }, PAGE);
  assert.equal(out.handoff.state, 'task');
  assert.match(out.handoff.note, /Bạn chọn giao việc này cho người/);
  assert.equal(b.calls().filter(c => c.argv[0] !== 'company').length, 0, 'no ticket, no session');
  assert.deepEqual(await w.call('team_watch'), { done: true });
  const back = await w.call('page_action', { op: 'retry_handoff', id: ref, request_id: 'req-pppppppq' }, PAGE);
  assert.equal(back.handoff.state, 'spawned');
});

test('to_person: a blocked build becomes a person\'s task that keeps the checkout; task_done frees it for the queued Go', async () => {
  const { w, b, dir } = await ready();
  await w.call('digest_save', { opportunities: [ITEM.product, { ...ITEM.product, title: 'Nhắc nạp lại khi ví gần hết' }] });
  const [a, c] = w.rows('opportunities').map(o => o.ref);
  await w.call('page_action', { op: 'go', id: a, request_id: 'req-tttttttt' }, PAGE);
  assert.equal((await w.call('page_action', { op: 'go', id: c, request_id: 'req-tttttttu' }, PAGE)).handoff.state, 'queued');
  await assert.rejects(w.call('page_action', { op: 'to_person', id: a, request_id: 'req-tttttttv' }, PAGE), /Không có bản dựng nào đang dừng/);
  b.ticket(T1, { status: 'blocked' });
  await w.call('team_watch');
  const out = await w.call('page_action', { op: 'to_person', id: a, request_id: 'req-tttttttw' }, PAGE);
  assert.equal(out.handoff.state, 'task');
  assert.match(out.handoff.note, /còn nằm chưa commit/);
  const row = () => w.rows('handoffs').find(h => h.opportunity === a);
  assert.deepEqual([row().repo, row().ticket], [dir, T1]);
  // The half-done change is still in the checkout: the queued Go waits for the person.
  await w.call('team_watch');
  assert.equal(w.rows('handoffs').find(h => h.opportunity === c).state, 'queued');
  await w.call('page_action', { op: 'task_done', id: a, request_id: 'req-tttttttx' }, PAGE);
  assert.deepEqual((await w.call('team_watch')).changed, [{ ref: c, state: 'spawned' }]);
});
