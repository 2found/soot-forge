// A topic handed to the wake call by the company loop (chain: company-loop.topic_next -> marketing.plan)
// reaches the Writer's own plan call, which carries no query, until a post about it exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';

const T0 = Date.parse('2026-11-10T01:00:00Z');
const FEED = 'https://api.example/novel/discovery/feed', GENRES = 'https://api.example/novel/discovery/genres';
const CATALOG = { feed: FEED, genres: GENRES, page: 'https://lohi2.com/truyen/{slug}', links: ['https://lohi2.com/ung-dung'] };
const novel = slug => ({ slug, titleVi: `Truyện ${slug}`, authorNameVi: 'Tác Giả', genres: ['x'], totalChapters: 120, completionStatus: 'completed', access: 'open', synopsis: 'Một hành trình dài.', totalWords: 1, readCount: 1 });
const WAKE = { wake: true, channel: 'blog-lohi', facts_url: 'https://api.example/app-config', catalog: CATALOG };

function world() {
  const w = { now: T0, env: { MARKETING_CLAIM_KEY: 'k'.repeat(32) } };
  w.store = fakeStore({ clock: () => w.now });
  w.fetch = async url => {
    const u = String(url);
    if (u.startsWith(GENRES)) return { ok: true, status: 200, json: async () => ['Tiên Hiệp', 'Ngôn Tình'] };
    if (u.startsWith(FEED)) return { ok: true, status: 200, json: async () => ['a', 'b', 'c', 'd'].map(novel) };
    if (u.startsWith('https://api.example/app-config')) return { ok: true, status: 200, json: async () => ({}) };
    if (u.startsWith('https://lohi2.com/') || u.startsWith('https://blog.lohi2.com/')) return { ok: true, status: 200 };
    throw new Error('no network');
  };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch });
  return w;
}

test('the query of a wake call is kept, so the Writer plan without a query writes about it', async () => {
  const w = world();
  const wake = await w.call('plan', { ...WAKE, query: 'cách học tiếng Anh giao tiếp' });
  assert.ok(wake.wake !== false);
  const writer = await w.call('plan', { channel: 'blog-lohi', catalog: CATALOG });
  assert.match(JSON.stringify(writer), /cách học tiếng Anh giao tiếp/);
});

test('without a handed topic the Writer plan is unchanged', async () => {
  const w = world();
  await w.call('plan', WAKE);
  const writer = await w.call('plan', { channel: 'blog-lohi', catalog: CATALOG });
  assert.doesNotMatch(JSON.stringify(writer), /cách học tiếng Anh giao tiếp/);
});

test('the wake call reports the keywords of the newest posts (topic_posts) so the company loop can mark a topic written', async () => {
  const w = world();
  const first = await w.call('plan', { ...WAKE, query: 'truyện tiên hiệp hay nhất' });
  assert.equal(first.topic_posts, undefined, 'no post yet');
  await w.store.insert('posts', { ref: 'P-TEST000001', channel: 'blog-lohi', kind: 'article', state: 'draft', revision: 1, body: 'b', brief: { keyword: 'truyện tiên hiệp hay nhất' } });
  const again = await w.call('plan', { ...WAKE, query: 'truyện tiên hiệp hay nhất' });
  assert.deepEqual(again.topic_posts, [{ keyword: 'truyện tiên hiệp hay nhất', post: 'P-TEST000001' }]);
});

// F10: a published post reports its own numbers; no signal means the key is absent ("chưa đo"), never 0.
const published = (w, ref, kw, url) => w.store.insert('posts', { ref, channel: 'blog-lohi', kind: 'article', state: 'published', revision: 1, body: 'b', url, brief: { keyword: kw } });

test('topic_posts carries publish date and the post\'s own Search Console clicks', async () => {
  const w = world();
  await published(w, 'P-PUB000001', 'truyện kiếm hiệp hay', 'https://blog.lohi2.com/kiem-hiep');
  await w.store.insert('publish_log', { post: 'P-PUB000001', channel: 'blog-lohi', action: 'publish', intent_id: 'i1', status: 'published', at: '2026-11-08T03:00:00.000Z' });
  await w.store.insert('metrics', { url: 'https://blog.lohi2.com/kiem-hiep', source: 'gsc', day: '2026-11-09', query: '', impressions: 400, clicks: 17, position: 8 });
  const out = await w.call('plan', { ...WAKE, query: 'truyện kiếm hiệp hay' });
  assert.deepEqual(out.topic_posts, [{ keyword: 'truyện kiếm hiệp hay', post: 'P-PUB000001', url: 'https://blog.lohi2.com/kiem-hiep', published_at: '2026-11-08T03:00:00.000Z', clicks: 17 }]);
});

test('a published post nobody measured has no clicks key (not 0), and a draft has no publish fields', async () => {
  const w = world();
  await published(w, 'P-PUB000002', 'truyện ngôn tình hay', 'https://blog.lohi2.com/ngon-tinh');
  await w.store.insert('posts', { ref: 'P-DRAFT00001', channel: 'blog-lohi', kind: 'article', state: 'draft', revision: 1, body: 'b', brief: { keyword: 'truyện đam mỹ hay' } });
  const out = await w.call('plan', { ...WAKE, query: 'truyện ngôn tình hay' });
  const byPost = Object.fromEntries(out.topic_posts.map(p => [p.post, p]));
  assert.ok(byPost['P-PUB000002'].published_at && !('clicks' in byPost['P-PUB000002']) && !('signups' in byPost['P-PUB000002']));
  assert.deepEqual(byPost['P-DRAFT00001'], { keyword: 'truyện đam mỹ hay', post: 'P-DRAFT00001' });
});
