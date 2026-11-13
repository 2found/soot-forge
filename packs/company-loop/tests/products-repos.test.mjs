// One project per product (PRODUCT_REPOS) and the founder's choice of who builds: Soot's team or a person. A runtime that
// sets only PRODUCT_REPO behaves exactly as before (build.test.mjs, handoff.test.mjs pin that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, ITEM } from './world.mjs';
import { fakeBbs, scratchRepo } from './fixtures.mjs';
import { projectOf, buildsHere, hasBuild } from '../tools/lib/handoff.mjs';

const PAGE = { page: { page: 'company' } };
let n = 0;
const rid = () => `req-pr${String(++n).padStart(8, '0')}`;
const goOf = (w, ref, extra = {}) => w.call('page_action', { op: 'go', id: ref, request_id: rid(), ...extra }, PAGE);
const act = (w, op, ref, extra = {}) => w.call('page_action', { op, id: ref, request_id: rid(), ...extra }, PAGE);
async function setup(env = {}, items = [ITEM.product]) {
  const b = fakeBbs();
  const w = world({ env: { BBS_BIN: b.bin, ...env } });
  await w.call('digest_save', { opportunities: items });
  return { w, b, refs: w.rows('opportunities').map(o => o.ref) };
}

test('projectOf: a PRODUCT_REPOS line wins for its product (comma or newline), PRODUCT_REPO is the fallback, nothing is ""', () => {
  const env = { PRODUCT_REPOS: 'lohi=/a/lohi, 2novel = soot-team/2agent\nsach-hay=/x', PRODUCT_REPO: '/fallback' };
  assert.equal(projectOf(env, 'lohi'), '/a/lohi');
  assert.equal(projectOf(env, '2novel'), 'soot-team/2agent');
  assert.equal(projectOf(env, 'other'), '/fallback');
  assert.equal(projectOf({ PRODUCT_REPO: '/only' }, 'lohi'), '/only');
  assert.equal(projectOf({}, 'lohi'), '');
  assert.equal(projectOf({ PRODUCT_REPOS: 'lohi=' }, 'lohi'), '');
  assert.deepEqual([hasBuild({}), hasBuild({ PRODUCT_REPO: '/p' }), hasBuild({ PRODUCT_REPOS: 'a=/p' }), hasBuild({ PRODUCT_REPOS: 'a=' })], [false, true, true, false]);
});

test('buildsHere: PRODUCT_REPO alone keeps the old rule (a product run builds only itself); a PRODUCT_REPOS line names its product', () => {
  assert.equal(buildsHere({ PRODUCT_REPO: '/p' }, 'lohi'), true);
  assert.equal(buildsHere({ PRODUCT_REPO: '/p', SOOT_PRODUCT: '2novel' }, 'lohi'), false);
  assert.equal(buildsHere({ PRODUCT_REPO: '/p', SOOT_PRODUCT: 'lohi' }, 'lohi'), true);
  assert.equal(buildsHere({ PRODUCT_REPOS: 'lohi=/p' }, 'lohi'), true);
  assert.equal(buildsHere({ PRODUCT_REPOS: 'lohi=/p' }, '2novel'), false, 'a line for another product is not this one\'s repo');
  assert.equal(buildsHere({ PRODUCT_REPOS: 'lohi=/p', SOOT_PRODUCT: '2novel' }, 'lohi'), true);
  assert.equal(buildsHere({}, 'lohi'), false);
});

test('two products in two repos each build in their own repo', async () => {
  const lohi = scratchRepo(), other = scratchRepo();
  const { w, b, refs } = await setup({}, [ITEM.product, { ...ITEM.product, product: '2novel', title: 'Gợi ý truyện theo thể loại' }]);
  w.env.PRODUCT_REPOS = `lohi=${lohi},2novel=${other}`;
  for (const r of refs) assert.equal((await goOf(w, r)).handoff.state, 'spawned');
  const repos = Object.fromEntries(w.rows('handoffs').map(h => [h.product, h.repo]));
  assert.deepEqual(repos, { lohi, '2novel': other });
  const spawns = b.calls().filter(c => c.argv[1] === 'spawn');
  assert.deepEqual(spawns.map(c => c.cwd).sort(), [lohi, other].map(d => require_real(d)).sort());
});
const require_real = d => d.replace(/^\/var\//, '/private/var/'); // macOS tmp is a symlink; cwd reports the real path

test('a bbs workspace name resolves on this machine; an unresolvable one stops at no_repo with the reason and never falls back', async () => {
  const one = scratchRepo(), two = scratchRepo(), fallback = scratchRepo();
  const { w, b, refs } = await setup({ PRODUCT_REPO: fallback });
  const ref = refs[0];
  b.workspace('acme', [one, two]);
  const cases = [['acme', /có 2 kho/], ['nope', /không có workspace nope/], ['acme/missing', /không có kho missing/], ['a/b/c', /không phải đường dẫn tuyệt đối hay tên workspace/]];
  let first = true;
  for (const [project, why] of cases) {
    w.env.PRODUCT_REPOS = `lohi=${project}`;
    const out = first ? await goOf(w, ref) : await act(w, 'retry_handoff', ref);
    first = false;
    assert.equal(out.handoff.state, 'no_repo', project);
    assert.match(out.handoff.note, why);
    assert.match(out.handoff.note, /giao việc này cho người/);
  }
  assert.equal(b.calls().filter(c => c.argv[1] === 'spawn').length, 0);
  w.env.PRODUCT_REPOS = `lohi=acme/${two.split('/').pop()}`;
  assert.equal((await act(w, 'retry_handoff', ref)).handoff.state, 'spawned');
  assert.equal(w.rows('handoffs')[0].repo, two);
  // No bbs at all: a name cannot be resolved.
  const bare = world({ env: { PRODUCT_REPOS: 'lohi=acme', PATH: '/nonexistent', BBS_BIN: '/nonexistent/bbs' } });
  await bare.call('digest_save', { opportunities: [ITEM.product] });
  const out = await goOf(bare, bare.rows('opportunities')[0].ref);
  assert.equal(out.handoff.state, 'no_repo');
  assert.match(out.handoff.note, /chưa có bbs/);
});

test('Go: giao người làm records a task, writes and spawns nothing, and no build runtime pulls it; Để Soot dựng takes it back', async () => {
  const repo = scratchRepo();
  const { w, b, refs } = await setup({ PRODUCT_REPOS: `lohi=${repo}` });
  const view = await w.call('page_view', {}, PAGE);
  assert.equal(view.opportunities[0].build, true, 'a product with a project gets both Go buttons');
  const out = await goOf(w, refs[0], { build: 'person' });
  assert.equal(out.handoff.state, 'task');
  assert.match(out.handoff.note, /giao việc này cho người/);
  assert.equal(b.calls().filter(c => c.argv[0] === 'team').length, 0);
  assert.equal(w.rows('handoffs')[0].state, 'task');
  assert.equal(w.rows('decisions').filter(d => d.decision === 'go').length, 1);
  const hv = (await w.call('page_view', {}, PAGE)).handoffs[0];
  assert.deepEqual([hv.state, hv.person, hv.build], ['task', true, true]);
  assert.deepEqual(await w.call('team_watch'), { done: true });
  const back = await act(w, 'retry_handoff', refs[0]);
  assert.equal(back.handoff.state, 'spawned');
});

test('a product without a project gets one Go (no person button) and its Go is unchanged: approved for the workshop', async () => {
  const { w, refs } = await setup();
  const v = await w.call('page_view', {}, PAGE);
  assert.equal(v.opportunities[0].build, false);
  assert.equal((await goOf(w, refs[0])).handoff.state, 'approved');
  // The server can also hand an approved Go to a person, so the workshop never pulls it; the person can hand it back.
  assert.equal((await act(w, 'to_person', refs[0])).handoff.state, 'task');
  assert.equal(w.rows('handoffs')[0].state, 'task');
  assert.equal((await act(w, 'retry_handoff', refs[0])).handoff.state, 'approved');
});

test('to_person: only a build that is not running; a blocked team keeps its repo and says where the half-done change is', async () => {
  const repo = scratchRepo();
  const { w, refs } = await setup({ PRODUCT_REPOS: `lohi=${repo}` });
  const ref = refs[0];
  await goOf(w, ref);
  await assert.rejects(act(w, 'to_person', ref), /Không có bản dựng nào đang dừng/, 'spawned is running');
  const h = w.rows('handoffs')[0];
  await w.store.update('handoffs', h.id, { state: 'blocked', detail: 'Phát hành giai đoạn p1 lỗi' });
  const out = await act(w, 'to_person', ref);
  assert.equal(out.handoff.state, 'task');
  assert.match(out.handoff.note, new RegExp(`chưa commit trong ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(out.settle, [`company:handover:${ref}`, `company:unstarted:${ref}`]);
  assert.equal(w.rows('handoffs')[0].repo, repo);
  const done = await act(w, 'task_done', ref);
  assert.equal(done.handoff.state, 'released');
  await assert.rejects(act(w, 'to_person', ref), /Không có bản dựng nào đang dừng/);
});

test('draft_ready (no bbs/Orca) can go to a person; the build runtime\'s events never move a person\'s task', async () => {
  const repo = scratchRepo();
  const { w, b, refs } = await setup({ PRODUCT_REPOS: `lohi=${repo}` });
  b.failSpawn(true);
  assert.equal((await goOf(w, refs[0])).handoff.state, 'draft_ready');
  assert.equal((await act(w, 'to_person', refs[0])).handoff.state, 'task');
  const h = w.rows('handoffs')[0];
  await w.store.insert('handoff_events', { handoff: refs[0], state: 'shipped', product: 'lohi', at: new Date(w.now).toISOString() });
  await w.call('handoff_events_apply');
  assert.equal(w.rows('handoffs')[0].state, 'task', `stays with the person (${h.id})`);
});

test('builds_pull with PRODUCT_REPOS builds the rows of the products it has a project for and leaves the rest', async () => {
  const lohi = scratchRepo();
  const b = fakeBbs();
  const dir = mkdtempSync(join(tmpdir(), 'cl-pr-soot-'));
  const soot = join(dir, 'soot');
  const row = (ref, product) => ({ opportunity: ref, product, state: 'approved', requirement: `# REQ-${ref}: Việc của ${product}\n\nNội dung`, target_outcome: 'x', expected_delta: 1 });
  writeFileSync(soot, `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[1] === 'query') { process.stdout.write(JSON.stringify({ rows: ${JSON.stringify([row('OP-00000001', 'lohi'), row('OP-00000002', '2novel')])} })); process.exit(0); }\nconsole.log('{}');\n`);
  chmodSync(soot, 0o755);
  const w = world({ env: { PRODUCT_REPOS: `lohi=${lohi}`, BBS_BIN: b.bin, LOOP_SOOT_BIN: soot, SOOT_RUNTIME_URL: 'http://127.0.0.1:7788', SOOT_RUNTIME_TOKEN: 'srt_test-token-not-a-secret' } });
  const out = await w.call('builds_pull');
  assert.deepEqual(out.started, [{ handoff: 'OP-00000001', state: 'spawned' }]);
  assert.deepEqual(out.skipped, [{ handoff: 'OP-00000002', why: 'other_product' }]);
  assert.equal(w.rows('builds')[0].repo, lohi);
});
