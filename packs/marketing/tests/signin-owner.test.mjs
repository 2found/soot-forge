// T2: "signed in" has one owner, the browser profile's sites in Nest (contract browser-profiles §3a). A Poster's
// sign-out is told to the profile; a sign-in the person records in Nest resumes the channels on that profile and
// settles their one card; without the runtime grant the pack never guesses (the desk shows "—" with why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { signInLink, siteState } from '../tools/lib/profiles.mjs';
import * as M from '../page/src/model.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'k'.repeat(32);
const TOKEN = 'srt_test-token-not-a-secret';
const RUNTIME = 'http://127.0.0.1:7788';
const T0 = Date.parse('2026-11-24T03:00:00Z');
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();

/** A fake runtime for the two scopes: `sites` per profile, `granted` profiles, every request recorded. */
function runtime({ granted = ['x-lohi', 'social'], scopes = ['read', 'report'] } = {}) {
  const rt = { calls: [], sites: {}, profiles: ['x-lohi', 'social', 'tiktok-lohi'] };
  rt.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization;
    rt.calls.push({ method: init.method ?? 'GET', path: u.pathname, auth, body: init.body ? JSON.parse(init.body) : null });
    const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (u.origin !== RUNTIME || auth !== `Bearer ${TOKEN}`) return answer(401, { code: 'runtime_token_invalid', error: 'no' });
    if (init.method === undefined || init.method === 'GET') {
      if (!scopes.includes('read')) return answer(403, { code: 'runtime_scope_forbidden', error: 'no' });
      return answer(200, { profiles: rt.profiles.map(id => ({ id, name: id, groups: [], soots: [], allowed: [], granted: granted.includes(id), sites: rt.sites[id] ?? [], usage: [] })) });
    }
    const m = /^\/v1\/runtime\/browser-profiles\/([^/]+)\/signed-out$/.exec(u.pathname);
    if (!m) return answer(404, { code: 'not_found' });
    if (!scopes.includes('report')) return answer(403, { code: 'runtime_scope_forbidden', error: 'no' });
    const id = decodeURIComponent(m[1]);
    if (!rt.profiles.includes(id)) return answer(404, { code: 'browser_profile_unknown', error: 'no' });
    if (!granted.includes(id)) return answer(403, { code: 'browser_profile_not_granted', error: 'no' });
    const host = JSON.parse(init.body).host;
    const sites = rt.sites[id] ??= [];
    let site = sites.find(s => s.host === host);
    const changed = !site || site.state !== 'signed_out';
    if (!site) sites.push(site = { host });
    if (changed) Object.assign(site, { state: 'signed_out', signed_out_at: iso(T0), signed_out_by: 'soot:poster' });
    return answer(200, { profile: id, host, state: 'signed_out', site, changed });
  };
  /** The person's "Tôi đã đăng nhập" in Nest at `at`. */
  rt.signIn = (id, host, at, handle = '@lohi2com') => {
    const sites = rt.sites[id] ??= [];
    const rest = sites.filter(s => s.host !== host);
    rt.sites[id] = [...rest, { host, handle, signed_in_at: iso(at), state: 'signed_in' }];
  };
  return rt;
}

function world({ rt = runtime(), token = true } = {}) {
  const w = { now: T0, rt };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { MARKETING_CLAIM_KEY: KEY, ...(token ? { SOOT_RUNTIME_URL: RUNTIME, SOOT_RUNTIME_TOKEN: TOKEN } : {}) };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: rt.fetch });
  w.page = (op, input = {}) => w.call('page_action', { op, request_id: `r-${Math.random()}`, ...input }, { page: { page: 'queue' } });
  w.ch = key => w.store.data.channels.find(c => c.key === key);
  return w;
}

const CHANNELS = [{ id: 'x-lohi', account: 'lohi2com', profile: 'x-lohi' }, { id: 'facebook-lohi', account: 'https://www.facebook.com/lohi2com' }];

async function postOn(w, channel = 'x-lohi', body = 'Chín bộ tiên hiệp đáng đọc năm nay, mỗi bộ một lý do riêng.') {
  const d = await w.call('draft_save', { request_id: `q-${Math.random()}`, kind: 'social', channel, body });
  const c = await w.call('check', { id: d.id, revision: d.revision, verdict: 'pass', reasons: [] });
  assert.equal(c.verdict, 'pass', JSON.stringify(c.auto));
  await w.call('schedule', { id: d.id, scheduled_at: iso(w.now - MIN) });
  return d.id;
}

/** x-lohi running on profile x-lohi, one post claimed: the Poster met the login wall. */
async function signedOutX(w) {
  await w.call('channels_setup', { channels: CHANNELS, quiet_hours: { from: '23:00', to: '07:00', tz: 'Asia/Ho_Chi_Minh' } });
  await w.page('resume', { channel: 'x-lohi' });
  const id = await postOn(w);
  const { claim } = await w.call('claim', { id, action: 'publish' });
  const out = await w.call('fail', { intent_id: claim.intent_id, status: 'needs_person', reason: 'signed_out', platform: 'x' });
  return { id, out };
}

test('AC2.2 fail signed_out: keeps when the pause began and tells Nest the site is signed out on the row\'s profile, never with the token in the answer', async () => {
  const w = world();
  const { out } = await signedOutX(w);
  assert.deepEqual(out, { state: 'failed', profile_report: { profile: 'x-lohi', host: 'x.com', ok: true, state: 'signed_out', changed: true } });
  assert.equal(JSON.stringify(out).includes(TOKEN), false);
  const report = w.rt.calls.find(c => c.method === 'POST');
  assert.deepEqual([report.path, report.body, report.auth], ['/v1/runtime/browser-profiles/x-lohi/signed-out', { host: 'x.com' }, `Bearer ${TOKEN}`]);
  assert.deepEqual([w.ch('x-lohi').paused, w.ch('x-lohi').paused_reason, w.ch('x-lohi').rules.signed_out_at, w.ch('x-lohi').rules.profile], [true, 'signed_out', iso(T0), 'x-lohi']);
  // A second wall in the same episode keeps the first pause time.
  w.now += 30 * MIN;
  await w.page('resume', { channel: 'x-lohi' });
  await w.store.update('channels', [{ column: 'key', op: 'eq', value: 'x-lohi' }], { paused: true, paused_reason: 'signed_out' });
  const id2 = await postOn(w, 'x-lohi', 'Đọc gì cuối tuần? Ba truyện ngôn tình cổ đại nhẹ nhàng cho buổi tối.');
  await w.store.update('channels', [{ column: 'key', op: 'eq', value: 'x-lohi' }], { paused: false, paused_reason: null });
  const { claim } = await w.call('claim', { id: id2, action: 'publish' });
  await w.store.update('channels', [{ column: 'key', op: 'eq', value: 'x-lohi' }], { paused: true, paused_reason: 'signed_out' });
  await w.call('fail', { intent_id: claim.intent_id, status: 'needs_person', reason: 'signed_out' });
  assert.equal(w.ch('x-lohi').rules.signed_out_at, iso(T0), 'the episode began at the first wall');
});

test('AC2.2 non-happy fail: no grant, a profile the Soot may not open, or a channel without a profile still pause; the report says why', async () => {
  const none = world({ token: false });
  const a = await signedOutX(none);
  assert.deepEqual(a.out.profile_report, { profile: 'x-lohi', host: 'x.com', ok: false, why: 'no_grant' });
  assert.deepEqual([none.ch('x-lohi').paused_reason, none.ch('x-lohi').rules.signed_out_at], ['signed_out', iso(T0)]);
  assert.equal(none.rt.calls.length, 0, 'no token: nothing is sent');
  const refused = world({ rt: runtime({ granted: [] }) });
  assert.deepEqual((await signedOutX(refused)).out.profile_report, { profile: 'x-lohi', host: 'x.com', ok: false, why: 'browser_profile_not_granted' });
  const readOnly = world({ rt: runtime({ scopes: ['read'] }) });
  assert.equal((await signedOutX(readOnly)).out.profile_report.why, 'no_grant', 'a token without the report scope is a missing grant');
  // facebook-lohi names no profile: it pauses and nothing is reported.
  const w = world();
  await w.call('channels_setup', { channels: CHANNELS });
  await w.page('resume', { channel: 'facebook-lohi' });
  const id = await postOn(w, 'facebook-lohi', 'Một bài chia sẻ blog về mười một cảnh ngôn tình cổ đại đáng nhớ.');
  const { claim } = await w.call('claim', { id, action: 'publish' });
  assert.deepEqual(await w.call('fail', { intent_id: claim.intent_id, status: 'needs_person', reason: 'signed_out' }), { state: 'failed' });
  assert.equal(w.rt.calls.length, 0);
});

test('AC2.2/AC2.4 due: one Đăng nhập card per profile linking its sign-in; a sign-in recorded after the pause resumes the channel and settles the card', async () => {
  const w = world();
  await signedOutX(w);
  let due = await w.call('due', { schedule: true });
  const card = due.raise.find(c => c.group === 'signin:x-lohi');
  assert.deepEqual([card.title, card.link, card.link_label], ['Đăng nhập X', 'nest://settings/browser?profile=x-lohi&sign_in=x.com', 'Đăng nhập']);
  assert.deepEqual(card.options.map(o => [o.id, o.label, o.recommended, o.tool.name, o.tool.input]), [['signed_in', 'Đã đăng nhập X', undefined, 'pause', { channel: 'x-lohi', paused: true, signed_in: true }]]);
  assert.match(card.why, /Bấm Đăng nhập → đăng nhập trên trang vừa mở → bấm Tôi đã đăng nhập \(hồ sơ trình duyệt x-lohi\)\. Trang đăng nhập: https:\/\/x\.com\/i\/flow\/login/);
  assert.ok(due.settle.includes('need:channel:x-lohi:signed_out'), 'a per-channel card from an older version closes');
  assert.equal(due.resumed, undefined);
  // A sign-in from before the pause is not this episode's: the channel stays paused.
  w.rt.signIn('x-lohi', 'x.com', T0 - 60 * MIN);
  w.now += 10 * MIN;
  due = await w.call('due', { schedule: true });
  assert.equal(w.ch('x-lohi').paused, true);
  assert.ok(due.raise.some(c => c.group === 'signin:x-lohi'));
  // The person records the sign-in in Nest: the next due resumes x-lohi, posts its held post and settles the card.
  w.rt.signIn('x-lohi', 'x.com', w.now);
  w.now += 10 * MIN;
  const id = await postOn(w, 'x-lohi', 'Bạn thích nhân vật phản diện nào nhất trong truyện huyền huyễn gần đây?');
  due = await w.call('due', { schedule: true });
  assert.deepEqual(due.resumed, ['x-lohi']);
  assert.deepEqual([w.ch('x-lohi').paused, w.ch('x-lohi').paused_reason], [false, null]);
  assert.ok(due.publish.includes(id), 'the resumed channel posts on this very call');
  assert.equal((due.raise ?? []).some(c => c.group === 'signin:x-lohi'), false);
  assert.ok(due.settle.includes('signin:x-lohi'), 'the profile\'s card settles');
  assert.equal(w.store.data.attention.some(r => r.key.startsWith('inc:channel:x-lohi')), false);
  // Once settled, a repeat neither resumes nor settles again.
  due = await w.call('due', { schedule: true });
  assert.equal(due.resumed, undefined);
  assert.equal((due.settle ?? []).includes('signin:x-lohi'), false);
});

test('AC2.2 non-happy due: a sign-in as another account than the row\'s never resumes it (its posts would go out from that account)', async () => {
  const w = world();
  await signedOutX(w);
  await w.call('due', { schedule: true });
  w.rt.signIn('x-lohi', 'x.com', w.now + MIN, '@someone_else');
  w.now += 10 * MIN;
  let due = await w.call('due', { schedule: true });
  assert.deepEqual([due.resumed, w.ch('x-lohi').paused, w.ch('x-lohi').paused_reason], [undefined, true, 'signed_out']);
  assert.ok(due.raise.some(c => c.group === 'signin:x-lohi'), 'the card stays');
  // The same account, written another way, is the row's.
  w.rt.signIn('x-lohi', 'x.com', w.now + MIN, 'LOHI2COM');
  w.now += 10 * MIN;
  due = await w.call('due', { schedule: true });
  assert.deepEqual(due.resumed, ['x-lohi']);
});

test('AC2.4 two channels on one profile are one card; one resuming leaves the card for the other', async () => {
  const w = world();
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'lohi2com', profile: 'social' }, { id: 'facebook-lohi', account: 'https://www.facebook.com/lohi2com', profile: 'social' }] });
  let due = await w.call('due', { schedule: true });
  const cards = due.raise.filter(c => c.group === 'signin:social');
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0].title, cards[0].link, cards[0].options.map(o => o.id)], ['Đăng nhập X, Facebook', 'nest://settings/browser?profile=social&sign_in=x.com', ['signed_in_1', 'signed_in_2']]);
  assert.equal(cards[0].options.some(o => o.recommended), false);
  w.rt.signIn('social', 'x.com', w.now + MIN);
  w.now += 10 * MIN;
  due = await w.call('due', { schedule: true });
  assert.deepEqual(due.resumed, ['x-lohi']);
  const left = due.raise.filter(c => c.group === 'signin:social');
  assert.deepEqual([left.length, left[0].title, left[0].link], [1, 'Đăng nhập Facebook', 'nest://settings/browser?profile=social&sign_in=facebook.com']);
  assert.notEqual(left[0].id, cards[0].id, 'a new id, so the card for both is replaced in its group');
  assert.match(left[0].id, /^signin:social@\d+\.[0-9a-f]{8}$/);
  assert.equal(due.settle.includes('signin:social'), false, 'Facebook still needs it');
});

test('AC2.2 non-happy due: without the read grant nothing resumes and the answer says why; a row paused before its time was kept is stamped, not resumed by an older sign-in', async () => {
  const w = world({ rt: runtime({ scopes: ['report'] }) });
  await w.call('channels_setup', { channels: CHANNELS });
  w.rt.signIn('x-lohi', 'x.com', w.now - MIN);
  let due = await w.call('due', {});
  assert.deepEqual([due.resumed, due.sign_in_unread], [undefined, 'no_grant']);
  assert.equal(w.ch('x-lohi').rules.signed_out_at, iso(T0), 'the pause time is kept from now');
  const ok = world();
  await ok.call('channels_setup', { channels: CHANNELS });
  ok.rt.signIn('x-lohi', 'x.com', ok.now - MIN);
  due = await ok.call('due', {});
  assert.deepEqual([due.resumed, ok.ch('x-lohi').paused], [undefined, true], 'a sign-in older than the pause does not resume it');
  // An unknown profile is never a sign-in.
  ok.rt.profiles = ['social'];
  ok.now += 10 * MIN;
  assert.equal((await ok.call('due', {})).resumed, undefined);
});

test('AC2.1 desk: an account line shows its profile\'s sign-in from Nest; without the grant "—" with why and a Cấp quyền link to the Soot', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'signin-')));
  try {
    const lib = join(dir, 'marketing');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'products.json'), JSON.stringify({ products: [{ id: 'lohi', name: 'Lohi', site: 'lohi2.com', accounts: { tiktok: [{ handle: 'lohi', profile: 'tiktok-lohi' }] } }] }));
    const desk = async (w) => {
      w.env = { ...w.env, FILE_ROOT: dir, MARKETING_ROOT: lib };
      await w.call('channels_setup', { from_products: true, channels: [] });
      return w.call('page_view', { view: 'channel', key: 'lohi:tiktok' }, { soot: 'lohi-editor' });
    };
    const w = world();
    w.rt.signIn('tiktok-lohi', 'tiktok.com', T0 - 60 * MIN);
    const v = await desk(w);
    const line = v.cell.accounts.find(a => a.channel === 'tiktok-lohi');
    assert.deepEqual([line.state, line.sign_in.state, line.sign_in.at, line.sign_in.href], ['signed_out', 'signed_in', iso(T0 - 60 * MIN), 'nest://settings/browser?profile=tiktok-lohi&sign_in=tiktok.com'],
      'the row waits for its resume; Nest says the profile is signed in');
    assert.equal(v.steps.find(s => s.id === 'sign_in').href, 'nest://settings/browser?profile=tiktok-lohi&sign_in=tiktok.com');
    assert.equal(M.stepText(v.steps[0], { channel: 'tiktok' }).button, 'Đăng nhập');
    assert.deepEqual(M.signInText(line.sign_in, T0), { text: `Đã đăng nhập · ${M.when(iso(T0 - 60 * MIN), T0)}`, tone: 'ok' });
    // Without the grant: no request, "—", why, and the link that grants it.
    const none = world({ token: false });
    const u = (await desk(none)).cell.accounts.find(a => a.channel === 'tiktok-lohi');
    assert.deepEqual(u.sign_in, { state: null, why: 'no_grant', host: 'tiktok.com', href: 'nest://settings/browser?profile=tiktok-lohi&sign_in=tiktok.com', grant: 'nest://soot/lohi-editor' });
    assert.equal(none.rt.calls.length, 0);
    assert.deepEqual(M.signInText(u.sign_in, T0), { text: '—', tone: 'idle', why: 'Marketing chưa được cấp quyền đọc hồ sơ trình duyệt.', grant: 'nest://soot/lohi-editor' });
    // A profile Nest does not have, an unreachable Nest, and the other states.
    const gone = world();
    gone.rt.profiles = [];
    assert.equal((await desk(gone)).cell.accounts[0].sign_in.why, 'browser_profile_unknown');
    assert.equal(M.signInText({ state: null, why: 'unreachable' }, T0).grant, null);
    assert.deepEqual(M.signInText({ state: 'signed_out', at: iso(T0) }, T0), { text: `Đã đăng xuất · ${M.when(iso(T0), T0)}`, tone: 'err' });
    assert.deepEqual(M.signInText({ state: 'never', at: null }, T0), { text: 'Chưa đăng nhập', tone: 'wait' });
    assert.equal(M.signInText(null, T0), null);
    assert.deepEqual(siteState({ ok: true, profiles: [] }, 'tiktok-lohi', 'tiktok.com'), { state: null, why: 'browser_profile_unknown' });
    assert.equal(signInLink(null, 'x.com'), 'nest://settings/browser');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC2.5 no pack text points to a place Nest does not have, and no sign-in links the Soot\'s browser', () => {
  const files = [];
  const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|md)$/.test(e.name)) files.push(p); } };
  for (const d of ['tools', 'page/src', 'campaigns/src', 'skills']) walk(join(root, d));
  const STALE = [/Cài đặt › Trình duyệt/, /(Mở|ở|vào|Nest →) Thiết lập/, /Mở trình duyệt của Editor/, /khung bên phải/];
  for (const f of files) {
    const text = readFileSync(f, 'utf8').split('\n').filter(l => !/split\(\//.test(l)).join('\n');
    for (const re of STALE) assert.equal(re.test(text), false, `${f.slice(root.length + 1)} says ${re}`);
  }
  const ops = readFileSync(join(root, 'tools/lib/ops.mjs'), 'utf8');
  assert.equal(/login_url[^\n]*nest:\/\/browser/.test(ops), false, 'a sign-in need links the profile, not nest://browser/<soot>');
});
