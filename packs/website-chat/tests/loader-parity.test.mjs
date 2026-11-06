// AC-P6-2 at the loader level: the widget fixtures of scripts/widget-loader.test.mjs
// that do not depend on the transport are replayed on BOTH real loaders,
//   old: live-chat/widget/loader.js  over SootChatSession and /public/v1 (frozen)
//   new: website-chat/widget/web-chat.js over WebChatSession and /v1/channel
// each against a fake host, and what the frame is sent is compared. Only the
// transport differs; a difference here is a difference a guest would see.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const oldDir = new URL('../../live-chat/widget/', import.meta.url);
const newDir = new URL('../widget/', import.meta.url);
const sdk = await import(new URL('browser.js', oldDir));
const web = await import(new URL('web-session.js', newDir));
const channel = await import(new URL('channel-browser.js', newDir));
Object.assign(channel.timing, { backoffMinMs: 1, backoffMaxMs: 2, maxAttempts: 2 });

// A session holds an event stream open; every one a loader makes is closed at the end.
const opened = [];
const webTracked = { ...web, WebChatSession: class extends web.WebChatSession { constructor(o) { super(o); opened.push(this); } } };
after(() => { for (const s of opened) s.close?.(); });

const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
class Storage { #m = new Map(); getItem(k) { return this.#m.get(k) ?? null; } setItem(k, v) { this.#m.set(k, String(v)); } removeItem(k) { this.#m.delete(k); } }

function oldHost(counters) {
  return async (url, init = {}) => {
    const p = new URL(url).pathname.replace('/public/v1', ''), m = init.method ?? 'GET';
    if (p.endsWith('/sessions')) { counters.sessions++; return json(201, { token: 't', expires: Date.now() + 3600_000 }); }
    if (p.startsWith('/apps/')) return json(200, { widget: { name: 'Lohi' }, soots: [{ id: 'support', name: 'Support' }], capabilities: [] });
    if (p === '/session/revoke') return json(200, {});
    if (p === '/conversations' && m === 'POST') return json(201, { id: 'c1', soot: 'support' });
    if (p === '/conversations/c1/messages' && m === 'POST') { counters.messages++; return json(202, { request_id: JSON.parse(init.body).id }); }
    if (p === '/conversations/c1') return json(200, { id: 'c1', soot: 'support', state: 'idle', message_cursor: 0 });
    if (p === '/conversations/c1/messages') { counters.reads++; return json(200, { messages: [], next_after: 0 }); }
    return json(404, { code: 'not_found' });
  };
}
function newHost(counters) {
  return async (url, init = {}) => {
    const p = new URL(url).pathname, m = init.method ?? 'GET';
    if (p === '/v1/channel/session') { counters.sessions++; return json(201, { session: 'scc_1', level: 'anonymous', visitor: 'v'.repeat(22), expires_at: new Date(Date.now() + 3600_000).toISOString(), sender: { id: 'v', kind: 'anonymous' } }); }
    if (p === '/v1/channel/conversations') return json(200, { handle: 'h1', kind: 'default', created: true });
    if (p === '/v1/channel/messages' && m === 'POST') { counters.messages++; return json(200, { accepted: true, duplicate: false, conversation: 'h1' }); }
    if (p === '/v1/channel/outbox/stream') return new Response(new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => { try { c.close(); } catch {} }); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    return json(404, { code: 'not_found', path: p });
  };
}

const LOADERS = {
  old: { src: new URL('loader.js', oldDir), script: 'https://soot.test/public/widget/loader.js', data: { app: 'spk_aaaaaaaaaaaaaaaaaaaaaaaa' },
    swap: ['import(`${base}/public/widget/browser.js`)', 'Promise.resolve(sdk)'], host: oldHost,
    globals: { sdk }, origin: 'https://soot.test' },
  new: { src: new URL('web-chat.js', newDir), script: 'https://soot.test/widget/web-chat.js', data: { host: 'https://soot.test', binding: 'lohi-web', config: '{"name":"Support"}' },
    swap: ["import(new URL('web-session.js', here).href)", 'Promise.resolve(web)'], host: newHost,
    globals: { web: webTracked }, origin: 'https://soot.test' },
};

function load(kind, { lang = 'en' } = {}) {
  const spec = LOADERS[kind];
  const counters = { sessions: 0, messages: 0, reads: 0 }, posted = [], handlers = new Map(), storage = new Storage();
  const style = () => { const v = new Map([['overflow', ['auto', 'important']]]); return { getPropertyValue: k => v.get(k)?.[0] || '', getPropertyPriority: k => v.get(k)?.[1] || '', setProperty: (k, x, pr) => v.set(k, [x, pr || '']), removeProperty: k => v.delete(k) }; };
  const frame = { style: {}, setAttribute() {}, remove() {}, contentWindow: { postMessage: m => posted.push(m) } };
  let languageCallback;
  const document = { currentScript: { dataset: spec.data, src: spec.script }, documentElement: { lang, style: style() }, body: { style: style(), append() {}, appendChild() {} },
    visibilityState: 'visible', createElement: () => frame, querySelector: () => null };
  const fetch = spec.host(counters);
  globalThis.fetch = fetch; globalThis.localStorage = storage;
  const context = { document, window: { visualViewport: null }, location: { origin: 'https://site.example', href: 'https://site.example/' }, innerWidth: 390, innerHeight: 800, URL, crypto: { randomUUID: () => 'test-nonce' },
    localStorage: storage, fetch, addEventListener: (t, fn) => handlers.set(t, fn), MutationObserver: class { constructor(fn) { languageCallback = fn; } observe() {} },
    setTimeout, clearTimeout, ...spec.globals };
  let source = readFileSync(spec.src, 'utf8');
  assert.ok(source.includes(spec.swap[0]), `${kind}: module load site found`);
  source = source.replace(spec.swap[0], spec.swap[1]);
  runInNewContext(source, context);
  const receive = (type, extra = {}, origin = spec.origin) => handlers.get('message')({ origin, source: frame.contentWindow, data: { soot_chat: 1, nonce: 'test-nonce', type, ...extra } });
  return { counters, posted, frame, document, receive, language: l => { document.documentElement.lang = l; languageCallback(); } };
}

/** What the frame hears, reduced to type and the fields a guest can see. */
const heard = f => f.posted.map(m => [m.type, m.language, m.submission === true, m.error?.kind, m.config?.name].filter(x => x !== undefined && x !== false));

for (const kind of Object.keys(LOADERS)) {
  test(`${kind} loader: opening the widget creates no session; the first Send creates one and tells the frame`, async () => {
    const f = load(kind); await f.receive('ready'); await tick();
    assert.ok(f.posted.some(m => m.type === 'init'));
    await f.receive('open'); await f.receive('sync');
    assert.equal(f.counters.sessions, 0);
    await f.receive('send', { text: 'Hello' });
    assert.equal(f.counters.sessions, 1);
    assert.equal(f.counters.messages, 1);
    assert.ok(f.posted.some(m => m.type === 'sync' && m.submission));
  });

  test(`${kind} loader: a message from another origin cannot send work`, async () => {
    const f = load(kind); await f.receive('ready'); await tick();
    await f.receive('send', { text: 'Foreign' }, 'https://foreign.example');
    assert.equal(f.counters.sessions, 0); assert.equal(f.counters.messages, 0);
  });

  test(`${kind} loader: a language change reaches the same instance without a new session`, async () => {
    const f = load(kind); await f.receive('ready'); await tick();
    f.language('vi');
    assert.deepEqual([f.posted.at(-1).type, f.posted.at(-1).language], ['language', 'vi']);
    assert.equal(f.counters.sessions, 0);
  });

  test(`${kind} loader: expanding on a phone locks page scroll and collapsing restores its style`, async () => {
    const f = load(kind); await f.receive('ready'); await tick();
    await f.receive('open');
    assert.equal(f.document.body.style.getPropertyValue('overflow'), 'hidden');
    await f.receive('close');
    assert.equal(f.document.body.style.getPropertyValue('overflow'), 'auto');
    assert.equal(f.document.body.style.getPropertyPriority('overflow'), 'important');
  });

  test(`${kind} loader: the frame is named for the site's chat`, async () => {
    const f = load(kind);
    assert.ok(f.frame.title.startsWith('Support chat'), f.frame.title);
    assert.equal(f.frame.allow, 'clipboard-write');
  });
}

test('AC-P6-2: both loaders tell the frame the same thing for the same guest', async () => {
  const run = async kind => {
    const f = load(kind); await f.receive('ready'); await tick();
    await f.receive('open'); await f.receive('sync');
    await f.receive('send', { text: 'Hello' });
    f.language('vi'); await f.receive('close');
    return heard(f).map(([type, ...rest]) => [type, ...rest.filter(x => typeof x === 'string' && ['vi', 'en'].includes(x))]);
  };
  const [oldHeard, newHeard] = [await run('old'), await run('new')];
  assert.deepEqual(newHeard.map(x => x[0]), oldHeard.map(x => x[0]));
  assert.deepEqual(newHeard, oldHeard);
});
