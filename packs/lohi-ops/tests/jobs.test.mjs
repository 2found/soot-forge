import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/ops.mjs';
import { parseSubject, commandFor } from '../tools/lib/jobs.mjs';
import { fakeStore } from './helpers.mjs';

const NOW = Date.parse('2026-11-11T03:00:00Z');

/** A fake `soot data` CLI: per-item rows in, inserted rows recorded. */
function fakeSoot({ jobs = [], events = [], failInsert = false } = {}) {
  const inserted = [], queries = [];
  const soot = async args => {
    const [, verb] = args;
    const flag = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
    if (verb === 'query') {
      queries.push({ team: flag('--team'), item: flag('--item'), filter: flag('--filter') ? JSON.parse(flag('--filter')) : null });
      const rows = flag('--item') === 'catalog_jobs' ? jobs.filter(j => !flag('--filter') || j.state === JSON.parse(flag('--filter')).state) : events;
      return { ok: true, json: { items: rows } };
    }
    if (verb === 'insert') {
      if (failInsert) return { ok: false, json: null, reason: 'soot_failed' };
      inserted.push({ team: flag('--team'), queue: flag('--queue'), row: JSON.parse(flag('--row')) });
      return { ok: true, json: { id: 'e' } };
    }
    return { ok: false };
  };
  return { soot, inserted, queries };
}
const go = (name, input, o = {}) => run(name, { input }, { env: o.env ?? {}, store: o.store ?? fakeStore(), now: NOW, soot: o.soot, spawnJob: o.spawnJob, fsImpl: o.fsImpl });
const memfs = (files = {}) => ({
  files,
  async readFile(p) { if (p in files) return files[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  async stat(p) { if (p in files) return {}; throw new Error('ENOENT'); },
  async mkdir() {},
});

test('parseSubject: source/novel, repair needs a range, nothing else passes', () => {
  assert.deepEqual(parseSubject('ixdzs-hk/568746', 'crawl'), { source: 'ixdzs-hk', novel: '568746', chapters: null });
  assert.equal(parseSubject('piaotia-com/a_b-1#493-495', 'repair').chapters, '493-495');
  for (const [s, k] of [['ixdzs-hk', 'crawl'], ['a/b#1-2', 'crawl'], ['a/b', 'repair'], ['a/b#5-2', 'repair'], ['../x/y', 'crawl'], ['a/b c', 'crawl'], ['a/b;rm -rf', 'crawl'], ['A/b', 'crawl']]) {
    assert.throws(() => parseSubject(s, k), e => e.code === 'invalid_request', s);
  }
});

test('commands come only from the cli README forms; the rest are plans (runner.test.mjs)', () => {
  assert.deepEqual(commandFor('crawl', { source: 's', novel: 'n' }).slice(0, 8), ['npx', 'tsx', 'src/index.ts', 'crawl', 'catalog', 'run', '--source', 's']);
  assert.ok(commandFor('refresh', { source: 's', novel: 'n' }).includes('radar'));
  assert.equal(commandFor('onboard', { source: 's', novel: 'n' }), null);
  assert.equal(commandFor('repair', { source: 's', novel: 'n' }), null);
});

test('catalog_job_request: operator-approved call writes an approved row; a duplicate answers the open job', async () => {
  const store = fakeStore();
  const input = { kind: 'crawl', subject: 'ixdzs-hk/568746', reason: 'Truyện thiếu 40 chương ở cuối.' };
  const a = await go('catalog_job_request', input, { store });
  assert.equal(a.duplicate, false);
  const row = store.tables.get('catalog_jobs')[0];
  assert.equal(row.state, 'approved'); assert.equal(row.approved_by, 'operator'); assert.equal(row.product, 'lohi');
  const b = await go('catalog_job_request', input, { store });
  assert.equal(b.duplicate, true); assert.equal(store.tables.get('catalog_jobs').length, 1);
  // a finished job may be asked again
  row.state = 'done';
  assert.equal((await go('catalog_job_request', input, { store })).duplicate, false);
});

test('catalog_job_request refuses what the builder could not run', async () => {
  const store = fakeStore();
  for (const bad of [{ kind: 'delete', subject: 'a/b', reason: 'long enough reason' }, { kind: 'crawl', subject: 'a', reason: 'long enough reason' }, { kind: 'crawl', subject: 'a/b', reason: 'short' }, { kind: 'crawl', product: 'x', subject: 'a/b', reason: 'long enough reason' }, { kind: 'repair', subject: 'a/b', reason: 'long enough reason' }]) {
    await assert.rejects(go('catalog_job_request', bad, { store }), e => e.code === 'invalid_request');
  }
  assert.equal(store.tables.get('catalog_jobs'), undefined);
});

test('catalog_jobs_sync folds its own queue table into catalog_jobs, in order, once', async () => {
  const store = fakeStore();
  const id1 = await store.insert('catalog_jobs', { kind: 'crawl', subject: 'a/b', state: 'approved' });
  const id2 = await store.insert('catalog_jobs', { kind: 'crawl', subject: 'c/d', state: 'approved' });
  for (const e of [
    { job_id: id1, state: 'done', detail: 'exit 0', at: '2026-11-11T02:00:00Z' },
    { job_id: id1, state: 'running', detail: 'started', at: '2026-11-11T01:00:00Z' },
    { job_id: id2, state: 'running', detail: 'started', at: '2026-11-11T01:30:00Z' },
    { job_id: 'ghost', state: 'done', at: '2026-11-11T01:30:00Z' },
  ]) await store.insert('catalog_job_events', e);
  const { soot, queries } = fakeSoot();
  const out = await go('catalog_jobs_sync', {}, { store, soot, env: {} });
  assert.equal(queries.length, 0, 'the queue is read in place, not through soot data');
  assert.equal(out.notify, false, 'a done job needs no model line'); // only a failed job wakes
  const rows = store.tables.get('catalog_jobs');
  assert.equal(rows.find(r => r.id === id1).state, 'done'); assert.equal(rows.find(r => r.id === id2).state, 'running');
  const again = await go('catalog_jobs_sync', {}, { store, soot });
  assert.equal(again.changed.length, 0); assert.equal(again.notify, false);
  await store.insert('catalog_job_events', { job_id: id2, state: 'failed', detail: 'exit 2', at: '2026-11-11T03:00:00Z' });
  const third = await go('catalog_jobs_sync', {}, { store, soot });
  assert.deepEqual(third.changed.map(c => [c.id, c.state]), [[id2, 'failed']]); assert.equal(third.failed, 1); assert.equal(third.notify, true);
});

test('without a runtime token the builder pull is a quiet skip, not an error', async () => {
  for (const name of ['catalog_jobs_pull']) {
    const out = await go(name, {}, { env: {} });
    assert.equal(out.skipped, true); assert.equal(out.reason_code, 'no_runtime');
  }
});

test('catalog_jobs_pull asks for approved jobs only and hides those this Mac already started', async () => {
  const store = fakeStore();
  await store.insert('state', { key: 'job:j2', value: { state: 'running' } });
  const { soot, queries } = fakeSoot({ jobs: [
    { id: 'j1', state: 'approved', product: 'lohi', kind: 'crawl', subject: 'a/b', reason: 'thiếu chương' },
    { id: 'j2', state: 'approved', product: 'lohi', kind: 'crawl', subject: 'c/d', reason: 'x' },
    { id: 'j3', state: 'requested', product: 'lohi', kind: 'crawl', subject: 'e/f', reason: 'x' },
  ] });
  const out = await go('catalog_jobs_pull', {}, { store, soot, fsImpl: memfs() });
  assert.deepEqual(queries[0], { team: 'operations', item: 'catalog_jobs', filter: { state: 'approved' } });
  assert.deepEqual(out.jobs.map(j => j.id), ['j1']); assert.equal(out.notify, true);
});

test('catalog_job_run crawl: validates, spawns the cli command detached, records state and a running event', async () => {
  const store = fakeStore();
  const { soot, inserted } = fakeSoot({ jobs: [{ id: 'j1', state: 'approved', product: 'lohi', kind: 'crawl', subject: 'ixdzs-hk/568746', reason: 'r' }] });
  const spawned = [];
  const env = { CLI_DIR: '/cli', SOOT_PACK_STATE: '/state' };
  const out = await go('catalog_job_run', { job_id: 'j1' }, { env, store, soot, fsImpl: memfs({ '/cli/data/sources/ixdzs-hk/config.json': '{}' }), spawnJob: (cmd, o) => { spawned.push({ cmd, o }); return 4242; } });
  assert.equal(out.executed, true);
  assert.equal(spawned[0].o.cwd, '/cli'); assert.equal(spawned[0].cmd[5], 'run'); assert.ok(spawned[0].cmd.includes('568746'));
  assert.equal(inserted[0].queue, 'catalog_job_events'); assert.equal(inserted[0].row.state, 'running');
  assert.equal(store.tables.get('state')[0].value.pid, 4242);
  // second call: already started, nothing spawned
  const again = await go('catalog_job_run', { job_id: 'j1' }, { env, store, soot, fsImpl: memfs(), spawnJob: () => assert.fail('spawned twice') });
  assert.equal(again.reason_code, 'already_started');
});

test('catalog_job_run refuses what is not an approved lohi job with a known source', async () => {
  const jobs = [
    { id: 'p', state: 'approved', product: '2novel', kind: 'crawl', subject: 'a/b', reason: 'r' },
    { id: 's', state: 'approved', product: 'lohi', kind: 'crawl', subject: 'nope-src/b', reason: 'r' },
    { id: 'bad', state: 'approved', product: 'lohi', kind: 'crawl', subject: 'a/b; rm -rf ~', reason: 'r' },
  ];
  const { soot } = fakeSoot({ jobs });
  const base = { env: { CLI_DIR: '/cli', SOOT_PACK_STATE: '/s' }, soot, fsImpl: memfs(), spawnJob: () => assert.fail('must not spawn') };
  assert.equal((await go('catalog_job_run', { job_id: 'ghost' }, base)).error.code, 'not_approved');
  assert.equal((await go('catalog_job_run', { job_id: 'p' }, base)).error.code, 'unsupported_product');
  assert.equal((await go('catalog_job_run', { job_id: 's' }, base)).error.code, 'unknown_source');
  await assert.rejects(go('catalog_job_run', { job_id: 'bad' }, base), e => e.code === 'invalid_request');
  await assert.rejects(go('catalog_job_run', { job_id: '../x' }, base), e => e.code === 'invalid_request');
  const noCli = await go('catalog_job_run', { job_id: 's' }, { ...base, env: {} });
  assert.equal(noCli.skipped, true);
});

test('catalog_job_run repair: runs the deterministic overwrite plan, then the runner result closes it', async () => {
  const store = fakeStore();
  const { soot, inserted } = fakeSoot({ jobs: [{ id: 'r1', state: 'approved', product: 'lohi', kind: 'repair', subject: 'ixdzs-hk/568746#10-12', reason: 'r' }] });
  const spawned = [];
  const out = await go('catalog_job_run', { job_id: 'r1' }, { env: { CLI_DIR: '/cli', SOOT_PACK_STATE: '/st' }, store, soot, fsImpl: memfs({ '/cli/data/sources/ixdzs-hk/config.json': '{}' }), spawnJob: (argv, o) => { spawned.push({ argv, o }); return 7; } });
  assert.equal(out.executed, true);
  assert.ok(spawned[0].argv.join(' ').endsWith('--chapters 10-12 --chapters-only --overwrite --no-announce'));
  assert.equal(spawned[0].o.cwd, '/cli');
  const rep = await go('catalog_job_report', { job_id: 'r1', state: 'done', detail: '3 chương đã nhập lại' }, { store, soot });
  assert.equal(rep.ok, true); assert.equal(inserted.at(-1).row.state, 'done');
  assert.equal((await go('catalog_job_report', { job_id: 'r1', state: 'done' }, { store, soot })).reason_code, 'already_reported');
  assert.equal((await go('catalog_job_report', { job_id: 'zzz', state: 'done' }, { store, soot })).error.code, 'unknown_job');
  await assert.rejects(go('catalog_job_report', { job_id: 'r1', state: 'weird' }, { store, soot }), e => e.code === 'invalid_request');
});

test('catalog_jobs_pull reports how a started job ended (exit file), once; a failed insert retries next time', async () => {
  const store = fakeStore();
  await store.insert('state', { key: 'job:j1', value: { state: 'running', kind: 'crawl' } });
  const env = { SOOT_PACK_STATE: '/state' };
  const fsImpl = memfs({ '/state/catalog-jobs/j1/exit': '1\n', '/state/catalog-jobs/j1/log': 'a\nb\nError: 403 Attention Required\n' });
  const bad = fakeSoot({ failInsert: true });
  const first = await go('catalog_jobs_pull', {}, { env, store, soot: bad.soot, fsImpl });
  assert.equal(first.settled.length, 0);
  const ok = fakeSoot();
  const second = await go('catalog_jobs_pull', {}, { env, store, soot: ok.soot, fsImpl });
  assert.deepEqual(second.settled, [{ id: 'j1', state: 'failed' }]);
  assert.match(ok.inserted[0].row.detail, /exit 1.*403/);
  const third = await go('catalog_jobs_pull', {}, { env, store, soot: ok.soot, fsImpl });
  assert.equal(third.settled.length, 0); assert.equal(ok.inserted.length, 1);
  // still running (no exit file): nothing reported
  await store.insert('state', { key: 'job:j9', value: { state: 'running' } });
  assert.equal((await go('catalog_jobs_pull', {}, { env, store, soot: ok.soot, fsImpl })).settled.length, 0);
});
