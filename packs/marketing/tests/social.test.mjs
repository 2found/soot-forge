// Social publishing through the Soot's browser (AC5), replies (AC6) and the
// per-channel guard (AC11) on the pack's own storage. The browser side is the
// marketing-browser-post skill; here every path it can report is fed back
// and the pack must keep one post one post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { checkPlatform, platformOf, defaultsFor } from '../tools/lib/guard.mjs';
import { redditComments as parseRss } from '../tools/lib/ops.mjs';
import { verifyClaim } from '../tools/lib/claim.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-10T03:00:00Z'); // 10:00 in Asia/Ho_Chi_Minh
const MIN = 60_000, H = 60 * MIN, DAY = 24 * H;
const CHANNELS = [
  { id: 'x-lohi', account: 'lohi2com', rules: { support_reply: 'Bạn nhắn Hỗ trợ trong app nhé', support_label: 'Chuyển Hỗ trợ Lohi' } },
  { id: 'facebook-lohi', account: 'https://www.facebook.com/lohi2com' },
  { id: 'reddit-lohi', account: 'lohi2com' },
];

function world() {
  const w = { now: T0 };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { MARKETING_CLAIM_KEY: KEY };
  w.fetch = async () => { throw new Error('no network in this test'); };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch });
  w.page = (op, input = {}) => w.call('page_action', { op, request_id: `r-${Math.random()}`, ...input }, { page: { page: 'hang-doi' } });
  w.ch = key => w.store.data.channels.find(c => c.key === key);
  return w;
}

async function seeded(w, { signIn = ['x-lohi'] } = {}) {
  await w.call('channels_setup', { channels: CHANNELS, quiet_hours: { from: '23:00', to: '07:00', tz: 'Asia/Ho_Chi_Minh' }, stale_after_h: 6 });
  for (const id of signIn) await w.page('resume', { channel: id });
}

const BODIES = ['Chín bộ tiên hiệp đáng đọc năm nay, mỗi bộ một lý do riêng.', 'Đọc gì cuối tuần? Ba truyện ngôn tình cổ đại nhẹ nhàng cho buổi tối.',
  'Bạn thích nhân vật phản diện nào nhất trong truyện huyền huyễn gần đây?', 'Mẹo nghe truyện audio khi chạy bộ: chọn giọng đọc chậm và chương ngắn.', 'Đêm nay có chương mới của bộ kiếm hiệp đang được bàn tán nhiều.'];
let n = 0;
async function post(w, { channel = 'x-lohi', body = BODIES[n++ % BODIES.length], at = w.now - MIN, ...over } = {}) {
  const d = await w.call('draft_save', { request_id: `q-${Math.random()}`, kind: 'social', channel, body, ...over });
  const c = await w.call('check', { id: d.id, revision: d.revision, verdict: 'pass', reasons: [] });
  assert.equal(c.verdict, 'pass', JSON.stringify(c.auto));
  await w.call('schedule', { id: d.id, scheduled_at: new Date(at).toISOString() });
  return d.id;
}

test('channels: x-lohi, facebook-lohi and reddit-lohi are created paused until their first sign-in, each one Cần bạn item, raised once', async () => {
  const w = world();
  assert.deepEqual([platformOf('x-lohi'), platformOf('facebook-lohi'), platformOf('reddit-lohi'), platformOf('blog-lohi'), platformOf('myspace-lohi')], ['x', 'facebook', 'reddit', 'blog-lohi', null]);
  assert.equal(defaultsFor('x-lohi').cap_per_day, 4);
  const out = await w.call('channels_setup', { channels: CHANNELS });
  assert.deepEqual(out.channels.map(c => [c.id, c.platform, c.paused, c.paused_reason, c.created]), [
    ['x-lohi', 'x', true, 'signed_out', true], ['facebook-lohi', 'facebook', true, 'signed_out', true], ['reddit-lohi', 'reddit', true, 'signed_out', true]]);
  assert.deepEqual([w.ch('x-lohi').cap_per_day, w.ch('x-lohi').spacing_min, w.ch('x-lohi').reply_cap_per_day, w.ch('reddit-lohi').cap_per_day], [4, 180, 10, 1]);
  assert.equal(w.ch('x-lohi').account, 'lohi2com');
  let due = await w.call('due', {});
  assert.deepEqual(due.needs.map(x => [x.key, x.label, x.raised]).sort(), [
    ['channel:facebook-lohi:signed_out', 'Đăng nhập lại', false], ['channel:reddit-lohi:signed_out', 'Đăng nhập lại', false], ['channel:x-lohi:signed_out', 'Đăng nhập lại', false]]);
  assert.equal(due.notify, true, 'the Publisher wakes to ask for each sign-in');
  await w.call('raised', { keys: due.needs.map(x => x.key) });
  due = await w.call('due', {});
  assert.equal(due.notify, false, 'raised once: the 10-minute schedule does not wake again');
  // The founder signs in and resumes X; a re-run of the recipe never re-pauses it or overwrites an edit.
  await w.page('resume', { channel: 'x-lohi' });
  await w.store.update('channels', [{ column: 'key', op: 'eq', value: 'x-lohi' }], { cap_per_day: 2 });
  await w.call('channels_setup', { channels: CHANNELS.map(c => ({ ...c, cap_per_day: 9 })) });
  assert.deepEqual([w.ch('x-lohi').paused, w.ch('x-lohi').cap_per_day], [false, 2]);
  assert.equal((await w.call('due', {})).needs.length, 2);
  await assert.rejects(w.call('channels_setup', { channels: [{ id: 'myspace-lohi' }] }), { code: 'unknown_channel' });
});

test('AC5: an X post goes claim → browser → record with its URL and the post_published outcome', async () => {
  const w = world();
  await seeded(w);
  const id = await post(w, { link: 'https://lohi2.com/novel/tien-hiep' });
  const due = await w.call('due', {});
  assert.deepEqual(due.publish, [id]);
  const { claim, verify_first } = await w.call('claim', { id, action: 'publish' });
  assert.equal(verify_first, undefined);
  assert.deepEqual([claim.publisher, claim.platform, claim.account, claim.channel], ['browser', 'x', 'lohi2com', 'x-lohi']);
  assert.equal(verifyClaim(claim, KEY, w.now), null);
  assert.deepEqual(w.store.data.publish_log.map(r => r.status), ['intent'], 'the intent is written before the browser acts');
  const url = 'https://x.com/lohi2com/status/1854000000000000001';
  assert.deepEqual(await w.call('record', { intent_id: claim.intent_id, url, platform_id: '1854000000000000001' }), { state: 'published', outcome: { id: 'post_published', ref: url } });
  const q = await w.call('page_view', {}, { page: { page: 'hang-doi' } });
  const x = q.channels.find(c => c.id === 'x-lohi');
  assert.deepEqual([x.label, x.posts_today, x.cap_per_day, x.replies_today, x.reply_cap_per_day], ['X', 1, 4, 0, 10]);
  assert.equal(q.recent[0].url, url);
});

for (const reason of ['signed_out', 'layout_changed', 'captcha']) {
  test(`AC5 non-happy: ${reason} pauses only that channel, posts nothing and is one Cần bạn item`, async () => {
    const w = world();
    await seeded(w, { signIn: ['x-lohi', 'facebook-lohi'] });
    const id = await post(w);
    const fb = await post(w, { channel: 'facebook-lohi', body: 'Một bài chia sẻ blog về mười một cảnh ngôn tình cổ đại đáng nhớ.' });
    const { claim } = await w.call('claim', { id, action: 'publish' });
    assert.deepEqual(await w.call('fail', { intent_id: claim.intent_id, status: 'needs_person', reason, platform: 'x' }), { state: 'failed' });
    assert.deepEqual([w.ch('x-lohi').paused, w.ch('x-lohi').paused_reason], [true, reason]);
    assert.equal(w.ch('facebook-lohi').paused, false, 'the other channels go on');
    assert.equal(w.store.data.publish_log[0].status, 'needs_person');
    const due = await w.call('due', {});
    assert.deepEqual(due.publish, [fb], 'X waits; Facebook still posts');
    assert.deepEqual(due.needs.filter(x => x.channel === 'x-lohi').map(x => [x.kind, x.reason, x.platform, x.raised]), [['channel', reason, 'x', false]]);
    assert.equal((await w.call('claim', { id, action: 'publish' })).refused.code, 'paused');
    // Resume after the person fixed it: the post goes out on the next claim, under a new intent.
    await w.page('resume', { channel: 'x-lohi' });
    const again = await w.call('claim', { id, action: 'publish' });
    assert.notEqual(again.claim.intent_id, claim.intent_id);
  });
}

test('AC5 never twice: a crash between posting and recording → verify_first → find → record, one post', async () => {
  const w = world();
  await seeded(w);
  const id = await post(w);
  const first = (await w.call('claim', { id, action: 'publish' })).claim;
  // The browser posted, then the Mac slept before marketing_record.
  assert.equal((await w.call('claim', { id, action: 'publish' })).refused.code, 'open_intent');
  assert.deepEqual((await w.call('due', {})).publish, [], 'a fresh intent is not re-dispatched');
  w.now += 31 * MIN;
  assert.deepEqual((await w.call('due', {})).publish, [id]);
  const again = await w.call('claim', { id, action: 'publish' });
  assert.equal(again.verify_first, true);
  assert.equal(again.claim.intent_id, first.intent_id, 'the same intent: the publisher only looks');
  await w.call('record', { intent_id: first.intent_id, url: 'https://x.com/lohi2com/status/1' });
  assert.equal(w.store.data.publish_log.length, 1);
  assert.equal(w.store.data.posts[0].state, 'published');
});

test('AC5 never twice: find fails → uncertain, never claimed or dispatched again until the person answers', async () => {
  const w = world();
  await seeded(w);
  const id = await post(w);
  const first = (await w.call('claim', { id, action: 'publish' })).claim;
  w.now += 31 * MIN;
  const again = await w.call('claim', { id, action: 'publish' });
  assert.equal(again.verify_first, true);
  // Signed out while looking: the channel pauses, but the post stays uncertain, never failed.
  assert.deepEqual(await w.call('fail', { intent_id: first.intent_id, status: 'needs_person', reason: 'signed_out' }), { state: 'uncertain' });
  assert.equal(w.ch('x-lohi').paused, true);
  await w.page('resume', { channel: 'x-lohi' });
  w.now += 31 * MIN;
  let due = await w.call('due', {});
  assert.deepEqual(due.publish, [], 'an uncertain post is never dispatched');
  assert.deepEqual(due.needs.filter(x => x.kind !== 'channel').map(x => [x.kind, x.id, x.label]), [['uncertain', id, 'Không chắc đã đăng chưa']]);
  const look = await w.call('claim', { id, action: 'publish' });
  assert.equal(look.verify_first, true, 'a direct claim still only looks');
  assert.deepEqual(await w.call('fail', { intent_id: first.intent_id, status: 'failed', reason: 'not found' }), { state: 'uncertain' }, 'after verify_first nothing frees the intent');
  assert.equal(w.store.data.publish_log.length, 1);
  await w.call('raised', { keys: due.needs.map(x => x.key) });
  assert.equal((await w.call('due', {})).notify, false);
  await assert.rejects(w.page('post_now', { id }), { code: 'conflict' });

  // "Chưa lên — đăng lại": only the person frees it; the next claim is a new intent.
  await w.page('confirm_not_posted', { id });
  assert.equal(w.store.data.publish_log[0].status, 'failed');
  const fresh = await w.call('claim', { id, action: 'publish' });
  assert.notEqual(fresh.claim.intent_id, first.intent_id);
  assert.equal(fresh.verify_first, undefined);
});

test('AC5: "Đã lên — dán liên kết" records the uncertain post; "Bỏ bài" drops it', async () => {
  const w = world();
  await seeded(w);
  const a = await post(w), b = await post(w, { at: w.now - 2 * MIN });
  for (const id of [a, b]) {
    const { claim } = await w.call('claim', { id, action: 'publish' });
    await w.call('fail', { intent_id: claim.intent_id, status: 'uncertain', reason: 'composer closed before the result' });
    w.store.data.publish_log.find(r => r.intent_id === claim.intent_id).at = new Date(w.now - 4 * H).toISOString();
  }
  await assert.rejects(w.page('confirm_posted', { id: a, url: 'javascript:alert(1)' }), { code: 'invalid_request' });
  const ok = await w.page('confirm_posted', { id: a, url: 'https://x.com/lohi2com/status/9' });
  assert.deepEqual([ok.state, ok.outcome.id], ['published', 'post_published']);
  assert.equal((await w.page('drop', { id: b })).state, 'pulled');
  assert.equal(w.store.data.queue.length, 0);
  assert.deepEqual((await w.call('due', {})).needs.filter(x => x.kind === 'uncertain'), []);
});

test('AC5: an item 6 h or more past its time is "Bài lỡ giờ", never posted on its own', async () => {
  const w = world();
  await seeded(w);
  const id = await post(w, { at: w.now - 6 * H });
  const due = await w.call('due', {});
  assert.deepEqual([due.publish, due.late], [[], [id]]);
  assert.deepEqual(due.needs.filter(x => x.kind !== 'channel').map(x => [x.kind, x.label]), [['late', 'Bài lỡ giờ']]);
  assert.equal(due.notify, true);
  const refused = await w.call('claim', { id, action: 'publish' });
  assert.equal(refused.refused.code, 'late');
  assert.equal(w.store.data.publish_log.length, 0, 'no intent, nothing went out');
  const view = await w.call('page_view', {}, { page: { page: 'hang-doi' } });
  assert.deepEqual([view.items[0].late, view.items[0].label], [true, 'Bài lỡ giờ']);
  assert.equal(view.channels.find(c => c.id === 'facebook-lohi').paused_label, 'chưa đăng nhập');
  // "Đăng ngay" is the person's decision.
  await w.page('post_now', { id });
  assert.ok((await w.call('claim', { id, action: 'publish' })).claim);
  assert.deepEqual((await w.call('due', {})).needs.filter(x => x.kind === 'late'), []);
});

test('AC11: per-channel caps and spacing; replies have their own cap; quiet hours hold', async () => {
  const w = world();
  await seeded(w, { signIn: ['x-lohi', 'reddit-lohi'] });
  const a = await post(w), b = await post(w, { at: w.now - 2 * MIN });
  await w.call('record', { intent_id: (await w.call('claim', { id: a, action: 'publish' })).claim.intent_id, url: 'https://x.com/lohi2com/status/2' });
  assert.equal((await w.call('claim', { id: b, action: 'publish' })).refused.code, 'spacing', 'X: 3 h apart');
  const r1 = await post(w, { channel: 'reddit-lohi', body: 'What xianxia hooked you this year? Ours is a slow-burn cultivation story.', brief: { title: 'What xianxia hooked you in 2026?', subreddit: 'noveltranslations' } });
  const rc = (await w.call('claim', { id: r1, action: 'publish' })).claim;
  assert.equal(rc.subreddit, 'noveltranslations');
  await w.call('record', { intent_id: rc.intent_id, url: 'https://www.reddit.com/r/noveltranslations/comments/abc/x/' });
  w.now = Date.parse('2026-11-11T17:00:00Z'); // 00:00 local the next night: quiet
  const r2 = await post(w, { channel: 'reddit-lohi', body: 'Second thread about a completely different subject: audio dramas of classic romance.' });
  assert.equal((await w.call('claim', { id: r2, action: 'publish' })).refused.code, 'quiet_hours');
});

async function savedReplies(w) {
  const out = await w.call('reply_save', { channel: 'x-lohi', items: [
    { reply_url: 'https://x.com/reader_vn/status/11', thread_url: 'https://x.com/lohi2com/status/2', author_handle: '@reader_vn', text: 'Cảm ơn! Chương 3 hay nhất đó', class: 'safe' },
    { reply_url: 'https://x.com/a/status/12', text: 'Mình nạp xu mà không thấy, hoàn tiền giúp?', class: 'money' },
    { reply_url: 'https://x.com/b/status/13', text: 'Không đăng nhập được app từ hôm qua', class: 'account' },
    { reply_url: 'https://x.com/c/status/14', text: 'Dịch chương 300 tệ quá', class: 'complaint' },
    { reply_url: 'https://x.com/d/status/15', text: 'Báo chí muốn hỏi', class: 'flagged' },
    { reply_url: 'https://x.com/e/status/16', text: 'cheap followers here', class: 'spam' },
  ] });
  return out;
}

test('AC6: only safe replies are answered, through check and claim under the reply cap; the others are Cần bạn items', async () => {
  const w = world();
  await seeded(w);
  const out = await savedReplies(w);
  assert.deepEqual(out.saved.map(s => [s.class, s.state, s.label ?? null]), [
    ['safe', 'open', null], ['money', 'needs_person', 'Tiền'], ['account', 'needs_person', 'Chuyển Hỗ trợ Lohi'],
    ['complaint', 'needs_person', 'Phàn nàn'], ['flagged', 'needs_person', 'Cần xem'], ['spam', 'ignored', null]]);
  assert.equal((await savedReplies(w)).saved.every(s => s.replayed), true, 'a replay changes nothing');
  const [safe, money, account, complaint, flagged] = out.saved.map(s => s.id);
  // Never answered: complaint, money, flagged; account only with the fixed pointer.
  for (const parent of [money, complaint, flagged]) {
    await assert.rejects(w.call('draft_save', { request_id: `n-${parent}`, kind: 'reply', channel: 'x-lohi', parent, body: 'Chúng mình xin lỗi bạn nhé' }), { code: 'not_answerable' });
  }
  await assert.rejects(w.call('draft_save', { request_id: 'acc', kind: 'reply', channel: 'x-lohi', parent: account, body: 'Gửi email cho mình nhé' }), { code: 'not_answerable' });
  assert.equal(out.drafts.length, 1, 'the account pointer is drafted');
  assert.equal(w.store.data.posts.find(p => p.ref === out.drafts[0].post).body, 'Bạn nhắn Hỗ trợ trong app nhé');

  const due = await w.call('due', {});
  assert.deepEqual(due.needs.filter(x => x.kind === 'reply').map(x => [x.kind, x.reason, x.label]).sort(), [
    ['reply', 'account', 'Chuyển Hỗ trợ Lohi'], ['reply', 'complaint', 'Phàn nàn'], ['reply', 'flagged', 'Cần xem'], ['reply', 'money', 'Tiền']]);

  // The safe answer may address its reader, but no one else and no link on X.
  const bad = await w.call('draft_save', { request_id: 'b1', kind: 'reply', channel: 'x-lohi', parent: safe, body: 'Cảm ơn @reader_vn, hỏi thêm @someone nhé' });
  assert.equal((await w.call('check', { id: bad.id, revision: 1, verdict: 'pass', reasons: [] })).verdict, 'fail');
  const link = await w.call('draft_save', { request_id: 'b2', kind: 'reply', channel: 'x-lohi', parent: safe, body: 'Đọc tiếp ở https://lohi2.com nhé' });
  assert.match((await w.call('check', { id: link.id, revision: 1, verdict: 'pass', reasons: [] })).reason, /không được kèm liên kết/);
  const d = await w.call('draft_save', { request_id: 'g1', kind: 'reply', channel: 'x-lohi', parent: safe, body: 'Cảm ơn @reader_vn! Chương 3 cũng là chương chúng mình thích nhất.' });
  assert.equal((await w.call('check', { id: d.id, revision: 1, verdict: 'pass', reasons: [] })).verdict, 'pass');
  const s = await w.call('schedule', { id: d.id });
  w.now = Date.parse(s.scheduled_at) + MIN;
  assert.deepEqual((await w.call('due', {})).reply, [d.id]);
  assert.equal((await w.call('claim', { id: d.id, action: 'publish' })).refused.code, 'not_queued', 'a reply is claimed only as a reply');
  const { claim } = await w.call('claim', { id: d.id, action: 'reply' });
  assert.deepEqual([claim.action, claim.reply_url, claim.platform], ['reply', 'https://x.com/reader_vn/status/11', 'x']);
  assert.deepEqual(await w.call('record', { intent_id: claim.intent_id, url: 'https://x.com/lohi2com/status/21' }), { state: 'published' }, 'a reply is not a post_published outcome');
  assert.equal(w.store.data.replies.find(r => r.ref === safe).state, 'answered');
});

test('AC6: the reply cap and spacing are the channel\'s own, apart from posts', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', reply_cap_per_day: 1 }] });
  w.store.data.channels[0].reply_cap_per_day = 1;
  await w.page('resume', { channel: 'x-lohi' });
  const out = await w.call('reply_save', { channel: 'x-lohi', items: [1, 2].map(i => ({ reply_url: `https://x.com/r${i}/status/${i}`, author_handle: `r${i}`, text: 'Hay quá', class: 'safe' })) });
  const ids = [];
  for (const [i, s] of out.saved.entries()) {
    const d = await w.call('draft_save', { request_id: `c${i}`, kind: 'reply', channel: 'x-lohi', parent: s.id, body: `Cảm ơn bạn ${i}!` });
    await w.call('check', { id: d.id, revision: 1, verdict: 'pass', reasons: [] });
    await w.call('schedule', { id: d.id, scheduled_at: new Date(w.now - MIN).toISOString() });
    ids.push(d.id);
  }
  await post(w); // a post does not use the reply cap
  const c = (await w.call('claim', { id: ids[0], action: 'reply' })).claim;
  await w.call('record', { intent_id: c.intent_id, url: 'https://x.com/lohi2com/status/31' });
  assert.equal((await w.call('claim', { id: ids[1], action: 'reply' })).refused.code, 'over_cap');
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><author><name>/u/lohi2com</name></author><content type="html">&lt;p&gt;the post&lt;/p&gt;</content><id>t3_abc</id><link href="https://www.reddit.com/r/noveltranslations/comments/abc/x/"/></entry>
<entry><author><name>/u/reader_one</name></author><content type="html">&lt;!-- SC_OFF --&gt;&lt;div class="md"&gt;&lt;p&gt;Translation of ch. 300 is rough &amp;amp; slow&lt;/p&gt;&lt;/div&gt;</content><id>t1_c1</id><link href="https://www.reddit.com/r/noveltranslations/comments/abc/x/c1/"/></entry>
<entry><author><name>/u/lohi2com</name></author><content type="html">&lt;p&gt;our own comment&lt;/p&gt;</content><id>t1_c2</id><link href="https://www.reddit.com/r/noveltranslations/comments/abc/x/c2/"/></entry>
</feed>`;

test('AC6: replies_sync reads watched Reddit threads by RSS, skips the account\'s own, wakes to classify, drops handles after 30 days', async () => {
  assert.deepEqual(parseRss(RSS).map(c => [c.author_handle, c.text, c.platform_id]), [['reader_one', 'Translation of ch. 300 is rough & slow', 't1_c1'], ['lohi2com', 'our own comment', 't1_c2']]);
  const w = world();
  await seeded(w, { signIn: ['x-lohi', 'reddit-lohi'] });
  const r = await post(w, { channel: 'reddit-lohi', body: 'What xianxia hooked you this year? Ours is a slow-burn cultivation story.' });
  const rc = (await w.call('claim', { id: r, action: 'publish' })).claim;
  await w.call('record', { intent_id: rc.intent_id, url: 'https://www.reddit.com/r/noveltranslations/comments/abc/x/' });
  const x = await post(w);
  await w.call('record', { intent_id: (await w.call('claim', { id: x, action: 'publish' })).claim.intent_id, url: 'https://x.com/lohi2com/status/5' });
  const seen = [];
  w.fetch = async (url, opts) => { seen.push([url, opts.headers['User-Agent']]); return { ok: true, status: 200, text: async () => RSS }; };
  let out = await w.call('replies_sync', {});
  assert.deepEqual(seen, [['https://www.reddit.com/r/noveltranslations/comments/abc/x/.rss', 'soot-marketing/1.0']]);
  assert.deepEqual([out.saved, out.wake, out.notify, out.read, out.classify.length], [1, true, true, ['x-lohi'], 1]);
  assert.equal(w.store.data.replies[0].parent_post, r);
  out = await w.call('replies_sync', {});
  assert.equal(out.saved, 0, 'already saved');
  // The Publisher classifies the synced one and reads X in the browser (nothing new there).
  await w.call('reply_save', { channel: 'reddit-lohi', items: [{ id: out.classify[0].id, class: 'complaint' }] });
  await w.call('reply_save', { channel: 'x-lohi', items: [] });
  out = await w.call('replies_sync', {});
  assert.deepEqual([out.wake, out.read, out.classify], [false, [], []], 'nothing to do: no model call');
  w.now += 2 * H + MIN;
  assert.deepEqual((await w.call('replies_sync', {})).read, ['x-lohi'], 'X is read again after 2 h');
  w.now += 30 * DAY;
  w.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  const late = await w.call('replies_sync', {});
  assert.equal(late.purged, 1);
  assert.equal(w.store.data.replies[0].author_handle, null, 'reader handles never outlive 30 days');
});

test('AC11: unpublish deletes through the browser claim and records removed', async () => {
  const w = world();
  await seeded(w);
  const id = await post(w);
  const c = (await w.call('claim', { id, action: 'publish' })).claim;
  const url = 'https://x.com/lohi2com/status/7';
  await w.call('record', { intent_id: c.intent_id, url });
  assert.equal((await w.page('unpublish', { id })).unpublish, 'queued');
  assert.deepEqual((await w.call('due', {})).unpublish, [id]);
  const u = (await w.call('claim', { id, action: 'unpublish' })).claim;
  assert.deepEqual([u.action, u.url, u.platform], ['unpublish', url, 'x']);
  assert.equal(w.store.data.posts[0].state, 'unpublishing');
  assert.deepEqual(await w.call('record', { intent_id: u.intent_id }), { state: 'removed' });
  assert.equal(w.store.data.posts[0].state, 'removed');
});

test('AC11: Facebook Page rules apply to facebook-<account> channels', () => {
  assert.equal(checkPlatform({ kind: 'social', body: 'Like nếu bạn cũng mê truyện' }, { key: 'facebook-lohi', ...defaultsFor('facebook-lohi') }).code, 'engagement_bait');
  assert.equal(checkPlatform({ kind: 'social', body: 'x'.repeat(300) }, { key: 'x-lohi', ...defaultsFor('x-lohi') }).code, 'too_long');
});
