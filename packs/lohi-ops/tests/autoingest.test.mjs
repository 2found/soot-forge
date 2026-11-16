// The deterministic builder loop (autorun, no_source, needs_source), the radar and its policy, and the
// translate_step additions (announce, chained rest). Mocks only: in-memory store, catalog, fs, soot and api.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/ops.mjs';
import { RADAR, sweepPlan, carried } from '../tools/lib/radar.mjs';
import { NO_SOURCE_NOTE } from '../tools/lib/stage.mjs';
import { fakeStore, fakeFetch, fakeCatalog, KEYED } from './helpers.mjs';

const NOW = Date.parse('2026-11-15T03:00:00Z');
const R1 = '11111111-1111-4111-8111-111111111111';
const rows = (store, t) => store.tables.get(t) ?? [];
const state = (store, key) => rows(store, 'state').find(r => r.key === key)?.value ?? null;
const ENV = { ...KEYED, CLI_DIR: '/cli', SOOT_PACK_STATE: '/st', CLI_CATALOG_DB: '/cli/data/catalog.db' };

function memfs(files = {}) {
  return {
    files,
    async readFile(p) { if (p in files) return files[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    async stat(p) { if (p in files) return {}; throw new Error('ENOENT'); },
    async readdir() { return ['ixdzs-hk', 'piaotia-com']; },
    async mkdir() {}, async writeFile(p, c) { files[p] = c; },
  };
}
const SRC = { '/cli/data/sources/ixdzs-hk/config.json': '{"base_url":"https://ixdzs.hk"}', '/cli/data/sources/piaotia-com/config.json': '{"base_url":"https://www.piaotia.com"}' };

function fakeSoot({ jobs = [], failInsert = false } = {}) {
  const inserted = [];
  const soot = async args => {
    const flag = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
    if (args[1] === 'query') return { ok: true, json: { items: jobs } };
    if (args[1] === 'insert') { if (failInsert) return { ok: false, reason: 'soot_failed' }; inserted.push({ queue: flag('--queue'), row: JSON.parse(flag('--row')) }); return { ok: true, json: { id: 'e' } }; }
    return { ok: false };
  };
  return { soot, inserted };
}
const CATALOG = [
  { source: 'ixdzs-hk', novel: '568746', title: 'Thần Hoàng Vô Địch', landing_url: 'https://ixdzs.hk/read/568746/', prd: 1, fresh: 1 },
  { source: 'piaotia-com', novel: 'a-1', title: 'Đại Chúa Tể', landing_url: 'https://www.piaotia.com/bookinfo/1.html' },
  { source: 'ixdzs-hk', novel: 'b-2', title: 'Đại chúa tể', landing_url: 'https://ixdzs.hk/read/2/' },
  { source: 'ixdzs-hk', novel: 'ended', title: 'Đã Hết', prd: 1, status: 'completed', fresh: 1 },
  { source: 'ixdzs-hk', novel: 'bad', title: 'Vướng', prd: 1, copyright: 1 },
  { source: 'metruyenchuvn', novel: 'mt', title: 'Không radar', prd: 1 },
  { source: 'piaotia-com', novel: 'quiet', title: 'Yên Ắng', prd: 1 },
];
const CHAPTERS = [['ixdzs-hk', '568746', 1, 120], ['ixdzs-hk', 'ended', 1, 5], ['piaotia-com', 'quiet', 1, 40], ['piaotia-com', 'a-1', 1, 10]];
const J = (o = {}) => ({ id: 'j1', state: 'approved', product: 'lohi', kind: 'onboard', subject: `request/${R1}`, reason: 'r', request_id: R1, title: 'Thần Hoàng Vô Địch', ...o });

async function build(jobs, extra = {}) {
  const db = await fakeCatalog(CATALOG, CHAPTERS);
  const store = extra.store ?? fakeStore();
  const { soot, inserted } = fakeSoot({ jobs });
  const spawned = [];
  const files = extra.files ?? { ...SRC };
  const call = (name, input = {}, o = {}) => run(name, { input }, { env: ENV, store, now: o.now ?? NOW, fetchImpl: o.fetch ?? fakeFetch({}), soot, openDb: () => db, spawnJob: (argv, opts) => { spawned.push({ argv, opts }); return 99; }, fsImpl: memfs(files) });
  return { db, store, soot, inserted, spawned, call, files };
}

test('autorun: a request titled exactly like one catalog novel is onboarded as a draft, with no model', async () => {
  const b = await build([J()]);
  const out = await b.call('catalog_jobs_pull', { autorun: true });
  assert.deepEqual(out.started.map(s => s.id), ['j1']); assert.equal(out.notify, false);
  const plan = b.spawned[0].opts.plan;
  assert.equal(plan.kind, 'onboard'); assert.deepEqual([plan.source, plan.novel], ['ixdzs-hk', '568746']);
  assert.ok(plan.onboard_argv.join(' ').endsWith(`--request-id ${R1} --keep-draft`));
  assert.equal(b.inserted[0].row.state, 'running');
  assert.equal(state(b.store, 'job:j1').state, 'running');
  assert.equal((await b.call('catalog_jobs_pull', { autorun: true })).started.length, 0, 'not started twice');
});

test('a vague request is never onboarded blind: no_source, a fixed reader line, the donors refunded by the api', async () => {
  const b = await build([J({ title: 'Đại chúa tể' }), J({ id: 'j2', title: 'Kiếm' })]);
  const out = await b.call('catalog_jobs_pull', { autorun: true });
  assert.equal(b.spawned.length, 0);
  assert.deepEqual(out.started.map(s => s.failed), ['no_source', 'no_source']);
  assert.match(b.inserted[0].row.detail, /^no source:/);
  // the curator side: the event ends the onboard job, the api gets the failed stage with the cause and the one line
  const store = fakeStore();
  const id = await store.insert('catalog_jobs', { kind: 'onboard', state: 'approved', request_id: R1, title: 'Đại chúa tể' });
  await store.insert('catalog_job_events', { ...b.inserted[0].row, job_id: id });
  const f = fakeFetch({ [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true, refund: { refunded: 1 } }] });
  await run('catalog_jobs_sync', { input: {} }, { env: KEYED, store, now: NOW, fetchImpl: f });
  const call = f.calls.find(c => c.path.endsWith('/stage'));
  assert.deepEqual([call.body.stage, call.body.cause, call.body.note], ['failed', 'no_source', NO_SOURCE_NOTE]);
  assert.ok(NO_SOURCE_NOTE.length <= 300 && /link/.test(NO_SOURCE_NOTE));
  assert.equal(rows(store, 'request_outcomes')[0].outcome, 'no_source');
});

test('an unseen request link is the one judgment step: needs_source, answered with source + novel, guarded by the link host', async () => {
  const job = J({ source_url: 'https://ixdzs.hk/read/777/', title: 'Truyện lạ' });
  const b = await build([job]);
  const out = await b.call('catalog_jobs_pull', { autorun: true });
  assert.equal(out.notify, true);
  assert.equal(out.needs_source[0].source_hint, 'ixdzs-hk');
  assert.match(out.needs_source[0].instruction, /ixdzs\.hk\/read\/777/);
  assert.equal(state(b.store, 'job:j1').state, 'needs_source');
  assert.equal(b.spawned.length, 0);
  // not asked twice while waiting
  assert.deepEqual((await b.call('catalog_jobs_pull', { autorun: true })).needs_source, []);
  // a wrong site is refused, an unknown novel is refused, the right pick runs
  assert.equal((await b.call('catalog_job_run', { job_id: 'j1', source: 'piaotia-com', novel: 'a-1' })).error.code, 'source_mismatch');
  assert.equal((await b.call('catalog_job_run', { job_id: 'j1', source: 'ixdzs-hk', novel: 'nope' })).error.code, 'unknown_novel');
  await assert.rejects(b.call('catalog_job_run', { job_id: 'j1', source: 'ixdzs-hk', novel: 'x; rm' }), e => e.code === 'invalid_request');
  const ok = await b.call('catalog_job_run', { job_id: 'j1', source: 'ixdzs-hk', novel: 'b-2' });
  assert.equal(ok.executed, true); assert.equal(b.spawned[0].opts.plan.novel, 'b-2');
});

test('a needs_source job nobody answers ends no source after 24 hours', async () => {
  const b = await build([J({ source_url: 'https://ixdzs.hk/read/777/' })]);
  await b.call('catalog_jobs_pull', { autorun: true });
  const early = await b.call('catalog_jobs_pull', { autorun: true }, { now: NOW + 23 * 3_600_000 });
  assert.deepEqual(early.settled, []);
  const late = await b.call('catalog_jobs_pull', { autorun: true }, { now: NOW + 25 * 3_600_000 });
  assert.deepEqual(late.settled, [{ id: 'j1', state: 'failed', detail: 'no_source' }]);
  assert.match(b.inserted.at(-1).row.detail, /^no source:/);
});

test('autorun settles from the runner result: slug, chapters and copyright reach the event; max_start bounds the batch', async () => {
  const jobs = [1, 2, 3, 4].map(i => J({ id: `s${i}`, kind: 'refresh', subject: `ixdzs-hk/568746#${i}-${i + 9}`, request_id: null, title: null }));
  const b = await build(jobs);
  const out = await b.call('catalog_jobs_pull', { autorun: true, max_start: 2 });
  assert.equal(out.started.length, 2); assert.equal(out.waiting, 2);
  b.files['/st/catalog-jobs/s1/exit'] = '0\n';
  b.files['/st/catalog-jobs/s1/result.json'] = JSON.stringify({ state: 'done', detail: 'ok', novel_slug: '568746', chapters: '110-120' });
  b.files['/st/catalog-jobs/s2/exit'] = '0\n';
  b.files['/st/catalog-jobs/s2/result.json'] = JSON.stringify({ state: 'blocked_copyright', detail: 'x', copyright: 'Tencent' });
  const next = await b.call('catalog_jobs_pull', { autorun: true, max_start: 1 });
  assert.deepEqual(next.settled.map(s => [s.id, s.state]), [['s1', 'done'], ['s2', 'blocked_copyright']]);
  const ev = b.inserted.filter(e => e.row.state === 'done')[0].row;
  assert.deepEqual([ev.novel_slug, ev.chapters], ['568746', '110-120']);
  assert.equal(b.inserted.find(e => e.row.state === 'blocked_copyright').row.copyright, 'Tencent');
});

test('a job that can never start (unknown source) is ended once, not retried every 15 minutes', async () => {
  const b = await build([J({ kind: 'refresh', subject: 'nope-src/abc#1-5', request_id: null })]);
  const out = await b.call('catalog_jobs_pull', { autorun: true });
  assert.equal(out.notify, false);
  assert.match(b.inserted.at(-1).row.detail, /unknown_source/); assert.equal(b.inserted.at(-1).row.state, 'failed');
  assert.equal((await b.call('catalog_jobs_pull', { autorun: true })).started.length, 0);
});

// ---------- radar ----------
test('carried / sweepPlan: prod-synced, unfinished, no copyright flag, no metruyenchuvn; one radar step per source', async () => {
  const db = await fakeCatalog(CATALOG, CHAPTERS);
  assert.deepEqual(carried(db).map(r => `${r.source}/${r.novel}`), ['ixdzs-hk/568746', 'piaotia-com/quiet']);
  const plan = sweepPlan(carried(db));
  assert.equal(plan.stop_on_fail, false);
  assert.deepEqual(plan.steps.map(s => s.argv.slice(3, 8).join(' ') + ' ' + s.argv.at(-1)), ['crawl catalog radar --source ixdzs-hk 568746', 'crawl catalog radar --source piaotia-com quiet']);
  const many = sweepPlan(Array.from({ length: 45 }, (_, i) => ({ source: 's', novel: `n${i}` })));
  assert.equal(many.steps.length, 3);
});

test('radar_scan: starts one detached sweep, harvests finds as radar events, remembers baselines, waits between sweeps', async () => {
  const b = await build([]);
  const first = await b.call('radar_scan');
  assert.equal(first.started, true); assert.equal(first.notify, false);
  assert.equal(b.spawned.length, 1); assert.equal(b.spawned[0].opts.plan.steps.length, 2);
  assert.equal((await b.call('radar_scan')).running, true);
  assert.equal(b.spawned.length, 1);
  // the sweep ends
  const dir = state(b.store, 'radar').dir;
  b.files[`${dir}/exit`] = '0\n'; b.files[`${dir}/result.json`] = JSON.stringify({ state: 'done', detail: '2/2' });
  const harvest = await b.call('radar_scan');
  assert.deepEqual(harvest.found, ['ixdzs-hk/568746']);
  assert.deepEqual([b.inserted[0].queue, b.inserted[0].row.job_id, b.inserted[0].row.state, b.inserted[0].row.chapters, b.inserted[0].row.novel_slug], ['catalog_job_events', 'radar:ixdzs-hk/568746', 'radar', '120', '568746']);
  assert.equal(state(b.store, 'radar_seen')['piaotia-com/quiet'], 40); // a novel with nothing flagged only sets its baseline
  // gap: no new sweep within 2 hours; after it, the next one goes on from the offset
  assert.equal((await b.call('radar_scan', {}, { now: NOW + 3_600_000 })).waiting, true);
  assert.equal((await b.call('radar_scan', {}, { now: NOW + 3 * 3_600_000 })).started, true);
  assert.equal(b.spawned.length, 2);
});

test('radar_scan: a failed or never-finished sweep wakes once; a find already sent is not sent again', async () => {
  const b = await build([]);
  await b.call('radar_scan');
  const dir = state(b.store, 'radar').dir;
  b.files[`${dir}/exit`] = '1\n'; b.files[`${dir}/result.json`] = JSON.stringify({ state: 'failed', detail: 'none ok' });
  const bad = await b.call('radar_scan');
  assert.deepEqual([bad.failed, bad.notify], ['none ok', true]);
  const c = await build([]);
  await c.call('radar_scan');
  assert.equal((await c.call('radar_scan', {}, { now: NOW + 4 * 3_600_000 })).notify, true, 'stale sweep');
  // same find twice
  const d = await build([]);
  for (let i = 0; i < 2; i++) {
    await d.call('radar_scan', {}, { now: NOW + i * 6 * 3_600_000 });
    const dd = state(d.store, 'radar').dir; d.files[`${dd}/exit`] = '0\n'; d.files[`${dd}/result.json`] = '{"state":"done"}';
    await d.call('radar_scan', {}, { now: NOW + i * 6 * 3_600_000 });
  }
  assert.equal(d.inserted.filter(e => e.row.state === 'radar').length, 1);
});
