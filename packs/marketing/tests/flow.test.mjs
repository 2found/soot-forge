// Founder flow (N3): every post and channel on Bài viết / Hàng đợi carries its next step,
// "Cần bạn" lists what only the founder can move, and set_limits is a button that completes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-10T03:00:00Z'); // 10:00 in Asia/Ho_Chi_Minh
const H = 3_600_000;

function world() {
  const w = { now: T0 };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { MARKETING_CLAIM_KEY: KEY };
  w.fetch = async () => { throw new Error('no network'); };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch });
  w.act = (op, input = {}) => w.call('page_action', { op, request_id: `r-${Math.random()}`, ...input }, { page: { soot: 'lohi-editor', page: 'hang-doi' } });
  w.list = (input = {}) => w.call('page_view', input, { page: { soot: 'lohi-editor', page: 'bai-viet' } });
  w.queue = () => w.call('page_view', {}, { page: { soot: 'lohi-editor', page: 'hang-doi' } });
  return w;
}
const BODY = 'Nếu bạn mê tiên hiệp, đây là chín bộ đáng đọc nhất năm nay, mỗi bộ một lý do riêng. Xem thêm [kho truyện](https://lohi2.com/novel/tien-hiep).';
const social = (w, text = 'Mới đọc xong một bộ ngôn tình 200 chương mà không thấy dài.') => w.call('draft_save', { request_id: 'q-' + Math.random(), kind: 'social', channel: 'x-lohi', body: text });

test('a draft says Writer is on it, with no button; the founder has nothing to do', async () => {
  const w = world();
  await w.call('draft_save', { request_id: 'a', kind: 'article', channel: 'blog-lohi', body: BODY, brief: { title: 'Bài nháp thử', keyword: 'tiên hiệp', slug: 'bai-nhap', meta: 'x' } });
  const list = await w.list();
  assert.equal(list.items[0].next.code, 'draft');
  assert.equal(list.counts.need, 0);
  assert.equal(list.editor, 'lohi-editor');
});

test('a social post shows its words, not a blank row, and its next step', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'acct' }] });
  const d = await social(w);
  const list = await w.list();
  const row = list.items.find(i => i.id === d.id);
  assert.match(row.title, /^Mới đọc xong một bộ ngôn tình/);
  assert.doesNotMatch(row.title, /https?:\/\//);
});

async function queued(w, text) {
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'acct' }] });
  const d = await social(w, text);
  await w.call('check', { id: d.id, revision: d.revision, verdict: 'pass', reasons: [] });
  const s = await w.call('schedule', { id: d.id });
  return { d, s };
}

test('a channel that is signed out says so on its waiting posts; signing in is the one button', async () => {
  const w = world();
  const { d } = await queued(w);
  const q = await w.queue();
  const x = q.channels.find(c => c.id === 'x-lohi');
  assert.equal(x.paused_reason, 'signed_out');
  assert.equal(x.waiting, 1);
  const it = q.items.find(i => i.id === d.id);
  assert.deepEqual([it.next.code, it.next.do, it.next.channel], ['signed_out', 'sign_in', 'X']);
  assert.equal(q.editor, 'lohi-editor', 'the page can open the sign-in browser of the Soot that posts');
});

test('person pauses and resumes a signed-in channel: the next step follows the switch', async () => {
  const w = world();
  const { d } = await queued(w);
  await w.act('resume', { channel: 'x-lohi' });
  let it = (await w.queue()).items.find(i => i.id === d.id);
  assert.equal(it.next.code, 'scheduled');
  await w.act('pause', { channel: 'x-lohi' });
  it = (await w.queue()).items.find(i => i.id === d.id);
  assert.equal(it.next.code, 'person_paused');
  assert.equal(it.next.do, 'resume_channel');
  await w.act('resume', { channel: 'x-lohi' });
  await w.act('pause');
  it = (await w.queue()).items.find(i => i.id === d.id);
  assert.equal(it.next.code, 'paused_all');
});

test('set_limits changes a channel and reads back; out-of-range is refused with the reason', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'acct' }] });
  const out = await w.act('set_limits', { channel: 'x-lohi', cap_per_day: 3, spacing_min: 90 });
  assert.ok(!out.error, JSON.stringify(out));
  const ch = (await w.queue()).channels.find(c => c.id === 'x-lohi');
  assert.equal(ch.cap_per_day, 3);
  assert.equal(ch.spacing_min, 90);
  await assert.rejects(w.act('set_limits', { channel: 'x-lohi', cap_per_day: 99 }));
});

test('a scheduled post hours past its time is late: Cần bạn lists it with Đăng ngay; Đăng ngay schedules it for now', async () => {
  const w = world();
  const { d } = await queued(w);
  await w.act('resume', { channel: 'x-lohi' });
  w.now = T0 + 8 * H;
  const need = await w.list({ filter: 'need' });
  const hit = need.items.find(i => i.id === d.id);
  assert.ok(hit, 'late post is in Cần bạn');
  assert.deepEqual([hit.next.code, hit.late, hit.next.do], ['late', true, 'post_now']);
  assert.equal(need.counts.need, 1);
  const out = await w.act('post_now', { id: d.id });
  assert.ok(!out.error, JSON.stringify(out));
  const it = (await w.queue()).items.find(i => i.id === d.id);
  assert.equal(it.late, false);
  assert.ok(Date.parse(it.scheduled_at) <= w.now + 60_000);
});

test('the Cần bạn and Chờ đăng tabs count the same posts the list shows; every filter value passes page_view', async () => {
  const w = world();
  await queued(w);
  const all = await w.list();
  for (const f of ['all', 'need', 'draft', 'ready', 'waiting', 'published', 'refused', 'removed']) {
    const l = await w.list({ filter: f });
    assert.equal(l.items.length, all.counts[f], f);
  }
});

test('items returns the queue time of a scheduled item (not null)', async () => {
  const { run } = await import('../tools/marketing.mjs');
  const { fakeStore } = await import('./fake-store.mjs');
  const now = Date.parse('2026-11-10T01:00:00Z');
  const store = fakeStore({ clock: () => now });
  await store.insert('posts', { ref: 'P-1', kind: 'article', channel: 'blog-lohi', state: 'scheduled', title: 'Bài một', body: 'x', revision: 1 });
  await store.insert('queue', { post: 'P-1', channel: 'blog-lohi', action: 'publish', scheduled_at: '2026-11-11T02:00:00.000Z' });
  const out = await run('items', { input: {} }, { store, now, env: {}, fetchImpl: async () => { throw new Error('no net'); } });
  assert.equal(out.items[0].scheduled_at, '2026-11-11T02:00:00.000Z');
});
