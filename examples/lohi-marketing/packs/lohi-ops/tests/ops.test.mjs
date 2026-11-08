// lohi-ops tools against local mocks only: a fake pack store, a fake fetch standing in for the Lohi api,
// Apple, Google and App Store Connect, and an in-memory sqlite. The real api is never called and no key leaves this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { fakeStore } from './fake-store.mjs';
import { run, TOOLS } from '../tools/ops.mjs';
import { analyze, MIN_SIGNUPS } from '../tools/lib/pricing.mjs';
import { ascToken } from '../tools/lib/appstore.mjs';
import { toFinding } from '../tools/lib/catalog.mjs';
import { checkPackModel } from '../../../../../scripts/catalog.mjs';

const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-10T03:00:00Z');
const API = 'https://api.test';
const ENV = { PRODUCT_API_URL: API, PRODUCT_ADMIN_KEY: 'lohi_ak_test' };
const ID1 = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222', ID3 = '33333333-3333-4333-8333-333333333333';
const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/** A fetch that routes by "METHOD host/path" and records every call. */
function router(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', url: String(url), host: u.host, path: u.pathname, search: u.search, headers: init.headers ?? {}, body: init.body });
    const k = `${init.method ?? 'GET'} ${u.host}${u.pathname}`;
    const h = routes[k] ?? routes[`${u.host}${u.pathname}`];
    if (!h) return res({}, 404);
    return typeof h === 'function' ? h(u, init) : h;
  };
  f.calls = calls;
  return f;
}
const go = (name, input, over = {}) => run(name, { input }, { now: NOW, env: ENV, store: fakeStore({ clock: () => NOW }), ...over });

test('the manifest is a valid pack model and every tool has an implementation', () => {
  checkPackModel(pack, 'lohi-ops');
  for (const t of pack.tools) assert.ok(TOOLS[t.name], t.name);
  assert.equal(Object.keys(TOOLS).length, pack.tools.length);
  const readers = pack.tools.filter(t => t.run.mode === 'read').map(t => t.name).sort();
  assert.deepEqual(readers, ['pricing_report', 'seo_report']);
});

// ---------- catalog_health ----------
const staleItem = { novel_slug: 'a', title: 'A', last_chapter_number: 9, last_chapter_at: '2026-09-01T00:00:00Z', days_since_last_chapter: 70 };
const catalogRoutes = (over = {}) => ({
  [`GET api.test/admin/analysis/catalog-health`]: u => {
    const c = u.searchParams.get('check');
    const body = { version: 1, check: c, scanned: 25, items: [], next_cursor: null, truncated: false };
    if (c === 'stale') body.items = [staleItem, { ...staleItem, novel_slug: 'b', days_since_last_chapter: 16 }];
    if (c === 'thin') body.items = [{ novel_slug: 'c', title: 'C', chapter_number: 4, kind: 'empty', stored_bytes: 0, imported_at: 'x' }];
    return res(body);
  }, ...over,
});

test('catalog_health: findings table, one card for the actionable ones only, and the key goes to the api only', async () => {
  const store = fakeStore({ clock: () => NOW }), fetch = router(catalogRoutes());
  const out = await go('catalog_health', {}, { store, fetchImpl: fetch });
  assert.equal(out.ok, true);
  assert.equal(out.counts.stale, 2);
  assert.equal(out.actionable, 2, 'a (70d) and the empty chapter; b (16d) is only listed');
  assert.ok(out.ask && out.wake && out.notify);
  assert.equal(store.data.findings.length, 3);
  assert.ok(fetch.calls.every(c => c.host === 'api.test' && c.headers['X-API-Key'] === 'lohi_ak_test'));
  // Same findings again: the card does not wake a second time.
  const again = await go('catalog_health', {}, { store, fetchImpl: fetch });
  assert.equal(again.wake, false);
  assert.equal(store.data.findings.length, 3, 'upsert, not duplicates');
  // Everything clears: the need resolves.
  const clean = await go('catalog_health', {}, { store, fetchImpl: router({ 'GET api.test/admin/analysis/catalog-health': res({ version: 1, check: 'x', scanned: 1, items: [], next_cursor: null, truncated: false }) }) });
  assert.equal(clean.resolves_need, true);
});

test('catalog_health: pages through the cursor and stops at the page budget', async () => {
  let n = 0;
  const fetch = router({ 'GET api.test/admin/analysis/catalog-health': () => res({ version: 1, check: 'stale', scanned: 25, items: [], next_cursor: `c${++n}`, truncated: false }) });
  const out = await go('catalog_health', { checks: ['stale'], pages: 2 }, { fetchImpl: fetch });
  assert.equal(fetch.calls.length, 2);
  assert.equal(out.scanned.stale.more, true);
});

test('catalog_health: no key is a quiet skip, a 403 is a named error, a bad check is invalid', async () => {
  const skip = await go('catalog_health', {}, { env: { PRODUCT_API_URL: API }, fetchImpl: router({}) });
  assert.equal(skip.skipped, true);
  assert.equal(skip.key, 'PRODUCT_ADMIN_KEY');
  const f = router({ 'GET api.test/admin/analysis/catalog-health': res({}, 403) });
  const denied = await go('catalog_health', {}, { fetchImpl: f });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'forbidden');
  assert.equal(f.calls.length, 1, 'stops after the first refusal');
  await assert.rejects(go('catalog_health', { checks: ['nope'] }, { fetchImpl: router({}) }), /checks/);
  // An api that is not https never receives the key.
  const plain = router({});
  const unsafe = await go('catalog_health', {}, { env: { ...ENV, PRODUCT_API_URL: 'http://api.example.com' }, fetchImpl: plain });
  assert.equal(unsafe.skipped, true);
  assert.equal(plain.calls.length, 0);
});

test('toFinding: severity and actionability follow the thresholds', () => {
  const t = { act_stale_days: 30, act_gap_chapters: 5 };
  assert.equal(toFinding('stale', { ...staleItem, days_since_last_chapter: 14 }, t).actionable, false);
  assert.equal(toFinding('stale', { ...staleItem, last_chapter_at: null, days_since_last_chapter: null }, t).severity, 'high');
  assert.equal(toFinding('gaps', { novel_slug: 'g', missing: 3, ranges: [[4, 6]] }, t).actionable, false);
  assert.equal(toFinding('untranslated', { novel_slug: 'u', chapter_number: 1, cjk_ratio: 0.7 }, t).actionable, true);
  assert.equal(toFinding('thin', { novel_slug: 't', chapter_number: 1, kind: 'short', stored_bytes: 120 }, t).actionable, false);
});

// ---------- crawl_watch ----------
async function memDb(setup) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE source_catalog (source_slug TEXT, novel_slug TEXT, crawl_status TEXT, crawl_error TEXT, crawled_at TEXT, enriched_at TEXT, radar_checked_at TEXT, has_new_chapters INTEGER DEFAULT 0);
           CREATE TABLE chapters (source_slug TEXT, novel_slug TEXT, fetched_at TEXT);`);
  setup(db);
  return db;
}
test('crawl_watch: stuck, grouped failures and a stalled source become one card', async () => {
  const openDb = () => memDb(db => {
    const ins = db.prepare('INSERT INTO source_catalog (source_slug, novel_slug, crawl_status, crawl_error, crawled_at) VALUES (?,?,?,?,?)');
    ins.run('s1', 'stuck-one', 'crawling', null, '2026-11-09T00:00:00Z');
    for (let i = 0; i < 4; i++) ins.run('s1', `bad-${i}`, 'failed', `HTTP 50${i} for https://x.test/${i}`, '2026-11-09T20:00:00Z');
    ins.run('s2', 'old', 'pending', null, '2026-09-01T00:00:00Z');
    ins.run('s3', 'fine', 'done', null, '2026-11-10T01:00:00Z');
  });
  const store = fakeStore({ clock: () => NOW });
  const out = await go('crawl_watch', {}, { env: { CLI_CATALOG_DB: '/x.db' }, store, openDb });
  assert.equal(out.ok, true);
  assert.equal(out.stuck.length, 1);
  assert.equal(out.failed[0].count, 4, 'four codes and urls collapse to one kind');
  assert.deepEqual(out.stale_sources.map(s => s.source), ['s2']);
  assert.equal(out.actionable, 3);
  assert.ok(out.ask);
});
test('crawl_watch: no path is a quiet skip, an unreadable file is a named error, a healthy catalog raises nothing', async () => {
  assert.equal((await go('crawl_watch', {}, { env: {} })).skipped, true);
  const bad = await go('crawl_watch', {}, { env: { CLI_CATALOG_DB: '/definitely/missing.db' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'catalog_unreadable');
  const ok = await go('crawl_watch', {}, { env: { CLI_CATALOG_DB: '/x' }, openDb: () => memDb(db => db.prepare('INSERT INTO source_catalog (source_slug, novel_slug, crawl_status, crawled_at) VALUES (?,?,?,?)').run('s', 'n', 'done', '2026-11-10T00:00:00Z')) });
  assert.equal(ok.actionable, 0);
  assert.equal(ok.ask, undefined);
});

// ---------- comments ----------
const reply = (id, body) => ({ id, post_id: 'p', body, created_at: '2026-11-10T01:00:00Z', hidden: false, report_reason: null, reported_at: null });
function modApi({ failHide = false } = {}) {
  return router({
    'GET api.test/admin/moderation/replies': u => res({ version: 1, scope: u.searchParams.get('scope'), items: u.searchParams.get('scope') === 'flagged' ? [reply(ID1, 'mua sub zalo 0900')] : [reply(ID2, 'truyện hay quá'), reply(ID3, 'hmm')], next_cursor: null }),
    [`POST api.test/admin/moderation/replies/${ID1}/hide`]: () => failHide ? res({}, 403) : res({ id: ID1, hidden: true, changed: true }),
    [`POST api.test/admin/moderation/replies/${ID1}/keep`]: res({ id: ID1, hidden: false, changed: false }),
    [`POST api.test/admin/moderation/replies/${ID3}/hide`]: res({ id: ID3, hidden: true, changed: true }),
  });
}
test('comments: pull stores pending, decide hides only the confident bad, keeps the confident ok, escalates the rest', async () => {
  const store = fakeStore({ clock: () => NOW }), fetch = modApi();
  const pulled = await go('comments_pull', {}, { store, fetchImpl: fetch });
  assert.equal(pulled.count, 3);
  assert.equal(pulled.notify, true);
  assert.equal(store.data.comments.length, 3);
  const out = await go('comments_decide', { verdicts: [
    { id: ID1, verdict: 'spam', confidence: 0.97, why: 'lure' },
    { id: ID2, verdict: 'ok', confidence: 0.9 },
    { id: ID3, verdict: 'abuse', confidence: 0.6, why: 'maybe' },
  ] }, { store, fetchImpl: fetch });
  assert.deepEqual(out.hidden, [{ id: ID1, reason: 'spam' }]);
  assert.deepEqual(out.kept.map(k => k.id), [ID2]);
  assert.deepEqual(out.escalated.map(k => k.id), [ID3], 'a 0.6 abuse is a person\'s call');
  assert.equal(out.awaiting_person, 1);
  assert.ok(out.ask && out.wake);
  assert.equal(fetch.calls.filter(c => c.method === 'POST').length, 1, 'only the one hide reached the api (ID2 was not flagged: no call)');
  assert.deepEqual(JSON.parse(fetch.calls.find(c => c.method === 'POST').body), { reason: 'spam' });
  // Pulled again: decided ones are not offered twice.
  const second = await go('comments_pull', {}, { store, fetchImpl: fetch });
  assert.equal(second.count, 0);
  assert.equal(second.notify, false);
  // A person resolves the escalated one; the need clears.
  const r = await go('comments_resolve', { id: ID3, action: 'hide', reason: 'abuse' }, { store, fetchImpl: fetch });
  assert.equal(r.state, 'hidden');
  assert.equal(r.resolves_need, true);
  await assert.rejects(go('comments_resolve', { id: ID1, action: 'keep' }, { store, fetchImpl: fetch }), /escalated/);
});
test('comments_decide: dry run calls nothing, the hide cap spills to a person, bad input is refused', async () => {
  const store = fakeStore({ clock: () => NOW }), fetch = modApi();
  await go('comments_pull', {}, { store, fetchImpl: fetch });
  const dry = await go('comments_decide', { dry_run: true, verdicts: [{ id: ID1, verdict: 'scam', confidence: 1 }] }, { store, fetchImpl: fetch });
  assert.equal(dry.hidden[0].dry_run, true);
  assert.equal(fetch.calls.filter(c => c.method === 'POST').length, 0);

  const many = fakeStore({ clock: () => NOW });
  const ids = Array.from({ length: 17 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (const id of ids) await many.insert('comments', { reply_id: id, source: 'recent', excerpt: 'x', state: 'pending' });
  const posts = router(Object.fromEntries(ids.map(id => [`POST api.test/admin/moderation/replies/${id}/hide`, res({ id, hidden: true, changed: true })])));
  const capped = await go('comments_decide', { verdicts: ids.map(id => ({ id, verdict: 'spam', confidence: 0.99 })) }, { store: many, fetchImpl: posts });
  assert.equal(capped.hidden.length, 15);
  assert.equal(capped.escalated.length, 2);

  const out = await go('comments_decide', { verdicts: [{ id: 'nope', verdict: 'spam', confidence: 1 }, { id: ID2, verdict: 'maybe', confidence: 1 }, { id: '44444444-4444-4444-8444-444444444444', verdict: 'ok', confidence: 0.9 }] }, { store, fetchImpl: fetch });
  assert.equal(out.rejected.length, 3, 'bad id, bad verdict, and a comment that was never pulled');
  await assert.rejects(go('comments_decide', { verdicts: [] }, { store }), /verdicts/);
});
test('comments: no key skips, a refusing api stops the batch with a named error', async () => {
  assert.equal((await go('comments_pull', {}, { env: { PRODUCT_API_URL: API }, fetchImpl: router({}) })).skipped, true);
  const store = fakeStore({ clock: () => NOW });
  await go('comments_pull', {}, { store, fetchImpl: modApi() });
  const out = await go('comments_decide', { verdicts: [{ id: ID1, verdict: 'spam', confidence: 1 }] }, { store, fetchImpl: modApi({ failHide: true }) });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'forbidden');
  assert.equal(store.data.comments.find(c => c.reply_id === ID1).state, 'pending', 'a failed hide is not recorded as hidden');
});

// ---------- App Store ----------
const entry = (id, rating, title, body) => ({ id: { label: id }, 'im:rating': { label: String(rating) }, title: { label: title }, content: { label: body }, 'im:version': { label: '1.2' }, updated: { label: '2026-11-09T10:00:00-07:00' }, author: { name: { label: 'Someone Private' } } });
const feed = entries => ({ feed: { entry: [{ id: { label: 'app' }, 'im:name': { label: 'Lohi' } }, ...entries] } });
const FEED_PATH = 'itunes.apple.com/vn/rss/customerreviews/id=6795186131/sortBy=mostRecent/page=1/json';
test('appstore_sync: stores new reviews without the reviewer, dedupes, lists the low ones, and an empty page ends', async () => {
  const store = fakeStore({ clock: () => NOW });
  const fetchImpl = router({ [`GET ${FEED_PATH}`]: res(feed([entry('r1', 2, 'Lỗi', 'Không đọc được'), entry('r2', 5, 'Tuyệt', 'Hay')])) });
  const a = await go('appstore_sync', { pages: 3 }, { store, fetchImpl });
  assert.equal(a.new_count, 2);
  assert.equal(a.needs_reply.length, 1);
  assert.equal(a.notify, true);
  assert.equal(a.average_rating, 3.5);
  assert.ok(!JSON.stringify(store.data.reviews).includes('Someone Private'));
  const b = await go('appstore_sync', { pages: 3 }, { store, fetchImpl });
  assert.equal(b.new_count, 0);
  assert.equal(b.notify, false);
  assert.equal(store.data.reviews.length, 2);
  const empty = await go('appstore_sync', {}, { fetchImpl: router({ [`GET ${FEED_PATH}`]: res('') }) });
  assert.equal(empty.ok, true);
  assert.equal(empty.new_count, 0);
  const down = await go('appstore_sync', {}, { fetchImpl: router({ [`GET ${FEED_PATH}`]: res({}, 503) }) });
  assert.equal(down.error.code, 'unreachable');
  await assert.rejects(go('appstore_sync', {}, { env: { APPSTORE_APP_ID: 'x;rm' }, fetchImpl: router({}) }), /APPSTORE_APP_ID/);
});
test('appstore_draft then appstore_post: no ASC key is a named credential need and posts nothing', async () => {
  const store = fakeStore({ clock: () => NOW });
  await go('appstore_sync', {}, { store, fetchImpl: router({ [`GET ${FEED_PATH}`]: res(feed([entry('r1', 2, 'Lỗi', 'Không đọc được')])) }) });
  await assert.rejects(go('appstore_draft', { rid: 'r1', reply: 'Gửi mail a@b.com nhé' }, { store }), /email/);
  await assert.rejects(go('appstore_draft', { rid: 'r1', reply: 'x'.repeat(1001) }, { store }), /reply/);
  assert.equal((await go('appstore_draft', { rid: 'r1', reply: 'Cảm ơn bạn, mình đã ghi nhận lỗi.' }, { store })).state, 'drafted');
  const f = router({});
  const out = await go('appstore_post', { rid: 'r1' }, { store, fetchImpl: f });
  assert.equal(out.reason_code, 'needs_credential');
  assert.equal(out.key, 'ASC_API_KEY');
  assert.equal(f.calls.length, 0);
  const bad = await go('appstore_post', { rid: 'r1' }, { store, env: { ...ENV, ASC_API_KEY: 'not json' }, fetchImpl: f });
  assert.equal(bad.reason_code, 'needs_credential');
  assert.equal(store.data.reviews[0].state, 'drafted');
});
test('appstore_post with a key: matches the review in App Store Connect, posts the reply, marks replied', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const cred = JSON.stringify({ key_id: 'KID', issuer_id: 'ISS', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const tok = ascToken(cred, NOW);
  const [h, b, s] = tok.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).kid, 'KID');
  assert.equal(JSON.parse(Buffer.from(b, 'base64url')).iss, 'ISS');
  assert.ok(verify('sha256', Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(ascToken('{}', NOW), null);

  const store = fakeStore({ clock: () => NOW });
  await go('appstore_sync', {}, { store, fetchImpl: router({ [`GET ${FEED_PATH}`]: res(feed([entry('r1', 2, 'Lỗi', 'Không đọc được')])) }) });
  await go('appstore_draft', { rid: 'r1', reply: 'Cảm ơn bạn.' }, { store });
  let posted;
  const fetchImpl = router({
    'GET api.appstoreconnect.apple.com/v1/apps/6795186131/customerReviews': res({ data: [{ id: 'asc-9', attributes: { rating: 2, title: 'Lỗi', body: 'Không đọc được' } }] }),
    'POST api.appstoreconnect.apple.com/v1/customerReviewResponses': (u, init) => { posted = JSON.parse(init.body); return res({}, 201); },
  });
  const out = await go('appstore_post', { rid: 'r1' }, { store, env: { ...ENV, ASC_API_KEY: cred }, fetchImpl });
  assert.equal(out.state, 'replied');
  assert.equal(posted.data.relationships.review.data.id, 'asc-9');
  assert.equal(store.data.reviews[0].asc_id, 'asc-9');
  assert.ok(fetchImpl.calls.every(c => c.host === 'api.appstoreconnect.apple.com'), 'the ASC token goes only to Apple');
  const again = await go('appstore_post', { rid: 'r1' }, { store, env: { ...ENV, ASC_API_KEY: cred }, fetchImpl });
  assert.equal(again.already, true);
});

// ---------- seo_report ----------
const gscCred = JSON.stringify({ type: 'google_oauth', refresh_token: 'rt', client_id: 'cid', client_secret: 'cs' });
function gscRoutes({ pages, queries, tokenStatus = 200 }) {
  return router({
    'POST oauth2.googleapis.com/token': tokenStatus === 200 ? res({ access_token: 'at' }) : res({ error: 'invalid_grant' }, tokenStatus),
    'POST searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Alohi2.com/searchAnalytics/query': (u, init) => res({ rows: JSON.parse(init.body).dimensions.length === 1 ? pages : queries }),
    'GET lohi2.com/truyen/tien-gioi': res('<html><title>Tiên giới</title><meta name="description" content="ngắn"></html>'),
  });
}
test('seo_report: flags low-CTR and near-page-one /truyen pages with a concrete change and a content opportunity', async () => {
  const U = 'https://lohi2.com/truyen/tien-gioi', V = 'https://lohi2.com/truyen/ok-page';
  const fetchImpl = gscRoutes({
    pages: [{ keys: [U], impressions: 2000, clicks: 4, position: 4.2 }, { keys: [V], impressions: 500, clicks: 100, position: 3 }, { keys: ['https://lohi2.com/truyen/tiny'], impressions: 5, clicks: 0, position: 2 }],
    queries: [{ keys: [U, 'tiên giới đọc online'], impressions: 900, clicks: 2, position: 4 }],
  });
  const out = await run('seo_report', { input: {} }, { now: NOW, env: { GSC_GOOGLE: gscCred }, fetchImpl });
  assert.equal(out.ok, true);
  assert.deepEqual(out.pages.map(p => p.url), [U]);
  assert.equal(out.pages[0].issue, 'low_ctr');
  assert.equal(out.pages[0].current.title, 'Tiên giới');
  assert.ok(out.pages[0].suggestions.length >= 1);
  assert.equal(out.opportunities[0].kind, 'content');
  assert.equal(out.opportunities[0].product, 'lohi');
  assert.ok(out.opportunities[0].evidence_refs.length >= 1);
});
test('seo_report: no credential skips quietly; a revoked sign-in asks the person; the store is not needed', async () => {
  assert.equal((await run('seo_report', { input: {} }, { now: NOW, env: {}, fetchImpl: router({}) })).skipped, true);
  const out = await run('seo_report', { input: {} }, { now: NOW, env: { GSC_GOOGLE: gscCred }, fetchImpl: gscRoutes({ pages: [], queries: [], tokenStatus: 400 }) });
  assert.equal(out.status, 'needs_person');
  assert.equal(out.needs_person.credential, 'GSC_GOOGLE');
  const junk = await run('seo_report', { input: {} }, { now: NOW, env: { GSC_GOOGLE: 'garbage' }, fetchImpl: router({}) });
  assert.equal(junk.status, 'needs_person');
});

// ---------- pricing_report ----------
const board = (over = {}) => ({ metrics: { signups: { value: 200 }, first_payers: { value: 4 }, payers: { value: 4 }, revenue_vnd: { value: 400000 }, topups: { value: 6 } }, ...over });
test('analyze: funnel, plan mix and cohort retention with hypotheses that always defer to the founder', () => {
  const out = analyze(board({
    plans: [{ tier: 'a', started: 18, active: 10, revenue_vnd: 90000 }, { tier: 'b', started: 2, active: 1, revenue_vnd: 20000 }, { tier: 'c', started: 0, active: 0, revenue_vnd: 0 }],
    cohorts: [{ cohort: '2026-W44', signups: 100, active_w1: 10, active_w2: null, active_w4: null, first_payers: 2 }],
  }));
  assert.equal(out.funnel.payer_rate_pct, 2);
  assert.equal(out.plans[0].share_of_started_pct, 90);
  assert.equal(out.cohorts[0].w4_pct, null);
  const topics = out.suggestions.map(s => s.topic);
  assert.ok(topics.includes('lần nạp đầu') && topics.includes('cơ cấu gói') && topics.includes('giữ chân') && topics.includes('gói c'));
  assert.ok(out.suggestions.every(s => s.decision === 'founder'));
  assert.equal(out.not_yet_available, undefined);
});
test('analyze: a small sample only says to wait, and missing plans/cohorts are named, not guessed', () => {
  const small = analyze(board({ metrics: { signups: { value: MIN_SIGNUPS - 1 }, first_payers: { value: 0 } } }));
  assert.equal(small.enough_data, false);
  assert.equal(small.suggestions.length, 1);
  assert.deepEqual(small.not_yet_available, ['plans', 'cohorts']);
});
test('pricing_report: reads the scoreboard with the key to the api only, never writes; skip and refusal are quiet and named', async () => {
  const fetchImpl = router({ 'GET api.test/admin/analysis/scoreboard': res(board()) });
  const out = await run('pricing_report', { input: { days: 14 } }, { now: NOW, env: ENV, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.read_only, true);
  assert.deepEqual(fetchImpl.calls.map(c => c.method), ['GET']);
  assert.match(fetchImpl.calls[0].search, /from=2026-10-27&to=2026-11-09/);
  assert.equal((await run('pricing_report', { input: {} }, { now: NOW, env: {}, fetchImpl })).skipped, true);
  const denied = await run('pricing_report', { input: {} }, { now: NOW, env: ENV, fetchImpl: router({ 'GET api.test/admin/analysis/scoreboard': res({}, 401) }) });
  assert.equal(denied.error.code, 'forbidden');
});

test('an unknown tool is refused', async () => {
  await assert.rejects(run('hide_everything', {}, {}), /Unknown tool/);
});
