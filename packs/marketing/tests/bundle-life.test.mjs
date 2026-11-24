// The life of an approved bundle after its first approval (review of M3): a set
// approved again after it ended, a bundle split in two, a newer set replacing an
// older one on a capped channel, the preview's byte limit, pause holding what the
// hub already queued, one pause for both chains, a post past the hub's newest 50,
// and an approval Nest granted that the Editor has not run yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN, H, world, saved, bundleOf, XPOST } from './desk-world.mjs';
import { localDay } from '../tools/lib/time.mjs';

const TZ = 'Asia/Ho_Chi_Minh';
const releases = (w) => w.store.data.releases.map(r => [r.channel, r.state]);
const pre = (w, b) => w.call('publish_bundle', b, { hook: 'tool.preflight' });

test('a set approved again after its slot was missed is re-armed at a new slot and goes out; the reply says what will happen', async () => {
  const w = await world();
  const s = await saved(w);
  const b = await bundleOf(w, s.ref);
  await w.call('publish_bundle', b);
  w.now = Date.parse(w.store.data.releases[0].slot_at) + 361 * MIN;
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[0].state, 'missed');
  // A dead set is not "already scheduled": the Editor may ask again, and the card goes up.
  const ask = await pre(w, b);
  assert.ok(ask.preview, JSON.stringify(ask));
  const again = await w.call('publish_bundle', b);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.rearmed, true);
  assert.equal(again.replayed, undefined);
  assert.match(again.next, /2 post\(s\) scheduled/);
  assert.deepEqual(releases(w), [['blog', 'scheduled'], ['x', 'scheduled']]);
  assert.equal(w.store.data.releases.length, 2, 'the same rows, re-armed, not new ones');
  assert.ok(Date.parse(w.store.data.releases[0].slot_at) >= w.now, 'the new slot is ahead');
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[0].state, 'posted');
});

test('preflight of a set already approved and on schedule refuses already_scheduled, so Nest files no second card', async () => {
  const w = await world();
  const s = await saved(w);
  const b = await bundleOf(w, s.ref);
  await w.call('publish_bundle', b);
  const dup = await pre(w, b);
  assert.equal(dup.error?.code, 'already_scheduled', JSON.stringify(dup));
  // The executed call itself still replays (a retried run is harmless).
  assert.equal((await w.call('publish_bundle', b)).replayed, true);
});

test('a bundle split in two (blog first, social later) keeps the blog scheduled under its own approval', async () => {
  const w = await world();
  const s = await saved(w);
  const b = await bundleOf(w, s.ref);
  await w.call('publish_bundle', { ...b, posts: [b.posts[0]] });
  await w.call('publish_bundle', { ...b, posts: [b.posts[1]] });
  assert.deepEqual(releases(w).sort(), [['blog', 'scheduled'], ['x', 'scheduled']]);
  assert.deepEqual(w.store.data.bundles.map(x => x.state), ['approved', 'approved']);
});

test('a newer set replaces the older one: the old X row is superseded, its slot is free again, and an old bundle with a waiting blog stays approved', async () => {
  const w = await world();
  await w.store.insert('settings', { key: 'desk_rules', value: { 'acme:x': { cap_per_day: 1, spacing_min: 90, quiet: { from: '23:00', to: '07:00' } } } });
  const s = await saved(w);
  const b = await bundleOf(w, s.ref);
  await w.call('publish_bundle', b);
  const oldX = w.store.data.releases.find(r => r.channel === 'x');
  // The founder asks for a shorter X post; the Writer saves it, the Editor sends only the X post again.
  await saved(w, { posts: [{ ...XPOST, text: 'Chín bộ tiên hiệp, đọc ngay.' }] });
  const b2 = await bundleOf(w, s.ref);
  assert.notEqual(b2.posts[1].revision, b.posts[1].revision);
  const preview = await pre(w, { ...b2, posts: [b2.posts[1]] });
  assert.ok(preview.preview, JSON.stringify(preview));
  const out = await w.call('publish_bundle', { ...b2, posts: [b2.posts[1]] });
  assert.equal(out.superseded, 1, JSON.stringify(out));
  const xs = w.store.data.releases.filter(r => r.channel === 'x');
  assert.deepEqual(xs.map(r => r.state).sort(), ['scheduled', 'superseded']);
  const fresh = xs.find(r => r.state === 'scheduled');
  assert.equal(localDay(Date.parse(fresh.slot_at), TZ), localDay(Date.parse(oldX.slot_at), TZ), 'the replaced row does not hold the day of a cap-1 channel');
  const first = w.store.data.bundles.find(x => x.key === oldX.bundle);
  assert.equal(first.state, 'approved', 'its blog still waits, so the first bundle is not superseded');
  assert.equal(w.store.data.releases.find(r => r.channel === 'blog').state, 'scheduled');
});

test('the preview limit counts bytes, as the host does: Vietnamese text under 3900 characters can still be too long', async () => {
  const w = await world();
  const fb = (text) => ({ ref: 'MK-AAAAAA', product: 'acme', posts: [{ channel: 'facebook', lang: 'vi', id: 'SP-0000000A', revision: 1, text }] });
  const ascii = await pre(w, fb('e'.repeat(1400)));
  assert.ok(ascii.preview, JSON.stringify(ascii));
  const vi = await pre(w, fb('ế'.repeat(1400)));
  assert.equal(vi.error?.code, 'too_long');
  assert.match(vi.error.message, /bytes/);
});

test('a blog looked up after a lost answer never records the signed preview link as its public url', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  w.hub.lose.add('cms_publish');
  await w.call('release_due', {});
  w.hub.lose.clear();
  w.now += 5 * MIN;
  await w.call('release_due', {});
  const blog = w.store.data.releases[0];
  assert.equal(blog.state, 'posted');
  assert.ok(!/preview/.test(blog.url ?? ''), `url is ${blog.url}`);
});

test('pausing takes back an X post the hub already queued for the Poster; resuming sends it again through the checks', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  const [blog, x] = w.store.data.releases;
  w.now = Date.parse(blog.slot_at) + MIN;
  await w.call('release_due', {});
  w.now = Date.parse(x.slot_at) + MIN;
  await w.call('release_due', {});
  assert.equal([...w.hub.social.values()][0].status, 'approved');
  const paused = await w.act({ op: 'pause', scope: 'channel', channel: 'acme:x' });
  assert.equal(paused.withdrawn, 1, JSON.stringify(paused));
  assert.equal([...w.hub.social.values()][0].status, 'draft');
  assert.equal(w.hub.poster('published'), null, 'the Poster has nothing to take while paused');
  assert.deepEqual([w.store.data.releases[1].state, w.store.data.releases[1].reason], ['scheduled', 'paused']);
  w.now += 5 * MIN;
  const held = await w.call('release_due', {});
  assert.deepEqual(held.held.map(h => h.reason), ['paused']);
  await w.act({ op: 'resume', scope: 'channel', channel: 'acme:x' });
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[1].state, 'approved', 'released again with the revision the hub now holds');
  assert.equal(w.store.data.releases[1].reason, null, 'the pause reason does not outlive the pause');
  w.hub.poster('published');
  w.now += 5 * MIN;
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[1].state, 'posted');
});

test('one pause: the pack\'s older pause-everything holds the desk, and the desk\'s holds the older chain', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  await w.call('pause', { paused: true });
  w.now = Date.parse(w.store.data.releases[0].slot_at) + MIN;
  const out = await w.call('release_due', {});
  assert.equal(out.paused, true);
  assert.equal(w.publishes(), 0);
  // Resuming on the desk lifts both.
  await w.act({ op: 'resume', scope: 'all' });
  assert.equal((await w.call('pause', { paused: true })).paused_all, true);
  await w.act({ op: 'resume', scope: 'all' });
  const after = await w.call('release_due', {});
  assert.equal(after.paused, undefined, JSON.stringify(after));
  assert.equal(w.store.data.releases[0].state, 'posted');
  // And the desk's pause shows in the older chain's settings.
  await w.act({ op: 'pause', scope: 'all' });
  assert.ok((await w.view({ view: 'today' })).blockers.some(x => x.kind === 'paused'));
  assert.equal((await w.call('pause', { paused: false })).paused_all, false, 'the older resume lifts the desk pause too');
  const today = await w.view({ view: 'today' });
  assert.ok(!today.blockers.some(x => x.kind === 'paused'), 'the desk no longer says everything is paused');
});

test('an X post pushed past the hub\'s newest 50 is still found by its status; one the hub no longer lists is named, not waited on', async () => {
  const w = await world();
  const s = await saved(w);
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  const [blog, x] = w.store.data.releases;
  w.now = Date.parse(blog.slot_at) + MIN;
  await w.call('release_due', {});
  w.now = Date.parse(x.slot_at) + MIN;
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[1].state, 'approved');
  for (let i = 0; i < 60; i++) {
    const id = `SP-${(0xA0000000 + i).toString(16).toUpperCase()}`;
    w.hub.social.set(id, { id, channel: 'x', language: 'vi', text: `nháp ${i}`, link: null, source: null, status: 'draft', revision: 1, updated_at: new Date(w.now).toISOString(), published_at: null, url: null, note: null });
  }
  w.hub.poster('published');
  w.now += 5 * MIN;
  await w.call('release_due', {});
  assert.equal(w.store.data.releases[1].state, 'posted');
  // A second item whose approved X post the hub drops entirely.
  const w2 = await world();
  const s2 = await saved(w2);
  await w2.call('publish_bundle', await bundleOf(w2, s2.ref));
  const [b2, x2] = w2.store.data.releases;
  w2.now = Date.parse(b2.slot_at) + MIN;
  await w2.call('release_due', {});
  w2.now = Date.parse(x2.slot_at) + MIN;
  await w2.call('release_due', {});
  w2.hub.social.clear();
  w2.now += 5 * MIN;
  const lost = await w2.call('release_due', {});
  assert.deepEqual(lost.needs.map(n => [n.kind, n.reason, n.new]), [['uncertain', 'not_listed', true]]);
  assert.equal(lost.notify, true);
  assert.equal((await w2.call('release_due', {})).notify, false, 'said once');
});

test('an approval Nest granted that the Editor has not run yet reads "approved, scheduling", not Chờ duyệt or Nháp', async () => {
  const w = await world();
  const s = await saved(w);
  const granted = [{ id: 'ap-9', state: 'approved', tool: 'publish_bundle', ref: s.ref, created_at: new Date(w.now - 2 * H).toISOString(), decided_at: new Date(w.now - H).toISOString() }];
  const item = await w.view({ view: 'item', ref: s.ref, approvals: granted });
  assert.deepEqual([item.stage, item.state], ['approval', 'granted']);
  const content = await w.view({ view: 'content', approvals: granted });
  assert.deepEqual(content.stages.approval.sub, { granted: 1 });
  const today = await w.view({ view: 'today', approvals: granted });
  assert.ok(!today.blockers.some(b => b.ref === s.ref), 'nothing for the founder to do');
  const summary = await w.view({ view: 'summary', approvals: granted });
  assert.equal(summary.tiles.find(t => t.id === 'approval').value, 0);
  // Once the Editor runs the call, the item is scheduled.
  await w.call('publish_bundle', await bundleOf(w, s.ref));
  assert.equal((await w.view({ view: 'item', ref: s.ref, approvals: granted })).state, 'scheduled');
});
