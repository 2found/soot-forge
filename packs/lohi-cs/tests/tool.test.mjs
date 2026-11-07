// lohi-cs runner (tools/soot-lohi-api) against a fake Lohi api: the reader's own
// data goes to /lookup/me/* with X-Soot-Principal, anonymous conversations ask
// nothing, the secrets never reach argv or output, public reads need no token.
// tests/ is not shipped in the pack archive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = new URL('../tools/soot-lohi-api', import.meta.url).pathname;
const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const KEY = 'test-only-key-not-real';
let server, base, seen = [], answer = () => [200, { ok: true }], state;

before(async () => {
  state = await mkdtemp(join(tmpdir(), 'lohi-cs-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c).on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const [status, out] = answer(req);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await rm(state, { recursive: true, force: true }); });

function run(cmd, input, { token = TOKEN, hook = 'tool.call', env = {} } = {}) {
  seen = [];
  const call = { api_version: 'soot/v1', hook, event: { subject: 'conv-1' }, input };
  return new Promise(resolve => {
    const child = spawn(bin, [cmd], { env: { PATH: process.env.PATH, LOHI_API_BASE: base, LOHI_CS_API_KEY: KEY, SOOT_PACK_STATE: state, ...(token ? { SOOT_PRINCIPAL_TOKEN: token } : {}), ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(call) + '\n');
  });
}

test('the reader\'s own data is read from /lookup/me/* with the principal header and no user id or conversation in the URL', async () => {
  for (const [kind, path] of [['me', '/agent/support/lookup/me'], ['wallet', '/agent/support/lookup/me/wallet?limit=10'], ['unlocks', '/agent/support/lookup/me/unlocks?limit=10'], ['topups', '/agent/support/lookup/me/topups?limit=10'], ['subscription', '/agent/support/lookup/me/subscription?limit=10']]) {
    const r = await run('lookup', { kind });
    assert.equal(r.code, 0, `${kind}: ${r.stdout}${r.stderr}`);
    assert.equal(seen.length, 1, `${kind}: one request, no userId resolution round trip`);
    assert.equal(seen[0].url, path);
    assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
    assert.equal(seen[0].headers['x-api-key'], KEY);
  }
  const h = await run('history', { limit: 5, q: 'nạp' });
  assert.equal(seen[0].url, '/agent/support/lookup/me/history?limit=5&q=n%E1%BA%A1p');
  assert.equal(h.code, 0);
  const rec = await run('lookup', { kind: 'recommend', like: 'Phàm Nhân' });
  assert.match(seen[0].url, /^\/agent\/support\/lookup\/me\/recommendations\?limit=8&like=/);
  assert.equal(rec.code, 0);
});

test('an anonymous conversation asks nothing about a reader and says principal_required', async () => {
  for (const [cmd, input] of [['lookup', { kind: 'wallet' }], ['lookup', { kind: 'me' }], ['history', {}], ['request-novel', { title: 'X' }], ['recover-topup', { from: '2026-11-01T00:00:00Z', to: '2026-11-01T01:00:00Z' }]]) {
    const r = await run(cmd, input, { token: '' });
    assert.equal(r.code, 1, cmd);
    assert.equal(JSON.parse(r.stdout).code, 'principal_required', cmd);
    assert.equal(seen.length, 0, `${cmd}: nothing sent`);
  }
});

test('public catalogue reads need no principal; a malformed token is never sent', async () => {
  const r = await run('lookup', { kind: 'features', q: 'audio pro' }, { token: '' });
  assert.equal(r.code, 0);
  assert.equal(seen[0].url, '/agent/support/lookup/features?q=audio%20pro');
  assert.equal(seen[0].headers['x-soot-principal'], undefined);
  const bad = await run('lookup', { kind: 'wallet' }, { token: 'not a jws"\nheader = "X-Evil: 1' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /principal_invalid/);
  assert.equal(seen.length, 0);
});

test('the api\'s principal refusals reach the Soot as the api said them', async () => {
  answer = () => [403, { code: 'principal_mismatch' }];
  const r = await run('lookup', { kind: 'wallet' });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).code, 'principal_mismatch');
  answer = () => [200, { ok: true }];
});

test('writes keep their bodies and add the header; neither secret appears in output', async () => {
  const r = await run('request-novel', { title: 'Truyện mới' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(seen[0].url, '/agent/support/requests');
  assert.equal(seen[0].body.conversationId, 'conv-1');
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  assert.equal(seen[0].headers['content-type'], 'application/json');
  answer = () => [200, { reader: { userId: 'u1' }, window: {}, candidates: [] }];
  const pre = await run('recover-topup', { from: '2026-11-01T00:00:00Z', to: '2026-11-01T01:00:00Z' }, { hook: 'tool.preflight' });
  assert.equal(pre.code, 0, pre.stdout + pre.stderr);
  assert.equal(seen[0].body.dryRun, true);
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  answer = () => [200, { ok: true }];
  for (const out of [r, pre]) assert.ok(!(out.stdout + out.stderr).includes(TOKEN) && !(out.stdout + out.stderr).includes(KEY));
});

test('secrets reach curl only through its config on stdin, never argv', async () => {
  const text = await readFile(bin, 'utf8');
  for (const line of text.split('\n').filter(l => /\bcurl\b/.test(l) && !l.trim().startsWith('#') && !/command -v/.test(l))) {
    assert.match(line, /-K -/, line);
    assert.doesNotMatch(line, /LOHI_CS_API_KEY|principal|-H /, line);
  }
});

// Dual-write window (CS engine P5.3, removed in R2): with LOHI_CS_LEGACY_SCOPE=1
// granted, a conversation from the legacy cs bridge (no principal) is scoped by
// conversationId and the api checks the bound thread.
test('legacy scope: no principal + LOHI_CS_LEGACY_SCOPE=1 reads by conversationId; the api decides', async () => {
  const legacy = { token: '', env: { LOHI_CS_LEGACY_SCOPE: '1' } };
  answer = req => req.url.startsWith('/agent/support/lookup/me?') ? [200, { userId: 'u 1' }] : [200, { ok: true }];
  const w = await run('lookup', { kind: 'wallet', limit: 3 }, legacy);
  assert.equal(w.code, 0, w.stdout + w.stderr);
  assert.deepEqual(seen.map(s => s.url), ['/agent/support/lookup/me?conversationId=conv-1', '/agent/support/lookup/users/u%201/wallet?conversationId=conv-1&limit=3']);
  assert.ok(seen.every(s => s.headers['x-soot-principal'] === undefined));
  const h = await run('history', { limit: 5 }, legacy);
  assert.equal(h.code, 0);
  assert.equal(seen[1].url, '/agent/support/lookup/users/u%201/messages?conversationId=conv-1&limit=5');
  const me = await run('lookup', { kind: 'me' }, legacy);
  assert.equal(me.code, 0);
  assert.deepEqual(seen.map(s => s.url), ['/agent/support/lookup/me?conversationId=conv-1']);
  const n = await run('request-novel', { title: 'Legacy' }, legacy);
  assert.equal(n.code, 0, n.stdout + n.stderr);
  assert.equal(seen[0].body.conversationId, 'conv-1');
  // An unbound conversation is the api's refusal, passed through.
  answer = () => [403, { error: 'thread_unbound' }];
  const u = await run('lookup', { kind: 'topups' }, legacy);
  assert.equal(u.code, 1);
  assert.equal(JSON.parse(u.stdout).error, 'thread_unbound');
  assert.equal(seen.length, 1, 'no second request after the refusal');
  answer = () => [200, { ok: true }];
  // Without the grant an anonymous conversation still asks nothing.
  const off = await run('lookup', { kind: 'wallet' }, { token: '', env: { LOHI_CS_LEGACY_SCOPE: '0' } });
  assert.equal(JSON.parse(off.stdout).code, 'principal_required');
  assert.equal(seen.length, 0);
});
