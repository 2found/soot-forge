// Reader awareness (nấc 1/2/3): kept with a handed topic, saved on the post, and the 14-day mix with its one-line note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';

const T0 = Date.parse('2026-11-10T01:00:00Z');
const DAY = 86_400_000;
const CATALOG = { feed: 'https://api.example/feed', genres: 'https://api.example/genres', page: 'https://shop.example/p/{slug}', links: ['https://shop.example/app'] };
const WAKE = { wake: true, channel: 'blog-lohi', catalog: CATALOG };
const BODY = 'Nếu bạn đang tìm cách đọc đều mỗi ngày, đây là vài gợi ý. Xem thêm [kho truyện](https://shop.example/novel/a).';

function world() {
  const w = { now: T0, env: { MARKETING_CLAIM_KEY: 'k'.repeat(32) } };
  w.store = fakeStore({ clock: () => w.now });
  w.fetch = async () => { throw new Error('no network'); };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch });
  return w;
}
/** n posts tagged `level` (undefined = untagged), saved `ago` days before now. */
async function posts(w, level, n, ago = 1) {
  const keep = w.now;
  w.now = T0 - ago * DAY;
  for (let i = 0; i < n; i++) await w.store.insert('posts', { ref: `P-${Math.random().toString(16).slice(2, 12).toUpperCase()}`, channel: 'blog-lohi', kind: 'article', state: 'published', revision: 1, body: 'b', awareness: level ?? null });
  w.now = keep;
}
const mix = async w => (await w.call('inputs_health', {})).posts.awareness;

test('plan keeps the awareness of a handed topic and returns it in the Writer brief; none, or a wrong one, adds nothing', async () => {
  const w = world();
  await w.call('plan', { ...WAKE, query: 'cách đọc truyện mỗi ngày', awareness: 'unaware' });
  assert.equal((await w.call('plan', { channel: 'blog-lohi', catalog: CATALOG })).awareness, 'unaware', 'the Writer call carries no query: the kept topic speaks');
  assert.equal((await w.call('plan', { channel: 'blog-lohi', catalog: CATALOG, query: 'chủ đề khác', awareness: 'choosing' })).awareness, 'choosing');
  const plain = world();
  await plain.call('plan', { ...WAKE, query: 'cách đọc truyện mỗi ngày' });
  assert.equal('awareness' in await plain.call('plan', { channel: 'blog-lohi', catalog: CATALOG }), false, 'never guessed');
  const odd = world();
  await odd.call('plan', { ...WAKE, query: 'cách đọc truyện mỗi ngày', awareness: 'nap-4' }).catch(() => {});
  assert.equal('awareness' in await odd.call('plan', { channel: 'blog-lohi', catalog: CATALOG }), false);
  // A topic with no query of the loop's keeps nothing from an older topic.
  assert.equal('awareness' in await world().call('plan', { channel: 'blog-lohi', catalog: CATALOG }), false);
});

test('draft_save stores the awareness on the post, refuses an unknown level, and an edit without it keeps the tag', async () => {
  const w = world();
  const d = await w.call('draft_save', { request_id: 'a1', kind: 'article', channel: 'blog-lohi', body: BODY, awareness: 'problem', brief: { title: 'Bài thử nấc hai', keyword: 'đọc truyện', slug: 'nac-hai', meta: 'x' } });
  assert.equal(w.store.data.posts[0].awareness, 'problem');
  await assert.rejects(w.call('draft_save', { request_id: 'a2', kind: 'article', channel: 'blog-lohi', body: BODY + ' thêm', awareness: 'nap-4' }), /awareness is unaware, problem or choosing/);
  assert.equal(w.store.data.posts.length, 1);
  await w.call('draft_save', { id: d.id, expected_revision: 1, kind: 'article', channel: 'blog-lohi', body: BODY + ' đã sửa', brief: { title: 'Bài thử nấc hai', keyword: 'đọc truyện', slug: 'nac-hai', meta: 'x' } });
  assert.equal(w.store.data.posts[0].awareness, 'problem');
  await w.call('draft_save', { request_id: 'a3', kind: 'article', channel: 'blog-lohi', body: 'Một bài khác hẳn, chưa gắn nấc nào. https://shop.example/novel/b' });
  assert.equal(w.store.data.posts[1].awareness, null);
});

test('inputs_health: a 14-day mix by level; untagged posts are chua_gan, older posts and replies are left out', async () => {
  const w = world();
  await posts(w, 'unaware', 2); await posts(w, 'problem', 2); await posts(w, 'choosing', 1); await posts(w, undefined, 3);
  await posts(w, 'unaware', 4, 20);
  await w.store.insert('posts', { ref: 'P-REPLY00001', channel: 'x', kind: 'reply', state: 'published', revision: 1, body: 'r', awareness: 'unaware' });
  const m = await mix(w);
  assert.deepEqual([m.days, m.unaware, m.problem, m.choosing, m.chua_gan, m.note], [14, 2, 2, 1, 3, null], 'balanced: no note');
  // The company loop's health_sync takes `inputs` and `posts`; the mix lives inside posts so the chain stays valid.
  assert.deepEqual(Object.keys(await w.call('inputs_health', {})).sort(), ['inputs', 'posts']);
});

test('inputs_health: one line when a nấc is over 70% of the tagged posts, or a nấc has none while 5+ are tagged', async () => {
  const lopsided = world();
  await posts(lopsided, 'problem', 8); await posts(lopsided, 'unaware', 2);
  const a = await mix(lopsided);
  assert.match(a.note, /Nấc 2 .* chiếm 80% bài đã gắn nấc trong 14 ngày qua/);
  assert.match(a.note, /chưa có bài nào cho Nấc 3/);
  const missing = world();
  await posts(missing, 'unaware', 3); await posts(missing, 'problem', 3);
  assert.equal((await mix(missing)).note, 'Chưa có bài nào cho Nấc 3 (đang chọn mua).'.replace('Chưa', 'chưa'));
  // Non-happy: fewer than 5 tagged posts say nothing about a missing nấc; untagged posts alone never make a note.
  const few = world();
  await posts(few, 'unaware', 2); await posts(few, 'problem', 2);
  assert.equal((await mix(few)).note, null);
  const none = world();
  await posts(none, undefined, 9);
  const n = await mix(none);
  assert.deepEqual([n.chua_gan, n.note], [9, null]);
  assert.deepEqual((await mix(world())).note, null);
});

test('the daily report adds the mix note as a line when the mix is lopsided, and nothing when it is balanced', async () => {
  const w = world();
  await posts(w, 'problem', 6);
  const r = await w.call('report', {});
  assert.ok(r.lines.some(l => /^Nấc 2 .* chiếm 100% bài đã gắn nấc/.test(l)), r.text);
  assert.ok(r.lines.length <= 6);
  const ok = world();
  await posts(ok, 'unaware', 2); await posts(ok, 'problem', 2); await posts(ok, 'choosing', 2);
  assert.ok(!(await ok.call('report', {})).lines.some(l => /nấc/i.test(l)));
});
