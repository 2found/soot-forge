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

function run(cmd, input, { token = TOKEN, hook = 'tool.call', env = {}, event = { subject: 'conv-1' }, project } = {}) {
  seen = [];
  const call = { api_version: 'soot/v1', hook, event, input, ...(project ? { project } : {}) };
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

test('ranks reads a public board with its period or chart month; a bad board never leaves the tool', async () => {
  const lohi = await run('lookup', { kind: 'ranks', period: 'week', limit: 5 }, { token: '' });
  assert.equal(lohi.code, 0);
  assert.equal(seen[0].url, '/agent/support/lookup/ranks/novels?limit=5&period=week');
  assert.equal(seen[0].headers['x-soot-principal'], undefined);
  const qd = await run('lookup', { kind: 'ranks', board: 'yuepiao', month: '2026-10' }, { token: '' });
  assert.equal(qd.code, 0);
  assert.equal(seen[0].url, '/agent/support/lookup/ranks/yuepiao?limit=10&month=2026-10');
  for (const input of [{ board: '../me/wallet' }, { board: 'yuepiao', month: '2026-13' }, { period: 'year' }]) {
    const bad = await run('lookup', { kind: 'ranks', ...input }, { token: '' });
    assert.equal(bad.code, 1, JSON.stringify(input));
    assert.equal(seen.length, 0, `${JSON.stringify(input)}: nothing sent`);
  }
});

test('characters and wiki are one call: the novel as the reader named it, or none; wiki needs q', async () => {
  answer = () => [200, { characters: [], entries: [] }];
  const c = await run('lookup', { kind: 'characters', novel: 'Kiếm Lai', q: 'Trần Bình An' });
  assert.equal(c.code, 0, c.stderr);
  assert.equal(seen[0].url, '/agent/support/lookup/story/characters?novel=Ki%E1%BA%BFm%20Lai&q=Tr%E1%BA%A7n%20B%C3%ACnh%20An');
  assert.ok(seen[0].headers['x-soot-principal']);
  const byId = await run('lookup', { kind: 'characters', novelId: 'n1' }, { token: '' });
  assert.equal(byId.code, 0);
  assert.equal(seen[0].url, '/agent/support/lookup/story/characters?novel=n1');
  const recent = await run('lookup', { kind: 'characters', q: 'Ninh Diêu' });
  assert.equal(recent.code, 0);
  assert.equal(seen[0].url, '/agent/support/lookup/story/characters?q=Ninh%20Di%C3%AAu');
  const w = await run('lookup', { kind: 'wiki', novel: 'https://lohi2.com/truyen/kiem-lai', q: 'Kiếm Khí' }, { token: '' });
  assert.equal(w.code, 0);
  assert.equal(seen[0].url, '/agent/support/lookup/story/wiki?novel=https%3A%2F%2Flohi2.com%2Ftruyen%2Fkiem-lai&q=Ki%E1%BA%BFm%20Kh%C3%AD');
  const bad = await run('lookup', { kind: 'wiki', novel: 'Kiếm Lai' }, { token: '' });
  assert.equal(bad.code, 1);
  assert.equal(seen.length, 0, 'wiki without q: nothing sent');
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

// Product gate: one runtime may serve several projects; a conversation that is not Lohi's is refused
// in one line before any request.
test('product gate: another product, a foreign binding or an unproven write is refused with no request', async () => {
  for (const [name, cmd, input, opts] of [
    ['SOOT_PROJECT env', 'lookup', { kind: 'features' }, { env: { SOOT_PROJECT: '2novel' } }],
    ['ToolCall project', 'lookup', { kind: 'wallet' }, { project: '2novel' }],
    ['write', 'request-novel', { title: 'X' }, { env: { SOOT_PROJECT: 'trysoot' } }],
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

test('product gate: the Lohi project, a Lohi binding or a principal still work', async () => {
  assert.equal((await run('lookup', { kind: 'features' }, { env: { SOOT_PROJECT: 'lohi' } })).code, 0);
  assert.equal((await run('lookup', { kind: 'features' }, { env: { SOOT_PROJECT: 'acme', LOHI_PRODUCT: 'acme' } })).code, 0);
  assert.equal((await run('lookup', { kind: 'features' }, { event: { subject: 'c', binding: 'lohi' }, env: { LOHI_BINDINGS: 'lohi' } })).code, 0);
  assert.equal((await run('report-content', { novelId: 'n1', kind: 'empty_chapter', from: 1 }, { token: '', env: { SOOT_PROJECT: 'lohi' } })).code, 0);
  const withPrincipal = await run('report-content', { novelId: 'n1', kind: 'empty_chapter', from: 1 });
  assert.equal(withPrincipal.code, 0, withPrincipal.stdout + withPrincipal.stderr);
});

// Exit >=2 fences the resource for every Soot until a person checks, so only a
// write that may have reached the api may say "unknown". A write that never
// connected, or a runner that broke before sending, did nothing: exit 1.
test('an approval-gated write that never reached the api is decided (exit 1)', async () => {
  const closed = createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise(r => closed.close(r));
  const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-01T01:00:00Z' };
  const refused = await run('recover-topup', window, { env: { LOHI_API_BASE: `http://127.0.0.1:${port}` } });
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, 'transport_7');
  // A jq failure while building the body (input is not an object) exits 5
  // under set -e; nothing was sent, so it is decided too.
  const broken = await run('recover-topup', 'not-an-object');
  assert.equal(broken.code, 1, broken.stdout + broken.stderr);
  assert.equal(seen.length, 0);
});

test('an approval-gated write the api may have committed stays unknown (exit >=2)', async () => {
  answer = () => [503, { error: 'unavailable' }];
  try {
    const r = await run('recover-topup', { from: '2026-11-01T00:00:00Z', to: '2026-11-01T01:00:00Z' });
    assert.ok(r.code >= 2, `5xx on the real call must stay unknown, got ${r.code}`);
    assert.equal(seen.length, 1);
  } finally { answer = () => [200, { ok: true }]; }
});

// bs-86omy0rq: one book, one request, three asks + a source link.
test('request-novel passes the api answer through, hub_url included', async () => {
  answer = () => [201, { id: 'r1', hub_url: '/yeu-cau/r1', stage: 'scoring', score: 1, threshold: 20 }];
  try {
    const r = await run('request-novel', { title: 'Sách mới', requestId: 'x' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).hub_url, '/yeu-cau/r1');
  } finally { answer = () => [200, { ok: true }]; }
});

test('lookup requests reads the reader\'s own list (stage, progress, hub_url come from the api)', async () => {
  answer = () => [200, { items: [{ id: 'r1', stage: 'translating', progress: { done: 3, total: 10 }, needs_you: false, hub_url: '/yeu-cau/r1' }] }];
  try {
    const r = await run('lookup', { kind: 'requests', limit: 20 });
    assert.equal(r.code, 0);
    assert.equal(seen[0].url, '/agent/support/lookup/me/requests?limit=20');
    assert.equal(JSON.parse(r.stdout).items[0].progress.total, 10);
  } finally { answer = () => [200, { ok: true }]; }
});

test('send-source posts the link as the bound reader; a bad id or link is refused before any request', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  answer = () => [200, { changed: true, reopened: false, stage: 'onboarding', hub_url: `/yeu-cau/${id}` }];
  try {
    const ok = await run('send-source', { id, url: 'https://example.com/book/1' });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(seen[0].url, `/agent/support/requests/${id}/source`);
    assert.deepEqual(seen[0].body, { conversationId: 'conv-1', url: 'https://example.com/book/1' });
    assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
    const anon = await run('send-source', { id, url: 'https://example.com/b' }, { token: '' });
    assert.equal(JSON.parse(anon.stdout).code, 'principal_required');
    assert.equal(seen.length, 0);
    const badId = await run('send-source', { id: '../x', url: 'https://example.com/b' });
    assert.equal(badId.code, 1);
    assert.equal(seen.length, 0, 'the id is never put in a path unchecked');
    const badUrl = await run('send-source', { id, url: 'javascript:alert(1)' });
    assert.equal(badUrl.code, 1);
    assert.equal(seen.length, 0);
  } finally { answer = () => [200, { ok: true }]; }
  // the api's refusal reaches the Soot as said
  answer = () => [400, { error: 'invalid_source_url', code: 'invalid_source_url', details: { reason: 'private_ip' } }];
  try {
    const r = await run('send-source', { id, url: 'http://10.0.0.1/x' });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).code, 'invalid_source_url');
  } finally { answer = () => [200, { ok: true }]; }
});

test('audio-pro is a quote: one GET for tts_pro_create, never a POST, never a price', async () => {
  const quote = { novel: { slug: 'kiem-lai', title: 'Kiếm Lai' }, kind: 'tts_pro_create', quote: { price: 0, priceGas: 100, range: { from: 21, to: 40, chapters: 20 } }, action_url: 'https://lohi2.com/truyen/kiem-lai?gas-action=tts_pro_create&from=21&to=40' };
  answer = () => [200, quote];
  try {
    const r = await run('audio-pro', { novelSlug: 'kiem-lai', fromChapter: 21, toChapter: 40, step: 'confirm', expect: { from: 21, to: 40, cost: 20 }, price: 1 });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai/quote?kind=tts_pro_create&from=21&to=40');
    assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
    assert.equal(JSON.parse(r.stdout).action_url, quote.action_url);

    const one = await run('audio-pro', { novelSlug: 'https://lohi2.com/truyen/kiem-lai/chuong-21', fromChapter: 21 });
    assert.equal(one.code, 0, one.stdout + one.stderr);
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai/quote?kind=tts_pro_create&chapter=21', 'slug from a link, one chapter');

    // the api's refusal is passed on as it said it
    answer = () => [422, { error: 'not_eligible', message: 'Truyện này dịch trong Studio' }];
    const refused = await run('audio-pro', { novelSlug: 'kiem-lai', fromChapter: 21 });
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.stdout).error, 'not_eligible');

    const anon = await run('audio-pro', { novelSlug: 'kiem-lai', fromChapter: 21 }, { token: '' });
    assert.equal(JSON.parse(anon.stdout).code, 'principal_required');
    assert.equal(seen.length, 0);
    for (const bad of [{ novelSlug: '../x', fromChapter: 1 }, { novelSlug: 'kiem-lai' }, { novelSlug: 'kiem-lai', fromChapter: 40, toChapter: 21 }]) {
      const r2 = await run('audio-pro', bad);
      assert.equal(r2.code, 1, JSON.stringify(bad));
      assert.equal(seen.length, 0, `${JSON.stringify(bad)}: nothing sent`);
    }
    // the dry-run hook is no longer answered: nothing is ever held for approval
    const pre = await run('audio-pro', { novelSlug: 'kiem-lai', fromChapter: 21 }, { hook: 'tool.preflight' });
    assert.equal(pre.code, 1);
    assert.equal(seen.length, 0);
  } finally { answer = () => [200, { ok: true }]; }
});

test('gas reads the novel tank (principal optional); a named amount also asks for the top-up link', async () => {
  const card = { novel: { slug: 'kiem-lai', title: 'Kiếm Lai' }, gas: { phase: 'running', balanceLt: 340, chaptersLeft: 12, chaptersWaiting: 330 }, reach: { first_waiting: 1201, auto_until: 1212, last_chapter: 1530 }, top_up_url: 'https://lohi2.com/truyen/kiem-lai?nap-gas=1' };
  answer = (req) => req.url.includes('/top-up-link') ? [200, { url: 'https://lohi2.com/truyen/kiem-lai?nap-gas=500', gas: 500 }] : [200, card];
  try {
    const r = await run('gas', { novel: 'kiem-lai' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai');
    assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
    assert.deepEqual(JSON.parse(r.stdout), card);

    const anon = await run('gas', { novel: 'https://lohi2.com/truyen/kiem-lai?ref=x' }, { token: '' });
    assert.equal(anon.code, 0, 'the tank reads without a reader');
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai');
    assert.equal(seen[0].headers['x-soot-principal'], undefined);

    const amt = await run('gas', { novel: 'kiem-lai', gas: 500 });
    assert.equal(amt.code, 0, amt.stdout + amt.stderr);
    assert.deepEqual(seen.map(x => x.url), ['/agent/support/gas/kiem-lai', '/agent/support/gas/kiem-lai/top-up-link?gas=500']);
    const out = JSON.parse(amt.stdout);
    assert.equal(out.top_up_url, 'https://lohi2.com/truyen/kiem-lai?nap-gas=500');
    assert.equal(out.top_up_gas, 500);
    assert.equal(out.gas.balanceLt, 340);
    assert.ok(seen.every(x => x.method === 'GET'), 'gas never writes');

    answer = (req) => req.url.includes('/top-up-link') ? [409, { error: 'top_up_refused', message: 'Truyện đã dừng, không dịch thêm' }] : [200, card];
    const refused = await run('gas', { novel: 'kiem-lai', gas: 100 });
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.stdout).error, 'top_up_refused');

    for (const bad of [{ novel: '../me/wallet' }, { novel: 'https://example.com/books/1' }, { novel: 'kiem-lai', gas: 0 }, { novel: 'kiem-lai', gas: '1;rm' }, {}]) {
      const b = await run('gas', bad);
      assert.equal(b.code, 1, JSON.stringify(bad));
      assert.equal(seen.length, 0, `${JSON.stringify(bad)}: nothing sent`);
    }
  } finally { answer = () => [200, { ok: true }]; }
});

test('gas-quote asks the api for THIS reader\'s quote (principal header, kind + range in the query, no price)', async () => {
  answer = () => [200, { kind: 'translate_range', quote: { price: 120, priceGas: 1500 }, action_url: 'https://lohi2.com/truyen/kiem-lai?gas-action=translate_range&from=1201&to=1250' }];
  try {
    const r = await run('gas-quote', { novel: 'kiem-lai', kind: 'translate_range', from: 1201, to: 1250, price: 1 });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai/quote?kind=translate_range&from=1201&to=1250');
    assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
    assert.equal(seen[0].body, null);
    assert.match(JSON.parse(r.stdout).action_url, /gas-action=translate_range/);

    await run('gas-quote', { novel: 'https://lohi2.com/truyen/kiem-lai/chuong-1201', kind: 'translate_chapter', chapter: 1201 });
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai/quote?kind=translate_chapter&chapter=1201');

    // legacy scope: no principal, the bound conversation names the reader
    await run('gas-quote', { novel: 'kiem-lai', kind: 'translate_chapter', chapter: 3 }, { token: '', env: { LOHI_CS_LEGACY_SCOPE: '1' } });
    assert.equal(seen[0].url, '/agent/support/gas/kiem-lai/quote?kind=translate_chapter&chapter=3&conversationId=conv-1');

    const anon = await run('gas-quote', { novel: 'kiem-lai', kind: 'translate_chapter', chapter: 3 }, { token: '' });
    assert.equal(JSON.parse(anon.stdout).code, 'principal_required');
    assert.equal(seen.length, 0);
    for (const bad of [
      { novel: 'kiem-lai', kind: 'unlock', chapter: 3 },
      { novel: 'kiem-lai', kind: 'translate_range', from: 50, to: 10 },
      { novel: 'kiem-lai', kind: 'translate_range', from: 1.5, to: 10 },
      { novel: 'kiem-lai', kind: 'translate_range' },
      { novel: 'Kiếm Lai', kind: 'translate_chapter', chapter: 3 },
    ]) {
      const b = await run('gas-quote', bad);
      assert.equal(b.code, 1, JSON.stringify(bad));
      assert.equal(seen.length, 0, `${JSON.stringify(bad)}: nothing sent`);
    }
  } finally { answer = () => [200, { ok: true }]; }
});

test('pack.json: the gas tools are read-only, audio-pro is a quote with no preflight, and no tool takes a price', async () => {
  const pack = JSON.parse(await readFile(new URL('../pack.json', import.meta.url), 'utf8'));
  const tools = Object.fromEntries(pack.tools.map(t => [t.name, t]));
  assert.deepEqual(tools.lohi_send_source.run.args, ['send-source']);
  assert.deepEqual(tools.lohi_gas.run.args, ['gas']);
  assert.deepEqual(tools.lohi_gas_quote.run.args, ['gas-quote']);
  assert.deepEqual(tools.lohi_request_audio_pro.run.args, ['audio-pro']);
  for (const name of ['lohi_gas', 'lohi_gas_quote', 'lohi_request_audio_pro']) {
    assert.equal(tools[name].run.mode, 'read', `${name} is read-only`);
    assert.equal(tools[name].run.preflight, undefined, `${name} holds nothing for approval`);
    assert.equal(tools[name].run.approval, undefined);
  }
  assert.deepEqual(Object.keys(tools.lohi_request_audio_pro.parameters.properties).sort(), ['fromChapter', 'novelSlug', 'toChapter']);
  for (const t of pack.tools) assert.ok(!('price' in (t.parameters.properties ?? {})), `${t.name} takes no price`);
  // the reader's words: no points, no Pro quota in any tool prompt
  for (const t of pack.tools) assert.doesNotMatch(t.description, /quota|điểm|hạn mức|score\/threshold/i, t.name);
  assert.match(tools.lohi_request_novel.description, /hub_url/);
  assert.match(tools.lohi_lookup.description, /needs_you/);
  assert.match(tools.lohi_gas.description, /top_up_url/);
  assert.match(tools.lohi_gas_quote.description, /action_url/);
});
