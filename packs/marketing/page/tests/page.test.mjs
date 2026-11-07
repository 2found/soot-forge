// Bài viết / Hàng đợi bundle: bodies that pass the page tools' parameters,
// "no data" never shown as 0, links through the bridge, and a bundle that never
// fetches and is the current build. tests/ is not shipped in the pack archive.
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

test('every body the page builds passes the page tool parameters; writes carry a stable request id', () => {
  const ajv = new Ajv2020({ strict: false });
  const view = ajv.compile(tool('page_view').parameters), action = ajv.compile(tool('page_action').parameters);
  for (const body of [M.viewBody(), M.viewBody('published'), M.viewBody('all', 'P-0123456789')]) assert.ok(view(body), JSON.stringify(view.errors));
  const id = randomID('mk', 12);
  assert.match(id, REQUEST_ID);
  for (const [op, rest] of [['pull', { id: 'P-0123456789' }], ['restore', { id: 'P-0123456789' }], ['unpublish', { id: 'P-0123456789' }], ['pause', {}], ['resume', {}], ['pause', { channel: 'blog-lohi' }]]) {
    const body = M.actionBody(id, op, rest);
    assert.ok(action(body), JSON.stringify(action.errors));
    assert.equal(body.request_id, id);
  }
});

test('no Search Console data reads "Chưa có số liệu", never 0; numbers use vi-VN', () => {
  const t = M.strings('vi');
  assert.equal(M.metricLine(null, t), 'Chưa có số liệu');
  assert.equal(M.num(null), null);
  assert.equal(M.num(0), '0', 'a real zero after a read stays 0');
  assert.match(M.metricLine({ impressions: 1200, clicks: 8, position: 8.25 }, t), /^1\.200 lượt hiển thị · 8 lượt bấm · vị trí 8,3/);
  assert.equal(M.strings('en').noData, 'No data yet');
});

test('a tool error in the output is thrown with its code; a lost answer reads as unknown', () => {
  assert.throws(() => M.output({ ok: true, output: { error: { code: 'not_found', message: 'x' } } }), e => e.code === 'not_found');
  assert.deepEqual(M.output({ ok: true, output: { page: 'hang-doi' } }), { page: 'hang-doi' });
  const t = M.strings('vi');
  assert.equal(M.errorText(t, { code: 'no_response' }), t.unknown);
  assert.equal(M.errorText(t, { code: 'x', message: 'Không có bài này.' }), t.failed + 'Không có bài này.');
});

test('links open through the bridge; the frame never navigates and drops anything but https', () => {
  const posted = [];
  const bridge = createBridge({ post: m => posted.push(m), listen: () => {}, parent: {} });
  bridge.open('https://blog.lohi2.com/truyen-hay/a/vi/');
  bridge.open('javascript:alert(1)');
  bridge.open('http://example.com');
  assert.deepEqual(posted.filter(m => m.type === 'open'), [{ v: 1, type: 'open', link: 'https://blog.lohi2.com/truyen-hay/a/vi/' }]);
});

test('the bundle makes no network call, sets text only and has no inline script, form or modal', async () => {
  const files = [...(await readdir(page)), ...(await readdir(new URL('src/', page))).map(n => 'src/' + n)];
  for (const name of files) {
    if (!/\.(js|html|css)$/.test(name)) continue;
    const text = await readFile(new URL(name, page), 'utf8');
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(\s*['"]https?:/, name);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, name);
    assert.doesNotMatch(text, /h\('form'|<form|<a\b|h\('a'|\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/, name);
    if (name.endsWith('.html')) assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i, name);
  }
});

test('the shipped classic app.js is the current build of src/ and parses as a classic script', async () => {
  const built = await build();
  assert.equal(await readFile(new URL('app.js', page), 'utf8'), built, 'run node packs/marketing/page/tests/build.mjs');
  assert.doesNotThrow(() => new Function(built));
});
