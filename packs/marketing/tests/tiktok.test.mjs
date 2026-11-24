// TikTok is posted by the browser Publisher like X and Facebook: tiktok-<handle> channels carry the platform defaults
// (video only, 2 a day, 240 minutes), name the browser profile in the signed claim, are created from the product's
// accounts, and wait for a sign-in. A person's "hand" stays theirs. video_brief picks the next source for a video and
// answers exactly the input of claude-code_start, once per day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { verifyClaim } from '../tools/lib/claim.mjs';
import { CHANNEL_DEFAULTS, defaultsFor, platformOf, checkPlatform } from '../tools/lib/guard.mjs';
import { isLegacyTiktok, retireLegacyTiktok } from '../tools/lib/ops.mjs';
import { tiktokAccounts, tiktokChannelId } from '../tools/lib/library.mjs';
import { requestIdOf } from '../tools/lib/video-jobs.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-24T03:00:00Z'); // 10:00 in Asia/Ho_Chi_Minh
const MIN = 60_000, DAY = 86_400_000;
const eq = (column, value) => ({ column, op: 'eq', value });
const put = (root, rel, data) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); };

const PRODUCTS = { products: [{ id: 'lohi', name: 'Lohi', site: 'lohi2.com', video_channels: ['lohi-truyen', 'hoa-long-chan-nhan'], goal: 'Nghe truyện audio', accounts: {
  x: '@lohi2com', tiktok: [{ handle: 'lohi', video_channel: 'lohi-truyen', profile: 'tiktok-lohi' }, { handle: 'hoalongchannhan', video_channel: 'hoa-long-chan-nhan', profile: 'tiktok-hoalongchannhan' }] } }] };

/** <tmp>/repo/marketing is MARKETING_ROOT; the repo holds 2build/skills/marketing-video/SKILL.md. */
function repo({ skill = true, products = PRODUCTS } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tt-')));
  const root = join(dir, 'marketing');
  put(root, 'products.json', products);
  mkdirSync(join(root, 'channels/lohi-truyen/campaigns'), { recursive: true });
  mkdirSync(join(root, 'channels/hoa-long-chan-nhan/campaigns'), { recursive: true });
  if (skill) put(dir, '2build/skills/marketing-video/SKILL.md', '# marketing-video\n');
  return { dir, root };
}

function world(root, extraEnv = {}) {
  const w = { now: T0 };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { MARKETING_CLAIM_KEY: KEY, FILE_ROOT: dirname(root), MARKETING_ROOT: root, ...extraEnv };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: async () => { throw new Error('no network'); } });
  w.page = (op, input = {}) => w.call('page_action', { op, request_id: `r-${Math.random()}`, ...input }, { page: { page: 'queue' } });
  w.row = key => w.store.one('channels', [eq('key', key)]);
  return w;
}

test('a tiktok-<handle> channel resolves to the TikTok defaults; the platform and the account key follow', () => {
  assert.equal(platformOf('tiktok-lohi'), 'tiktok');
  assert.equal(platformOf('tiktok'), 'tiktok');
  const d = defaultsFor('tiktok-hoalongchannhan');
  assert.deepEqual([d.kind, d.publisher, d.cap_per_day, d.spacing_min, d.reply_cap_per_day, d.rules.max_chars, d.rules.video_required], ['video', 'browser', 2, 240, 0, 2200, true]);
  assert.equal(CHANNEL_DEFAULTS.tiktok.publisher, 'browser');
  assert.equal(tiktokChannelId('HoaLongChanNhan'), 'tiktok-hoalongchannhan');
  // A text post is refused on a video-only channel; a video within 2200 characters passes.
  const ch = { key: 'tiktok-lohi', ...d };
  assert.equal(checkPlatform({ kind: 'article', body: 'x', brief: {} }, ch).code, 'video_required');
  assert.equal(checkPlatform({ kind: 'video', body: 'Nghe thử một cảnh. #truyen' }, ch).code ?? null, null);
  assert.equal(checkPlatform({ kind: 'video', body: 'a'.repeat(2201) }, ch).code, 'too_long');
});

test('TikTok accounts read from an array, an object or the older text; a bad handle is left out', () => {
  assert.deepEqual(tiktokAccounts('lohi (lohi-truyen), hoalongchannhan (hoa-long-chan-nhan)'), [{ handle: 'lohi', video_channel: 'lohi-truyen' }, { handle: 'hoalongchannhan', video_channel: 'hoa-long-chan-nhan' }]);
  assert.deepEqual(tiktokAccounts({ handle: '@lohi', profile: 'tiktok-lohi' }), [{ handle: 'lohi', profile: 'tiktok-lohi' }]);
  assert.deepEqual(tiktokAccounts([{ handle: 'a b' }, { handle: 'ok.name', profile: '../x' }, 'lohi']), [{ handle: 'ok.name' }, { handle: 'lohi' }]);
  assert.deepEqual(tiktokAccounts(undefined), []);
});

test('channels_setup from_products creates one paused TikTok channel per account with its profile; again changes nothing and never unpauses', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    const out = await w.call('channels_setup', { from_products: true, channels: [{ id: 'facebook-lohi', account: 'https://www.facebook.com/lohi' }] });
    const tt = out.channels.filter(c => c.id.startsWith('tiktok-'));
    assert.deepEqual(tt.map(c => [c.id, c.profile, c.paused, c.paused_reason, c.created]), [['tiktok-lohi', 'tiktok-lohi', true, 'signed_out', true], ['tiktok-hoalongchannhan', 'tiktok-hoalongchannhan', true, 'signed_out', true]]);
    const row = await w.row('tiktok-lohi');
    assert.deepEqual([row.kind, row.publisher, row.cap_per_day, row.spacing_min, row.reply_cap_per_day, row.account], ['video', 'browser', 2, 240, 0, '@lohi']);
    assert.deepEqual([row.rules.profile, row.rules.product, row.rules.video_channel, row.rules.max_chars], ['tiktok-lohi', 'lohi', 'lohi-truyen', 2200]);
    // The sign-in card names the platform, the account and the profile to open.
    const view = await w.call('page_view', {}, { page: { page: 'queue' } });
    assert.match(JSON.stringify(view), /tiktok-lohi/);
    await w.page('resume', { channel: 'tiktok-lohi' });
    assert.equal((await w.row('tiktok-lohi')).paused, false);
    const again = await w.call('channels_setup', { from_products: true, channels: [] });
    assert.deepEqual(again.channels.filter(c => c.id.startsWith('tiktok-')).map(c => [c.id, c.created, c.paused]), [['tiktok-lohi', false, false], ['tiktok-hoalongchannhan', false, true]], 'no repeat creates, no re-pause');
    // Older products.json text still creates the channels, without a profile.
    const old = repo({ products: { products: [{ id: 'lohi', name: 'Lohi', accounts: { tiktok: 'lohi (lohi-truyen), hoalongchannhan (hoa-long-chan-nhan)' } }] } });
    try {
      const w2 = world(old.root);
      const o2 = await w2.call('channels_setup', { from_products: true, channels: [] });
      assert.deepEqual(o2.channels.map(c => [c.id, c.profile]), [['tiktok-lohi', null], ['tiktok-hoalongchannhan', null]]);
    } finally { rmSync(old.dir, { recursive: true, force: true }); }
    await assert.rejects(world(root, { MARKETING_ROOT: undefined }).call('channels_setup', { from_products: true, channels: [] }), /MARKETING_ROOT/);
    await assert.rejects(w.call('channels_setup', { channels: [{ id: 'tiktok-lohi', profile: '../etc' }] }), { code: 'invalid_request' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an old-default tiktok-<handle> row moves to the browser defaults, paused for a person; a row a person set to hand, or capped, is left alone', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    const old = { kind: 'video', publisher: 'hand', cap_per_day: 0, spacing_min: 0, reply_cap_per_day: 0, paused: false, paused_reason: null, rules: {}, account: null, platform: 'tiktok' };
    await w.store.insert('channels', { key: 'tiktok-old', ...old });
    await w.store.insert('channels', { key: 'tiktok-hand', ...old, rules: { publisher_by: 'person' } });
    await w.store.insert('channels', { key: 'tiktok-capped', ...old, cap_per_day: 1 });
    assert.equal(isLegacyTiktok(await w.row('tiktok-old')), true);
    assert.equal(isLegacyTiktok(await w.row('tiktok-hand')), false);
    assert.equal(isLegacyTiktok(await w.row('tiktok-capped')), false);
    await w.call('channels_setup', { channels: [{ id: 'tiktok-old' }, { id: 'tiktok-hand' }, { id: 'tiktok-capped' }] });
    const m = await w.row('tiktok-old');
    assert.deepEqual([m.publisher, m.cap_per_day, m.spacing_min, m.paused, m.paused_reason], ['browser', 2, 240, true, 'person']);
    assert.equal((await w.row('tiktok-hand')).publisher, 'hand');
    const c = await w.row('tiktok-capped');
    assert.deepEqual([c.publisher, c.cap_per_day], ['hand', 1]);
    // The account-less `tiktok` is no channel to set up any more.
    await assert.rejects(w.call('channels_setup', { channels: [{ id: 'tiktok' }] }), { code: 'tiktok_account_required' });
    // A person's own word: setting hand through channels_setup is kept against a later default.
    await w.call('channels_setup', { channels: [{ id: 'tiktok-lohi', publisher: 'hand' }] });
    const h = await w.row('tiktok-lohi');
    assert.deepEqual([h.publisher, h.rules.publisher_by], ['hand', 'person']);
    await w.call('channels_setup', { channels: [{ id: 'tiktok-lohi' }] });
    assert.equal((await w.row('tiktok-lohi')).publisher, 'hand');
    // set_limits changes the publisher from the desk; it binds a profile as browser_profile (bind-profile.test.mjs),
    // never as `profile`, which the host would check against the desk Soot's own grants.
    const set = await w.page('set_limits', { channel: 'tiktok-lohi', publisher: 'browser' });
    assert.ok(!set.error, JSON.stringify(set));
    assert.equal((await w.row('tiktok-lohi')).publisher, 'browser');
    await assert.rejects(w.page('set_limits', { channel: 'tiktok-lohi', profile: 'tiktok-lohi' }), { code: 'invalid_request' });
    await assert.rejects(w.page('set_limits', { channel: 'tiktok-lohi', browser_profile: 'bad profile' }), { code: 'invalid_request' });
    // No browser.profiles.read grant: nothing to check the profile against, so nothing is bound.
    await assert.rejects(w.page('set_limits', { channel: 'tiktok-lohi', browser_profile: 'tiktok-lohi', cap_per_day: 3 }), { code: 'profiles_unread' });
    const kept = await w.row('tiktok-lohi');
    assert.deepEqual([kept.rules.profile, kept.cap_per_day], [undefined, 2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the legacy `tiktok` row (AC1.5) ----------

const LEGACY = { key: 'tiktok', kind: 'video', publisher: 'hand', cap_per_day: 0, spacing_min: 0, reply_cap_per_day: 0, paused: false, paused_reason: null, rules: {}, account: null, platform: 'tiktok' };
const legacyPost = (w, ref, extra = {}) => w.store.insert('posts', { ref, kind: 'video', channel: 'tiktok', brief: { title: ref }, title: ref, body: `Video ${ref}`, state: 'scheduled', revision: 1, content_hash: `h-${ref}`, ...extra });

test('channel("tiktok") is refused everywhere a post or a channel is made; no row is created', async () => {
  const { dir, root } = repo();
  try {
    tiktokCampaign(root);
    const w = world(root);
    await assert.rejects(w.call('draft_save', { request_id: 'd-1', kind: 'video', channel: 'tiktok', body: 'Một video' }), { code: 'tiktok_account_required' });
    await assert.rejects(w.call('video_import', { request_id: 'v-1', campaign: TT_CAMP, channels: ['tiktok'] }), { code: 'tiktok_account_required' });
    await assert.rejects(w.call('channels_setup', { channels: [{ id: 'tiktok' }] }), { code: 'tiktok_account_required' });
    await assert.rejects(w.call('pause', { channel: 'tiktok', paused: true }), { code: 'tiktok_account_required' });
    assert.equal(await w.row('tiktok'), null, 'nothing made the row');
    // The account channels still work.
    const ok = await w.call('draft_save', { request_id: 'd-2', kind: 'video', channel: 'tiktok-lohi', body: 'Một video' });
    assert.match(ok.id, /^P-/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the repair moves a legacy post only to the one account that matches, retires the row, keeps the intent, and runs once', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.store.insert('channels', LEGACY);
    // Cut in hoa-long-chan-nhan: one account has that folder. In flight: its intent stays on the queue row.
    await legacyPost(w, 'P-00000000A1', { brief: { title: 'A', campaign_dir: 'marketing/channels/hoa-long-chan-nhan/campaigns/k01' } });
    await w.store.insert('queue', { post: 'P-00000000A1', channel: 'tiktok', action: 'publish', scheduled_at: new Date(w.now - MIN).toISOString(), intent_id: 'I-aaaaaaaaaaaaaaaa', intent_at: new Date(w.now - MIN).toISOString(), attempts: 1 });
    await w.store.insert('publish_log', { post: 'P-00000000A1', channel: 'tiktok', action: 'publish', intent_id: 'I-aaaaaaaaaaaaaaaa', status: 'intent', at: new Date(w.now - MIN).toISOString() });
    // Uncertain, cut in lohi-truyen: moves, stays uncertain, is never queued again.
    await legacyPost(w, 'P-00000000A2', { state: 'uncertain', brief: { title: 'B', campaign_dir: 'marketing/channels/lohi-truyen/campaigns/x' } });
    // No folder, and lohi has two accounts: ambiguous, so it stays where it is.
    await legacyPost(w, 'P-00000000A3', { brief: { title: 'C' } });
    const out = await w.call('channels_setup', { from_products: true, channels: [] });
    assert.ok(out.channels.length === 2);
    const post = ref => w.store.data.posts.find(p => p.ref === ref);
    assert.deepEqual([post('P-00000000A1').channel, post('P-00000000A2').channel, post('P-00000000A3').channel], ['tiktok-hoalongchannhan', 'tiktok-lohi', 'tiktok']);
    assert.equal(post('P-00000000A2').state, 'uncertain');
    assert.equal(post('P-00000000A1').state, 'scheduled');
    const q = w.store.data.queue.find(x => x.post === 'P-00000000A1');
    assert.deepEqual([q.channel, q.intent_id, q.attempts], ['tiktok-hoalongchannhan', 'I-aaaaaaaaaaaaaaaa', 1]);
    assert.equal(w.store.data.queue.some(x => x.post === 'P-00000000A2'), false, 'an uncertain post is not queued again');
    assert.equal(w.store.data.publish_log.find(x => x.post === 'P-00000000A1').channel, 'tiktok-hoalongchannhan');
    const row = await w.row('tiktok');
    assert.deepEqual([row.paused, row.paused_reason], [true, 'retired']);
    const mark = w.store.data.settings.find(s => s.key === 'legacy_tiktok').value;
    assert.deepEqual([mark.moved_n, mark.kept_n, mark.kept], [2, 1, ['P-00000000A3']]);
    // No sign-in card for a retired row; channel('tiktok') still resolves it for its old post.
    const due = await w.call('due', {});
    assert.equal(due.needs_person.some(n => n.channel === 'tiktok'), false);
    assert.equal(due.needs.some(n => n.channel === 'tiktok' && n.kind === 'channel'), false);
    assert.deepEqual(await w.call('due', { channel: 'tiktok' }), { done: true, reason: 'paused' });
    // A retired row is never resumed, from the tool or from the desk.
    await assert.rejects(w.call('pause', { channel: 'tiktok', paused: false }), { code: 'conflict' });
    await assert.rejects(w.page('resume', { scope: 'account', channel: 'tiktok' }), { code: 'conflict' });
    assert.equal((await w.row('tiktok')).paused_reason, 'retired');
    // A second run reads the marker and changes nothing, even for a post that appeared since.
    await legacyPost(w, 'P-00000000A4', { brief: { title: 'D', campaign_dir: 'marketing/channels/lohi-truyen/campaigns/y' } });
    await w.call('due', {});
    await w.call('channels_setup', { channels: [] });
    assert.equal(post('P-00000000A4').channel, 'tiktok');
    assert.equal(w.store.data.settings.find(s => s.key === 'legacy_tiktok').value.moved_n, 2);
    // The desk shows no line for the retired row.
    const cell = (await w.call('page_view', { view: 'channel', key: 'lohi:tiktok' })).cell;
    assert.deepEqual(cell.accounts.map(a => a.channel), ['tiktok-hoalongchannhan', 'tiktok-lohi']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the repair: a product with one account takes a post with no folder; with no account known yet it waits; a store with no legacy row only gets the marker', async () => {
  const one = repo({ products: { products: [{ id: 'lohi', name: 'Lohi', video_channels: ['lohi-truyen'], accounts: { tiktok: [{ handle: 'lohi', video_channel: 'lohi-truyen', profile: 'tiktok-lohi' }] } }] } });
  try {
    const w = world(one.root);
    await w.store.insert('channels', LEGACY);
    await legacyPost(w, 'P-00000000B1', { state: 'published', url: 'https://www.tiktok.com/@lohi/video/1234567' });
    await w.page('resume', { scope: 'all' });
    assert.equal(w.store.data.posts.find(p => p.ref === 'P-00000000B1').channel, 'tiktok-lohi', 'the desk action ran the repair');
    assert.equal((await w.row('tiktok')).paused_reason, 'retired');
  } finally { rmSync(one.dir, { recursive: true, force: true }); }
  // No account known yet (due has no MARKETING_ROOT, no account row): the posts wait on the row, unmarked, for a later run.
  const early = repo();
  try {
    const w = world(early.root, { MARKETING_ROOT: undefined });
    await w.store.insert('channels', LEGACY);
    await legacyPost(w, 'P-00000000B2', { brief: { title: 'E', campaign_dir: 'marketing/channels/lohi-truyen/campaigns/z' } });
    await w.call('due', {});
    assert.equal(w.store.data.settings.some(s => s.key === 'legacy_tiktok'), false);
    assert.equal((await w.row('tiktok')).paused_reason, null);
    w.env.MARKETING_ROOT = early.root;
    await w.call('channels_setup', { from_products: true, channels: [] });
    assert.equal(w.store.data.posts.find(p => p.ref === 'P-00000000B2').channel, 'tiktok-lohi');
    assert.equal((await w.row('tiktok')).paused_reason, 'retired');
  } finally { rmSync(early.dir, { recursive: true, force: true }); }
  const none = repo();
  try {
    const w = world(none.root);
    await w.call('due', {});
    assert.deepEqual(w.store.data.settings.find(s => s.key === 'legacy_tiktok').value.row, false);
    assert.equal(await w.row('tiktok'), null);
  } finally { rmSync(none.dir, { recursive: true, force: true }); }
});

test('the repair, non-happy: without products.json only a folder match moves a post; a failure part way through is finished by the next run', async () => {
  // due has no MARKETING_ROOT and only tiktok-lohi is stored: a post cut in another folder is not guessed onto it.
  const w = world('/nowhere/marketing', { MARKETING_ROOT: undefined });
  await w.store.insert('channels', LEGACY);
  await w.store.insert('channels', { ...LEGACY, key: 'tiktok-lohi', account: '@lohi', rules: { product: 'lohi', video_channel: 'lohi-truyen' } });
  await legacyPost(w, 'P-00000000C1', { brief: { title: 'F', campaign_dir: 'marketing/channels/hoa-long-chan-nhan/campaigns/k' } });
  await legacyPost(w, 'P-00000000C2', { brief: { title: 'G', campaign_dir: 'marketing/channels/lohi-truyen/campaigns/k' } });
  await legacyPost(w, 'P-00000000C3', { brief: { title: 'H' } });
  const out = await retireLegacyTiktok(w.store, { env: w.env, now: w.now });
  assert.deepEqual([out.at, out.waiting, out.moved_n, out.kept_n], [null, 'no_library', 1, 2]);
  const post = ref => w.store.data.posts.find(p => p.ref === ref).channel;
  assert.deepEqual([post('P-00000000C1'), post('P-00000000C2'), post('P-00000000C3')], ['tiktok', 'tiktok-lohi', 'tiktok']);
  assert.equal(w.store.data.settings.some(s => s.key === 'legacy_tiktok'), false, 'unmarked: a run with the library finishes it');
  assert.equal((await w.row('tiktok')).paused_reason, null);
  // The post's own row moves last: a failure on it leaves the post findable, and the rerun moves it.
  const v = world('/nowhere/marketing', { MARKETING_ROOT: undefined });
  await v.store.insert('channels', LEGACY);
  await v.store.insert('channels', { ...LEGACY, key: 'tiktok-lohi', account: '@lohi', rules: { product: 'lohi', video_channel: 'lohi-truyen' } });
  await legacyPost(v, 'P-00000000C4', { brief: { title: 'I', campaign_dir: 'marketing/channels/lohi-truyen/campaigns/k' } });
  await v.store.insert('queue', { post: 'P-00000000C4', channel: 'tiktok', action: 'publish', scheduled_at: new Date(v.now).toISOString() });
  let broken = true;
  const flaky = { ...v.store, update: async (t, ...a) => { if (t === 'posts' && broken) throw new Error('storage timeout'); return v.store.update(t, ...a); } };
  await assert.rejects(retireLegacyTiktok(flaky, { env: v.env, now: v.now }), /storage timeout/);
  broken = false;
  const again = await retireLegacyTiktok(flaky, { env: v.env, now: v.now });
  assert.equal(again.moved_n, 1);
  assert.deepEqual([v.store.data.posts[0].channel, v.store.data.queue[0].channel], ['tiktok-lohi', 'tiktok-lohi']);
});

// ---------- one account's pause and resume from the desk (AC1.1, AC1.2) ----------

test('the desk pauses and resumes one TikTok account row; due and claim read it; the resume step names the row', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    // Both accounts start signed out: the cell is signed out and its steps act on the first signed-out row.
    let v = await w.call('page_view', { view: 'channel', key: 'lohi:tiktok' });
    assert.equal(v.cell.state, 'signed_out');
    assert.deepEqual(v.cell.accounts.map(a => [a.channel, a.account, a.state, a.video_channel]), [['tiktok-hoalongchannhan', '@hoalongchannhan', 'signed_out', 'hoa-long-chan-nhan'], ['tiktok-lohi', '@lohi', 'signed_out', 'lohi-truyen']]);
    const resume = v.steps.find(s => s.id === 'resume');
    assert.deepEqual(resume.args, { channel: 'tiktok-hoalongchannhan', account: '@hoalongchannhan' });
    assert.equal(v.steps.find(s => s.id === 'sign_in').args.profile, 'tiktok-hoalongchannhan');
    // Bật lại on the step: the row the Publisher reads is running.
    const r = await w.page('resume', { scope: 'account', channel: resume.args.channel });
    assert.deepEqual([r.ok, r.scope, r.paused, r.was_signed_out], [true, 'account', false, true]);
    assert.equal((await w.row('tiktok-hoalongchannhan')).paused, false);
    v = await w.call('page_view', { view: 'channel', key: 'lohi:tiktok' });
    assert.deepEqual(v.cell.accounts.map(a => a.state), ['ok', 'signed_out']);
    assert.equal(v.cell.state, 'signed_out', 'one signed-out account still needs fixing');
    // Pause, then resume: the round trip, as due's chain reads it.
    await w.store.insert('posts', { ref: 'P-00000000C1', kind: 'video', channel: 'tiktok-hoalongchannhan', brief: { title: 'x' }, body: 'x', state: 'scheduled', revision: 1, content_hash: 'h' });
    await w.store.insert('queue', { post: 'P-00000000C1', channel: 'tiktok-hoalongchannhan', action: 'publish', scheduled_at: new Date(w.now - MIN).toISOString(), attempts: 0 });
    assert.deepEqual(await w.call('due', { channel: 'tiktok-hoalongchannhan' }), { id: 'P-00000000C1', action: 'publish' });
    const p = await w.page('pause', { scope: 'account', channel: 'tiktok-hoalongchannhan' });
    assert.deepEqual([p.paused, (await w.row('tiktok-hoalongchannhan')).paused_reason], [true, 'person']);
    assert.deepEqual(await w.call('due', { channel: 'tiktok-hoalongchannhan' }), { done: true, reason: 'paused' });
    assert.equal((await w.page('pause', { scope: 'account', channel: 'tiktok-hoalongchannhan' })).unchanged, true, 'the same pause twice changes nothing');
    await w.page('resume', { scope: 'account', channel: 'tiktok-hoalongchannhan' });
    assert.deepEqual(await w.call('due', { channel: 'tiktok-hoalongchannhan' }), { id: 'P-00000000C1', action: 'publish' });
    // Non-happy: no such row, a malformed key.
    await assert.rejects(w.page('resume', { scope: 'account', channel: 'tiktok-nobody' }), { code: 'not_found' });
    await assert.rejects(w.page('resume', { scope: 'account', channel: 'lohi:tiktok' }), { code: 'invalid_request' });
    // A desk pause on the TikTok cell would stop nothing: refused, the accounts pause one by one.
    await assert.rejects(w.page('pause', { scope: 'channel', channel: 'lohi:tiktok' }), { code: 'invalid_request', message: /scope "account"/ });
    // Pausing a signed-out account keeps it waiting for its sign-in (not a person's pause that hides its card).
    const still = await w.page('pause', { scope: 'account', channel: 'tiktok-lohi' });
    assert.equal(still.unchanged, true);
    assert.equal((await w.row('tiktok-lohi')).paused_reason, 'signed_out');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the misrouted video (repro) and per-account lines (AC1.4, AC1.6) ----------

test('repro: a video folder named as its own product in campaign.json belongs to the product that owns the folder; one TikTok cell with a line per account', async () => {
  const { dir, root } = repo();
  try {
    // mvf writes the folder name as the product; products.json says lohi owns hoa-long-chan-nhan.
    for (const slug of ['k01-thien-thach', 't01-ngu-kiem-com']) {
      put(root, `channels/hoa-long-chan-nhan/campaigns/${slug}/campaign.json`, { slug, product: 'hoa-long-chan-nhan', platforms: ['tiktok'] });
      put(root, `channels/hoa-long-chan-nhan/campaigns/${slug}/08-delivery/${slug}-final.mp4`, '');
    }
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    await w.call('library_scan', {});
    const camps = w.store.data.library.filter(r => r.kind === 'campaign');
    assert.deepEqual([...new Set(camps.map(r => r.product))], ['lohi']);
    const sum = await w.call('page_view', { view: 'summary' });
    assert.deepEqual(sum.products.map(p => p.id), ['lohi'], 'a video folder is no product of its own');
    const ch = await w.call('page_view', { view: 'channels' });
    assert.deepEqual(ch.rows.map(r => r.product), ['lohi']);
    const cell = ch.rows[0].cells.tiktok;
    assert.equal(cell.state, 'signed_out');
    assert.notEqual(cell.state, 'manual');
    assert.deepEqual(cell.accounts.map(a => a.account), ['@hoalongchannhan', '@lohi']);
    // The video item names the account its folder posts on, not every handle.
    const item = await w.call('page_view', { view: 'item', ref: camps.find(r => r.campaign === 'k01-thien-thach').ref });
    assert.equal(item.item?.product ?? item.product ?? 'lohi', 'lohi');
    assert.equal(item.video.account, '@hoalongchannhan');
    assert.equal(item.video.channel_key, 'tiktok-hoalongchannhan');
    // Hôm nay: a signed-out TikTok account is a blocker that opens the cell's sheet, hubless as this desk is.
    const today = await w.call('page_view', { view: 'today' });
    const b = today.blockers.find(x => x.id === 'signed_out:lohi:tiktok');
    assert.ok(b, JSON.stringify(today.blockers.map(x => x.id)));
    assert.deepEqual(b.do, { label_code: 'fix_channel', sheet: { kind: 'channel', key: 'lohi:tiktok' } });
    assert.equal(b.title_args.account, '@hoalongchannhan, @lohi');
    // Kênh cần sửa counts it with no hub: the desk knows its own browser rows.
    const tile = sum.tiles.find(t => t.id === 'channels');
    assert.deepEqual([tile.value, tile.why ?? null, tile.tone, tile.sub_args.key], [1, null, 'err', 'lohi:tiktok']);
    // Both accounts running: no blocker, nothing to fix.
    for (const k of ['tiktok-lohi', 'tiktok-hoalongchannhan']) await w.page('resume', { scope: 'account', channel: k });
    assert.equal((await w.call('page_view', { view: 'today' })).blockers.some(x => x.id === 'signed_out:lohi:tiktok'), false);
    assert.equal((await w.call('page_view', { view: 'summary' })).tiles.find(t => t.id === 'channels').value, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a hubless desk with no browser channel of its own still says it cannot tell (Kênh cần sửa stays blind)', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    const tile = (await w.call('page_view', { view: 'summary' })).tiles.find(t => t.id === 'channels');
    assert.deepEqual([tile.value, tile.why], [null, 'hubless']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const TT_CAMP = 'marketing/channels/lohi-truyen/campaigns/nghe-thu';
const TT_DIR = `${TT_CAMP}/08-delivery/s1/9x16/tiktok`;
function tiktokCampaign(root) {
  const base = dirname(root);
  put(base, `${TT_CAMP}/campaign.json`, { slug: 'nghe-thu', product: 'lohi' });
  put(base, `${TT_CAMP}/05-scripts/s1.json`, { id: 's1', spine: { question: 'Nghe thử' }, beats: [{ role: 'hook', onscreen: 'Nghe thử một cảnh' }], variants: [{ id: 'H1', onscreen: 'Nghe thử một cảnh' }] });
  put(base, `${TT_CAMP}/06-pretest/r1/decision.json`, { method: 'simulated-panel', winner: 's1/H1', decided_at: '2026-11-23T02:00:00Z' });
  put(base, `${TT_CAMP}/06-pretest/r1/microfish/judge.json`, { sim: 'micro-fish', caveat: 'Panel mô phỏng.', stimuli: { A: { id: 's1/H1', kind: 'candidate', n: 40, watch_through: 44, intent_top2: 30 }, C: { id: 'control', kind: 'control', n: 40, watch_through: 22 } } });
  put(base, `${TT_DIR}/s1-H1-tiktok.mp4`, 'fake mp4');
  put(base, `${TT_DIR}/cover.jpg`, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]));
  put(base, `${TT_DIR}/caption.txt`, 'Nghe thử một cảnh truyện audio, đủ mê trong 16 giây. #truyenaudio');
  put(base, `${TT_CAMP}/08-delivery/s1/9x16/delivery.json`, { script: 's1', hook: 'H1', canvas: '9x16', draft: false, files: { tiktok: { video: '08-delivery/s1/9x16/tiktok/s1-H1-tiktok.mp4', fails: 0, warns: 0, qa: [{ level: 'PASS', code: 'Q0', msg: '1080x1920 30fps 16.32s 5.2MB' }] } }, ai_disclosure: { photoreal: false, tiktok: 'ON', why: ['generated art'] } });
}

test('video_import accepts a TikTok channel; the draft is checked, scheduled and claimed with the profile, the account and the campaign link', async () => {
  const { dir, root } = repo();
  try {
    tiktokCampaign(root);
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    await w.page('resume', { channel: 'tiktok-lohi' });
    // A running campaign with a tiktok link: the video goes out with it.
    await w.store.insert('campaigns', { key: 'nov', name: 'Tháng 11', state: 'active', channels: ['x-lohi', 'tiktok'], starts: '2026-11-01', ends: '2026-11-30' });
    await w.store.insert('links', { code: 'nov-tiktok', campaign: 'nov', channel: 'tiktok', post: null, target: 'https://lohi2.com/?utm_source=tiktok', url: 'https://api.lohi2.com/r/aB3dE' });
    const out = await w.call('video_import', { request_id: 'v-1', campaign: TT_CAMP, channels: ['tiktok-lohi'] });
    assert.equal(out.posts.length, 1, JSON.stringify(out));
    assert.deepEqual([out.posts[0].channel, out.posts[0].state, out.posts[0].hold], ['tiktok-lohi', 'draft', null]);
    const p = w.store.data.posts.find(x => x.channel === 'tiktok-lohi');
    assert.equal(p.kind, 'video');
    assert.equal(p.link, 'https://api.lohi2.com/r/aB3dE');
    assert.equal(p.campaign, 'nov');
    const c = await w.call('check', { id: p.ref, revision: p.revision, verdict: 'pass', reasons: [] });
    assert.equal(c.verdict, 'pass', JSON.stringify(c.auto));
    await w.call('schedule', { id: p.ref, scheduled_at: new Date(w.now - MIN).toISOString() });
    const { claim } = await w.call('claim', { id: p.ref, action: 'publish' });
    assert.equal(verifyClaim(claim, KEY, w.now), null);
    assert.deepEqual([claim.platform, claim.kind, claim.profile], ['tiktok', 'video', 'tiktok-lohi']);
    assert.equal(claim.assets[0].kind, 'video');
    assert.match(JSON.stringify(claim), /@lohi/);
    // The profile is signed: another profile does not verify.
    assert.notEqual(verifyClaim({ ...claim, profile: 'tiktok-other' }, KEY, w.now), null);
    // A video for a channel that is not TikTok-shaped is still refused.
    const bad = await w.call('video_import', { request_id: 'v-2', campaign: TT_CAMP, channels: ['reddit-lohi'] }).catch(e => e);
    assert.match(String(bad.message ?? JSON.stringify(bad)), /kênh khác|không/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('from_products makes account channels only, never a channel for the campaign link slug', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    assert.equal(await w.row('tiktok'), null, 'no phantom sign-in card for the link slug');
    // campaign_save with the slug needs the api: the rule is pinned in campaigns.test.mjs; here the stored rows hold only account channels.
    assert.deepEqual(w.store.data.channels.map(c => c.key).sort(), ['tiktok-hoalongchannhan', 'tiktok-lohi']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- video_brief ----------

const START_KEYS = ['dir', 'key', 'prompt', 'title'];
const article = (w, ref, title, state = 'published', url = 'https://blog.lohi2.com/x') => w.store.insert('posts', { ref, kind: 'article', channel: 'blog-lohi', title, brief: { title, slug: ref.toLowerCase() }, body: `${title}. Một bài về truyện audio.`, state, revision: 1, content_hash: 'h', url });

test('video_brief answers the exact claude-code_start input for the newest published post without a video, once a day', async () => {
  const { dir, root } = repo();
  try {
    const w = await (async () => { const x = world(root); await x.call('channels_setup', { from_products: true, channels: [] }); return x; })();
    await article(w, 'P-000000000A', 'Bài cũ về truyện cổ', 'published');
    await w.store.update('posts', [eq('ref', 'P-000000000A')], { updated_at: new Date(T0 - 5 * DAY).toISOString() }).catch(() => {});
    await article(w, 'P-000000000B', 'Địa ngục cấm nói đời', 'published');
    await article(w, 'P-000000000C', 'Bản nháp chưa đăng', 'draft', null);
    const input = { product: 'lohi', channels: ['tiktok-lohi'] };
    const out = await w.call('video_brief', input);
    assert.deepEqual(Object.keys(out).sort(), START_KEYS);
    assert.match(out.key, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.match(out.key, /^video-lohi-dia-nguc-cam-noi-doi-1124$/);
    assert.ok(out.title.length <= 120 && out.title.includes('Địa ngục cấm nói đời'));
    assert.equal(out.dir, dir, 'the repository that holds MARKETING_ROOT');
    assert.ok(out.prompt.length <= 20000);
    for (const must of [join(dir, '2build/skills/marketing-video/SKILL.md'), 'mvf init dia-nguc-cam-noi-doi-1124 --product "lohi" --channel lohi-truyen', 'mvf approve <sid> --verdict delegated', 'mvf next', '08-delivery', 'NEVER post', 'P-000000000B', '"ok": false', '"channels": ["tiktok-lohi"]', 'marketing/channels/lohi-truyen/campaigns/dia-nguc-cam-noi-doi-1124'])
      assert.ok(out.prompt.includes(must), must);
    assert.ok(!out.prompt.includes('Bản nháp chưa đăng'), 'a draft is no source');
    // The request id the prompt names fits video_import, which takes exactly {request_id, campaign, channels, parent}.
    assert.match(out.prompt, /"request_id": "vb-[0-9a-f]{12}"/);
    // The same day: nothing more for this product and channel folder.
    const again = await w.call('video_brief', input);
    assert.equal(again.done, true);
    assert.equal(again.key, undefined);
    // Two days later with every_days 1: the next source is the older post (the first is briefed and waits for its video).
    w.now = T0 + 2 * DAY;
    const next = await w.call('video_brief', input);
    assert.match(next.prompt, /P-000000000A/);
    // every_days 7 holds the following brief for a week.
    w.now = T0 + 3 * DAY;
    assert.equal((await w.call('video_brief', { ...input, every_days: 7 })).done, true);
    // A source that already has a video for the channel is skipped.
    await w.store.insert('posts', { ref: 'P-00000000D1', kind: 'video', channel: 'tiktok-lohi', parent: 'P-000000000A', body: 'v', state: 'draft', revision: 1, content_hash: 'h2' });
    w.now = T0 + 10 * DAY;
    const last = await w.call('video_brief', { ...input, every_days: 1 });
    assert.match(last.prompt ?? '', /P-000000000B/, 'the briefed post whose video never came back is offered again after the retry window');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('video_brief, non-happy: no source is done; no skill file, no root or an unknown product is a thrown refusal (a chain fails loudly)', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    assert.deepEqual(Object.keys(await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] })), ['done', 'reason']);
    assert.equal((await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] })).reason, 'no_source');
    await article(w, 'P-000000000B', 'Một bài', 'published');
    // MVF_SKILL wins over the default path; a wrong one is an error answer, not a crash.
    const w2 = world(root, { MVF_SKILL: join(dir, 'nope.md') });
    await article(w2, 'P-000000000B', 'Một bài', 'published');
    await assert.rejects(w2.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] }), { code: 'not_configured', message: /MVF_SKILL/ });
    await assert.rejects(world(root, { MARKETING_ROOT: undefined }).call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] }), { code: 'not_configured', message: /MARKETING_ROOT/ });
    await assert.rejects(w.call('video_brief', { product: 'other', channels: ['tiktok-lohi'] }), { code: 'not_found', message: /products\.json/ });
    for (const bad of [{ channels: [] }, { channels: ['blog-lohi'] }, { channels: ['tiktok-lohi', 'tiktok-hoalongchannhan'] }, { every_days: 0 }, { product: 'Lohi!' }, { source_state: 'draft' }])
      await assert.rejects(w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'], ...bad }), { code: 'invalid_request' }, JSON.stringify(bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const none = repo({ skill: false });
  try {
    const w = world(none.root);
    await article(w, 'P-000000000B', 'Một bài', 'published');
    await assert.rejects(w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] }), { code: 'not_configured', message: /marketing-video\/SKILL\.md/ });
  } finally { rmSync(none.dir, { recursive: true, force: true }); }
  // A video channel folder that is not there, and a product with no TikTok account to cover.
  const gone = repo({ products: { products: [{ id: 'lohi', name: 'Lohi', video_channels: ['nowhere'] }] } });
  try {
    const w = world(gone.root);
    await assert.rejects(w.call('video_brief', { product: 'lohi', channels: ['x-lohi'] }), { code: 'not_found', message: /channels\/nowhere/ });
    await assert.rejects(w.call('video_brief', { product: 'lohi' }), { code: 'not_found', message: /no TikTok account/ });
  } finally { rmSync(gone.dir, { recursive: true, force: true }); }
});

test('video_brief is a write tool with a strict schema that names only what it takes', async () => {
  const pack = readFileSync(new URL('../pack.json', import.meta.url), 'utf8');
  const t = JSON.parse(pack).tools.find(x => x.name === 'video_brief');
  assert.equal(t.run.mode, 'write');
  assert.equal(t.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(t.parameters.properties).sort(), ['channels', 'every_days', 'product', 'source_state']);
  assert.deepEqual(t.parameters.required, ['product'], 'channels left out covers every TikTok account');
  assert.equal(t.run.env, undefined);
  assert.deepEqual(t.run.secret_env, { MARKETING_ROOT: '{{cred:MARKETING_ROOT}}' });
});

// ---------- every TikTok account (AC4.5) ----------

test('video_brief with no channels briefs the account whose turn is next, one per fire, until each account has its brief', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    await article(w, 'P-000000000B', 'Địa ngục cấm nói đời', 'published');
    const first = await w.call('video_brief', { product: 'lohi' });
    assert.deepEqual(Object.keys(first).sort(), START_KEYS);
    assert.ok(first.prompt.includes('"channels": ["tiktok-hoalongchannhan"]') && first.prompt.includes('--channel hoa-long-chan-nhan'), 'never briefed: the first account by name');
    const second = await w.call('video_brief', { product: 'lohi' });
    assert.ok(second.prompt.includes('"channels": ["tiktok-lohi"]') && second.prompt.includes('--channel lohi-truyen'), 'the next fire takes the other account');
    assert.deepEqual([first.key, second.key], ['video-lohi-hoa-long-chan-nhan-dia-nguc-cam-noi-doi-1124', 'video-lohi-dia-nguc-cam-noi-doi-1124'], 'one job key per account: the second is never "already running"');
    assert.deepEqual(await w.call('video_brief', { product: 'lohi' }), { done: true, reason: 'already_briefed' });
    // The next day the account briefed longest ago goes first again, with a new post (a post briefed for a folder waits days).
    w.now = T0 + DAY;
    await article(w, 'P-000000000D', 'Kiếm khách cuối cùng', 'published');
    const third = await w.call('video_brief', { product: 'lohi' });
    assert.ok(third.prompt.includes('"channels": ["tiktok-hoalongchannhan"]'));
    // An explicit channel keeps working and keeps its own slot.
    assert.deepEqual(await w.call('video_brief', { product: 'lohi', channels: ['tiktok-hoalongchannhan'] }), { done: true, reason: 'already_briefed' });
    // A retired row is never an account to cover.
    await w.store.update('channels', [eq('key', 'tiktok-lohi')], { paused: true, paused_reason: 'retired' });
    w.now = T0 + 2 * DAY;
    await article(w, 'P-000000000E', 'Tiếng đàn trong núi', 'published');
    const only = await w.call('video_brief', { product: 'lohi' });
    assert.ok(only.prompt.includes('"channels": ["tiktok-hoalongchannhan"]'));
    assert.deepEqual(await w.call('video_brief', { product: 'lohi' }), { done: true, reason: 'already_briefed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('video_brief, non-happy: an account whose folder is missing never starves the others; with nothing briefed its refusal is thrown', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    // tiktok-hoalongchannhan sorts first and points at a folder that is not there.
    const row = await w.row('tiktok-hoalongchannhan');
    await w.store.update('channels', [eq('key', 'tiktok-hoalongchannhan')], { rules: { ...row.rules, video_channel: 'missing-folder' } });
    await article(w, 'P-000000000B', 'Địa ngục cấm nói đời', 'published');
    const out = await w.call('video_brief', { product: 'lohi' });
    assert.ok(out.prompt.includes('"channels": ["tiktok-lohi"]'), 'the configured account gets its brief');
    // Nothing left to brief: the broken account's refusal fails the chain loudly.
    await assert.rejects(w.call('video_brief', { product: 'lohi' }), { code: 'not_found', message: /channels\/missing-folder/ });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('due {platform: "tiktok"} picks the oldest due publish across every live tiktok-* account; channel still works; a paused account is skipped', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    for (const c of ['tiktok-lohi', 'tiktok-hoalongchannhan']) await w.page('resume', { scope: 'account', channel: c });
    assert.deepEqual(await w.call('due', { schedule: true, platform: 'tiktok' }), { done: true });
    const queue = async (ref, channel, ago) => {
      await w.store.insert('posts', { ref, kind: 'video', channel, brief: { title: ref }, body: ref, state: 'scheduled', revision: 1, content_hash: `h-${ref}` });
      await w.store.insert('queue', { post: ref, channel, action: 'publish', scheduled_at: new Date(w.now - ago).toISOString(), attempts: 0 });
    };
    await queue('P-00000000E1', 'tiktok-lohi', 10 * MIN);
    await queue('P-00000000E2', 'tiktok-hoalongchannhan', 30 * MIN);
    assert.deepEqual(await w.call('due', { schedule: true, platform: 'tiktok' }), { id: 'P-00000000E2', action: 'publish' }, 'the older one, whichever account');
    assert.deepEqual(await w.call('due', { schedule: true, channel: 'tiktok-lohi' }), { id: 'P-00000000E1', action: 'publish' });
    await w.page('pause', { scope: 'account', channel: 'tiktok-hoalongchannhan' });
    assert.deepEqual(await w.call('due', { schedule: true, platform: 'tiktok' }), { id: 'P-00000000E1', action: 'publish' }, 'a paused account is skipped');
    await w.page('pause', { scope: 'account', channel: 'tiktok-lohi' });
    assert.deepEqual(await w.call('due', { schedule: true, platform: 'tiktok' }), { done: true, reason: 'paused' });
    await assert.rejects(w.call('due', { platform: 'myspace' }), { code: 'invalid_request' });
    // The dispatch's skip may name the platform: the chain posts every account, so the Editor is not woken for one.
    await w.page('resume', { scope: 'account', channel: 'tiktok-lohi' });
    const d = await w.call('due', { schedule: true, skip: ['tiktok'] });
    assert.ok(!d.publish.includes('P-00000000E1'), JSON.stringify(d.publish));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the Claude Code ledger (AC4.3, AC4.6) ----------

const ledger = async (w) => (await w.store.one('settings', [eq('key', 'video_jobs')]))?.value?.jobs ?? [];

test('video_job records the start; a busy machine frees the brief for the next fire; the desk shows each job', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    await article(w, 'P-000000000B', 'Địa ngục cấm nói đời', 'published');
    const brief = await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] });
    // claude-code_start's busy answer, as the chain hands it on: nothing started, the slot is freed.
    const busy = await w.call('video_job', { started: false, waiting: 'busy', key: brief.key, title: brief.title, running: [{ id: 'j-0', key: 'video-other', title: 'Video khác', minutes: 12 }] });
    assert.deepEqual(busy, { ok: true, state: 'waiting', key: brief.key, freed: true, notify: false });
    assert.deepEqual((await ledger(w)).map(j => [j.key, j.state, j.product]), [[brief.key, 'waiting', 'lohi']]);
    const again = await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] });
    assert.equal(again.key, brief.key, 'the next fire briefs the same source again instead of losing the day');
    // The start: running with its id, log and start time; an `already` answer for the same job changes nothing.
    const started = await w.call('video_job', { started: true, id: 'j-1', key: brief.key, title: brief.title, log: '/jobs/j-1/log.jsonl', result_path: '/jobs/j-1/result.json' });
    assert.deepEqual(started, { ok: true, state: 'running', id: 'j-1', key: brief.key, notify: false });
    await w.call('video_job', { started: false, already: true, id: 'j-1', key: brief.key, title: brief.title, log: '/jobs/j-1/log.jsonl' });
    const jobs = await ledger(w);
    assert.deepEqual(jobs.map(j => [j.id, j.state, j.started_at, j.log]), [['j-1', 'running', new Date(w.now).toISOString(), '/jobs/j-1/log.jsonl']]);
    w.now += 25 * MIN;
    const v = await w.call('page_view', { view: 'content' });
    assert.deepEqual(v.claude_code.counts, { running: 1, waiting: 0, done: 0, failed: 0 });
    assert.deepEqual([v.claude_code.rows[0].state, v.claude_code.rows[0].minutes, v.claude_code.rows[0].log_tail], ['running', 25, null]);
    // Non-happy: no key, no id, nothing to record.
    await assert.rejects(w.call('video_job', { started: true, id: 'j-2' }), { code: 'invalid_request' });
    await assert.rejects(w.call('video_job', { started: true, key: 'video-x' }), { code: 'invalid_request', message: /id/ });
    await assert.rejects(w.call('video_job', { key: 'video-x' }), { code: 'invalid_request' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('video_import records how the job ended: done with its drafts, a failed job loudly with its reason and last words; the old result input still works', async () => {
  const { dir, root } = repo();
  try {
    tiktokCampaign(root);
    const w = world(root);
    await w.call('channels_setup', { from_products: true, channels: [] });
    const key = 'video-lohi-nghe-thu-1124';
    await w.call('video_job', { started: true, id: 'j-1', key, title: 'Video: Nghe thử', log: '/jobs/j-1/log.jsonl' });
    // emit "job", success: {job, result}.
    const ok = await w.call('video_import', { job: { id: 'j-1', key, title: 'Video: Nghe thử', state: 'done', last_text: 'Đã ghi kết quả.' }, result: { request_id: requestIdOf(key), campaign: TT_CAMP, channels: ['tiktok-lohi'] } });
    assert.equal(ok.posts.length, 1, JSON.stringify(ok));
    let j = (await ledger(w)).find(x => x.id === 'j-1');
    assert.deepEqual([j.state, j.posts, j.error], ['done', [ok.posts[0].id], null]);
    // emit "job", failure: recorded, then a loud answer that fails the chain and wakes the Soot.
    const key2 = 'video-lohi-kiem-khach-1124';
    await w.call('video_job', { started: true, id: 'j-2', key: key2, title: 'Video: Kiếm khách' });
    const bad = await w.call('video_import', { notify: true, job: { id: 'j-2', key: key2, title: 'Video: Kiếm khách', state: 'failed', error: 'exit code 1', last_text: 'mvf FAIL: render 9x16 thiếu font' } });
    assert.deepEqual([bad.ok, bad.notify, bad.job], [false, true, { id: 'j-2', key: key2, state: 'failed' }]);
    assert.match(bad.error, /^job_failed: Claude Code job video-lohi-kiem-khach-1124 failed: exit code 1$/);
    j = (await ledger(w)).find(x => x.id === 'j-2');
    assert.deepEqual([j.state, j.error, j.log_tail], ['failed', 'exit code 1', 'mvf FAIL: render 9x16 thiếu font']);
    // A finished job with no result is a failure too.
    const empty = await w.call('video_import', { job: { id: 'j-3', key: 'video-lohi-trong-1124', state: 'done' } });
    assert.deepEqual([empty.ok, empty.notify], [false, true]);
    assert.match(empty.error, /left no result/);
    // emit "result" (the old recipe): the entry is found by the result's request id.
    const key4 = 'video-lohi-tieng-dan-1124';
    await w.call('video_job', { started: true, id: 'j-4', key: key4, title: 'Video: Tiếng đàn' });
    const old = await w.call('video_import', { request_id: requestIdOf(key4), campaign: TT_CAMP, channels: ['tiktok-lohi'] });
    assert.ok(old.posts.length === 1);
    assert.equal((await ledger(w)).find(x => x.id === 'j-4').state, 'done');
    // The desk: each state in a person's words, the failure with its reason.
    const v = await w.call('page_view', { view: 'content' });
    assert.deepEqual(v.claude_code.counts, { running: 0, waiting: 0, done: 2, failed: 2 });
    assert.equal(v.claude_code.rows.find(r => r.id === 'j-2').log_tail, 'mvf FAIL: render 9x16 thiếu font');
    // Non-happy: job with other keys, and a result with keys import does not take.
    await assert.rejects(w.call('video_import', { job: { id: 'j-5', key: 'video-x', state: 'done' }, campaign: TT_CAMP }), { code: 'invalid_request' });
    await assert.rejects(w.call('video_import', { job: { id: 'j-6', key: 'video-y', state: 'done' }, result: { request_id: 'r', campaign: TT_CAMP, channels: ['tiktok-lohi'], extra: 1 } }), { code: 'invalid_request', message: /extra/ });
    assert.equal((await ledger(w)).find(x => x.id === 'j-6').state, 'failed', 'a result import refuses is still recorded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a finished job is dropped from the ledger after 14 days; a running one stays until its end, or 3 days when the end is lost', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    await w.call('video_job', { started: true, id: 'j-1', key: 'video-lohi-a-1124', title: 'A' });
    await w.call('video_job', { started: true, id: 'j-2', key: 'video-lohi-b-1124', title: 'B' });
    await w.call('video_import', { notify: true, job: { id: 'j-1', key: 'video-lohi-a-1124', state: 'failed', error: 'exit code 1' } });
    w.now += 2 * DAY;
    await w.call('video_job', { started: true, id: 'j-3', key: 'video-lohi-c-1126', title: 'C' });
    assert.deepEqual((await ledger(w)).map(j => j.id).sort(), ['j-1', 'j-2', 'j-3'], 'a running job outlives any claude-code timeout (12 hours at most)');
    w.now += 13 * DAY;
    await w.call('video_job', { started: true, id: 'j-4', key: 'video-lohi-d-1209', title: 'D' });
    // j-2 and j-3 never got an end (no watch schedule): dropped, not shown running for good.
    assert.deepEqual((await ledger(w)).map(j => j.id).sort(), ['j-4']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
