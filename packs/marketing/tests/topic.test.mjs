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
