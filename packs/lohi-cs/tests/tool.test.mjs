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

function run(cmd, input, { token = TOKEN, hook = 'tool.call', env = {}, event = { subject: 'conv-1' }, product } = {}) {
  seen = [];
  const call = { api_version: 'soot/v1', hook, event, input, ...(product ? { product } : {}) };
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

test('request-chapters posts type chapters|quality with the novel and one idempotency key per ask', async () => {
  const novelId = '22222222-2222-4222-8222-222222222222';
  const a = await run('request-chapters', { novelId, title: 'Kiếm Lai', fromChapter: 41, requestId: 'not-a-uuid' });
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(seen[0].url, '/agent/support/requests');
  const first = seen[0].body;
  assert.equal(first.type, 'chapters');
  assert.equal(first.novelId, novelId);
  assert.equal(first.fromChapter, 41);
  assert.equal(first.conversationId, 'conv-1');
  assert.match(first.requestId, /^[0-9a-f-]{36}$/, 'a non-uuid model id is replaced');
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  // the same ask again reuses the stored id; a quality complaint gets its own
  await run('request-chapters', { novelId, title: 'Kiếm Lai', fromChapter: 41, requestId: 'x' });
  assert.equal(seen[0].body.requestId, first.requestId);
  await run('request-chapters', { novelId, type: 'quality', title: 'Kiếm Lai', description: 'Tên nhân vật sai ở nhiều chương' });
  assert.equal(seen[0].body.type, 'quality');
  assert.notEqual(seen[0].body.requestId, first.requestId);
  assert.equal('fromChapter' in seen[0].body, false, 'absent fields are not sent as null');
  // anonymous: nothing is asked
  const anon = await run('request-chapters', { novelId, title: 'x' }, { token: '' });
  assert.notEqual(anon.code, 0);
  assert.equal(seen.length, 0);
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

// interface.subject (subject.v1): the host runs `card` for a conversation's
// principal and shows the card in Nest. I4 → neutral card with Vietnamese
// labels, vi-VN money and dd/MM/yyyy dates in Vietnam time.
const I4 = {
  userId: '3f2c0000-0000-4000-8000-000000000001', name: '  Nguyễn Văn A ', email: 'a+1@example.com',
  tier: 'reader_pass', tierLabel: 'Reading Pass', tierEndsAt: '2026-11-30T18:00:00.000Z',
  ltBalance: 1250, joinedAt: '2025-03-04T10:00:00.000Z',
  lastTopup: { amountVnd: 50000, ltAmount: 500, status: 'pending', createdAt: '2026-11-07T16:30:00.000Z', completedAt: null },
  adminUrl: 'https://lohi2.com/admin/users/list?q=a%2B1%40example.com',
};

test('card maps I4 to a verified subject.v1 card', async () => {
  answer = () => [200, I4];
  const r = await run('card', { conversation: 'conv-1' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/agent/support/lookup/me/card');
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  assert.deepEqual(JSON.parse(r.stdout), {
    state: 'verified',
    title: 'Nguyễn Văn A',
    subtitle: 'a+1@example.com',
    fields: [
      { label: 'Mã người dùng', value: I4.userId },
      // 18:00Z on 30/11 is 01:00 on 01/12 in Vietnam.
      { label: 'Gói', value: 'Reading Pass · hết hạn 01/12/2026' },
      { label: 'Số dư', value: '1.250 LT' },
      { label: 'Tham gia', value: '04/03/2025' },
      { label: 'Nạp gần nhất', value: '50.000 đ · 500 LT · đang chờ · 07/11/2026' },
    ],
    badges: ['Có nạp đang chờ'],
    link: { label: 'Mở trên Lohi', url: I4.adminUrl },
  });
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN) && !(r.stdout + r.stderr).includes(KEY));
  answer = () => [200, { ok: true }];
});

test('card: a free reader with no name and no top-up; a non-https link is dropped', async () => {
  answer = () => [200, { ...I4, name: null, tier: null, tierLabel: null, tierEndsAt: null, ltBalance: 0, lastTopup: null, adminUrl: 'http://lohi2.com/x' }];
  const r = await run('card', {});
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const card = JSON.parse(r.stdout);
  assert.equal(card.title, 'a+1@example.com');
  assert.deepEqual(card.fields.map(f => f.value).slice(1), ['Miễn phí', '0 LT', '04/03/2025', 'Chưa có']);
  assert.deepEqual(card.badges, []);
  assert.equal(card.link, undefined);
  answer = () => [200, { ok: true }];
});

test('card: no principal asks nothing; an api refusal exits 1 with its body', async () => {
  const anon = await run('card', {}, { token: '', env: { LOHI_CS_LEGACY_SCOPE: '1' } });
  assert.equal(anon.code, 1);
  assert.equal(JSON.parse(anon.stdout).code, 'principal_required');
  assert.equal(seen.length, 0);
  answer = () => [404, { error: 'user_not_found' }];
  const gone = await run('card', {});
  assert.equal(gone.code, 1);
  assert.equal(JSON.parse(gone.stdout).error, 'user_not_found');
  answer = () => [200, { ok: true }];
});

test('card: a negative balance and a fractional amount keep their sign and decimals', async () => {
  answer = () => [200, { ...I4, ltBalance: -1250, lastTopup: { ...I4.lastTopup, amountVnd: 50000, ltAmount: 12.5, status: 'completed' } }];
  const r = await run('card', {}, { event: {} });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const card = JSON.parse(r.stdout);
  assert.equal(card.fields[2].value, '-1.250 LT');
  assert.equal(card.fields[4].value, '50.000 đ · 12,5 LT · đã vào ví · 07/11/2026');
  answer = () => [200, { ok: true }];
});

test('only the host names the conversation: a model-supplied input.conversation is never used', async () => {
  const r = await run('lookup', { kind: 'me', conversation: 'someone-elses' }, { token: '', env: { LOHI_CS_LEGACY_SCOPE: '1' }, event: {} });
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /missing_subject/);
  assert.equal(seen.length, 0);
});

test('a transport failure or a non-JSON error page is named, not an empty failure', async () => {
  // Nothing listens on port 9 of loopback: curl fails to connect.
  const down = await run('lookup', { kind: 'me' }, { env: { LOHI_API_BASE: 'http://127.0.0.1:9' } });
  assert.notEqual(down.code, 0);
  const d = JSON.parse(down.stdout.trim());
  assert.match(d.code, /^transport_\d+$/);
  assert.equal(d.retryable, true);
  // A 502 whose body is not a JSON object (a proxy page) is http_502, retryable.
  answer = () => [502, 'bad gateway'];
  const bad = await run('lookup', { kind: 'me' });
  assert.notEqual(bad.code, 0);
  assert.deepEqual(JSON.parse(bad.stdout.trim()), { code: 'http_502', retryable: true });
  // The api's own JSON refusal still reaches the model unchanged.
  answer = () => [404, { code: 'not_found' }];
  const nf = await run('lookup', { kind: 'me' });
  assert.notEqual(nf.code, 0);
  assert.deepEqual(JSON.parse(nf.stdout.trim()), { code: 'not_found' });
  answer = () => [200, { ok: true }];
});

// Product gate: one runtime may serve several products; a conversation that is not Lohi's is refused
// in one line before any request.
test('product gate: another product, a foreign binding or an unproven write is refused with no request', async () => {
  for (const [name, cmd, input, opts] of [
    ['SOOT_PRODUCT env', 'lookup', { kind: 'features' }, { env: { SOOT_PRODUCT: '2novel' } }],
    ['ToolCall product', 'lookup', { kind: 'wallet' }, { product: '2novel' }],
    ['write', 'request-novel', { title: 'X' }, { env: { SOOT_PRODUCT: 'trysoot' } }],
    ['binding', 'lookup', { kind: 'features' }, { event: { subject: 'c', binding: 'web-2found' }, env: { LOHI_BINDINGS: 'lohi, lohi-app' } }],
    ['unproven write', 'report-content', { novelId: 'n1', kind: 'empty_chapter', from: 1 }, { token: '' }],
  ]) {
    const r = await run(cmd, input, opts);
    assert.equal(r.code, 1, name);
    assert.equal(r.stdout.trim().split('\n').length, 1, `${name}: one line`);
    assert.equal(JSON.parse(r.stdout).code, 'not_lohi_conversation', name);
    assert.equal(seen.length, 0, `${name}: no network call`);
  }
});

test('product gate: the Lohi product, a Lohi binding or a principal still work', async () => {
  assert.equal((await run('lookup', { kind: 'features' }, { env: { SOOT_PRODUCT: 'lohi' } })).code, 0);
  assert.equal((await run('lookup', { kind: 'features' }, { env: { SOOT_PRODUCT: 'acme', LOHI_PRODUCT: 'acme' } })).code, 0);
  assert.equal((await run('lookup', { kind: 'features' }, { event: { subject: 'c', binding: 'lohi' }, env: { LOHI_BINDINGS: 'lohi' } })).code, 0);
  assert.equal((await run('report-content', { novelId: 'n1', kind: 'empty_chapter', from: 1 }, { token: '', env: { SOOT_PRODUCT: 'lohi' } })).code, 0);
  const withPrincipal = await run('report-content', { novelId: 'n1', kind: 'empty_chapter', from: 1 });
  assert.equal(withPrincipal.code, 0, withPrincipal.stdout + withPrincipal.stderr);
});
