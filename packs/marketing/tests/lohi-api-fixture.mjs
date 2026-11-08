// A fixture of the Lohi api's campaign routes (design §7, frozen shapes):
// POST /admin/links → {code, url}; GET /admin/analysis/campaigns/:id?from&to →
// {clicks, signups}; X-API-Key auth (401 on a wrong key; 403 for `limitedKey`, a key without the role). `mode` is ok, error
// (503) or hang (never answers). Used by the tests and the real local check:
// node tests/lohi-api-fixture.mjs <port> <key>.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function startFixture({ key, limitedKey = null, port = 0, host = '127.0.0.1' } = {}) {
  let seq = 0;
  const state = {
    mode: 'ok', calls: [], analysis: { clicks: [], signups: [] }, links: new Map(),
    reset() { this.mode = 'ok'; this.calls = []; this.analysis = { clicks: [], signups: [] }; },
  };
  const hung = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const call = { method: req.method, path: req.url, key: req.headers['x-api-key'] ?? null, body: raw ? JSON.parse(raw) : null };
    state.calls.push(call);
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (state.mode === 'hang') { hung.add(res); return; }
    if (state.mode === 'error') return send(503, { error: 'unavailable' });
    if (limitedKey && call.key === limitedKey) return send(403, { error: 'forbidden' });
    if (call.key !== key) return send(401, { error: 'authentication_required' });
    if (req.method === 'POST' && req.url === '/admin/links') {
      const code = 'c' + (++seq).toString(36).padStart(5, '0');
      state.links.set(code, call.body);
      return send(201, { code, url: `https://api.lohi2.com/r/${code}` });
    }
    const m = /^\/admin\/analysis\/campaigns\/([^/?]+)\?from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) return send(200, state.analysis);
    return send(404, { error: 'not_found' });
  });
  return new Promise(resolve => server.listen(port, host, () => {
    state.url = `http://${host}:${server.address().port}`;
    state.close = () => { for (const r of hung) r.destroy(); server.closeAllConnections?.(); return new Promise(ok => server.close(ok)); };
    resolve(state);
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [port, key, analysis] = process.argv.slice(2);
  const s = await startFixture({ key, port: Number(port) });
  if (analysis) s.analysis = JSON.parse(analysis);
  console.log(`lohi api fixture on ${s.url}`);
}
