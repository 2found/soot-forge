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
  assert.equal(M.doneNotice(t, 'wat', {}).text, 'Đã lưu.');
  assert.match(M.doneNotice(t, 'pause', {}).text, /^Đã dừng\./);
});

test('every next-step code reads as one plain sentence; a quiet one has no button, a blocked one has the button that fixes it', () => {
  const quiet = ['draft', 'unpublishing', 'in_flight', 'waiting', 'scheduled', 'channel_held'];
  const fix = { refused: 'ask_writer', ready: 'schedule', pulled: 'restore', removed: 'restore', uncertain: 'confirm', failed_retry: 'retry', failed: 'retry', late: 'post_now', paused_all: 'resume_all', signed_out: 'sign_in', signed_in: 'resume_channel', person_paused: 'resume_channel', draft_stale: 'ask_writer' };
  const at = '2026-11-10T03:00:00Z';
  for (const code of [...quiet, ...Object.keys(fix)]) {
    const l = M.nextLine({ code, at, channel: 'X', reason: 'lý do', channel_id: 'x-lohi' }, {});
    assert.ok(l.text.length > 10, code);
    assert.doesNotMatch(l.text, /[{}_]|undefined|null|Kamaji|PRODUCT_/, code);
    if (quiet.includes(code)) assert.equal(l.button, undefined, code); else assert.equal(l.button.do, fix[code], code);
  }
  assert.equal(M.nextLine({ code: 'published' }, { url: 'https://lohi2.com/x' }).button.do, 'open');
  assert.equal(M.nextLine({ code: 'published' }, {}).button, undefined, 'no link: it says so, no dead button');
  assert.equal(M.nextLine(null), null);
});

test('Hàng đợi headline: the one blocker wins, otherwise "Không cần làm gì" with what is next', () => {
  const ch = [{ id: 'x-lohi', label: 'X', paused: true, paused_reason: 'signed_out', waiting: 2 }];
  assert.equal(M.queueHeadline({ paused_all: true, items: [{}], channels: [] }).button.do, 'resume_all');
  assert.match(M.queueHeadline({ items: [{ state: 'uncertain' }], channels: [] }).text, /Đã lên hoặc Chưa lên/);
  assert.match(M.queueHeadline({ items: [{ late: true }], channels: [] }).text, /lỡ giờ/);
  const so = M.queueHeadline({ items: [], channels: ch });
  assert.deepEqual([so.button.do, so.button.channel], ['sign_in', 'x-lohi']);
  const ok = M.queueHeadline({ items: [{ action: 'publish', channel: 'Blog', scheduled_at: '2026-11-10T03:00:00Z' }], channels: [] });
  assert.match(ok.text, /^Không cần làm gì, Soot đang tự chạy/);
  assert.equal(M.queueHeadline({ items: [], channels: [], writer: 'lohi-writer' }).button.do, 'ask_writer');
});

test('a channel row names its state and carries its button; a signed-out channel is never just a switch', () => {
  const c = { id: 'x-lohi', label: 'X', paused: true, paused_reason: 'signed_out', waiting: 1, posts_today: 0, cap_per_day: 4, reply_cap_per_day: 10, replies_today: 0 };
  const l = M.channelLine(c, {});
  assert.equal(l.button.do, 'sign_in');
  assert.match(l.text, /Chưa đăng nhập X, 1 bài đang chờ/);
  assert.equal(M.channelLine({ ...c, paused: false }, {}).tone, 'ok');
  assert.equal(M.channelLine({ ...c, paused_reason: 'person' }, {}).button.do, 'resume_channel');
  assert.match(M.channelLine({ ...c, paused: false }, { paused_all: true }).text, /dừng mọi kênh/);
  assert.equal(M.signInLink('lohi-editor'), 'nest://browser/lohi-editor');
  assert.equal(M.signInLink(null), 'nest://settings/setup');
});

test('limits: a form body only carries what changed, refuses out-of-range in Vietnamese, and the confirm line says from → to; the body passes set_limits', () => {
  const ajv = new Ajv2020({ strict: false });
  const action = ajv.compile(tool('page_action').parameters);
  const c = { label: 'X', cap_per_day: 4, spacing_min: 180, reply_cap_per_day: 10 };
  const body = M.limitsBody(c, { cap: '6', gap: '3', rep: '10' });
  assert.deepEqual(body, { cap_per_day: 6 });
  assert.match(M.limitsAsk(c, body), /bài mỗi ngày 4 → 6/);
  assert.ok(action(M.actionBody('mk-123456789012', 'set_limits', { channel: 'x-lohi', ...body })), JSON.stringify(action.errors));
  assert.match(M.limitsBody(c, { cap: '99', gap: '3', rep: '1' }), /từ 0 đến 50/);
  assert.match(M.limitsBody(c, { cap: '1', gap: '999', rep: '1' }), /từ 0 đến 168/);
  assert.deepEqual(M.limitsBody(c, { cap: '4', gap: '3', rep: '10' }), {});
});

test('a failing action shows its inline fix: needs_credential becomes a message with the Thiết lập link, not a raw error', () => {
  const r = { ok: true, output: { ok: false, reason_code: 'needs_credential', key: 'PRODUCT_ADMIN_KEY', link: 'nest://settings/setup', error: { code: 'needs_credential', message: 'Chiến dịch cần khoá API của Lohi để tạo liên kết. Mở Thiết lập để nhập PRODUCT_ADMIN_KEY (nest://settings/setup).' } } };
  let err; try { M.output(r); } catch (e) { err = e; }
  assert.ok(err, 'throws');
  assert.equal(err.link, 'nest://settings/setup');
  const text = M.errorText(M.strings('vi'), err);
  assert.match(text, /^Chiến dịch cần khoá API của Lohi để tạo liên kết\. Bấm Mở Thiết lập, điền "Khoá quản trị Lohi" rồi Thử lại\.$/);
  assert.doesNotMatch(text, /PRODUCT_ADMIN_KEY|nest:\/\//, 'no env key or raw link in the founder text');
});

test('markdown body: headings, lists, bold and https links become blocks; no HTML survives', () => {
  const b = M.mdBlocks('# Tiêu đề\n\nĐoạn **đậm** và [liên kết](https://lohi2.com/x).\n\n- một\n- hai <script>alert(1)</script>');
  assert.deepEqual(b.map(x => x.t), ['h', 'p', 'li', 'li']);
  assert.deepEqual(b[1].parts.map(p => p.href ?? p.b ?? null), [null, true, null, 'https://lohi2.com/x', null]);
  assert.equal(M.mdBlocks('[x](javascript:alert(1))')[0].parts.every(p => !p.href), true);
});

test('a runtime refusal in English reads as one Vietnamese sentence with the way out', () => {
  const text = M.errorText(M.strings('vi'), { code: 'tool_refused', message: "input does not match operation parameters: at '/id': bad (refused)" });
  assert.match(text, /^Trang gửi một yêu cầu không hợp lệ/);
  assert.doesNotMatch(text, /operation parameters/);
});

test('a dialog sits above its scrim, or every click on its buttons only closes it', async () => {
  const css = await readFile(new URL('app.css', page), 'utf8');
  const z = sel => Number(new RegExp(`${sel.replace('.', '\\.')} \\{[^}]*z-index: (\\d+)`).exec(css)?.[1] ?? 0);
  assert.ok(z('.dialog') > z('.scrim'), `dialog ${z('.dialog')} vs scrim ${z('.scrim')}`);
  assert.ok(z('.sheet') > z('.scrim'), 'the campaign sheet sits above its scrim too');
});
