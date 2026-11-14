// Khách hàng piece bundle (customers): the declaration, bodies that pass the tools'
// parameters, outcomes that keep the request id while an answer is unknown,
// and a bundle that never fetches. tests/ is not shipped in the pack archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createBridge, parseNestMessage, randomID, REQUEST_ID } from '../src/bridge.js';
import * as M from '../src/model.js';
import { build } from './build.mjs';

const page = new URL('../', import.meta.url);
const pack = JSON.parse(await readFile(new URL('../../pack.json', import.meta.url), 'utf8'));
const tool = name => pack.tools.find(t => t.name === name);

test('the declaration is a member project.tab piece (tab support) on a read view tool and a write action tool; storage keeps only tags, notes and links by principal', () => {
  const [p] = pack.interface.pieces;
  assert.deepEqual({ id: p.id, slot: p.slot, tab: p.tab, access: p.access, bundle: p.bundle, vi: p.label.vi },
    { id: 'customers', slot: 'project.tab', tab: { id: 'support', label: { vi: 'Hỗ trợ', en: 'Support' } }, access: 'member', bundle: 'page/', vi: 'Khách hàng' });
  assert.equal(p.provides, undefined, 'a project tab is placed by its slot, never by a flow capability');
  assert.equal(tool(p.data.view_tool).run.mode, 'read');
  assert.equal(tool(p.data.action_tool).run.mode, 'write', 'storage writes need a write-mode token');
  for (const t of pack.tools) { assert.equal(t.run.stdin, 'context'); assert.equal(t.approval, undefined, 'pieces refuse approval-gated tools'); }
  assert.deepEqual(pack.storage.tables.map(t => t.name), ['tags', 'notes', 'links', 'proofs', 'proof_claims']);
  for (const t of pack.storage.tables.filter(t => !['proofs', 'proof_claims'].includes(t.name))) assert.equal(t.columns.find(c => c.name === 'sub').principal, true, t.name);
  // Used proof ids only (no person in them): kept past an unlink so a proof is never replayed.
  assert.deepEqual(pack.storage.tables.find(t => t.name === 'proofs').columns.map(c => [c.name, !!c.principal]), [['jti', false], ['kid', false]]);
  assert.equal(pack.storage.tables.find(t => t.name === 'proof_claims').columns.find(c => c.name === 'jti').unique, true, 'D3: the jti claim is a declared unique column');
  assert.equal(pack.storage.tables.find(t => t.name === 'links').columns.find(c => c.name === 'alias').principal, true);
});

test('every body the page builds passes the tool parameters; writes carry the stable request id', () => {
  const ajv = new Ajv2020({ strict: false });
  const view = ajv.compile(tool('console_view').parameters), action = ajv.compile(tool('console_action').parameters);
  for (const body of [M.listBody(), M.listBody(' Khoa '), M.listBody('', 'eyJrIjowLCJhIjoiMTAwIn0'), M.detailBody('lohi:u-1001')]) assert.ok(view(body), JSON.stringify(view.errors));
  const id = randomID('cs', 12);
  assert.match(id, REQUEST_ID);
  const control = { conversation: 'c1', owner: 'agent', state: 'active', revision: 3, can_control: true };
  const bodies = [M.controlBody(control), M.controlBody({ ...control, owner: 'human' }), M.tagBody('lohi:u-1', ' VIP '), M.tagBody('lohi:u-1', 'VIP', true),
    M.noteBody('lohi:u-1', 'ghi chú'), M.linkBody('a.b.c'), { kind: 'note_delete', id: 'r1' }, { kind: 'unlink', id: 'r2' }];
  for (const b of bodies) { const body = M.actionBody(id, b); assert.ok(action(body), JSON.stringify(action.errors)); assert.equal(body.request_id, id); }
  assert.equal(M.controlBody(control).action, 'takeover');
  assert.equal(M.controlBody({ ...control, state: 'waiting_human' }).action, 'resume');
  assert.equal(M.tagBody('k', ' VIP ').tag, 'VIP');
});

test('outcomes: a lost or 5xx answer is unknown; busy waits; a tool refusal is rejected with its code', () => {
  for (const code of ['no_response', 'request_in_flight', 'timeout', 'result_unknown', 'unavailable', 'http_502']) assert.equal(M.classify({ ok: false, error: { code, message: '' } }).state, 'unknown', code);
  assert.equal(M.classify({ ok: false, error: { code: 'busy', message: '' } }).state, 'busy');
  assert.deepEqual(M.classify({ ok: true, output: { error: { code: 'proof_expired', message: 'x' } } }), { state: 'rejected', code: 'proof_expired', message: 'x' });
  assert.deepEqual(M.classify({ ok: true, output: { added: true }, replayed: true }), { state: 'done', output: { added: true }, replayed: true });
  assert.throws(() => M.viewOutput({ ok: true, output: { error: { code: 'not_configured', message: '' } } }), e => e.code === 'not_configured');
  const t = M.strings('vi');
  assert.equal(M.errorText(t, 'proof_expired'), t.errors.proof_expired);
  assert.equal(M.errorText(t, 'weird', 'Máy chủ nói vậy'), 'Máy chủ nói vậy');
});

test('a lost action answer resent with the same request id writes once', async () => {
  const posted = [], listeners = [], parent = {};
  const bridge = createBridge({ post: m => posted.push(m), listen: h => listeners.push(h), parent, timeoutMs: 30 });
  const receipts = new Map(); let writes = 0, drop = true;
  const answer = () => {
    const call = posted.at(-1), replayed = receipts.has(call.request_id);
    if (!replayed) { writes++; receipts.set(call.request_id, { tag: 'VIP', added: true }); }
    if (drop) { drop = false; return; }
    listeners.forEach(h => h({ v: 2, type: 'result', id: call.id, ok: true, output: receipts.get(call.request_id), receipt: { request_id: call.request_id, status: 'done', at: new Date().toISOString(), ...(replayed ? { replayed: true } : {}) }, ...(replayed ? { replayed: true } : {}) }, parent));
  };
  const id = randomID('cs', 12), body = M.actionBody(id, M.tagBody('lohi:u-1', 'VIP'));
  const first = bridge.call('action', body, id); answer();
  assert.equal(M.classify(await first).state, 'unknown');
  const second = bridge.call('action', body, id); answer();
  const c = M.classify(await second);
  assert.deepEqual([c.state, c.replayed, writes], ['done', true, 1]);
});

test('bridge v2: posts carry v 2; init carries viewer and project; v1 messages and product contexts are dropped', () => {
  const posted = [], listeners = [], parent = {}, seen = [];
  const bridge = createBridge({ post: m => posted.push(m), listen: h => listeners.push(h), parent, timeoutMs: 10, onInit: i => seen.push(['init', i.project]), onContext: p => seen.push(['context', p]) });
  bridge.ready();
  assert.deepEqual(posted[0], { v: 2, type: 'ready' });
  const project = { id: 'lohi', name: 'Lohi', teams: ['support'] };
  const deliver = m => listeners.forEach(h => h(m, parent));
  deliver({ v: 1, type: 'init', theme: 'light', locale: 'vi', tokens: {} });
  deliver({ v: 2, type: 'init', theme: 'light', locale: 'vi', tokens: {}, project: null }); // no viewer
  deliver({ v: 2, type: 'context', product: null, products: [] });
  deliver({ v: 2, type: 'init', theme: 'light', locale: 'vi', tokens: { '--background': '#fff' }, viewer: { kind: 'member' }, project });
  deliver({ v: 2, type: 'context', project: null });
  assert.deepEqual(seen, [['init', project], ['context', null]]);
  assert.equal(parseNestMessage({ v: 2, type: 'context', project: { id: 'lohi', name: 'Lohi' } }), null, 'a project names its teams');
  void bridge.call('view', M.listBody());
  assert.equal(posted[1].v, 2);
});

test('a later host: keys the page does not know are ignored, so the page never waits for an init it was sent', () => {
  const listeners = [], parent = {}, seen = [];
  createBridge({ post: () => {}, listen: h => listeners.push(h), parent, timeoutMs: 10, onInit: i => seen.push(['init', i.project?.id ?? null]), onContext: p => seen.push(['context', p?.id ?? null]) });
  const project = { id: 'acme', name: 'Acme', teams: ['team-a'] };
  const deliver = m => listeners.forEach(h => h(m, parent));
  // Nest 0.18.0's init: `level`, and from level 2 `visible` and `cached`.
  deliver({ v: 2, type: 'init', level: 1, visible: true, cached: [], theme: 'light', locale: 'vi', tokens: {}, viewer: { kind: 'operator', later: 1 }, project, projects: [{ ...project, later: 1 }] });
  deliver({ v: 2, type: 'context', project: null, projects: [], later: 1 });
  assert.deepEqual(seen, [['init', 'acme'], ['context', null]]);
  assert.equal(parseNestMessage({ v: 2, type: 'theme', theme: 'dark', tokens: {}, later: 1 })?.type, 'theme');
  assert.equal(parseNestMessage({ v: 2, type: 'result', id: 'c-1', ok: true, output: {}, later: 1 })?.ok, true);
  assert.equal(parseNestMessage({ v: 2, type: 'result', id: 'c-1', ok: false, error: { code: 'busy', message: 'm', later: 1 } })?.ok, false);
});

test('bridge v2: a host that also sends projects (the projects the viewer can see) is still heard; a malformed list is dropped', () => {
  const listeners = [], parent = {}, seen = [];
  createBridge({ post: () => {}, listen: h => listeners.push(h), parent, timeoutMs: 10, onInit: i => seen.push(['init', i.project]), onContext: p => seen.push(['context', p]) });
  const project = { id: 'acme', name: 'Acme', teams: ['team-a'] };
  const deliver = m => listeners.forEach(h => h(m, parent));
  const init = { v: 2, type: 'init', theme: 'light', locale: 'vi', tokens: {}, viewer: { kind: 'operator' }, project };
  deliver({ ...init, projects: project });
  deliver({ ...init, projects: [null] });
  deliver({ ...init, projects: [{ id: 'acme', name: 'Acme' }] });
  deliver({ ...init, projects: Array.from({ length: 65 }, () => project) });
  deliver({ ...init, projects: [project, { id: 'beta', name: 'Beta', teams: [] }] });
  deliver({ v: 2, type: 'context', project: null, projects: 'x' });
  deliver({ v: 2, type: 'context', project: null, projects: [] });
  assert.deepEqual(seen, [['init', project], ['context', null]]);
});

test('labels exist in Vietnamese and English with the same keys', () => {
  const vi = M.strings('vi'), en = M.strings('en');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  assert.deepEqual(Object.keys(en.status).sort(), ['done', 'human', 'need', 'soot']);
  assert.equal(M.strings('fr').title, 'Khách hàng');
});

test('the bundle makes no network call and has no inline script, style, form or modal', async () => {
  const files = [...(await readdir(page)), ...(await readdir(new URL('src/', page))).map(n => 'src/' + n)];
  for (const name of files) {
    if (!/\.(js|html|css)$/.test(name)) continue;
    const text = await readFile(new URL(name, page), 'utf8');
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(\s*['"]https?:/, name);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, `${name} sets text, never markup`);
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org)/, `${name} loads nothing remote`);
    assert.doesNotMatch(text, /h\('form'|<form|\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/, `${name} uses no form or modal`);
    if (name.endsWith('.html')) {
      assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
      assert.doesNotMatch(text, /<style|\sstyle=|\son[a-z]+=/i, 'no inline style or handler');
    }
  }
});

test('the page tells Nest it is ready, so Nest sends init and the list loads (soot-pages §5)', async () => {
  const app = await readFile(new URL('src/app.js', page), 'utf8');
  assert.match(app, /^bridge\.ready\(\);$/m, 'Nest waits for ready before init');
  assert.match(app, /setTimeout\(start, \d+\)/, 'the standalone shell may send no init');
});

test('the shipped classic app.js is the current build of src/ and parses as a classic script', async () => {
  const built = await build();
  assert.equal(await readFile(new URL('app.js', page), 'utf8'), built, 'run node packs/cs-console/page/tests/build.mjs');
  assert.doesNotThrow(() => new Function(built));
});

test('D2: the next page of people joins the rows shown; one person across two pages is one row with both counted', () => {
  const row = (key, o = {}) => ({ key, name: key, status: 'done', channels: ['web'], levels: ['asserted'], latest: '2026-11-01T07:00:00Z', conversations: 1, tags: [], ...o });
  const merged = M.mergeRows([row('a'), row('b', { status: 'soot' })], [row('a', { status: 'need', channels: ['tg'], conversations: 2, tags: ['vip'], latest: '2026-11-02T00:00:00Z' }), row('c')]);
  assert.deepEqual(merged.map(r => r.key), ['a', 'b', 'c']);
  assert.deepEqual([merged[0].status, merged[0].channels, merged[0].conversations, merged[0].tags, merged[0].latest], ['need', ['tg', 'web'], 3, ['vip'], '2026-11-02T00:00:00Z']);
  assert.equal(M.listBody('', 'cur').cursor, 'cur');
  assert.equal('cursor' in M.listBody(), false);
});

test('D2: the page words the cut list, timeline and notes in both languages, and renders the Load more control', async () => {
  for (const loc of ['vi', 'en']) { const t = M.strings(loc); for (const k of ['loadMore', 'listTruncated', 'timelineTruncated', 'notesTruncated']) assert.ok(t[k], `${loc}.${k}`); }
  assert.notEqual(M.strings('vi').loadMore, M.strings('en').loadMore);
  const src = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(src, /S\.truncated &&/);
  assert.match(src, /d\.timeline_truncated &&/);
  assert.match(src, /d\.notes_truncated &&/);
});

test('N11 (audit 2026-11-14): no env name in the words; a missing key is Nest\'s one message, and the page keeps one Tải lại', async () => {
  for (const loc of ['vi', 'en']) {
    const t = M.strings(loc);
    for (const text of [...Object.values(t.errors), t.loadFailed, t.waitingSetup]) assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|README/, `${loc}: ${text}`);
  }
  const src = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.equal((src.match(/button\(t\.reload,/g) ?? []).length, 1, 'one retry: the search row\'s');
  assert.match(src, /code === M\.SAID_BY_NEST \? ''/, 'credential_missing adds no second message');
});
