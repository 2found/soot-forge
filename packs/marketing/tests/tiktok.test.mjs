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
import { isLegacyTiktok } from '../tools/lib/ops.mjs';
import { tiktokAccounts, tiktokChannelId } from '../tools/lib/library.mjs';

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

test('an old-default tiktok row moves to the browser defaults, paused for a person; a row a person set to hand, or capped, is left alone', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    const old = { kind: 'video', publisher: 'hand', cap_per_day: 0, spacing_min: 0, reply_cap_per_day: 0, paused: false, paused_reason: null, rules: {}, account: null, platform: 'tiktok' };
    await w.store.insert('channels', { key: 'tiktok', ...old });
    await w.store.insert('channels', { key: 'tiktok-hand', ...old, rules: { publisher_by: 'person' } });
    await w.store.insert('channels', { key: 'tiktok-capped', ...old, cap_per_day: 1 });
    assert.equal(isLegacyTiktok(await w.row('tiktok')), true);
    assert.equal(isLegacyTiktok(await w.row('tiktok-hand')), false);
    assert.equal(isLegacyTiktok(await w.row('tiktok-capped')), false);
    await w.call('channels_setup', { channels: [{ id: 'tiktok' }, { id: 'tiktok-hand' }, { id: 'tiktok-capped' }] });
    const m = await w.row('tiktok');
    assert.deepEqual([m.publisher, m.cap_per_day, m.spacing_min, m.paused, m.paused_reason], ['browser', 2, 240, true, 'person']);
    assert.equal((await w.row('tiktok-hand')).publisher, 'hand');
    const c = await w.row('tiktok-capped');
    assert.deepEqual([c.publisher, c.cap_per_day], ['hand', 1]);
    // A person's own word: setting hand through channels_setup is kept against a later default.
    await w.call('channels_setup', { channels: [{ id: 'tiktok-lohi', publisher: 'hand' }] });
    const h = await w.row('tiktok-lohi');
    assert.deepEqual([h.publisher, h.rules.publisher_by], ['hand', 'person']);
    await w.call('channels_setup', { channels: [{ id: 'tiktok-lohi' }] });
    assert.equal((await w.row('tiktok-lohi')).publisher, 'hand');
    // set_limits changes the profile and the publisher from the desk.
    const set = await w.page('set_limits', { channel: 'tiktok-lohi', profile: 'tiktok-lohi', publisher: 'browser' });
    assert.ok(!set.error, JSON.stringify(set));
    const after = await w.row('tiktok-lohi');
    assert.deepEqual([after.publisher, after.rules.profile], ['browser', 'tiktok-lohi']);
    await assert.rejects(w.page('set_limits', { channel: 'tiktok-lohi', profile: 'bad profile' }));
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

test('video_brief, non-happy: no source, no skill file, no root, a bad channel and bad input each answer plainly', async () => {
  const { dir, root } = repo();
  try {
    const w = world(root);
    assert.deepEqual(Object.keys(await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] })), ['done', 'reason']);
    assert.equal((await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] })).reason, 'no_source');
    await article(w, 'P-000000000B', 'Một bài', 'published');
    // MVF_SKILL wins over the default path; a wrong one is an error answer, not a crash.
    const w2 = world(root, { MVF_SKILL: join(dir, 'nope.md') });
    await article(w2, 'P-000000000B', 'Một bài', 'published');
    const miss = await w2.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /MVF_SKILL/);
    const noRoot = await world(root, { MARKETING_ROOT: undefined }).call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] });
    assert.equal(noRoot.ok, false);
    assert.match(noRoot.error, /MARKETING_ROOT/);
    for (const bad of [{ channels: [] }, { channels: ['blog-lohi'] }, { channels: ['tiktok-lohi', 'tiktok-hoalongchannhan'] }, { every_days: 0 }, { product: 'Lohi!' }, { source_state: 'draft' }])
      await assert.rejects(w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'], ...bad }), { code: 'invalid_request' }, JSON.stringify(bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const none = repo({ skill: false });
  try {
    const w = world(none.root);
    await article(w, 'P-000000000B', 'Một bài', 'published');
    const out = await w.call('video_brief', { product: 'lohi', channels: ['tiktok-lohi'] });
    assert.equal(out.ok, false);
    assert.match(out.error, /marketing-video\/SKILL\.md/);
  } finally { rmSync(none.dir, { recursive: true, force: true }); }
});

test('video_brief is a write tool with a strict schema that names only what it takes', async () => {
  const pack = readFileSync(new URL('../pack.json', import.meta.url), 'utf8');
  const t = JSON.parse(pack).tools.find(x => x.name === 'video_brief');
  assert.equal(t.run.mode, 'write');
  assert.equal(t.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(t.parameters.properties).sort(), ['channels', 'every_days', 'product', 'source_state']);
  assert.deepEqual(t.parameters.required, ['product', 'channels']);
  assert.equal(t.run.env, undefined);
  assert.deepEqual(t.run.secret_env, { MARKETING_ROOT: '{{cred:MARKETING_ROOT}}' });
});
