// Binding a browser profile to an account row, and adding a TikTok account, from the desk (T3). The row
// (`channels`, rules.profile) is what the Publisher's claim carries; the profile is Nest's (browser.profiles.read
// lists them, browser.profiles.report records what this pack uses one for: "Dùng cho" in Kho khóa).
//
// The binding field is `browser_profile`, never `profile`: the host checks a tool input's top-level `profile`
// against the calling Soot's own grants (contract browser-profiles §4), because there it names a profile the call
// opens. Binding opens nothing: it names which profile the Publisher will open later, and that later browser call is
// checked against the Publisher's grants. So the desk, served by whichever Soot the host picks, can bind a profile it
// may not open itself, and still no Soot ever opens a profile it was not granted.
import { fail, eq } from './store.mjs';
import { platformOf } from './guard.mjs';
import { libraryRoot } from './root.mjs';
import { loadProducts, tiktokChannelId, TIKTOK_HANDLE, PRODUCT_ID } from './library.mjs';
import { PROFILE_RE, profileOf, channels_setup, clearAttention } from './ops.mjs';
import { PLATFORM_HOST, readProfiles, siteState, handleMismatch, setUsage, removeUsage, signInLink, grantLink } from './profiles.mjs';

/** Where Kho khóa's "Dùng cho" line opens: the Marketing desk (its rail piece). */
export const DESK_LINK = 'nest://piece/desk';
const PLATFORM_LABEL = { x: 'X', facebook: 'Facebook', reddit: 'Reddit', tiktok: 'TikTok' };
const iso = ms => new Date(ms).toISOString();
const bare = h => String(h ?? '').trim().replace(/^@/, '').toLowerCase();

/** Kho khóa's words for one use: "TikTok @lohi · Lohi" (plain text, at most 80 characters). */
export function useLabel(row, productName) {
  const platform = platformOf(row.key);
  const who = row.account ?? String(row.key).replace(new RegExp(`^${platform}-?`), '');
  return `${PLATFORM_LABEL[platform] ?? platform} ${who}${productName ? ` · ${productName}` : ''}`.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
}

/** The other live row of the same platform that already posts from `profile`: two rows on one profile would be two
 *  accounts sharing one sign-in. A profile holding X and TikTok sign-ins for one product is fine. */
async function boundElsewhere(store, profile, key) {
  const platform = platformOf(key);
  return (await store.query('channels', [], { limit: 50 })).find(c => c.key !== key && profileOf(c) === profile && platformOf(c.key) === platform && c.paused_reason !== 'retired') ?? null;
}

/** The profiles as the desk offers them: read once, refused in plain codes when Nest cannot be read. */
async function readFor(deps) {
  const read = await readProfiles(deps.env, deps.fetch);
  if (!read.ok) fail('profiles_unread', `Nest's browser profiles cannot be read (${read.why}): grant this pack browser.profiles.read, or bind with channels_setup.`);
  return read;
}

async function productName(env, id) {
  if (!id) return null;
  const lr = await libraryRoot(env ?? {}).catch(() => ({ ok: false }));
  const products = await loadProducts({ root: lr.ok ? lr.root : null, hubSites: [id] }).catch(() => []);
  return products.find(p => p.id === id)?.name ?? id;
}

/**
 * After a row moves to `profile`: a row paused `signed_out` was waiting for a sign-in on its *old* profile, so the new
 * profile's own state decides. Signed in on the platform's site (as the same account, when Nest knows the handle):
 * the row resumes now. Otherwise this is a new wait, stamped now, and the next sign-in on this profile resumes it (due).
 * A row a person paused, or one that runs, is left as it is.
 */
async function settleSignIn(store, row, read, profile, now) {
  const host = PLATFORM_HOST[platformOf(row.key)];
  const site = host ? siteState(read, profile, host) : { state: null };
  const mismatch = handleMismatch(site, row);
  if (!(row.paused && row.paused_reason === 'signed_out')) return { mismatch };
  const { signed_out_at: _old, ...rules } = row.rules ?? {};
  if (site.state === 'signed_in' && !mismatch) {
    await store.update('channels', [eq('key', row.key)], { paused: false, paused_reason: null, rules });
    await store.remove('attention', [eq('kind', 'woke-item'), eq('reason', row.key)]);
    await clearAttention(store, 'channel', row.key);
    return { resumed: true, mismatch };
  }
  await store.update('channels', [eq('key', row.key)], { rules: { ...rules, signed_out_at: iso(now) } });
  return { mismatch };
}

/** Record the use on the new profile and forget it on the old one; never fails the binding (display only). */
async function writeUse(deps, row, before, after, name) {
  const out = {};
  if (before && before !== after) {
    const r = await removeUsage(deps.env, deps.fetch, before, row.key);
    if (!r.ok) out.removed = { ok: false, why: r.why };
  }
  if (after) {
    const r = await setUsage(deps.env, deps.fetch, after, { key: row.key, label: useLabel(row, name), link: DESK_LINK });
    out.set = r.ok ? { ok: true } : { ok: false, why: r.why };
  }
  return out;
}

/**
 * Bind (or with null unbind) the browser profile an account row posts from: page_action set_limits
 * {channel, browser_profile}. Refusals: not_found, conflict (retired), invalid_request, profiles_unread,
 * browser_profile_unknown, profile_in_use. The same binding again changes nothing but refreshes its use line.
 */
export async function bindProfile(key, profile, deps) {
  const { store, now } = deps;
  const row = await store.one('channels', [eq('key', key)]);
  if (!row) fail('not_found', `Không có kênh ${key}.`);
  if (row.paused_reason === 'retired') fail('conflict', `Kênh ${key} đã ngừng; TikTok đăng theo từng tài khoản.`);
  if (profile !== null && !(typeof profile === 'string' && PROFILE_RE.test(profile))) fail('invalid_request', 'browser_profile is a browser profile id (letters, digits, . _ -, up to 64) or null.');
  const before = profileOf(row);
  const name = await productName(deps.env, row.rules?.product ?? null);
  if (profile === null) {
    if (before) {
      const { profile: _gone, ...rules } = row.rules ?? {};
      await store.update('channels', [eq('key', key)], { rules });
    }
    return { id: key, profile: null, previous: before, ...(before ? {} : { unchanged: true }), usage: await writeUse(deps, row, before, null, name) };
  }
  const read = await readFor(deps);
  if (!read.profiles.some(p => p?.id === profile)) fail('browser_profile_unknown', `Nest has no browser profile ${profile}.`);
  const other = await boundElsewhere(store, profile, key);
  if (other) fail('profile_in_use', `Hồ sơ ${profile} đang dùng cho ${other.account ?? other.key} (${other.key}); mỗi tài khoản một hồ sơ.`);
  let settled = {};
  if (before !== profile) {
    const rules = { ...(row.rules ?? {}), profile };
    await store.update('channels', [eq('key', key)], { rules });
    settled = await settleSignIn(store, { ...row, rules }, read, profile, now);
  }
  const after = await store.one('channels', [eq('key', key)]);
  return { id: key, profile, previous: before, ...(before === profile ? { unchanged: true } : {}), paused: !!after.paused, paused_reason: after.paused_reason ?? null,
    ...(settled.resumed ? { resumed: true } : {}), ...(settled.mismatch ? { signed_in_as: settled.mismatch } : {}), usage: await writeUse(deps, after, before, profile, name) };
}

/**
 * The desk's "Thêm tài khoản TikTok": page_action add_account {product, handle, browser_profile}. Creates
 * `tiktok-<handle>` (account @handle, rules {product, profile}) through channels_setup's row path, paused until the
 * profile is signed in to TikTok (already signed in: it runs at once). products.json is not written: the row is the
 * account. Refusals: invalid_request (product), handle_invalid, account_exists, profiles_unread,
 * browser_profile_unknown, profile_in_use. Sending the same account again answers unchanged.
 */
export async function addAccount(input, deps) {
  const { store, env, now } = deps;
  const product = input.product;
  if (typeof product !== 'string' || !PRODUCT_ID.test(product)) fail('invalid_request', 'product is a product id.');
  const lr = await libraryRoot(env ?? {});
  const prod = (await loadProducts({ root: lr.ok ? lr.root : null, hubSites: [product] })).find(p => p.id === product);
  if (!prod) fail('invalid_request', `product "${product}" is not on the desk.`);
  const handle = String(input.handle ?? '').trim().replace(/^@/, '');
  const key = tiktokChannelId(handle);
  if (!TIKTOK_HANDLE.test(handle) || platformOf(key) !== 'tiktok') fail('handle_invalid', 'handle is a TikTok handle: 2–24 letters, digits, . or _.');
  const profile = input.browser_profile;
  if (!(typeof profile === 'string' && PROFILE_RE.test(profile))) fail('invalid_request', 'browser_profile is the browser profile id the account signs in on.');
  const account = `@${handle}`;
  const had = await store.one('channels', [eq('key', key)]);
  if (had) {
    if (had.rules?.product === product && profileOf(had) === profile && bare(had.account) === bare(handle)) return { ok: true, op: 'add_account', channel: key, account: had.account, product, profile, created: false, unchanged: true, paused: !!had.paused, paused_reason: had.paused_reason ?? null };
    fail('account_exists', `Đã có tài khoản ${had.account ?? key} (${key}).`);
  }
  const read = await readFor(deps);
  if (!read.profiles.some(p => p?.id === profile)) fail('browser_profile_unknown', `Nest has no browser profile ${profile}.`);
  const other = await boundElsewhere(store, profile, key);
  if (other) fail('profile_in_use', `Hồ sơ ${profile} đang dùng cho ${other.account ?? other.key} (${other.key}); mỗi tài khoản một hồ sơ.`);
  await channels_setup({ channels: [{ id: key, account, profile, rules: { product } }] }, deps);
  const row = await store.one('channels', [eq('key', key)]);
  const settled = await settleSignIn(store, row, read, profile, now);
  const after = await store.one('channels', [eq('key', key)]);
  return { ok: true, op: 'add_account', channel: key, account, product, profile, created: true, paused: !!after.paused, paused_reason: after.paused_reason ?? null,
    ...(settled.mismatch ? { signed_in_as: settled.mismatch } : {}), usage: await writeUse(deps, after, null, profile, prod.name ?? product) };
}

/**
 * The profiles a desk sheet offers for a platform's account rows: {ok, list} or {ok: false, why, grant?}. Each entry
 * says who may open it (`granted`: team when it is granted to one of the desk's teams, soot when only to Soots, none),
 * its sign-in on the platform's site and the row it is bound to. Ids stay in the data; the frame shows names.
 */
export function profileChoices(W, platform) {
  if (!W.profiles) return { ok: false, why: 'not_read' };
  if (!W.profiles.ok) return { ok: false, why: W.profiles.why, ...(W.profiles.why === 'no_grant' ? { grant: grantLink(W.soot) } : {}) };
  const host = PLATFORM_HOST[platform] ?? null;
  const teams = new Set((W.teams ?? []).map(t => (typeof t === 'string' ? t : t?.id)).filter(Boolean));
  const rows = (W.channels ?? []).filter(c => platformOf(c.key) === platform && c.paused_reason !== 'retired' && profileOf(c));
  const list = W.profiles.profiles.filter(p => typeof p?.id === 'string').slice(0, 64).map(p => {
    const allowed = Array.isArray(p.allowed) ? p.allowed : [];
    const bound = rows.find(c => profileOf(c) === p.id);
    const s = host ? siteState(W.profiles, p.id, host) : { state: null };
    return { id: p.id, name: typeof p.name === 'string' && p.name ? p.name : p.id, ...(p.project ? { project: p.project } : {}),
      granted: (p.groups ?? []).some(g => teams.has(g)) ? 'team' : allowed.length ? 'soot' : 'none', allowed: allowed.length,
      sign_in: { state: s.state, at: s.at ?? null }, bound: bound ? { channel: bound.key, account: bound.account ?? null } : null, href: signInLink(p.id, host) };
  });
  return { ok: true, list };
}
