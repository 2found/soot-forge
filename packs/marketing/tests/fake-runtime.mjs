// A fake Nest runtime for the browser.profiles.read / browser.profiles.report scopes (contract browser-profiles §3a):
// GET the profiles (sorted by id, as the runtime answers), POST a sign-out, PUT and DELETE a use. Every request is recorded; the token is a test value.
export const RUNTIME = 'http://127.0.0.1:7788';
export const TOKEN = 'srt_test-token-not-a-secret';
export const runtimeEnv = () => ({ SOOT_RUNTIME_URL: RUNTIME, SOOT_RUNTIME_TOKEN: TOKEN });
const USE_KEY = /^[a-z0-9:._@-]{1,64}$/;
const MAX_USES = 8;

/**
 * profiles: [{id, name?, project?, groups?, soots?, allowed?, granted?}]; scopes: which of read/report the token holds.
 * `fallback` answers any other origin (the hub), so one fetch serves both.
 */
export function fakeRuntime({ profiles = [], scopes = ['read', 'report'], fallback = null, clock = () => Date.now() } = {}) {
  const rt = { calls: [], sites: {}, uses: {}, profiles: profiles.map(p => ({ groups: [], soots: [], allowed: [], granted: false, ...p })).sort((a, b) => (a.id < b.id ? -1 : 1)) };
  const answer = (status, body) => ({ ok: status < 300, status, json: async () => body });
  rt.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin !== RUNTIME) {
      if (fallback) return fallback(url, init);
      throw new Error('no network');
    }
    const method = init.method ?? 'GET';
    const auth = init.headers?.authorization;
    rt.calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    if (auth !== `Bearer ${TOKEN}`) return answer(401, { code: 'runtime_token_invalid', error: 'no' });
    if (method === 'GET' && u.pathname === '/v1/runtime/browser-profiles') {
      if (!scopes.includes('read')) return answer(403, { code: 'runtime_scope_forbidden', error: 'no' });
      return answer(200, { profiles: rt.profiles.map(p => ({ name: p.id, ...p, sites: rt.sites[p.id] ?? [], usage: rt.uses[p.id] ?? [] })) });
    }
    const m = /^\/v1\/runtime\/browser-profiles\/([^/]+)\/(signed-out|usage)(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return answer(404, { code: 'not_found', error: 'no' });
    if (!scopes.includes('report')) return answer(403, { code: 'runtime_scope_forbidden', error: 'no' });
    const id = decodeURIComponent(m[1]);
    if (!rt.profiles.some(p => p.id === id)) return answer(404, { code: 'browser_profile_unknown', error: 'no' });
    const uses = rt.uses[id] ??= [];
    if (m[2] === 'usage' && method === 'PUT' && !m[3]) {
      const b = JSON.parse(init.body);
      if (!USE_KEY.test(b.key ?? '') || typeof b.label !== 'string' || !b.label || b.label.length > 80 || (b.link && !String(b.link).startsWith('nest://'))) return answer(400, { code: 'usage_invalid', error: 'no' });
      const i = uses.findIndex(x => x.key === b.key);
      const use = { pack: 'marketing', key: b.key, label: b.label, ...(b.link ? { link: b.link } : {}), at: new Date(clock()).toISOString() };
      const changed = i < 0 || uses[i].label !== use.label || uses[i].link !== use.link;
      if (i < 0 && uses.length >= MAX_USES) return answer(409, { code: 'usage_full', error: 'no' });
      if (i < 0) uses.push(use); else uses[i] = use;
      return answer(200, { profile: id, use, changed });
    }
    if (m[2] === 'usage' && method === 'DELETE' && m[3]) {
      const key = decodeURIComponent(m[3]);
      const i = uses.findIndex(x => x.key === key);
      if (i >= 0) uses.splice(i, 1);
      return answer(200, { profile: id, changed: i >= 0 });
    }
    return answer(405, { code: 'method_not_allowed', error: 'no' });
  };
  /** The person's "Tôi đã đăng nhập" in Nest at `at`, as `handle` when Nest knows it. */
  rt.signIn = (id, host, at, handle) => {
    rt.sites[id] = [...(rt.sites[id] ?? []).filter(s => s.host !== host), { host, ...(handle ? { handle } : {}), signed_in_at: new Date(at).toISOString(), state: 'signed_in' }];
  };
  rt.writes = () => rt.calls.filter(c => c.method !== 'GET');
  return rt;
}
