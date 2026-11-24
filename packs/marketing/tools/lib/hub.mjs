// The marketing hub, called from a node tool. MARKETING_HUB is the service
// binding `soot tool-forward` reads ({service_url, service_token}); the tool
// posts the same soot/v1 envelope to <service_url>/v1/tool itself, so one tool
// call can read several hub tools (a view) or act on the hub after its own
// checks (release_due). Node built-ins only. The token never leaves this
// module: answers carry the host, never the URL's credentials or the token.
//
// Every answer is {ok, host, ms, data?, error?, message?}:
//   error  not_configured  no binding, or one that is not a service binding
//          unauthorized    401/403
//          timeout         no answer within the deadline (4 s for reads)
//          unreachable     no connection, a 5xx, or an answer that is not JSON
//          refused         the hub's own decided "no" (400 invalid_input); `message` says why
// A refusal is a call outcome; the hub itself is fine (source ok).

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
export const READ_TIMEOUT_MS = 4000;
export const WRITE_TIMEOUT_MS = 15000;
const PATH = /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,63}){0,8}\/?$/;

/** Parse MARKETING_HUB like `soot tool-forward` does; `{ok:false, error}` when it is unset or not a binding. */
export function hubBinding(env) {
  const raw = typeof env?.MARKETING_HUB === 'string' ? env.MARKETING_HUB.trim() : '';
  if (!raw) return { ok: false, error: 'not_configured', host: null };
  let b;
  try { b = JSON.parse(raw); } catch { return { ok: false, error: 'not_configured', host: null }; }
  if (!b || typeof b !== 'object' || typeof b.service_url !== 'string' || typeof b.service_token !== 'string') return { ok: false, error: 'not_configured', host: null };
  let u;
  try { u = new URL(b.service_url); } catch { return { ok: false, error: 'not_configured', host: null }; }
  const host = u.hostname;
  const secure = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(host));
  if (!secure || u.username || u.password || u.search || u.hash || !PATH.test(u.pathname) || u.pathname.replace(/\/+$/, '').endsWith('/v1/tool')) return { ok: false, error: 'not_configured', host };
  if (b.service_token.length < 32 || b.service_token.length > 4096 || /[^\x21-\x7e]/.test(b.service_token)) return { ok: false, error: 'not_configured', host };
  return { ok: true, url: b.service_url.replace(/\/+$/, ''), token: b.service_token, host: u.host };
}

/**
 * One hub tool call. `tool` is the hub's tool name (cms_read, social_list, …); the operation is sent as
 * `marketing_<tool>`, which the hub routes on its suffix. Never retries: a write whose answer is lost is
 * looked up by the caller, never sent twice.
 */
export async function hubCall(env, tool, input = {}, { fetchImpl = fetch, timeoutMs = READ_TIMEOUT_MS, soot = 'marketing', hook = 'tool.call', interaction = false, now = () => Date.now() } = {}) {
  const b = hubBinding(env);
  const started = now();
  if (!b.ok) return { ok: false, host: b.host, ms: 0, error: b.error };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const envelope = { api_version: 'soot/v1', hook, soot: String(soot || 'marketing').slice(0, 128), operation: `marketing_${tool}`, input, ...(interaction ? { interaction: true } : {}) };
  let res;
  try {
    res = await fetchImpl(`${b.url}/v1/tool`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: ctrl.signal, redirect: 'manual' });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, host: b.host, ms: now() - started, error: ctrl.signal.aborted ? 'timeout' : 'unreachable' };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; } finally { clearTimeout(timer); }
  const ms = now() - started;
  if (ctrl.signal.aborted && body === null) return { ok: false, host: b.host, ms, error: 'timeout' };
  if (res.status === 401 || res.status === 403) return { ok: false, host: b.host, ms, error: 'unauthorized' };
  // The hub admits each client a fixed number of calls a minute and refuses the rest before doing them.
  if (res.status === 429) return { ok: false, host: b.host, ms, error: 'rate_limited' };
  if (res.status === 400 && body?.error?.code === 'invalid_input') return { ok: false, host: b.host, ms, error: 'refused', message: String(body.error.message ?? '').slice(0, 500) };
  if (res.status !== 200 || body === null || typeof body !== 'object') return { ok: false, host: b.host, ms, error: 'unreachable', status: res.status };
  return { ok: true, host: b.host, ms, data: body };
}

/** The `sources[]` entry of a hub read: {id:'hub', ok, host, error?, ms, last_ok_at}. */
export function hubSource(results, lastOkAt = null) {
  const list = (Array.isArray(results) ? results : [results]).filter(Boolean);
  const host = list.find(r => r.host)?.host ?? null;
  const bad = list.find(r => !r.ok && r.error !== 'refused');
  const ms = list.reduce((m, r) => Math.max(m, r.ms ?? 0), 0);
  if (!list.length) return { id: 'hub', ok: false, host, error: 'not_configured', ms: 0, last_ok_at: lastOkAt };
  return bad ? { id: 'hub', ok: false, host, error: bad.error, ms, last_ok_at: lastOkAt } : { id: 'hub', ok: true, host, ms, last_ok_at: new Date().toISOString() };
}
