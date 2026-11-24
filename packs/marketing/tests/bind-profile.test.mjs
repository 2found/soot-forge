// T3: bind a browser profile on the desk. An account row (tiktok-<handle>, x-…) names the Nest profile its Publisher
// signs in with; the desk sets it with set_limits {channel, browser_profile} and adds a TikTok account with
// add_account {product, handle, browser_profile}. One profile posts for one account per platform. Each binding is
// written to the profile as a use ("Dùng cho" in Kho khóa), linking back to the desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { world, T0, MIN } from './desk-world.mjs';
import { fakeRuntime, runtimeEnv } from './fake-runtime.mjs';
import { useLabel, DESK_LINK } from '../tools/lib/accounts.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8'));
const PROFILES = [
  { id: 'tt-acme', name: 'TikTok Acme', groups: ['growth'], allowed: ['poster'] },
  { id: 'tt-beta', name: 'TikTok Beta', soots: ['poster'], allowed: ['poster'] },
  { id: 'spare', name: 'Dự phòng' },
];

async function desk({ profiles = PROFILES, scopes, token = true } = {}) {
  const w = await world();
  w.rt = fakeRuntime({ profiles, scopes, fallback: w.hub.fetch, clock: () => w.now });
  w.fetch = w.rt.fetch;
  if (token) w.env = { ...w.env, ...runtimeEnv() };
  w.row = key => w.store.data.channels.find(c => c.key === key);
  w.bind = (channel, browser_profile, extra = {}) => w.act({ op: 'set_limits', channel, browser_profile, ...extra });
  w.add = (input) => w.act({ op: 'add_account', product: 'acme', ...input });
  w.cell = (key = 'acme:tiktok') => w.call('page_view', { view: 'channel', key }, { piece: { soot: 'editor', piece: 'desk', teams: ['growth'] } });
  w.uses = id => (w.rt.uses[id] ?? []).map(u => `${u.key}=${u.label}`);
  return w;
}

test('page_action names the binding browser_profile, never the profile field the host checks against the caller', () => {
  const props = pack.tools.find(t => t.name === 'page_action').parameters.properties;
  assert.equal(props.profile, undefined);
  assert.deepEqual(props.browser_profile.type, ['string', 'null']);
  assert.ok(props.op.enum.includes('add_account') && props.handle);
});

test('add_account creates tiktok-<handle> on its profile, paused until signed in, and its own line in the cell', async () => {
  const w = await desk();
  const r = await w.add({ handle: '@Acme.Truyen', browser_profile: 'tt-acme' });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual([r.channel, r.account, r.created, r.paused, r.paused_reason], ['tiktok-acme-truyen', '@Acme.Truyen', true, true, 'signed_out']);
  const row = w.row('tiktok-acme-truyen');
  assert.deepEqual([row.account, row.rules.product, row.rules.profile, row.publisher, row.rules.publisher_by], ['@Acme.Truyen', 'acme', 'tt-acme', 'browser', undefined]);
  assert.equal(row.rules.signed_out_at, new Date(T0).toISOString(), 'the wait starts now: a sign-in from here on resumes it');
  assert.deepEqual(w.uses('tt-acme'), ['tiktok-acme-truyen=TikTok @Acme.Truyen · Acme Truyện']);
  assert.equal(w.rt.uses['tt-acme'][0].link, DESK_LINK);
  // Its own line, with Nest's sign-in state; no chat, no products.json edit.
  const v = await w.cell();
  const line = v.cell.accounts.find(a => a.channel === 'tiktok-acme-truyen');
  assert.deepEqual([line.account, line.profile, line.state, line.sign_in.state], ['@Acme.Truyen', 'tt-acme', 'signed_out', 'never']);
  // The same account again changes nothing.
  const again = await w.add({ handle: 'Acme.Truyen', browser_profile: 'tt-acme' });
  assert.deepEqual([again.created, again.unchanged], [false, true]);
  // A sign-in recorded in Nest after the add resumes it (T2's due path).
  w.now += 5 * MIN;
  w.rt.signIn('tt-acme', 'tiktok.com', w.now);
  await w.call('due', {});
  assert.equal(w.row('tiktok-acme-truyen').paused, false);
});

test('add_account on a profile already signed in to TikTok as that account runs at once; as another account it waits', async () => {
  const w = await desk();
  w.rt.signIn('tt-acme', 'tiktok.com', T0 - 60 * MIN, '@acme');
  const r = await w.add({ handle: 'acme', browser_profile: 'tt-acme' });
  assert.deepEqual([r.paused, r.paused_reason], [false, null]);
  assert.equal(w.row('tiktok-acme').rules.signed_out_at, undefined);
  w.rt.signIn('tt-beta', 'tiktok.com', T0 - 60 * MIN, '@someone');
  const other = await w.act({ op: 'add_account', product: 'beta', handle: 'beta', browser_profile: 'tt-beta' });
  assert.deepEqual([other.paused, other.paused_reason, other.signed_in_as], [true, 'signed_out', '@someone']);
});

test('add_account refuses a bad handle, a taken account, a taken profile, an unknown profile or product, and writes nothing', async () => {
  const w = await desk();
  for (const handle of ['', '@', 'a', 'bad handle', 'tên-việt', 'x'.repeat(25), 7]) {
    assert.equal((await w.add({ handle, browser_profile: 'tt-acme' })).error?.code, 'handle_invalid', String(handle));
  }
  assert.equal((await w.add({ handle: 'acme', browser_profile: 'nope' })).error?.code, 'browser_profile_unknown');
  assert.equal((await w.add({ handle: 'acme', browser_profile: 'bad profile' })).error?.code, 'invalid_request');
  assert.equal((await w.add({ handle: 'acme' })).error?.code, 'invalid_request');
  assert.equal((await w.act({ op: 'add_account', product: 'nope', handle: 'acme', browser_profile: 'tt-acme' })).error?.code, 'invalid_request');
  assert.equal((w.store.data.channels ?? []).length, 0);
  assert.deepEqual(w.rt.writes(), []);
  assert.equal((await w.add({ handle: 'acme', browser_profile: 'tt-acme' })).created, true);
  // The same handle (any case) for another product or profile is the same account: refused, never moved.
  assert.equal((await w.act({ op: 'add_account', product: 'beta', handle: 'ACME', browser_profile: 'tt-acme' })).error?.code, 'account_exists');
  assert.equal((await w.add({ handle: 'acme', browser_profile: 'tt-beta' })).error?.code, 'account_exists');
  // A second TikTok account on the first one's profile would share its sign-in.
  const taken = await w.add({ handle: 'acme2', browser_profile: 'tt-acme' });
  assert.equal(taken.error?.code, 'profile_in_use');
  assert.equal(w.row('tiktok-acme2'), undefined);
  assert.equal(w.row('tiktok-acme').rules.product, 'acme');
});

test('set_limits binds, rebinds and unbinds a row, moving its use between profiles', async () => {
  const w = await desk();
  await w.call('channels_setup', { channels: [{ id: 'tiktok-acme', account: '@acme', rules: { product: 'acme' } }] });
  let r = await w.bind('tiktok-acme', 'tt-acme');
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual([r.profile, r.binding.previous, r.binding.paused_reason, r.usage.set.ok], ['tt-acme', null, 'signed_out', true]);
  assert.equal(w.row('tiktok-acme').rules.profile, 'tt-acme');
  assert.deepEqual(w.uses('tt-acme'), ['tiktok-acme=TikTok @acme · Acme Truyện']);
  // The same binding again: nothing moves, the use line is refreshed.
  r = await w.bind('tiktok-acme', 'tt-acme');
  assert.equal(r.binding.unchanged, true);
  // Rebind to a profile already signed in: the row was waiting on the old profile's sign-in; the new one's state decides.
  w.now += MIN;
  w.rt.signIn('spare', 'tiktok.com', T0 - 60 * MIN);
  r = await w.bind('tiktok-acme', 'spare');
  assert.deepEqual([r.binding.previous, r.binding.resumed, r.binding.paused], ['tt-acme', true, false]);
  assert.deepEqual([w.uses('tt-acme'), w.uses('spare')], [[], ['tiktok-acme=TikTok @acme · Acme Truyện']]);
  assert.deepEqual(w.rt.writes().slice(-2).map(c => c.method + ' ' + c.path), ['DELETE /v1/runtime/browser-profiles/tt-acme/usage/tiktok-acme', 'PUT /v1/runtime/browser-profiles/spare/usage']);
  // A running row moved to a profile that is not signed in keeps running: the Publisher meets the wall and says so (T2).
  r = await w.bind('tiktok-acme', 'tt-beta');
  assert.deepEqual([r.binding.paused, w.row('tiktok-acme').paused], [false, false]);
  // Unbind: the row has no profile and the profile no use.
  r = await w.bind('tiktok-acme', null);
  assert.deepEqual([r.profile, r.binding.previous], [null, 'tt-beta']);
  assert.equal(w.row('tiktok-acme').rules.profile, undefined);
  assert.deepEqual(w.uses('tt-beta'), []);
  // Caps and the binding in one call.
  r = await w.bind('tiktok-acme', 'tt-acme', { cap_per_day: 3 });
  assert.deepEqual([r.cap_per_day, w.row('tiktok-acme').cap_per_day, w.row('tiktok-acme').rules.profile], [3, 3, 'tt-acme']);
});

test('set_limits refuses a profile another account of the platform posts from; another platform on it is fine', async () => {
  const w = await desk();
  await w.add({ handle: 'acme', browser_profile: 'tt-acme' });
  await w.act({ op: 'add_account', product: 'beta', handle: 'beta', browser_profile: 'tt-beta' });
  const before = w.rt.writes().length;
  const r = await w.bind('tiktok-beta', 'tt-acme', { cap_per_day: 5 });
  assert.equal(r.error?.code, 'profile_in_use');
  assert.match(r.error.message, /@acme/);
  assert.deepEqual([w.row('tiktok-beta').rules.profile, w.row('tiktok-beta').cap_per_day], ['tt-beta', 2], 'nothing written on a refusal');
  assert.equal(w.rt.writes().length, before);
  // The same Nest profile can hold the product's X sign-in too.
  const x = await w.bind('x-acme', 'tt-acme');
  assert.equal(x.error, undefined, JSON.stringify(x));
  assert.deepEqual(w.uses('tt-acme'), ['tiktok-acme=TikTok @acme · Acme Truyện', 'x-acme=X acme']);
  // A row that does not exist, an unknown profile, the retired legacy row: coded refusals.
  assert.equal((await w.bind('tiktok-acme', 'nope')).error?.code, 'browser_profile_unknown');
  await w.store.insert('channels', { key: 'tiktok', kind: 'video', publisher: 'hand', paused: true, paused_reason: 'retired', rules: {}, platform: 'tiktok' });
  assert.ok(['conflict', 'tiktok_account_required'].includes((await w.bind('tiktok', 'spare')).error?.code));
});

test('a use that cannot be written never undoes the binding; the answer says why', async () => {
  const w = await desk({ profiles: PROFILES });
  for (let i = 0; i < 8; i++) w.rt.uses.spare = [...(w.rt.uses.spare ?? []), { pack: 'other', key: `k${i}`, label: `L${i}` }];
  await w.call('channels_setup', { channels: [{ id: 'tiktok-acme', account: '@acme', rules: { product: 'acme' } }] });
  const r = await w.bind('tiktok-acme', 'spare');
  assert.deepEqual([r.profile, r.usage.set], ['spare', { ok: false, why: 'usage_full' }]);
  assert.equal(w.row('tiktok-acme').rules.profile, 'spare');
  // Read but not report: the binding holds, the use is not written.
  const ro = await desk({ scopes: ['read'] });
  const a = await ro.add({ handle: 'acme', browser_profile: 'tt-acme' });
  assert.deepEqual([a.created, a.usage.set], [true, { ok: false, why: 'no_grant' }]);
});

test('without browser.profiles.read nothing is bound and the cell says why, with the grant link', async () => {
  const w = await desk({ token: false });
  await w.call('channels_setup', { channels: [{ id: 'tiktok-acme', account: '@acme', rules: { product: 'acme' } }] });
  assert.equal((await w.bind('tiktok-acme', 'tt-acme')).error?.code, 'profiles_unread');
  assert.equal((await w.add({ handle: 'acme2', browser_profile: 'tt-acme' })).error?.code, 'profiles_unread');
  assert.equal(w.row('tiktok-acme').rules.profile, undefined);
  assert.equal(w.row('tiktok-acme2'), undefined);
  const v = await w.cell();
  assert.deepEqual(v.profiles, { ok: false, why: 'no_grant', grant: 'nest://soot/editor' });
  // A token without the read scope is a missing grant too.
  const scoped = await desk({ scopes: ['report'] });
  assert.equal((await scoped.cell()).profiles.why, 'no_grant');
  // Unbinding needs no read: it only forgets.
  await w.store.update('channels', [{ column: 'key', op: 'eq', value: 'tiktok-acme' }], { rules: { product: 'acme', profile: 'tt-acme' } });
  const un = await w.bind('tiktok-acme', null);
  assert.deepEqual([un.profile, w.row('tiktok-acme').rules.profile], [null, undefined]);
});

test('the TikTok cell lists every profile with who may open it, its TikTok sign-in and the account it posts for', async () => {
  const w = await desk();
  w.rt.signIn('tt-beta', 'tiktok.com', T0 - MIN);
  await w.add({ handle: 'acme', browser_profile: 'tt-acme' });
  const v = await w.cell();
  assert.equal(v.profiles.ok, true);
  const by = Object.fromEntries(v.profiles.list.map(p => [p.id, p]));
  assert.deepEqual(Object.keys(by), ['spare', 'tt-acme', 'tt-beta']);
  assert.deepEqual([by['tt-acme'].granted, by['tt-beta'].granted, by.spare.granted], ['team', 'soot', 'none']);
  assert.deepEqual(by['tt-acme'].bound, { channel: 'tiktok-acme', account: '@acme' });
  assert.equal(by['tt-beta'].bound, null);
  assert.deepEqual([by['tt-beta'].sign_in.state, by.spare.sign_in.state], ['signed_in', 'never']);
  assert.equal(by.spare.name, 'Dự phòng');
  assert.match(by.spare.href, /^nest:\/\/settings\/browser\?profile=spare&sign_in=tiktok\.com$/);
  // Another platform's cell offers none: the desk binds TikTok accounts.
  assert.equal((await w.cell('acme:x')).profiles, undefined);
});

test('useLabel is plain words: platform, account, product', () => {
  assert.equal(useLabel({ key: 'tiktok-lohi', account: '@lohi' }, 'Lohi'), 'TikTok @lohi · Lohi');
  assert.equal(useLabel({ key: 'tiktok-lohi' }, null), 'TikTok lohi');
  assert.equal(useLabel({ key: 'x-lohi', account: 'lohi2com' }, 'L'.repeat(90)).length, 80);
});
