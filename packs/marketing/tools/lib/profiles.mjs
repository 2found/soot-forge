// Browser profiles through the pack's own runtime (contract browser-profiles §3a): the profile's sites are the one
// state of "signed in". A tool reads it with `browser.profiles.read` and says a site is signed out with
// `browser.profiles.report`, through the per-call SOOT_RUNTIME_URL + SOOT_RUNTIME_TOKEN the host issues for the pack's
// `needs.runtime` once it is granted. No token means no grant: the pack then never guesses a state. The token is sent
// only to that URL and never written to an answer or a log. A Soot can never mark a site signed in: that is the
// person's statement in Nest.

/** The site a platform signs in on, as the runtime keys it (no www.). */
export const PLATFORM_HOST = { x: 'x.com', facebook: 'facebook.com', reddit: 'reddit.com', tiktok: 'tiktok.com' };

/** The Nest link that opens a profile's sign-in sheet on a host; without a profile, Kho khóa's sign-in list. */
export function signInLink(profile, host) {
  if (!profile) return 'nest://settings/browser';
  return `nest://settings/browser?profile=${encodeURIComponent(profile)}${host ? `&sign_in=${encodeURIComponent(host)}` : ''}`;
}

/** Where a person grants the pack's runtime scopes: the serving Soot's sheet (its packs and their grants). */
export const grantLink = soot => (soot ? `nest://soot/${encodeURIComponent(soot)}` : 'nest://settings/updates');

const TIMEOUT_MS = 5000;

/** One runtime call: {ok, data} or {ok: false, why}; why is no_grant, unreachable or the runtime's error code. */
async function call(env, fetchImpl, method, path, body) {
  const base = env?.SOOT_RUNTIME_URL, token = env?.SOOT_RUNTIME_TOKEN;
  if (!base || !token || typeof fetchImpl !== 'function') return { ok: false, why: 'no_grant' };
  let res;
  try {
    res = await fetchImpl(String(base).replace(/\/+$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { return { ok: false, why: 'unreachable' }; }
  let data = null;
  try { data = await res.json(); } catch { /* an answer that is not JSON is coded by its status */ }
  if (res.ok && data && typeof data === 'object') return { ok: true, data };
  const code = typeof data?.code === 'string' && /^[a-z_]{1,64}$/.test(data.code) ? data.code : `http_${res.status}`;
  // A token without this scope (the host granted only part of needs.runtime) is a missing grant too.
  return { ok: false, why: code === 'runtime_scope_forbidden' || code === 'runtime_token_invalid' ? 'no_grant' : code };
}

/** Every profile with its sites' state: {ok, profiles} or {ok: false, why}. */
export async function readProfiles(env, fetchImpl) {
  const r = await call(env, fetchImpl, 'GET', '/v1/runtime/browser-profiles');
  if (!r.ok) return r;
  return { ok: true, profiles: Array.isArray(r.data.profiles) ? r.data.profiles : [] };
}

/** Say `host` is signed out on `profile` (idempotent; the runtime keeps the first report): {ok, state, changed} or {ok: false, why}. */
export async function reportSignedOut(env, fetchImpl, profile, host) {
  const r = await call(env, fetchImpl, 'POST', `/v1/runtime/browser-profiles/${encodeURIComponent(profile)}/signed-out`, { host });
  return r.ok ? { ok: true, state: r.data.state ?? null, changed: !!r.data.changed } : r;
}

/**
 * Say what this pack uses `profile` for (display only, keyed by pack + key; the runtime grants nothing for it):
 * {ok, changed} or {ok: false, why}. `link` is a nest:// address.
 */
export async function setUsage(env, fetchImpl, profile, { key, label, link }) {
  const r = await call(env, fetchImpl, 'PUT', `/v1/runtime/browser-profiles/${encodeURIComponent(profile)}/usage`, { key, label, ...(link ? { link } : {}) });
  return r.ok ? { ok: true, changed: !!r.data.changed } : r;
}

/** Forget this pack's use `key` of `profile` (idempotent): {ok, changed} or {ok: false, why}. */
export async function removeUsage(env, fetchImpl, profile, key) {
  const r = await call(env, fetchImpl, 'DELETE', `/v1/runtime/browser-profiles/${encodeURIComponent(profile)}/usage/${encodeURIComponent(key)}`);
  return r.ok ? { ok: true, changed: !!r.data.changed } : r;
}

/**
 * The handle a site is signed in as, when it is another account than the row's (both known): such a sign-in never
 * resumes the row, since its posts would go out from the wrong account. Null when they match or either is unknown.
 */
export function handleMismatch(site, row) {
  const bare = h => String(h ?? '').trim().replace(/^@/, '').toLowerCase();
  return site?.handle && row?.account && bare(site.handle) !== bare(row.account) ? site.handle : null;
}

/**
 * A profile's sign-in on one host, from a read: {state, at} where state is signed_in, signed_out or never (no site
 * recorded), or {state: null, why} when it cannot be told (no_grant, unreachable, browser_profile_unknown).
 */
export function siteState(read, profile, host) {
  if (!read) return { state: null, why: 'not_read' };
  if (!read.ok) return { state: null, why: read.why };
  const p = read.profiles.find(x => x?.id === profile);
  if (!p) return { state: null, why: 'browser_profile_unknown' };
  const site = (p.sites ?? []).find(s => s?.host === host);
  if (!site) return { state: 'never', at: null };
  const state = site.state ?? (site.signed_out_at || !site.signed_in_at ? 'signed_out' : 'signed_in');
  return { state, at: state === 'signed_in' ? site.signed_in_at ?? null : site.signed_out_at ?? null, ...(site.handle ? { handle: site.handle } : {}) };
}
