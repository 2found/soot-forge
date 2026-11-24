// Phase 2 of the desk (spec §12): the team and its packs, setup, hubless publishing
// to a site folder and hand-offs, community posts, newsletters, launch packs,
// TikTok links, replies, learning, counting live items, pre-tests and channels
// the product cannot post to. Every path has a happy case and a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { T0, MIN, H, DAY, world, BLOG, XPOST, saved, bundleOf } from './desk-world.mjs';

const iso = (ms) => new Date(ms).toISOString();
const FB = { channel: 'facebook', lang: 'vi', text: 'Chín bộ tiên hiệp, đọc trên Acme.' };
const products = (w, list) => writeFile(join(w.root, 'products.json'), JSON.stringify({ products: list }));
const ACME = { id: 'acme', name: 'Acme Truyện', mark: 'AT', site: 'acme.example', hub_site: 'acme', video_channels: ['acme-video'], accounts: { facebook: 'Trang Acme' } };
const WITH_TARGETS = { ...ACME, targets: [{ kind: 'reddit', sub: 'selfhosted' }, { kind: 'hn' }], newsletter: true, changelog: 'acme/CHANGELOG.md' };
const tile = (v, id) => v.tiles.find(t => t.id === id);
const plan = (it, ch) => it.plan.find(p => p.channel === ch);
const itemOf = async (w, ref, extra = {}) => w.view({ view: 'item', ref, ...extra });
const rows = (w, t) => w.store.data[t] ?? [];

/** A hubless item: blog + X + Facebook, saved as files only, and its bundle (no hub ids, the item's revision). */
async function hublessBundle(w) {
  const s = await w.call('item_save', { product: 'acme', slug: 'tien-hiep', langs: [BLOG], posts: [XPOST, FB] });
  return { s, b: { ref: s.ref, product: 'acme', posts: [
    { channel: 'blog', lang: 'vi', site: 'acme', slug: 'tien-hiep', revision: s.revision, title: BLOG.title },
    { channel: 'x', lang: 'vi', revision: s.revision, text: XPOST.text, link: XPOST.link },
    { channel: 'facebook', lang: 'vi', revision: s.revision, text: FB.text },
  ] } };
}

// ---------- summary: team, abilities, mode, gsc, setup ----------

test('summary names the team and what its packs allow; both are null when the host does not say', async () => {
  const w = await world();
  const piece = { piece: { teams: ['marketing', 'ops'], packs: ['marketing', { id: 'micro-fish' }] } };
  const sum = await w.call('page_view', { view: 'summary', approvals: [] }, piece);
  assert.deepEqual(sum.team, { id: 'marketing' });
  assert.deepEqual(sum.abilities, { micro_fish: true, email: false });
  assert.equal(sum.mode, 'hub');
  assert.deepEqual(sum.gsc, { state: 'off', at: null });
  const bare = await w.view({ view: 'summary', approvals: [] });
  assert.deepEqual([bare.team, bare.abilities], [null, { micro_fish: null, email: null }]);
  await w.store.insert('settings', { key: 'gsc', value: { state: 'ok', at: iso(T0 - 4 * DAY) } });
  assert.equal((await w.view({ view: 'summary' })).gsc.state, 'stale', 'no read in 3 days');
  const hubless = await world({ hub: false });
  assert.equal((await hubless.view({ view: 'summary' })).mode, 'hubless');
});

test('no product yet: the status is setup and every tile is null with why no_posts_yet; setup adds one', async () => {
  const w = await world({ hub: false });
  await rm(join(w.root, 'products.json'));
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.equal(sum.status.code, 'setup');
  assert.ok(sum.tiles.every(t => t.value === null && t.why === 'no_posts_yet'), JSON.stringify(sum.tiles));
  const res = await w.act({ op: 'setup', product: { id: 'gamma', name: 'Gamma', site: 'gamma.dev', langs: ['en'], about: 'Một công cụ tự host.', blog: { dir: 'gamma/site/posts' }, channels: { x: '@gammadev', community: 'r/selfhosted, Hacker News, dev.to', newsletter: true } } });
  assert.deepEqual([res.ok, res.id, res.files, res.site], [true, 'gamma', ['products.json', 'gamma/brand.md'], 'https://gamma.dev']);
  const file = JSON.parse(await readFile(join(w.root, 'products.json'), 'utf8'));
  const g = file.products.find(p => p.id === 'gamma');
  assert.deepEqual(g.targets.map(t => t.kind), ['reddit', 'hn', 'devto']);
  assert.deepEqual([g.site, g.accounts.x, g.newsletter, g.blog.dir], ['https://gamma.dev', '@gammadev', true, 'gamma/site/posts']);
  assert.match(await readFile(join(w.root, 'gamma/brand.md'), 'utf8'), /^# Gamma\n\nMột công cụ tự host\./);
  const after = await w.view({ view: 'summary', approvals: [] });
  assert.notEqual(after.status.code, 'setup');
  const gp = after.products.find(p => p.id === 'gamma');
  assert.deepEqual([gp.blog, gp.blog_dir, gp.langs, gp.targets.map(t => t.label)], ['folder', 'gamma/site/posts', ['en'], ['r/selfhosted', 'Hacker News', 'dev.to']]);
  // The same product again is a replay; a different one under the same id is refused.
  const again = await w.act({ op: 'setup', product: { id: 'gamma', name: 'Gamma', site: 'gamma.dev', langs: ['en'], about: 'Một công cụ tự host.', blog: { dir: 'gamma/site/posts' }, channels: { x: '@gammadev', community: 'r/selfhosted, Hacker News, dev.to', newsletter: true } } });
  assert.equal(again.replayed, true);
  const clash = await w.act({ op: 'setup', product: { id: 'gamma', name: 'Gamma 2' } });
  assert.equal(clash.error.code, 'product_exists');
});

test('setup non-happy: a blog folder outside the library is bad_dir; no library root is needs_credential; an absolute folder inside is kept relative', async () => {
  const w = await world({ hub: false });
  for (const dir of ['/etc', '../outside', '']) {
    const r = await w.act({ op: 'setup', product: { id: 'delta', name: 'Delta', blog: { dir } } });
    assert.equal(r.error?.code, 'bad_dir', dir);
  }
  const bad = await w.act({ op: 'setup', product: { id: 'Delta!', name: 'Delta' } });
  assert.equal(bad.error.code, 'invalid_request');
  const none = await w.call('page_action', { op: 'setup', request_id: 'r-setup-0', product: { id: 'delta', name: 'Delta' } }, {}, { env: {} });
  assert.equal(none.error.code, 'needs_credential');
  const ok = await w.act({ op: 'setup', product: { id: 'delta', name: 'Delta', blog: { dir: join(w.root, 'delta/posts') } } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const file = JSON.parse(await readFile(join(w.root, 'products.json'), 'utf8'));
  assert.equal(file.products.find(p => p.id === 'delta').blog.dir, 'delta/posts');
});

// ---------- hubless: the site folder and hand-offs ----------

test('hubless: one approval writes the blog into the site folder at its slot, Facebook becomes a hand-off, X with no account is left out', async () => {
  const w = await world({ hub: false });
  const { s, b } = await hublessBundle(w);
  assert.equal(s.revision, 1);
  assert.deepEqual(s.blog.map(l => l.local), [true]);
  const pre = await w.call('publish_bundle', b, { hook: 'tool.preflight' }, { env: {} });
  assert.match(pre.preview, /ghi vào thư mục site/);
  assert.match(pre.preview, /Facebook tiếng Việt · \d+ ký tự · bạn đăng tay/);
  const done = await w.call('publish_bundle', b);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.skipped, [{ channel: 'x', lang: 'vi', reason: 'no_account' }]);
  assert.deepEqual(rows(w, 'releases').map(r => [r.channel, r.state, r.outcome?.via]), [['blog', 'scheduled', 'folder'], ['facebook', 'handoff', 'hand']]);
  assert.deepEqual(rows(w, 'bundles')[0].posts.map(p => p.channel), ['blog', 'facebook'], 'the bundle holds only what goes out');
  const before = (await w.view({ view: 'channels' })).rows.find(r => r.product === 'acme').cells.blog;
  assert.deepEqual([before.dir, before.dir_ok], ['acme/site/posts', 'new'], 'a folder not made yet is made at the first write, not an error');
  let it = await itemOf(w, s.ref);
  assert.equal(plan(it, 'x').state, 'no_account');
  assert.deepEqual([plan(it, 'facebook').state, plan(it, 'facebook').via], ['handoff', 'hand']);
  // At its slot release_due writes the post with front matter; written counts as live.
  w.now = Date.parse(rows(w, 'releases')[0].slot_at) + MIN;
  const due = await w.call('release_due', {});
  assert.deepEqual(due.released, [{ ref: s.ref, channel: 'blog', lang: 'vi', state: 'written' }]);
  const md = await readFile(join(w.root, 'acme/site/posts/tien-hiep.md'), 'utf8');
  assert.match(md, /^---\ntitle: "Chín bộ tiên hiệp nên đọc"\ndescription: "Chín bộ đáng đọc, mỗi bộ một lý do\."\nslug: tien-hiep\nlang: vi\ndate: 2026-11-24\nref: MK-[0-9A-Z]{6}\n---\n\nBài viết về chín bộ tiên hiệp\./);
  const replay = await w.call('release_due', {});
  assert.equal(replay.released?.length ?? 0, 0, 'written once: nothing is left to write');
  it = await itemOf(w, s.ref);
  assert.deepEqual([plan(it, 'blog').state, it.stage, it.state], ['written', 'scheduled', 'handoff']);
  const today = await w.view({ view: 'today' });
  const b1 = today.blockers.find(x => x.kind === 'handoff_social');
  assert.deepEqual([b1.id, b1.title_args.n, b1.title_args.channel, b1.do.label_code], ['handoff_social:acme:facebook', 1, 'facebook', 'post_by_hand']);
  const ch = await w.view({ view: 'channels' });
  const acme = ch.rows.find(r => r.product === 'acme');
  assert.deepEqual([acme.cells.blog.state, acme.cells.blog.posted_7d, acme.cells.blog.dir_ok], ['folder', 1, true]);
  // X was not chosen at setup (no account in products.json): the desk says Không dùng, not a missing account.
  assert.deepEqual([acme.cells.facebook.state, acme.cells.facebook.waiting, acme.cells.x.state, acme.cells.x.why], ['by_hand', 1, 'off', 'not_chosen']);
  // The founder posts it by hand and pastes the link; a link that is not Facebook is refused.
  const wrong = await w.act({ op: 'confirm', ref: s.ref, channel: 'facebook', outcome: 'posted', url: 'https://example.com/p/1' });
  assert.equal(wrong.error.code, 'bad_url');
  const ok = await w.act({ op: 'confirm', ref: s.ref, channel: 'facebook', outcome: 'posted', url: 'https://www.facebook.com/acme/posts/123' });
  assert.deepEqual([ok.state, ok.url], ['posted', 'https://www.facebook.com/acme/posts/123']);
  it = await itemOf(w, s.ref);
  assert.deepEqual([it.stage, it.state], ['live', 'posted']);
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.deepEqual([tile(sum, 'published').value, tile(sum, 'published').sub_code, tile(sum, 'published').sub_args], [1, 'published_posts', { posts: 2, channels: 2 }]);
});

test('hubless non-happy: a blog changed after Duyệt is held, not written; a hub id needs the hub; nothing to post is no_channel', async () => {
  const w = await world({ hub: false });
  const { s, b } = await hublessBundle(w);
  await w.call('publish_bundle', b);
  const meta = rows(w, 'library').find(r => r.ref === s.ref).meta;
  await writeFile(join(w.root, meta.dir, 'vi.md'), '---\ntitle: "Đổi tên"\nsummary: ""\nslug: tien-hiep\n---\n\nKhác.\n');
  w.now = Date.parse(rows(w, 'releases')[0].slot_at) + MIN;
  const due = await w.call('release_due', {});
  assert.deepEqual(due.held, [{ ref: s.ref, channel: 'blog', lang: 'vi', reason: 'changed' }]);
  assert.equal(due.needs[0].kind, 'changed');
  assert.equal(existsSync(join(w.root, 'acme/site/posts/tien-hiep.md')), false);
  // Missed: a slot more than 6 hours ago is never written late.
  const w2 = await world({ hub: false });
  const h2 = await hublessBundle(w2);
  await w2.call('publish_bundle', h2.b);
  w2.now = Date.parse(rows(w2, 'releases')[0].slot_at) + 7 * H;
  const late = await w2.call('release_due', {});
  assert.equal(late.held[0].reason, 'missed');
  assert.equal(rows(w2, 'releases')[0].state, 'missed');
  // A hub post id with no hub, and a bundle whose every post is left out.
  const hubId = await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'x', lang: 'vi', id: 'SP-0000000A', revision: 1, text: 'x' }] });
  assert.equal(hubId.error.code, 'needs_credential');
  const x = await w.call('item_save', { product: 'acme', slug: 'chi-x', format: 'social', posts: [XPOST] });
  const none = await w.call('publish_bundle', { ref: x.ref, product: 'acme', posts: [{ channel: 'x', lang: 'vi', revision: x.revision, text: XPOST.text, link: XPOST.link }] });
  assert.equal(none.error.code, 'no_channel');
  const moved = await w.call('publish_bundle', { ref: x.ref, product: 'acme', posts: [{ channel: 'x', lang: 'vi', revision: x.revision, text: 'chữ khác', link: XPOST.link }] });
  assert.equal(moved.error.code, 'moved');
  // Paused: due rows wait, nothing is written.
  const w3 = await world({ hub: false });
  const h3 = await hublessBundle(w3);
  await w3.call('publish_bundle', h3.b);
  await w3.act({ op: 'pause', scope: 'all' });
  w3.now = Date.parse(rows(w3, 'releases')[0].slot_at) + MIN;
  const paused = await w3.call('release_due', {});
  assert.deepEqual([paused.paused, paused.held[0].reason], [true, 'paused']);
  assert.equal(existsSync(join(w3.root, 'acme/site/posts/tien-hiep.md')), false);
});

// ---------- P2-7: a channel the product cannot post to ----------

test('hub: a Facebook post for a product whose page is not connected is left out of the bundle and reads channel_not_connected', async () => {
  const w = await world();
  const s = await saved(w, { posts: [XPOST, FB] });
  const b = await bundleOf(w, s.ref);
  const fb = [...w.hub.social.values()].find(p => p.channel === 'facebook');
  b.posts.push({ channel: 'facebook', lang: 'vi', id: fb.id, revision: fb.revision, text: fb.text, link: null });
  const done = await w.call('publish_bundle', b);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(done.skipped, [{ channel: 'facebook', lang: 'vi', reason: 'channel_not_connected' }]);
  assert.deepEqual(rows(w, 'releases').map(r => r.channel), ['blog', 'x']);
  const it = await itemOf(w, s.ref);
  assert.equal(plan(it, 'facebook').state, 'channel_not_connected');
  assert.equal(it.stage, 'scheduled');
});

// ---------- community ----------

test('community: a Reddit post is one approval, then a hand-off; its link must be a thread in that subreddit and joins the replies watch', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS, { id: 'beta', name: 'Beta', hub_site: 'beta' }]);
  const body = 'I built a self-hosted reader.\n\nFeedback welcome.';
  const s = await w.call('item_save', { product: 'acme', slug: 'self-host', format: 'community', community: { target: 'reddit:selfhosted', title: 'I built a self-hosted novel reader', body, lang: 'en' } });
  assert.deepEqual([s.revision, s.community.target.sub], [1, 'selfhosted']);
  assert.equal(w.hub.calls.filter(c => c[0] === 'cms_save' || c[0] === 'social_queue').length, 0, 'a community post never goes to the hub');
  const b = { ref: s.ref, product: 'acme', posts: [{ channel: 'community', lang: 'en', revision: 1, title: 'I built a self-hosted novel reader', body }] };
  const pre = await w.call('publish_bundle', b, { hook: 'tool.preflight' }, { env: {} });
  assert.match(pre.preview, /Cộng đồng tiếng Anh · r\/selfhosted · bạn đăng tay/);
  const done = await w.call('publish_bundle', b);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(rows(w, 'releases').map(r => [r.channel, r.state]), [['community', 'handoff']]);
  let it = await itemOf(w, s.ref);
  assert.deepEqual([it.stage, it.state, it.community.target.label, it.community.title_max], ['scheduled', 'handoff', 'r/selfhosted', 300]);
  assert.equal(it.community.body, body);
  const today = await w.view({ view: 'today', approvals: [] });
  const bl = today.blockers.find(x => x.kind === 'handoff_community');
  assert.deepEqual([bl.title_args.n, bl.title_args.target, bl.do.label_code], [1, 'r/selfhosted', 'post_by_hand']);
  const ch = await w.view({ view: 'channels' });
  const cell = ch.rows.find(r => r.product === 'acme').cells.community;
  assert.deepEqual([cell.state, cell.targets.map(t => t.label), cell.waiting], ['by_hand', ['r/selfhosted', 'Hacker News'], 1]);
  assert.equal(ch.rows.find(r => r.product === 'beta').cells.community.state, 'off');
  const other = await w.act({ op: 'confirm', ref: s.ref, outcome: 'posted', url: 'https://www.reddit.com/r/programming/comments/abc123/i_built' });
  assert.equal(other.error.code, 'bad_url', 'a thread in another subreddit');
  const ok = await w.act({ op: 'confirm', ref: s.ref, outcome: 'posted', url: 'https://www.reddit.com/r/selfhosted/comments/abc123/i_built?utm=x' });
  assert.deepEqual([ok.state, ok.url, ok.watching], ['posted', 'https://www.reddit.com/r/selfhosted/comments/abc123/i_built', true]);
  const src = rows(w, 'sources').find(r => r.key === `reddit_thread:${s.ref}`);
  assert.deepEqual([src.kind, src.url], ['reddit_thread', 'https://www.reddit.com/r/selfhosted/comments/abc123/i_built']);
  it = await itemOf(w, s.ref);
  assert.deepEqual([it.stage, it.state], ['live', 'posted']);
});

test('community non-happy: a Show HN title over 80 characters, an unknown target, a body that moved since it was saved', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const long = await w.call('item_save', { product: 'acme', slug: 'hn', format: 'community', community: { target: 'hn', title: 'S'.repeat(81), body: 'x' } });
  assert.equal(long.error.code, 'invalid_request');
  assert.match(long.error.message, /80/);
  const unknown = await w.call('item_save', { product: 'acme', slug: 'hn', format: 'community', community: { target: 'reddit:nope', title: 'T', body: 'x' } });
  assert.equal(unknown.error.code, 'invalid_request');
  const s = await w.call('item_save', { product: 'acme', slug: 'hn', format: 'community', community: { target: 'hn', title: 'Show HN: Acme', body: 'We built it.' } });
  const moved = await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'community', lang: s.community.lang, revision: 1, title: 'Show HN: Acme', body: 'Different.' }] });
  assert.equal(moved.error.code, 'moved');
  const hnBad = await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'community', lang: s.community.lang, revision: 1, title: 'Show HN: Acme', body: 'We built it.' }] });
  assert.equal(hnBad.ok, true);
  const bad = await w.act({ op: 'confirm', ref: s.ref, outcome: 'posted', url: 'https://news.ycombinator.com/newest' });
  assert.equal(bad.error.code, 'bad_url');
  const good = await w.act({ op: 'confirm', ref: s.ref, outcome: 'posted', url: 'https://news.ycombinator.com/item?id=4242' });
  assert.deepEqual([good.state, good.url, good.watching], ['posted', 'https://news.ycombinator.com/item?id=4242', undefined]);
});

// ---------- newsletter ----------

test('newsletter: the count of subscribers, never an address; export after Duyệt writes html and txt; sent makes it live', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  await mkdir(join(w.root, 'acme/newsletter'), { recursive: true });
  await writeFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'email,name\nan@mail.test,An\nbinh@mail.test,Bình\n\ncuong@mail.test,Cường\n');
  const n = { subject: 'Tuần này ở Acme', preheader: 'Ba bộ mới', body: 'Chào bạn,\n\n**Ba bộ** mới tuần này: [đọc](https://acme.example/blog).' };
  const s = await w.call('item_save', { product: 'acme', slug: 'ban-tin-w48', format: 'newsletter', newsletter: n });
  assert.equal(s.revision, 1);
  const early = await w.act({ op: 'export', ref: s.ref });
  assert.equal(early.error.code, 'conflict', 'export comes after Duyệt');
  let it = await itemOf(w, s.ref);
  assert.deepEqual([it.newsletter.subscribers, it.newsletter.subject], [3, 'Tuần này ở Acme']);
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.equal(sum.products[0].subscribers, 3);
  for (const v of [it, sum, await w.view({ view: 'channels' })]) assert.doesNotMatch(JSON.stringify(v), /mail\.test/, 'no address leaves the desk');
  const b = { ref: s.ref, product: 'acme', posts: [{ channel: 'newsletter', lang: 'vi', revision: 1, ...n }] };
  const pre = await w.call('publish_bundle', b, { hook: 'tool.preflight' }, { env: {} });
  assert.match(pre.preview, /Bản tin tiếng Việt · bạn gửi/);
  assert.equal((await w.call('publish_bundle', b)).ok, true);
  it = await itemOf(w, s.ref);
  assert.deepEqual([it.state, plan(it, 'newsletter').via, plan(it, 'newsletter').subscribers], ['handoff', 'export', 3]);
  const today = await w.view({ view: 'today', approvals: [] });
  const bl = today.blockers.find(x => x.kind === 'handoff_newsletter');
  assert.deepEqual([bl.title_args.title, bl.do.label_code], ['Tuần này ở Acme', 'send_newsletter']);
  const ex = await w.act({ op: 'export', ref: s.ref });
  assert.deepEqual(ex.files, ['acme/newsletter/out/ban-tin-w48.html', 'acme/newsletter/out/ban-tin-w48.txt']);
  const html = await readFile(join(w.root, ex.files[0]), 'utf8');
  assert.match(html, /<h1>Tuần này ở Acme<\/h1>/);
  assert.match(html, /<strong>Ba bộ<\/strong> mới tuần này: <a href="https:\/\/acme\.example\/blog">đọc<\/a>\./);
  assert.match(await readFile(join(w.root, ex.files[1]), 'utf8'), /Ba bộ mới tuần này: đọc \(https:\/\/acme\.example\/blog\)\./);
  it = await itemOf(w, s.ref);
  assert.deepEqual([it.state, it.newsletter.export.files.length], ['exported', 2]);
  assert.equal((await w.act({ op: 'export', ref: s.ref })).replayed, true);
  // Exported is not sent: Hôm nay keeps the line until the founder says it went out.
  const kept = (await w.view({ view: 'today', approvals: [] })).blockers.find(x => x.kind === 'handoff_newsletter');
  assert.deepEqual([kept.title_code, kept.do.label_code], ['handoff_newsletter_exported', 'open_item']);
  const sent = await w.act({ op: 'confirm', ref: s.ref, outcome: 'sent' });
  assert.equal((await w.view({ view: 'today', approvals: [] })).blockers.find(x => x.kind === 'handoff_newsletter'), undefined, 'sent leaves Hôm nay');
  assert.deepEqual([sent.channel, sent.state], ['newsletter', 'posted']);
  it = await itemOf(w, s.ref);
  assert.deepEqual([it.stage, it.state], ['live', 'posted']);
  // With the email pack the cell sends instead of exporting.
  const ch = await w.call('page_view', { view: 'channels' }, { piece: { packs: ['email'] } });
  assert.deepEqual([ch.rows[0].cells.newsletter.state, ch.rows[0].cells.newsletter.subscribers], ['email', 3]);
  // Past ten addresses (one Nest approval each) the cell exports even with the email pack.
  await writeFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'email\n' + Array.from({ length: 11 }, (_, i) => `p${i}@mail.test`).join('\n') + '\n');
  const big = await w.call('page_view', { view: 'channels' }, { piece: { packs: ['email'] } });
  assert.deepEqual([big.rows[0].cells.newsletter.state, big.rows[0].cells.newsletter.via, big.rows[0].cells.newsletter.subscribers], ['export', 'export', 11]);
});

test('newsletter non-happy: no list is no_list; a newsletter changed after Duyệt is not exported; sent needs a newsletter; the Editor\'s send shows sending', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const ch = await w.view({ view: 'channels' });
  assert.deepEqual([ch.rows[0].cells.newsletter.state, ch.rows[0].cells.newsletter.subscribers], ['no_list', null]);
  const n = { subject: 'Tuần này', body: 'Chào.' };
  const s = await w.call('item_save', { product: 'acme', slug: 'ban-tin', format: 'newsletter', newsletter: n });
  await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'newsletter', lang: 'vi', revision: 1, ...n }] });
  w.now += MIN;
  await w.call('item_save', { ref: s.ref, product: 'acme', newsletter: { sending: true } });
  let it = await itemOf(w, s.ref);
  assert.deepEqual([plan(it, 'newsletter').state, it.state], ['sending', 'sending']);
  await w.call('item_save', { ref: s.ref, product: 'acme', newsletter: { subject: 'Tuần này', body: 'Chào, bản mới.' } });
  it = await itemOf(w, s.ref);
  assert.deepEqual([plan(it, 'newsletter').state, plan(it, 'newsletter').reason], ['held', 'changed']);
  const moved = await w.act({ op: 'export', ref: s.ref });
  assert.equal(moved.error.code, 'moved');
  const notNews = await saved(w);
  const sent = await w.act({ op: 'confirm', ref: notNews.ref, outcome: 'sent' });
  assert.equal(sent.error.code, 'not_found');
  const nobody = await w.call('item_save', { product: 'acme', slug: 'rong', format: 'newsletter', newsletter: { body: 'x' } });
  assert.equal(nobody.error.code, 'invalid_request');
});

// ---------- launch ----------

test('launch: blog + X + Show HN in one approval; after Duyệt the Show HN is its own community hand-off', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const show = { title: 'Show HN: Acme, a reader for long novels', body: 'Hi HN, we built Acme.' };
  const s = await w.call('item_save', { product: 'acme', slug: 'ra-mat', format: 'launch', langs: [BLOG], posts: [XPOST], community: show });
  assert.deepEqual([s.format, s.community.target.kind, s.community.lang], ['launch', 'hn', 'en']);
  const blog = w.hub.cms.get('acme/ra-mat');
  const x = [...w.hub.social.values()][0];
  const b = { ref: s.ref, product: 'acme', posts: [
    { channel: 'blog', lang: 'vi', site: 'acme', slug: 'ra-mat', revision: blog.revision, title: blog.title },
    { channel: 'x', lang: 'vi', id: x.id, revision: x.revision, text: x.text, link: x.link },
    { channel: 'community', lang: 'en', revision: s.revision, ...show },
  ] };
  const done = await w.call('publish_bundle', b);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.match(done.split, /^MK-[0-9A-Z]{6}$/);
  const again = await w.call('publish_bundle', b);
  assert.equal(again.replayed, true);
  assert.equal(rows(w, 'library').filter(r => r.meta?.parent === s.ref).length, 1, 'one Show HN item, however often it is replayed');
  const parent = await itemOf(w, s.ref);
  assert.deepEqual([parent.stage, parent.state, plan(parent, 'community').split], ['scheduled', 'scheduled', done.split]);
  const child = await itemOf(w, done.split);
  assert.deepEqual([child.format, child.stage, child.state, child.community.parent, child.community.title_max], ['community', 'scheduled', 'handoff', s.ref, 80]);
  const today = await w.view({ view: 'today', approvals: [] });
  const hn = today.blockers.filter(x => x.kind === 'handoff_community');
  assert.deepEqual(hn.map(x => [x.ref, x.title_args.target]), [[done.split, 'Hacker News']]);
  const ok = await w.act({ op: 'confirm', ref: done.split, outcome: 'posted', url: 'https://news.ycombinator.com/item?id=99' });
  assert.equal(ok.state, 'posted');
});

test('launch and create non-happy: a launch with no changelog to read, an unknown target; create names a launch and the week\'s newsletter itself', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const paste = await w.act({ op: 'create', product: 'acme', format: 'launch', source: 'paste' });
  assert.equal(paste.error.code, 'invalid_request');
  const t = await w.act({ op: 'create', product: 'acme', format: 'community', topic: 'Reader', target: 'reddit:nope' });
  assert.equal(t.error.code, 'invalid_request');
  const wrongSource = await w.act({ op: 'create', product: 'acme', format: 'blog', topic: 'x', source: 'week' });
  assert.equal(wrongSource.error.code, 'invalid_request');
  const unread = await w.act({ op: 'create', product: 'acme', format: 'launch' });
  assert.equal(unread.error.code, 'invalid_request', 'a CHANGELOG that is not there is said before the Writer is asked');
  await mkdir(join(w.root, 'acme'), { recursive: true });
  await writeFile(join(w.root, 'acme/CHANGELOG.md'), '# Changelog\n\n## [0.9.0] - 2026-11-20\n\n- Đọc offline.\n\n## [0.8.0]\n\n- Cũ.\n');
  const launch = await w.act({ op: 'create', product: 'acme', format: 'launch' });
  assert.deepEqual([launch.ok, launch.channels, launch.target.label], [true, ['blog', 'x', 'community'], 'Hacker News']);
  assert.match(launch.ask_text, /Ra mắt Acme Truyện 0\.9\.0/);
  assert.match(launch.ask_text, /CHANGELOG 0\.9\.0/);
  // The notes ride in the ask: the Writer has no file tool.
  assert.match(launch.ask_text, /Ghi chú phát hành:\n- Đọc offline\.$/);
  assert.doesNotMatch(launch.ask_text, /Cũ/);
  const news = await w.act({ op: 'create', product: 'acme', format: 'newsletter' });
  assert.match(news.ask_text, /Bản tin 2026-W48/);
  const comm = await w.act({ op: 'create', product: 'acme', format: 'community', topic: 'Reader tự host', target: 'reddit:selfhosted' });
  assert.match(comm.ask_text, /Nơi đăng: r\/selfhosted/);
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.equal(sum.products[0].changelog_version, '0.9.0');
  const other = await w.act({ op: 'create', product: 'acme', format: 'community', topic: 'Diễn đàn', target: { kind: 'other', name: 'Diễn đàn Tinh Tế' } });
  assert.equal(other.target.label, 'Diễn đàn Tinh Tế');
});

// ---------- TikTok ----------

test('TikTok confirm fills the Builder\'s row in videos.csv; the item says where it is in the queue; a wrong link is bad_url', async () => {
  const w = await world();
  await writeFile(join(w.root, 'channels/acme-video/metrics/videos.csv'), 'posted,series,slug,script,platform,url,duration_s,views_48h,views_7d\n,hay,ep-1,ep-1-final.mp4,tiktok,,42,,\n');
  await w.call('library_scan', { hub: false });
  const ref = rows(w, 'library').find(r => r.kind === 'campaign' && r.campaign === 'ep-1').ref;
  const it = await itemOf(w, ref);
  assert.deepEqual([it.state, it.queue], ['handoff', { pos: 1, total: 1, next: null }]);
  const bad = await w.act({ op: 'confirm', ref, outcome: 'posted', url: 'https://www.tiktok.com/@acme/photo/123456' });
  assert.equal(bad.error.code, 'bad_url');
  const ok = await w.act({ op: 'confirm', ref, outcome: 'posted', url: 'https://www.tiktok.com/@acme/video/1234567890?lang=vi' });
  assert.deepEqual([ok.row, ok.queue], ['updated', { left: 0, next: null }]);
  const csv = (await readFile(join(w.root, 'channels/acme-video/metrics/videos.csv'), 'utf8')).trim().split('\n');
  assert.deepEqual(csv, ['posted,series,slug,script,platform,url,duration_s,views_48h,views_7d', '2026-11-24,hay,ep-1,ep-1-final.mp4,tiktok,https://www.tiktok.com/@acme/video/1234567890,42,,']);
  const again = await w.act({ op: 'confirm', ref, outcome: 'posted', url: 'https://www.tiktok.com/@acme/video/1234567890' });
  assert.equal(again.row, 'same');
  assert.equal((await itemOf(w, ref)).state, 'posted');
});

// ---------- replies ----------

test('replies: what needs the founder, drafted replies, answered this week; reply_done settles one', async () => {
  const w = await world();
  await w.store.insert('replies', { ref: 'R-00000000A1', channel: 'reddit', thread_url: 'https://www.reddit.com/r/selfhosted/comments/abc/x', reply_url: 'https://www.reddit.com/r/selfhosted/comments/abc/x/c1', author_handle: 'u_one', text: 'Giá bao nhiêu?', class: 'money', state: 'needs_person' });
  await w.store.insert('replies', { ref: 'R-00000000A2', channel: 'reddit', thread_url: 'https://www.reddit.com/r/selfhosted/comments/abc/x', author_handle: 'u_two', text: 'Hay đó', class: 'safe', state: 'answered' });
  await w.store.insert('replies', { ref: 'R-00000000A3', channel: 'reddit', thread_url: 'https://www.reddit.com/r/selfhosted/comments/abc/x', author_handle: 'u_three', text: 'Có app không?', class: 'safe', state: 'open' });
  await w.store.insert('posts', { ref: 'P-00000000B1', kind: 'reply', channel: 'reddit', parent: 'R-00000000A3', title: null, body: 'Có, trên iOS.', state: 'draft', revision: 1 });
  await w.store.insert('attention', { key: 'reply:R-00000000A1', kind: 'reply', ref: 'R-00000000A1', reason: 'money', raised_at: iso(T0) });
  const t1 = await w.view({ view: 'today', approvals: [] });
  assert.deepEqual(t1.replies.need.map(r => [r.ref, r.class, r.author, r.text]), [['R-00000000A1', 'money', 'u_one', 'Giá bao nhiêu?']]);
  assert.deepEqual(t1.replies.drafted.map(r => [r.ref, r.author, r.text]), [['P-00000000B1', 'u_three', 'Có, trên iOS.']]);
  assert.equal(t1.replies.answered_week, 1);
  const done = await w.act({ op: 'reply_done', ref: 'R-00000000A1' });
  assert.deepEqual([done.ok, done.state], [true, 'done']);
  assert.equal(rows(w, 'attention').length, 0);
  const t2 = await w.view({ view: 'today', approvals: [] });
  assert.deepEqual([t2.replies.need.length, t2.replies.answered_week], [0, 2]);
  assert.equal((await w.act({ op: 'reply_done', ref: 'R-00000000A1' })).replayed, true);
  assert.equal((await w.act({ op: 'reply_done', ref: 'R-00000000FF' })).error.code, 'not_found');
  assert.equal((await w.act({ op: 'reply_done', ref: 'R-00000000A3' })).error.code, 'conflict');
  assert.equal((await w.act({ op: 'reply_done', ref: 'MK-AAAAAA' })).error.code, 'invalid_request');
});

// ---------- learning ----------

test('learn: pages and queries from Search Console, which a post already covers, what to make next', async () => {
  const w = await world();
  await saved(w);
  await w.store.insert('settings', { key: 'gsc', value: { state: 'ok', at: iso(T0 - H) } });
  const m = (query, impressions, clicks, position) => w.store.insert('metrics', { url: 'https://acme.example/blog/tien-hiep', source: 'gsc', day: '2026-11-22', query, impressions, clicks, position });
  await m('', 120, 7, 6);
  await m('tiên hiệp nên đọc', 80, 5, 4);
  await m('truyện đô thị hay', 60, 1, 12);
  const t = await w.view({ view: 'today', approvals: [] });
  const L = t.learn;
  assert.deepEqual([L.basis, L.read_at, L.data_to], ['gsc', iso(T0 - H), '2026-11-22']);
  assert.deepEqual(L.top.map(x => [x.product, x.clicks, x.impressions]), [['acme', 7, 120]]);
  assert.deepEqual(L.queries.map(q => [q.query, q.covered, q.position]), [['tiên hiệp nên đọc', true, 4], ['truyện đô thị hay', false, 12]]);
  assert.deepEqual([L.next.topic, L.next.why, L.next.format], ['truyện đô thị hay', 'uncovered_query', 'blog']);
  assert.deepEqual(L.inputs, []);
  // The plan's chosen topic goes first.
  await w.store.insert('settings', { key: 'plan_topic', value: { query: 'top tiên hiệp 2026', awareness: 'problem', at: iso(T0) } });
  assert.deepEqual([(await w.view({ view: 'today' })).learn.next.topic, (await w.view({ view: 'today' })).learn.next.why], ['top tiên hiệp 2026', 'plan_topic']);
});

test('learn non-happy: nothing to learn from says which input is missing; an empty desk has no learn', async () => {
  const w = await world();
  assert.equal((await w.view({ view: 'today' })).learn, null, 'no item yet');
  await saved(w);
  await w.call('library_scan', { hub: false });
  const L = (await w.view({ view: 'today' })).learn;
  assert.deepEqual([L.basis, L.top, L.queries, L.next], [null, [], [], null]);
  assert.deepEqual(L.inputs.map(i => i.code), ['gsc_not_connected', 'no_signals']);
  await w.store.insert('settings', { key: 'gsc', value: { state: 'needs_person', at: iso(T0) } });
  assert.equal((await w.view({ view: 'today' })).learn.inputs[0].code, 'gsc_sign_in');
  const gsc = rows(w, 'settings').find(r => r.key === 'gsc');
  gsc.value = { state: 'ok', at: iso(T0 - 5 * DAY) };
  const stale = (await w.view({ view: 'today' })).learn.inputs;
  assert.deepEqual(stale.map(i => i.code), ['gsc_stale', 'no_signals']);
});

// ---------- counting (P2-2) ----------

test('Đã lên counts this week\'s items; older ones are behind live: "all"', async () => {
  const w = await world({ hub: false });
  for (const [ref, ago] of [['P-00000000C1', DAY], ['P-00000000C2', 10 * DAY]]) await w.store.insert('posts', { ref, kind: 'article', channel: 'blog-acme', title: ref, body: 'x', state: 'published', url: `https://acme.example/${ref}`, revision: 1 });
  rows(w, 'posts').find(p => p.ref === 'P-00000000C1').updated_at = iso(T0 - DAY);
  rows(w, 'posts').find(p => p.ref === 'P-00000000C2').updated_at = iso(T0 - 10 * DAY);
  const c = await w.view({ view: 'content' });
  assert.deepEqual([c.stages.live.count, c.stages.live.sub.week, c.older_live], [1, 1, 1]);
  assert.deepEqual(c.items.filter(i => i.stage === 'live').map(i => i.ref), ['P-00000000C1']);
  const all = await w.view({ view: 'content', stage: 'live', live: 'all' });
  assert.deepEqual([all.items.map(i => i.ref), all.older_live], [['P-00000000C1', 'P-00000000C2'], 1], 'the count stays so the page can offer the way back');
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.equal(tile(sum, 'published').value, 1);
  const bad = await w.view({ view: 'content', live: 'some' });
  assert.equal(bad.error.code, 'invalid_request');
});

// ---------- item: revision and pre-test ----------

test('item: the revision moves with the words; a pre-test holds for its revision; a team without Micro Fish has none', async () => {
  const w = await world();
  const s = await saved(w);
  const same = await saved(w);
  assert.deepEqual([s.revision, same.revision], [1, 1], 'the same words are the same revision');
  await w.call('item_save', { ref: s.ref, product: 'acme', pretest: { state: 'done', verdict: 'go', n: 40, score: 7.46, reasons: ['Rõ ràng', ' '] } });
  let it = await itemOf(w, s.ref);
  assert.deepEqual([it.revision, it.pretest.verdict, it.pretest.score, it.pretest.reasons, it.pretest.revision, it.pretest.stale], [1, 'go', 7.5, ['Rõ ràng'], 1, undefined]);
  const moved = await saved(w, { langs: [{ ...BLOG, body: BLOG.body + '\n\nThêm một đoạn.' }] });
  assert.equal(moved.revision, 2);
  it = await itemOf(w, s.ref);
  assert.deepEqual([it.revision, it.pretest.stale], [2, true]);
  const none = await w.call('page_view', { view: 'item', ref: s.ref }, { piece: { packs: ['marketing'] } });
  assert.deepEqual(none.pretest, { state: 'unavailable' });
  const bad = await w.call('item_save', { ref: s.ref, product: 'acme', pretest: { state: 'maybe' } });
  assert.equal(bad.error.code, 'invalid_request');
  const badScore = await w.call('item_save', { ref: s.ref, product: 'acme', pretest: { state: 'done', score: 11 } });
  assert.equal(badScore.error.code, 'invalid_request');
});

test('channels: every product row has community and newsletter cells; a channel view takes them as keys', async () => {
  const w = await world();
  const ch = await w.view({ view: 'channels' });
  for (const r of ch.rows) assert.deepEqual([r.cells.community.state, r.cells.newsletter.state], ['off', 'off']);
  const one = await w.view({ view: 'channel', key: 'acme:community' });
  assert.equal(one.cell.channel, 'community');
  const bad = await w.view({ view: 'channel', key: 'acme:mastodon' });
  assert.equal(bad.error.code, 'invalid_request');
});

test('stop takes back an exported newsletter: nothing is left to send', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  await mkdir(join(w.root, 'acme/newsletter'), { recursive: true });
  await writeFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'email\na@mail.test\n');
  const n = { subject: 'S', body: 'B' };
  const s = await w.call('item_save', { product: 'acme', slug: 'bt', format: 'newsletter', newsletter: n });
  await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'newsletter', lang: 'vi', revision: 1, ...n }] });
  await w.act({ op: 'export', ref: s.ref });
  const st = await w.act({ op: 'stop', ref: s.ref });
  assert.equal(st.stopped, 1);
  assert.equal(rows(w, 'releases')[0].state, 'stopped');
  const sent = await w.act({ op: 'confirm', ref: s.ref, outcome: 'sent' });
  assert.equal(sent.error.code, 'not_found');
});

test('hub mode with a site-folder blog: the blog never goes to the hub, release_due writes it into blog.dir; with no library root it waits', async () => {
  const w = await world();
  await products(w, [{ ...ACME, blog: { dir: 'acme/www/posts' } }]);
  const s = await saved(w);
  assert.equal(w.hub.calls.filter(c => c[0] === 'cms_save').length, 0, 'the folder blog stays off the hub');
  assert.equal(s.blog[0].local, true);
  const x = [...w.hub.social.values()][0];
  const b = { ref: s.ref, product: 'acme', posts: [
    { channel: 'blog', lang: 'vi', site: 'acme', slug: 'tien-hiep', revision: s.revision, title: BLOG.title },
    { channel: 'x', lang: 'vi', id: x.id, revision: x.revision, text: x.text, link: x.link },
  ] };
  const done = await w.call('publish_bundle', b);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual(rows(w, 'releases').map(r => [r.channel, r.state, r.outcome?.via ?? null]), [['blog', 'scheduled', 'folder'], ['x', 'scheduled', null]]);
  w.now = Date.parse(rows(w, 'releases')[0].slot_at) + MIN;
  const noRoot = await w.call('release_due', {}, {}, { env: { ...w.env, MARKETING_ROOT: undefined } });
  assert.equal(noRoot.folder, 'needs_root');
  assert.equal(rows(w, 'releases')[0].state, 'scheduled');
  const due = await w.call('release_due', {});
  assert.ok(due.released.some(r => r.channel === 'blog' && r.state === 'written'), JSON.stringify(due));
  assert.match(await readFile(join(w.root, 'acme/www/posts/tien-hiep.md'), 'utf8'), /^---\ntitle: "Chín bộ tiên hiệp nên đọc"/);
  assert.equal(w.hub.calls.filter(c => c[0] === 'cms_publish').length, 0);
  // X follows a blog the folder holds as it follows one the hub posted.
  w.now = Date.parse(rows(w, 'releases').find(r => r.channel === 'x').slot_at) + MIN;
  const xs = await w.call('release_due', {});
  assert.deepEqual(xs.released.map(r => [r.channel, r.state]), [['x', 'approved']]);
  const ch = await w.view({ view: 'channels' });
  assert.deepEqual([ch.rows[0].cells.blog.state, ch.rows[0].cells.blog.dir], ['folder', 'acme/www/posts']);
});

// ---------- review fixes ----------

test('a re-approved launch: the blog stays at the hub once products are indexed; the Show HN item takes the new words and the old hand-off is replaced', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  await w.call('library_scan', { hub: false });
  const show = { title: 'Show HN: Acme, a reader for long novels', body: 'Hi HN, we built Acme.' };
  const s = await w.call('item_save', { product: 'acme', slug: 'ra-mat', format: 'launch', langs: [BLOG], posts: [XPOST], community: show });
  const blog = w.hub.cms.get('acme/ra-mat');
  const x = [...w.hub.social.values()][0];
  const parts = (c, rev) => ({ ref: s.ref, product: 'acme', posts: [
    { channel: 'blog', lang: 'vi', site: 'acme', slug: 'ra-mat', revision: blog.revision, title: blog.title },
    { channel: 'x', lang: 'vi', id: x.id, revision: x.revision, text: x.text, link: x.link },
    { channel: 'community', lang: 'en', revision: rev, ...c },
  ] });
  const first = await w.call('publish_bundle', parts(show, s.revision));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.notEqual(rows(w, 'releases').find(r => r.channel === 'blog').outcome?.via, 'folder', 'an indexed product with no blog setting still posts through the hub');
  const show2 = { title: 'Show HN: Acme, a reader for very long novels', body: 'Hi HN, we built Acme. Now with offline reading.' };
  const s2 = await w.call('item_save', { ref: s.ref, product: 'acme', format: 'launch', community: show2 });
  const second = await w.call('publish_bundle', parts(show2, s2.revision));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.split, first.split, 'the same Show HN item');
  const child = await itemOf(w, first.split);
  assert.deepEqual([child.community.title, child.community.body, child.state], [show2.title, show2.body, 'handoff']);
  const hn = rows(w, 'releases').filter(r => r.channel === 'community');
  assert.deepEqual(hn.map(r => r.state).sort(), ['handoff', 'superseded'], 'the old words are no longer the founder\'s to post');
});

test('confirm by hand: a replay keeps its answer, Hacker News keeps only the id, a replayed not_posted is not an error', async () => {
  const w = await world({ hub: false });
  await products(w, [{ ...ACME, accounts: { facebook: 'Trang Acme', x: '@acme' } }]);
  const { s, b } = await hublessBundle(w);
  const done = await w.call('publish_bundle', b);
  assert.equal(done.ok, true, JSON.stringify(done));
  const url = 'https://x.com/acme/status/1234567890';
  const one = await w.act({ op: 'confirm', ref: s.ref, channel: 'x', outcome: 'posted', url });
  assert.deepEqual([one.channel, one.state], ['x', 'posted']);
  const again = await w.act({ op: 'confirm', ref: s.ref, outcome: 'posted', url: `${url}?s=20` });
  assert.deepEqual([again.channel, again.already], ['x', true], 'the replay is not recorded on the Facebook row');
  assert.equal(rows(w, 'releases').find(r => r.channel === 'facebook').state, 'handoff');
  const back = await w.act({ op: 'confirm', ref: s.ref, channel: 'facebook', outcome: 'not_posted' });
  assert.equal(back.state, 'draft');
  const replay = await w.act({ op: 'confirm', ref: s.ref, channel: 'facebook', outcome: 'not_posted' });
  assert.deepEqual([replay.state, replay.already], ['draft', true]);

  const h = await world();
  await products(h, [WITH_TARGETS]);
  const c = await h.call('item_save', { product: 'acme', slug: 'show', format: 'community', community: { target: 'hn', title: 'Show HN: Acme', body: 'Hi HN.', lang: 'en' } });
  assert.equal(c.community.target.kind, 'hn');
  const r = await h.call('publish_bundle', { ref: c.ref, product: 'acme', posts: [{ channel: 'community', lang: 'en', revision: 1, title: 'Show HN: Acme', body: 'Hi HN.' }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ok = await h.act({ op: 'confirm', ref: c.ref, outcome: 'posted', url: 'https://news.ycombinator.com/item?id=4242&utm_source=x' });
  assert.equal(ok.url, 'https://news.ycombinator.com/item?id=4242');
});

test('item_save by ref needs no slug; a heading right above its text still exports as a heading', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const s = await w.call('item_save', { product: 'acme', slug: 'ban-tin', format: 'newsletter', newsletter: { subject: 'Tuần này', body: '## Mới\nBa bộ mới.' } });
  const pt = await w.call('item_save', { ref: s.ref, product: 'acme', pretest: { state: 'asked' } });
  assert.equal(pt.ok ?? true, true, JSON.stringify(pt));
  assert.equal(rows(w, 'library').find(r => r.meta?.ref === s.ref).meta.pretest.state, 'asked');
  await mkdir(join(w.root, 'acme/newsletter'), { recursive: true });
  await writeFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'email\na@mail.test\n');
  const b = await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'newsletter', lang: 'vi', revision: s.revision, subject: 'Tuần này', body: '## Mới\nBa bộ mới.' }] });
  assert.equal(b.ok, true, JSON.stringify(b));
  const ex = await w.act({ op: 'export', ref: s.ref });
  const html = await readFile(join(w.root, ex.files[0]), 'utf8');
  assert.match(html, /<h3>Mới<\/h3>\n<p>Ba bộ mới\.<\/p>/);
});
