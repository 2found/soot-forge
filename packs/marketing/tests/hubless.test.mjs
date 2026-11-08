// Hubless mode (AC1, AC3, AC11 core): the full loop on the pack's own
// storage, every guard rule, the claim's refusals and crash safety, and
// Search Console. Runs on an in-memory store with the route's semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, signInExit } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { checkFacts, checkPersonal, checkPlatform, checkDuplicate, claimWindow, factClaims, CHANNEL_DEFAULTS } from '../tools/lib/guard.mjs';
import { verifyClaim as publisherVerify, contentHash as publisherHash } from '../../../examples/lohi-marketing/packs/lohi-blog/tools/blog.mjs';
import { verifyClaim, contentHash, signClaim } from '../tools/lib/claim.mjs';
import { inQuiet } from '../tools/lib/time.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-10T03:00:00Z'); // 10:00 in Asia/Ho_Chi_Minh
const H = 3_600_000, DAY = 24 * H;

function world({ now = T0, env = {} } = {}) {
  const w = { now };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { MARKETING_CLAIM_KEY: KEY, ...env };
  w.fetch = async () => { throw new Error('no network in this test'); };
  w.call = async (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch });
  return w;
}

const BODY = 'Nếu bạn mê tiên hiệp, đây là chín bộ đáng đọc nhất năm nay, mỗi bộ một lý do riêng. '
  + 'Xem thêm [kho truyện](https://lohi2.com/novel/tien-hiep) và [bài ngôn tình](https://blog.lohi2.com/truyen-hay/11-canh/vi/). '
  + 'Gói Audio chỉ 49.000đ một tháng.';
const ARTICLE = {
  kind: 'article', channel: 'blog-lohi', body: BODY,
  brief: { keyword: 'truyện tiên hiệp hay', title: 'Truyện tiên hiệp hay nhất 2026: 9 bộ đáng đọc', meta: 'Chín bộ truyện tiên hiệp hay nhất 2026 cho người mới và người đọc lâu năm: cốt truyện, độ dài, điểm nổi bật và nơi đọc nghe miễn phí thử.'.slice(0, 150), slug: 'truyen-tien-hiep-hay-nhat-2026', series: 'truyen-hay' },
};

async function withFacts(w, facts = { pricing: { audio_monthly: 49000 }, trial: { free_days: 7 } }) {
  w.fetch = async url => ({ ok: true, status: 200, json: async () => facts, url });
  const out = await w.call('facts_sync', { url: 'https://api.example/novel/v1/app-config' });
  w.fetch = async () => { throw new Error('no network'); };
  return out;
}

async function readyPost(w, over = {}) {
  await withFacts(w);
  const d = await w.call('draft_save', { request_id: 'req-' + Math.random(), ...ARTICLE, ...over });
  const c = await w.call('check', { id: d.id, revision: d.revision, verdict: 'pass', reasons: [] });
  return { ...d, check: c };
}

test('AC1: draft → check → schedule → due → claim → publish → record, with no hub, and the pages show it', async () => {
  const w = world();
  const d = await readyPost(w);
  assert.deepEqual(d.check.auto.map(a => [a.rule, a.ok]), [['facts', true], ['personal_data', true], ['platform', true], ['duplicate', true], ['links', true]]);
  assert.equal(d.check.verdict, 'pass');
  const s = await w.call('schedule', { id: d.id });
  assert.ok(Date.parse(s.scheduled_at) >= T0);
  assert.deepEqual((await w.call('due', {})).publish, Date.parse(s.scheduled_at) <= w.now ? [d.id] : []);
  w.now = Date.parse(s.scheduled_at) + 60_000;
  const due = await w.call('due', {});
  assert.equal(due.wake, true);
  assert.equal(due.notify, true, 'the runtime wakes on the boolean notify');
  assert.deepEqual(due.publish, [d.id]);

  const { claim, verify_first } = await w.call('claim', { id: d.id, action: 'publish' });
  assert.equal(verify_first, undefined);
  assert.equal(claim.publisher, 'lohi-blog');
  assert.equal(claim.series, 'truyen-hay');
  assert.equal(publisherVerify(claim, KEY, w.now), null, 'the publisher accepts the marketing pack\'s claim');
  // The intent row exists before anything goes out.
  assert.deepEqual(w.store.data.publish_log.map(r => [r.intent_id, r.status]), [[claim.intent_id, 'intent']]);
  assert.equal(w.store.data.posts[0].state, 'publishing');

  const url = 'https://blog.lohi2.com/truyen-hay/truyen-tien-hiep-hay-nhat-2026/vi/';
  const rec = await w.call('record', { intent_id: claim.intent_id, url, platform_id: 'abc123' });
  assert.deepEqual(rec, { state: 'published', outcome: { id: 'post_published', ref: url } });
  assert.deepEqual(await w.call('record', { intent_id: claim.intent_id, url }), { ...rec, replayed: true }, 'record is idempotent');
  assert.equal(w.store.data.queue.length, 0);
  assert.equal(w.store.data.publish_log[0].status, 'published');

  const list = await w.call('page_view', {}, { page: { soot: 'lohi-editor', page: 'bai-viet', mode: 'view' } });
  assert.equal(list.page, 'bai-viet');
  assert.equal(list.counts.published, 1);
  assert.equal(list.items[0].url, url);
  assert.equal(list.items[0].metrics_28, null, 'no Search Console read yet: null, never 0');
  const q = await w.call('page_view', {}, { page: { page: 'hang-doi' } });
  assert.equal(q.empty, true);
  assert.equal(q.recent[0].status, 'published');
  assert.equal(q.channels[0].id, 'blog-lohi');
});

test('draft_save lints the article brief and replays a request id', async () => {
  const w = world();
  const bad = await w.call('draft_save', { request_id: 'r1', kind: 'article', channel: 'blog-lohi', body: 'ngắn', brief: { title: 'Ngắn', meta: 'x', slug: 'Bad Slug', keyword: 'zzz' } });
  assert.deepEqual(bad.lint.map(l => l.code).sort(), ['internal_links', 'keyword_missing', 'meta_length', 'slug_invalid', 'title_length']);
  const again = await w.call('draft_save', { request_id: 'r1', kind: 'article', channel: 'blog-lohi', body: 'khác' });
  assert.equal(again.id, bad.id);
  assert.equal(again.replayed, true);
  await assert.rejects(w.call('draft_save', { id: bad.id, expected_revision: 9, kind: 'article', channel: 'blog-lohi', body: 'x' }), { code: 'revision_conflict' });
  await assert.rejects(w.call('draft_save', { request_id: 'r2', kind: 'article', channel: 'myspace', body: 'x' }), { code: 'unknown_channel' });
});

// ---------- §4.1 rule by rule ----------

test('rule 1 facts: amounts, percentages and "miễn phí" must match a fact read within 24 h', () => {
  const now = T0;
  const facts = [{ key: 'pricing.audio_monthly', value: 49000, fetched_at: new Date(now - H).toISOString() }, { key: 'trial.free_days', value: 7, fetched_at: new Date(now - H).toISOString() }];
  assert.deepEqual(factClaims('Giá 49.000đ, giảm 50%, 1,5 triệu và 99k, miễn phí').map(c => [c.kind, c.value]), [['money', 49000], ['money', 1500000], ['money', 99000], ['percent', 50], ['free', undefined]]);
  assert.equal(checkFacts('Gói Audio 49.000đ/tháng', facts, now).ok, true);
  assert.equal(checkFacts('Gói Audio 49k', facts, now).ok, true);
  assert.equal(checkFacts('Nghe miễn phí 7 ngày', facts, now).ok, true);
  const r = checkFacts('Gói Audio giảm 50% cho bạn mới', facts, now);
  assert.equal(r.ok, false); assert.equal(r.code, 'fact_unsourced'); assert.match(r.detail, /"50%" không có/);
  const twice = checkFacts('Giảm 50% hôm nay. Nhớ: giảm 50% chỉ tuần này, 50% thật.', facts.map(f => ({ ...f, source_url: 'https://api.example/novel/v1/app-config' })), now);
  assert.equal(twice.detail.match(/"50%"/g).length, 1, 'one line per unsourced claim');
  assert.equal(twice.source, `Nguồn: app-config đọc lúc ${new Date(now - H).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })} — pricing.audio_monthly 49.000, trial.free_days 7`);
  assert.equal(checkFacts('Chỉ 39.000đ', facts, now).ok, false);
  const stale = facts.map(f => ({ ...f, fetched_at: new Date(now - 25 * H).toISOString() }));
  assert.equal(checkFacts('Gói Audio 49.000đ', stale, now).ok, false, 'facts older than 24 h do not count');
  assert.equal(checkFacts('Nghe miễn phí', [facts[0]], now).ok, false);
});

test('rule 2 personal data: email, VN phone, id-like number and a foreign @handle', () => {
  for (const s of ['liên hệ an.nguyen@gmail.com', 'gọi 0912 345 678', 'số +84912345678', 'CCCD 001203004567', 'cảm ơn @reader_99']) assert.equal(checkPersonal(s).ok, false, s);
  assert.equal(checkPersonal('cảm ơn @reader_99', { replyTarget: 'reader_99' }).ok, true);
  assert.equal(checkPersonal('Gói 49.000đ, 9 bộ truyện năm 2026').ok, true);
});

test('rule 3 platform: X length with links, no link in an X reply, Facebook engagement bait, blog brief', () => {
  const x = { key: 'x', ...CHANNEL_DEFAULTS.x };
  assert.equal(checkPlatform({ kind: 'social', body: 'a'.repeat(256), link: 'https://lohi2.com/x' }, x).ok, true, '256 + a 23-char link + space = 280');
  assert.equal(checkPlatform({ kind: 'social', body: 'a'.repeat(257), link: 'https://lohi2.com/x' }, x).code, 'too_long');
  assert.equal(checkPlatform({ kind: 'social', body: 'a'.repeat(257) + ' https://a.b/c', link: 'https://lohi2.com/x' }, x).code, 'too_long');
  assert.equal(checkPlatform({ kind: 'reply', body: 'xem https://lohi2.com' }, x).code, 'reply_link');
  assert.equal(checkPlatform({ kind: 'social', body: 'Like nếu bạn cũng mê truyện' }, { key: 'facebook', ...CHANNEL_DEFAULTS.facebook }).code, 'engagement_bait');
  assert.equal(checkPlatform({ kind: 'article', body: 'x', brief: { title: 'ngắn' } }, { key: 'blog-lohi', ...CHANNEL_DEFAULTS['blog-lohi'] }).code, 'brief_lint');
});

test('rule 4 tone: the editor\'s fail refuses the post even when every automatic check passes', async () => {
  const w = world();
  await withFacts(w);
  const d = await w.call('draft_save', { request_id: 'r', ...ARTICLE });
  const c = await w.call('check', { id: d.id, revision: 1, verdict: 'fail', reasons: ['Giọng văn quá quảng cáo.'] });
  assert.equal(c.verdict, 'fail');
  assert.ok(c.auto.every(a => a.ok));
  assert.equal(w.store.data.posts[0].state, 'refused');
  assert.equal(w.store.data.posts[0].reason, 'Giọng văn quá quảng cáo.');
});

test('rule 5 duplicate: 80 % trigram overlap in 90 days, or the same link on the channel in 14 days', () => {
  const now = T0, at = new Date(now - 10 * DAY).toISOString();
  const log = [{ status: 'published', action: 'publish', body: BODY, link: 'https://lohi2.com/a', channel: 'x', at }];
  assert.equal(checkDuplicate({ body: BODY.replace('chín', '9'), channel: 'x' }, log, now).code, 'duplicate');
  assert.equal(checkDuplicate({ body: 'Một bài hoàn toàn khác về truyện đam mỹ.', link: 'https://lohi2.com/a', channel: 'x' }, log, now).code, 'duplicate');
  assert.equal(checkDuplicate({ body: 'Một bài hoàn toàn khác về truyện đam mỹ.', link: 'https://lohi2.com/a', channel: 'facebook' }, log, now).ok, true);
  assert.equal(checkDuplicate({ body: BODY, channel: 'x' }, log, now + 81 * DAY).ok, true, 'older than 90 days');
});

test('rule 6 at claim time: pause, quiet hours, cap and spacing are waits', () => {
  const ch = { key: 'blog-lohi', ...CHANNEL_DEFAULTS['blog-lohi'], paused: false };
  const base = { settings: { paused_all: false }, channel: ch, log: [], now: T0 };
  assert.equal(claimWindow(base), null);
  assert.equal(claimWindow({ ...base, settings: { paused_all: true } }).code, 'paused');
  assert.equal(claimWindow({ ...base, channel: { ...ch, paused: true } }).code, 'paused');
  assert.equal(claimWindow({ ...base, now: Date.parse('2026-11-10T17:00:00Z') }).code, 'quiet_hours', '00:00 local');
  const today = [{ action: 'publish', status: 'published', at: new Date(T0 - 2 * H).toISOString() }];
  assert.equal(claimWindow({ ...base, log: today }).code, 'over_cap');
  assert.equal(claimWindow({ ...base, channel: { ...ch, cap_per_day: 3 }, log: today }).code, 'spacing');
  assert.equal(claimWindow({ ...base, log: [{ action: 'publish', status: 'failed', at: today[0].at }] }), null, 'a failed attempt does not use the cap');
});

// ---------- the claim ----------

async function scheduledNow(w) {
  const d = await readyPost(w);
  await w.call('schedule', { id: d.id, scheduled_at: new Date(w.now - 60_000).toISOString() });
  return d;
}

test('AC11: a guard-failed item is never posted and shows its reason', async () => {
  const w = world();
  await withFacts(w);
  const d = await w.call('draft_save', { request_id: 'r', ...ARTICLE, body: BODY.replace('49.000đ một tháng', '49.000đ, giảm 50% cho bạn mới') });
  const c = await w.call('check', { id: d.id, revision: 1, verdict: 'pass', reasons: [] });
  assert.equal(c.verdict, 'fail');
  await assert.rejects(w.call('schedule', { id: d.id }), { code: 'not_ready' });
  const claim = await w.call('claim', { id: d.id, action: 'publish' });
  assert.equal(claim.claim, undefined);
  assert.equal(claim.refused.code, 'not_queued');
  assert.equal(w.store.data.publish_log.length, 0, 'no intent, so no publisher is ever called');
  const view = await w.call('page_view', { page: 'bai-viet', id: d.id });
  assert.equal(view.post.state, 'refused');
  assert.match(view.post.reason, /50%/);
  assert.equal(view.check.auto.find(a => a.rule === 'facts').ok, false);
});

test('the claim re-runs the guard: facts gone stale between check and claim refuse the post', async () => {
  const w = world();
  const d = await scheduledNow(w);
  w.now += 25 * H; // facts read at T0 are now older than 24 h
  await w.call('schedule', { id: d.id, scheduled_at: new Date(w.now - 60_000).toISOString() });
  const out = await w.call('claim', { id: d.id, action: 'publish' });
  assert.equal(out.refused.code, 'fact_unsourced');
  assert.equal(w.store.data.posts[0].state, 'refused');
  assert.equal(w.store.data.queue.length, 0);
});

test('the claim refuses while paused, in quiet hours, over the cap and before its time; the post keeps waiting', async () => {
  const w = world();
  const d = await scheduledNow(w);
  await w.call('pause', { paused: true });
  assert.equal((await w.call('claim', { id: d.id, action: 'publish' })).refused.code, 'paused');
  assert.equal((await w.call('due', {})).publish.length, 0, 'due wakes nobody while paused');
  await w.call('pause', { paused: false });
  await w.call('pause', { channel: 'blog-lohi', paused: true });
  assert.equal((await w.call('claim', { id: d.id, action: 'publish' })).refused.code, 'paused');
  await w.call('pause', { channel: 'blog-lohi', paused: false });

  const quiet = world({ now: Date.parse('2026-11-10T18:00:00Z') }); // 01:00 local
  const dq = await scheduledNow(quiet);
  const r = await quiet.call('claim', { id: dq.id, action: 'publish' });
  assert.equal(r.refused.code, 'quiet_hours');
  assert.equal(quiet.store.data.posts[0].state, 'scheduled');
  assert.match(quiet.store.data.queue[0].wait_reason, /giờ yên/);

  // Over the cap: one post already went out today on the blog.
  const { claim } = await w.call('claim', { id: d.id, action: 'publish' });
  await w.call('record', { intent_id: claim.intent_id, url: 'https://blog.lohi2.com/a/b/vi/' });
  const d2 = await w.call('draft_save', { request_id: 'second', ...ARTICLE, body: 'Một bài khác hẳn về truyện kiếm hiệp, không trùng gì với bài trước. https://lohi2.com/a https://lohi2.com/b', brief: { ...ARTICLE.brief, slug: 'kiem-hiep-hay', keyword: 'truyện' } });
  await w.call('check', { id: d2.id, revision: 1, verdict: 'pass', reasons: [] });
  await w.call('schedule', { id: d2.id, scheduled_at: new Date(w.now - 1000).toISOString() });
  assert.equal((await w.call('claim', { id: d2.id, action: 'publish' })).refused.code, 'over_cap');
  await w.call('schedule', { id: d2.id, scheduled_at: new Date(w.now + DAY).toISOString() });
  assert.equal((await w.call('claim', { id: d2.id, action: 'publish' })).refused.code, 'not_due');
  // Without a time the next free slot respects cap, spacing and quiet hours.
  const s = await w.call('schedule', { id: d2.id });
  assert.ok(Date.parse(s.scheduled_at) - w.now >= 20 * H - 10 * 60_000, s.scheduled_at);
});

test('a crash between post and record never posts twice: the same intent comes back with verify_first', async () => {
  const w = world();
  const d = await scheduledNow(w);
  const [a, b] = await Promise.all([w.call('claim', { id: d.id, action: 'publish' }), w.call('claim', { id: d.id, action: 'publish' })]);
  const won = [a, b].filter(x => x.claim);
  assert.equal(won.length, 1, 'the compare-and-set lets one caller through');
  assert.equal([a, b].find(x => x.refused).refused.code, 'open_intent');
  const first = won[0].claim;
  // The publisher posted, then the Soot crashed before record.
  w.now += 11 * 60_000;
  assert.deepEqual((await w.call('due', {})).publish, [], 'a publisher may still be deploying: not due yet');
  assert.equal((await w.call('claim', { id: d.id, action: 'publish' })).refused.code, 'open_intent', 'never raced by a second claim inside the publisher timeout');
  w.now += 20 * 60_000;
  assert.deepEqual((await w.call('due', {})).publish, [d.id], 'a stuck intent is due again');
  const again = await w.call('claim', { id: d.id, action: 'publish' });
  assert.equal(again.verify_first, true);
  assert.equal(again.claim.intent_id, first.intent_id, 'same intent: the publisher finds its earlier post');
  assert.equal(w.store.data.publish_log.length, 1);
  await w.call('record', { intent_id: first.intent_id, url: 'https://blog.lohi2.com/x/y/vi/' });
  assert.equal(w.store.data.posts[0].state, 'published');
});

test('fail: a retry is never promised inside quiet hours', async () => {
  const w = world();
  const d = await scheduledNow(w);
  const c = (await w.call('claim', { id: d.id, action: 'publish' })).claim;
  // 22:20 local (UTC+7): an hour later is 23:20, inside the 23:00-07:00 quiet hours.
  const local = new Date(w.now + 7 * 3600e3);
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 22, 20) - 7 * 3600e3;
  w.now = target > w.now - 1 ? target : target + 24 * 3600e3;
  await w.call('fail', { intent_id: c.intent_id, status: 'failed', reason: 'deploy_failed' });
  const at = Date.parse(w.store.data.queue[0].scheduled_at);
  assert.ok(!inQuiet(at), 'the retry time is outside quiet hours');
  assert.ok(at >= w.now + 3600e3, 'and no earlier than an hour on');
});

test('fail: failed retries later, needs_person pauses the channel, uncertain keeps the intent', async () => {
  const w = world();
  const d = await scheduledNow(w);
  const c1 = (await w.call('claim', { id: d.id, action: 'publish' })).claim;
  assert.deepEqual(await w.call('fail', { intent_id: c1.intent_id, status: 'failed', reason: 'deploy_failed' }), { state: 'failed' });
  assert.equal(w.store.data.queue[0].intent_id, null);
  assert.equal(w.store.data.queue[0].wait_reason, 'deploy_failed');
  assert.equal((await w.call('claim', { id: d.id, action: 'publish' })).refused.code, 'not_due', 'retry in an hour');
  w.now += H + 1000;
  const c2 = (await w.call('claim', { id: d.id, action: 'publish' })).claim;
  assert.notEqual(c2.intent_id, c1.intent_id);
  await w.call('fail', { intent_id: c2.intent_id, status: 'uncertain', reason: 'tool crashed' });
  await assert.rejects(w.call('draft_save', { id: d.id, expected_revision: 1, ...ARTICLE, body: ARTICLE.body + ' Sửa sau.' }), { code: 'conflict' }, 'an uncertain post may be live: no edit rides on its open intent');
  w.now += 31 * 60_000;
  const c3 = await w.call('claim', { id: d.id, action: 'publish' });
  assert.equal(c3.claim.intent_id, c2.intent_id);
  assert.equal(c3.verify_first, true);
  await w.call('fail', { intent_id: c2.intent_id, status: 'needs_person', reason: 'signed_out' });
  assert.equal(w.store.data.channels[0].paused, true);
  assert.equal(w.store.data.channels[0].paused_reason, 'signed_out');
  assert.deepEqual((await w.call('due', {})).needs_person, [{ id: 'blog-lohi', channel: 'blog-lohi', reason: 'signed_out' }]);
});

test('a forged or expired claim fails verification; both pack copies agree on one vector', () => {
  const claim = signClaim({ intent_id: 'I-0123456789abcdef', post: 'P-0123456789', title: 'A', meta: 'B', slug: 'a-b', body: 'C', link: '', content_hash: contentHash({ title: 'A', meta: 'B', slug: 'a-b', body: 'C', link: '' }), expires_at: new Date(T0 + 60_000).toISOString() }, KEY);
  assert.equal(contentHash(claim), publisherHash(claim));
  assert.match(claim.sig, /^[0-9a-f]{64}$/);
  for (const verify of [verifyClaim, publisherVerify]) {
    assert.equal(verify(claim, KEY, T0), null);
    assert.equal(verify({ ...claim, body: 'D' }, KEY, T0), 'claim_forged');
    assert.equal(verify(claim, 'other-key', T0), 'claim_forged');
    assert.equal(verify(claim, KEY, T0 + 61_000), 'claim_expired');
    assert.equal(verify({ ...claim, sig: undefined }, KEY, T0), 'claim_unsigned');
    const resigned = signClaim({ ...claim, body: 'D' }, KEY);
    assert.equal(verify(resigned, KEY, T0), 'claim_hash_mismatch');
  }
});

test('unpublish from the page goes through the same claim and ends removed', async () => {
  const w = world();
  const d = await scheduledNow(w);
  const { claim } = await w.call('claim', { id: d.id, action: 'publish' });
  await w.call('record', { intent_id: claim.intent_id, url: 'https://blog.lohi2.com/a/b/vi/' });
  await assert.rejects(w.call('page_action', { op: 'unpublish', request_id: 'req-00000001', id: 'P-0000000000' }), { code: 'not_found' });
  await w.call('page_action', { op: 'unpublish', request_id: 'req-00000002', id: d.id });
  w.now += 1000;
  assert.deepEqual((await w.call('due', {})).unpublish, [d.id]);
  await w.call('pause', { paused: true });
  const u = await w.call('claim', { id: d.id, action: 'unpublish' });
  assert.equal(u.claim.action, 'unpublish', 'taking a post down is allowed while paused');
  assert.equal(u.claim.url, 'https://blog.lohi2.com/a/b/vi/');
  assert.deepEqual(await w.call('record', { intent_id: u.claim.intent_id }), { state: 'removed' });
  assert.equal(w.store.data.posts[0].state, 'removed');
});

test('page actions pull and restore a queued post; pages refuse unknown ops', async () => {
  const w = world();
  const d = await scheduledNow(w);
  assert.equal((await w.call('page_action', { op: 'pull', request_id: 'req-00000003', id: d.id })).state, 'pulled');
  assert.equal(w.store.data.queue.length, 0);
  assert.equal((await w.call('page_action', { op: 'restore', request_id: 'req-00000004', id: d.id })).state, 'scheduled');
  await w.call('page_action', { op: 'pause', request_id: 'req-00000005' });
  const q = await w.call('page_view', { page: 'hang-doi' });
  assert.equal(q.paused_all, true);
  assert.equal(q.items[0].id, d.id);
  await assert.rejects(w.call('page_action', { op: 'publish', request_id: 'req-00000006', id: d.id }), { code: 'invalid_request' });
});

// ---------- Search Console (AC3) ----------

function google({ grant = 'ok', rows }) {
  const calls = [];
  return Object.assign(async (url, init) => {
    calls.push({ url, body: init?.body });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      if (grant === 'revoked') return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
      assert.match(init.body, /grant_type=refresh_token&refresh_token=rt-1&client_id=cid/);
      return { ok: true, status: 200, json: async () => ({ access_token: 'at-1' }) };
    }
    assert.match(url, /^https:\/\/searchconsole\.googleapis\.com\/webmasters\/v3\/sites\/sc-domain%3Alohi2\.com\/searchAnalytics\/query$/);
    assert.equal(init.headers.Authorization, 'Bearer at-1');
    const dims = JSON.parse(init.body).dimensions;
    return { ok: true, status: 200, json: async () => ({ rows: rows[dims.join(',')] }) };
  }, { calls });
}
const GSC = JSON.stringify({ type: 'google_oauth', client_id: 'cid', client_secret: 'cs', refresh_token: 'rt-1', scope: 'https://www.googleapis.com/auth/webmasters.readonly', account: 'founder@example.com' });

test('AC3: gsc_sync fills metrics for published URLs; the post shows numbers; seo_brief returns queries', async () => {
  const w = world({ env: { GSC_GOOGLE: GSC } });
  const d = await scheduledNow(w);
  const url = 'https://blog.lohi2.com/truyen-hay/truyen-tien-hiep-hay-nhat-2026/vi/';
  const { claim } = await w.call('claim', { id: d.id, action: 'publish' });
  await w.call('record', { intent_id: claim.intent_id, url });

  const before = await w.call('page_view', { page: 'bai-viet', id: d.id });
  assert.equal(before.search_console.last_28, null, '"Chưa có số liệu" before the first read, never 0');
  assert.deepEqual((await w.call('seo_brief', {})).posts[0].last_14_days, null);

  w.fetch = google({ rows: {
    'page,date': [{ keys: [url, '2026-11-08'], impressions: 120, clicks: 6, position: 7.4 }, { keys: [url, '2026-11-09'], impressions: 80, clicks: 2, position: 9 }, { keys: ['https://blog.lohi2.com/other/', '2026-11-09'], impressions: 999, clicks: 9, position: 1 }],
    'page,query': [{ keys: [url, 'truyện tiên hiệp hay'], impressions: 150, clicks: 1, position: 11.2 }, { keys: [url, 'tiên hiệp'], impressions: 10, clicks: 0, position: 15 }, { keys: [url, 'top tiên hiệp'], impressions: 40, clicks: 3, position: 3 }],
  } });
  const out = await w.call('gsc_sync', { site: 'sc-domain:lohi2.com', days: 3 });
  assert.deepEqual(out, { status: 'ok', rows: 5, urls: 1, listed: 3, matched: 2 });
  assert.ok(!w.store.data.metrics.some(r => r.url.endsWith('/other/')), 'only published post URLs are kept');
  await w.call('gsc_sync', { site: 'sc-domain:lohi2.com', days: 3 });
  assert.equal(w.store.data.metrics.length, 5, 'a second read replaces, never doubles');

  const detail = await w.call('page_view', { page: 'bai-viet', id: d.id });
  assert.deepEqual(detail.search_console.last_28, { impressions: 200, clicks: 8, position: 8 });
  assert.equal(detail.search_console.queries[0].query, 'truyện tiên hiệp hay');
  const brief = await w.call('seo_brief', {});
  assert.deepEqual(brief.queries.map(q => q.query), ['truyện tiên hiệp hay'], 'impressions ≥ 20 and position 8–20 or CTR < 1 %');
  assert.deepEqual(brief.posts[0].last_14_days, { impressions: 200, clicks: 8, position: 8 });
});

test('AC3 non-happy: no sign-in or a revoked token answers needs_person and stores nothing', async () => {
  // Never signed in: Search Console is optional, so this is a quiet skip (no sign-in item, no failure) ...
  const none = world();
  const skipped = await none.call('gsc_sync', { site: 'sc-domain:lohi2.com' });
  assert.deepEqual([skipped.skipped, skipped.reason_code, skipped.key, skipped.needs_person], [true, 'optional_credential', 'GSC_GOOGLE', undefined]);
  assert.equal(none.store.data.metrics.length, 0);
  // ... but a sign-in that worked once and then vanished is a person's job again.
  assert.equal(none.store.data.settings.find(s => s.key === 'gsc').value.state, 'not_connected', 'the reason for 0 rows is kept for the report');
  assert.match(skipped.message, /Đăng nhập Google/);
  none.store.data.settings.find(s => s.key === 'gsc').value = { state: 'ok', at: new Date(T0).toISOString() };
  assert.equal((await none.call('gsc_sync', { site: 'sc-domain:lohi2.com' })).status, 'needs_person');
  const w = world({ env: { GSC_GOOGLE: GSC } });
  w.fetch = google({ grant: 'revoked', rows: {} });
  const out = await w.call('gsc_sync', { site: 'sc-domain:lohi2.com' });
  assert.deepEqual([out.status, out.reason], ['needs_person', 'revoked']);
  assert.deepEqual(out.needs_person, { credential: 'GSC_GOOGLE', reason: 'oauth_revoked' }, 'the host sign-in signal');
  assert.equal(w.store.data.metrics.length, 0);
  assert.equal(w.store.data.settings.find(s => s.key === 'gsc').value.state, 'needs_person');
});

test('gsc_sync: a trailing slash does not drop the rows, and an empty read says why instead of a bare 0', async () => {
  const w = world({ env: { GSC_GOOGLE: GSC } });
  const d = await scheduledNow(w);
  const url = 'https://blog.lohi2.com/truyen-hay/x/vi/';
  const { claim } = await w.call('claim', { id: d.id, action: 'publish' });
  await w.call('record', { intent_id: claim.intent_id, url });
  w.fetch = google({ rows: { 'page,date': [{ keys: ['https://BLOG.lohi2.com/truyen-hay/x/vi', '2026-11-08'], impressions: 10, clicks: 1, position: 5 }], 'page,query': [] } });
  const ok = await w.call('gsc_sync', { site: 'sc-domain:lohi2.com' });
  assert.deepEqual([ok.rows, ok.matched, ok.why], [1, 1, undefined]);
  assert.equal(w.store.data.metrics[0].url, url, 'stored under the post\'s own url');
  // Google lists pages, none of them ours.
  w.fetch = google({ rows: { 'page,date': [{ keys: ['https://blog.lohi2.com/other/', '2026-11-08'], impressions: 9, clicks: 0, position: 5 }], 'page,query': [] } });
  const other = await w.call('gsc_sync', { site: 'sc-domain:lohi2.com' });
  assert.deepEqual([other.listed, other.matched, other.why], [1, 0, 'no_page_matches_a_post']);
  // Google lists nothing.
  w.fetch = google({ rows: { 'page,date': [], 'page,query': [] } });
  assert.equal((await w.call('gsc_sync', { site: 'sc-domain:lohi2.com' })).why, 'search_console_listed_nothing');
  assert.equal(w.store.data.settings.find(s => s.key === 'gsc').value.why, 'search_console_listed_nothing');
});

test('gsc_sync: a signed-in account without access to the property is named, not a generic sign-in item', async () => {
  const w = world({ env: { GSC_GOOGLE: GSC } });
  w.fetch = async (u, init) => (String(u).includes('searchAnalytics') ? { ok: false, status: 403, json: async () => ({}) } : google({ rows: {} })(u, init));
  const out = await w.call('gsc_sync', { site: 'sc-domain:lohi2.com' });
  assert.deepEqual([out.status, out.needs_person, out.notify], ['no_access', undefined, false]);
  assert.match(out.message, /không có quyền đọc sc-domain:lohi2\.com/);
  assert.equal(w.store.data.settings.find(s => s.key === 'gsc').value.state, 'no_access');
});

// ---------- the real entry over HTTP ----------

test('the CLI entry talks to pack storage over HTTP with the per-call token and answers tool errors as output', async () => {
  const store = fakeStore();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const [, , table, op] = req.url.split('/');
    if (req.headers.authorization !== 'Bearer sps_test') { res.writeHead(401).end('{}'); return; }
    try { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await store.call(table, op, JSON.parse(body)))); }
    catch (e) { res.writeHead(e.code === 'conflict' ? 409 : 400).end(JSON.stringify({ code: e.code, error: e.message })); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const exec = (name, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/marketing.mjs', import.meta.url)), name], { env: { SOOT_STORAGE_URL: `http://127.0.0.1:${server.address().port}/v1`, SOOT_STORAGE_TOKEN: 'sps_test' } });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.on('close', () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify({ input }));
  });
  try {
    const saved = await exec('draft_save', { request_id: 'cli-1', kind: 'social', channel: 'blog-lohi', body: 'Xin chào' });
    assert.match(saved.id, /^P-[0-9A-F]{10}$/);
    assert.equal((await exec('items', { query: 'xin chao' })).items[0].id, saved.id, 'accent-insensitive search');
    assert.equal((await exec('claim', { id: saved.id, action: 'publish' })).refused.code, 'claim_key_missing');
    assert.equal((await exec('schedule', { id: saved.id })).error.code, 'not_ready');
  } finally { server.close(); }
});

test('the declaration: hub optional, three flow-marketing pages and the Kênh đăng bài settings page, unguarded page tools, node built-ins only', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
  const tools = Object.fromEntries(pack.tools.map(t => [t.name, t]));
  assert.equal(pack.needs.credentials.MARKETING_HUB.optional, true);
  assert.deepEqual(pack.interface.pages.map(p => [p.id, p.label.vi, p.provides]), [['bai-viet', 'Bài viết', ['flow-marketing']], ['hang-doi', 'Hàng đợi', ['flow-marketing']], ['kenh', 'Kênh đăng bài', undefined], ['chien-dich', 'Chiến dịch', ['flow-marketing']]]);
  for (const p of pack.interface.pages) {
    assert.equal(tools[p.view_tool].run.mode, 'read');
    for (const name of [p.view_tool, p.action_tool]) assert.equal(tools[name].run.approval, undefined, name);
  }
  assert.equal(tools.claim.run.approval, 'operator', 'a host approves claims, or a recipe maps marketing_claim to auto');
  assert.deepEqual(tools.claim.run.secret_env, { MARKETING_CLAIM_KEY: '{{cred:MARKETING_CLAIM_KEY}}' });
  const lib = new URL('../tools/lib/', import.meta.url);
  const sources = [new URL('../tools/marketing.mjs', import.meta.url), ...readdirSync(lib).map(f => new URL(f, lib))];
  for (const f of sources) for (const [, spec] of readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)) assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${f.pathname}: ${spec}`);
});

test('a claim whose intent row was lost (crash after the compare-and-set) writes it before re-issuing', async () => {
  const w = world();
  const d = await scheduledNow(w);
  const { claim } = await w.call('claim', { id: d.id, action: 'publish' });
  w.store.data.publish_log.length = 0;
  w.now += 31 * 60_000;
  const again = await w.call('claim', { id: d.id, action: 'publish' });
  assert.equal(again.claim.intent_id, claim.intent_id);
  assert.deepEqual(w.store.data.publish_log.map(r => [r.intent_id, r.status]), [[claim.intent_id, 'intent']]);
  assert.equal((await w.call('record', { intent_id: claim.intent_id, url: 'https://blog.lohi2.com/a/b/vi/' })).state, 'published');
});

test('the CLI exits 1 with the host sign-in line when Google refuses, so the host raises one Cần bạn item', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/marketing.mjs', import.meta.url)), 'gsc_sync'], { env: { PATH: process.env.PATH, SOOT_STORAGE_URL: 'http://127.0.0.1:9', SOOT_STORAGE_TOKEN: 't', GSC_GOOGLE: 'not a google sign-in' } });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stdin.end(JSON.stringify({ input: { site: 'sc-domain:lohi2.com' } }));
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(out).needs_person, { credential: 'GSC_GOOGLE', reason: 'oauth_signed_out' });
});

test('only the host sign-in shape exits 1; due\'s needs_person list does not, so the dispatch schedule can wake', () => {
  assert.equal(signInExit({ wake: true, publish: ['P-0000000001'], needs_person: [], notify: true }), false);
  assert.equal(signInExit({ needs_person: [{ id: 'blog-lohi', channel: 'blog-lohi', reason: 'signed_out' }] }), false);
  assert.equal(signInExit({ status: 'needs_person', needs_person: { credential: 'GSC_GOOGLE', reason: 'oauth_revoked' } }), true);
});

test('spacing holds even when a log row has no parseable time', () => {
  const now = T0;
  const ch = { ...CHANNEL_DEFAULTS['blog-lohi'], key: 'blog-lohi', cap_per_day: 5 };
  const log = [{ action: 'publish', status: 'published', at: new Date(now - H).toISOString() }, { action: 'publish', status: 'intent', at: null }];
  assert.equal(claimWindow({ settings: {}, channel: ch, log, now })?.code, 'spacing');
});
