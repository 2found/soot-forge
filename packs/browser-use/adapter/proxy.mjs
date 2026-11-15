import {createHash, randomBytes} from 'node:crypto';
import {readFile, writeFile, rename, rm, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';

// Per-profile proxy (contract browser-profiles §6). The host passes a JSON
// object in SOOT_BROWSER_PROXIES over the profiles the calling Soot may open
// that have a proxy. The value is a secret: it never goes on a command line,
// into an output or into the environment of a browser that is not that
// profile's.

export const WEBRTC_ARG = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';
// Everything agent-browser (or a library under it) would read a proxy from.
const AMBIENT = ['SOOT_BROWSER_PROXIES','AGENT_BROWSER_PROXY','AGENT_BROWSER_PROXY_USERNAME','AGENT_BROWSER_PROXY_PASSWORD','AGENT_BROWSER_PROXY_BYPASS',
  'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'];

export function proxyError(code, text) { return Object.assign(new Error(`${code}: ${text}`), {decided: true}); }

/**
 * The entries the host granted. `set` is false when the variable is absent
 * (a host without proxy support); invalid JSON reads as set with no entries,
 * so a proxied launch is then refused rather than made direct.
 */
export function parseProxies(value = process.env.SOOT_BROWSER_PROXIES) {
  if (value === undefined) return {set: false, entries: new Map()};
  const entries = new Map();
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, e] of Object.entries(parsed)) if (e && typeof e === 'object' && !Array.isArray(e)) entries.set(id, e);
    }
  } catch { /* no entries */ }
  return {set: true, entries};
}

/** A well-formed entry, or a refusal. Nothing here echoes a credential. */
export function checkEntry(entry, id) {
  let url;
  try { url = new URL(entry.server); } catch { throw proxyError('browser_proxy_unsupported', `the proxy of browser profile "${id}" is not a valid URL; nothing ran`); }
  const hasLogin = entry.username !== undefined || entry.password !== undefined;
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search)
    throw proxyError('browser_proxy_unsupported', `the proxy of browser profile "${id}" must be http://, https:// or socks5:// host:port; nothing ran`);
  if (hasLogin && (typeof entry.username !== 'string' || typeof entry.password !== 'string' || !entry.username || !entry.password))
    throw proxyError('browser_proxy_secret_missing', `the proxy login of browser profile "${id}" is incomplete; nothing ran. Ask a person to set it in Nest › Cài đặt › Trình duyệt`);
  if (hasLogin && url.protocol === 'socks5:')
    throw proxyError('browser_proxy_unsupported', `the browser cannot sign in to a SOCKS5 proxy (profile "${id}"); use an authenticated HTTP proxy. Nothing ran`);
  return url;
}

/** The proxy's host:port, for messages. Never the login. */
export function proxyHost(entry) {
  try { return new URL(entry.server).host; } catch { return 'the proxy'; }
}

/** Salted digest of what the launch used; the salt keeps the file from being a password oracle. */
export function entryHash(entry, salt) {
  if (!entry) return 'none';
  return createHash('sha256').update(salt).update('\0').update(JSON.stringify([entry.server, entry.username ?? '', entry.password ?? ''])).digest('hex');
}

export const proxyFile = stateDir => join(stateDir, 'proxy.json');
/** What the profile's browser was last launched with: {hash, salt}, or null when unknown. */
export async function readLaunched(stateDir) {
  try {
    const v = JSON.parse(await readFile(proxyFile(stateDir), 'utf8'));
    if (typeof v?.hash === 'string' && typeof v.salt === 'string') return v;
  } catch { /* none */ }
  return null;
}
export async function writeLaunched(stateDir, entry) {
  const salt = randomBytes(16).toString('hex'), path = proxyFile(stateDir), tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  try { await writeFile(tmp, JSON.stringify({hash: entryHash(entry, salt), salt, proxied: !!entry}), {mode: 0o600}); await rename(tmp, path); }
  finally { await rm(tmp, {force: true}); }
}

/**
 * What a call does about the proxy, before anything launches.
 * - `chosen`: how the profile was chosen ('bound' | 'asked' | 'linked'); the
 *   host vetted bound and asked ones (a proxied one without an entry was
 *   refused there), so only a linked profile can arrive here proxied with its
 *   entry missing.
 * - returns {entry|null, relaunch}. Throws when launching would go direct
 *   where the profile was last launched through a proxy.
 */
export function proxyPlan({id, chosen, proxies, launched}) {
  const entry = proxies.entries.get(id) ?? null;
  if (entry?.secret_missing === true)
    throw proxyError('browser_proxy_secret_missing', `the proxy login of browser profile "${id}" is not available; nothing ran. Ask a person to set it in Nest › Cài đặt › Trình duyệt`);
  if (entry) checkEntry(entry, id);
  const wasProxied = !!launched && launched.hash !== entryHash(null, launched.salt);
  const hostVetted = proxies.set && (chosen === 'bound' || chosen === 'asked');
  if (!entry && wasProxied && !hostVetted)
    throw proxyError('browser_proxy_unsupported', `browser profile "${id}" was last opened through a proxy and the host gave none now, so it is not opened directly; nothing ran. Ask a person to check its proxy in Nest › Cài đặt › Trình duyệt`);
  const same = launched ? launched.hash === entryHash(entry, launched.salt) : !entry;
  return {entry, relaunch: !same};
}

/** The environment and browser args for a launch; the one place a proxy reaches the daemon. */
export function launchEnv(base, {entry = null, args = [], argsKey = 'AGENT_BROWSER_ARGS'} = {}) {
  const env = {...base};
  for (const k of AMBIENT) delete env[k];
  const out = [...args];
  if (entry) {
    env.AGENT_BROWSER_PROXY = entry.server;
    if (entry.username !== undefined) { env.AGENT_BROWSER_PROXY_USERNAME = entry.username; env.AGENT_BROWSER_PROXY_PASSWORD = entry.password; }
    if (!out.includes(WEBRTC_ARG)) out.push(WEBRTC_ARG);
  }
  env[argsKey] = out.join(',');
  return {env, args: out};
}

const PROXY_FAILURE = /ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|SOCKS_CONNECTION_HOST_UNREACHABLE|PROXY_AUTH_[A-Z_]+|PROXY_CERTIFICATE_INVALID|NO_SUPPORTED_PROXIES|UNEXPECTED_PROXY_AUTH|PROXY_CONNECTION_REFUSED)/;
export function isProxyFailure(message) { return PROXY_FAILURE.test(String(message ?? '')); }

/** Replace every secret value (and the whole server string) in a message. */
export function scrub(message, entry) {
  let text = String(message ?? '');
  if (!entry) return text;
  for (const v of [entry.password, entry.username]) if (typeof v === 'string' && v.length >= 1) text = text.split(v).join('***');
  return text;
}

/** The error a failed call becomes: proxy trouble names the host only. */
export function mapFailure(error, entry) {
  if (entry && isProxyFailure(error?.message)) return proxyError('browser_proxy_unreachable', proxyHost(entry));
  if (entry && error) { error.message = scrub(error.message, entry); }
  return error;
}
