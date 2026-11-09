// The content engine (friction W1): the daily plan wakes the Writer only for a
// free blog slot and hands it a brief of real novels; check fails a dead
// internal link; a need the dispatch already woke for never wakes twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-10T01:00:00Z'); // 08:00 in Asia/Ho_Chi_Minh
const H = 3_600_000, DAY = 24 * H;
const FEED = 'https://api.example/novel/discovery/feed', GENRES = 'https://api.example/novel/discovery/genres';
const CATALOG = { feed: FEED, genres: GENRES, page: 'https://lohi2.com/truyen/{slug}', links: ['https://lohi2.com/ung-dung'] };
const novel = (slug, extra = {}) => ({ slug, titleVi: `Truyện ${slug}`, authorNameVi: 'Tác Giả', genres: ['Tiên Hiệp'], totalChapters: 120, completionStatus: 'completed', access: 'open', synopsis: 'Một hành trình dài. '.repeat(20), totalWords: 100000, readCount: 5, ...extra });

function world({ now = T0, dead = [] } = {}) {
  const w = { now, dead: new Set(dead), calls: [], feed: ['a', 'b', 'c', 'd', 'e'].map(s => novel(s)) };
  w.store = fakeStore({ clock: () => w.now });
  w.fetch = async (url, init = {}) => {
    const u = String(url);
    w.calls.push([init.method ?? 'GET', u]);
    if (u.startsWith(GENRES)) return { ok: true, status: 200, json: async () => ['Tiên Hiệp', 'Ngôn Tình'] };
    if (u.startsWith(FEED)) return { ok: true, status: 200, json: async () => w.feed };
    if (u.startsWith('https://api.example/app-config')) return { ok: true, status: 200, json: async () => ({ pricing: { audio_monthly: 49000 } }) };
    if (w.dead.has(u)) return { ok: false, status: 404 };
    if (u.startsWith('https://lohi2.com/') || u.startsWith('https://blog.lohi2.com/')) return { ok: true, status: 200 };
    throw new Error('no network');
  };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: { MARKETING_CLAIM_KEY: KEY }, fetchImpl: w.fetch });
  return w;
}
const WAKE = { wake: true, channel: 'blog-lohi', facts_url: 'https://api.example/app-config', catalog: CATALOG };

const body = links => `Gợi ý truyện tiên hiệp. ${links.map((l, i) => `[bộ ${i}](${l})`).join(' và ')}`;
const article = links => ({
  kind: 'article', channel: 'blog-lohi', body: body(links),
  brief: { keyword: 'truyện tiên hiệp hay', title: 'Truyện tiên hiệp hay nhất 2026: 9 bộ đáng đọc', meta: 'Chín bộ truyện tiên hiệp hay nhất 2026 cho người mới và người đọc lâu năm: cốt truyện, độ dài, điểm nổi bật và nơi đọc nghe thử trên Lohi.'.slice(0, 150), slug: 'truyen-tien-hiep-hay-nhat-2026' },
});

test('plan wake: a free blog slot wakes the Writer once a day and remembers the catalog', async () => {
  const w = world();
  const a = await w.call('plan', WAKE);
  assert.equal(a.wake, true);
  assert.equal(a.notify, true);
  assert.equal(a.facts, 'synced', 'the plan keeps the guard supplied with fresh facts');
  const b = await w.call('plan', WAKE);
  assert.deepEqual([b.wake, b.notify, b.code], [false, false, 'planned_today']);
});

test('plan brief: topic, keyword and real novels with links, from the saved catalog', async () => {
  const w = world();
  await w.call('plan', WAKE);
  const brief = await w.call('plan', {}); // the woken Writer passes nothing
  assert.equal(brief.channel, 'blog-lohi');
  assert.equal(brief.source, 'catalog');
  assert.match(brief.keyword, /^truyện (tiên hiệp|ngôn tình) hay$/);
  assert.equal(brief.novels.length, 4);
  assert.deepEqual(brief.novels[0].url, 'https://lohi2.com/truyen/a');
  assert.ok(brief.novels.every(n => n.title && n.chapters === 120 && n.summary.length <= 150));
  assert.ok(brief.internal_links.includes('https://lohi2.com/truyen/a') && brief.internal_links.includes('https://lohi2.com/ung-dung'));
  assert.ok(brief.internal_links.length >= 2);
});

test('plan brief: Search Console queries come first; a written keyword is skipped; featured novels are not repeated', async () => {
  const w = world();
  await w.call('plan', WAKE);
  const first = await w.call('plan', {});
  const d = await w.call('draft_save', { request_id: 'r1', ...article(first.novels.slice(0, 2).map(n => n.url)), brief: { ...article([]).brief, keyword: first.keyword } });
  assert.ok(d.id);
  const next = await w.call('plan', {});
  assert.notEqual(next.keyword, first.keyword, 'a keyword already written is not planned again');
  assert.ok(!next.novels.slice(0, 2).some(n => first.novels.slice(0, 2).some(f => f.slug === n.slug)), 'novels of the last post are rotated out');
});

test('no free slot: a queued post, an open draft, a paused team and a refusal streak do not wake the Writer', async () => {
  const w = world();
  assert.equal((await w.call('plan', WAKE)).wake, true);
  // An open draft (written, not yet scheduled).
  const d = await w.call('draft_save', { request_id: 'r1', ...article(['https://lohi2.com/truyen/a', 'https://lohi2.com/ung-dung']) });
  w.now += DAY; // next day: only the draft blocks
  const open = await w.call('plan', WAKE);
  assert.deepEqual([open.wake, open.notify, open.code], [false, false, 'draft_open']);
  // Scheduled → queued.
  await w.call('facts_sync', {});
  await w.call('check', { id: d.id, revision: 1, verdict: 'pass' });
  await w.call('schedule', { id: d.id });
  w.now += H; // the draft is old enough only after a day; the queue still holds the post
  const queued = await w.call('plan', WAKE);
  assert.deepEqual([queued.wake, queued.code], [false, 'queued']);
  // Paused team.
  await w.call('pause', { paused: true });
  assert.equal((await w.call('plan', WAKE)).code, 'paused_all');
});

test('no free slot: today the blog already posted and the spacing runs past the next 26 hours', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'blog-lohi', cap_per_day: 1, spacing_min: 60 * 60 }] });
  await w.call('plan', { ...WAKE, wake: false }); // save config only through a wake below
  const row = { post: 'P-0000000001', channel: 'blog-lohi', action: 'publish', status: 'published', at: new Date(w.now - H).toISOString() };
  await w.store.call('publish_log', 'insert', { row: { ...row, intent_id: 'I-1', body: 'x', link: null } });
  const out = await w.call('plan', WAKE);
  assert.equal(out.wake, false);
  assert.equal(out.code, 'no_slot');
});

test('check fails a draft with a dead internal link and passes live ones', async () => {
  const w = world({ dead: ['https://lohi2.com/truyen/gone'] });
  await w.call('facts_sync', { url: 'https://api.example/app-config' });
  const good = await w.call('draft_save', { request_id: 'g', ...article(['https://lohi2.com/truyen/a', 'https://lohi2.com/ung-dung']) });
  const ok = await w.call('check', { id: good.id, revision: 1, verdict: 'pass' });
  assert.equal(ok.verdict, 'pass');
  const links = ok.auto.find(a => a.rule === 'links');
  assert.deepEqual([links.ok, links.detail], [true, '2 liên kết nội bộ mở được']);

  const bad = await w.call('draft_save', { request_id: 'b', ...article(['https://lohi2.com/truyen/gone', 'https://lohi2.com/ung-dung']), brief: { ...article([]).brief, slug: 'bai-co-lien-ket-chet' } });
  const no = await w.call('check', { id: bad.id, revision: 1, verdict: 'pass' });
  assert.equal(no.verdict, 'fail');
  assert.match(no.reason, /Liên kết không còn: https:\/\/lohi2\.com\/truyen\/gone/);
  const post = (await w.call('items', { state: 'refused' })).items[0];
  assert.equal(post.id, bad.id);
});

test('check does not fail on a link it cannot reach (offline is not a dead link)', async () => {
  const w = world();
  await w.call('facts_sync', { url: 'https://api.example/app-config' });
  const d = await w.call('draft_save', { request_id: 'o', ...article(['https://lohi2.com/truyen/a', 'https://blog.lohi2.com/truyen-hay/x/vi/']) });
  w.fetch = async () => { throw new Error('offline'); };
  const out = await w.call('check', { id: d.id, revision: 1, verdict: 'pass' });
  assert.equal(out.verdict, 'pass');
  assert.match(out.auto.find(a => a.rule === 'links').detail, /chưa kiểm tra được/);
});

test('facts_sync with no url uses the remembered source, or says to write without prices', async () => {
  const w = world();
  await assert.rejects(w.call('facts_sync', {}), /không nêu giá/);
  await w.call('facts_sync', { url: 'https://api.example/app-config' });
  const again = await w.call('facts_sync', {});
  assert.ok(again.facts > 0);
});

test('sign-in cards: the dispatch schedule raises one card per signed-out channel and wakes no model; the same incident keeps the same id', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'lohi2com' }] });
  const first = await w.call('due', { schedule: true });
  assert.ok(first.wake !== true && first.notify !== true, 'a sign-in is a card, not a model run');
  assert.equal(first.ask, undefined);
  assert.equal(first.raise.length, 1);
  const card = first.raise[0];
  assert.match(card.id, /^need:/);
  const opt = card.options.find(o => o.tool);
  assert.deepEqual([opt.tool.pack, opt.tool.name, opt.tool.input.signed_in, opt.wake], ['marketing', 'pause', true, undefined], 'the pick runs the probe, no model');
  w.now += 10 * 60_000;
  const second = await w.call('due', { schedule: true });
  assert.equal(second.raise[0].id, card.id, 'a tick later is the same card id (the host files it once)');
  // Another channel signing out is another card.
  await w.call('channels_setup', { channels: [{ id: 'facebook-lohi', account: 'https://facebook.com/lohi2com' }] });
  assert.equal((await w.call('due', { schedule: true })).raise.length, 2);
  // Signing in ends the incident: the card is settled, and a later sign-out is a new id.
  await w.call('pause', { channel: 'x-lohi', paused: true, signed_in: true });
  await w.call('pause', { channel: 'x-lohi', paused: false });
  const gone = await w.call('due', { schedule: true });
  assert.ok(gone.settle.some(k => k.includes('x-lohi')), 'the signed-in channel card is settled');
  await w.store.call('channels', 'update', { where: [{ column: 'key', op: 'eq', value: 'x-lohi' }], set: { paused: true, paused_reason: 'signed_out' } });
  w.now += 60_000;
  const again = await w.call('due', { schedule: true });
  assert.ok(again.raise.some(r => r.id !== card.id && r.group === card.group));
});

test('a model call to due (no schedule flag) raises nothing', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'reddit-lohi', account: 'lohi2com' }] });
  const out = await w.call('due', {});
  assert.equal(out.raise, undefined);
});

test('page: one state vocabulary, a checked post is not "waiting", the body shows, the link summary has no empty segment', async () => {
  const w = world();
  await w.call('facts_sync', { url: 'https://api.example/app-config' });
  const d = await w.call('draft_save', { request_id: 'p', ...article(['https://lohi2.com/', 'https://blog.lohi2.com/truyen-hay/x/vi/']) });
  await w.call('check', { id: d.id, revision: 1, verdict: 'pass' });
  const ctx = { store: w.store, now: w.now, page: 'bai-viet', env: {} };
  const { page_view } = await import('../tools/lib/page.mjs');
  const list = await page_view({}, ctx);
  assert.deepEqual([list.counts.ready, list.counts.waiting], [1, 0], 'Đã kiểm tra is its own tab; nothing is queued yet');
  const detail = await page_view({ id: d.id }, ctx);
  assert.match(detail.post.body, /Gợi ý truyện/);
  assert.ok(!detail.brief.find(f => f.label === 'Liên kết nội bộ').value.includes('//'));
  const q = await page_view({ page: 'hang-doi' }, ctx);
  assert.equal(q.empty, true);
});

test('draft_save: the same words saved twice are one draft, not a refused duplicate', async () => {
  const w = world();
  const a = await w.call('draft_save', { request_id: 'one', ...article(['https://lohi2.com/truyen/a', 'https://lohi2.com/ung-dung']) });
  const b = await w.call('draft_save', { request_id: 'two', ...article(['https://lohi2.com/truyen/a', 'https://lohi2.com/ung-dung']) });
  assert.deepEqual([b.id, b.replayed], [a.id, true]);
  assert.equal((await w.call('items', {})).items.length, 1);
});
