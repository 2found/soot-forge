// Wake once: a due item the Editor was woken for and could not finish (it parked on a person) never wakes it again
// until the item changes state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { classify } from '../tools/lib/probe.mjs';
import { socialPending } from '../tools/lib/plan.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-10T01:00:00Z'); // 08:00 ICT
const H = 3_600_000, DAY = 24 * H;
const FEED = 'https://api.example/novel/discovery/feed', GENRES = 'https://api.example/novel/discovery/genres';
const CATALOG = { feed: FEED, genres: GENRES, page: 'https://lohi2.com/truyen/{slug}', links: ['https://lohi2.com/ung-dung'] };
const novel = slug => ({ slug, titleVi: `Truyện ${slug}`, authorNameVi: 'Tác Giả', genres: ['x'], totalChapters: 120, completionStatus: 'completed', access: 'open', synopsis: 'Một hành trình dài.', totalWords: 1, readCount: 1 });
const WAKE = { wake: true, channel: 'blog-lohi', facts_url: 'https://api.example/app-config', catalog: CATALOG };
const root = new URL('../../../', import.meta.url);
const json = p => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

function world({ genres = ['Tiên Hiệp', 'Ngôn Tình'] } = {}) {
  const w = { now: T0, env: { MARKETING_CLAIM_KEY: KEY } };
  w.store = fakeStore({ clock: () => w.now });
  w.fetch = async url => {
    const u = String(url);
    if (u.startsWith(GENRES)) return { ok: true, status: 200, json: async () => genres };
    if (u.startsWith(FEED)) return { ok: true, status: 200, json: async () => ['a', 'b', 'c', 'd'].map(novel) };
    if (u.startsWith('https://api.example/app-config')) return { ok: true, status: 200, json: async () => ({ pricing: { audio_monthly: 49000 } }) };
    if (u.startsWith('https://lohi2.com/') || u.startsWith('https://blog.lohi2.com/')) return { ok: true, status: 200 };
    throw new Error('no network');
  };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch });
  return w;
}
let n = 0;
const article = (kw, slug) => ({
  kind: 'article', channel: 'blog-lohi', request_id: `r${++n}`, body: `Gợi ý ${kw}. [một](https://lohi2.com/truyen/a) và [hai](https://lohi2.com/ung-dung)`,
  brief: { keyword: kw, title: `${kw[0].toUpperCase()}${kw.slice(1)} nhất 2026: chín bộ đáng đọc`, meta: `Chín bộ ${kw} nhất 2026 cho người mới và người đọc lâu năm: cốt truyện, độ dài, điểm nổi bật và nơi đọc nghe thử trên Lohi.`.slice(0, 150), slug },
});
async function passed(w, kw, slug) {
  await w.call('facts_sync', { url: 'https://api.example/app-config' });
  const d = await w.call('draft_save', article(kw, slug));
  const c = await w.call('check', { id: d.id, revision: 1, verdict: 'pass' });
  assert.equal(c.verdict, 'pass', JSON.stringify(c));
  return d.id;
}

test('a due item wakes the Editor once; it parks on a person and is not woken again until it changes', async () => {
  const w = world();
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  const s = await w.call('schedule', { id });
  w.now = Date.parse(s.scheduled_at) + 60_000;
  const first = await w.call('due', { schedule: true });
  assert.deepEqual([first.publish, first.notify, first.wake], [[id], true, true]);
  for (let i = 0; i < 3; i++) {
    w.now += 10 * 60_000;
    const again = await w.call('due', { schedule: true });
    assert.deepEqual([again.publish, again.notify, again.wake, again.waiting], [[id], false, false, 1], 'listed, but no model wake');
  }
  // Non-happy: a read-only call (no schedule flag) writes no marker and still lists the item.
  const fresh = world();
  const id2 = await passed(fresh, 'truyện ngôn tình hay', 'ngon-tinh-hay-nhat-2026');
  const s2 = await fresh.call('schedule', { id: id2 });
  fresh.now = Date.parse(s2.scheduled_at) + 60_000;
  assert.equal((await fresh.call('due', {})).notify, true);
  assert.equal((await fresh.call('due', {})).notify, true, 'only the schedule remembers');
});

test('a changed item wakes again: a new slot, or its channel resumed', async () => {
  const w = world();
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  const s = await w.call('schedule', { id });
  w.now = Date.parse(s.scheduled_at) + 60_000;
  assert.equal((await w.call('due', { schedule: true })).notify, true);
  assert.equal((await w.call('due', { schedule: true })).notify, false);
  // The channel resumes (pause true then false): the marker goes, the item may be woken for once more.
  await w.call('pause', { channel: 'blog-lohi', paused: true });
  await w.call('pause', { channel: 'blog-lohi', paused: false });
  assert.equal((await w.call('due', { schedule: true })).notify, true, 'channel resumed');
  assert.equal((await w.call('due', { schedule: true })).notify, false);
  // Resume all clears them too.
  await w.call('pause', { paused: true });
  await w.call('pause', { paused: false });
  assert.equal((await w.call('due', { schedule: true })).notify, true, 'team resumed');
  // Once the item is gone (claimed and recorded) its marker is pruned.
  const c = await w.call('claim', { id, action: 'publish' });
  assert.ok(c.ok !== false);
  await w.call('due', { schedule: true });
  assert.equal((await w.store.query('attention', [], { limit: 50 })).filter(r => r.kind === 'woke-item').length, 0);
});
