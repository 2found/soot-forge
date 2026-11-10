// Radar (feeds read by a tool, a model only to triage), TikTok/YouTube numbers through yt-dlp (a stub binary, never the
// network) and the starving-inputs read the loop-health screen shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tools/marketing.mjs';
import { parseFeed, publicHttps } from '../tools/lib/radar.mjs';
import { fakeStore } from './fake-store.mjs';

const T0 = Date.parse('2026-11-10T01:00:00Z');
const H = 3_600_000;
const world = (env = {}) => {
  const w = { now: T0, env, store: fakeStore({ clock: () => w.now }), feeds: {}, hits: [] };
  w.fetch = async url => {
    w.hits.push(String(url));
    const body = w.feeds[url];
    if (body === undefined) return { ok: false, status: 429, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  w.call = (name, input, extra = {}) => run(name, { input }, { store: w.store, now: w.now, env: w.env, fetchImpl: w.fetch, ...extra });
  return w;
};
const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.map(([t, u, d]) => `<item><title><![CDATA[${t}]]></title><link>${u}</link><description>${d ?? ''}</description></item>`).join('')}</channel></rss>`;
const atom = items => `<feed xmlns="http://www.w3.org/2005/Atom">${items.map(([t, u]) => `<entry><title>${t}</title><link href="${u}"/><content type="html">&lt;p&gt;hi &amp;amp; bye&lt;/p&gt;</content></entry>`).join('')}</feed>`;
const SRC = [{ key: 'reddit-noveltranslations', kind: 'reddit', url: 'https://www.reddit.com/r/noveltranslations/.rss' }, { key: 'news-truyen-chu', kind: 'news', url: 'https://news.google.com/rss/search?q=truyen+chu' }];

test('feeds parse as RSS and Atom, and only public https addresses are read', () => {
  assert.deepEqual(parseFeed(rss([['Truyện hay', 'https://a.example/1', '<b>mô tả</b>']])), [{ title: 'Truyện hay', url: 'https://a.example/1', summary: 'mô tả' }]);
  assert.equal(parseFeed(atom([['Tiên hiệp', 'https://a.example/2']]))[0].summary, 'hi & bye');
  assert.equal(parseFeed(rss([['bad', 'http://a.example/x'], ['local', 'https://localhost/x'], ['ip', 'https://10.0.0.1/x']])).length, 0);
  assert.equal(publicHttps('https://user:pw@a.example/x'), null);
});

test('radar_read keeps each new item once, reads the oldest due source first, and wakes the triage Soot once per batch', async () => {
  const w = world();
  w.feeds[SRC[0].url] = atom([1, 2, 3, 4, 5].map(i => [`Bài ${i}`, `https://www.reddit.com/r/x/${i}`]));
  w.feeds[SRC[1].url] = rss([['Tin 1', 'https://news.example/1'], ['Tin 2', 'https://news.example/2'], ['Tin 3', 'https://news.example/3']]);
  const a = await w.call('radar_read', { sources: SRC, schedule: true, wake_at: 8, per_call: 2 });
  assert.deepEqual([a.new_total, a.waiting, a.notify], [8, 8, true]);
  // The same call again: sources are not due, nothing new, no second wake.
  const again = await w.call('radar_read', { sources: SRC, schedule: true, wake_at: 8 });
  assert.deepEqual([again.read, again.notify], [[], false]);
  // The triage Soot reads, keeps few, dismisses the rest.
  const list = await w.call('signals_list', {});
  // Later the feeds repeat the same items: stored once, no wake for the answered batch.
  w.now += 7 * H;
  const later = await w.call('radar_read', { schedule: true, wake_at: 8 });
  assert.deepEqual([later.new_total, later.waiting, later.notify], [0, 8, false]);
  assert.equal(list.signals.length, 8);
  assert.match(list.signals[0].ref, /^RS-[0-9A-F]{8}$/);
  const [first, second, ...rest] = list.signals;
  await w.call('signals_mark', { items: [{ ref: first.ref, state: 'kept', note: 'Người đọc hỏi nguồn truyện dịch: viết so sánh' }, { ref: second.ref, state: 'dismissed' }, ...rest.map(s => ({ ref: s.ref, state: 'dismissed' }))] });
  assert.equal((await w.call('signals_list', { state: 'kept' })).signals[0].note.startsWith('Người đọc'), true);
  assert.equal((await w.call('signals_list', {})).signals.length, 0);
});

test('radar non-happy: a failing source is recorded and does not stop the others; bad input and a half-valid mark change nothing', async () => {
  const w = world();
  w.feeds[SRC[1].url] = rss([['Tin 1', 'https://news.example/1']]);
  const r = await w.call('radar_read', { sources: SRC, per_call: 5 });
  assert.equal(r.read.find(x => x.source === 'reddit-noveltranslations').error, 'HTTP 429');
  assert.equal(r.read.find(x => x.source === 'news-truyen-chu').new, 1);
  assert.equal(w.store.data.sources.find(s => s.key === 'reddit-noveltranslations').last_error, 'HTTP 429');
  await assert.rejects(w.call('radar_read', { sources: [{ key: 'x', url: 'http://insecure.example/feed' }] }), /public https/);
  const ref = w.store.data.signals[0].ref;
  await assert.rejects(w.call('signals_mark', { items: [{ ref, state: 'kept', note: 'ok' }, { ref: 'RS-00000000', state: 'dismissed' }] }), /No signal/);
  assert.equal(w.store.data.signals[0].state, 'new', 'all or nothing');
  await assert.rejects(w.call('signals_mark', { items: [{ ref, state: 'kept' }] }), /note/);
});

// ---------- yt-dlp ----------

/** A yt-dlp stand-in: prints the counts for the url it is given; an unknown url fails like the real one. */
function stub(dir) {
  const file = join(dir, 'yt-dlp');
  writeFileSync(file, `#!${process.execPath}
const url = process.argv.at(-1), args = process.argv.slice(2);
if (!args.includes('--skip-download') || !args.includes('--dump-json')) process.exit(3);
const known = { 'https://www.tiktok.com/@lohi2com/video/111': { view_count: 1200, like_count: 90, comment_count: 7, repost_count: 3 },
  'https://www.youtube.com/watch?v=abc': { view_count: 55, like_count: 4, comment_count: 0 } };
if (url === 'https://www.tiktok.com/@lohi2com') {
  for (const id of ['201', '202']) console.log(JSON.stringify({ webpage_url: 'https://www.tiktok.com/@lohi2com/video/' + id, view_count: Number(id) * 10, like_count: 1 }));
} else if (known[url]) console.log(JSON.stringify({ webpage_url: url, ...known[url] }));
else { console.error('ERROR: Unable to extract'); process.exit(1); }
`);
  chmodSync(file, 0o755);
  return file;
}
async function published(w, url, kind = 'video') {
  await w.store.insert('posts', { ref: 'P-' + Math.random().toString(16).slice(2, 10).toUpperCase(), kind, channel: 'tiktok-lohi', state: 'published', revision: 1, url });
}

test('video_stats reads published video posts and a channel handle through yt-dlp into metrics, one row per video and day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-'));
  const w = world({ YT_DLP_BIN: stub(dir) });
  await published(w, 'https://www.tiktok.com/@lohi2com/video/111');
  await published(w, 'https://www.youtube.com/watch?v=abc');
  await published(w, 'https://blog.lohi2.com/a/', 'article');
  const out = await w.call('video_stats', { handles: [{ url: 'https://www.tiktok.com/@lohi2com', limit: 2 }] });
  assert.deepEqual([out.ok, out.rows, out.videos, out.errors], [true, 4, 4, []]);
  const tk = w.store.data.metrics.find(m => m.url.endsWith('/111'));
  assert.deepEqual([tk.source, tk.views, tk.likes, tk.comments, tk.reposts, tk.day], ['tiktok', 1200, 90, 7, 3, '2026-11-10']);
  assert.equal(w.store.data.metrics.find(m => m.source === 'youtube').reposts, null, 'a count the platform does not give stays null, never 0');
  await w.call('video_stats', {});
  assert.equal(w.store.data.metrics.filter(m => m.url.endsWith('/111')).length, 1, 'the same day replaces, never doubles');
  // The starving-inputs read now sees the numbers.
  const h = await w.call('inputs_health', {});
  assert.equal(h.inputs.find(i => i.key === 'tiktok').starving, false);
});

test('video_stats non-happy: no yt-dlp is one plain need, a failing video is listed, nothing to read says so, a bad handle is refused', async () => {
  const w = world({ YT_DLP_BIN: '/nonexistent/yt-dlp' });
  await published(w, 'https://www.tiktok.com/@lohi2com/video/111');
  const missing = await w.call('video_stats', {});
  assert.deepEqual([missing.skipped, missing.status, missing.notify, missing.wake], [true, 'yt_dlp_missing', false, false]);
  assert.match(missing.message, /brew install yt-dlp/);
  assert.equal(w.store.data.metrics.length, 0);
  const h = await w.call('inputs_health', {});
  assert.match(h.inputs.find(i => i.key === 'tiktok').detail, /Chưa có số TikTok — Chưa cài yt-dlp/);
  const dir = mkdtempSync(join(tmpdir(), 'ytdlp-'));
  const w2 = world({ YT_DLP_BIN: stub(dir) });
  await published(w2, 'https://www.tiktok.com/@lohi2com/video/999');
  const failed = await w2.call('video_stats', {});
  assert.deepEqual([failed.rows, failed.why, failed.errors.length], [0, 'read_failed', 1]);
  const idle = await world().call('video_stats', {});
  assert.deepEqual([idle.status, idle.rows], ['idle', 0]);
  await assert.rejects(w2.call('video_stats', { handles: [{ url: 'https://evil.example/@x' }] }), /tiktok\.com or youtube\.com/);
  await assert.rejects(w2.call('video_stats', { handles: [{ url: 'http://www.tiktok.com/@x' }] }), /https/);
});

test('inputs_health says exactly what is missing, in the words a person acts on', async () => {
  const w = world();
  const h = await w.call('inputs_health', {});
  const by = Object.fromEntries(h.inputs.map(i => [i.key, i]));
  assert.ok(Object.values(by).every(i => i.starving), 'a fresh workspace starves every input');
  assert.match(by.gsc.detail, /^GSC 0 dòng — Search Console chưa đọc lần nào/);
  assert.match(by.signals.detail, /Chưa có tín hiệu thị trường: chưa cấu hình nguồn radar/);
  assert.match(by.tiktok.detail, /^Chưa có số TikTok/);
  await w.call('gsc_sync', { site: 'sc-domain:lohi2.com' });
  assert.match((await w.call('inputs_health', {})).inputs.find(i => i.key === 'gsc').detail, /Đăng nhập Google/, 'the sync recorded why it read nothing');
});

// F12: relevance in the tool, a short wake, sources that answer 429 or never return.
const KW = ['truyện chữ', 'truyện dịch', 'đọc truyện', 'webnovel'];
const NEWS = { key: 'news-vi', kind: 'news', url: 'https://news.google.com/rss/search?q=vi' };
const EN = { key: 'reddit-en', kind: 'reddit', url: 'https://www.reddit.com/r/webnovels/.rss' };

test('radar prefilter: English and off-topic items are kept as dismissed, never shown to the model', async () => {
  const w = world();
  w.feeds[NEWS.url] = rss([['Ứng dụng đọc truyện chữ mới ra mắt', 'https://n.example/1', 'người đọc truyện chữ tăng'], ['Giá vàng hôm nay tăng mạnh', 'https://n.example/2', 'thị trường'], ['Top 10 Python frameworks', 'https://n.example/3', 'listicle']]);
  w.feeds[EN.url] = atom([['Best webnovel of the year', 'https://www.reddit.com/r/webnovels/1']]);
  const out = await w.call('radar_read', { sources: [NEWS, EN], per_call: 5, keywords: KW, lang: 'vi' });
  assert.equal(out.new_total, 1);
  assert.deepEqual(out.read.find(r => r.source === 'news-vi'), { source: 'news-vi', new: 1, off_topic: 2 });
  assert.equal(out.read.find(r => r.source === 'reddit-en').off_topic, 1, 'English text has no Vietnamese letters');
  const states = Object.fromEntries(w.store.data.signals.map(s => [s.url, s.state]));
  assert.equal(states['https://n.example/1'], 'new');
  assert.equal(states['https://n.example/2'], 'dismissed');
  assert.equal((await w.call('signals_list', {})).signals.length, 1);
  // Read again later: the dismissed ones are not stored twice.
  w.now += 7 * H;
  assert.equal((await w.call('radar_read', { per_call: 5, keywords: KW, lang: 'vi' })).new_total, 0);
  assert.equal(w.store.data.signals.length, 4);
});

test('radar wake: at most 15 of the best new items, the surplus dismissed, one wake per gap', async () => {
  const w = world();
  w.feeds[NEWS.url] = rss(Array.from({ length: 30 }, (_, i) => [`Đọc truyện dịch số ${i}${i < 5 ? ' webnovel truyện chữ' : ''}`, `https://n.example/${i}`, 'nội dung']));
  const a = await w.call('radar_read', { sources: [NEWS], schedule: true, wake_at: 6, keywords: KW, lang: 'vi' });
  assert.deepEqual([a.wake, a.wake_items, a.waiting, a.dropped], [true, 15, 15, 15]);
  const shown = (await w.call('signals_list', { limit: 40 })).signals; // the triage Soot answers the wake
  assert.equal(shown.length, 15, 'the list is capped too');
  assert.ok(['https://n.example/0', 'https://n.example/4'].every(u => shown.some(s => s.url === u)), 'the best-matching items are the ones kept');
  assert.equal(w.store.data.signals.filter(s => s.note === 'tự bỏ: vượt giới hạn mỗi lần').length, 15);
  // New items the same day do not wake again before the gap.
  w.now += 7 * H;
  w.feeds[NEWS.url] = rss(Array.from({ length: 10 }, (_, i) => [`Đọc truyện chữ mới ${i}`, `https://n.example/new${i}`, 'x']));
  const b = await w.call('radar_read', { schedule: true, wake_at: 6, keywords: KW, lang: 'vi' });
  assert.deepEqual([b.new_total, b.notify], [10, false]);
  w.now += 14 * H;
  w.feeds[NEWS.url] = rss(Array.from({ length: 10 }, (_, i) => [`Đọc truyện chữ lại ${i}`, `https://n.example/again${i}`, 'x']));
  assert.equal((await w.call('radar_read', { schedule: true, wake_at: 6, keywords: KW, lang: 'vi' })).wake, true, 'a day later it wakes again');
});

test('radar non-happy: a source answering 429 rests a day and is named in skipped; three failures switch it off; retire does it by hand', async () => {
  const w = world();
  w.feeds[NEWS.url] = rss([['Đọc truyện chữ', 'https://n.example/1', 'x']]);
  const first = await w.call('radar_read', { sources: [NEWS, EN], per_call: 5 });
  assert.equal(first.read.find(r => r.source === 'reddit-en').error, 'HTTP 429');
  assert.equal(w.store.data.sources.find(s => s.key === 'reddit-en').fails, 1);
  // Inside the rest the source is not even tried; the call says so.
  w.now += 7 * H;
  const hitsBefore = w.hits.filter(u => u === EN.url).length;
  const second = await w.call('radar_read', { per_call: 5 });
  assert.equal(w.hits.filter(u => u === EN.url).length, hitsBefore);
  assert.match(second.skipped.find(s => s.source === 'reddit-en').why, /^nghỉ đến/);
  // After the rest it fails again twice more and is switched off.
  w.now += 25 * H;
  await w.call('radar_read', { per_call: 5 });
  w.now += 25 * H;
  const third = await w.call('radar_read', { per_call: 5 });
  assert.equal(third.read.find(r => r.source === 'reddit-en').disabled, true);
  assert.match(third.skipped.find(s => s.source === 'reddit-en').why, /^tắt sau 3 lần lỗi: HTTP 429/);
  w.now += 25 * H;
  const hits = w.hits.length;
  const later = await w.call('radar_read', { per_call: 5 });
  assert.ok(!later.read.some(r => r.source === 'reddit-en') && w.hits.slice(hits).every(u => u !== EN.url));
  assert.match(later.skipped.find(s => s.source === 'reddit-en').why, /^tắt/);
  // retire switches a healthy source off by name, keeping its signals.
  const r = await w.call('radar_read', { retire: ['news-vi', 'nope'] });
  assert.deepEqual(r.retired, ['news-vi']);
  assert.equal(w.store.data.signals.length, 1);
});

// M7-F2: a wake the host refused (a token budget) is never answered; it must not start wake_gap_hours.
test('radar wake refused by a budget does not count toward the gap: the batch wakes again, and the gap starts at the answered wake', async () => {
  const w = world();
  w.feeds[NEWS.url] = rss(Array.from({ length: 8 }, (_, i) => [`Đọc truyện chữ ${i}`, `https://n.example/${i}`, 'x']));
  const a = await w.call('radar_read', { sources: [NEWS], schedule: true, wake_at: 6, keywords: KW, lang: 'vi' });
  assert.equal(a.wake, true);
  // Refused: nobody reads the batch. Inside the hold no second wake (the run may just be queued).
  w.now += 2 * H;
  assert.equal((await w.call('radar_read', { schedule: true, wake_at: 6, keywords: KW, lang: 'vi' })).wake, false);
  // After the hold, well inside wake_gap_hours (20), the same unanswered batch wakes again.
  w.now += 5 * H;
  const retry = await w.call('radar_read', { schedule: true, wake_at: 6, keywords: KW, lang: 'vi' });
  assert.deepEqual([retry.wake, retry.wake_items], [true, 8]);
  // This time the Soot answers (marks the batch): now the gap counts from that wake.
  const batch = (await w.call('signals_list', {})).signals;
  await w.call('signals_mark', { items: batch.map(s => ({ ref: s.ref, state: 'dismissed' })) });
  w.now += 7 * H;
  w.feeds[NEWS.url] = rss(Array.from({ length: 8 }, (_, i) => [`Đọc truyện chữ mới ${i}`, `https://n.example/new${i}`, 'x']));
  assert.equal((await w.call('radar_read', { schedule: true, wake_at: 6, keywords: KW, lang: 'vi' })).wake, false, 'inside the gap of the answered wake');
  w.now += 14 * H;
  assert.equal((await w.call('radar_read', { schedule: true, wake_at: 6, keywords: KW, lang: 'vi' })).wake, true);
});

// wake_gap_hours 0 wakes on every scheduled read with enough new signals: no hold for an unanswered wake.
test('radar with wake_gap_hours 0 holds nothing', async () => {
  const w = world();
  w.feeds[NEWS.url] = rss(Array.from({ length: 8 }, (_, i) => [`Đọc truyện chữ ${i}`, `https://n.example/${i}`, 'x']));
  const opts = { schedule: true, wake_at: 6, wake_gap_hours: 0, keywords: KW, lang: 'vi' };
  assert.equal((await w.call('radar_read', { sources: [NEWS], ...opts })).wake, true);
  w.now += 1 * H;
  assert.equal((await w.call('radar_read', opts)).wake, true);
});
