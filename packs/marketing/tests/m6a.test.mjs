// M6a: the generic growth desk. file_read, the founder's open question on an
// item, TikTok from setup, channels not chosen, the pasted newsletter list,
// the reply card toast and Search Console without a named site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { world, saved, T0 } from './desk-world.mjs';
import { slugTitle } from '../tools/lib/library.mjs';
import { gscProperty } from '../tools/lib/ops.mjs';

const iso = (t) => new Date(t).toISOString();

// ---------- file_read ----------

test('file_read reads products.json, a brand.md and a folder of the library, in pages', async () => {
  const w = await world({ hub: false });
  await mkdir(join(w.root, 'acme'), { recursive: true });
  await writeFile(join(w.root, 'acme/brand.md'), '# Acme\n\nĐọc truyện.\n\n## Giọng\n- ngắn\n');
  const top = await w.call('file_read', {});
  assert.ok(top.entries.includes('products.json') && top.entries.includes('acme/'), 'no path lists the top folder');
  const products = await w.call('file_read', { path: 'products.json' });
  assert.equal(JSON.parse(products.text).products[0].id, 'acme');
  assert.equal(products.next_offset, null);
  const brand = await w.call('file_read', { path: './acme/brand.md', max_chars: 6 });
  assert.deepEqual([brand.path, brand.text, brand.next_offset], ['acme/brand.md', '# Acme', 6]);
  const rest = await w.call('file_read', { path: 'acme/brand.md', offset: brand.next_offset });
  assert.match(rest.text, /## Giọng/);
  assert.deepEqual((await w.call('file_read', { path: 'acme' })).entries, ['brand.md']);
});

test('file_read refuses what leaves the library, hidden files, binaries and big files; no folder is a setup ask', async () => {
  const w = await world({ hub: false });
  const outside = await mkdtemp(join(tmpdir(), 'mk-out-'));
  await writeFile(join(outside, 'secret.txt'), 'token');
  await symlink(join(outside, 'secret.txt'), join(w.root, 'leak.txt'));
  await symlink(outside, join(w.root, 'away'));
  await mkdir(join(w.root, '.git'), { recursive: true });
  await writeFile(join(w.root, '.git/config'), '[core]');
  await writeFile(join(w.root, 'big.md'), 'x'.repeat(256 * 1024 + 1));
  await writeFile(join(w.root, 'bin.dat'), Buffer.from([0x41, 0, 0x42]));
  for (const path of ['../etc/passwd', '/etc/passwd', 'leak.txt', 'away/secret.txt', '.git/config', 'a\\b']) {
    const out = await w.call('file_read', { path });
    assert.equal(out.error?.code, 'path_refused', path);
    assert.doesNotMatch(JSON.stringify(out), /token/, path);
  }
  assert.equal((await w.call('file_read', { path: 'big.md' })).error.code, 'too_large');
  assert.equal((await w.call('file_read', { path: 'bin.dat' })).error.code, 'not_text');
  assert.equal((await w.call('file_read', { path: 'none.md' })).error.code, 'not_found');
  const unset = await w.call('file_read', { path: 'products.json' }, {}, { env: {} });
  assert.deepEqual([unset.ok, unset.reason_code, unset.key], [false, 'needs_credential', 'MARKETING_ROOT']);
});

// ---------- the founder's open question ----------

test('an item the team asked the founder about reads Chờ bạn trả lời, and Hôm nay is not healthy while it waits', async () => {
  const w = await world({ hub: false });
  const s = await saved(w);
  const before = await w.view({ view: 'summary', approvals: [] });
  const asked = await w.call('item_save', { ref: s.ref, product: 'acme', waiting: 'Bài nhắc giá 49k, giá này còn đúng không?' });
  assert.equal(asked.revision, s.revision, 'a question alone does not move the revision');
  const item = await w.view({ view: 'item', ref: s.ref });
  assert.deepEqual([item.stage, item.state, item.note], ['making', 'waiting', 'Bài nhắc giá 49k, giá này còn đúng không?']);
  const today = await w.view({ view: 'today', approvals: [] });
  const ask = today.blockers.find(b => b.kind === 'ask');
  assert.deepEqual([ask.ref, ask.title_code, ask.title_args.question, ask.do.sheet.key], [s.ref, 'ask', 'Bài nhắc giá 49k, giá này còn đúng không?', s.ref]);
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.notEqual(sum.status.code, 'healthy');
  assert.deepEqual([sum.status.code, sum.status.tone, sum.status.args.asks], ['waits', 'wait', 1]);
  assert.notEqual(before.status.args?.asks, 1);
  // Answered: null clears it and the item is a draft again.
  await w.call('item_save', { ref: s.ref, product: 'acme', waiting: null });
  assert.equal((await w.view({ view: 'item', ref: s.ref })).state, 'drafting');
  assert.equal((await w.view({ view: 'today', approvals: [] })).blockers.some(b => b.kind === 'ask'), false);
});

test('a waiting question over 300 characters is refused and changes nothing', async () => {
  const w = await world({ hub: false });
  const s = await saved(w);
  const out = await w.call('item_save', { ref: s.ref, product: 'acme', waiting: 'x'.repeat(301) });
  assert.equal(out.error.code, 'invalid_request');
  assert.equal((await w.view({ view: 'item', ref: s.ref })).state, 'drafting');
});

// ---------- channels from setup ----------

test('the TikTok handle given at setup shows on Kênh đăng; a channel not chosen reads off (Không dùng)', async () => {
  const w = await world({ hub: false });
  const made = await w.act({ op: 'setup', product: { id: 'qua', name: 'Quà biết nói', site: 'quabietnoi.vn', channels: { tiktok: '@quabietnoi', x: '@quaxx' } } });
  assert.equal(made.ok, true);
  const ch = await w.view({ view: 'channels' });
  const qua = ch.rows.find(r => r.product === 'qua');
  assert.deepEqual([qua.cells.tiktok.state, qua.cells.tiktok.account], ['manual', '@quabietnoi']);
  assert.deepEqual([qua.cells.x.state, qua.cells.x.account], ['by_hand', '@quaxx']);
  assert.deepEqual([qua.cells.facebook.state, qua.cells.facebook.why], ['off', 'not_chosen']);
  // A product that never chose TikTok and has no video channel: not chosen, not a TikTok to post by hand.
  const beta = ch.rows.find(r => r.product === 'beta');
  assert.deepEqual([beta.cells.tiktok.state, beta.cells.tiktok.why], ['off', 'not_chosen']);
});

// ---------- the TikTok hand-off from an mvf delivery ----------

test('a delivered cut gives the hand-off its file path and caption; the title is the humanized slug', async () => {
  const w = await world({ hub: false });
  const cut = join(w.root, 'channels/acme-video/campaigns/ep-1/08-delivery/s1-vertical/tiktok');
  await mkdir(cut, { recursive: true });
  await writeFile(join(cut, 'ep-1.mp4'), '');
  await writeFile(join(cut, 'caption.txt'), 'Một bộ tiên hiệp đáng đọc #truyen\n');
  await w.call('library_scan', { hub: false });
  const content = await w.view({ view: 'content' });
  const video = content.items.find(i => i.format === 'video');
  assert.equal(video.title, 'Ep 1');
  const item = await w.view({ view: 'item', ref: video.ref });
  assert.equal(item.video.tiktok.file, 'channels/acme-video/campaigns/ep-1/08-delivery/s1-vertical/tiktok/ep-1.mp4');
  assert.equal(item.video.tiktok.path, join(await realpath(w.root), item.video.tiktok.file));
  assert.equal(item.video.tiktok.caption, 'Một bộ tiên hiệp đáng đọc #truyen');
  assert.deepEqual([slugTitle('ep-1'), slugTitle('mua-dong_2026'), slugTitle('')], ['Ep 1', 'Mua dong 2026', '']);
});

test('a campaign with no TikTok cut has no file to copy (never a path outside the library)', async () => {
  const w = await world({ hub: false });
  await w.call('library_scan', { hub: false });
  const video = (await w.view({ view: 'content' })).items.find(i => i.format === 'video');
  const item = await w.view({ view: 'item', ref: video.ref });
  assert.equal(item.video.tiktok, null);
});

// ---------- the newsletter's recipients ----------

test('review-pr M6: an empty library folder answers no names; an address never starts as a spreadsheet formula', async () => {
  const w = await world({ hub: false });
  await mkdir(join(w.root, 'acme/newsletter'), { recursive: true });
  assert.deepEqual(await w.call('file_read', { path: 'acme/newsletter' }), { ok: true, path: 'acme/newsletter', entries: [] });
  const gone = await w.call('file_read', { path: 'acme/nothing.md' });
  assert.notEqual(gone.entries?.length, 0);
  assert.equal(gone.entries, undefined, 'a missing path is not an empty folder');
  const out = await w.act({ op: 'subscribers', product: 'acme', list: '=cmd@vidu.vn\n+x@vidu.vn\nan@vidu.vn' });
  assert.equal(out.count, 1);
});

test('subscribers: a pasted list becomes subscribers.csv and the desk only ever shows the count', async () => {
  const w = await world({ hub: false });
  const list = 'email\nAn <an@vidu.vn>\nbinh@vidu.vn\nBINH@vidu.vn\n"Chi",chi@vidu.vn\nkhông phải địa chỉ\n';
  const out = await w.act({ op: 'subscribers', product: 'acme', list });
  assert.deepEqual([out.ok, out.count, out.skipped], [true, 3, 1]);
  assert.doesNotMatch(JSON.stringify(out), /vidu\.vn/, 'the answer carries no address');
  assert.equal(await readFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'utf8'), 'email\nan@vidu.vn\nbinh@vidu.vn\nchi@vidu.vn\n');
  const ch = await w.view({ view: 'channels' });
  const cell = ch.rows.find(r => r.product === 'acme').cells.newsletter;
  assert.deepEqual([cell.state, cell.subscribers], ['export', 3]);
  assert.doesNotMatch(JSON.stringify(ch), /vidu\.vn/);
  // A new paste replaces the old list.
  assert.equal((await w.act({ op: 'subscribers', product: 'acme', list: 'dung@vidu.vn' })).count, 1);
  assert.equal(await readFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'utf8'), 'email\ndung@vidu.vn\n');
});

test('subscribers refuses a list with no address, an unknown product and a missing folder, and writes nothing', async () => {
  const w = await world({ hub: false });
  assert.equal((await w.act({ op: 'subscribers', product: 'acme', list: 'email\nkhông có ai' })).error.code, 'no_addresses');
  assert.equal((await w.act({ op: 'subscribers', product: 'nope', list: 'a@b.vn' })).error.code, 'invalid_request');
  assert.equal((await w.act({ op: 'subscribers', product: 'acme', list: 'x'.repeat(120001) })).error.code, 'invalid_request');
  assert.equal((await w.call('page_action', { request_id: 'r-root', op: 'subscribers', product: 'acme', list: 'a@b.vn' }, {}, { env: {} })).error.code, 'needs_credential');
  await assert.rejects(readFile(join(w.root, 'acme/newsletter/subscribers.csv')), /ENOENT/);
});

// ---------- Đã trả lời ----------

test('reply_done says a Cần bạn card closes only when the dispatcher raised one for that comment', async () => {
  const w = await world({ hub: false });
  const reply = (ref) => w.store.insert('replies', { ref, channel: 'reddit', thread_url: 'https://www.reddit.com/r/selfhosted/comments/abc/x', author_handle: 'u', text: 'Giá?', class: 'money', state: 'needs_person' });
  await reply('R-00000000C1');
  await reply('R-00000000C2');
  await w.store.insert('attention', { key: 'inc:reply:R-00000000C1:money', kind: 'inc-reply', ref: 'R-00000000C1', reason: 'money', raised_at: iso(T0) });
  const carded = await w.act({ op: 'reply_done', ref: 'R-00000000C1' });
  assert.deepEqual([carded.ok, carded.card_closes], [true, true]);
  const quiet = await w.act({ op: 'reply_done', ref: 'R-00000000C2' });
  assert.deepEqual([quiet.ok, quiet.card_closes], [true, false]);
});

// ---------- Search Console without a site ----------

const GSC = JSON.stringify({ type: 'google_oauth', client_id: 'cid', client_secret: 'cs', refresh_token: 'rt-1' });
function google(answer) {
  const asked = [];
  const fetch = async (u, init) => {
    if (String(u).startsWith('https://oauth2.googleapis.com/')) return { ok: true, status: 200, json: async () => ({ access_token: 'at' }) };
    const site = decodeURIComponent(String(u).split('/sites/')[1].split('/')[0]);
    asked.push(site);
    const status = answer(site);
    return { ok: status === 200, status, json: async () => ({ rows: [] }) };
  };
  return { fetch, asked };
}
const gscCall = (w, input) => w.call('gsc_sync', input, {}, { env: { ...w.env, GSC_GOOGLE: GSC } });

test('gsc_sync with no site reads each product site as its domain property', async () => {
  const w2 = await world({ hub: false });
  await w2.act({ op: 'setup', product: { id: 'qua', name: 'Quà biết nói', site: 'https://www.quabietnoi.vn' } });
  const g = google(() => 200);
  w2.hub.fetch = g.fetch;
  const ok = await gscCall(w2, {});
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.sites, ['sc-domain:acme.example', 'sc-domain:quabietnoi.vn']);
  assert.deepEqual([...new Set(g.asked)], ['sc-domain:acme.example', 'sc-domain:quabietnoi.vn']);
  assert.deepEqual([gscProperty('acme.example'), gscProperty('https://www.Acme.example/blog'), gscProperty('not a site'), gscProperty(null)], ['sc-domain:acme.example', 'sc-domain:acme.example', null, null]);
});

test('gsc_sync with no site: one unreadable property is named and skipped; none readable is no_access; no site at all is a quiet skip', async () => {
  const w = await world({ hub: false });
  await w.act({ op: 'setup', product: { id: 'qua', name: 'Quà biết nói', site: 'quabietnoi.vn' } });
  w.hub.fetch = google(site => (site === 'sc-domain:quabietnoi.vn' ? 403 : 200)).fetch;
  const part = await gscCall(w, {});
  assert.deepEqual([part.status, part.no_access], ['ok', ['sc-domain:quabietnoi.vn']]);
  assert.match(part.no_access_message, /không có quyền đọc sc-domain:quabietnoi\.vn/);
  w.hub.fetch = google(() => 403).fetch;
  const none = await gscCall(w, {});
  assert.deepEqual([none.status, none.site], ['no_access', 'sc-domain:acme.example']);
  // No product names a site: nothing to read, and no failure that wakes the Editor.
  const bare = await world({ hub: false });
  await writeFile(join(bare.root, 'products.json'), JSON.stringify({ products: [{ id: 'beta', name: 'Beta' }] }));
  bare.hub.fetch = google(() => 200).fetch;
  const skip = await gscCall(bare, {});
  assert.deepEqual([skip.ok, skip.skipped, skip.reason_code, skip.wake], [true, true, 'no_site', false]);
});

test('gsc_sync: an unreadable library is its own skip; a denied property keeps its query rows; every denied property is named', async () => {
  const w = await world({ hub: false });
  await w.act({ op: 'setup', product: { id: 'qua', name: 'Quà biết nói', site: 'quabietnoi.vn' } });
  const row = (url, query) => ({ url, source: 'gsc', day: '2026-01-01', query, impressions: 1, clicks: 0, position: 1, views: null });
  const post = (ref, url) => w.store.insert('posts', { ref, channel: 'blog-lohi', kind: 'article', state: 'published', revision: 1, body: 'b', url, brief: { keyword: 'k' } });
  await post('P-00000000A1', 'https://quabietnoi.vn/a');
  await post('P-00000000A2', 'https://acme.example/b');
  await w.store.insert('metrics', row('https://quabietnoi.vn/a', 'kept'));
  await w.store.insert('metrics', row('https://acme.example/b', 'replaced'));
  w.hub.fetch = google(site => (site === 'sc-domain:quabietnoi.vn' ? 403 : 200)).fetch;
  const part = await gscCall(w, {});
  assert.equal(part.status, 'ok');
  const left = (await w.store.query('metrics', [])).filter(r => r.query).map(r => r.query);
  assert.deepEqual(left, ['kept'], 'the denied property keeps its rows; the re-read one is replaced');
  w.hub.fetch = google(() => 403).fetch;
  const none = await gscCall(w, {});
  assert.deepEqual(none.sites, ['sc-domain:acme.example', 'sc-domain:quabietnoi.vn']);
  assert.match(none.message, /sc-domain:acme\.example[\s\S]*sc-domain:quabietnoi\.vn/);
  // A library that cannot be read says so, not "no product has a site".
  const lost = await w.call('gsc_sync', {}, {}, { env: { ...w.env, GSC_GOOGLE: GSC, MARKETING_ROOT: join(w.root, 'missing-folder') } });
  assert.deepEqual([lost.ok, lost.skipped, lost.reason_code, lost.wake], [true, true, 'no_library', false]);
});

// ---------- team cards in Cần bạn (the piece's team_waits query) ----------

test('open Cần bạn cards of the team keep Hôm nay from reading healthy; a bad count is refused', async () => {
  const w = await world({ hub: false });
  const empty = await w.view({ view: 'summary', approvals: [] });
  assert.equal(empty.status.code, 'empty');
  const waitsEmpty = await w.view({ view: 'summary', approvals: [], cards: 2 });
  assert.deepEqual([waitsEmpty.status.code, waitsEmpty.status.tone, waitsEmpty.status.args.cards], ['waits', 'wait', 2]);
  await saved(w);
  const quiet = await w.view({ view: 'summary', approvals: [], cards: 0 });
  assert.equal(quiet.status.args?.cards ?? 0, 0);
  const busy = await w.view({ view: 'summary', approvals: [], cards: 3 });
  assert.notEqual(busy.status.code, 'healthy');
  assert.equal(busy.status.args.cards, 3);
  for (const cards of [-1, 1.5]) assert.equal((await w.view({ view: 'summary', approvals: [], cards })).error?.code, 'invalid_request', `cards ${cards}`);
});
