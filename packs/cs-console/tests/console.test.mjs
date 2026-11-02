// cs-console tools against a fake Soot host and a fake pack storage:
// one person across bindings (AC-P6-3), only the keys' grants (AC-P6-4),
// identity links only from a product-signed proof (P6.4), and refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { view, action, verifyLinkProof, parseConfig, groupPeople, LINK_AUDIENCE } from '../tools/console.mjs';

const HOST = 'http://soot.test';
const TEAM_KEY = 'sk_team_key_0000000000', OTHER_KEY = 'sk_other_key_000000000';

const product = generateKeyPairSync('ed25519');
const x = product.publicKey.export({ format: 'jwk' }).x;
const LINK_KEYS = [{ kid: 'lohi-1', iss: 'https://lohi2.com', x }];

function proof(claims, { key = product.privateKey, kid = 'lohi-1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'EdDSA', kid }), body = enc({ iss: 'https://lohi2.com', aud: LINK_AUDIENCE, tenant: 'lohi', iat: now, exp: now + 120, jti: `j-${Math.random()}`, ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

const conv = (id, binding, principal, extra = {}) => ({ id, soot: 'le-tan', source: { kind: 'channel', ref: binding, label: extra.label ?? 'Khoa' }, control: { owner: 'agent', state: 'active', revision: 3 }, created: extra.created ?? '2026-11-01T07:00:00Z', message_cursor: 2, capabilities: ['control'], ...(principal ? { principal } : {}), ...extra });
const P = (sub, binding, level = 'asserted', tenant = 'lohi') => ({ tenant, binding, sub, level });

function fixture() {
  // What each key can read: the host enforces grants; another team's
  // conversation is visible only to OTHER_KEY, which the console does not hold.
  const byKey = {
    [TEAM_KEY]: [
      conv('c-web', 'lohi-web', P('u-1001', 'lohi-web'), { created: '2026-11-01T07:30:00Z' }),
      conv('c-tg', 'lohi-tg', P('u-1001', 'lohi-tg', 'paired'), { label: 'khoa_tg', created: '2026-11-01T07:10:00Z', control: { owner: 'human', state: 'waiting_human', revision: 5 } }),
      conv('c-tg2', 'lohi-tg', P('tg-777', 'lohi-tg', 'paired'), { label: 'Khoa (tg cũ)' }),
      conv('c-ha', 'lohi-web', P('u-2002', 'lohi-web'), { label: 'Hà' }),
      conv('c-anon', 'lohi-web', P('v_abc', 'lohi-web', 'anonymous')),
      conv('c-nest', '', null),
    ],
    [OTHER_KEY]: [conv('c-other', 'acme-web', P('u-1001', 'acme-web', 'asserted', 'acme'))],
  };
  const messages = {
    'c-web': [{ id: 1, role: 'user', actor_role: 'user', author: 'Khoa', text: 'Em nạp 50k mà chưa thấy LT', created: '2026-11-01T07:30:00Z', audience: 'public' },
      { id: 2, role: 'assistant', actor_role: 'agent', author: 'Lễ tân', text: 'Mình thấy giao dịch đang chờ.', created: '2026-11-01T07:31:00Z', audience: 'public' }],
    'c-tg': [{ id: 1, role: 'user', actor_role: 'user', author: 'khoa_tg', text: 'Audio tắt sau 2 giây', created: '2026-11-01T07:10:00Z', audience: 'public' },
      { id: 2, role: 'user', actor_role: 'member', author: 'Hà', text: 'Đang tạo lại audio', created: '2026-11-01T07:12:00Z', audience: 'public' }],
  };
  const memory = { 'lohi:u-1001': [{ id: 'm1', content: 'Thích đọc tiên hiệp', kind: 'preference' }] };
  const tables = { tags: [], notes: [], links: [], proofs: [] };
  const calls = [];
  let seq = 0;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.pathname + u.search, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    if (u.origin === 'http://storage.test') {
      if (init.headers.Authorization !== 'Bearer sps_call') return json(401, { code: 'unauthorized', error: 'bad token' });
      const [table, op] = u.pathname.split('/').slice(-2);
      const rows = tables[table], body = JSON.parse(init.body);
      if (!rows) return json(404, { code: 'table_not_found', error: 'no table' });
      const match = r => Object.entries(body.where ?? {}).every(([k, v]) => r[k] === v);
      if (op === 'query') return json(200, { rows: rows.filter(match).slice(0, body.limit ?? 50) });
      if (op === 'insert') { const row = { id: `r${++seq}`, created_at: new Date().toISOString(), ...body.row }; rows.push(row); return json(200, { id: row.id, affected: 1 }); }
      if (op === 'delete') { const before = rows.length; tables[table] = rows.filter(r => !(body.id ? r.id === body.id : match(r))); return json(200, { affected: before - tables[table].length }); }
      return json(400, { code: 'invalid', error: op });
    }
    const key = init.headers.Authorization.slice(7);
    const mine = byKey[key] ?? [];
    if (u.pathname === '/v1/conversations') return json(200, { conversations: mine, next_after: '' });
    const m = u.pathname.match(/^\/v1\/conversations\/([^/]+)(?:\/(messages|principal|control))?$/);
    const c = m && mine.find(x => x.id === decodeURIComponent(m[1]));
    if (!c) return json(404, { error: 'not found' });
    if (m[2] === 'messages') return json(200, { messages: messages[c.id] ?? [], next_after: 0 });
    if (m[2] === 'principal') return c.principal && c.principal.level !== 'anonymous' ? json(200, { principal: c.principal, memory: { entries: memory[`${c.principal.tenant}:${c.principal.sub}`] ?? [], total: 0 } }) : json(404, { code: 'no_principal' });
    if (m[2] === 'control') {
      const b = JSON.parse(init.body);
      if (b.expected_revision !== c.control.revision) return json(409, { error: 'stale' });
      c.control = { owner: b.action === 'takeover' ? 'human' : 'agent', state: b.action === 'takeover' ? 'waiting_human' : 'active', revision: c.control.revision + 1 };
      return json(200, { control: c.control });
    }
    return json(200, c);
  };
  const env = { CS_CONSOLE: JSON.stringify({ host: HOST, keys: [TEAM_KEY], link_keys: LINK_KEYS, facts: { url: 'http://facts.test/users/{sub}', key: 'fk' } }), SOOT_STORAGE_URL: 'http://storage.test/v1/pack-storage', SOOT_STORAGE_TOKEN: 'sps_call' };
  const withFacts = async (url, init) => {
    const u = new URL(url);
    if (u.origin === 'http://facts.test') return u.pathname === '/users/u-1001' ? json(200, { facts: [{ label: 'Số dư', value: '1.240 LT' }] }) : json(404, {});
    return fetchImpl(url, init);
  };
  return { env, fetch: withFacts, tables, calls, byKey };
}

test('one person across bindings: the same verified sub on web and Telegram is one row and one timeline; another user never merges', async () => {
  const f = fixture();
  const list = await view({ kind: 'customers' }, f.env, f.fetch);
  const keys = list.customers.map(c => c.key).sort();
  assert.deepEqual(keys, ['lohi:tg-777', 'lohi:u-1001', 'lohi:u-2002'], 'anonymous and non-channel conversations are not people; another tenant is not reachable');
  const khoa = list.customers.find(c => c.key === 'lohi:u-1001');
  assert.deepEqual(khoa.channels, ['lohi-tg', 'lohi-web']);
  assert.equal(khoa.conversations, 2);
  assert.equal(khoa.status, 'need', 'the person needs someone when any of their conversations does');
  const d = await view({ kind: 'customer', key: 'lohi:u-1001' }, f.env, f.fetch);
  assert.deepEqual(d.timeline.map(e => [e.channel, e.role, e.text]), [
    ['lohi-tg', 'c', 'Audio tắt sau 2 giây'], ['lohi-tg', 'm', 'Đang tạo lại audio'],
    ['lohi-web', 'c', 'Em nạp 50k mà chưa thấy LT'], ['lohi-web', 's', 'Mình thấy giao dịch đang chờ.']]);
  assert.deepEqual(d.memory.map(m => m.content), ['Thích đọc tiên hiệp']);
  assert.deepEqual(d.facts, [{ label: 'Số dư', value: '1.240 LT' }]);
  assert.equal(d.control.conversation, 'c-web');
  const ha = await view({ kind: 'customer', key: 'lohi:u-2002' }, f.env, f.fetch);
  assert.ok(ha.timeline.every(e => e.conversation === 'c-ha'));
  assert.equal(ha.facts_state, 'unavailable', 'a product answer for another sub is not shown');
});

test('a product-signed proof links a Telegram sender to the Lohi user; replay, expiry, wrong audience, foreign key and conflicts are refused', async () => {
  const f = fixture();
  const good = proof({ sub: 'u-1001', alias: 'tg-777' });
  const linked = await action({ kind: 'link', proof: good }, f.env, { request_id: 'cs-link-0001' }, f.fetch);
  assert.deepEqual(linked, { link: { sub: 'lohi:u-1001', alias: 'lohi:tg-777' }, added: true });
  assert.equal(f.tables.links[0].proof, 'product_assertion');
  const list = await view({ kind: 'customers' }, f.env, f.fetch);
  assert.deepEqual(list.customers.map(c => c.key).sort(), ['lohi:u-1001', 'lohi:u-2002'], 'the alias joins the proven person');
  assert.equal(list.customers.find(c => c.key === 'lohi:u-1001').conversations, 3);

  const refuse = async (p, code) => assert.rejects(action({ kind: 'link', proof: p }, f.env, { request_id: 'cs-link-0002' }, f.fetch), e => e.code === code);
  await refuse(good, 'proof_replayed');
  await refuse(proof({ sub: 'u-2002', alias: 'tg-777' }), 'link_conflict');
  await refuse(proof({ sub: 'u-2002', alias: 'tg-x', exp: Math.floor(Date.now() / 1000) - 60, iat: Math.floor(Date.now() / 1000) - 120 }), 'proof_expired');
  await refuse(proof({ sub: 'u-2002', alias: 'tg-x', aud: 'https://soot.test' }), 'invalid_proof');
  await refuse(proof({ sub: 'u-2002', alias: 'tg-x' }, { key: generateKeyPairSync('ed25519').privateKey }), 'invalid_proof');
  await refuse(proof({ sub: 'u-2002', alias: 'tg-x' }, { kid: 'other' }), 'invalid_proof');
  await refuse(proof({ sub: 'u-2002', alias: 'u-2002' }), 'invalid_proof');
  await refuse('Khoa <khoa@example.com>', 'invalid_proof');
  assert.equal(f.tables.links.length, 1, 'nothing but the first proof was stored');
  // An unlink drops the link but not the used proof: it cannot be replayed.
  await action({ kind: 'unlink', id: f.tables.links[0].id }, f.env, { request_id: 'cs-unlink-001' }, f.fetch);
  assert.equal(f.tables.links.length, 0);
  const mark = f.calls.length;
  assert.equal((await action({ kind: 'link', proof: proof({ sub: 'u-2002', alias: 'tg-888' }) }, f.env, { request_id: 'cs-link-0003' }, f.fetch)).added, true);
  await refuse(good, 'proof_replayed');
  assert.ok(f.calls.slice(mark).filter(c => c.url.endsWith('/links/query')).every(c => Object.keys(c.body.where).length > 0), 'link checks are targeted reads');
});

test('no link without a proof: two people with the same name stay two people', () => {
  const same = (id, sub) => ({ id, source: { ref: 'lohi-web', label: 'Minh' }, principal: { tenant: 'lohi', sub, level: 'asserted' }, created: '2026-11-01T00:00:00Z' });
  assert.equal(groupPeople([same('a', 'u-1'), same('b', 'u-2')], []).length, 2);
});

test('only the keys’ grants: a person or conversation outside them is not found, and nothing is written for it', async () => {
  const f = fixture();
  await assert.rejects(view({ kind: 'customer', key: 'acme:u-1001' }, f.env, f.fetch), e => e.code === 'not_found');
  await assert.rejects(action({ kind: 'tag', key: 'acme:u-1001', tag: 'VIP' }, f.env, { request_id: 'cs-tag-00001' }, f.fetch), e => e.code === 'not_found');
  await assert.rejects(action({ kind: 'control', conversation: 'c-other', action: 'takeover', expected_revision: 3 }, f.env, { request_id: 'cs-ctl-00001' }, f.fetch), e => e.code === 'not_found');
  assert.equal(f.tables.tags.length, 0);
  assert.ok(f.calls.filter(c => c.auth).every(c => c.auth !== `Bearer ${OTHER_KEY}`), 'the console never holds another team’s key');
});

test('tags and notes are stored per principal; control takes over and hands back with the request id and revision', async () => {
  const f = fixture();
  assert.equal((await action({ kind: 'tag', key: 'lohi:u-1001', tag: 'VIP' }, f.env, { request_id: 'cs-tag-00001' }, f.fetch)).added, true);
  assert.equal((await action({ kind: 'tag', key: 'lohi:u-1001', tag: 'VIP' }, f.env, { request_id: 'cs-tag-00002' }, f.fetch)).added, false);
  await assert.rejects(action({ kind: 'tag', key: 'lohi:u-1001', tag: '<script>' }, f.env, { request_id: 'cs-tag-00003' }, f.fetch), e => e.code === 'invalid_request');
  await action({ kind: 'note', key: 'lohi:u-1001', body: 'Hay nạp qua Vietcombank' }, f.env, { request_id: 'cs-note-0001', viewer: { kind: 'member', id: 'ha' } }, f.fetch);
  assert.deepEqual(f.tables.notes.map(n => [n.sub, n.author]), [['lohi:u-1001', 'member:ha']]);
  const d = await view({ kind: 'customer', key: 'lohi:u-1001' }, f.env, f.fetch);
  assert.deepEqual(d.tags.map(t => t.tag), ['VIP']);
  assert.equal(d.notes[0].body, 'Hay nạp qua Vietcombank');
  const out = await action({ kind: 'control', conversation: 'c-web', action: 'takeover', expected_revision: 3 }, f.env, { request_id: 'cs-ctl-00001' }, f.fetch);
  assert.equal(out.control.owner, 'human');
  const sent = f.calls.find(c => c.url === '/v1/conversations/c-web/control');
  assert.deepEqual(sent.body, { id: 'cs-ctl-00001', action: 'takeover', expected_revision: 3 });
  await assert.rejects(action({ kind: 'control', conversation: 'c-web', action: 'resume', expected_revision: 3 }, f.env, { request_id: 'cs-ctl-00002' }, f.fetch), e => e.code === 'conflict');
});

test('configuration refusals never echo the credential', () => {
  for (const raw of ['', 'not json', '[]', '{"host":"ftp://x","keys":["k_000000000000000"]}', '{"host":"http://x","keys":[]}', '{"host":"http://x","keys":["k_000000000000000"],"facts":{"url":"http://f"}}']) {
    assert.throws(() => parseConfig(raw), e => e.code === 'not_configured' && !e.message.includes('k_000000000000000'), raw);
  }
  assert.throws(() => verifyLinkProof('a.b', LINK_KEYS), e => e.code === 'invalid_proof');
});
