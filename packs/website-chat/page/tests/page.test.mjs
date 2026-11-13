// Live chat settings page bundle (D6.2): the bodies the page sends are the
// tools' own parameters, outcomes keep the request id while an answer is
// unknown, the embed refuses an unsafe address, and the bundle never fetches.
// tests/ is not shipped in the pack archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createBridge, randomID, REQUEST_ID } from '../src/bridge.js';
import * as M from '../src/model.js';
import { build } from './build.mjs';

const page = new URL('../', import.meta.url);
const pack = JSON.parse(await readFile(new URL('../../pack.json', import.meta.url), 'utf8'));
const tool = name => pack.tools.find(t => t.name === name);
const site = { id: 'site_1', revision: 3, published_revision: 2, paused: false, draft: M.defaultConfig('cs'), published: null };

test('the declaration is a server settings piece on the pack\'s read view tool and stdin-context action tool', () => {
  const [p] = pack.interface.pieces;
  assert.deepEqual({ id: p.id, slot: p.slot, access: p.access, group: p.group, bundle: p.bundle }, { id: 'live-chat-settings', slot: 'settings', access: 'operator', group: 'server', bundle: 'page/' });
  assert.equal(tool(p.data.view_tool).run.mode, 'read');
  assert.equal(tool(p.data.view_tool).run.stdin, 'context');
  assert.equal(tool(p.data.action_tool).run.stdin, 'context');
  assert.equal(pack.interface.tool_area, undefined, 'the tool area is replaced by the page');
  assert.equal(pack.label.vi, 'Live chat trên website');
  assert.ok(pack.keywords.vi.includes('live chat'));
});

test('every body the page builds passes the tool parameters; writes carry the stable request id and current revision', () => {
  const ajv = new Ajv2020({ strict: false });
  const view = ajv.compile(tool('website_view').parameters), action = ajv.compile(tool('website_action').parameters);
  for (const body of [M.listSites(), M.listSites(100), M.getSite('site_1')]) assert.ok(view(body), JSON.stringify(view.errors));
  const id = randomID('lc', 12);
  assert.match(id, REQUEST_ID);
  const create = M.actionBody('create', id, { config: M.defaultConfig('cs') });
  assert.deepEqual(Object.keys(create).sort(), ['action', 'config', 'request_id']);
  for (const kind of /** @type {const} */ (['save', 'publish', 'pause', 'resume'])) {
    const body = M.actionBody(kind, id, { site, config: { ...site.draft, name: 'Mây' } });
    assert.ok(action(body), `${kind}: ${JSON.stringify(action.errors)}`);
    assert.deepEqual([body.request_id, body.site_id, body.expected_revision], [id, 'site_1', 3]);
    assert.equal('config' in body, kind === 'save', `${kind} sends a config only when saving`);
  }
  assert.ok(action(create));
  assert.throws(() => M.actionBody('save', id), /needs a site/);
  assert.throws(() => M.actionBody('create', id), /needs a config/);
});

test('outcomes: a lost or 5xx answer keeps the id (unknown); busy waits; a stale revision is a conflict; a refusal names its code', () => {
  for (const code of ['no_response', 'request_in_flight', 'timeout', 'result_unknown', 'unavailable', 'page_call_failed', 'http_502']) {
    assert.equal(M.classify({ ok: false, error: { code, message: '' } }).state, 'unknown', code);
  }
  assert.equal(M.classify({ ok: false, error: { code: 'busy', message: '' } }).state, 'busy');
  assert.equal(M.classify({ ok: false, error: { code: 'reloading', message: '' } }).state, 'busy');
  assert.deepEqual(M.classify({ ok: false, error: { code: 'http_404', message: '' } }), { state: 'rejected', code: 'http_404' });
  assert.deepEqual(M.classify({ ok: true, output: { error: { code: 'revision_conflict', status: 409 } } }), { state: 'conflict', code: 'revision_conflict' });
  assert.deepEqual(M.classify({ ok: true, output: { error: { status: 403 } } }), { state: 'rejected', code: 'request_rejected' });
  assert.equal(M.classify({ ok: true, output: { not: 'a site' } }).state, 'unknown', 'an answer that is not a site cannot drop the id');
  const done = M.classify({ ok: true, output: site, receipt: { replayed: true } });
  assert.deepEqual([done.state, done.replayed], ['done', true]);
  const t = M.strings('vi');
  assert.match(M.errorText(t, 'revision_conflict'), /được giữ/);
  assert.match(M.errorText(t, 'odd_code'), /odd_code/);
  assert.equal(M.errorText(t, 'toString'), t.rejected('toString'), 'no prototype key reads as copy');
});

test('a lost answer resent with the same request id writes once', async () => {
  const posted = [], listeners = [], parent = {};
  const bridge = createBridge({ post: m => posted.push(m), listen: h => listeners.push(h), parent, timeoutMs: 30 });
  const receipts = new Map(); let writes = 0, drop = true;
  const answer = () => {
    const call = posted.at(-1);
    const replayed = receipts.has(call.request_id);
    if (!replayed) { writes++; receipts.set(call.request_id, { ...site, revision: 4 }); }
    if (drop) { drop = false; return; }
    listeners.forEach(h => h({ v: 2, type: 'result', id: call.id, ok: true, output: receipts.get(call.request_id), receipt: { request_id: call.request_id, status: 'done', at: new Date().toISOString(), ...(replayed ? { replayed: true } : {}) } }, parent));
  };
  const id = randomID('lc', 12), body = M.actionBody('save', id, { site });
  const first = bridge.call('action', body, id); answer();
  assert.equal(M.classify(await first).state, 'unknown');
  const second = bridge.call('action', body, id); answer();
  const c = M.classify(await second);
  assert.deepEqual([c.state, c.replayed, writes], ['done', true, 1]);
});

test('answers are shape-checked: a malformed site or list item is dropped, unknown theme falls back', () => {
  const o = M.parseOverview({ sites: [{ id: 'a', draft: { name: 'A' } }, { id: 'bad\n', draft: {} }, { nope: 1 }], next_after: 2, capabilities: { soots: ['cs', 7], public_url: 'https://chat.example.com' } });
  assert.deepEqual(o, { sites: [{ id: 'a', name: 'A' }], next: 2, soots: ['cs'], publicURL: 'https://chat.example.com' });
  assert.equal(M.parseSite({ id: 'a' }), null);
  assert.equal(M.parseSite({ id: 'a', draft: { theme: 'neon', position: 'top' } })?.draft.theme, 'light');
  assert.deepEqual(M.splitLines(' a \n\n b \n c\nd\ne\nf', M.QUICK_REPLIES), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(M.changed(site.draft, structuredClone(site.draft)), false);
});

test('the embed snippet needs https (http only on this machine) and a plain site id', () => {
  assert.equal(M.embedSnippet('https://chat.example.com/', 'site_1'), '<script async src="https://chat.example.com/widget/v1.js" data-site="site_1"></script>');
  assert.match(M.embedSnippet('http://localhost:8787', 'site_1'), /localhost:8787\/widget/);
  for (const [url, id] of [['http://chat.example.com', 'site_1'], ['javascript:alert(1)', 'site_1'], ['https://u:p@chat.example.com', 'site_1'], ['https://chat.example.com/?x=1', 'site_1'], ['not a url', 'site_1'], ['https://chat.example.com', 'a"><script>'], ['', 'site_1']]) {
    assert.equal(M.embedSnippet(url, id), '', `${url} ${id}`);
  }
});

test('labels exist in Vietnamese and English with the same keys', () => {
  assert.deepEqual(Object.keys(M.STRINGS.en).sort(), Object.keys(M.STRINGS.vi).sort());
  assert.deepEqual(Object.keys(M.STRINGS.en.errors).sort(), Object.keys(M.STRINGS.vi.errors).sort());
  assert.equal(M.strings('fr').title, M.STRINGS.vi.title);
});

test('the bundle makes no network call and has no inline script, style, form or modal', async () => {
  const files = [...(await readdir(page)), ...(await readdir(new URL('src/', page))).map(n => 'src/' + n)];
  for (const name of files) {
    if (!/\.(js|html|css)$/.test(name)) continue;
    const text = await readFile(new URL(name, page), 'utf8');
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(\s*['"]https?:/, name);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${name} sets text, never markup`);
    // example.com is the default allowed-origin placeholder, never loaded.
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org|example\.com)/, `${name} loads nothing remote`);
    assert.doesNotMatch(text, /h\('form'|<form|\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/, `${name} uses no form or modal`);
    if (name.endsWith('.html')) {
      assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
      assert.doesNotMatch(text, /<style|\sstyle=|\son[a-z]+=/i, 'no inline style or handler');
      assert.doesNotMatch(text, /type="module"/, 'the page ships a classic script');
    }
  }
});

test('the shipped classic app.js is the current build of src/ and parses as a classic script', async () => {
  const built = await build();
  assert.equal(await readFile(new URL('app.js', page), 'utf8'), built, 'run node packs/website-chat/page/tests/build.mjs');
  assert.doesNotThrow(() => new Function(built));
});

test('bridge v2: posts carry v 2; init carries viewer and project; v1 messages and product contexts are dropped', () => {
  const posted = [], listeners = [], parent = {}, seen = [];
  const bridge = createBridge({ post: m => posted.push(m), listen: h => listeners.push(h), parent, timeoutMs: 10, onInit: i => seen.push(['init', i.project]), onContext: p => seen.push(['context', p]) });
  bridge.ready();
  assert.deepEqual(posted[0], { v: 2, type: 'ready' });
  const project = { id: 'lohi', name: 'Lohi', teams: ['marketing'] };
  const deliver = m => listeners.forEach(h => h(m, parent));
  deliver({ v: 1, type: 'init', theme: 'light', locale: 'vi', tokens: {} });
  deliver({ v: 2, type: 'init', theme: 'light', locale: 'vi', tokens: {}, project: null }); // no viewer
  deliver({ v: 2, type: 'context', product: null, products: [] });
  deliver({ v: 2, type: 'init', theme: 'light', locale: 'vi', tokens: { '--background': '#fff' }, viewer: { kind: 'operator' }, project });
  deliver({ v: 2, type: 'context', project: null });
  assert.deepEqual(seen, [['init', project], ['context', null]]);
  void bridge.call('view', {});
  assert.equal(posted[1].v, 2);
});
