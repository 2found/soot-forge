// AC-P6-2: a guest sees the same behaviour on the old widget (live-chat,
// SootChatSession over /public/v1) and the new one (website-chat browser
// mode, WebChatSession over /v1/channel). One guest fixture is replayed
// through both sessions by the same driver the loaders run, against a fake
// host for each API, and what the frame would be sent is compared.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const widget = new URL('../widget/', import.meta.url);
const { SootChatSession } = await import(new URL('../../live-chat/widget/browser.js', import.meta.url));
const { WebChatSession, wordable } = await import(new URL('web-session.js', widget));
const { timing, ChannelError } = await import(new URL('channel-browser.js', widget));
// Shrink the SDK's retry policy (the SDK's own tests do the same).
Object.assign(timing, { backoffMinMs: 1, backoffMaxMs: 2, maxAttempts: 2 });

class MemoryStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  keys() { return [...this.#m.keys()]; }
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const replyTo = text => `Đã nhận: ${text}`;

// ---- the old host: /public/v1 ----
function oldHost() {
  const h = { mode: 'ok', posts: [], messages: [], admitted: new Map(), sessions: 0 };
  h.fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace('/public/v1', ''), m = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (p === '/apps/spk_aaaaaaaaaaaaaaaaaaaaaaaa' && m === 'GET') return json(200, { widget: { name: 'Lohi' }, soots: [{ id: 'support' }], capabilities: [] });
    if (p.endsWith('/sessions')) { h.sessions++; return json(201, { token: 't', expires: Date.now() + 3600_000 }); }
    if (p === '/session/revoke') return json(200, {});
    if (p === '/conversations' && m === 'POST') return json(201, { id: 'c1', soot: 'support' });
    if (p === '/conversations' && m === 'GET') return json(404, { code: 'not_found' });
    const receipt = p.match(/^\/conversations\/c1\/requests\/(.+)$/);
    if (receipt) { const run = h.admitted.get(receipt[1]); return run ? json(200, { run }) : json(404, { code: 'not_found' }); }
    if (p === '/conversations/c1/messages' && m === 'POST') {
      h.posts.push(body.id);
      if (h.mode === 'unavailable') throw new TypeError('fetch failed');
      if (h.mode === 'invalid') return json(400, { code: 'invalid_request' });
      if (h.mode === 'rate') return json(429, { code: 'rate_limited' });
      if (!h.admitted.has(body.id)) {
        h.admitted.set(body.id, { request_id: body.id, input: body.text });
        h.messages.push({ id: h.messages.length + 1, role: 'user', text: body.text, created: new Date().toISOString() });
        h.messages.push({ id: h.messages.length + 1, role: 'assistant', text: replyTo(body.text), created: new Date().toISOString() });
      }
      return json(202, { request_id: body.id });
    }
    if (p === '/conversations/c1' && m === 'GET') return json(200, { id: 'c1', soot: 'support', state: 'idle', message_cursor: h.messages.at(-1)?.id ?? 0, progress: null });
    if (p === '/conversations/c1/messages' && m === 'GET') {
      const after = Number(u.searchParams.get('after')), page = h.messages.filter(x => x.id > after);
      return json(200, { messages: page, next_after: page.at(-1)?.id ?? after });
    }
    return json(404, { code: 'not_found', path: p });
  };
  return h;
}

// ---- the new host: /v1/channel (browser mode) ----
function newHost() {
  const h = { mode: 'ok', posts: [], admitted: new Set(), sessions: 0, acks: [], seq: 0, streams: new Set(), queued: [], visitor: null, assertion: null };
  const sse = (event, data) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  h.emit = (event, data) => { const chunk = sse(event, data); if (h.streams.size === 0) h.queued.push(chunk); for (const c of h.streams) c.enqueue(chunk); };
  h.fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname, m = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (p === '/v1/channel/session' && m === 'POST') {
      h.sessions++;
      if (body.binding !== 'lohi-web') return json(404, { code: 'unknown_binding' });
      if (body.assertion === 'expired') return json(401, { code: 'assertion_expired' });
      h.assertion = body.assertion ?? null;
      h.visitor = body.visitor ?? `v${h.sessions}`;
      return json(201, { session: `scc_${h.sessions}`, level: body.assertion ? 'asserted' : 'anonymous', ...(body.assertion ? {} : { visitor: h.visitor }), expires_at: new Date(Date.now() + 3600_000).toISOString(), sender: { id: h.visitor } });
    }
    if (p === '/v1/channel/conversations') return json(200, { handle: `h-${h.visitor}`, kind: 'default', created: true });
    if (p === '/v1/channel/messages' && m === 'POST') {
      h.posts.push(body.request_id);
      if (h.mode === 'unavailable') return json(503, { code: 'unavailable' });
      if (h.mode === 'invalid') return json(400, { code: 'invalid_request' });
      if (h.mode === 'rate') return json(429, { code: 'rate_limited' });
      const duplicate = h.admitted.has(body.request_id);
      if (!duplicate) {
        h.admitted.add(body.request_id);
        h.emit('run', { conversation: body.conversation, active: true });
        h.emit('item', { receipt_id: `r${++h.seq}`, seq: h.seq, attempt: 1, kind: 'reply', chat: { id: 'x' }, created_at: new Date().toISOString(), conversation: body.conversation, text: replyTo(body.text), links: [], open_url: null });
        h.emit('item', { receipt_id: `r${++h.seq}`, seq: h.seq, attempt: 1, kind: 'future_kind', chat: { id: 'x' }, created_at: new Date().toISOString(), conversation: body.conversation, text: 'never shown', links: [], open_url: null });
        h.emit('run', { conversation: body.conversation, active: false });
        // Admitted and answered, but the reply to the POST never arrives.
        if (h.mode === 'lost') { h.mode = 'ok'; return json(503, { code: 'unavailable' }); }
      }
      return json(200, { accepted: true, duplicate, conversation: body.conversation });
    }
    if (p === '/v1/channel/outbox/ack') { h.acks.push(...body.acks); return json(200, { acked: body.acks.length }); }
    if (p === '/v1/channel/outbox/stream') {
      let ctl;
      const stream = new ReadableStream({
        start(c) { ctl = c; h.streams.add(c); for (const q of h.queued.splice(0)) c.enqueue(q); },
        cancel() { h.streams.delete(ctl); },
      });
      init.signal?.addEventListener('abort', () => { h.streams.delete(ctl); try { ctl.close(); } catch {} });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json(404, { code: 'not_found', path: p });
  };
  return h;
}

// ---- the loaders' driver (live-chat loader.js ≡ website-chat web-chat.js) ----
function driver(make) {
  const d = { s: make(), inited: null, cursor: 0, transcript: [] };
  const kindOf = err => err?.challenge ? 'challenge' : err?.status === 429 ? 'rate' : err?.status === 400 ? 'validation' : err?.status === 401 ? 'expired' : 'send';
  d.load = async () => {
    const state = d.s.readState();
    if (state.session) { const out = await d.s.init(); d.inited = d.s; return { opened: true, pending: out.state.pendingMessage?.text ?? null, draft: out.state.draft }; }
    await d.s.client.getAppInfo();
    return { opened: false, pending: state.pendingMessage?.text ?? null, draft: state.draft };
  };
  d.sync = async (submission = false) => {
    try {
      const saved = d.s.readState();
      const state = saved.session ? await d.s.reconcile() : saved;
      let messages = [], activity = 'connected';
      if (state.conversationId) {
        const conv = await d.s.client.getConversation(state.conversationId);
        activity = conv.state;
        const page = await d.s.client.getMessages(state.conversationId, { after: submission ? 0 : d.cursor, limit: 50 });
        messages = page.messages;
        d.cursor = Math.max(d.cursor, page.next_after || 0);
      }
      for (const m of messages) if (!d.transcript.some(t => t.key === `${m.id}`)) d.transcript.push({ key: `${m.id}`, role: m.role, ...(m.actor_role ? { actor_role: m.actor_role } : {}), text: m.text });
      return { submission, pending: state.pendingMessage?.text ?? null, idle: ['active', 'idle', 'completed', 'failed', 'stopped'].includes(activity) };
    } catch (err) { return { submission, error: err?.status === 401 ? 'expired' : 'connection' }; }
  };
  d.send = async text => {
    try {
      if (d.inited !== d.s) { await d.s.init(); d.inited = d.s; }
      await d.s.sendMessage(text);
      return await d.sync(true);
    } catch (err) { return { submission: true, error: kindOf(err), pending: d.s.readState().pendingMessage?.text ?? null }; }
  };
  // The frame polls every 3 s until the conversation is idle.
  d.settle = async () => { let r; for (let i = 0; i < 100; i++) { r = await d.sync(); if (r.idle && !r.error) return r; await new Promise(res => setTimeout(res, 5)); } return r; };
  d.reload = () => { d.s.close?.(); d.s = make(); d.inited = null; d.cursor = 0; d.transcript = []; };
  d.reset = async () => { await d.s.reset(); d.inited = null; d.cursor = 0; d.transcript = []; };
  d.lines = () => d.transcript.map(({ key, ...line }) => line);
  return d;
}

/** The guest fixture: what a visitor does, and what the frame is shown. */
async function replay(d, host) {
  const seen = [];
  const step = async (name, run) => seen.push([name, await run()]);
  await step('page view', d.load);
  await step('first send', () => d.send('Xin chào'));
  await step('reply', async () => (await d.settle(), d.lines()));
  host.mode = 'invalid';
  await step('refused send', () => d.send('xấu'));
  host.mode = 'rate';
  await step('rate limited', () => d.send('nhanh quá'));
  host.mode = 'ok';
  await step('retry after the limit', () => d.send('nhanh quá'));
  await step('reply after the limit', async () => (await d.settle(), d.lines()));
  host.mode = 'unavailable';
  await step('host down', () => d.send('lần hai'));
  host.mode = 'ok';
  d.reload();
  await step('reload keeps the receipt', d.load);
  await step('reload shows it pending', () => d.sync());
  await step('resend', () => d.send('lần hai'));
  await step('reply to resend', async () => (await d.settle(), d.lines()));
  await d.reset();
  await step('after new conversation', d.load);
  return seen;
}

const OLD_KEY = 'spk_aaaaaaaaaaaaaaaaaaaaaaaa';
const makeOld = (host, storage) => () => { globalThis.localStorage = storage; return new SootChatSession({ baseUrl: 'https://soot.test', appKey: OLD_KEY, language: 'vi', fetch: host.fetch }); };
const makeNew = (host, storage, extra = {}) => () => new WebChatSession({ host: 'https://soot.test', binding: 'lohi-web', storage, fetch: host.fetch, language: 'vi', widget: { name: 'Lohi' }, ...extra });

test('AC-P6-2: one guest fixture, the same frame-visible behaviour on the old and the new widget', async () => {
  const oh = oldHost(), nh = newHost();
  const before = await replay(driver(makeOld(oh, new MemoryStorage())), oh);
  const nd = driver(makeNew(nh, new MemoryStorage()));
  const after = await replay(nd, nh);
  nd.s.close();
  assert.deepEqual(after, before);
  // And the fixture says what it should, so equal is not equally wrong.
  const at = Object.fromEntries(before);
  assert.deepEqual(at['page view'], { opened: false, pending: null, draft: '' });
  assert.deepEqual(at.reply, [{ role: 'user', text: 'Xin chào' }, { role: 'assistant', text: 'Đã nhận: Xin chào' }]);
  assert.equal(at['refused send'].error, 'validation');
  assert.equal(at['refused send'].pending, null);
  assert.equal(at['rate limited'].error, 'rate');
  assert.equal(at['rate limited'].pending, 'nhanh quá', 'a 429 keeps the receipt: Retry resends the same message');
  assert.deepEqual(at['reply after the limit'].slice(-2), [{ role: 'user', text: 'nhanh quá' }, { role: 'assistant', text: 'Đã nhận: nhanh quá' }]);
  assert.equal(at['host down'].error, 'send');
  assert.equal(at['host down'].pending, 'lần hai');
  assert.equal(at['reload keeps the receipt'].pending, 'lần hai');
  assert.equal(at['reload shows it pending'].pending, 'lần hai');
  assert.deepEqual(at['reply to resend'].slice(-2), [{ role: 'user', text: 'lần hai' }, { role: 'assistant', text: 'Đã nhận: lần hai' }]);
  assert.deepEqual(at['after new conversation'], { opened: false, pending: null, draft: '' });
});

test('browser mode: a page view mints nothing; the resend reuses its request id; unknown kinds are acked skipped', async () => {
  const host = newHost(), storage = new MemoryStorage();
  const d = driver(makeNew(host, storage));
  await d.load();
  assert.equal(host.sessions, 0, 'no visitor session before the first Send');
  await d.send('Xin chào');
  await d.settle();
  assert.ok(host.acks.some(a => a.status === 'delivered'));
  assert.ok(host.acks.some(a => a.status === 'skipped'), 'an unknown outbox kind is acked skipped, never shown');
  assert.ok(!d.lines().some(l => l.text === 'never shown'));
  host.mode = 'unavailable';
  await d.send('lần hai');
  const tried = host.posts.at(-1);
  host.mode = 'ok';
  await d.send('lần hai');
  assert.equal(host.posts.at(-1), tried, 'Resend carries the same request id');
  d.s.close();
});

test('browser mode: an admitted message whose answer was lost is answered once', async () => {
  const host = newHost(), d = driver(makeNew(host, new MemoryStorage()));
  host.mode = 'lost';
  const r = await d.send('một lần');
  assert.equal(r.error, undefined, 'the SDK retried with the same request id and the host said duplicate');
  await d.settle();
  assert.equal(d.lines().filter(l => l.role === 'assistant').length, 1);
  assert.equal(new Set(host.posts).size, 1);
  d.s.close();
});

test('browser mode: a reset visitor is a new visitor; a refused assertion reads as expired', async () => {
  const host = newHost(), storage = new MemoryStorage();
  const d = driver(makeNew(host, storage));
  await d.send('Xin chào');
  const first = host.visitor;
  await d.reset();
  assert.deepEqual(storage.keys().filter(k => k.startsWith('soot.')), []);
  await d.send('lại');
  assert.notEqual(host.visitor, first);
  d.s.close();

  const signed = driver(makeNew(host, new MemoryStorage(), { assertion: async () => 'expired' }));
  assert.equal((await signed.send('hi')).error, 'expired');
  const ok = driver(makeNew(host, new MemoryStorage(), { assertion: async () => 'signed.jws' }));
  await ok.send('hi');
  assert.equal(ok.s.channel.level, 'asserted');
  assert.equal(host.assertion, 'signed.jws');
  ok.s.close();
  assert.equal(wordable(new ChannelError('assertion_required', 403)).status, 401);
});

test('the browser-mode widget ships the shared frame unchanged, with relative asset paths', async () => {
  const live = new URL('../../live-chat/widget/', import.meta.url);
  for (const file of ['frame.js', 'widget-composer.js', 'agent-behavior.js', 'agent.css', 'widget.css', 'theme.css']) {
    assert.ok((await readFile(new URL(file, widget))).equals(await readFile(new URL(file, live))), file);
  }
  const html = await readFile(new URL('frame.html', widget), 'utf8');
  assert.equal(html, (await readFile(new URL('frame.html', live), 'utf8')).replaceAll('/public/widget/', './'));
  assert.doesNotMatch(html, /\/public\//);
  const loader = await readFile(new URL('web-chat.js', widget), 'utf8');
  assert.doesNotMatch(loader, /spk_|scb_|turnstile/i, 'no app key, binding secret or challenge in browser mode');
});
