import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the shipped frame state machine. Only its DOM, composer and clock are
// substituted; transport stays at the same postMessage boundary as the iframe.
function frameFixture() {
  const elements = new Map(), handlers = new Map(), posted = [], timers = new Map();
  let timerID = 0;
  class Element {
    constructor(id = '') { this.id = id; this.hidden = false; this.value = ''; this.children = []; this.dataset = {}; this.style = {}; this.textContent = ''; }
    setAttribute(key, value) { this[key] = value; }
    querySelector(selector) { return element(this.id + ':' + selector); }
    querySelectorAll() { return []; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    focus() {}
    contains(target) { return target === this; }
    click() { this.onclick?.(); }
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
    setTimeout: fn => { timers.set(++timerID, fn); return timerID; }, clearTimeout: id => timers.delete(id),
    addEventListener: (type, fn) => handlers.set(type, fn) };
  const source = readFileSync(new URL('../packs/live-chat/widget/frame.js', import.meta.url), 'utf8');
  runInNewContext(source.replace(/^import .*;\n/gm, ''), context);
  const receive = (type, extra = {}) => handlers.get('message')({ source: parent, origin: 'https://site.example',
    data: { soot_chat: 1, nonce: 'fixture-nonce', type, ...extra } });
  const init = () => receive('init', { language: 'en', config: { name: 'Support' } });
  return { element, receive, init, posted, timers, composer, context };
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
