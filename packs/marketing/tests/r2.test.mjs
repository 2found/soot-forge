// Friction round 2 (W1): a ready draft never stalls the plan, the blog publishes as a tool chain,
// social drafts follow a published post only for a signed-in channel, the plan learns from results,
// the sign-in probe, page actions without the admin key, and a lean tool surface.
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
/** A blog post published by the real chain tools, with a stand-in publisher. */
async function published(w, kw, slug) {
  const id = await passed(w, kw, slug);
  const s = await w.call('schedule', { id });
  w.now = Date.parse(s.scheduled_at) + 60_000;
  const due = await w.call('due', { schedule: true, channel: 'blog-lohi' });
  const c = await w.call('claim', due);
  const url = `https://blog.lohi2.com/truyen-hay/${slug}/vi/`;
  await w.call('record', { ok: true, status: 'published', url, platform_id: 'abc', intent_id: c.claim.intent_id });
  return { id, url };
}

test('a ready draft nobody scheduled is queued by the plan itself after an hour; a younger one waits; nothing wakes the Writer', async () => {
  const w = world();
  await w.call('plan', { ...WAKE, wake: true });
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  w.now += 30 * 60_000;
  const early = await w.call('plan', WAKE);
  assert.deepEqual([early.wake, early.code, early.scheduled], [false, 'draft_open', undefined], 'under an hour: left to its writer');
  w.now += H;
  const out = await w.call('plan', WAKE);
  assert.equal(out.scheduled[0].id, id);
  assert.deepEqual([out.wake, out.notify, out.code], [false, false, 'queued']);
  assert.equal((await w.call('items', { state: 'scheduled' })).items[0].id, id);
});

test('a draft open for more than a day never blocks the plan and is reported once', async () => {
  const w = world();
  await w.call('plan', WAKE);
  const d = await w.call('draft_save', article('truyện ngôn tình hay', 'ngon-tinh-hay-nhat-2026'));
  w.now += 2 * DAY;
  const out = await w.call('plan', WAKE);
  assert.equal(out.wake, true, 'the old draft does not hold the slot');
  const first = await w.call('report', {});
  assert.ok(first.lines.some(l => l.includes(d.id) && /mở hơn một ngày/.test(l)));
  const second = await w.call('report', {});
  assert.ok(!second.lines.some(l => l.includes(d.id)), 'told once');
  assert.ok(first.lines.length <= 6);
});

test('blog chain: due → claim → publish → record publishes with no model, and a second pass is quiet', async () => {
  const w = world();
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  const s = await w.call('schedule', { id });
  // Not yet due: the chain stops quietly.
  assert.deepEqual(await w.call('due', { schedule: true, channel: 'blog-lohi' }), { done: true });
  w.now = Date.parse(s.scheduled_at) + 60_000;
  const step1 = await w.call('due', { schedule: true, channel: 'blog-lohi' });
  assert.deepEqual(step1, { id, action: 'publish' }, 'exactly the claim input');
  const step2 = await w.call('claim', step1);
  assert.ok(step2.claim.sig && step2.claim.intent_id);
  const step3 = { ok: true, status: 'published', url: 'https://blog.lohi2.com/truyen-hay/tien-hiep-hay-nhat-2026/vi/', platform_id: 'sha', intent_id: step2.claim.intent_id };
  const rec = await w.call('record', step3);
  assert.equal(rec.state, 'published');
  assert.equal(rec.outcome.id, 'post_published');
  assert.deepEqual(await w.call('due', { schedule: true, channel: 'blog-lohi' }), { done: true });
});

test('blog chain, non-happy: paused, quiet hours, a refused claim and a claim in flight all stop quietly; the Editor dispatch skips the blog', async () => {
  const w = world();
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  const s = await w.call('schedule', { id });
  w.now = Date.parse(s.scheduled_at) + 60_000;
  // The Editor's own dispatch does not claim a chain channel.
  const social = await w.call('due', { schedule: true, skip: ['blog-lohi'] });
  assert.deepEqual([social.publish, social.notify], [[], false]);
  assert.equal((await w.call('due', {})).publish[0], id, 'without skip it is still listed');
  // Quiet hours.
  const keep = w.now; w.now = Date.parse('2026-11-10T17:00:00Z'); // 00:00 ICT
  assert.equal((await w.call('due', { schedule: true, channel: 'blog-lohi' })).done, true);
  w.now = keep;
  // Paused team.
  await w.call('pause', { paused: true });
  assert.equal((await w.call('due', { schedule: true, channel: 'blog-lohi' })).reason, 'paused');
  const refused = await w.call('claim', { id, action: 'publish' });
  assert.deepEqual([refused.refused.code, refused.done], ['paused', true], 'a refused claim ends the chain quietly');
  await w.call('pause', { paused: false });
  // In flight: the open intent is not claimed again until it is stale.
  const c = await w.call('claim', { id, action: 'publish' });
  assert.ok(c.claim);
  assert.deepEqual(await w.call('due', { schedule: true, channel: 'blog-lohi' }), { done: true });
  w.now += 31 * 60_000;
  assert.deepEqual(await w.call('due', { schedule: true, channel: 'blog-lohi' }), { id, action: 'publish' }, 'a stuck intent is re-claimed (verify first)');
  assert.equal((await w.call('claim', { id, action: 'publish' })).verify_first, true);
});

test('blog chain, step failure: the publisher answers ok:false with the intent id and fail releases it for a retry', async () => {
  const w = world();
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  const s = await w.call('schedule', { id });
  w.now = Date.parse(s.scheduled_at) + 60_000;
  const c = await w.call('claim', await w.call('due', { schedule: true, channel: 'blog-lohi' }));
  const { asChainStep } = await import(new URL('examples/lohi-marketing/packs/lohi-blog/tools/blog.mjs', root));
  const bad = asChainStep({ status: 'failed', reason: 'push_rejected', retry: true }, c.claim);
  assert.deepEqual([bad.ok, bad.intent_id], [false, c.claim.intent_id]);
  const f = await w.call('fail', { intent_id: bad.intent_id, status: 'failed', reason: bad.reason });
  assert.equal(f.state, 'failed');
  assert.equal((await w.call('items', { state: 'failed' })).items[0].id, id);
});

test('due says resolves_need only when no need is left', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi' }] });
  const open = await w.call('due', { schedule: true });
  assert.equal(open.resolves_need, false, 'x-lohi is signed out: a need');
  await w.call('pause', { channel: 'x-lohi', paused: false });
  assert.equal((await w.call('due', { schedule: true })).resolves_need, true);
});

// ---------- social ----------

test('social: a signed-out or paused channel gets nothing and costs no model turn; a live one asks for one draft per published post', async () => {
  const w = world();
  await w.call('plan', WAKE);
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'lohi2com' }, { id: 'facebook-lohi' }] });
  const post = await published(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  w.now += H;
  assert.deepEqual(await socialPending(w.store, { channel: 'blog-lohi' }, { paused_all: false }, w.now), [], 'all signed out: nothing');
  const quiet = await w.call('plan', WAKE);
  assert.equal(quiet.social, undefined);
  assert.equal(quiet.wake, false, 'the blog slot is queued/spent and no channel is live: no wake');
  // The founder confirmed X and pressed Bật.
  await w.call('pause', { channel: 'x-lohi', paused: false });
  const wake = await w.call('plan', WAKE);;
  assert.deepEqual([wake.wake, wake.kind, wake.social], [true, 'social', 1]);
  const brief = await w.call('plan', {});
  assert.ok(brief.social, 'the brief carries the social work');
  const item = brief.social[0];
  assert.equal(item.post, post.id);
  assert.deepEqual(item.channels.map(c => c.channel), ['x-lohi'], 'Facebook is still signed out');
  const link = new URL(item.channels[0].link);
  assert.deepEqual([link.origin, link.searchParams.get('utm_source'), link.searchParams.get('utm_medium'), link.searchParams.get('utm_campaign')], ['https://blog.lohi2.com', 'x', 'social', 'blog-tien-hiep-hay-nhat-2026']);
  assert.equal(item.channels[0].max_chars, 280);
  // Not woken again for the same item before 6 hours; the draft ends the need.
  assert.equal((await w.call('plan', WAKE)).wake, false);
  const d = await w.call('draft_save', { kind: 'social', channel: 'x-lohi', request_id: 'sx', link: item.channels[0].link, body: 'Chín bộ tiên hiệp đáng đọc tuần này.', brief: { from: post.id } });
  assert.ok(d.id);
  assert.deepEqual(await socialPending(w.store, { channel: 'blog-lohi' }, { paused_all: false }, w.now), []);
  // A paused team: nothing, even for a live channel.
  await w.call('pause', { paused: true });
  assert.deepEqual(await socialPending(w.store, { channel: 'blog-lohi' }, { paused_all: true }, w.now), []);
});

// ---------- insight ----------

test('insight: with Search Console numbers the plan picks the genre that earned clicks and stops repeating a loser', async () => {
  const w = world({ genres: ['Tiên Hiệp', 'Ngôn Tình', 'Kiếm Hiệp'] });
  await w.call('plan', WAKE);
  const mk = async (kw, slug, clicks, impressions, ageDays) => {
    const row = await w.store.insert('posts', { ref: `P-${String(++n).padStart(10, '0')}`, kind: 'article', channel: 'blog-lohi', body: 'b', state: 'published', url: `https://blog.lohi2.com/truyen-hay/${slug}/vi/`, revision: 1, brief: { keyword: kw, title: kw, slug } });
    await w.store.insert('metrics', { url: `https://blog.lohi2.com/truyen-hay/${slug}/vi/`, source: 'gsc', day: new Date(w.now + DAY).toISOString().slice(0, 10), query: '', clicks, impressions, position: 8, views: null });
    return row;
  };
  await mk('truyện ngôn tình hay', 'nt1', 40, 900, 20);
  await mk('truyện kiếm hiệp hay', 'kh1', 0, 0, 20);
  await mk('truyện kiếm hiệp mới', 'kh2', 0, 0, 20);
  w.now += 20 * DAY; // the posts are now three weeks old
  const brief = await w.call('plan', {});
  assert.equal(brief.source, 'insight');
  assert.equal(brief.genre, 'Ngôn Tình', 'the winner first');
  assert.deepEqual(brief.insight.avoid, ['Kiếm Hiệp']);
  assert.equal(brief.insight.basis, 'Search Console');
  assert.equal(brief.insight.top[0].clicks, 40);
  // Written out: the rest of the winner's angles come before the untried genre, the loser is last.
  const report = await w.call('report', {});
  assert.ok(report.lines.length <= 6 && report.notify);
  assert.match(report.lines.join('\n'), /40 lượt bấm, 900 lượt hiển thị/);
  assert.match(report.lines.join('\n'), /Tiếp theo: viết về/);
});

test('insight: without any numbers the plan keeps its plain rotation and says it has no data', async () => {
  const w = world();
  await w.call('plan', WAKE);
  const brief = await w.call('plan', {});
  assert.equal(brief.source, 'catalog');
  assert.equal(brief.insight, undefined);
  assert.match((await w.call('report', {})).lines.join('\n'), /Chưa có số liệu/);
});

// ---------- the sign-in probe (fixtures: no live login exists) ----------

const SNAP = {
  x_in: '- link "Home"\n- button "Account menu"\n- link "Profile"\n- button "Post"',
  x_out: '- heading "Sign in to X"\n- textbox "Phone, email, or username"\n- button "Next"\n- link "Sign up"',
  fb_in: '- heading "Settings & privacy"\n- link "General account settings"',
  fb_out: '- textbox "Email or phone number"\n- textbox "Password"\n- button "Log in"',
  rd_in: '- button "Open inbox"\n- button "Create post"\n- button "Expand user menu"',
  unknown: '- heading "Something went wrong"\n- button "Try again"',
};
const control = text => ({ session: 'soot-lohi-editor', result: { origin: 'https://x.com', snapshot: text }, resource: { state: 'active' } });

test('probe classifier: signed in, signed out and unsure from page fixtures', () => {
  assert.equal(classify('x', { text: SNAP.x_in }), 'signed_in');
  assert.equal(classify('x', { text: SNAP.x_out }), 'signed_out');
  assert.equal(classify('facebook', { text: SNAP.fb_in }), 'signed_in');
  assert.equal(classify('facebook', { text: SNAP.fb_out }), 'signed_out');
  assert.equal(classify('reddit', { text: SNAP.rd_in }), 'signed_in');
  assert.equal(classify('x', { text: SNAP.unknown }), 'unknown');
  assert.equal(classify('x', { text: '', url: 'https://x.com/i/flow/login' }), 'signed_out');
});

test('probe chain: nothing to probe is quiet; a confirmed, really signed-in channel is unpaused and the need resolves', async () => {
  const w = world();
  assert.deepEqual(await w.call('channels_probe', {}), { done: true, reason: 'nothing_to_probe' });
  await w.call('channels_setup', { channels: [{ id: 'x-lohi' }, { id: 'facebook-lohi' }] });
  // The founder confirmed X ("Đã đăng nhập"): paused with reason signed_in.
  await w.call('pause', { channel: 'x-lohi', paused: true, signed_in: true });
  const start = await w.call('channels_probe', {});
  assert.deepEqual(start, { action: 'navigate', url: 'https://x.com/home' }, 'the browser-use_control input, confirmed channel first');
  const out = await w.call('channels_probe', control(SNAP.x_in));
  assert.deepEqual([out.state, out.unpaused, out.resolves_need], ['signed_in', true, true]);
  const ch = (await w.call('page_view', {}, { page: { page: 'hang-doi' } })).channels.find(c => c.id === 'x-lohi');
  assert.equal(ch.paused, false);
});

test('probe, non-happy: a confirmed channel that is really signed out goes back to its sign-in card; an unsure page changes nothing; an unconfirmed signed-in page only waits for the person', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi' }, { id: 'reddit-lohi' }] });
  await w.call('pause', { channel: 'x-lohi', paused: true, signed_in: true });
  await w.call('channels_probe', {});
  const back = await w.call('channels_probe', control(SNAP.x_out));
  assert.deepEqual([back.state, back.reraised, back.unpaused], ['signed_out', true, undefined].map((v, i) => (i === 2 ? false : v)));
  const due = await w.call('due', {});
  assert.equal(due.needs.find(x => x.id === 'x-lohi').reason, 'signed_out', 'a sign-in need again');
  assert.equal(due.needs.find(x => x.id === 'x-lohi').raised, false, 'and it is raised afresh');
  // Unsure: no change, and the retry backs off.
  w.now += 3 * H;
  const next = await w.call('channels_probe', {});
  assert.equal(next.url, 'https://www.reddit.com/settings');
  const unsure = await w.call('channels_probe', control(SNAP.unknown));
  assert.deepEqual([unsure.state, unsure.unpaused], ['unknown', false]);
  // Signed in per the page but the person has not confirmed: stays paused.
  w.now += 3 * H;
  const again = await w.call('channels_probe', {});
  assert.ok(again.url);
  const wait = await w.call('channels_probe', control(again.url.includes('reddit') ? SNAP.rd_in : SNAP.x_in));
  assert.deepEqual([wait.state, wait.awaiting, wait.unpaused], ['signed_in', 'confirm', false]);
});

test('probe: a result nobody asked for, or a stale one, does nothing; two browser failures back the probe off for half a day', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi' }] });
  assert.equal((await w.call('channels_probe', control(SNAP.x_in))).done, true, 'no probe pending');
  await w.call('channels_probe', {});
  w.now += 20 * 60_000;
  assert.equal((await w.call('channels_probe', control(SNAP.x_in))).reason, 'no_probe_pending', 'older than 15 minutes');
  w.now += 3 * H;
  await w.call('channels_probe', {}); // second try, again no result (the browser failed)
  w.now += 3 * H;
  assert.equal((await w.call('channels_probe', {})).done, true, 'backed off after two failures');
  w.now += 12 * H;
  assert.ok((await w.call('channels_probe', {})).action);
});

// ---------- page actions without the admin key ----------

test('page actions: reschedule, pull, restore, pause and set_limits need no PRODUCT_ADMIN_KEY', async () => {
  const w = world();
  const id = await passed(w, 'truyện tiên hiệp hay', 'tien-hiep-hay-nhat-2026');
  await w.call('schedule', { id });
  const act = (op, extra = {}) => w.call('page_action', { op, request_id: `q-${op}`, ...extra }, { page: { page: 'hang-doi' } });
  const at = new Date(w.now + 3 * DAY).toISOString();
  assert.equal((await act('reschedule', { id, scheduled_at: at })).scheduled_at, at);
  assert.equal((await act('pull', { id })).state, 'pulled');
  assert.equal((await act('restore', { id })).state, 'scheduled');
  assert.equal((await act('pause', { channel: 'blog-lohi' })).channels.find(c => c.id === 'blog-lohi').paused, true);
  assert.deepEqual(await act('set_limits', { channel: 'blog-lohi', cap_per_day: 2, spacing_min: 600 }), { id: 'blog-lohi', cap_per_day: 2, spacing_min: 600 });
  await assert.rejects(act('set_limits', { channel: 'blog-lohi', cap_per_day: 99 }), /cap_per_day/);
  await assert.rejects(act('set_limits', { channel: 'blog-lohi' }), /ít nhất một giới hạn/);
  assert.equal(w.env.PRODUCT_ADMIN_KEY, undefined);
});

// ---------- the tool surface ----------

test('the pack stays under 64 KiB and chain steps accept each other\'s output', () => {
  const raw = readFileSync(new URL('packs/marketing/pack.json', root));
  assert.ok(raw.length < 64 * 1024, `pack.json is ${raw.length} bytes`);
  const tool = n => JSON.parse(raw).tools.find(t => t.name === n);
  // The keys a chain hands on are declared (additionalProperties is false everywhere).
  assert.ok('ok' in tool('record').parameters.properties && 'status' in tool('record').parameters.properties);
  assert.deepEqual(Object.keys(tool('claim').parameters.properties), ['id', 'action']);
  assert.ok('channel' in tool('due').parameters.properties && 'skip' in tool('due').parameters.properties);
  assert.ok('result' in tool('channels_probe').parameters.properties && 'session' in tool('channels_probe').parameters.properties);
  const blog = json('examples/lohi-marketing/packs/lohi-blog/pack.json').tools.find(t => t.name === 'publish');
  assert.ok('claim' in blog.parameters.properties && 'verify_first' in blog.parameters.properties);
});

test('Editor and Writer carry only the tools they use: schema bytes stay small', () => {
  const pack = json('packs/marketing/pack.json'), blog = json('examples/lohi-marketing/packs/lohi-blog/pack.json'), browser = json('packs/browser-use/pack.json');
  const size = (p, id, names) => p.tools.filter(t => !names || names.includes(t.name)).reduce((s, t) => s + JSON.stringify({ name: `${id}_${t.name}`, description: t.description, parameters: t.parameters }).length, 0);
  const list = ref => ref.split('tools=')[1].split(',');
  const editor = json('examples/lohi-marketing/soots/lohi-editor.json').packs, writer = json('examples/lohi-marketing/soots/lohi-writer.json').packs;
  const e = size(pack, 'marketing', list(editor[0])) + size(blog, 'lohi-blog', list(editor[1])) + size(browser, 'browser-use');
  const wr = size(pack, 'marketing', list(writer[0]));
  assert.ok(e < 21_000, `Editor schemas ${e} bytes (was 31,953)`);
  assert.ok(wr < 5_000, `Writer schemas ${wr} bytes (was 4,963)`);
});
