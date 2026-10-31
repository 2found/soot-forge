import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the shipped frame state machine. Only its DOM, composer and clock are
// substituted; transport stays at the same postMessage boundary as the iframe.
function frameFixture() {
  const elements = new Map(), handlers = new Map(), posted = [], islands = [], timers = new Map(), delays = new Map(), intervals = new Map();
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
    // The 2ui AgentQuestion island, reduced to its controlled props.
    createWidgetQuestion: (container, props) => { const island = { container, props, destroyed: false,
      update(next) { this.props = { ...this.props, ...next }; }, destroy() { this.destroyed = true; } }; islands.push(island); return island; },
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
  return { element, receive, init, posted, timers, delays, intervals, composer, context, islands };
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

// ---- live-chat-attention v1: question cards and pointers (spec §5.3, §8) ----
const card = (extra = {}) => ({ item: 'r_ask', prompt: 'Which plan?', multi: false,
  options: [{ label: 'Personal' }, { label: 'Team', description: 'up to 5 people' }, { label: 'Business' }], ...extra });
const asking = (extra = {}) => ({ id: 41, role: 'assistant', intent: 'assistant_reply', run: 'r_ask',
  text: 'Which plan?\n- Personal\n- Team\n- Business', created: '', question: card(extra) });
const opened = (f, extra = {}) => {
  f.init(); f.receive('open');
  f.receive('sync', { messages: [{ id: 40, role: 'user', actor_role: 'customer', text: 'Change plan', created: '' }, asking(extra)],
    next_after: 41, activity: 'waiting_input', question: card(), waiting: { on: 'asker', reason: 'question' }, pointers: [] });
  return f.islands[0];
};
const lines = f => f.element('transcript').children.filter(n => n.className === 'pointer' && !n.removed);

test('a question renders as one card, never also as the bullet text', () => {
  const f = frameFixture(), island = opened(f);
  assert.equal(f.islands.length, 1);
  const article = f.element('transcript').children.find(n => n.dataset?.message === '41');
  assert.match(article.className, /question-card/);
  assert.equal(article.children.some(n => n.className === 'prose'), false, 'no text bubble');
  assert.equal(island.props.title, 'Question');
  assert.equal(island.props.confirmLabel, 'Send');
  assert.equal(island.props.prompt, 'Which plan?');
  assert.deepEqual(island.props.options.map(o => o.label), ['Personal', 'Team', 'Business']);
  assert.equal(island.props.options[1].description, 'up to 5 people');
  assert.equal(island.props.answered, false);
  assert.equal(island.props.multiple, false);
  // The same message read again (a submission reads from the start) adds no second card.
  f.receive('sync', { submission: true, messages: [asking()], next_after: 41, activity: 'waiting_input', question: card(), pointers: [] });
  assert.equal(f.islands.length, 1);
});

test('choose and Send posts one answer; the resolution freezes the card with the receipt', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['1']);
  island.props.onConfirm();
  island.props.onConfirm();
  const answers = f.posted.filter(m => m.type === 'answer');
  assert.equal(answers.length, 1, 'a double tap sends once');
  assert.deepEqual({ item: answers[0].item, choices: [...answers[0].choices], message: answers[0].message }, { item: 'r_ask', choices: [1], message: 41 });
  assert.equal(island.props.busy, true);
  const resolution = { outcome: 'answered', labels: ['Team'], by: 'asker', at: '2026-10-31T10:00:00Z' };
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, messages: [asking({ resolution })], next_after: 42, activity: 'running', pointers: [] });
  assert.equal(island.props.answered, true);
  assert.equal(island.props.busy, false);
  assert.equal(island.props.footer, 'Answered · Team');
  assert.deepEqual([...island.props.value], ['1']);
  assert.equal(f.element('transcript').children.find(n => n.dataset?.message === '41').children.at(-1).hidden, true, 'no refusal note');
  // A reload renders the frozen card straight away.
  const reload = frameFixture(); reload.init(); reload.receive('open');
  reload.receive('sync', { messages: [asking({ resolution })], next_after: 41, activity: 'completed', pointers: [] });
  assert.equal(reload.islands[0].props.answered, true);
  assert.equal(reload.islands[0].props.footer, 'Answered · Team');
});

test('a typed answer leaves the composer working and the card says Answered without labels', () => {
  const f = frameFixture(), island = opened(f);
  assert.equal(f.composer.props.canSend, true, 'the composer stays enabled while a card is open');
  // The run resumed: the conversation no longer holds this question, so its message is read again.
  f.receive('sync', { messages: [], next_after: 42, activity: 'running', pointers: [] });
  f.timers.get([...f.timers.keys()].at(-1))();
  assert.equal(f.posted.at(-1).refresh, 41);
  f.receive('sync', { messages: [asking({ resolution: { outcome: 'answered', by: 'asker', at: 'x' } })], next_after: 42, activity: 'running', pointers: [] });
  assert.equal(island.props.answered, true);
  assert.equal(island.props.footer, 'Answered');
  assert.deepEqual([...island.props.value], []);
  f.timers.get([...f.timers.keys()].at(-1))();
  assert.equal(f.posted.at(-1).refresh, undefined, 'a frozen card is not read again');
});

test('a stale card is read again at most three times', () => {
  const f = frameFixture(); opened(f);
  // A read the loader dropped (busy, collapsed) costs no try; one it made does.
  f.receive('sync', { messages: [], next_after: 42, activity: 'running', pointers: [] });
  f.receive('sync', { messages: [], next_after: 42, activity: 'running', pointers: [] });
  for (let i = 0; i < 5; i++) {
    f.receive('sync', { messages: [], next_after: 42, activity: 'running', pointers: [], refreshed: 41 });
    f.timers.get([...f.timers.keys()].at(-1))();
  }
  assert.equal(f.posted.filter(m => m.type === 'sync' && m.refresh === 41).length, 2, 'after three reads that never froze it');
});

test('a second tab or double tap shows the resolution with a plain note, not an error', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['0']); island.props.onConfirm();
  // 409 already_resolved: the SDK refreshes; the other answer wins.
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, next_after: 42, activity: 'running', pointers: [],
    messages: [asking({ resolution: { outcome: 'answered', labels: ['Team'], by: 'asker', at: 'x' } })] });
  const note = f.element('transcript').children.find(n => n.dataset?.message === '41').children.at(-1);
  assert.equal(island.props.footer, 'Answered · Team');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'This question was already answered.');
  assert.equal(f.element('error-bar').hidden, true);
});

test('a stale card (Stop or replaced) refreshes to Question closed and says it changed', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['2']); island.props.onConfirm();
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, next_after: 42, activity: 'stopped', pointers: [],
    messages: [asking({ resolution: { outcome: 'closed', by: 'team', at: 'x' } })] });
  assert.equal(island.props.answered, true);
  assert.equal(island.props.footer, 'Question closed');
  const note = f.element('transcript').children.find(n => n.dataset?.message === '41').children.at(-1);
  assert.equal(note.textContent, 'This question has changed.');
});

test('a definitive refusal is worded by code; a transport failure keeps the answer for Resend', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['1']); island.props.onConfirm();
  f.receive('sync', { submission: true, answer: { item: 'r_ask', code: 'not_asker' }, messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [] });
  const note = f.element('transcript').children.find(n => n.dataset?.message === '41').children.at(-1);
  assert.equal(note.textContent, 'Only the person who asked can answer this.');
  assert.equal(island.props.busy, false);
  island.props.onConfirm();
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, error: { kind: 'send' } });
  assert.match(f.element('error').textContent, /unconfirmed/);
  assert.equal(f.element('retry').textContent, 'Resend');
  assert.equal(island.props.answered, false);
  f.element('retry').click();
  const answers = f.posted.filter(m => m.type === 'answer');
  assert.equal(answers.length, 3);
  assert.deepEqual([...answers.at(-1).choices], [1], 'the same answer, whose receipt the SDK kept');
});

test('a durable answer from another tab or a reload keeps the card busy until it settles', () => {
  const f = frameFixture(), island = opened(f);
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [], pendingAnswer: { id: 'a1', item: 'r_ask', choices: [0] } });
  assert.equal(island.props.busy, true);
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [], pendingAnswer: null });
  assert.equal(island.props.busy, false);
});

test('pointers render one line after their message, once, and none when the Soot already replied', () => {
  const f = frameFixture(); opened(f);
  const pointers = [{ item: 'ap_1', class: 'approval', reply: false, afterMessage: 40 }, { item: 'h_1', class: 'team', reply: true, afterMessage: 41 }];
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_human', waiting: { on: 'team', reason: 'approval' }, pointers });
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_human', waiting: { on: 'team', reason: 'approval' }, pointers });
  const shown = lines(f);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].textContent, 'This needs the team\'s approval. I\'ve let them know; you\'ll get the answer right here.');
  assert.equal(shown[0]['aria-live'], 'polite');
  const log = f.element('transcript').children;
  assert.equal(log.indexOf(shown[0]), log.findIndex(n => n.dataset?.message === '41') - 1, 'placed before the next message');
  assert.equal(f.element('activity').textContent, 'Waiting for the team\'s approval');
});

test('a pointer after a message not read yet waits for it', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [], next_after: 0, activity: 'queued', pointers: [{ item: 'nr_1', class: 'not_ready', reply: false, afterMessage: 3 }] });
  assert.equal(lines(f).length, 0);
  f.receive('sync', { messages: [{ id: 3, role: 'user', actor_role: 'customer', text: 'alo', created: '' }], next_after: 3, activity: 'queued',
    waiting: { on: 'team', reason: 'not_ready' }, pointers: [{ item: 'nr_1', class: 'not_ready', reply: false, afterMessage: 3 }] });
  assert.equal(lines(f).length, 1);
  assert.match(lines(f)[0].textContent, /isn't ready yet/);
  assert.equal(f.element('activity').textContent, 'Not ready yet');
});

test('unavailable for today offers no Resend loop', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [{ id: 5, role: 'user', actor_role: 'customer', text: 'One more question', created: '' }], next_after: 5,
    activity: 'failed', pointers: [{ item: 'u_1', class: 'unavailable', reply: false, afterMessage: 5 }] });
  assert.equal(lines(f)[0].textContent, 'Soot is paused for today. Please come back later.');
  assert.equal(lines(f)[0].dataset.class, 'unavailable');
  assert.equal(f.element('error').textContent, '', 'no "couldn\'t answer, Resend"');
  // Without the pointer the same failed run offers Resend (the control case).
  const g = frameFixture(); g.init(); g.receive('open');
  g.receive('sync', { messages: [{ id: 5, role: 'user', actor_role: 'customer', text: 'One more question', created: '' }], next_after: 5, activity: 'failed', pointers: [] });
  assert.equal(g.element('retry').textContent, 'Resend');
});

test('cards and pointers follow the page language', () => {
  const f = frameFixture(), island = opened(f);
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [{ item: 't_1', class: 'team', reply: false, afterMessage: 41 }] });
  f.receive('language', { language: 'vi' });
  assert.equal(island.props.title, 'Câu hỏi');
  assert.equal(island.props.confirmLabel, 'Gửi');
  assert.equal(lines(f)[0].textContent, 'Mình đã chuyển việc này cho đội ngũ. Bạn sẽ nhận trả lời ngay tại đây.');
  f.receive('sync', { messages: [asking({ resolution: { outcome: 'answered', labels: ['Team'], by: 'asker', at: 'x' } })], next_after: 42, activity: 'running', pointers: [] });
  assert.equal(island.props.footer, 'Đã trả lời · Team');
  f.receive('sync', { messages: [], next_after: 42, activity: 'waiting_human', waiting: { on: 'team', reason: 'approval' }, pointers: [] });
  assert.equal(f.element('activity').textContent, 'Đang chờ đội ngũ duyệt');
});

test('a new conversation clears cards and pointers', () => {
  const f = frameFixture(), island = opened(f);
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [{ item: 't_1', class: 'team', reply: false, afterMessage: 41 }] });
  const line = lines(f)[0];
  f.receive('reset-done');
  assert.equal(island.destroyed, true);
  assert.equal(line.removed, true);
  f.timers.get([...f.timers.keys()].at(-1))();
  assert.equal(f.posted.at(-1).refresh, undefined);
});

test('a busy loader reply unlocks the card and keeps the open question', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['1']); island.props.onConfirm();
  f.receive('sync', { answer: { item: 'r_ask', code: 'busy' } });
  assert.equal(island.props.busy, false);
  f.timers.get([...f.timers.keys()].at(-1))?.();
  assert.equal(f.posted.filter(m => m.type === 'sync' && m.refresh === 41).length, 0, 'still the open question');
  island.props.onConfirm();
  assert.equal(f.posted.filter(m => m.type === 'answer').length, 2);
});

test('an accepted answer whose read failed unlocks the composer and offers no Resend of the answer', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['1']); island.props.onConfirm();
  f.receive('sync', { submission: true, answer: { item: 'r_ask', read: false }, error: { kind: 'connection' } });
  assert.equal(island.props.busy, false);
  assert.equal(f.element('retry').textContent, 'Reconnect');
  f.element('text').value = 'next';
  f.composer.submit();
  assert.equal(f.posted.filter(m => m.type === 'send').length, 1, 'the composer is not locked');
});

test('a multi-select answer of my own never reads as lost when labels come back reordered', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [asking({ multi: true })], next_after: 41, activity: 'waiting_input', question: card({ multi: true }), pointers: [] });
  const island = f.islands[0];
  assert.equal(island.props.multiple, true);
  island.props.onValueChange(['2', '0']); island.props.onConfirm();
  assert.deepEqual([...f.posted.filter(m => m.type === 'answer')[0].choices], [0, 2]);
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, next_after: 42, activity: 'running', pointers: [],
    messages: [asking({ multi: true, resolution: { outcome: 'answered', labels: ['Business', 'Personal'], by: 'asker', at: 'x' } })] });
  assert.equal(f.element('transcript').children.find(n => n.dataset?.message === '41').children.at(-1).hidden, true);
  assert.equal(island.props.footer, 'Answered · Business, Personal');
});

test('a failed answer keeps its Resend while the SDK holds the receipt, also after a reload', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['1']); island.props.onConfirm();
  // A timeout: the SDK keeps the receipt, and the next background read still shows it.
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, error: { kind: 'send' } });
  const held = { id: 'a1', item: 'r_ask', choices: [1] };
  f.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [], pendingAnswer: held });
  assert.equal(f.element('retry').textContent, 'Resend', 'a background read does not clear the answer error');
  assert.equal(f.element('error-bar').hidden, false);
  f.element('retry').click();
  assert.deepEqual([...f.posted.filter(m => m.type === 'answer').at(-1).choices], [1]);
  // A reload: only the receipt knows the answer; one read may be another tab in flight, two are not.
  const g = frameFixture(), card2 = opened(g);
  g.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [], pendingAnswer: held });
  assert.equal(card2.props.busy, true);
  assert.equal(g.element('error').textContent, '', 'one read: maybe another tab is sending');
  g.receive('sync', { messages: [], next_after: 41, activity: 'waiting_input', question: card(), pointers: [], pendingAnswer: held });
  assert.equal(g.element('retry').textContent, 'Resend');
  g.element('retry').click();
  const sent = g.posted.filter(m => m.type === 'answer');
  assert.equal(sent.length, 1);
  assert.deepEqual([...sent[0].choices], [1], 'the held choices, same receipt');
});

test('a rate-limited answer offers Resend of the answer, not a plain sync', () => {
  const f = frameFixture(), island = opened(f);
  island.props.onValueChange(['0']); island.props.onConfirm();
  f.receive('sync', { submission: true, answer: { item: 'r_ask' }, error: { kind: 'rate' } });
  assert.match(f.element('error').textContent, /./);
  f.element('retry').click();
  assert.equal(f.posted.filter(m => m.type === 'answer').length, 2);
});

test('an unavailable pointer from before the latest message does not hide a later failure', () => {
  const f = frameFixture(); f.init(); f.receive('open');
  f.receive('sync', { messages: [{ id: 5, role: 'user', actor_role: 'customer', text: 'Hi', created: '' }], next_after: 5,
    activity: 'failed', pointers: [{ item: 'u_1', class: 'unavailable', reply: false, afterMessage: 5 }] });
  assert.equal(f.element('error').textContent, '');
  f.element('text').value = 'Tomorrow question'; f.composer.submit();
  f.receive('sync', { submission: true, messages: [{ id: 9, role: 'user', actor_role: 'customer', text: 'Tomorrow question', created: '' }], next_after: 9,
    activity: 'failed', pointers: [{ item: 'u_1', class: 'unavailable', reply: false, afterMessage: 5 }] });
  assert.equal(f.element('retry').textContent, 'Resend');
});

test('the powered-by line links the brand word to the product site in a new tab', () => {
  const f = frameFixture();
  f.init();
  const [before, link, after] = f.element('chat:footer').children;
  assert.equal(before, 'Powered by ');
  assert.equal(after, '');
  assert.equal(link.tagName, 'a');
  assert.equal(link.textContent, 'Soot');
  assert.equal(link.href, 'https://trysoot.com');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
});
