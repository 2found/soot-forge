// Kho tài liệu piece bundle (library): bridge v2, request bodies, outcomes and draft recovery.
// tests/ is not shipped in the pack archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { createBridge, parseNestMessage, randomID, REQUEST_ID } from '../src/bridge.js';
import * as M from '../src/model.js';
import { docTitle, readerIds, strings, STRINGS } from '../src/text.js';
import { build } from './build.mjs';

const page = new URL('../', import.meta.url);
const pack = JSON.parse(await readFile(new URL('../../pack.json', import.meta.url), 'utf8'));
const bodies = JSON.parse(await readFile(new URL('bodies.json', import.meta.url), 'utf8'));
const tool = name => pack.tools.find(t => t.name === name);

test('the page and Nest share one body: legacy pools/query bodies pass, an unknown kind is refused with a reason', () => {
  const ajv = new Ajv2020({ strict: false });
  const params = { view: ajv.compile(tool('view').parameters), action: ajv.compile(tool('action').parameters) };
  for (const c of bodies) {
    const build = () => c.mode === 'view' ? M.viewBody(c.input.kind, c.input.input) : M.actionBody(c.input.kind, c.input.input);
    if (c.valid) {
      assert.deepEqual(build(), c.input, c.name);
      assert.ok(params[c.mode](c.input), `${c.name}: ${JSON.stringify(params[c.mode].errors)}`);
    } else {
      assert.throws(build, new RegExp(c.reason), c.name);
      assert.equal(params[c.mode](c.input), false, `${c.name}: the tool's kind enum refuses it too`);
    }
  }
  // The builders the page uses produce exactly the legacy shapes.
  assert.deepEqual(M.listPools(), bodies[0].input);
  assert.deepEqual(M.searchDocuments('lohi-support', 'hoan LT'), bodies[1].input);
  assert.deepEqual(M.poolDetail('lohi-support'), bodies[2].input);
  assert.deepEqual(M.requestStatus('lib-0123456789abcdef01234567'), bodies[3].input);
});

test('the declaration matches soot-pages v2: data.tab piece, operator, read view tool and action tool on stdin context', () => {
  const [p] = pack.interface.pieces;
  assert.deepEqual({ id: p.id, slot: p.slot, access: p.access, bundle: p.bundle }, { id: 'library', slot: 'data.tab', access: 'operator', bundle: 'page/' });
  assert.equal(pack.interface.tool_area, undefined, 'the tool area is replaced by the piece');
  assert.equal(tool(p.data.view_tool).run.mode, 'read');
  assert.equal(tool(p.data.view_tool).run.stdin, 'context');
  assert.equal(tool(p.data.action_tool).run.stdin, 'context');
  assert.deepEqual(pack.label, { vi: 'Kho tài liệu', en: 'Library' });
});

test('the bundle makes no network call and has no inline script or style (CSP default-src self, connect-src none)', async () => {
  const files = [...(await readdir(page)), ...(await readdir(new URL('src/', page))).map(n => 'src/' + n)];
  for (const name of files) {
    if (!/\.(js|html|css)$/.test(name)) continue;
    const text = await readFile(new URL(name, page), 'utf8');
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(\s*['"]https?:/, name);
    assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org)/, `${name} loads nothing remote`);
    // sandbox="allow-scripts" only: no form submission, no modal dialogs.
    assert.doesNotMatch(text, /h\('form'|<form|\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/, `${name} uses no form or modal`);
    if (name.endsWith('.html')) {
      assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
      assert.doesNotMatch(text, /<style|\sstyle=|\son[a-z]+=/i, 'no inline style or handler');
      assert.doesNotMatch(text, /type="module"/, 'a sandboxed frame fetches module scripts with CORS; the page ships a classic script');
    }
  }
});

function fakeHost() {
  const posted = [], listeners = [];
  const parent = { name: 'nest' };
  const bridge = createBridge({ post: m => posted.push(m), listen: h => listeners.push(h), parent, timeoutMs: 50 });
  const deliver = (data, source = parent) => listeners.forEach(h => h(data, source));
  return { bridge, posted, deliver, parent };
}

test('bridge v2: calls carry only v/type/id/mode/input/request_id; results route by id; foreign or malformed messages are dropped', async () => {
  const { bridge, posted, deliver } = fakeHost();
  bridge.ready();
  assert.deepEqual(posted[0], { v: 2, type: 'ready' });
  const done = bridge.call('view', M.listPools());
  const call = posted[1];
  assert.deepEqual(Object.keys(call).sort(), ['id', 'input', 'mode', 'type', 'v']);
  assert.ok(call.id.length <= 64);
  deliver({ v: 2, type: 'result', id: call.id, ok: true }); // no output: dropped
  deliver({ v: 1, type: 'result', id: call.id, ok: true, output: { pools: [] } }); // other version: dropped
  deliver({ v: 2, type: 'result', id: call.id, ok: true, output: { pools: [] } }, { name: 'another frame' }); // other source: dropped
  assert.equal(bridge.pending(), 1);
  deliver({ v: 2, type: 'result', id: call.id, ok: true, output: { pools: [{ id: 'a' }] } });
  assert.deepEqual(await done, { ok: true, output: { pools: [{ id: 'a' }] } });
  assert.throws(() => bridge.call('action', {}), /request_id/);
  const action = bridge.call('action', M.actionBody('write', {}), 'lib-0123456789abcdef');
  assert.equal(posted[2].request_id, 'lib-0123456789abcdef');
  assert.deepEqual(await action, { ok: false, error: { code: 'no_response', message: 'no result from the host' } }, 'a lost answer is unknown, not failed');
  const init = { v: 2, type: 'init', theme: 'dark', locale: 'vi', viewer: { kind: 'operator' }, project: null };
  assert.equal(parseNestMessage({ ...init, tokens: { '--background': '#000' } })?.type, 'init');
  assert.equal(parseNestMessage({ ...init, locale: 'fr', tokens: {} }), null);
  assert.equal(parseNestMessage({ ...init, tokens: { '--font': 'x'.repeat(512) } })?.type, 'init', 'Nest sends tokens up to 512 chars');
  assert.equal(parseNestMessage({ ...init, tokens: {}, project: { id: 'lohi', name: 'Lohi', teams: ['cs'] } })?.project.id, 'lohi');
  assert.equal(parseNestMessage({ ...init, v: 1, tokens: {} }), null, 'a v1 init is dropped');
  assert.equal(parseNestMessage({ v: 2, type: 'init', theme: 'dark', locale: 'vi', tokens: {}, project: null }), null, 'init names the viewer');
  assert.equal(parseNestMessage({ v: 2, type: 'context', project: null })?.type, 'context');
  assert.equal(parseNestMessage({ v: 2, type: 'context', product: null, products: [] }), null, 'a v1 product context is dropped');
  assert.equal(parseNestMessage({ v: 2, type: 'theme', theme: 'light', tokens: { background: '#fff' } }), null, 'token names start with --');
  assert.match(randomID('lib'), REQUEST_ID);
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

test('outcomes: a stale revision is a conflict that keeps the draft; 429 is busy; a lost answer is unknown; a resend replays', () => {
  const conflictOut = { ok: true, output: { status: 'error', code: 'conflict', message: 'revision conflict: document doc-1 changed' } };
  assert.equal(M.classify(conflictOut).state, 'conflict');
  assert.equal(M.classify({ ok: false, error: { code: 'tool_refused', message: 'revision conflict: reload' } }).state, 'conflict');
  assert.equal(M.classify({ ok: true, output: { status: 'error', code: 'rejected', message: 'internal address' } }).state, 'rejected');
  assert.equal(M.classify({ ok: false, error: { code: 'not_authorized', message: 'operator page' } }).state, 'rejected');
  assert.equal(M.classify({ ok: false, error: { code: 'busy', message: 'busy' } }).state, 'busy');
  assert.equal(M.classify({ ok: false, error: { code: 'request_in_flight', message: '' } }).state, 'unknown');
  // A lost answer may follow a write that ran: never 'rejected' (which drops the id).
  for (const code of ['result_unknown', 'unavailable', 'page_call_failed', 'http_502', 'http_500']) {
    assert.equal(M.classify({ ok: false, error: { code, message: 'x' } }).state, 'unknown', code);
  }
  assert.equal(M.classify({ ok: false, error: { code: 'reloading', message: 'x' } }).state, 'busy');
  assert.equal(M.classify({ ok: false, error: { code: 'http_404', message: 'x' } }).state, 'rejected');
  assert.equal(M.classify({ ok: true, output: { status: 'failed', reason: 'x' } }).state, 'failed');
  const receipt = (at) => ({ request_id: 'lib-01234567', status: 'done', at });
  // Replay comes from the host's flag, not from comparing receipt time with the browser clock.
  const fresh = M.classify({ ok: true, output: { status: 'succeeded' }, receipt: receipt(new Date().toISOString()) });
  assert.deepEqual([fresh.state, fresh.replayed], ['done', false]);
  const skewed = M.classify({ ok: true, output: { status: 'succeeded' }, receipt: receipt(new Date(Date.now() - 3600e3).toISOString()) });
  assert.equal(skewed.replayed, false, 'an old-looking receipt time alone is not a replay');
  const flagged = M.classify({ ok: true, output: { status: 'succeeded' }, receipt: { ...receipt(new Date().toISOString()), replayed: true } });
  assert.equal(M.classify({ ok: true, output: { status: 'succeeded' }, replayed: true }).replayed, true, 'top-level form tolerated');
  assert.deepEqual([flagged.state, flagged.replayed], ['done', true]);
  assert.equal(M.classify({ ok: true, output: { status: 'succeeded', replay: true } }).replayed, true);
});

test('a lost response replayed by the same request id saves exactly once', async () => {
  // A host that keeps receipts by request id (soot-pages §3) in front of a service that counts writes.
  const receipts = new Map(); let writes = 0, drop = true;
  const { bridge, posted, deliver } = fakeHost();
  const answer = () => {
    const call = posted.at(-1);
    let output = receipts.get(call.request_id);
    if (!output) { writes++; output = { status: 'succeeded', request_id: call.request_id }; receipts.set(call.request_id, output); }
    else output = { ...output, replay: true };
    if (drop) { drop = false; return; } // the first answer never arrives
    deliver({ v: 2, type: 'result', id: call.id, ok: true, output, receipt: { request_id: call.request_id, status: 'done', at: new Date().toISOString(), ...(output.replay ? { replayed: true } : {}) } });
  };
  const id = randomID('lib');
  const body = M.saveDocument({ pool: 'p', id: 'doc-1', title: 'T', content: 'body', tags: [], revision: 0, generation: 'g' }, id);
  const first = bridge.call('action', body, id); answer();
  assert.equal(M.classify(await first).state, 'unknown');
  const second = bridge.call('action', body, id); answer();
  const c = M.classify(await second);
  assert.deepEqual([c.state, c.replayed, writes], ['done', true, 1]);
  assert.equal(posted.at(-1).request_id, posted.at(-2).request_id);
});

test('draft recovery keeps the request id and metadata only, and survives blocked storage', () => {
  const store = new Map();
  const storage = () => ({ setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k) });
  const body = M.saveDocument({ pool: 'lohi-support', id: 'doc-1', title: 'Bí mật', content: 'NỘI DUNG RIÊNG', tags: [], revision: 7, generation: 'g' }, 'lib-0123456789abcdef');
  const pending = { request_id: 'lib-0123456789abcdef', kind: 'write', action: 'upsert', pool: 'lohi-support', at: '2026-11-01T00:00:00Z', body, token: 'sps_secret' };
  assert.equal(M.remember(storage, pending), true);
  const raw = store.get(M.RECOVERY_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['action', 'at', 'kind', 'pool', 'request_id']);
  assert.doesNotMatch(raw, /NỘI DUNG|Bí mật|sps_|doc-1/);
  assert.deepEqual(M.recall(storage), { request_id: 'lib-0123456789abcdef', kind: 'write', action: 'upsert', pool: 'lohi-support', at: '2026-11-01T00:00:00Z' });
  store.set(M.RECOVERY_KEY, JSON.stringify({ request_id: 'short', kind: 'write', action: 'upsert', pool: 'p' }));
  assert.equal(M.recall(storage), null, 'an invalid record cannot start or replay work');
  store.set(M.RECOVERY_KEY, '{not json');
  assert.equal(M.recall(storage), null);
  assert.equal(M.remember(storage, null), true);
  assert.equal(store.has(M.RECOVERY_KEY), false);
  const blocked = () => { throw new DOMException('denied', 'SecurityError'); };
  assert.equal(M.remember(blocked, pending), false);
  assert.equal(M.recall(blocked), null);
  assert.equal(M.remember(() => undefined, pending), false);
});

test('labels are localized in Vietnamese and English with the same keys; titles and readers read as people see them', () => {
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.vi).sort());
  assert.equal(strings('en').title, 'Library');
  assert.equal(strings('fr').title, 'Kho tài liệu');
  assert.equal(docTitle('soot://radar/radar-2026-10-14.md'), 'Radar 2026-10-14');
  assert.equal(docTitle('', ''), 'Tài liệu chưa đặt tên');
  assert.deepEqual(readerIds({ host_managers: ['lead'], bound_soots: ['a', 'b'], grants: { a: 'read' }, effective_group_grants: { cs: 'read' }, groups: { cs: ['c'] } }).sort(), ['a', 'c', 'lead']);
});

test('the shipped classic app.js is the current build of src/ and parses as a classic script', async () => {
  const built = await build();
  assert.equal(await readFile(new URL('app.js', page), 'utf8'), built, 'run node packs/data-pool-console/page/tests/build.mjs');
  assert.doesNotThrow(() => new Function(built));
});

test('B20: behind a host the draft record rides draft.get/set/clear; sessionStorage is the fallback only without a bridge', async () => {
  const calls = [];
  let held = null;
  const io = async (kind, value) => {
    calls.push(kind);
    if (kind === 'draft.set') { held = value; return { ok: true, output: { saved: true } }; }
    if (kind === 'draft.clear') { held = null; return { ok: true, output: { cleared: true } }; }
    return { ok: true, output: { value: held } };
  };
  const throwing = () => { throw new DOMException('denied', 'SecurityError'); };
  const pending = { request_id: 'lib-0123456789abcdef', kind: 'write', action: 'upsert', pool: 'lohi-support', at: '2026-11-01T00:00:00Z', body: { secret: 'NỘI DUNG' } };
  assert.equal(await M.rememberDraft(io, throwing, pending), true, 'a blocked sessionStorage does not matter behind a host');
  assert.deepEqual(Object.keys(held).sort(), ['action', 'at', 'kind', 'pool', 'request_id']);
  assert.deepEqual(await M.recallDraft(io, throwing), M.recoveryRecord(pending));
  held = { request_id: 'short' };
  assert.equal(await M.recallDraft(io, throwing), null, 'an invalid record cannot start work');
  assert.equal(await M.rememberDraft(io, throwing, null), true);
  assert.deepEqual(calls, ['draft.set', 'draft.get', 'draft.get', 'draft.clear']);
  const refusing = async () => ({ ok: false });
  assert.equal(await M.rememberDraft(refusing, throwing, pending), false);
  const store = new Map();
  const storage = () => ({ setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k) });
  assert.equal(await M.rememberDraft(undefined, storage, pending), true);
  assert.deepEqual(await M.recallDraft(undefined, storage), M.recoveryRecord(pending));
});

test('E6: the page has no h1 of its own (Nest owns it) and B21: it declares the knowledge capability', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8') + readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /h\('h1'|<h1/);
  const pack = JSON.parse(readFileSync(new URL('../../pack.json', import.meta.url), 'utf8'));
  const piece = pack.interface.pieces[0];
  assert.deepEqual([piece.slot, piece.provides], ['data.tab', ['knowledge']]);
});
