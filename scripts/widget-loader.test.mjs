import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const appKey = 'spk_widget_fixture_0123456789';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ saved = false, challenge = false } = {}) {
  const handlers = new Map(), posted = [], counters = { constructed: 0, sessions: 0, messages: 0, reads: 0 };
  const storage = new Map();
  const state = { session: saved ? { token: 'fixture' } : null, conversationId: saved ? 'saved-chat' : null,
    draft: '', pendingMessage: null, pendingCreate: null };
  let holdRead, languageCallback, proofOptions, conversation = { id: 'saved-chat', soot: 'support', state: 'completed' };
  const style = () => {
    const values = new Map([['overflow', ['auto', 'important']]]);
    return { getPropertyValue: key => values.get(key)?.[0] || '', getPropertyPriority: key => values.get(key)?.[1] || '',
      setProperty: (key, value, priority) => values.set(key, [value, priority || '']), removeProperty: key => values.delete(key) };
  };
  const frame = { style: {}, setAttribute() {}, remove() {}, contentWindow: { postMessage: message => posted.push(message) } };
  const document = { currentScript: { dataset: { app: appKey }, src: 'https://runtime.example/public/widget/loader.js' },
    documentElement: { lang: 'en', style: style() }, body: { style: style(), append() {}, appendChild() {} }, visibilityState: 'visible',
    createElement: () => frame };
  const appInfo = { soots: [{ id: 'support', name: 'Support' }], widget: { name: 'Support' } };
  class SootChatSession {
    constructor(options) { counters.constructed++; this.proof = options.proofProvider; }
    client = { getAppInfo: async () => appInfo,
      getConversation: async () => ({ ...conversation }),
      getMessages: async () => { counters.reads++; return holdRead ? await holdRead : { messages: [], next_after: 0 }; } };
    readState() { return { ...state }; }
    async init() { if (!state.session) { if (challenge) await this.proof({ required: true, site_key: 'fixture-sitekey' }); counters.sessions++; state.session = { token: 'fixture' }; } return { appInfo, state: this.readState() }; }
    async reconcile() { return this.readState(); }
    async sendMessage() { counters.messages++; state.draft = ''; state.conversationId = 'saved-chat'; }
    saveDraft(draft) { state.draft = draft; }
    async reset() { state.session = null; state.conversationId = null; state.draft = ''; }
    setLanguage(language) { state.language = language; }
  }
  const context = { document, window: { visualViewport: null }, location: { origin: 'https://site.example' },
    innerWidth: 390, innerHeight: 800, URL, crypto: { randomUUID: () => 'test-nonce' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener: (type, fn) => handlers.set(type, fn),
    MutationObserver: class { constructor(fn) { languageCallback = fn; } observe() {} },
    sdk: { SootChatSession }, setTimeout, clearTimeout };
  if (challenge) context.window.turnstile = { render: (_container, options) => { proofOptions = options; return 'proof-widget'; }, remove() {} };
  const source = readFileSync(new URL('../packs/live-chat/widget/loader.js', import.meta.url), 'utf8');
  // Substitute module loading, not widget logic. The public SDK itself has its
  // own real HTTP tests; here transport deliberately supplies delayed reads.
  runInNewContext(source.replace('import(`${base}/public/widget/browser.js`)', 'Promise.resolve(sdk)'), context);
  const receive = (type, extra = {}, origin = 'https://runtime.example') => handlers.get('message')({
    origin, source: frame.contentWindow, data: { soot_chat: 1, nonce: 'test-nonce', type, ...extra } });
  return { counters, posted, context, frame, receive, state, languageCallback: () => languageCallback(),
    holdRead: promise => { holdRead = promise; }, proofOptions: () => proofOptions, conversation: next => { conversation = next; } };
}

test('branding and opening the widget do not create anonymous sessions; first Send does', async () => {
  const f = fixture(); await f.receive('ready'); await tick();
  assert.equal(f.counters.sessions, 0);
  assert.ok(f.posted.some(m => m.type === 'init'));
  await f.receive('open'); await f.receive('sync');
  assert.equal(f.counters.sessions, 0);
  await f.receive('send', { text: 'Hello' });
  assert.equal(f.counters.sessions, 1);
  assert.equal(f.counters.messages, 1);
  assert.ok(f.posted.some(m => m.type === 'sync' && m.submission));
});

test('a delayed old history page cannot repopulate a reset conversation', async () => {
  const f = fixture({ saved: true }); await f.receive('ready'); await tick(); await f.receive('open');
  let resolveRead; f.holdRead(new Promise(resolve => { resolveRead = resolve; }));
  const oldRead = f.receive('sync'); await tick();
  await f.receive('reset');
  assert.equal(f.counters.sessions, 0);
  const boundary = f.posted.length;
  resolveRead({ messages: [{ id: 'old-message', text: 'Old conversation' }], next_after: 5 }); await oldRead;
  assert.equal(f.posted.slice(boundary).some(m => m.type === 'sync'), false);
});

test('collapse and hidden documents make no history reads and restore scroll style', async () => {
  const f = fixture({ saved: true }); await f.receive('ready'); await tick();
  await f.receive('sync'); assert.equal(f.counters.reads, 0);
  await f.receive('open'); assert.equal(f.context.document.body.style.getPropertyValue('overflow'), 'hidden');
  f.context.document.visibilityState = 'hidden'; await f.receive('sync'); assert.equal(f.counters.reads, 0);
  await f.receive('close');
  assert.equal(f.context.document.body.style.getPropertyValue('overflow'), 'auto');
  assert.equal(f.context.document.body.style.getPropertyPriority('overflow'), 'important');
});

test('language navigation updates the same instance without new sessions', async () => {
  const f = fixture(); await f.receive('ready'); await tick();
  f.context.document.documentElement.lang = 'vi'; f.languageCallback();
  assert.equal(f.state.language, 'vi');
  assert.equal(f.posted.at(-1).type, 'language');
  assert.equal(f.posted.at(-1).language, 'vi');
  assert.equal(f.counters.constructed, 1);
  assert.equal(f.counters.sessions, 0);
});

test('messages from another origin cannot send work', async () => {
  const f = fixture(); await f.receive('ready'); await tick();
  await f.receive('send', { text: 'Foreign message' }, 'https://foreign.example');
  assert.equal(f.counters.sessions, 0); assert.equal(f.counters.messages, 0);
});

test('a timed-out proof unlocks the send and retries without admitting earlier work', async () => {
  const f = fixture({ challenge: true }); await f.receive('ready'); await tick();
  assert.equal(f.proofOptions(), undefined);
  const sending = f.receive('send', { text: 'Hello' }); await tick();
  assert.equal(f.proofOptions().language, 'en');
  const first = f.proofOptions();
  first['timeout-callback'](); await tick();
  // Nothing was admitted yet, so the challenge is asked once more quietly.
  assert.notEqual(f.proofOptions(), first);
  f.proofOptions()['timeout-callback'](); await sending;
  assert.equal(f.counters.sessions, 0); assert.equal(f.counters.messages, 0);
  assert.equal(f.posted.at(-1).submission, true);
  // The visitor hears that nothing was sent, not that a receipt is unconfirmed.
  assert.equal(f.posted.at(-1).error.kind, 'challenge');
  const retry = f.receive('send', { text: 'Hello' }); await tick();
  f.proofOptions().callback('fixture-proof'); await retry;
  assert.equal(f.counters.sessions, 1); assert.equal(f.counters.messages, 1);
});

test('a challenge that fails once is retried before the visitor sees an error', async () => {
  const f = fixture({ challenge: true }); await f.receive('ready'); await tick();
  const sending = f.receive('send', { text: 'Hello' }); await tick();
  f.proofOptions()['error-callback'](); await tick();
  f.proofOptions().callback('fixture-proof'); await sending;
  assert.equal(f.counters.sessions, 1); assert.equal(f.counters.messages, 1);
  assert.equal(f.posted.some(m => m.error), false);
});

test('screen readers hear the site\'s chat, named once the widget config arrives', async () => {
  const f = fixture();
  assert.equal(f.frame.title, 'Support chat');
  assert.equal(f.frame.allow, 'clipboard-write');
  await f.receive('ready'); await tick();
  assert.equal(f.frame.title, 'Support chat · Support');
});

test('the frame hears what the run is doing, and the transcript is read only when it has something new', async () => {
  const f = fixture({ saved: true }); await f.receive('ready'); await tick(); await f.receive('open');
  const since = new Date().toISOString();
  f.conversation({ id: 'saved-chat', soot: 'support', state: 'running', message_cursor: 4,
    progress: { run: 'r1', phase: 'working', steps: 1, since } });
  await f.receive('sync', { after: 0 });
  assert.equal(f.counters.reads, 1, 'a first read always reads the transcript');
  await f.receive('sync', { after: 4 });
  assert.equal(f.counters.reads, 1, 'nothing past the cursor: no transcript read');
  const sync = f.posted.filter(m => m.type === 'sync').at(-1);
  assert.deepEqual({ ...sync.progress }, { run: 'r1', phase: 'working', steps: 1, since });
  assert.equal(sync.activity, 'running');
  f.conversation({ id: 'saved-chat', soot: 'support', state: 'completed', message_cursor: 6 });
  await f.receive('sync', { after: 4 });
  assert.equal(f.counters.reads, 2, 'a new message is read');
  assert.equal(f.posted.filter(m => m.type === 'sync').at(-1).progress, null);
});
