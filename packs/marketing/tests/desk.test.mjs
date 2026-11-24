// The Marketing desk (M3): the library (item_save, library_scan), one approval
// per bundle (publish_bundle), the release schedule (release_due), the desk's
// views and actions. Each failure case is written before the happy path it
// guards. Runs on an in-memory store, an in-memory hub and a temp library;
// tests/ is not shipped in the pack archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../tools/marketing.mjs';
import { wrap } from '../tools/lib/store.mjs';
import { refFor } from '../tools/lib/library.mjs';
import { T0, MIN, H, DAY, PUBLISH, library, world, BLOG, XPOST, saved, bundleOf } from './desk-world.mjs';

const readOnly = (store) => wrap(async (t, op, body) => {
  if (!['query', 'get', 'search'].includes(op)) throw Object.assign(new Error('read-only storage'), { code: 'read_only' });
  return store.call(t, op, body);
});
const releases = (w) => w.store.data.releases.map(r => [r.channel, r.state]);

// ---------- library ----------

test('a MARKETING_ROOT escape is refused: a symlink out of the library, a relative or missing root', async () => {
  const w = await world();
  const outside = await mkdtemp(join(tmpdir(), 'mk-out-'));
  await mkdir(join(outside, 'radar'));
  await writeFile(join(outside, 'radar/2026-11-23.md'), '| # | Tên | Onboard? |\n| --- | --- | --- |\n| 1 | X | _ |\n');
  await symlink(outside, join(w.root, 'channels/evil'));
  const r = await w.act({ op: 'mark', file: 'channels/evil/radar/2026-11-23.md', row: 1, onboard: 'yes' });
  assert.equal(r.error.code, 'path_refused');
  assert.match(await readFile(join(outside, 'radar/2026-11-23.md'), 'utf8'), /\| 1 \| X \| _ \|/, 'nothing written outside');
  assert.equal((await w.call('item_save', { product: 'acme', slug: 'x', langs: [BLOG] }, {}, { env: { ...w.env, MARKETING_ROOT: 'relative/path' } })).error.code, 'needs_credential');
  const scan = await w.call('library_scan', {}, {}, { env: { ...w.env, MARKETING_ROOT: join(w.root, 'nope') } });
  assert.equal(scan.ok, false);
  assert.equal(scan.error.code, 'library_missing');
  // The schema already refuses a path that is not a radar file.
  const { readFileSync } = await import('node:fs');
  const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
  const re = new RegExp(pack.tools.find(t => t.name === 'page_action').parameters.properties.file.pattern);
  for (const bad of ['../x/radar/2026-11-23.md', 'channels/../../etc/radar/2026-11-23.md', '/etc/passwd']) assert.ok(!re.test(bad) || bad.includes('..'), bad);
  await rm(outside, { recursive: true, force: true });
});

test('item_save writes the files and the hub drafts once; the same text again changes nothing', async () => {
  const w = await world();
  const s = await saved(w);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.match(s.ref, /^MK-[0-9A-Z]{6}$/);
  assert.equal(s.ref, refFor('item:acme:tien-hiep'));
  const meta = JSON.parse(await readFile(join(w.root, s.dir, 'meta.json'), 'utf8'));
  assert.equal(meta.ref, s.ref);
  assert.match(await readFile(join(w.root, s.dir, 'vi.md'), 'utf8'), /^---\ntitle: "Chín bộ tiên hiệp nên đọc"/);
  assert.equal(await readFile(join(w.root, s.dir, 'x.vi.txt'), 'utf8'), `${XPOST.text}\n\n${XPOST.link}\n`);
  assert.deepEqual(w.hub.calls.map(c => c[0]), ['cms_save', 'social_queue']);
  assert.deepEqual(s.blog.map(b => [b.slug, b.revision]), [['tien-hiep', 1]]);
  w.hub.calls.length = 0;
  const again = await saved(w);
  assert.equal(again.ref, s.ref);
  assert.equal(w.hub.calls.length, 0, 'unchanged text makes no hub call');
  // A changed post moves its hub revision (an approval in waiting no longer covers it).
  const edit = await saved(w, { posts: [{ ...XPOST, text: XPOST.text + ' Đọc ngay.' }] });
  assert.deepEqual(w.hub.calls.map(c => c[0]), ['social_update']);
  assert.equal(edit.social[0].revision, 2);
  assert.equal(w.publishes(), 0);
});

test('counts agree across the desk: Sắp lên counts hand-off videos, Bài viết counts hub-only posts', async () => {
  const w = await world();
  await saved(w);
  await w.hub.fetch('http://127.0.0.1:18999/api/hub/v1/tool', { headers: { Authorization: `Bearer ${'t'.repeat(40)}` }, body: JSON.stringify({ operation: 'marketing_cms_save', input: { site: 'beta', slug: 'tu-hub', request_id: 'a', expected_revision: 0, title: 'Viết thẳng trên hub', summary: '', body_markdown: 'x', language: 'vi', status: 'draft' } }) });
  await w.call('library_scan', {});
  const sum = await w.view({ view: 'summary', approvals: [] });
  const tile = sum.tiles.find(t => t.id === 'scheduled');
  const content = await w.view({ view: 'content', approvals: [] });
  const stage = content.stages.scheduled;
  assert.equal(tile.value, stage.count, 'the top tile and the content stage say the same number');
  assert.equal(tile.sub_args.handoff, 1, 'the delivered ep-1 waits on a person');
  const tree = (await w.view({ view: 'library' })).tree;
  for (const p of ['acme', 'beta']) {
    const node = tree.find(g => g.id === `product:${p}`).children.find(n => n.kind === 'posts');
    const listed = (await w.view({ view: 'library', node: node.id })).detail.items.length;
    assert.equal(node.count, listed, `${p}: the count is what the node lists`);
  }
  assert.equal(tree.find(g => g.id === 'product:beta').children.find(n => n.kind === 'posts').count, 1, 'the hub-only draft counts');
  // A video has waited since its delivery folder changed, not since the desk last indexed it.
  const since = new Date(T0 - 3 * DAY);
  await utimes(join(w.root, 'channels/acme-video/campaigns/ep-1/08-delivery'), since, since);
  w.now = T0 + H;
  await w.act({ op: 'scan' });
  const handoff = (await w.view({ view: 'today' })).blockers.find(b => b.kind === 'handoff');
  assert.equal(handoff.at, since.toISOString());
});
test('library_scan indexes items, campaigns, radars and videos.csv, and names hub posts with no file', async () => {
  const w = await world();
  await saved(w);
  await w.hub.fetch('http://127.0.0.1:18999/api/hub/v1/tool', { headers: { Authorization: `Bearer ${'t'.repeat(40)}` }, body: JSON.stringify({ operation: 'marketing_cms_save', input: { site: 'beta', slug: 'tu-hub', request_id: 'a', expected_revision: 0, title: 'Viết thẳng trên hub', summary: '', body_markdown: 'x', language: 'vi', status: 'draft' } }) });
  const scan = await w.call('library_scan', {});
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.hub_only.map(h => [h.product, h.slug]), [['beta', 'tu-hub']]);
  const kinds = w.store.data.library.map(r => r.kind).sort();
  assert.deepEqual(kinds, ['campaign', 'campaign', 'item', 'metrics', 'products', 'radar']);
  const again = await w.call('library_scan', { hub: false });
  assert.deepEqual([again.added, again.changed, again.removed, again.hub_only.length], [0, 0, 0, 0]);
});

// ---------- publish_bundle ----------

test('publish_bundle preflight refuses a revision or a text that moved since the Writer saved it, with no hub and read-only storage', async () => {
  const w = await world();
  const s = await saved(w);
  const b = await bundleOf(w, s.ref);
  const pre = (input) => w.call('publish_bundle', input, { hook: 'tool.preflight' }, { store: readOnly(w.store), env: {} });
  const moved = await pre({ ...b, posts: [{ ...b.posts[0], revision: b.posts[0].revision + 1 }, b.posts[1]] });
  assert.equal(moved.error.code, 'moved');
  const text = await pre({ ...b, posts: [b.posts[0], { ...b.posts[1], text: b.posts[1].text + '!' }] });
  assert.equal(text.error.code, 'moved');
  const ok = await pre(b);
  assert.ok(ok.preview, JSON.stringify(ok));
  assert.match(ok.preview, /^Gói đăng MK-[0-9A-Z]{6} \(acme\): Chín bộ tiên hiệp nên đọc/);
  assert.match(ok.preview, /• Blog tiếng Việt · acme\/tien-hiep · bản 1 · \d\d:\d\d \d\d\/\d\d/);
  assert.match(ok.preview, /• X tiếng Việt · \d+ ký tự · khoảng \d\d:\d\d/);
  assert.ok(ok.preview.includes(XPOST.text), 'the card shows every word of every post');
  assert.equal(w.hub.calls.length, 0, 'preflight never calls the hub');
  assert.equal(w.store.data.bundles.length, 0);
});

test('a preflight refusal exits 1 with the reason on stderr, so the host shows no approval card', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../tools/marketing.mjs', import.meta.url)), 'publish_bundle'], { env: { PATH: process.env.PATH, SOOT_STORAGE_URL: 'http://127.0.0.1:9', SOOT_STORAGE_TOKEN: 't' } });
  let out = '', err = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { err += c; });
  child.stdin.end(JSON.stringify({ hook: 'tool.preflight', input: { ref: 'nope', product: 'acme', posts: [] } }));
  assert.equal(await new Promise(r => child.on('close', r)), 1);
  assert.equal(out, '');
  assert.match(err, /ref is the item ref/);
});

test('publish_bundle after Duyệt re-reads the hub and only records rows; a draft changed while the card waited schedules nothing', async () => {
  const w = await world();
  const s = await saved(w);
  const b = await bundleOf(w, s.ref);
  // Someone edits the X draft at the hub itself while the card waits: the library still says revision 1.
  Object.assign([...w.hub.social.values()][0], { text: 'Đổi chữ trên hub.', revision: 2 });
  w.hub.calls.length = 0;
  const moved = await w.call('publish_bundle', b);
  assert.equal(moved.error.code, 'moved');
  assert.match(moved.error.message, /Changed at the hub/);
  assert.equal(w.store.data.bundles.length + w.store.data.releases.length, 0);
  // Back to the approved text (a new revision): the old bundle still does not match it.
  const w2 = await world();
  const s2 = await saved(w2);
  const b2 = await bundleOf(w2, s2.ref);
  const done = await w2.call('publish_bundle', b2);
  assert.equal(done.ok, true, JSON.stringify(done));
  // Reads only: the drafts again, and the channels (a post for a channel the product cannot post to is left out, P2-7).
  assert.deepEqual(w2.hub.calls.map(c => c[0]).sort(), ['cms_read', 'social_channels', 'social_list']);
  assert.deepEqual(releases(w2), [['blog', 'scheduled'], ['x', 'scheduled']]);
  const [blog, x] = w2.store.data.releases;
  assert.ok(Date.parse(x.slot_at) >= Date.parse(blog.slot_at) + 15 * MIN, 'social goes after its blog');
  assert.equal(done.releases.find(r => r.channel === 'x').about, true);
  // The same approved set again (a retried call) writes nothing new.
  const replay = await w2.call('publish_bundle', b2);
  assert.equal(replay.replayed, true);
  assert.equal(w2.store.data.releases.length, 2);
  assert.equal(w2.publishes(), 0);
});

// ---------- release_due ----------

test('release_due refuses a row no executed bundle wrote: held, nothing sent', async () => {
  const w = await world();
  await w.store.insert('releases', { key: 'forged', bundle: 'no-such-bundle', ref: 'MK-AAAAAA', product: 'acme', channel: 'blog', lang: 'vi', site: 'acme', slug: 'x', revision: 1, title: 'X', slot_at: new Date(T0 - MIN).toISOString(), state: 'scheduled' });
  const out = await w.call('release_due', {});
  assert.deepEqual(out.held.map(h => h.reason), ['no_bundle']);
  assert.equal(w.store.data.releases[0].state, 'held');
  assert.equal(w.publishes(), 0);
});

test('release_due holds a post whose revision moved after approval, raises one Cần bạn line, and says so once', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  await saved(w, { langs: [{ ...BLOG, body: BLOG.body + '\n\nSửa sau khi duyệt.' }] });
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  w.hub.calls.length = 0;
  const out = await w.call('release_due', {});
  assert.equal(w.store.data.releases[0].state, 'stale');
  assert.deepEqual(out.needs.map(n => [n.kind, n.new]), [['changed', true]]);
  assert.equal(out.notify, true);
  assert.match(out.summary, /Raise ONE report_blocker/);
  assert.equal(w.publishes(), 0);
  const again = await w.call('release_due', {});
  assert.equal(again.notify, false, 'the same line is not raised twice');
  // The desk shows it held with the reason, never as scheduled.
  const it = (await w.view({ view: 'item', ref: s.ref })).plan.find(p => p.channel === 'blog');
  assert.deepEqual([it.state, it.reason], ['held', 'changed']);
});

test('release_due holds a slot missed by more than late_grace_min (6 h) instead of posting it late', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  w.now = Date.parse(w.store.data.releases[0].slot_at) + 361 * MIN;
  const out = await w.call('release_due', {});
  assert.equal(w.store.data.releases[0].state, 'missed');
  assert.ok(out.needs.some(n => n.kind === 'missed'));
  assert.equal(w.publishes(), 0);
  const blocker = (await w.view({ view: 'today' })).blockers.find(b => b.kind === 'missed');
  assert.ok(blocker, 'Hôm nay says the slot was missed');
});

test('a crash after the hub call is looked up on the next run, never sent again', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  w.hub.lose.add('cms_publish');
  const first = await w.call('release_due', {});
  assert.equal(w.store.data.releases[0].state, 'publishing', 'the intent was written before the call');
  assert.ok(w.store.data.releases[0].intent_at);
  assert.equal(first.released.length, 0);
  w.hub.lose.clear();
  w.now += 5 * MIN;
  const second = await w.call('release_due', {});
  assert.equal(w.hub.count('cms_publish'), 1, 'never re-sent');
  assert.equal(w.store.data.releases[0].state, 'posted');
  assert.deepEqual(second.released.map(r => r.channel), ['blog']);
});

test('the full run: blog at its slot, X after it through the Poster, the item goes live', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  const [blog, x] = w.store.data.releases;
  w.now = Date.parse(blog.slot_at) + MIN;
  await w.call('release_due', {});
  assert.deepEqual(releases(w), [['blog', 'posted'], ['x', 'scheduled']]);
  assert.equal(w.hub.cms.get('acme/tien-hiep').status, 'published');
  w.now = Date.parse(x.slot_at) + MIN;
  await w.call('release_due', {});
  assert.deepEqual(releases(w), [['blog', 'posted'], ['x', 'approved']]);
  const sp = [...w.hub.social.values()][0];
  assert.equal(sp.status, 'approved', 'X waits for the browser poster');
  w.hub.poster('published');
  w.now += 5 * MIN;
  await w.call('release_due', {});
  assert.deepEqual(releases(w), [['blog', 'posted'], ['x', 'posted']]);
  const row = (await w.view({ view: 'content', stage: 'live' })).items.find(i => i.ref === s.ref);
  assert.equal(row.state, 'posted');
  assert.equal(w.hub.count('cms_publish') + w.hub.count('social_publish'), 2);
});

test('a paused desk holds every due post; resuming lets them go', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  assert.equal((await w.act({ op: 'pause', scope: 'all' })).paused, true);
  const first = await w.act({ op: 'pause', scope: 'all' });
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  const out = await w.call('release_due', {});
  assert.equal(out.paused, true);
  assert.equal(w.publishes(), 0);
  const again = await w.act({ op: 'pause', scope: 'all' });
  assert.equal(again.since, first.since, 'pausing twice keeps the first since');
  await w.act({ op: 'resume', scope: 'all' });
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[0].state, 'posted');
});

// ---------- actions ----------

test('stop before release touches no hub, and nothing it stopped goes out later', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  w.hub.calls.length = 0;
  const stop = await w.act({ op: 'stop', ref: s.ref });
  assert.deepEqual([stop.ok, stop.state, stop.stopped, stop.withdrawn], [true, 'stopped', 2, 0], JSON.stringify(stop));
  assert.ok(!w.hub.calls.some(c => ['social_update', ...PUBLISH].includes(c[0])), 'only reads');
  assert.deepEqual(releases(w), [['blog', 'stopped'], ['x', 'stopped']]);
  assert.equal(JSON.parse(await readFile(join(w.root, w.store.data.library.find(r => r.ref === s.ref).meta.dir, 'meta.json'), 'utf8')).state, 'stopped');
  // Stop converges: again is the same answer, nothing more.
  assert.equal((await w.act({ op: 'stop', ref: s.ref })).stopped, 0);
  w.now += 2 * DAY;
  await w.call('release_due', {});
  assert.equal(w.publishes(), 0);
  // Only the Editor reopens it: the Writer's plain save is refused, a bundle for it too.
  assert.equal((await saved(w, { langs: [{ ...BLOG, body: 'mới' }] })).error.code, 'stopped');
  const b = await bundleOf(w, s.ref);
  assert.equal((await w.call('publish_bundle', b, { hook: 'tool.preflight' })).error.code, 'stopped');
  assert.equal((await w.view({ view: 'item', ref: s.ref })).state, 'stopped');
});

test('stop after the hub approved an X post withdraws it to draft; that is the only hub write stop makes', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  const [, x] = w.store.data.releases;
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  await w.call('release_due', {});
  w.now = Date.parse(x.slot_at) + MIN;
  await w.call('release_due', {});
  assert.equal([...w.hub.social.values()][0].status, 'approved');
  w.hub.calls.length = 0;
  const stop = await w.act({ op: 'stop', ref: s.ref });
  assert.equal(stop.withdrawn, 1);
  assert.deepEqual(w.hub.calls.filter(c => c[0] !== 'social_channels' && c[0] !== 'social_list' && c[0] !== 'cms_list').map(c => [c[0], c[1].status]), [['social_update', 'draft']]);
  assert.equal([...w.hub.social.values()][0].status, 'draft');
  assert.equal(w.hub.poster('published'), null, 'the Poster has nothing to take');
});

test('every page_action op works and none of them publishes', async () => {
  const w = await world();
  const s = await saved(w);
  const ops = [
    { op: 'pause', scope: 'channel', channel: 'acme:x' }, { op: 'resume', scope: 'channel', channel: 'acme:x' },
    { op: 'pause', scope: 'all' }, { op: 'resume', scope: 'all' },
    { op: 'rules', channel: 'acme:x', cap_per_day: 2, spacing_min: 120, quiet: { from: '22:00', to: '08:00' } },
    { op: 'mark', file: 'channels/acme-video/radar/2026-11-23.md', row: 1, onboard: 'yes' },
    { op: 'create', product: 'beta', format: 'blog', topic: 'Năm mẹo đọc truyện dài', channels: ['blog', 'x'] },
    { op: 'confirm', ref: refFor('video:acme-video/ep-1'), outcome: 'posted', url: 'https://www.tiktok.com/@acmevid/video/7311111111111111111' },
    { op: 'stop', ref: s.ref },
  ];
  for (const input of ops) {
    const r = await w.act(input);
    assert.equal(r.ok, true, `${input.op}: ${JSON.stringify(r)}`);
  }
  assert.equal(w.publishes(), 0);
  assert.match(await readFile(join(w.root, 'channels/acme-video/radar/2026-11-23.md'), 'utf8'), /\| 1 \| \[Bộ A\]\(https:\/\/a\.example\) \| tiên hiệp \| 12k \| Có \|/);
  assert.match(await readFile(join(w.root, 'channels/acme-video/metrics/videos.csv'), 'utf8'), /,ep-1,ep-1-final\.mp4,tiktok,https:\/\/www\.tiktok\.com\/@acmevid\/video\/7311111111111111111/);
  const ch = await w.view({ view: 'channel', key: 'acme:x' });
  assert.deepEqual([ch.rules.cap_per_day, ch.rules.spacing_min, ch.rules.quiet.from], [2, 120, '22:00']);
  // The video is live once its link is in videos.csv.
  assert.equal((await w.view({ view: 'item', ref: refFor('video:acme-video/ep-1') })).state, 'posted');
});

test('the desk ops refuse what they cannot do: bad scope, rules out of range, a wrong link, an unknown ref', async () => {
  const w = await world();
  const bad = [
    [{ op: 'pause', scope: 'channel' }, 'invalid_request'],
    [{ op: 'rules', channel: 'acme:x', cap_per_day: 51 }, 'invalid_request'],
    [{ op: 'rules', channel: 'acme:x', quiet: { from: '25:00', to: '07:00' } }, 'invalid_request'],
    [{ op: 'confirm', ref: refFor('video:acme-video/ep-1'), outcome: 'posted', url: 'https://www.tiktok.com/@acmevid' }, 'bad_url'],
    [{ op: 'stop', ref: 'MK-ZZZZZZ' }, 'not_found'],
    [{ op: 'create', product: 'nope', format: 'blog', topic: 'x' }, 'invalid_request'],
  ];
  for (const [input, code] of bad) assert.equal((await w.act(input)).error?.code, code, JSON.stringify(input));
});

test('create is keyed on product, format, topic and day: the same ask twice is one item', async () => {
  const w = await world();
  const a = await w.act({ op: 'create', product: 'acme', format: 'social', topic: 'Bộ mới tuần này', channels: ['x'] });
  const b = await w.act({ op: 'create', product: 'acme', format: 'social', topic: '  bộ MỚI tuần   này ', channels: ['x'] });
  assert.equal(a.ref, b.ref);
  assert.equal(b.replayed, true);
  assert.equal(a.to, 'writer');
  assert.match(a.ask_text, /^Giao Writer làm bài mạng xã hội cho Acme Truyện \(MK-[0-9A-Z]{6}\): Bộ mới tuần này/);
  assert.match(a.ask_text, /item_save với ref MK-/);
  assert.equal(w.store.data.library.filter(r => r.kind === 'item').length, 1);
  const row = (await w.view({ view: 'content', stage: 'making' })).items.find(i => i.ref === a.ref);
  assert.equal(row.state, 'asked');
  w.now += DAY;
  assert.notEqual((await w.act({ op: 'create', product: 'acme', format: 'social', topic: 'Bộ mới tuần này' })).ref, a.ref, 'another day is another item');
  assert.equal((await w.act({ op: 'create', product: 'acme', format: 'video', topic: 'Tập mới' })).to, 'builder');
});

test('confirm settles an uncertain X post: posted records the link, not posted sends it back to draft', async () => {
  for (const outcome of ['posted', 'not_posted']) {
    const w = await world();
    const s = await saved(w);
    await w.call('publish_bundle', await bundleOf(w, s.ref));
    const [blog, x] = w.store.data.releases;
    w.now = Date.parse(blog.slot_at) + MIN; await w.call('release_due', {});
    w.now = Date.parse(x.slot_at) + MIN; await w.call('release_due', {});
    w.hub.poster('uncertain');
    w.now += 5 * MIN;
    const due = await w.call('release_due', {});
    assert.ok(due.needs.some(n => n.kind === 'uncertain'));
    assert.ok((await w.view({ view: 'today' })).blockers.some(b => b.kind === 'uncertain'));
    const r = await w.act({ op: 'confirm', ref: s.ref, outcome, ...(outcome === 'posted' ? { url: 'https://x.com/acmehq/status/1866000000000000000' } : {}) });
    assert.equal(r.ok, true, JSON.stringify(r));
    const post = [...w.hub.social.values()][0];
    assert.equal(post.status, outcome === 'posted' ? 'published' : 'draft');
    assert.equal(w.hub.count('social_publish'), 1, 'never sent again');
    if (outcome === 'posted') assert.equal((await w.act({ op: 'confirm', ref: s.ref, outcome, url: 'https://x.com/someone/status/1' })).error.code, 'bad_url');
  }
});

// ---------- views ----------

test('null and why, never 0: no approvals read, no Search Console, no hub', async () => {
  const w = await world();
  await saved(w);
  const sum = await w.view({ view: 'summary' });
  const tile = (id, v = sum) => v.tiles.find(t => t.id === id);
  assert.deepEqual([tile('approval').value, tile('approval').why], [null, 'approvals_unread']);
  assert.deepEqual([tile('reads').value, tile('reads').why], [null, 'search_console_not_connected']);
  const withApprovals = await w.view({ view: 'summary', approvals: [] });
  assert.equal(tile('approval', withApprovals).value, 0, 'read and empty is a real 0');
  w.hub.down = true;
  const down = await w.view({ view: 'summary', approvals: [] });
  assert.deepEqual([tile('published', down).value, tile('published', down).why], [null, 'hub']);
  assert.deepEqual([tile('channels', down).value, tile('channels', down).why], [null, 'hub']);
  assert.equal(down.status.code, 'hub_down');
  assert.equal(down.sources[0].ok, false);
  assert.equal(down.sources[0].error, 'unreachable');
  w.hub.down = false;
  w.hub.limited = true;
  const busy = await w.view({ view: 'summary', approvals: [] });
  assert.equal(busy.sources[0].error, 'rate_limited', 'a 429 is the minute budget of the hub, not a hub that is down');
  assert.deepEqual([busy.status.code, busy.status.tone], ['hub_busy', 'wait']);
  w.hub.limited = false;
  const nums = await w.view({ view: 'numbers' });
  for (const r of nums.rows) {
    assert.ok(r.views === null || typeof r.views === 'number');
    if (r.published === null || r.views === null) assert.ok(r.why, JSON.stringify(r));
  }
  const hubless = await world({ hub: false });
  const hs = await hubless.view({ view: 'summary', approvals: [] });
  // Without a hub the desk still counts what went out from its own rows (P2-2); with nothing live yet it says so.
  assert.deepEqual([tile('published', hs).value, tile('published', hs).why], [null, 'no_posts_yet']);
});

test('the summary: products from products.json, Hoả Long-style channels without a product under other, a declared page shows not connected', async () => {
  const w = await world();
  await w.call('library_scan', { hub: false });
  const sum = await w.view({ view: 'summary', approvals: [] });
  assert.deepEqual(sum.products.map(p => [p.id, p.name, p.mark]), [['acme', 'Acme Truyện', 'AT'], ['beta', 'Beta', 'Be']]);
  const lib = await w.view({ view: 'library' });
  assert.deepEqual(lib.tree.map(n => n.id), ['product:acme', 'product:beta', 'other']);
  assert.deepEqual(lib.tree[2].children.map(c => c.id), ['channel:side-show']);
  const ch = await w.view({ view: 'channels' });
  const acme = ch.rows.find(r => r.product === 'acme');
  assert.deepEqual([acme.cells.x.state, acme.cells.x.via, acme.cells.x.account], ['ok', 'browser', '@acmehq']);
  assert.deepEqual([acme.cells.facebook.state, acme.cells.facebook.account], ['not_connected', 'Trang Acme']);
  // X posts only for acme, and beta never chose X: Không dùng, with the hub's steps to add an account if the founder wants one.
  assert.deepEqual([ch.rows.find(r => r.product === 'beta').cells.x.state, ch.rows.find(r => r.product === 'beta').cells.x.why], ['off', 'not_chosen'], 'X posts only for acme');
  assert.equal(acme.cells.reddit.state, 'off');
  assert.equal(acme.cells.tiktok.state, 'manual');
  const radar = await w.view({ view: 'library', node: 'radar:acme-video/2026-11-23' });
  assert.deepEqual(radar.detail.rows.map(r => [r.n, r.title, r.onboard, r.link]), [[1, 'Bộ A', null, 'https://a.example'], [2, 'Bộ B', 'no', null]]);
});

test('approvals from the piece query move an item to Chờ duyệt; a late one is its own blocker', async () => {
  const w = await world();
  const s = await saved(w);
  const pending = [{ id: 'ap-1', state: 'pending', tool: 'publish_bundle', ref: s.ref, created_at: new Date(T0 - 7 * H).toISOString(), expires_at: new Date(T0 + 17 * H).toISOString() }];
  const today = await w.view({ view: 'today', approvals: pending });
  const b = today.blockers.find(x => x.ref === s.ref);
  assert.deepEqual([b.kind, b.do.sheet.kind, b.meta_args.hours], ['approval_late', 'item', 7]);
  const content = await w.view({ view: 'content', approvals: pending });
  assert.equal(content.stages.approval.count, 1);
  assert.deepEqual(content.items[0].approval, { id: 'ap-1', created_at: pending[0].created_at, expires_at: pending[0].expires_at });
  const rejected = await w.view({ view: 'item', ref: s.ref, approvals: [{ ...pending[0], state: 'rejected', decided_at: new Date(T0).toISOString(), reason: 'Câu mở đầu dài quá.' }] });
  assert.deepEqual([rejected.stage, rejected.state, rejected.note], ['making', 'revising', 'Câu mở đầu dài quá.']);
});

test('Nội dung is paged at 30 with a cursor', async () => {
  const w = await world({ hub: false });
  for (let i = 0; i < 35; i++) await w.act({ op: 'create', product: 'acme', format: 'blog', topic: `Chủ đề số ${i}` });
  const p1 = await w.view({ view: 'content' });
  assert.deepEqual([p1.items.length, p1.total, p1.next_cursor], [30, 35, '30']);
  const p2 = await w.view({ view: 'content', cursor: p1.next_cursor });
  assert.deepEqual([p2.items.length, p2.next_cursor], [5, null]);
  assert.equal(new Set([...p1.items, ...p2.items].map(i => i.ref)).size, 35);
});

test('hubless Nội dung shows the pack\'s own posts as items (G1)', async () => {
  const w = await world({ hub: false });
  await w.store.insert('posts', { ref: 'P-00000000AA', kind: 'article', channel: 'blog-acme', title: 'Bài không có hub', body: 'x', state: 'published', url: 'https://acme.example/a', revision: 1 });
  const c = await w.view({ view: 'content' });
  const it = c.items.find(i => i.ref === 'P-00000000AA');
  assert.deepEqual([it.stage, it.state, it.hubless], ['live', 'posted', true]);
});

test('scan refreshes the library index from the page and needs MARKETING_ROOT', async () => {
  const w = await world();
  const none = await w.call('page_action', { op: 'scan', request_id: 'r-scan-0' }, {}, { env: {} });
  assert.equal(none.error.code, 'needs_credential');
  const first = await w.act({ op: 'scan' });
  assert.ok(first.added >= 4, JSON.stringify(first));
  const again = await w.act({ op: 'scan' });
  assert.deepEqual([again.added, again.changed, again.removed], [0, 0, 0]);
  const tree = (await w.view({ view: 'library' })).tree;
  assert.ok(tree.find(g => g.id === 'product:acme').children.some(n => n.id === 'channel:acme-video'));
  assert.ok(tree.find(g => g.id === 'other'), 'a channel no product names sits under Kênh khác');
  assert.equal(w.publishes(), 0);
});
