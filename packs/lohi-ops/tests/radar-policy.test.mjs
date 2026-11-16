// The server half of auto-ingest: the radar policy inside catalog_jobs_sync, the translation it queues, and what
// translate_step / release_step / fix_recheck do so that no model is woken without work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/ops.mjs';
import { RADAR } from '../tools/lib/radar.mjs';
import { WAKE_COOLDOWN_H } from '../tools/lib/release.mjs';
import { fakeStore, fakeFetch, KEYED } from './helpers.mjs';

const NOW = Date.parse('2026-11-15T03:00:00Z');
const rows = (store, t) => store.tables.get(t) ?? [];
const state = (store, key) => rows(store, 'state').find(r => r.key === key)?.value ?? null;
const go = (name, input, o = {}) => run(name, { input }, { env: KEYED, store: o.store ?? fakeStore(), now: o.now ?? NOW, fetchImpl: o.fetch ?? fakeFetch({}) });
const status = readers => [200, { active_readers: readers, readers_threshold: 30, beyond_first_batch_allowed: readers >= 30 }];
const find = (store, source, novel, max, slug = novel) => store.insert('catalog_job_events', { job_id: `radar:${source}/${novel}`, state: 'radar', chapters: String(max), novel_slug: slug, at: '2026-11-15T02:00:00Z' });

test('radar policy: a carried novel with readers gets ONE approved refresh job for its last 50 chapters', async () => {
  const store = fakeStore();
  await find(store, 'ixdzs-hk', '568746', 120); await find(store, 'ixdzs-hk', 'empty', 80);
  const f = fakeFetch({ 'GET /novel/agent/novels/568746/litrans/status': status(12), 'GET /novel/agent/novels/empty/litrans/status': status(0) });
  const out = await go('catalog_jobs_sync', {}, { store, fetch: f });
  assert.deepEqual([out.radar.opened, out.radar.dropped], [1, 1]);
  const [job] = rows(store, 'catalog_jobs');
  assert.deepEqual([job.kind, job.state, job.approved_by, job.subject, job.novel_slug, job.chapters, job.request_id ?? null], ['refresh', 'approved', 'policy:radar', 'ixdzs-hk/568746#71-120', '568746', '71-120', null]);
  assert.equal(out.notify, false, 'a find wakes nobody');
  // a find for a novel whose refresh is still open is dropped, not doubled
  await find(store, 'ixdzs-hk', '568746', 125);
  assert.equal((await go('catalog_jobs_sync', {}, { store, fetch: f })).radar.opened, 0);
  assert.equal(rows(store, 'catalog_jobs').length, 1);
});

test('radar policy: the daily cap holds the rest for tomorrow; an unreachable api holds the find, not loses it', async () => {
  const store = fakeStore();
  const routes = {};
  for (let i = 0; i < RADAR.dailyJobs + 2; i++) { routes[`GET /novel/agent/novels/n${i}/litrans/status`] = status(5); await find(store, 's', `n${i}`, 60); }
  const f = fakeFetch(routes);
  const day1 = await go('catalog_jobs_sync', {}, { store, fetch: f });
  assert.deepEqual([day1.radar.opened, day1.radar.waiting, day1.radar.used], [RADAR.dailyJobs, 2, RADAR.dailyJobs]);
  const same = await go('catalog_jobs_sync', {}, { store, fetch: f });
  assert.equal(same.radar.opened, 0);
  const day2 = await go('catalog_jobs_sync', {}, { store, fetch: f, now: NOW + 86_400_000 });
  assert.deepEqual([day2.radar.opened, day2.radar.waiting], [2, 0]);
  // api down: nothing opened, the find waits in state
  const s2 = fakeStore(); await find(s2, 's', 'z', 60);
  const down = fakeFetch({ 'GET /novel/agent/novels/z/litrans/status': [503, {}] });
  const a = await go('catalog_jobs_sync', {}, { store: s2, fetch: down });
  assert.deepEqual([a.radar.opened, a.radar.waiting], [0, 1]);
  const up = fakeFetch({ 'GET /novel/agent/novels/z/litrans/status': status(3) });
  assert.equal((await go('catalog_jobs_sync', {}, { store: s2, fetch: up })).radar.opened, 1);
  // a novel the api does not know is dropped
  const s3 = fakeStore(); await find(s3, 's', 'gone', 60);
  assert.equal((await go('catalog_jobs_sync', {}, { store: s3, fetch: fakeFetch({}) })).radar.dropped, 1);
});

test('a done radar refresh queues the chapters it added, announced to readers once translated', async () => {
  const store = fakeStore();
  const id = await store.insert('catalog_jobs', { kind: 'refresh', state: 'running', approved_by: 'policy:radar', subject: 's/n#71-120', novel_slug: 'n', chapters: '71-120' });
  await store.insert('catalog_job_events', { job_id: id, state: 'done', novel_slug: 'n', chapters: '101-120', at: '2026-11-15T02:30:00Z' });
  const r = await go('catalog_jobs_sync', {}, { store });
  const [t] = rows(store, 'translations');
  assert.deepEqual([t.key, t.phase, t.from_chapter, t.to_chapter, t.rest_from ?? null, t.announce, t.request_id ?? null], ['n', 'wanted', 101, 110, 111, true, null]);
  assert.equal(r.changed[0].translate, '101-110'); assert.equal(r.notify, false);
  // chapters that arrive while a batch is in flight queue behind it
  const id2 = await store.insert('catalog_jobs', { kind: 'refresh', state: 'running', approved_by: 'policy:radar', subject: 's/n#121-125', novel_slug: 'n' });
  await store.insert('catalog_job_events', { job_id: id2, state: 'done', novel_slug: 'n', chapters: '121-125', at: '2026-11-15T02:40:00Z' });
  await go('catalog_jobs_sync', {}, { store });
  assert.equal(rows(store, 'translations').length, 1); assert.equal(rows(store, 'translations')[0].rest_to, 125);
});

test('translate_step: announces auto-ingested chapters, then chains the rest only for a novel with the readers', async () => {
  const mk = async readers => {
    const store = fakeStore();
    await store.insert('translations', { key: 'n', phase: 'pulling', job_id: 'jp', from_chapter: 101, to_chapter: 110, rest_from: 111, rest_to: 125, announce: true });
    const f = fakeFetch({
      'GET /novel/agent/novels/n/litrans/jobs/jp': [200, { job: { status: 'done' } }],
      'POST /novel/agent/onboard/novels/n/chapters/announce': [200, { ok: true }],
      'GET /novel/agent/novels/n/litrans/status': status(readers),
    });
    return { store, f, out: await go('translate_step', {}, { store, fetch: f }) };
  };
  const rich = await mk(40);
  assert.deepEqual(rich.f.calls.find(c => c.path.endsWith('/announce')).body.chapterNumbers, [101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
  assert.equal(rich.out.notify, false);
  const t = rows(rich.store, 'translations')[0];
  assert.deepEqual([t.phase, t.from_chapter, t.to_chapter, t.rest_from, t.rest_to], ['wanted', 111, 120, 121, 125]);
  const poor = await mk(3);
  const p = rows(poor.store, 'translations')[0];
  assert.deepEqual([p.phase, p.rest_from ?? null], ['done', null]);
  assert.match(p.detail, /111–125 chờ đủ 30 độc giả/);
  // a status the api cannot answer keeps the rest; the next tick asks again
  const store = fakeStore();
  await store.insert('translations', { key: 'n', phase: 'done', from_chapter: 101, to_chapter: 110, rest_from: 111, rest_to: 125 });
  await go('translate_step', {}, { store, fetch: fakeFetch({ 'GET /novel/agent/novels/n/litrans/status': [503, {}] }) });
  assert.equal(rows(store, 'translations')[0].rest_from, 111);
  await go('translate_step', {}, { store, fetch: fakeFetch({ 'GET /novel/agent/novels/n/litrans/status': status(50) }) });
  assert.equal(rows(store, 'translations')[0].phase, 'wanted');
});

test('translate_step: a stopped translation of an auto-ingested novel is a card, never a wake', async () => {
  const store = fakeStore();
  await store.insert('translations', { key: 'n', phase: 'wanted', from_chapter: 101, to_chapter: 110 });
  const f = fakeFetch({ 'POST /novel/agent/novels/n/translate': [422, { error: 'chapters_missing' }] });
  const out = await go('translate_step', {}, { store, fetch: f });
  assert.equal(out.notify, false);
  assert.match(out.ask.summary, /1 đợt dịch chưa thành/); assert.match(out.ask.missing, /n chương 101–110: chapters_missing/);
  const later = await go('translate_step', {}, { store, fetch: f, now: NOW + 4 * 86_400_000 });
  assert.equal(later.resolves_need, true);
});

test('release_step: an unanswered sample wakes the model once per cooldown, not every tick', async () => {
  const store = fakeStore();
  await store.insert('state', { key: 'release:moi', value: { phase: 'quality', from: 1, to: 10, attempt: 1, request_id: null } });
  const first = await go('release_step', {}, { store });
  assert.deepEqual([first.notify, first.to_judge.length], [true, 1]);
  const again = await go('release_step', {}, { store, now: NOW + 30 * 60_000 });
  assert.deepEqual([again.notify, again.to_judge.length], [false, 1]); // still listed, nobody woken
  const later = await go('release_step', {}, { store, now: NOW + (WAKE_COOLDOWN_H + 1) * 3_600_000 });
  assert.equal(later.notify, true);
  assert.ok(state(store, 'release:moi').woke_at);
});

test('fix_recheck: a pass or a card never wakes a model', async () => {
  const store = fakeStore();
  await store.insert('fix_checks', { key: 'a1', kind: 'fix_chapter', novel_slug: 'n', chapter: 3, state: 'pending_recheck', started_at: '2026-11-15T01:00:00Z' });
  await store.insert('fix_checks', { key: 'a2', kind: 'fix_chapter', novel_slug: 'n', chapter: 4, state: 'refused', detail: 'cap' });
  const f = fakeFetch({ 'GET /novel/agent/support-actions': [200, { items: [] }], 'GET /novel/agent/novels/n/chapters/3/health': [200, { health: { items: [{ number: 3, body: 'ok' }] } }] });
  const out = await go('fix_recheck', {}, { store, fetch: f });
  assert.equal(out.passed.length, 1); assert.equal(out.needs_person, 1);
  assert.equal(out.notify, false); assert.ok(out.ask);
});
