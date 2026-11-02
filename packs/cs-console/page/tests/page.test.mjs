// Khách hàng page bundle: the declaration, bodies that pass the tools'
// parameters, outcomes that keep the request id while an answer is unknown,
// and a bundle that never fetches. tests/ is not shipped in the pack archive.
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

test('the declaration is a member rail page on a read view tool and a write action tool; storage keeps only tags, notes and links by principal', () => {
  const [p] = pack.interface.pages;
  assert.deepEqual({ id: p.id, placement: p.placement, access: p.access, bundle: p.bundle, vi: p.label.vi }, { id: 'khach-hang', placement: 'rail', access: 'member', bundle: 'page/', vi: 'Khách hàng' });
  assert.equal(tool(p.view_tool).run.mode, 'read');
  assert.equal(tool(p.action_tool).run.mode, 'write', 'storage writes need a write-mode token');
  for (const t of pack.tools) { assert.equal(t.run.stdin, 'context'); assert.equal(t.approval, undefined, 'pages refuse approval-gated tools'); }
  assert.deepEqual(pack.storage.tables.map(t => t.name), ['tags', 'notes', 'links', 'proofs']);
  for (const t of pack.storage.tables.filter(t => t.name !== 'proofs')) assert.equal(t.columns.find(c => c.name === 'sub').principal, true, t.name);
  // Used proof ids only (no person in them): kept past an unlink so a proof is never replayed.
  assert.deepEqual(pack.storage.tables.find(t => t.name === 'proofs').columns.map(c => [c.name, !!c.principal]), [['jti', false], ['kid', false]]);
  assert.equal(pack.storage.tables.find(t => t.name === 'links').columns.find(c => c.name === 'alias').principal, true);
});

test('every body the page builds passes the tool parameters; writes carry the stable request id', () => {
  const ajv = new Ajv2020({ strict: false });
  const view = ajv.compile(tool('console_view').parameters), action = ajv.compile(tool('console_action').parameters);
  for (const body of [M.listBody(), M.listBody(' Khoa '), M.detailBody('lohi:u-1001')]) assert.ok(view(body), JSON.stringify(view.errors));
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
    listeners.forEach(h => h({ v: 1, type: 'result', id: call.id, ok: true, output: receipts.get(call.request_id), receipt: { request_id: call.request_id, status: 'done', at: new Date().toISOString(), ...(replayed ? { replayed: true } : {}) }, ...(replayed ? { replayed: true } : {}) }, parent));
  };
  const id = randomID('cs', 12), body = M.actionBody(id, M.tagBody('lohi:u-1', 'VIP'));
  const first = bridge.call('action', body, id); answer();
  assert.equal(M.classify(await first).state, 'unknown');
  const second = bridge.call('action', body, id); answer();
  const c = M.classify(await second);
  assert.deepEqual([c.state, c.replayed, writes], ['done', true, 1]);
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

test('the shipped classic app.js is the current build of src/ and parses as a classic script', async () => {
  const built = await build();
  assert.equal(await readFile(new URL('app.js', page), 'utf8'), built, 'run node packs/cs-console/page/tests/build.mjs');
  assert.doesNotThrow(() => new Function(built));
});
