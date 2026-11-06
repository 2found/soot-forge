// cs-console page tools (Khách hàng). `node tools/console.mjs view|action`
// reads the soot-pages ToolContext on stdin and writes one JSON output.
//
// Every conversation read goes through the host's own conversation API with
// the member keys the operator configured (scoped to the CS team's Soots):
// the host enforces those grants, so the page never sees a conversation the
// keys cannot read. The pack stores only tags, notes and identity links, in
// its declared storage tables; it keeps no copy of a conversation or of
// product data.
//
// A person is a verified principal (asserted or paired) of a tenant, keyed
// `<tenant>:<sub>`. Two principals are one person only through a link, and a
// link is made only from a product-signed proof (`link` action) — never from
// a name, an email or anything a model or a member typed.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const LINK_AUDIENCE = 'soot-identity-link';
const MAX_LINK_LIFE = 300, SKEW = 5;
const MAX_PAGES = 4, PAGE = 100, MAX_TIMELINE_CONVERSATIONS = 10, MESSAGES = 50;
// A look-up that must see everyone (a person's detail, a write) walks at most this many host pages, then refuses; it never answers from a silent prefix.
const MAX_ALL_PAGES = 100;
const STORE_PAGE = 500, STORE_MAX = 5000;
const STATUS_RANK = { need: 0, human: 1, soot: 2, done: 3 };

export class ConsoleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ConsoleError(code, message); };

/** Parse the operator's CS_CONSOLE credential (a JSON object). */
export function parseConfig(raw) {
  let c;
  try { c = JSON.parse(raw ?? ''); } catch { fail('not_configured', 'CS_CONSOLE is not valid JSON.'); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail('not_configured', 'CS_CONSOLE must be a JSON object.');
  let host;
  try { host = new URL(c.host); } catch { fail('not_configured', 'CS_CONSOLE.host must be the Soot host URL.'); }
  if (!['http:', 'https:'].includes(host.protocol)) fail('not_configured', 'CS_CONSOLE.host must be http(s).');
  const keys = Array.isArray(c.keys) ? c.keys.filter(k => typeof k === 'string' && k.length >= 16) : [];
  if (keys.length === 0 || keys.length > 8) fail('not_configured', 'CS_CONSOLE.keys must hold 1–8 member keys.');
  const linkKeys = Array.isArray(c.link_keys) ? c.link_keys : [];
  if (linkKeys.length > 2 || !linkKeys.every(k => k && typeof k.kid === 'string' && typeof k.iss === 'string' && typeof k.x === 'string' && k.iss))
    fail('not_configured', 'CS_CONSOLE.link_keys holds at most two {kid, iss, x} product keys.');
  let facts = null;
  if (c.facts != null) {
    if (typeof c.facts?.url !== 'string' || !c.facts.url.includes('{sub}')) fail('not_configured', 'CS_CONSOLE.facts.url must contain {sub}.');
    facts = { url: c.facts.url, key: typeof c.facts.key === 'string' ? c.facts.key : '' };
  }
  return { host: host.origin + host.pathname.replace(/\/+$/, ''), keys, linkKeys, facts };
}

// ---------- host reads ----------

function hostClient(cfg, fetchImpl) {
  async function get(key, path) {
    const res = await fetchImpl(cfg.host + path, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) fail('host_unavailable', `The Soot host answered ${res.status}.`);
    return res.json();
  }
  async function post(key, path, body) {
    const res = await fetchImpl(cfg.host + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    return { status: res.status, body: out };
  }
  return { get, post };
}

const encodeCursor = (k, a) => Buffer.from(JSON.stringify({ k, a })).toString('base64url');
function decodeCursor(cursor, keys) {
  if (!cursor) return { k: 0, a: '' };
  let c;
  try { c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { c = null; }
  if (!c || !Number.isInteger(c.k) || c.k < 0 || c.k >= keys || typeof c.a !== 'string' || c.a.length > 512) fail('invalid_request', 'The cursor is not valid.');
  return c;
}

/**
 * One page of the verified conversations the configured keys can read: at most
 * `budget` host pages from `cursor`. `next` is the cursor of the rest and
 * `truncated` says there is a rest; nothing is dropped without saying so.
 */
export async function readConversationPage(cfg, fetchImpl, cursor = '', budget = MAX_PAGES) {
  const host = hostClient(cfg, fetchImpl);
  const seen = new Map();
  let { k, a: after } = decodeCursor(cursor, cfg.keys.length);
  while (k < cfg.keys.length) {
    if (budget-- <= 0) return { conversations: [...seen.values()], next: encodeCursor(k, after), truncated: true };
    const key = cfg.keys[k];
    const page = await host.get(key, `/v1/conversations?limit=${PAGE}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    for (const c of page?.conversations ?? []) {
      const p = c.principal;
      if (!p || !p.tenant || !p.sub || !['asserted', 'paired'].includes(p.level) || seen.has(c.id)) continue;
      seen.set(c.id, { ...c, key });
    }
    after = page?.next_after ?? '';
    if (!after) k++;
  }
  return { conversations: [...seen.values()], next: '', truncated: false };
}

/** Every verified conversation, deduplicated, or a refusal; used where a partial answer would be wrong (a person's detail, a write). */
export async function readConversations(cfg, fetchImpl) {
  const seen = new Map();
  let cursor = '';
  for (let pages = 0; pages < MAX_ALL_PAGES; pages += MAX_PAGES) {
    const page = await readConversationPage(cfg, fetchImpl, cursor);
    for (const c of page.conversations) if (!seen.has(c.id)) seen.set(c.id, c);
    cursor = page.next;
    if (!cursor) return [...seen.values()];
  }
  return fail('too_large', 'There are too many conversations to search; narrow the keys’ grants.');
}

export const principalKey = p => `${p.tenant}:${p.sub}`;

/** alias → canonical person key, from stored links (one hop; a link never chains). */
export function linkMap(links) {
  const m = new Map();
  for (const l of links) if (typeof l.alias === 'string' && typeof l.sub === 'string') m.set(l.alias, l.sub);
  return m;
}

export function statusOf(c) {
  const st = c.control?.state;
  if (st === 'waiting_human' || st === 'blocked' || c.need) return 'need';
  if (c.control?.owner === 'human') return 'human';
  if (c.active_run) return 'soot';
  return 'done';
}

/** Group conversations into people. Links merge only an alias into its proven canonical key. */
export function groupPeople(conversations, links) {
  const alias = linkMap(links);
  const people = new Map();
  for (const c of conversations) {
    const own = principalKey(c.principal);
    const key = alias.get(own) ?? own;
    let p = people.get(key);
    if (!p) people.set(key, p = { key, principals: new Set(), conversations: [] });
    p.principals.add(own);
    p.conversations.push(c);
  }
  return [...people.values()].map(p => {
    p.conversations.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const latest = p.conversations[0];
    const status = p.conversations.map(statusOf).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0];
    return {
      key: p.key,
      principals: [...p.principals].sort(),
      name: p.conversations.map(c => c.source?.label).find(l => l && l !== 'web' && l !== 'app') || p.key.slice(p.key.indexOf(':') + 1),
      status,
      channels: [...new Set(p.conversations.map(c => c.source?.ref).filter(Boolean))].sort(),
      levels: [...new Set(p.conversations.map(c => c.principal.level))].sort(),
      latest: latest.created,
      conversations: p.conversations,
    };
  }).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || String(b.latest).localeCompare(String(a.latest)));
}

// ---------- pack storage ----------

function storage(env, fetchImpl) {
  const url = env.SOOT_STORAGE_URL, token = env.SOOT_STORAGE_TOKEN;
  return async (table, op, body) => {
    if (!url || !token) fail('storage_unavailable', 'The host gave this call no pack storage.');
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/${table}/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) fail(out.code || 'storage_failed', out.error || `pack storage answered ${res.status}`);
    return out;
  };
}

/**
 * Every row matching `where` (a condition list), newest first, in pages of
 * STORE_PAGE by the created_at keyset. More than STORE_MAX rows → `truncated`.
 */
export async function queryAll(store, table, where = [], { pageSize = STORE_PAGE, maxRows = STORE_MAX } = {}) {
  const rows = [], seen = new Set();
  let before = '';
  for (;;) {
    const conds = before ? [...where, { column: 'created_at', op: 'lte', value: before }] : where;
    const page = (await store(table, 'query', { where: conds, order: 'created_at', desc: true, limit: pageSize })).rows ?? [];
    const fresh = page.filter(r => !seen.has(r.id));
    for (const r of fresh) { seen.add(r.id); rows.push(r); }
    if (page.length < pageSize) return { rows, truncated: false };
    if (fresh.length === 0 || rows.length >= maxRows) return { rows, truncated: true };
    before = page[page.length - 1].created_at;
  }
}
const eq = (column, value) => ({ column, op: 'eq', value });

// ---------- identity link proof ----------

const b64url = s => Buffer.from(s, 'base64url');
const decodeJSON = s => { try { return JSON.parse(b64url(s).toString('utf8')); } catch { return null; } };
const SUB = /^[A-Za-z0-9._:@-]{1,128}$/, TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Verify a product-signed link proof: an EdDSA JWS whose claims say that the
 * product's user `sub` of `tenant` is also the principal `alias` of
 * `alias_tenant` (default: `tenant`; e.g. their paired Telegram sender, whose
 * principal lives under the binding's own tenant). Same shape and
 * lifetime rules as a browser-mode assertion; aud is "soot-identity-link".
 */
export function verifyLinkProof(jws, keys, now = Date.now() / 1000) {
  const parts = typeof jws === 'string' && jws.length <= 4096 ? jws.split('.') : [];
  if (parts.length !== 3) fail('invalid_proof', 'The proof is not a signed link.');
  const header = decodeJSON(parts[0]);
  if (header?.alg !== 'EdDSA') fail('invalid_proof', 'The proof is not EdDSA.');
  const key = keys.find(k => k.kid === header.kid);
  if (!key) fail('invalid_proof', 'The proof is signed by an unknown key.');
  let ok = false;
  try {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    ok = verifySignature(null, Buffer.from(parts[0] + '.' + parts[1]), pub, b64url(parts[2]));
  } catch { ok = false; }
  if (!ok) fail('invalid_proof', 'The proof signature does not verify.');
  const c = decodeJSON(parts[1]);
  const aud = Array.isArray(c?.aud) ? c.aud : [c?.aud];
  if (!c || c.iss !== key.iss || !aud.includes(LINK_AUDIENCE) || !TENANT.test(c.tenant ?? '') || (c.alias_tenant !== undefined && !TENANT.test(c.alias_tenant ?? '')) || !SUB.test(c.sub ?? '') || !SUB.test(c.alias ?? '') ||
      typeof c.jti !== 'string' || !c.jti || c.jti.length > 128 || typeof c.iat !== 'number' || typeof c.exp !== 'number')
    fail('invalid_proof', 'The proof claims are incomplete.');
  if (c.exp <= c.iat || c.exp - c.iat > MAX_LINK_LIFE || c.iat > now + SKEW) fail('invalid_proof', 'The proof lifetime is invalid.');
  if (now >= c.exp + SKEW) fail('proof_expired', 'The proof has expired.');
  const sub = `${c.tenant}:${c.sub}`, alias = `${c.alias_tenant ?? c.tenant}:${c.alias}`;
  if (sub === alias) fail('invalid_proof', 'A person cannot be linked to themselves.');
  return { sub, alias, kid: key.kid, jti: c.jti };
}

// ---------- view ----------

async function allLinks(store) {
  const r = await queryAll(store, 'links');
  if (r.truncated) fail('too_large', 'There are too many identity links to read; unlink some.');
  return r.rows;
}

function role(m) {
  if (m.actor_role === 'member') return 'm';
  if (m.role === 'user') return 'c';
  return 's';
}

async function timeline(host, conversations) {
  const out = [];
  // Said, not silent: older conversations, or messages before the last MESSAGES of one, are not shown.
  let truncated = conversations.length > MAX_TIMELINE_CONVERSATIONS;
  for (const c of conversations.slice(0, MAX_TIMELINE_CONVERSATIONS)) {
    if (Number(c.message_cursor ?? 0) > MESSAGES) truncated = true;
    const after = Math.max(0, Number(c.message_cursor ?? 0) - MESSAGES);
    const page = await host.get(c.key, `/v1/conversations/${encodeURIComponent(c.id)}/messages?limit=${MESSAGES}${after ? `&after=${after}` : ''}`);
    for (const m of page?.messages ?? []) {
      if (typeof m.text !== 'string' || !m.text) continue;
      out.push({ at: m.created, conversation: c.id, channel: c.source?.ref ?? '', role: role(m), author: m.author ?? '', text: m.text.slice(0, 4000), internal: m.audience === 'internal' });
    }
  }
  return { timeline: out.sort((a, b) => String(a.at).localeCompare(String(b.at))), timeline_truncated: truncated };
}

async function facts(cfg, fetchImpl, key) {
  if (!cfg.facts) return { facts: [], facts_state: 'not_configured' };
  const sub = key.slice(key.indexOf(':') + 1);
  try {
    const res = await fetchImpl(cfg.facts.url.replaceAll('{sub}', encodeURIComponent(sub)), { headers: { Accept: 'application/json', ...(cfg.facts.key ? { Authorization: `Bearer ${cfg.facts.key}` } : {}) } });
    if (!res.ok) return { facts: [], facts_state: 'unavailable' };
    const body = await res.json();
    const list = Array.isArray(body?.facts) ? body.facts : [];
    return { facts: list.filter(f => f && typeof f.label === 'string').slice(0, 24).map(f => ({ label: f.label.slice(0, 64), value: String(f.value ?? '').slice(0, 256) })), facts_state: 'ok' };
  } catch {
    return { facts: [], facts_state: 'unavailable' };
  }
}

export async function view(input, env, fetchImpl = fetch) {
  const cfg = parseConfig(env.CS_CONSOLE);
  const store = storage(env, fetchImpl);
  const kind = input?.kind ?? 'customers';
  const links = await allLinks(store);
  if (kind === 'customers') {
    // One bounded page of conversations per call; `next` is the cursor of the
    // rest and `truncated` says there is a rest. The page asks again to load more.
    const page = await readConversationPage(cfg, fetchImpl, typeof input?.cursor === 'string' ? input.cursor : '');
    const people = groupPeople(page.conversations, links);
    const tags = [];
    for (let i = 0; i < people.length; i += 50) {
      const keys = people.slice(i, i + 50).map(p => p.key);
      tags.push(...(await queryAll(store, 'tags', [{ column: 'sub', op: 'in', values: keys }])).rows);
    }
    const q = typeof input?.q === 'string' ? input.q.trim().toLowerCase() : '';
    return {
      next: page.next, truncated: page.truncated,
      customers: people
        .filter(p => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
        .map(p => ({ key: p.key, name: p.name, status: p.status, channels: p.channels, levels: p.levels, latest: p.latest, conversations: p.conversations.length,
          tags: tags.filter(t => t.sub === p.key).map(t => t.tag) })),
      link_proofs: cfg.linkKeys.length > 0,
    };
  }
  if (kind === 'customer') {
    const people = groupPeople(await readConversations(cfg, fetchImpl), links);
    const p = people.find(x => x.key === input?.key);
    if (!p) fail('not_found', 'No such person within this Soot’s conversations.');
    const host = hostClient(cfg, fetchImpl);
    const memory = [];
    for (const principal of p.principals) {
      const c = p.conversations.find(x => principalKey(x.principal) === principal);
      const read = await host.get(c.key, `/v1/conversations/${encodeURIComponent(c.id)}/principal?limit=50`);
      for (const e of read?.memory?.entries ?? []) memory.push({ id: e.id, content: e.content, kind: e.kind ?? '' });
    }
    const [notes, tags] = await Promise.all([queryAll(store, 'notes', [eq('sub', p.key)]), queryAll(store, 'tags', [eq('sub', p.key)])]);
    const latest = p.conversations[0];
    return {
      customer: { key: p.key, name: p.name, status: p.status, channels: p.channels, levels: p.levels, principals: p.principals },
      control: { conversation: latest.id, owner: latest.control?.owner ?? 'agent', state: latest.control?.state ?? '', revision: latest.control?.revision ?? 0, can_control: (latest.capabilities ?? []).includes('control') },
      ...(await timeline(host, p.conversations)),
      memory,
      ...(await facts(cfg, fetchImpl, p.key)),
      notes_truncated: notes.truncated,
      notes: notes.rows.map(n => ({ id: n.id, body: n.body, author: n.author ?? '', at: n.created_at })),
      tags: tags.rows.map(t => ({ id: t.id, tag: t.tag })),
      links: links.filter(l => l.sub === p.key).map(l => ({ id: l.id, alias: l.alias, proof: l.proof })),
    };
  }
  fail('invalid_request', 'Unknown view kind.');
}

// ---------- action ----------

const TAG = /^[\p{L}\p{N} _-]{1,32}$/u;

export async function action(input, env, ctx, fetchImpl = fetch) {
  const cfg = parseConfig(env.CS_CONSOLE);
  const store = storage(env, fetchImpl);
  const kind = input?.kind;
  const people = async () => groupPeople(await readConversations(cfg, fetchImpl), await allLinks(store));
  // Every write names a person the configured keys can read: a tag or note
  // can never be attached to someone outside this Soot's grants.
  const person = async key => (await people()).find(p => p.key === key) ?? fail('not_found', 'No such person within this Soot’s conversations.');
  switch (kind) {
    case 'control': {
      if (!['takeover', 'resume'].includes(input.action)) fail('invalid_request', 'action is takeover or resume.');
      const c = (await readConversations(cfg, fetchImpl)).find(x => x.id === input.conversation) ?? fail('not_found', 'No such conversation within this Soot’s grants.');
      const r = await hostClient(cfg, fetchImpl).post(c.key, `/v1/conversations/${encodeURIComponent(c.id)}/control`, { id: ctx.request_id, action: input.action, expected_revision: Number(input.expected_revision ?? 0) });
      if (r.status === 409) fail('conflict', 'The conversation changed; reload and try again.');
      if (r.status !== 200) fail('control_refused', r.body?.error || `The host answered ${r.status}.`);
      return { control: r.body.control ?? r.body };
    }
    case 'tag': {
      const p = await person(input.key);
      const tag = typeof input.tag === 'string' ? input.tag.trim() : '';
      if (!TAG.test(tag)) fail('invalid_request', 'A tag is 1–32 letters, digits, spaces, _ or -.');
      if (input.remove) return { removed: (await store('tags', 'delete', { where: { sub: p.key, tag } })).affected ?? 0 };
      const have = await store('tags', 'query', { where: { sub: p.key, tag }, limit: 1 });
      if ((have.rows ?? []).length) return { tag, added: false };
      await store('tags', 'insert', { row: { sub: p.key, tag } });
      return { tag, added: true };
    }
    case 'note': {
      const p = await person(input.key);
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (!body || body.length > 2000) fail('invalid_request', 'A note is 1–2000 characters.');
      const author = ctx.viewer?.kind === 'member' ? `member:${ctx.viewer.id}` : 'operator';
      return { note: await store('notes', 'insert', { row: { sub: p.key, body, author } }) };
    }
    case 'note_delete': {
      // Like tag and note: only a note of a person within the grants, and
      // only that person's note, never a bare row id.
      if (typeof input.id !== 'string' || !input.id) fail('invalid_request', 'id is required.');
      const p = await person(input.key);
      const row = (await store('notes', 'get', { id: input.id })).row;
      if (!row || row.sub !== p.key) fail('not_found', 'No such note for this person.');
      return { removed: (await store('notes', 'delete', { id: input.id })).affected ?? 0 };
    }
    case 'link': {
      if (cfg.linkKeys.length === 0) fail('not_configured', 'No product key is configured for identity links.');
      const proof = verifyLinkProof(input.proof, cfg.linkKeys);
      // Targeted reads (indexed columns), never a capped scan: a conflict past
      // row 500 must still be seen. A used jti is kept in `proofs`, which an
      // unlink never touches, so a proof cannot be replayed after an unlink.
      const rows = async (table, where) => (await store(table, 'query', { where, limit: 1 })).rows ?? [];
      if ((await rows('proofs', { jti: proof.jti })).length || (await rows('proof_claims', { jti: proof.jti })).length) fail('proof_replayed', 'This proof was already used.');
      const [taken] = await rows('links', { alias: proof.alias });
      if (taken && taken.sub !== proof.sub) fail('link_conflict', 'That sender is already linked to another person.');
      if ((await rows('links', { alias: proof.sub })).length) fail('link_conflict', 'The product user is itself an alias; unlink it first.');
      if ((await rows('links', { sub: proof.alias })).length) fail('link_conflict', 'That sender already has linked aliases; unlink them first.');
      // The jti is claimed by a UNIQUE column (`proof_claims.jti`): of two
      // racers with one proof the host lets exactly one insert succeed and
      // answers the other 409 conflict. `proofs` holds claims made before the
      // unique table existed and is only read.
      try {
        await store('proof_claims', 'insert', { row: { jti: proof.jti, kid: proof.kid } });
      } catch (e) {
        if (e?.code === 'conflict') fail('proof_replayed', 'This proof was already used.');
        throw e;
      }
      if (taken) return { link: { sub: proof.sub, alias: proof.alias }, added: false };
      await store('links', 'insert', { row: { sub: proof.sub, alias: proof.alias, proof: 'product_assertion', kid: proof.kid, jti: proof.jti } });
      return { link: { sub: proof.sub, alias: proof.alias }, added: true };
    }
    case 'unlink': {
      if (typeof input.id !== 'string' || !input.id) fail('invalid_request', 'id is required.');
      const p = await person(input.key);
      const row = (await store('links', 'get', { id: input.id })).row;
      if (!row || row.sub !== p.key) fail('not_found', 'No such link for this person.');
      return { removed: (await store('links', 'delete', { id: input.id })).affected ?? 0 };
    }
  }
  fail('invalid_request', 'Unknown action kind.');
}

// ---------- entry ----------

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 300_000) fail('invalid_request', 'Input too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function main(mode, env = process.env) {
  try {
    const ctx = await readStdin();
    const input = ctx.input ?? {};
    const out = mode === 'action' ? await action(input, env, { request_id: ctx.request_id ?? input.request_id, viewer: ctx.viewer }) : await view(input, env);
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    // A refusal is an answer the page shows; nothing secret is in it.
    process.stdout.write(JSON.stringify({ error: { code: e instanceof ConsoleError ? e.code : 'failed', message: e instanceof ConsoleError ? e.message : 'The console could not complete the request.' } }) + '\n');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
