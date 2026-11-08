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

test('Chiến dịch: the sheet sends a campaign_save body the tool accepts, and says what is missing first', () => {
  const ajv = new Ajv2020({ strict: false });
  const action = ajv.compile(tool('page_action').parameters), save = ajv.compile(tool('campaign_save').parameters), view = ajv.compile(tool('page_view').parameters);
  const f = M.newCampaign([{ id: 'blog-lohi' }, { id: 'x-lohi' }]);
  assert.equal(M.campaignProblem(f), 'Điền tên và ngày để tạo.');
  Object.assign(f, { name: 'Lohi tháng 12: truyện mới', starts: '2026-12-01', ends: '2026-12-31', target: '300', budget: '2.000.000' });
  assert.equal(M.slugOf(f.name), 'lohi-thang-12-truyen-moi');
  assert.equal(M.campaignProblem(f), null);
  assert.equal(M.campaignProblem({ ...f, ends: '2026-11-30' }), 'Ngày kết thúc phải từ ngày bắt đầu trở đi.');
  assert.equal(M.campaignProblem({ ...f, channels: [] }), 'Chọn ít nhất một kênh.');
  assert.equal(M.campaignProblem({ ...f, target: '0' }), 'Mục tiêu là một số lớn hơn 0.');
  const body = M.campaignBody(f);
  assert.deepEqual(body, { name: 'Lohi tháng 12: truyện mới', goal: { metric: 'signups', target: 300 }, channels: ['blog-lohi', 'x-lohi'], starts: '2026-12-01', ends: '2026-12-31', token_budget: 2_000_000 });
  assert.ok(save(body), JSON.stringify(save.errors));
  assert.ok(action(M.actionBody(randomID('mk', 12), 'campaign_save', { campaign: body })), JSON.stringify(action.errors));
  assert.ok(action(M.actionBody(randomID('mk', 12), 'campaign_refresh', { campaign_id: 'lohi-thang-12-truyen-moi' })));
  assert.ok(view(M.viewBody('all', '', 'lohi-thang-12-truyen-moi')));
  assert.deepEqual(M.viewBody('all', '', 'c-1'), { campaign: 'c-1' });
});

test('Chiến dịch numbers: unread is —, never 0; the failure line keeps the Soot numbers', () => {
  assert.equal(M.goalLine({ metric: 'signups', target: 300, value: 126 }), '126 / 300 người đăng ký');
  assert.equal(M.goalLine({ metric: 'signups', target: 300, value: null }), '— / 300 người đăng ký');
  assert.equal(M.goalPct({ target: 300, value: 126 }), 42);
  assert.equal(M.goalPct({ target: 300, value: null }), null);
  assert.equal(M.tokenLine(820000, 2000000), 'Token đã dùng: 820.000 / 2.000.000 (41%).');
  assert.equal(M.dayRange('2026-11-30T17:00:00.000Z', '2026-12-31T16:59:59.000Z'), '1/12 – 31/12');
  assert.equal(M.readFailLine({ at: '2026-12-05T00:00:00Z', error: { message: 'api.lohi2.com không trả lời.' } }),
    'api.lohi2.com không trả lời lúc 07:00. Số bài, tiếp cận dưới đây là của Soot; đăng ký và lượt bấm sẽ cập nhật ở lần đọc tới.');
});

test('a campaign re-read says it read again, and a failed one leaves the page its notice', () => {
  const t = M.strings('vi');
  assert.deepEqual(M.doneNotice(t, 'campaign_refresh', { read: { ok: true } }), { kind: 'success', text: 'Đã đọc lại số.' });
  assert.equal(M.doneNotice(t, 'campaign_refresh', { read: { ok: false, error: { code: 'api_unreachable' } } }), null);
  assert.deepEqual(M.doneNotice(t, 'pause', {}), { kind: 'success', text: 'Đã lưu.' });
});
