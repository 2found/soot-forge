import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/ops.mjs';
import { parseJobInput, firstBatch } from '../tools/lib/jobs.mjs';
import { fakeStore, fakeFetch, KEYED } from './helpers.mjs';

const NOW = Date.parse('2026-11-12T03:00:00Z'); // 10:00 ICT
const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222', R3 = '33333333-3333-4333-8333-333333333333';
const SCHED = { source: 'schedule', subject: 'ops-onboard-card' };
const go = (name, input, o = {}) => run(name, { input, event: o.event }, { env: KEYED, store: o.store ?? fakeStore(), now: o.now ?? NOW, fetchImpl: o.fetch, soot: o.soot });
const rows = (store, t) => store.tables.get(t) ?? [];

test('requests_pending attaches a published novel and merges an exact duplicate, without a model', async () => {
  const f = fakeFetch({
    'GET /novel/agent/requests/pending': [200, { items: [
      { id: R1, title: 'Đấu Phá Thương Khung', priority: 'paid' },
      { id: R2, title: 'Dau pha thuong khung', priority: 'normal' },
      { id: R3, title: 'Truyện chưa có', priority: 'normal' }], next_cursor: null }],
    'GET /novel/agent/novels': u => [200, u.searchParams.get('title') === 'Truyện chưa có' ? { exists: false } : { exists: false }],
    [`POST /novel/agent/requests/${R2}/merge`]: [200, { success: true }],
  });
  const store = fakeStore();
  const r = await go('requests_pending', {}, { store, fetch: f });
  assert.deepEqual(r.auto_resolved.map(a => a.action), ['merge']);
  assert.equal(r.auto_resolved[0].into, R1);
  assert.deepEqual(r.items.map(i => i.id), [R1, R3]);
  assert.equal(r.paid, 1);
  assert.equal(rows(store, 'request_outcomes')[0].outcome, 'merged');
  assert.equal(f.calls.find(c => c.path.endsWith('/merge')).body.targetId, R1);
});

test('requests_pending: a published novel with chapters is attached then done; a draft is left to the model', async () => {
  const f = fakeFetch({
    'GET /novel/agent/requests/pending': [200, { items: [{ id: R1, title: 'Có Sẵn' }, { id: R2, title: 'Bản Nháp' }] }],
    'GET /novel/agent/novels': u => [200, u.searchParams.get('title') === 'Có Sẵn' ? { exists: true, status: 'published', slug: 'co-san', chapterCount: 50 } : { exists: true, status: 'draft', slug: 'ban-nhap', chapterCount: 3 }],
    [`POST /novel/agent/requests/${R1}/attach-novel`]: [200, { success: true }],
    [`POST /novel/agent/requests/${R1}/done`]: [200, { success: true }],
  });
  const store = fakeStore();
  const r = await go('requests_pending', {}, { store, fetch: f });
  assert.deepEqual(r.auto_resolved, [{ id: R1, title: 'Có Sẵn', action: 'attach', novel_slug: 'co-san' }]);
  assert.deepEqual(r.items.map(i => i.id), [R2]);
  assert.equal(f.calls.find(c => c.path.endsWith('/attach-novel')).body.novelSlug, 'co-san');
  assert.equal(rows(store, 'request_outcomes')[0].outcome, 'attached');
  // the chapters type does no auto-resolve
  const g = fakeFetch({ 'GET /novel/agent/requests/pending': [200, { items: [{ id: R3, title: 'x' }] }] });
  const c = await go('requests_pending', { type: 'chapters' }, { fetch: g });
  assert.equal(c.items.length, 1);
  assert.equal(g.calls.length, 1);
});

test('accepting a refresh opens an approved job; an onboard waits as requested; a bad job leaves the request pending', async () => {
  const f = fakeFetch({ [`POST /novel/agent/requests/${R1}/approve`]: [200, { success: true }], [`POST /novel/agent/requests/${R2}/approve`]: [200, { success: true }] });
  const store = fakeStore();
  const a = await go('request_accept', { id: R1, kind: 'refresh', title: 'Dài Thêm', novel_slug: 'dai-them', chapters: '120-140' }, { store, fetch: f });
  assert.equal(a.job.state, 'approved');
  const b = await go('request_accept', { id: R2, kind: 'onboard', title: 'Mới Toanh', source_url: 'https://example.test/book/1' }, { store, fetch: f });
  assert.equal(b.job.state, 'requested');
  const [j1, j2] = rows(store, 'catalog_jobs');
  assert.deepEqual([j1.kind, j1.request_id, j1.novel_slug, j1.chapters, j1.approved_by], ['refresh', R1, 'dai-them', '120-140', 'policy:refresh']);
  assert.deepEqual([j2.kind, j2.request_id, j2.source_url, j2.approved_by], ['onboard', R2, 'https://example.test/book/1', null]);
  assert.equal(j1.subject, `request/${R1}#120-140`);
  // same request again: no second job
  assert.equal((await go('request_accept', { id: R2, kind: 'onboard', title: 'Mới Toanh' }, { store, fetch: f })).job.duplicate, true);
  // a refresh without the novel it refreshes is refused before the api moves the request
  const g = fakeFetch({});
  await assert.rejects(go('request_accept', { id: R3, kind: 'refresh', title: 'x' }, { fetch: g }), e => e.code === 'invalid_request');
  assert.equal(g.calls.length, 0);
});

test('onboard_card: ONE structured card a day; its option tools approve or decline, once, without a second approval', async () => {
  const store = fakeStore();
  await store.insert('catalog_jobs', { kind: 'onboard', state: 'requested', title: 'A', request_id: R1, copyright: 'không trùng' });
  await store.insert('catalog_jobs', { kind: 'onboard', state: 'requested', title: 'B', request_id: R2 });
  await store.insert('catalog_jobs', { kind: 'refresh', state: 'approved', title: 'C' });
  const first = await go('onboard_card', {}, { store, event: SCHED });
  assert.equal(first.pending, 2);
  assert.equal(first.ask, undefined);
  const card = first.raise;
  assert.match(card.id, /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,127}$/);
  assert.ok(card.title.length <= 200 && card.why.length <= 1500 && card.options.length <= 6);
  assert.ok(card.why.includes('A') && card.why.includes('B') && !card.why.includes('C'));
  assert.match(card.why, /không trùng/);
  const [approve, decline, later] = card.options;
  assert.equal(approve.tool.name, 'catalog_jobs_answer');
  assert.equal(approve.tool.pack, 'lohi-ops');
  assert.ok(JSON.stringify(approve.tool.input).length < 2048);
  assert.equal(later.tool, undefined);
  assert.equal(later.wake, undefined);
  const again = await go('onboard_card', {}, { store, event: SCHED });
  assert.equal(again.carded_today, true);
  assert.equal(again.raise, undefined);
  // the click: approve runs with the card's nonce, once; a second click or a forged nonce is refused
  const forged = await go('catalog_jobs_answer', { action: 'approve', nonce: 'x' }, { store, event: SCHED });
  assert.equal(forged.ok, false);
  const modelCall = await go('catalog_jobs_answer', approve.tool.input, { store, event: { source: 'chat', subject: 't' } });
  assert.equal(modelCall.ok, false);
  assert.equal(rows(store, 'catalog_jobs')[0].state, 'requested');
  const d = await go('catalog_jobs_answer', approve.tool.input, { store, event: SCHED });
  assert.equal(d.changed.length, 2);
  const jobs = rows(store, 'catalog_jobs');
  assert.deepEqual(jobs.map(j => j.state), ['approved', 'approved', 'approved']);
  assert.equal(jobs[0].approved_by, 'operator');
  assert.equal((await go('catalog_jobs_answer', approve.tool.input, { store, event: SCHED })).ok, false);
  // decline path, on a new day's card
  const store2 = fakeStore();
  await store2.insert('catalog_jobs', { kind: 'onboard', state: 'requested', title: 'A', request_id: R1 });
  const c2 = (await go('onboard_card', {}, { store: store2, event: SCHED })).raise;
  await go('catalog_jobs_answer', c2.options[1].tool.input, { store: store2, event: SCHED });
  assert.equal(rows(store2, 'catalog_jobs')[0].state, 'declined');
  // the gated chat path stays
  const store3 = fakeStore();
  await store3.insert('catalog_jobs', { kind: 'onboard', state: 'requested', title: 'A', request_id: R1 });
  const id = rows(store3, 'catalog_jobs')[0].id;
  assert.deepEqual((await go('catalog_jobs_decide', { action: 'approve', ids: [id] }, { store: store3 })).changed, [id]);
});

test('onboard_card: a model call (not the schedule) raises nothing and spends no day', async () => {
  const store = fakeStore();
  await store.insert('catalog_jobs', { kind: 'onboard', state: 'requested', title: 'A', request_id: R1 });
  const r = await go('onboard_card', {}, { store, event: { source: 'chat', subject: 't' } });
  assert.equal(r.refused, 'schedule_only');
  assert.equal(r.raise, undefined);
  assert.equal(rows(store, 'state').length, 0);
  assert.ok((await go('onboard_card', {}, { store, event: SCHED })).raise);
});

test('onboard_card: nothing requested raises nothing and spends no day', async () => {
  const store = fakeStore();
  const r = await go('onboard_card', {}, { store, event: SCHED });
  assert.equal(r.pending, 0);
  assert.equal(r.raise, undefined);
  await store.insert('catalog_jobs', { kind: 'onboard', state: 'requested', title: 'A', request_id: R1 });
  assert.ok((await go('onboard_card', {}, { store, event: SCHED })).raise);
});

test('catalog_job_report: blocked_copyright needs the match; done onboard needs the slug; the stop becomes a card', async () => {
  const store = fakeStore();
  await store.insert('state', { key: 'job:j1', value: { state: 'handed_over', kind: 'onboard' } });
  await store.insert('state', { key: 'job:j2', value: { state: 'handed_over', kind: 'onboard' } });
  const soot = async args => ({ ok: true, json: { items: [] }, args });
  const sent = [];
  const rec = async a => { if (a[1] === 'insert') sent.push(JSON.parse(a[a.indexOf('--row') + 1])); return { ok: true, json: {} }; };
  await assert.rejects(run('catalog_job_report', { input: { job_id: 'j1', state: 'blocked_copyright' } }, { env: {}, store, now: NOW, soot: rec }), e => e.code === 'invalid_request');
  await assert.rejects(run('catalog_job_report', { input: { job_id: 'j1', state: 'done' } }, { env: {}, store, now: NOW, soot: rec }), e => e.code === 'invalid_request');
  await run('catalog_job_report', { input: { job_id: 'j1', state: 'blocked_copyright', copyright: 'Tencent Reading giữ bản quyền' } }, { env: {}, store, now: NOW, soot: rec });
  await run('catalog_job_report', { input: { job_id: 'j2', state: 'done', novel_slug: 'moi', chapters: '1-10' } }, { env: {}, store, now: NOW, soot: rec });
  assert.deepEqual(sent.map(s => [s.state, s.novel_slug ?? null, s.chapters ?? null]), [['blocked_copyright', null, null], ['done', 'moi', '1-10']]);
  void soot;
});

test('catalog_jobs_sync: a done onboard queues the first 10 chapters; a copyright stop is one card and an outcome', async () => {
  const store = fakeStore();
  const j1 = await store.insert('catalog_jobs', { kind: 'onboard', state: 'running', request_id: R1, title: 'Mới' });
  const j2 = await store.insert('catalog_jobs', { kind: 'onboard', state: 'running', request_id: R2, title: 'Vướng' });
  await store.insert('catalog_job_events', { job_id: j1, state: 'done', novel_slug: 'moi', chapters: '1-30', at: '2026-11-12T01:00:00Z' });
  await store.insert('catalog_job_events', { job_id: j2, state: 'blocked_copyright', copyright: 'trùng nền tảng X', at: '2026-11-12T01:01:00Z' });
  const f = fakeFetch({
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true }],
    [`POST /novel/agent/requests/${R2}/stage`]: [200, { success: true, changed: true, refund: { refunded: 2, lt: 120, alreadyRefunded: 0 } }],
  });
  const r = await go('catalog_jobs_sync', {}, { store, fetch: f });
  const t = rows(store, 'translations')[0];
  assert.deepEqual([t.key, t.request_id, t.phase, t.from_chapter, t.to_chapter], ['moi', R1, 'wanted', 1, 10]);
  // The request's stage on the api: translating for the onboarded one, failed (refunded there) for the stopped one.
  const stages = f.calls.filter(c => c.path.endsWith('/stage')).map(c => [c.path.split('/')[4], c.body.stage, c.body.cause ?? null]);
  assert.deepEqual(stages, [[R1, 'translating', null], [R2, 'failed', 'blocked_copyright']]);
  assert.equal(r.blocked_copyright, 1);
  assert.match(r.ask.missing, /trùng nền tảng X/);
  assert.equal(rows(store, 'request_outcomes')[0].outcome, 'blocked_copyright');
  assert.deepEqual(firstBatch('21-60'), { from: 21, to: 30 });
  assert.deepEqual(firstBatch('3-5'), { from: 3, to: 5 });
});

test('translate_step walks translate, pull, translated; a cap waits instead of failing', async () => {
  const store = fakeStore();
  await store.insert('translations', { key: 'moi', request_id: R1, phase: 'wanted', from_chapter: 1, to_chapter: 10 });
  let jobStatus = 'queued';
  const f = fakeFetch({
    'POST /novel/agent/novels/moi/translate': [202, { job: { id: 'jt' } }],
    'GET /novel/agent/novels/moi/litrans/jobs/jt': () => [200, { job: { status: jobStatus } }],
    'POST /novel/agent/novels/moi/litrans/pull': [202, { job: { id: 'jp' } }],
    'GET /novel/agent/novels/moi/litrans/jobs/jp': [200, { job: { status: 'done' } }],
    [`POST /novel/agent/requests/${R1}/translated`]: [200, { success: true }],
  });
  assert.equal((await go('translate_step', {}, { store, fetch: f })).moved[0].phase, 'queued');
  assert.deepEqual((await go('translate_step', {}, { store, fetch: f })).moved, []); // job still queued
  jobStatus = 'done';
  assert.equal((await go('translate_step', {}, { store, fetch: f })).moved[0].phase, 'pulling');
  const last = await go('translate_step', {}, { store, fetch: f });
  assert.equal(last.moved[0].phase, 'done');
  assert.equal(last.notify, false, 'tool-only: a finished translation wakes no model');
  assert.equal(rows(store, 'request_outcomes')[0].outcome, 'translated');
  assert.equal(f.calls.find(c => c.path.endsWith('/translate')).body.to, 10);
  // the api refuses with its cap: the row stays wanted
  const s2 = fakeStore();
  await s2.insert('translations', { key: 'full', phase: 'wanted', from_chapter: 1, to_chapter: 10 });
  const capped = fakeFetch({ 'POST /novel/agent/novels/full/translate': [429, { error: 'novel_daily_cap' }] });
  const c = await go('translate_step', {}, { store: s2, fetch: capped });
  assert.deepEqual(c.moved, []);
  assert.equal(rows(s2, 'translations')[0].phase, 'wanted');
});

test('translate_step: a stopped translation of a request posts the failed stage; one without a request posts nothing', async () => {
  const store = fakeStore();
  await store.insert('translations', { key: 'moi', request_id: R1, phase: 'queued', from_chapter: 1, to_chapter: 10, job_id: 'jt' });
  await store.insert('translations', { key: 'le', request_id: null, phase: 'queued', from_chapter: 3, to_chapter: 4, job_id: 'jl' });
  const f = fakeFetch({
    'GET /novel/agent/novels/moi/litrans/jobs/jt': [200, { job: { status: 'failed', error: 'provider down' } }],
    'GET /novel/agent/novels/le/litrans/jobs/jl': [200, { job: { status: 'canceled' } }],
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true, refund: { refunded: 1, lt: 50, alreadyRefunded: 0 } }],
  });
  const r = await go('translate_step', {}, { store, fetch: f });
  assert.deepEqual(r.moved.map(m => m.phase), ['failed', 'failed']);
  const stages = f.calls.filter(c => c.path.endsWith('/stage'));
  assert.equal(stages.length, 1);
  assert.equal(stages[0].path.split('/')[4], R1);
  assert.deepEqual([stages[0].body.stage, stages[0].body.cause], ['failed', 'failed']);
  assert.match(stages[0].body.note, /Dịch chương 1–10 chưa thành/);
  assert.doesNotMatch(stages[0].body.note, /provider down/); // the operator log stays on the row
});

test('translate_start: at most 10 chapters, and past the first batch only with enough readers', async () => {
  await assert.rejects(go('translate_start', { slug: 'x', from: 1, to: 11 }), e => e.code === 'invalid_request');
  const quiet = fakeFetch({ 'GET /novel/agent/novels/x/litrans/status': [200, { beyond_first_batch_allowed: false, readers_threshold: 50, active_readers: 3 }] });
  const no = await go('translate_start', { slug: 'x', from: 11, to: 20, beyond_first_batch: true }, { fetch: quiet });
  assert.equal(no.error.code, 'not_enough_readers');
  const busy = fakeFetch({ 'GET /novel/agent/novels/x/litrans/status': [200, { beyond_first_batch_allowed: true }] });
  const store = fakeStore();
  assert.equal((await go('translate_start', { slug: 'x', from: 11, to: 20, beyond_first_batch: true }, { store, fetch: busy })).queued, true);
  assert.equal((await go('translate_start', { slug: 'x', from: 11, to: 20 }, { store })).duplicate, true);
});

test('fix: execute within the caps, re-check pass closes it, re-check fail and a wide scope raise ONE card', async () => {
  const A1 = 'aaaaaaaa-1111-4111-8111-111111111111', A2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const store = fakeStore();
  const list = [200, { items: [
    { id: A1, kind: 'requeue_tts', params: { novelSlug: 'moi', chapterNumber: 7 }, chapters: 1, wide: false },
    { id: A2, kind: 'requeue_crawl', params: { novelSlug: 'rong', fromChapter: 1, toChapter: 90 }, chapters: 90, wide: true }] }];
  let health = { items: [{ number: 7, body: 'ok', audio: 'too_short' }] };
  const f = fakeFetch({
    'GET /novel/agent/support-actions': list,
    [`POST /novel/agent/support-actions/${A1}/execute`]: [200, { status: 'approved' }],
    'GET /novel/agent/novels/moi/chapters/7/health': () => [200, { health }],
  });
  const ok = await go('fix_execute', { id: A1 }, { store, fetch: f });
  assert.equal(ok.executed, true);
  const wide = await go('fix_execute', { id: A2 }, { store, fetch: f });
  assert.equal(wide.wide, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/execute')).length, 1); // the wide one never reaches the api
  // too early: nothing looked at
  assert.deepEqual((await go('fix_recheck', {}, { store, fetch: f, now: NOW + 60_000 })).passed, []);
  // after 10 min: still defective, so not passed; the wide scope is the one card
  const later = NOW + 11 * 60_000;
  const still = await go('fix_recheck', {}, { store, fetch: f, now: later });
  assert.deepEqual(still.passed, []);
  assert.equal(still.needs_person, 1);
  assert.match(still.ask.missing, /rong/);
  // fixed now: pass
  health = { items: [] };
  const pass = await go('fix_recheck', {}, { store, fetch: f, now: later + 60_000 });
  assert.deepEqual(pass.passed, [{ slug: 'moi', chapter: 7, kind: 'requeue_tts' }]);
  assert.equal(rows(store, 'fix_checks').find(r => r.key === A1).state, 'passed');
  // never fixed within 6 hours: failed, and a card for it too
  const s2 = fakeStore();
  await go('fix_execute', { id: A1 }, { store: s2, fetch: f });
  health = { items: [{ number: 7, body: 'ok', audio: 'placeholder' }] };
  const fail = await go('fix_recheck', {}, { store: s2, fetch: f, now: NOW + 7 * 3_600_000 });
  assert.equal(rows(s2, 'fix_checks').find(r => r.key === A1).state, 'failed');
  // the failed fix, and the wide action still pending that nobody ran: fix_recheck cards it without a model
  assert.equal(fail.needs_person, 2);
  assert.equal(rows(s2, 'fix_checks').find(r => r.key === A2).state, 'wide');
});

test('fixes_pull wakes a model only for a row it can run (F5)', async () => {
  const A1 = 'aaaaaaaa-1111-4111-8111-111111111111', A2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const wideOnly = fakeFetch({ 'GET /novel/agent/support-actions': [200, { items: [{ id: A2, kind: 'requeue_crawl', params: { novelSlug: 'rong', fromChapter: 1, toChapter: 90 }, chapters: 90, wide: true }] }] });
  const quiet = await go('fixes_pull', {}, { fetch: wideOnly });
  assert.deepEqual([quiet.notify, quiet.runnable, quiet.wide], [false, 0, 1]);
  const mixed = fakeFetch({ 'GET /novel/agent/support-actions': [200, { items: [
    { id: A1, kind: 'requeue_tts', params: { novelSlug: 'moi', chapterNumber: 7 }, chapters: 1, wide: false },
    { id: A2, kind: 'requeue_crawl', params: { novelSlug: 'rong', fromChapter: 1, toChapter: 90 }, chapters: 90, wide: true }] }] });
  const loud = await go('fixes_pull', {}, { fetch: mixed });
  assert.deepEqual([loud.notify, loud.runnable, loud.wide], [true, 1, 1]);
});

test('fix_execute: a failed run (502 execute_failed, no reason) becomes a card, not a silent drop', async () => {
  const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const f = fakeFetch({
    'GET /novel/agent/support-actions': [200, { items: [{ id: A1, kind: 'requeue_crawl', params: { novelSlug: 'm', fromChapter: 2, toChapter: 2 }, chapters: 1, wide: false }] }],
    [`POST /novel/agent/support-actions/${A1}/execute`]: [502, { error: 'execute_failed' }],
  });
  const store = fakeStore();
  assert.equal((await go('fix_execute', { id: A1 }, { store, fetch: f })).ok, false);
  assert.equal(rows(store, 'fix_checks')[0].state, 'refused');
});

test('fix_execute: an api refusal (cap, wrong kind) is stored and said, not retried', async () => {
  const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const f = fakeFetch({
    'GET /novel/agent/support-actions': [200, { items: [{ id: A1, kind: 'requeue_tts', params: { novelSlug: 'm', chapterNumber: 2 }, chapters: 1, wide: false }] }],
    [`POST /novel/agent/support-actions/${A1}/execute`]: [429, { error: 'daily_cap' }],
  });
  const store = fakeStore();
  const r = await go('fix_execute', { id: A1 }, { store, fetch: f });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'daily_cap');
  assert.equal(rows(store, 'fix_checks')[0].state, 'refused');
  assert.equal((await go('fix_execute', { id: R3 }, { fetch: f })).error.code, 'not_pending');
});

test('fix: a room-filed report (origin room_report, no support thread) is pulled and executed like any other', async () => {
  const A1 = 'cccccccc-3333-4333-8333-333333333333';
  const item = { id: A1, kind: 'requeue_tts', params: { novelSlug: 'phong', chapterNumber: 6, voiceId: 'v' }, cause: 'room report: audio', origin: 'room_report', chapters: 1, wide: false };
  const f = fakeFetch({
    'GET /novel/agent/support-actions': [200, { items: [item] }],
    [`POST /novel/agent/support-actions/${A1}/execute`]: [200, { status: 'executed', result: { dispatchId: 'd1' } }],
  });
  const store = fakeStore();
  const pulled = await go('fixes_pull', {}, { store, fetch: f });
  assert.equal(pulled.items[0].origin, 'room_report');
  const r = await go('fix_execute', { id: A1 }, { store, fetch: f });
  assert.equal(r.executed, true);
  assert.equal(r.status, 'executed');
  assert.equal(rows(store, 'fix_checks').find(x => x.key === A1).state, 'pending_recheck');
});

test('fixes_run (WP7): runs what the api will run with no model, wakes the model once per review task, cards holds', async () => {
  const T = 'dddddddd-1111-4111-8111-111111111111', V = 'eeeeeeee-2222-4222-8222-222222222222', P = 'ffffffff-3333-4333-8333-333333333333', W = 'aaaaaaaa-4444-4444-8444-444444444444';
  const items = [
    { id: T, kind: 'fix_chapter', mode: 'replace', params: { novelSlug: 'm', chapterNumber: 4 }, chapters: 1, wide: false, needs_review: false, needs_person: false, reporter_count: 2 },
    { id: V, kind: 'fix_chapter', mode: 'review', params: { novelSlug: 'm', chapterNumber: 5, issue: { type: 'content', detail: 'bad_translation' } }, chapters: 1, wide: false, needs_review: true, needs_person: false, reporter_count: 3 },
    { id: P, kind: 'fix_chapter', mode: 'replace', params: { novelSlug: 'm', chapterNumber: 6 }, chapters: 1, wide: false, needs_review: false, needs_person: true, hold: 'quote_too_long' },
    { id: W, kind: 'requeue_crawl', params: { novelSlug: 'm', fromChapter: 1, toChapter: 40 }, chapters: 40, wide: true },
  ];
  const f = fakeFetch({
    'GET /novel/agent/support-actions': [200, { items }],
    [`POST /novel/agent/support-actions/${T}/execute`]: [200, { status: 'executed' }],
  });
  const store = fakeStore();
  const r = await go('fixes_run', {}, { store, fetch: f });
  assert.deepEqual(r.ran, [{ id: T, executed: true, status: 'executed' }]);
  assert.deepEqual(r.to_review.map(i => [i.id, i.reporter_count, i.issue.detail]), [[V, 3, 'bad_translation']]);
  assert.equal(r.notify, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/execute')).length, 1); // the hold, the wide one and the review never execute
  // the next pass: nothing new to run, the review task is not sent again
  const again = await go('fixes_run', {}, { store, fetch: f });
  assert.deepEqual([again.ran.length, again.to_review.length, again.notify], [0, 0, false]);
  // fix_recheck cards the hold and the wide scope with no model; an unresolved review becomes a card after 6 h
  const later = await go('fix_recheck', {}, { store, fetch: f, now: NOW + 7 * 3_600_000 });
  assert.equal(rows(store, 'fix_checks').find(x => x.key === P).state, 'refused');
  assert.equal(rows(store, 'fix_checks').find(x => x.key === V).state, 'refused');
  assert.equal(later.needs_person, 3);
});

test('fix_context and fix_resolve (WP7): read the task, then one decision; a refusal is a card', async () => {
  const V = 'eeeeeeee-2222-4222-8222-222222222222';
  const f = fakeFetch({
    [`GET /novel/agent/support-actions/${V}/context`]: [200, { id: V, reporter_count: 2, chapter: { text: 'Lâm Phong bước vào.' } }],
    [`POST /novel/agent/support-actions/${V}/resolve`]: () => {
      const body = f.calls.at(-1).body;
      return body.find === 'không có' ? [422, { error: 'quote_not_found', needs_person: true }] : [200, { status: body.outcome === 'not_reproduced' ? 'denied' : 'executed' }];
    },
  });
  const ctx = await go('fix_context', { id: V }, { fetch: f });
  assert.equal(ctx.chapter.text, 'Lâm Phong bước vào.');
  const store = fakeStore();
  const ok = await go('fix_resolve', { id: V, outcome: 'replace', find: 'Lâm Phong', replace: 'Lạc Phong', reason: 'tên nhân vật sai' }, { store, fetch: f });
  assert.deepEqual([ok.ok, ok.status], [true, 'executed']);
  const sent = f.calls.find(c => c.path.endsWith('/resolve')).body;
  assert.deepEqual(sent, { outcome: 'replace', reason: 'tên nhân vật sai', find: 'Lâm Phong', replace: 'Lạc Phong' });
  assert.equal(rows(store, 'fix_checks').find(x => x.key === V).state, 'pending_recheck');
  const closed = await go('fix_resolve', { id: V, outcome: 'not_reproduced', reason: 'đoạn văn đọc bình thường' }, { store, fetch: f });
  assert.equal(closed.status, 'denied');
  assert.equal(rows(store, 'fix_checks').find(x => x.key === V).state, 'closed');
  const refused = await go('fix_resolve', { id: V, outcome: 'replace', find: 'không có', replace: 'x', reason: 'thử' }, { store, fetch: f });
  assert.equal(refused.ok, false);
  assert.equal(rows(store, 'fix_checks').find(x => x.key === V).detail, 'quote_not_found');
  await assert.rejects(go('fix_resolve', { id: V, outcome: 'replace', reason: 'thiếu quote' }, { fetch: f }));
  await assert.rejects(go('fix_resolve', { id: V, outcome: 'rewrite', reason: 'không hợp lệ' }, { fetch: f }));
});

test('chapter_retranslate and chapter_tts name one chapter, queue a re-check, and need a slug', async () => {
  const f = fakeFetch({
    'POST /novel/agent/novels/m/chapters/4/retranslate': [200, { remaining: 19 }],
    'POST /novel/agent/novels/m/chapters/4/tts': [202, { remaining: 19 }],
  });
  const store = fakeStore();
  assert.equal((await go('chapter_retranslate', { slug: 'm', chapter: 4 }, { store, fetch: f })).remaining, 19);
  assert.equal((await go('chapter_tts', { slug: 'm', chapter: 4, voice_id: 'v1' }, { store, fetch: f })).remaining, 19);
  assert.equal(rows(store, 'fix_checks').length, 2);
  assert.equal(f.calls[1].body.voiceId, 'v1');
  await assert.rejects(go('chapter_retranslate', { slug: '../x', chapter: 4 }), e => e.code === 'invalid_request');
  await assert.rejects(go('chapter_tts', { slug: 'm', chapter: 4 }), e => e.code === 'invalid_request');
});

test('request_finish closes a request through the api and keeps the outcome', async () => {
  const f = fakeFetch({ [`POST /novel/agent/requests/${R1}/translated`]: [200, { success: true }], [`POST /novel/agent/requests/${R2}/done`]: [409, { error: 'already_settled' }] });
  const store = fakeStore();
  assert.equal((await go('request_finish', { id: R1, outcome: 'translated', novel_slug: 'moi', chapters: '1-10' }, { store, fetch: f })).ok, true);
  const o = rows(store, 'request_outcomes')[0];
  assert.deepEqual([o.outcome, o.novel_slug, o.chapters], ['translated', 'moi', '1-10']);
  assert.equal((await go('request_finish', { id: R2, novel_slug: 'moi' }, { store, fetch: f })).ok, false);
  assert.equal(rows(store, 'request_outcomes').length, 1);
  // no novel, no finish: a vague request is never closed as served
  const g = fakeFetch({});
  await assert.rejects(go('request_finish', { id: R3, outcome: 'done' }, { store, fetch: g }), e => e.code === 'invalid_request');
  assert.equal(g.calls.length, 0);
});

test('parseJobInput validates the job fields', () => {
  assert.throws(() => parseJobInput(R1, 'refresh', { title: 'x' }), e => e.code === 'invalid_request');
  assert.throws(() => parseJobInput(R1, 'onboard', { title: 'x', source_url: 'javascript:alert(1)' }), e => e.code === 'invalid_request');
  assert.throws(() => parseJobInput(R1, 'refresh', { title: 'x', novel_slug: 'a', chapters: '9-2' }), e => e.code === 'invalid_request');
  assert.equal(parseJobInput(R1, 'onboard', { title: 'x' }).kind, 'onboard');
});

test('a failed stage the api never got is posted again on the next tick (B5 refund), then dropped', async () => {
  const store = fakeStore();
  await store.insert('translations', { key: 'moi', request_id: R1, phase: 'queued', from_chapter: 1, to_chapter: 10, job_id: 'jt' });
  let up = false;
  const f = fakeFetch({
    'GET /novel/agent/novels/moi/litrans/jobs/jt': [200, { job: { status: 'failed', error: 'x' } }],
    [`POST /novel/agent/requests/${R1}/stage`]: () => (up ? [200, { success: true, changed: true }] : [503, {}]),
  });
  await go('translate_step', {}, { store, fetch: f });
  assert.equal(rows(store, 'translations')[0].phase, 'failed'); // the local row moved on
  up = true;
  await go('translate_step', {}, { store, fetch: f });
  const stages = f.calls.filter(c => c.path.endsWith('/stage'));
  assert.deepEqual(stages.map(s => s.body.stage), ['failed', 'failed']);
  assert.equal(stages[1].body.cause, 'failed');
  await go('translate_step', {}, { store, fetch: f });
  assert.equal(f.calls.filter(c => c.path.endsWith('/stage')).length, 2); // delivered once, not again
});

test('fixes_run: a daily cap waits for the next pass; a partial re-voice is a card; an upgraded review runs', async () => {
  const C = 'cccccccc-1111-4111-8111-111111111111', Q = 'bbbbbbbb-2222-4222-8222-222222222222', U = 'aaaaaaaa-3333-4333-8333-333333333333';
  let capped = true, upgraded = false;
  const list = () => [
    { id: C, kind: 'requeue_tts', params: { novelSlug: 'm', chapterNumber: 2 }, chapters: 1, wide: false, needs_review: false, needs_person: false },
    { id: Q, kind: 'requeue_tts', params: { novelSlug: 'm', fromChapter: 3, toChapter: 5 }, chapters: 3, wide: false, needs_review: false, needs_person: false },
    { id: U, kind: 'fix_chapter', mode: upgraded ? 'replace' : 'review', params: { novelSlug: 'm', chapterNumber: 9 }, chapters: 1, wide: false, needs_review: !upgraded, needs_person: false },
  ];
  const f = fakeFetch({
    'GET /novel/agent/support-actions': () => [200, { items: list() }],
    [`POST /novel/agent/support-actions/${C}/execute`]: () => (capped ? [429, { error: 'fix_tts', limit: 20, used: 20 }] : [200, { status: 'executed' }]),
    [`POST /novel/agent/support-actions/${Q}/execute`]: [200, { status: 'executed', result: { dispatched: [{ chapterNumber: 3 }], failed: [{ chapterNumber: 4 }, { chapterNumber: 5 }] } }],
    [`POST /novel/agent/support-actions/${U}/execute`]: [200, { status: 'executed' }],
  });
  const store = fakeStore();
  const r = await go('fixes_run', {}, { store, fetch: f });
  assert.equal(r.ran.find(x => x.id === C).retry, 'fix_tts');
  assert.equal(rows(store, 'fix_checks').find(x => x.key === C), undefined); // not a card
  assert.equal(rows(store, 'fix_checks').find(x => x.key === Q).state, 'failed');
  assert.match(rows(store, 'fix_checks').find(x => x.key === Q).detail, /4, 5/);
  assert.equal(rows(store, 'fix_checks').find(x => x.key === U).state, 'reviewing');
  capped = false; upgraded = true;
  const next = await go('fixes_run', {}, { store, fetch: f });
  assert.deepEqual(next.ran.map(x => [x.id, x.executed]).sort(), [[C, true], [U, true]].sort());
  assert.equal(rows(store, 'fix_checks').find(x => x.key === U).state, 'pending_recheck');
});

test('requests_pending: a request with no link is asked for a link at 12h (needs_source), still open, and only ends failed after the fail window', async () => {
  const mk = () => fakeFetch({
    'GET /novel/agent/requests/pending': [200, { items: [{ id: R1, title: 'Mạt Thế', source_url: null }, { id: R2, title: 'Có Link', source_url: 'https://example.test/b/1' }] }],
    'GET /novel/agent/novels': [200, { exists: false }],
    [`POST /novel/agent/requests/${R1}/ask`]: [200, { success: true, changed: true, stage: 'needs_source' }],
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { changed: true, refund: { refunded: 2 } }],
  });
  const store = fakeStore();
  const f1 = mk();
  const r1 = await go('requests_pending', {}, { store, fetch: f1, now: NOW });
  assert.deepEqual(r1.items.map(i => i.id), [R1, R2]);
  assert.equal(f1.calls.filter(c => c.path.endsWith('/stage') || c.path.endsWith('/ask')).length, 0);
  // an hour later: still waiting
  assert.equal((await go('requests_pending', {}, { store, fetch: mk(), now: NOW + 3_600_000 })).auto_resolved.length, 0);
  // past the grace period: the api is asked to move it to needs_source and tell the requester — the request stays OPEN
  const f2 = mk();
  const r2 = await go('requests_pending', {}, { store, fetch: f2, now: NOW + 13 * 3_600_000 });
  assert.deepEqual(r2.auto_resolved.map(a => [a.id, a.action]), [[R1, 'needs_source']]);
  const ask = f2.calls.find(c => c.path.endsWith('/ask'));
  assert.match(ask.body.message, /link/);
  assert.equal(f2.calls.filter(c => c.path.endsWith('/stage')).length, 0);
  // asked but not answered: the request stays on the list (still pending, not ended) until the fail window
  const f3 = mk();
  const r3 = await go('requests_pending', {}, { store, fetch: f3, now: NOW + 40 * 3_600_000 });
  assert.equal(f3.calls.filter(c => c.path.endsWith('/stage')).length, 0);
  // past the fail window: failed / no_source with the note that asks for a link; the request with a link is untouched
  const f4 = mk();
  const r4 = await go('requests_pending', {}, { store, fetch: f4, now: NOW + 80 * 3_600_000 });
  assert.deepEqual(r4.auto_resolved.map(a => [a.id, a.action]), [[R1, 'needs_source']]);
  const st = f4.calls.find(c => c.path.endsWith('/stage'));
  assert.deepEqual([st.body.stage, st.body.cause], ['failed', 'no_source']);
  assert.match(st.body.note, /link/);
  const out = rows(store, 'request_outcomes').find(o => o.key === R1);
  assert.equal(out.outcome, 'needs_source');
});

test('requests_pending: an api without the ask route falls back to ending the request at the grace period', async () => {
  const mk = () => fakeFetch({
    'GET /novel/agent/requests/pending': [200, { items: [{ id: R1, title: 'Mạt Thế', source_url: null }] }],
    'GET /novel/agent/novels': [200, { exists: false }],
    [`POST /novel/agent/requests/${R1}/ask`]: [404, { error: 'not_found' }],
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { changed: true, refund: { refunded: 0 } }],
  });
  const store = fakeStore();
  await go('requests_pending', {}, { store, fetch: mk(), now: NOW });
  const f = mk();
  const r = await go('requests_pending', {}, { store, fetch: f, now: NOW + 13 * 3_600_000 });
  assert.deepEqual(r.auto_resolved.map(a => [a.id, a.action]), [[R1, 'needs_source']]);
  const st = f.calls.find(c => c.path.endsWith('/stage'));
  assert.deepEqual([st.body.stage, st.body.cause], ['failed', 'no_source']);
});

test('requests_pending: a request that holds an auto-onboard slot is never asked for a link', async () => {
  const f = fakeFetch({ 'GET /novel/agent/requests/pending': [200, { items: [{ id: R1, title: 'Tự Động', source_url: null, auto_onboard: true }] }], 'GET /novel/agent/novels': [200, { exists: false }] });
  const store = fakeStore();
  await go('requests_pending', {}, { store, fetch: f, now: NOW });
  await go('requests_pending', {}, { store, fetch: f, now: NOW + 20 * 3_600_000 });
  assert.equal(f.calls.filter(c => c.path.endsWith('/stage')).length, 0);
});
