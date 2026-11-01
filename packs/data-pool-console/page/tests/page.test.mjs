// Kho tài liệu page bundle: bridge v1, request bodies, outcomes and draft recovery.
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
  assert.deepEqual(M.requestStatus('kho-0123456789abcdef01234567'), bodies[3].input);
});

test('the declaration matches soot-pages: data page, operator, read view tool and action tool on stdin context', () => {
  const [p] = pack.interface.pages;
  assert.deepEqual({ id: p.id, placement: p.placement, access: p.access, bundle: p.bundle }, { id: 'kho-tai-lieu', placement: 'data', access: 'operator', bundle: 'page/' });
  assert.equal(pack.interface.tool_area, undefined, 'the tool area is replaced by the page');
  assert.equal(tool(p.view_tool).run.mode, 'read');
  assert.equal(tool(p.view_tool).run.stdin, 'context');
  assert.equal(tool(p.action_tool).run.stdin, 'context');
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

test('bridge v1: calls carry only v/type/id/mode/input/request_id; results route by id; foreign or malformed messages are dropped', async () => {
  const { bridge, posted, deliver } = fakeHost();
  bridge.ready();
  assert.deepEqual(posted[0], { v: 1, type: 'ready' });
  const done = bridge.call('view', M.listPools());
  const call = posted[1];
  assert.deepEqual(Object.keys(call).sort(), ['id', 'input', 'mode', 'type', 'v']);
  assert.ok(call.id.length <= 64);
  deliver({ v: 1, type: 'result', id: call.id, ok: true, output: { pools: [] }, soot: 'x' }); // extra key: dropped
  deliver({ v: 2, type: 'result', id: call.id, ok: true, output: { pools: [] } }); // other version: dropped
  deliver({ v: 1, type: 'result', id: call.id, ok: true, output: { pools: [] } }, { name: 'another frame' }); // other source: dropped
  assert.equal(bridge.pending(), 1);
  deliver({ v: 1, type: 'result', id: call.id, ok: true, output: { pools: [{ id: 'a' }] } });
  assert.deepEqual(await done, { ok: true, output: { pools: [{ id: 'a' }] } });
  assert.throws(() => bridge.call('action', {}), /request_id/);
  const action = bridge.call('action', M.actionBody('write', {}), 'kho-0123456789abcdef');
  assert.equal(posted[2].request_id, 'kho-0123456789abcdef');
  assert.deepEqual(await action, { ok: false, error: { code: 'no_response', message: 'no result from the host' } }, 'a lost answer is unknown, not failed');
  assert.equal(parseNestMessage({ v: 1, type: 'init', theme: 'dark', locale: 'vi', tokens: { '--background': '#000' } })?.type, 'init');
  assert.equal(parseNestMessage({ v: 1, type: 'init', theme: 'dark', locale: 'fr', tokens: {} }), null);
  assert.equal(parseNestMessage({ v: 1, type: 'theme', theme: 'light', tokens: { background: '#fff' } }), null, 'token names start with --');
  assert.match(randomID('kho'), REQUEST_ID);
});

test('outcomes: a stale revision is a conflict that keeps the draft; 429 is busy; a lost answer is unknown; a resend replays', () => {
  const conflictOut = { ok: true, output: { status: 'error', code: 'conflict', message: 'revision conflict: document doc-1 changed' } };
  assert.equal(M.classify(conflictOut).state, 'conflict');
  assert.equal(M.classify({ ok: false, error: { code: 'tool_refused', message: 'revision conflict: reload' } }).state, 'conflict');
  assert.equal(M.classify({ ok: true, output: { status: 'error', code: 'rejected', message: 'internal address' } }).state, 'rejected');
  assert.equal(M.classify({ ok: false, error: { code: 'not_authorized', message: 'operator page' } }).state, 'rejected');
  assert.equal(M.classify({ ok: false, error: { code: 'busy', message: 'busy' } }).state, 'busy');
  assert.equal(M.classify({ ok: false, error: { code: 'request_in_flight', message: '' } }).state, 'unknown');
  assert.equal(M.classify({ ok: true, output: { status: 'failed', reason: 'x' } }).state, 'failed');
  const fresh = M.classify({ ok: true, output: { status: 'succeeded' }, receipt: { request_id: 'kho-01234567', status: 'done', at: new Date().toISOString() } }, Date.now());
  assert.deepEqual([fresh.state, fresh.replayed], ['done', false]);
  const old = M.classify({ ok: true, output: { status: 'succeeded' }, receipt: { request_id: 'kho-01234567', status: 'done', at: new Date(Date.now() - 60000).toISOString() } }, Date.now());
  assert.deepEqual([old.state, old.replayed], ['done', true]);
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
    deliver({ v: 1, type: 'result', id: call.id, ok: true, output });
  };
  const id = randomID('kho');
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
  const body = M.saveDocument({ pool: 'lohi-support', id: 'doc-1', title: 'Bí mật', content: 'NỘI DUNG RIÊNG', tags: [], revision: 7, generation: 'g' }, 'kho-0123456789abcdef');
  const pending = { request_id: 'kho-0123456789abcdef', kind: 'write', action: 'upsert', pool: 'lohi-support', at: '2026-11-01T00:00:00Z', body, token: 'sps_secret' };
  assert.equal(M.remember(storage, pending), true);
  const raw = store.get(M.RECOVERY_KEY);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['action', 'at', 'kind', 'pool', 'request_id']);
  assert.doesNotMatch(raw, /NỘI DUNG|Bí mật|sps_|doc-1/);
  assert.deepEqual(M.recall(storage), { request_id: 'kho-0123456789abcdef', kind: 'write', action: 'upsert', pool: 'lohi-support', at: '2026-11-01T00:00:00Z' });
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
