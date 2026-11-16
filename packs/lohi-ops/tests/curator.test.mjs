import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/ops.mjs';
import { fakeStore, fakeFetch, KEYED } from './helpers.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const go = (name, input, fetchImpl, extra = {}) => run(name, { input }, { env: { ...KEYED }, store: extra.store ?? fakeStore(), fetchImpl, now: Date.parse('2026-11-11T03:00:00Z'), ...extra });

test('requests_pending: asks the agent surface with the key, bounds the page, notifies on items', async () => {
  const f = fakeFetch({ 'GET /novel/agent/requests/pending': [200, { items: [{ id: ID, title: 'A' }], next_cursor: 'c1' }] });
  const out = await go('requests_pending', { limit: 500 }, f);
  assert.equal(out.ok, true); assert.equal(out.notify, true); assert.equal(out.next_cursor, 'c1');
  assert.equal(f.calls[0].query.limit, '50');
  assert.equal(f.calls[0].headers['X-API-Key'], KEYED.PRODUCT_ADMIN_KEY);
  assert.equal((await go('requests_pending', {}, fakeFetch({ 'GET /novel/agent/requests/pending': [200, { items: [], next_cursor: null }] }))).notify, false);
});

test('a missing key is a quiet skip, never a call; a refused key is a decided error', async () => {
  const f = fakeFetch({});
  const out = await run('requests_pending', { input: {} }, { env: { PRODUCT_API_URL: KEYED.PRODUCT_API_URL }, store: fakeStore(), fetchImpl: f });
  assert.equal(out.skipped, true); assert.equal(f.calls.length, 0);
  const denied = await go('requests_pending', {}, fakeFetch({ 'GET /novel/agent/requests/pending': [403, {}] }));
  assert.equal(denied.ok, false); assert.equal(denied.error.code, 'forbidden');
});

test('the key is never sent over plain http to a remote host', async () => {
  const f = fakeFetch({});
  const out = await run('requests_pending', { input: {} }, { env: { PRODUCT_ADMIN_KEY: 'k', PRODUCT_API_URL: 'http://api.example.test' }, store: fakeStore(), fetchImpl: f });
  assert.equal(out.skipped, true); assert.equal(f.calls.length, 0);
});

test('request_accept: approve / done / merge call the right route; bad input never calls', async () => {
  const f = fakeFetch({ [`POST /novel/agent/requests/${ID}/approve`]: [200, {}], [`POST /novel/agent/requests/${ID}/merge`]: [200, {}] });
  assert.equal((await go('request_accept', { id: ID }, f)).action, 'approve');
  assert.equal((await go('request_accept', { id: ID, action: 'merge', target_id: ID2 }, f)).ok, true);
  assert.deepEqual(f.calls[1].body, { targetId: ID2 });
  const n = f.calls.length;
  for (const bad of [{ id: 'x' }, { id: ID, action: 'delete' }, { id: ID, action: 'merge' }, { id: ID, action: 'merge', target_id: ID }]) {
    await assert.rejects(go('request_accept', bad, f), e => e.code === 'invalid_request');
  }
  assert.equal(f.calls.length, n);
});

test('request_reject needs a real reason', async () => {
  const f = fakeFetch({ [`POST /novel/agent/requests/${ID}/reject`]: [200, { success: true }] });
  await assert.rejects(go('request_reject', { id: ID, reason: 'no' }, f), e => e.code === 'invalid_request');
  assert.equal(f.calls.length, 0);
  const out = await go('request_reject', { id: ID, reason: 'Truyện đang giữ bản quyền ở nền tảng khác.' }, f);
  assert.equal(out.ok, true); assert.match(f.calls[0].body.reason, /bản quyền/);
});

test('edit_verdict validates confidence and carries the verdict, not a decision', async () => {
  const f = fakeFetch({ [`POST /novel/agent/edit-suggestions/${ID}/verdict`]: [200, { disposition: 'human' }] });
  for (const bad of [{ verdict: 'accept', confidence: 101, reason: 'x' }, { verdict: 'apply', confidence: 50, reason: 'x' }, { verdict: 'accept', confidence: 50, reason: '' }, { verdict: 'accept', reason: 'x' }]) {
    await assert.rejects(go('edit_verdict', { id: ID, ...bad }, f), e => e.code === 'invalid_request');
  }
  assert.equal(f.calls.length, 0);
  const out = await go('edit_verdict', { id: ID, verdict: 'unsure', confidence: 40.6, reason: 'Tên riêng, không đủ ngữ cảnh.' }, f);
  assert.equal(out.result.disposition, 'human'); assert.equal(f.calls[0].body.confidence, 41);
});

test('violations_list counts overdue and pages by offset', async () => {
  const f = fakeFetch({ 'GET /novel/agent/violation-reports': [200, { items: [{ id: ID, overdue: true }, { id: ID2, overdue: false }], total: 9, next_offset: 2 }] });
  const out = await go('violations_list', { limit: 2 }, f);
  assert.equal(out.overdue, 1); assert.equal(out.next_offset, 2); assert.equal(out.notify, true);
  await assert.rejects(go('violations_list', { status: 'actioned' }, f), e => e.code === 'invalid_request');
});

test('violation_resolve: the api refusing a copyright dismissal comes back with its word, nothing hidden', async () => {
  const f = fakeFetch({ [`POST /novel/agent/violation-reports/${ID}/resolve`]: [422, { error: 'copyright_needs_person' }] });
  const out = await go('violation_resolve', { id: ID, action: 'dismiss', notes: 'không hợp lệ' }, f);
  assert.equal(out.ok, false); assert.equal(out.error.reason, 'copyright_needs_person');
  await assert.rejects(go('violation_resolve', { id: ID, action: 'actioned', notes: 'x' }, f), e => e.code === 'invalid_request');
  await assert.rejects(go('violation_resolve', { id: ID, action: 'acknowledge' }, f), e => e.code === 'invalid_request');
});

test('enrichment_enqueue: slug shape, and a 422 not_catalogue is a decided refusal', async () => {
  const f = fakeFetch({ 'POST /novel/agent/enrichment/novels': [422, { error: 'not_catalogue' }] });
  const out = await go('enrichment_enqueue', { slug: 'user-work' }, f);
  assert.equal(out.ok, false); assert.equal(out.error.reason, 'not_catalogue');
  await assert.rejects(go('enrichment_enqueue', { slug: 'Bad Slug' }, f), e => e.code === 'invalid_request');
  const ok = await go('enrichment_enqueue', { slug: 'kiem-lai' }, fakeFetch({ 'POST /novel/agent/enrichment/novels': [201, { queued: true, job: { status: 'queued' } }] }));
  assert.equal(ok.queued, true);
});

test('quality_list passes the problem filter and cursor through', async () => {
  const f = fakeFetch({ 'GET /admin/analysis/catalog-health': [200, { scanned: 25, items: [{ novel_slug: 'a', problems: ['cover'] }], next_cursor: ID }] });
  const out = await go('quality_list', { problems: ['cover', 'genres'], cursor: ID }, f);
  assert.equal(f.calls[0].query.check, 'quality'); assert.equal(f.calls[0].query.problems, 'cover,genres');
  assert.equal(out.next_cursor, ID);
});

test('catalog_health quality: a published novel without chapters is a card, a missing cover is only a finding', async () => {
  const store = fakeStore();
  const f = fakeFetch({ 'GET /admin/analysis/catalog-health': u => [200, { scanned: 2, next_cursor: null, truncated: false, items: u.searchParams.get('check') === 'quality'
    ? [{ novel_slug: 'empty-one', problems: ['cover', 'chapters'] }, { novel_slug: 'no-cover', problems: ['cover'] }] : [] }] });
  const out = await go('catalog_health', { checks: ['quality'] }, f, { store });
  assert.equal(out.counts.quality, 2); assert.equal(out.actionable, 1);
  assert.ok(out.ask); assert.match(out.ask.missing, /empty-one/); assert.doesNotMatch(out.ask.missing, /no-cover/);
  assert.equal(store.tables.get('findings').length, 2);
});

test('duplicates_scan: pages, keeps one finding per pair, merges nothing', async () => {
  const store = fakeStore();
  const pair = (a, b, s) => ({ a: { id: 'x' + a, slug: a, title: a }, b: { id: 'y' + b, slug: b, title: b }, similarity: s, basis: 'title_vi' });
  let page = 0;
  const f = fakeFetch({ 'GET /admin/analysis/catalog-duplicates': () => [200, page++ === 0 ? { scanned: 25, items: [pair('a', 'b', 0.97)], next_cursor: ID } : { scanned: 25, items: [pair('c', 'd', 0.82)], next_cursor: null }] });
  const out = await go('duplicates_scan', { pages: 3 }, f, { store });
  assert.equal(out.pairs.length, 2); assert.equal(out.scanned, 50); assert.equal(out.more, false);
  assert.equal(f.calls[1].query.cursor, ID);
  const rows = store.tables.get('findings');
  assert.deepEqual(rows.map(r => r.key).sort(), ['dup:a:b', 'dup:c:d']);
  assert.equal(rows.find(r => r.key === 'dup:a:b').severity, 'high');
  assert.ok(f.calls.every(c => c.method === 'GET'));
  // re-running does not duplicate findings
  page = 0; await go('duplicates_scan', { pages: 3 }, f, { store });
  assert.equal(store.tables.get('findings').length, 2);
});

test('duplicates_scan clamps its inputs; the api refusing the key is returned, not thrown', async () => {
  const f = fakeFetch({ 'GET /admin/analysis/catalog-duplicates': [403, {}] });
  const out = await go('duplicates_scan', { threshold: 0.1, limit: 999, pages: 99 }, f);
  assert.equal(out.ok, false);
  assert.equal(f.calls[0].query.threshold, '0.5'); assert.equal(f.calls[0].query.limit, '50');
});

test('litrans_health: stalled and long-queued jobs raise one card, a calm day raises none', async () => {
  const store = fakeStore();
  const bad = { counts: { queued: 4, running: 1, done: 10, failed: 0, canceled: 0 }, oldest_queued_wait_seconds: 7200, stalled_running: 1, failed: [], next_cursor: null };
  const out = await go('litrans_health', {}, fakeFetch({ 'GET /admin/analysis/litrans-health': [200, bad] }), { store });
  assert.equal(out.actionable, 2); assert.ok(out.ask);
  assert.deepEqual(store.tables.get('findings').map(r => r.key).sort(), ['litrans:queue', 'litrans:stalled']);
  const calm = await go('litrans_health', {}, fakeFetch({ 'GET /admin/analysis/litrans-health': [200, { ...bad, oldest_queued_wait_seconds: 30, stalled_running: 0 }] }), { store });
  assert.equal(calm.actionable, 0); assert.equal(calm.resolves_need, true);
});

test('unknown tool names are refused', async () => {
  await assert.rejects(run('nope', { input: {} }, { env: {}, store: fakeStore() }), e => e.code === 'invalid_request');
});

test('PRODUCT_AGENT_KEY wins over the deprecated PRODUCT_ADMIN_KEY, and a 403 names the tool role', async () => {
  const f = fakeFetch({ 'GET /novel/agent/requests/pending': [403, { error: 'agent_capability_required' }] });
  const env = { PRODUCT_AGENT_KEY: 'agent-key', PRODUCT_ADMIN_KEY: 'old-key', PRODUCT_API_URL: 'https://api.example.test' };
  const out = await run('requests_pending', { input: {} }, { env, store: fakeStore(), fetchImpl: f });
  assert.equal(f.calls[0].headers['X-API-Key'], 'agent-key');
  assert.match(JSON.stringify(out), /agent_curator/);
  assert.doesNotMatch(JSON.stringify(out), /agent_mod/);
});

test('reports_open: reads the grouped room reports with the key, bounds its inputs, files nothing (B11)', async () => {
  const group = { novelSlug: 'kiem-lai', novelTitle: 'Kiếm Lai', kind: 'content', fromChapter: 12, toChapter: 15, chapters: [12, 14, 15], reporters: 2, reports: 3, details: { bad_translation: 2 }, verdicts: { unverified: 3 }, notes: ['dịch sai'], firstAt: '2026-11-13T01:00:00Z', lastAt: '2026-11-13T05:00:00Z' };
  const f = fakeFetch({ 'GET /novel/agent/content-reports/open': [200, { since: '2026-11-13T03:00:00Z', scanned: 3, truncated: false, groups: [group] }] });
  const out = await run('reports_open', { input: { days: 99, limit: 0 } }, { env: { ...KEYED }, fetchImpl: f });
  assert.equal(out.ok, true); assert.equal(out.notify, true);
  assert.deepEqual([f.calls[0].query.days, f.calls[0].query.limit], ['14', '20']);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(out.groups[0], { novel_slug: 'kiem-lai', novel_title: 'Kiếm Lai', kind: 'content', from: 12, to: 15, chapters: [12, 14, 15], reporters: 2, reports: 3, details: { bad_translation: 2 }, verdicts: { unverified: 3 }, notes: ['dịch sai'], last_at: '2026-11-13T05:00:00Z' });
  const calm = await run('reports_open', { input: {} }, { env: { ...KEYED }, fetchImpl: fakeFetch({ 'GET /novel/agent/content-reports/open': [200, { groups: [] }] }) });
  assert.equal(calm.notify, false);
});
