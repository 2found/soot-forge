// Request → release (bs-kh1atl85): auto-onboard from the api's score, the stage the pack posts at each step, the
// quality gate (fail never reaches audio; one retranslate, then a person) and the release that closes the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/ops.mjs';
import { RESAMPLE_AFTER_MIN } from '../tools/lib/release.mjs';
import { fakeStore, fakeFetch, KEYED } from './helpers.mjs';

const NOW = Date.parse('2026-11-13T03:00:00Z');
const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222';
const go = (name, input, o = {}) => run(name, { input }, { env: KEYED, store: o.store ?? fakeStore(), now: o.now ?? NOW, fetchImpl: o.fetch ?? fakeFetch({}) });
const rows = (store, t) => store.tables.get(t) ?? [];
const state = (store, key) => rows(store, 'state').find(r => r.key === key)?.value ?? null;
const stagesOf = f => f.calls.filter(c => c.path.endsWith('/stage')).map(c => c.body.stage);

test('requests_pending: a request that earned its slot is approved and its onboard job opened approved, once', async () => {
  const store = fakeStore();
  const f = fakeFetch({
    'GET /novel/agent/requests/pending': [200, { items: [
      { id: R1, type: 'novel', title: 'Cẩu Tại Sơ Thánh', source_url: 'https://example.test/b/1', stage: 'onboarding', auto_onboard: true },
      { id: R2, type: 'novel', title: 'Truyện khác', stage: null, auto_onboard: false }], next_cursor: null }],
    'GET /novel/agent/novels': [200, { exists: false }],
    [`POST /novel/agent/requests/${R1}/approve`]: [200, { success: true, autoOnboard: true, stage: 'onboarding' }],
  });
  const out = await go('requests_pending', {}, { store, fetch: f });
  assert.deepEqual(out.items.map(i => i.id), [R2]); // only what needs judgment is left
  assert.equal(out.auto_resolved[0].action, 'auto_onboard');
  const [job] = rows(store, 'catalog_jobs');
  assert.deepEqual([job.kind, job.state, job.approved_by, job.request_id, job.source_url], ['onboard', 'approved', 'policy:auto_onboard', R1, 'https://example.test/b/1']);
  // The api keeps listing it until the stage leaves onboarding: no second approve, no second job.
  const again = await go('requests_pending', {}, { store, fetch: f });
  assert.equal(again.auto_resolved[0].duplicate, true);
  assert.equal(rows(store, 'catalog_jobs').length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
});

test('requests_pending: when the api does not confirm the slot, the request stays for judgment and no job opens', async () => {
  const store = fakeStore();
  const f = fakeFetch({
    'GET /novel/agent/requests/pending': [200, { items: [{ id: R1, type: 'novel', title: 'A', auto_onboard: true }], next_cursor: null }],
    'GET /novel/agent/novels': [200, { exists: false }],
    [`POST /novel/agent/requests/${R1}/approve`]: [200, { success: true, autoOnboard: false }],
  });
  const out = await go('requests_pending', {}, { store, fetch: f });
  assert.deepEqual(out.items.map(i => i.id), [R1]);
  assert.equal(rows(store, 'catalog_jobs').length, 0);
});

test('request_accept: autoOnboard from the api opens the onboard approved; without it the onboard waits for the card', async () => {
  const yes = fakeFetch({ [`POST /novel/agent/requests/${R1}/approve`]: [200, { success: true, autoOnboard: true }] });
  const s1 = fakeStore();
  const a = await go('request_accept', { id: R1, kind: 'onboard', title: 'Truyện' }, { store: s1, fetch: yes });
  assert.equal(a.auto_onboard, true);
  assert.equal(a.job.state, 'approved');
  assert.equal(rows(s1, 'catalog_jobs')[0].approved_by, 'policy:auto_onboard');
  const no = fakeFetch({ [`POST /novel/agent/requests/${R1}/approve`]: [200, { success: true, autoOnboard: false }] });
  const b = await go('request_accept', { id: R1, kind: 'onboard', title: 'Truyện' }, { fetch: no });
  assert.equal(b.job.state, 'requested');
});

test('catalog_jobs_sync: a failed onboard posts stage failed with its cause', async () => {
  const store = fakeStore();
  const j = await store.insert('catalog_jobs', { kind: 'onboard', state: 'running', request_id: R1, title: 'X' });
  await store.insert('catalog_job_events', { job_id: j, state: 'failed', detail: 'no source matches the title', at: '2026-11-13T01:00:00Z' });
  const f = fakeFetch({ [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true }] });
  await go('catalog_jobs_sync', {}, { store, fetch: f });
  const call = f.calls.find(c => c.path.endsWith('/stage'));
  assert.deepEqual([call.body.stage, call.body.cause], ['failed', 'no_source']);
});

/** An onboarded novel whose first batch is translated: the pack state catalog_jobs_sync and translate_step leave. */
async function translatedNovel(f) {
  const store = fakeStore();
  const j = await store.insert('catalog_jobs', { kind: 'onboard', state: 'running', request_id: R1, title: 'Mới' });
  await store.insert('catalog_job_events', { job_id: j, state: 'done', novel_slug: 'moi', chapters: '1-10', at: '2026-11-13T01:00:00Z' });
  await go('catalog_jobs_sync', {}, { store, fetch: f });
  const t = rows(store, 'translations')[0];
  await store.update('translations', t.id, { phase: 'pulling', job_id: 'jp' });
  return store;
}

test('translate_step: a gated novel goes to quality instead of being closed as translated', async () => {
  const f = fakeFetch({
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true }],
    'GET /novel/agent/novels/moi/litrans/jobs/jp': [200, { job: { status: 'done' } }],
    [`POST /novel/agent/requests/${R1}/translated`]: [200, { success: true }],
  });
  const store = await translatedNovel(f);
  await go('translate_step', {}, { store, fetch: f });
  assert.deepEqual(stagesOf(f), ['translating', 'quality']);
  assert.equal(f.calls.some(c => c.path.endsWith('/translated')), false);
  assert.equal(state(store, 'release:moi').phase, 'quality');
  const step = await go('release_step', {}, { store, fetch: f });
  assert.deepEqual(step.to_judge.map(j => [j.slug, j.from, j.to, j.attempt, j.request_id]), [['moi', 1, 10, 1, R1]]);
  assert.equal(step.wake, true);
});

test('quality fail: no audio, one retranslate of the flagged chapters, sampled again; the second fail is one card', async () => {
  let next = 'retranslate';
  const f = fakeFetch({
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true }],
    'GET /novel/agent/novels/moi/litrans/jobs/jp': [200, { job: { status: 'done' } }],
    'POST /novel/agent/novels/moi/quality-verdict': () => [200, { verdict: 'fail', replayed: false, next, tts: null }],
    'POST /novel/agent/novels/moi/chapters/3/retranslate': [200, { remaining: 19 }],
    'POST /novel/agent/novels/moi/chapters/7/retranslate': [200, { remaining: 18 }],
  });
  const store = await translatedNovel(f);
  await go('translate_step', {}, { store, fetch: f });
  const first = await go('quality_verdict', { slug: 'moi', verdict: 'fail', score: 0.4, reason: 'Sót chữ Trung ở chương 3 và 7.', retranslate: [3, 7] }, { store, fetch: f });
  assert.equal(first.next, 'retranslate');
  assert.deepEqual(first.retranslated.map(r => r.chapter), [3, 7]);
  const verdictCall = f.calls.find(c => c.path.endsWith('/quality-verdict'));
  assert.deepEqual([verdictCall.body.attempt, verdictCall.body.from, verdictCall.body.to, verdictCall.body.requestId], [1, 1, 10, R1]);
  assert.equal(state(store, 'release:moi').phase, 'retranslating');
  // Too early: nothing to judge. After the wait: back to quality, attempt 2.
  assert.deepEqual((await go('release_step', {}, { store, fetch: f })).to_judge, []);
  const later = await go('release_step', {}, { store, fetch: f, now: NOW + RESAMPLE_AFTER_MIN * 60_000 });
  assert.equal(later.to_judge[0].attempt, 2);
  next = 'human';
  const second = await go('quality_verdict', { slug: 'moi', verdict: 'fail', score: 0.3, reason: 'Vẫn sai tên nhân vật chính.' }, { store, fetch: f });
  assert.equal(second.next, 'human');
  assert.match(second.ask.missing, /moi chương 1–10/);
  assert.equal(f.calls.filter(c => c.path.endsWith('/quality-verdict')).at(-1).body.attempt, 2);
  // No audio was ever asked for, and nothing more is done with it.
  assert.equal(f.calls.some(c => /quality-sample|\/tts|\/done$/.test(c.path)), false);
  assert.equal(state(store, 'release:moi').phase, 'human');
});

test('quality pass: audio dispatched by the api, then released and closed once every sampled chapter has audio', async () => {
  let audio = 4;
  const f = fakeFetch({
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true }],
    'GET /novel/agent/novels/moi/litrans/jobs/jp': [200, { job: { status: 'done' } }],
    'POST /novel/agent/novels/moi/quality-verdict': [200, { verdict: 'pass', replayed: false, next: null, tts: { status: 'dispatched', voiceId: 'v' } }],
    'GET /novel/agent/novels/moi/quality-sample': () => [200, { summary: { sampled: 10, audio } }],
    [`POST /novel/agent/requests/${R1}/done`]: [200, { success: true }],
  });
  const store = await translatedNovel(f);
  await go('translate_step', {}, { store, fetch: f });
  const pass = await go('quality_verdict', { slug: 'moi', verdict: 'pass', score: 0.9, reason: 'Đạt: đủ chữ, đúng tên.' }, { store, fetch: f });
  assert.equal(pass.tts.status, 'dispatched');
  assert.equal(state(store, 'release:moi').phase, 'audio');
  assert.equal((await go('release_step', {}, { store, fetch: f })).released, 0); // 4 of 10 voiced
  audio = 10;
  const done = await go('release_step', {}, { store, fetch: f });
  assert.equal(done.released, 1);
  assert.deepEqual(stagesOf(f), ['translating', 'quality', 'released']);
  assert.equal(f.calls.filter(c => c.path.endsWith('/done')).length, 1);
  assert.equal(rows(store, 'request_outcomes').at(-1).outcome, 'done');
  // Released is the end: a later tick does nothing.
  assert.deepEqual((await go('release_step', {}, { store, fetch: f })).moved, []);
});

test('quality pass past the daily cap: deferred audio is retried by release_step, never re-judged', async () => {
  let tts = { status: 'deferred', reason: 'daily_cap' };
  const f = fakeFetch({
    [`POST /novel/agent/requests/${R1}/stage`]: [200, { success: true, changed: true }],
    'GET /novel/agent/novels/moi/litrans/jobs/jp': [200, { job: { status: 'done' } }],
    'POST /novel/agent/novels/moi/quality-verdict': () => [200, { verdict: 'pass', replayed: tts.status !== 'deferred', next: null, tts }],
  });
  const store = await translatedNovel(f);
  await go('translate_step', {}, { store, fetch: f });
  await go('quality_verdict', { slug: 'moi', verdict: 'pass', score: 0.8, reason: 'Đạt.' }, { store, fetch: f });
  assert.equal(state(store, 'release:moi').phase, 'audio_deferred');
  const waiting = await go('release_step', {}, { store, fetch: f });
  assert.deepEqual(waiting.to_judge, []);
  assert.equal(state(store, 'release:moi').phase, 'audio_deferred');
  tts = { status: 'dispatched', replayed: true };
  await go('release_step', {}, { store, fetch: f });
  assert.equal(state(store, 'release:moi').phase, 'audio');
  assert.equal(f.calls.filter(c => c.path.endsWith('/quality-verdict')).at(-1).body.verdict, 'pass');
});

test('quality_sample and quality_verdict validate before calling', async () => {
  const f = fakeFetch({});
  await assert.rejects(go('quality_sample', { slug: 'Bad Slug' }, { fetch: f }), e => e.code === 'invalid_request');
  await assert.rejects(go('quality_verdict', { slug: 'moi', verdict: 'maybe', score: 0.5, reason: 'xxxx' }, { fetch: f }), e => e.code === 'invalid_request');
  await assert.rejects(go('quality_verdict', { slug: 'moi', verdict: 'pass', score: 2, reason: 'xxxx' }, { fetch: f }), e => e.code === 'invalid_request');
  assert.equal(f.calls.length, 0);
});

test('compactSample: a clean chapter is one short row, a flagged one keeps its figures and at most 3 names', async () => {
  const { compactSample } = await import('../tools/lib/release.mjs');
  const out = compactSample({ novel: { slug: 'a' }, summary: { sampled: 2 }, chapters: [
    { chapter: 1, status: 'translated', raw_chars: 2400, translated_chars: 2100, length_ratio: 0.87, leftover_cjk: 0, empty: false, thin: false, short_vs_source: false, names_missing: [], audio: false, flags: [] },
    { chapter: 2, status: 'translated', raw_chars: 2400, translated_chars: 300, length_ratio: 0.12, leftover_cjk: 40, empty: false, thin: true, short_vs_source: true, audio: true,
      names_missing: [1, 2, 3, 4, 5].map(n => ({ name_cn: `名${n}`, name_vi: `Tên ${n}` })), flags: ['thin', 'leftover_cjk', 'names_missing'] },
  ] });
  assert.deepEqual(out.chapters[0], { chapter: 1, flags: [], translated_chars: 2100 });
  assert.equal(out.chapters[1].names_missing.length, 3);
  assert.deepEqual([out.chapters[1].length_ratio, out.chapters[1].leftover_cjk], [0.12, 40]);
  assert.equal(out.summary.sampled, 2);
  assert.ok(JSON.stringify(out.chapters).length < JSON.stringify([{}, {}]).length + 400);
});
