import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the shipped frame state machine. Only its DOM, composer and clock are
// substituted; transport stays at the same postMessage boundary as the iframe.
function frameFixture() {
  const elements = new Map(), handlers = new Map(), posted = [], timers = new Map(), delays = new Map(), intervals = new Map();
  let timerID = 0;
  class Element {
    constructor(id = '') { this.id = id; this.hidden = false; this.value = ''; this.children = []; this.dataset = {}; this.style = {}; this.textContent = ''; }
    setAttribute(key, value) { this[key] = value; }
    querySelector(selector) { return element(this.id + ':' + selector); }
    querySelectorAll() { return []; }
    append(...items) { for (const item of items) { this.children = this.children.filter(c => c !== item); this.children.push(item); } }
    insertBefore(item, before) { this.children = this.children.filter(c => c !== item); const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, item); }
    replaceChildren(...items) { this.children = items; }
    focus() {}
    contains(target) { return target === this; }
    click() { this.onclick?.(); }
    remove() { this.removed = true; }
  }
  const element = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const document = { getElementById: element, documentElement: { dataset: {} },
    visibilityState: 'visible', querySelector: () => null, createElement: tag => Object.assign(new Element(), { tagName: tag }),
    addEventListener: (type, fn) => handlers.set('document:' + type, fn) };
  const parent = { postMessage: message => posted.push(message) };
  const composer = { props: {}, update(props) { Object.assign(this.props, props); },
    setValue(value) { element('text').value = value; }, destroy() {} };
  const context = { document, parent, location: { search: '?parent=https://site.example' }, URLSearchParams, URL,
    createWidgetComposer: (_container, submit) => { composer.submit = submit; return composer; }, isAgentTranscriptAtEnd: () => true,
    TextEncoder, crypto: { randomUUID: () => 'frame-message-id' }, CSS: { escape: v => v },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { timers.set(++timerID, fn); delays.set(timerID, ms); return timerID; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.set(++timerID, fn); return timerID; }, clearInterval: id => intervals.delete(id),
    addEventListener: (type, fn) => handlers.set(type, fn) };
  const source = readFileSync(new URL('../packs/live-chat/widget/frame.js', import.meta.url), 'utf8');
  runInNewContext(source.replace(/^import .*;\n/gm, ''), context);
  const receive = (type, extra = {}) => handlers.get('message')({ source: parent, origin: 'https://site.example',
    data: { soot_chat: 1, nonce: 'fixture-nonce', type, ...extra } });
  const init = () => receive('init', { language: 'en', config: { name: 'Support' } });
  return { element, receive, init, posted, timers, delays, intervals, composer, context };
}

test('a collapsed chat does not poll; opening resumes and closing stops', () => {
  const f = frameFixture(); f.init();
  assert.equal(f.posted.filter(m => m.type === 'sync').length, 0);
  f.receive('open');
  assert.equal(f.posted.filter(m => m.type === 'sync').length, 1);
  f.receive('sync', { messages: [], next_after: 0, activity: 'connected' });
  assert.equal(f.timers.size, 1);
  f.receive('close');
  assert.equal(f.timers.size, 0);
});

test('read failures offer reconnect and preserve an editable draft', () => {
  const f = frameFixture(); f.init(); f.element('text').value = 'Keep my question';
  f.receive('sync', { error: { kind: 'connection' } });
  assert.match(f.element('error').textContent, /unavailable/i);
  assert.equal(f.element('retry').textContent, 'Reconnect');
  assert.equal(f.element('text').value, 'Keep my question');
  f.element('retry').click();
  assert.equal(f.posted.at(-1).type, 'retry-connect');
  f.receive('sync', { messages: [], activity: 'connected' });
  assert.equal(f.element('error-bar').hidden, true);
});

test('an English embed keeps its language even if initialization fails', () => {
  const f = frameFixture();
  f.receive('unavailable', { language: 'en' });
  assert.equal(f.context.document.documentElement.lang, 'en');
  assert.equal(f.element('retry').textContent, 'Reconnect');
});

test('a background read cannot acknowledge an in-flight send', () => {
  const f = frameFixture(); f.init(); f.element('text').value = 'Still sending';
  f.composer.submit();
  assert.equal(f.composer.props.sending, true);
  f.receive('sync', { messages: [], activity: 'connected' });
  assert.equal(f.element('text').value, 'Still sending');
  assert.equal(f.composer.props.sending, true);
  f.receive('sync', { messages: [], activity: 'working', submission: true });
  assert.equal(f.element('text').value, '');
  assert.equal(f.composer.props.sending, false);
});

test('runtime status uses localized copy without leaking internal state names', () => {
  const f = frameFixture(); f.init();
  f.receive('sync', { activity: 'running' });
  // The header already names the site's brand; a status naming Soot reads as a second party.
  assert.equal(f.element('activity').textContent, 'Replying…');
  f.receive('sync', { activity: 'waiting_input' });
  assert.equal(f.element('activity').textContent, 'Waiting for your reply');
  f.receive('sync', { activity: 'idle' });
  assert.equal(f.element('activity').textContent, 'Ready to help');
  f.receive('sync', { activity: 'some-future-state' });
  assert.equal(f.element('activity').textContent, 'Ready to help');
});

test('an expired session exposes explicit new-chat confirmation without dropping its draft', () => {
  const f = frameFixture(); f.init(); f.element('text').value = 'My unsent question';
  f.receive('sync', { error: { kind: 'expired' } });
  assert.equal(f.element('retry').textContent, 'New conversation');
  f.element('retry').click();
  assert.equal(f.element('reset-confirm').hidden, false);
  assert.equal(f.element('text').value, 'My unsent question');
  assert.equal(f.posted.some(m => m.type === 'reset'), false);
});

test('a send before init is held and flushed once the nonce arrives', () => {
  const f = frameFixture();
  f.element('text').value = 'Queued before connect';
  f.composer.submit();
  assert.equal(f.posted.some(m => m.type === 'send'), false);
  f.init();
  const send = f.posted.find(m => m.type === 'send');
  assert.ok(send);
  assert.equal(send.nonce, 'fixture-nonce');
  assert.equal(send.text, 'Queued before connect');
});

test('replies render light markdown as DOM nodes, never as markup or unsafe links', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  const text = '**Nest** is the app.\n\n- one [docs](https://trysoot.com/docs)\n- two `soot spawn`\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> http://plain.example';
  f.receive('sync', { messages: [{ id: 1, role: 'assistant', text, created: '' }, { id: 2, role: 'user', actor_role: 'customer', text: '**mine**', created: '' }], next_after: 2, activity: 'connected' });
  const [reply, mine] = f.element('transcript').children;
  const prose = reply.children[1], [lead, list, tail] = prose.children;
  assert.equal(prose.className, 'prose');
  assert.equal(lead.children[0].tagName, 'strong');
  assert.equal(lead.children[0].textContent, 'Nest');
  assert.equal(list.tagName, 'ul');
  assert.equal(list.children.length, 2);
  const link = list.children[0].children.find(n => n.tagName === 'a');
  assert.equal(link.href, 'https://trysoot.com/docs');
  assert.equal(link.rel, 'noopener noreferrer nofollow');
  assert.equal(list.children[1].children.find(n => n.tagName === 'code').textContent, 'soot spawn');
  assert.ok(tail.children.every(n => typeof n === 'string'), 'unsafe link, html and http stay plain text');
  assert.equal(tail.children.join(''), '[x](javascript:alert(1)) <img src=x onerror=alert(1)> http://plain.example');
  assert.equal(mine.children[1].textContent, '**mine**');
});

test('a suggestion chip asks its question in one tap and never replaces a draft', () => {
  const f = frameFixture();
  f.receive('init', { language: 'en', config: { name: 'Support', quick_replies: ['What does 2found do?'] } });
  const chip = f.element('quick').children[0];
  f.element('text').value = 'My own words';
  chip.click();
  assert.equal(f.element('text').value, 'My own words');
  assert.equal(f.posted.filter(m => m.type === 'send').length, 0);
  f.element('text').value = '';
  chip.click();
  const sent = f.posted.filter(m => m.type === 'send');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'What does 2found do?');
});

test('a fenced command renders verbatim in a copyable block, not as markdown', async () => {
  const f = frameFixture(); f.init(); f.receive('open');
  let copied = '';
  f.context.navigator = { clipboard: { writeText: async text => { copied = text; } } };
  const text = 'Run:\n```sh\nsoot spawn my-work\nsoot run "**not bold**" <b>x</b>\n```\nThen open Nest.';
  f.receive('sync', { messages: [{ id: 1, role: 'assistant', text, created: '' }], next_after: 1, activity: 'connected' });
  const prose = f.element('transcript').children[0].children[1];
  const [lead, figure, tail] = prose.children;
  assert.equal(lead.children.join(''), 'Run:');
  assert.equal(figure.className, 'code-block');
  const [pre, copy] = figure.children, code = pre.children[0];
  assert.equal(code.tagName, 'code');
  assert.equal(code.textContent, 'soot spawn my-work\nsoot run "**not bold**" <b>x</b>');
  assert.equal(tail.children.join(''), 'Then open Nest.');
  await copy.onclick();
  assert.equal(copied, 'soot spawn my-work\nsoot run "**not bold**" <b>x</b>');
  assert.equal(copy.textContent, 'Copied');
});

test('the holding message gives way to its run\'s reply', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [
    { id: 1, role: 'user', actor_role: 'customer', text: 'Hi', created: '', run: 'r1' },
    { id: 2, role: 'assistant', intent: 'acknowledgement', text: 'Checking…', created: '', run: 'r1' },
    { id: 3, role: 'assistant', intent: 'acknowledgement', text: 'Checking…', created: '', run: 'r2' },
  ], next_after: 3, activity: 'running' });
  const [, ack1, ack2] = f.element('transcript').children;
  assert.equal(ack1.removed, undefined);
  f.receive('sync', { messages: [{ id: 4, role: 'assistant', text: 'Answer', created: '', run: 'r1' }], next_after: 4, activity: 'connected' });
  assert.equal(ack1.removed, true);
  assert.equal(ack2.removed, undefined, 'another run is still working');
});

test('a run that ends without a reply drops its holding message and offers to ask again', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [
    { id: 1, role: 'user', actor_role: 'customer', text: 'How do I deploy?', created: '', run: 'r1' },
    { id: 2, role: 'assistant', intent: 'acknowledgement', text: 'Checking…', created: '', run: 'r1' },
  ], next_after: 2, activity: 'running' });
  const [, ack] = f.element('transcript').children;
  assert.equal(f.element('error').textContent, '');
  f.receive('sync', { messages: [], next_after: 2, activity: 'failed' });
  assert.equal(ack.removed, true);
  assert.match(f.element('error').textContent, /couldn't answer/);
  assert.equal(f.element('retry').textContent, 'Resend');
  assert.equal(f.composer.props.error, false, 'the draft did nothing wrong');
  // Resending asks the same question again and leaves a half-typed draft alone.
  f.element('text').value = 'A draft';
  f.element('retry').click();
  const sent = f.posted.filter(m => m.type === 'send');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'How do I deploy?');
  f.receive('sync', { submission: true, messages: [], next_after: 2, activity: 'queued' });
  assert.equal(f.element('text').value, 'A draft');
  assert.equal(f.element('error-bar').hidden, true);
  assert.equal(f.element('error').textContent, '');
});

test('a holding message that gave way never comes back, and a reload drops one nothing is working on', () => {
  const history = [
    { id: 1, role: 'user', actor_role: 'customer', text: 'Hi', created: '', run: 'r1' },
    { id: 2, role: 'assistant', intent: 'acknowledgement', text: 'Checking…', created: '', run: 'r1' },
  ];
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: history, next_after: 2, activity: 'failed' });
  // Live holding messages (the fixture DOM does not dedupe by id, so count only the ack).
  const holds = x => x.element('transcript').children.filter(a => a.dataset.message === '2' && !a.removed).length;
  assert.equal(holds(f), 0);
  // A read that returns the same history again (reopen, cursor reset) must not revive it.
  f.receive('sync', { messages: history, next_after: 2, activity: 'failed' });
  assert.equal(holds(f), 0);
  const reload = frameFixture(); reload.init(); reload.receive('open');
  reload.receive('sync', { messages: history, next_after: 2, activity: 'completed' });
  assert.equal(holds(reload), 0);
  const working = frameFixture(); working.init(); working.receive('open');
  working.receive('sync', { messages: history, next_after: 2, activity: 'running' });
  assert.equal(holds(working), 1, 'still checking');
});

test('a failed conversation with nothing asked yet shows no resend', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [], next_after: 0, activity: 'failed' });
  assert.equal(f.element('error').textContent, '');
});

test('a markdown table reads row by row, each value labelled by its header', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  const text = 'Plans:\n\n| Plan | Vietnam | Includes |\n| --- | ---: | --- |\n| **Pro** | 150,000 VND | BYOK, [docs](https://2novel.app/en/pricing) |\n| Free | 0 | |\nAfter.\n\n| not | a table |\nstill prose';
  f.receive('sync', { messages: [{ id: 1, role: 'assistant', text, created: '' }], next_after: 1, activity: 'connected' });
  const [lead, table, after, plain] = f.element('transcript').children[0].children[1].children;
  assert.equal(lead.children.join(''), 'Plans:');
  assert.equal(table.className, 'table');
  const [pro, free] = table.children;
  const [title, pairs] = pro.children;
  assert.equal(title.children[0].tagName, 'strong');
  assert.equal(title.children[0].textContent, 'Pro');
  assert.deepEqual(pairs.children.map(n => n.tagName), ['dt', 'dd', 'dt', 'dd']);
  assert.equal(pairs.children[0].children.join(''), 'Vietnam');
  assert.equal(pairs.children[1].children.join(''), '150,000 VND');
  assert.equal(pairs.children[3].children.find(n => n.tagName === 'a').href, 'https://2novel.app/en/pricing');
  assert.equal(free.children[1].children.length, 2, 'an empty cell is left out');
  assert.equal(after.children.join(''), 'After.');
  assert.equal(plain.children.join(''), '| not | a table |\nstill prose', 'pipes without a header rule stay text');
});

test('an unverified browser is told nothing was sent and can resend', () => {
  const f = frameFixture(); f.init(); f.element('text').value = 'Keep my question';
  f.receive('sync', { submission: true, error: { kind: 'challenge' } });
  assert.match(f.element('error').textContent, /nothing was sent/i);
  assert.doesNotMatch(f.element('error').textContent, /unconfirmed/i);
  assert.equal(f.element('retry').textContent, 'Resend');
  assert.equal(f.element('text').value, 'Keep my question');
});

test('a reply in progress shows its phase, step count and wait, and nothing of the work itself', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  const since = new Date(Date.now() - 12_000).toISOString();
  f.receive('sync', { messages: [], activity: 'running', progress: { run: 'r1', phase: 'thinking', steps: 0, since } });
  assert.equal(f.element('working').hidden, false);
  assert.equal(f.element('working-label').textContent, 'Thinking…');
  assert.equal(f.element('working-meta').textContent, ' · 12s');
  assert.equal(f.element('activity').textContent, 'Thinking…');
  assert.equal([...f.delays.entries()].find(([id]) => f.timers.has(id))[1], 2000, 'a working reply is polled a little closer');
  f.receive('sync', { messages: [], activity: 'running', progress: { run: 'r1', phase: 'working', steps: 2, since, tool: 'knowledge_search' } });
  assert.equal(f.element('working-label').textContent, 'Looking things up…');
  assert.match(f.element('working-meta').textContent, /^ · step 2 · 1[23]s$/);
  assert.doesNotMatch(f.element('working').textContent + f.element('working-meta').textContent, /knowledge/);
  // The reply lands above the working row, then the row goes when the run ends.
  f.receive('sync', { messages: [{ id: 3, role: 'assistant', run: 'r1', text: 'Here you go', created: new Date().toISOString() }], next_after: 3, activity: 'running',
    progress: { run: 'r1', phase: 'writing', steps: 2, since } });
  const log = f.element('transcript').children;
  assert.equal(log.at(-1), f.element('working'));
  assert.equal(log.at(-2).dataset.message, '3');
  f.receive('sync', { messages: [], next_after: 3, activity: 'completed' });
  assert.equal(f.element('working').hidden, true);
  assert.equal(f.element('activity').textContent, 'Ready to help');
  assert.equal(f.intervals.size, 0, 'no clock keeps ticking once the reply is done');
  assert.equal([...f.delays.entries()].find(([id]) => f.timers.has(id))[1], 3000);
});

test('a skewed visitor clock never shows a negative or hour-long wait, and a failed read keeps the phase', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [], activity: 'queued', progress: { run: 'r2', phase: 'queued', steps: 0, since: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(f.element('working-label').textContent, 'Got your message…');
  assert.equal(f.element('working-meta').textContent, '');
  f.receive('sync', { error: { kind: 'connection' } });
  assert.equal(f.element('working').hidden, false);
  f.receive('sync', { messages: [], activity: 'running', progress: { run: 'r3', phase: 'thinking', steps: 0, since: new Date(Date.now() - 3_600_000).toISOString() } });
  assert.equal(f.element('working-meta').textContent, ' · 600s');
  f.receive('sync', { error: { kind: 'expired' } });
  assert.equal(f.element('working').hidden, true);
});
