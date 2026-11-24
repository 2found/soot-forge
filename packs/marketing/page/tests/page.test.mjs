// The Marketing desk piece: bodies the page tools accept, "—" and a reason
// for anything not measured, approving only through Nest's own card, writes
// from a press with a request id kept across a lost answer, a bundle that
// never fetches, sets text only and is the current build, and every tab and
// sheet drawn from real page_view answers. tests/ is not shipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import * as M from '../src/model.js';
import { ICONS } from '../src/icons.js';
import { build } from './build.mjs';
import { mount, text } from './fake-dom.mjs';
import { world, saved, T0 } from '../../tests/desk-world.mjs';

const page = new URL('../', import.meta.url);
const pack = JSON.parse(await readFile(new URL('../../pack.json', import.meta.url), 'utf8'));
const tool = (name) => pack.tools.find(t => t.name === name);
const ajv = new Ajv2020({ strict: false });
const viewOK = ajv.compile(tool('page_view').parameters);
const actionOK = ajv.compile(tool('page_action').parameters);
const H = 3600_000;

test('every view body the page builds passes page_view, approvals included; extra approval keys are dropped', () => {
  const approvals = M.compactApprovals({ approvals: [
    { id: 'ap-1', state: 'pending', tool: 'publish_bundle', ref: 'MK-ABC123', created_at: '2026-11-24T00:00:00Z', expires_at: '2026-11-25T00:00:00Z', extra: 'x' },
    { id: 'ap-2', state: 'pending', tool: 'publish_bundle', created_at: '2026-11-24T00:00:00Z' },
    { id: 'ap-3', state: 'rejected', tool: 'publish_bundle', ref: 'MK-ABC124', reason: 'r'.repeat(900), decided_at: '2026-11-24T01:00:00Z' },
  ], total: 3 });
  assert.deepEqual(approvals.map(a => a.id), ['ap-1', 'ap-3'], 'a row with no ref names no item');
  assert.equal(approvals[0].extra, undefined);
  assert.equal(approvals[1].reason.length, 500);
  assert.equal(M.compactApprovals({ approvals: Array.from({ length: 140 }, (_, i) => ({ id: `a${i}`, state: 'pending', ref: 'MK-ABC123' })) }).length, 100);
  const bodies = [
    M.viewBody('summary', {}, approvals), M.viewBody('today', { product: 'acme' }, approvals), M.viewBody('content', { stage: 'approval', cursor: '30' }, null),
    M.viewBody('item', { ref: 'MK-ABC123' }), M.viewBody('item', { ref: 'P-0123456789' }), M.viewBody('channels'), M.viewBody('channel', { key: 'acme:x' }),
    M.viewBody('library', { node: 'radar:acme-video/2026-11-23' }), M.viewBody('library', { node: 'other' }), M.viewBody('numbers', { week: '2026-W47' }),
  ];
  for (const b of bodies) assert.ok(viewOK(b), `${JSON.stringify(b)} ${JSON.stringify(viewOK.errors)}`);
  assert.equal(M.viewBody('content', { stage: undefined, product: null }).stage, undefined);
});

test('every action body passes page_action and carries the request id the call is sent under', () => {
  const rid = M.requestId('mk');
  assert.match(rid, M.REQUEST_ID);
  const ops = [
    ['stop', { ref: 'MK-ABC123' }], ['pause', { scope: 'all' }], ['resume', { scope: 'channel', channel: 'acme:x' }],
    ['rules', { channel: 'acme:x', cap_per_day: 3, spacing_min: 90, quiet: { from: '23:00', to: '07:00' }, max_len: 280 }],
    ['rules', { channel: 'acme:blog', cap_per_day: 1, spacing_min: 0, quiet: null }],
    ['confirm', { ref: 'MK-ABC123', outcome: 'posted', url: 'https://x.com/acmehq/status/123', channel: 'x', lang: 'vi' }],
    ['confirm', { ref: 'MK-ABC123', outcome: 'not_posted', channel: 'x', lang: 'vi' }],
    ['mark', { file: 'channels/acme-video/radar/2026-11-23.md', row: 2, onboard: null }],
    ['create', { product: 'acme', format: 'video', topic: 'Vì sao bộ này hay', channels: ['tiktok'], series: 'hay' }],
  ];
  for (const [op, f] of ops) {
    const body = M.actionBody(op, { ...f, unused: undefined }, rid);
    assert.ok(actionOK(body), `${op} ${JSON.stringify(actionOK.errors)}`);
    assert.equal(body.request_id, rid);
    assert.equal('unused' in body, false);
  }
  assert.equal(M.intentKey('stop', { ref: 'MK-ABC123' }), M.intentKey('stop', { ref: 'MK-ABC123' }));
  assert.notEqual(M.intentKey('stop', { ref: 'MK-ABC123' }), M.intentKey('stop', { ref: 'MK-ABC124' }));
});

test('nothing measured reads "—" with a reason, never 0; a real zero stays 0', () => {
  assert.equal(M.num(null), '—');
  assert.equal(M.num(undefined), '—');
  assert.equal(M.num(0), '0');
  assert.equal(M.num(12345), '12.345');
  for (const why of ['hub', 'hubless', 'approvals_unread', 'search_console_not_connected', 'something_new']) {
    const t = M.tileText({ id: 'reads', value: null, why }, { now: T0, products: {}, product: null });
    assert.equal(t.tone, 'blind');
    assert.doesNotMatch(t.value, /\d/, `${why}: a blind tile shows no number`);
    assert.ok(t.sub, `${why}: a blind tile says why`);
  }
  for (const why of ['hubless', 'hub', 'search_console_not_connected', 'signed_out', 'not_read_yet', 'no_metrics_file']) assert.ok(M.whyText(why, {}), why);
  assert.match(M.whyText('no_posted_links', { n: 2 }), /2/);
});

test('a tool error is thrown with its code; a lost answer keeps the request id; every code has words', () => {
  assert.throws(() => M.output({ error: { code: 'bad_url', message: 'x' } }), e => e.code === 'bad_url');
  assert.deepEqual(M.output({ ok: true }), { ok: true });
  for (const code of ['timeout', 'result_unknown', 'request_in_flight', 'no_response']) assert.ok(M.unknownOutcome({ code }), code);
  for (const code of ['request_id_reused', 'bad_url', 'gesture_required', 'not_found']) assert.equal(M.unknownOutcome({ code }), false, code);
  for (const code of ['invalid_request', 'not_found', 'conflict', 'bad_url', 'needs_credential', 'hub_refused', 'approval_required', 'gesture_required', 'unsupported', 'no_host', 'timeout']) {
    assert.notEqual(M.errorText({ code }), M.errorText({ code: 'never-heard-of-it' }), code);
  }
});

test('links: only https leaves the page; a posted link must be the channel\'s own address', () => {
  assert.equal(M.safeLink('https://acme.example/a'), 'https://acme.example/a');
  for (const bad of ['http://acme.example', 'javascript:alert(1)', 'nest://browser', 'https://', null, 42]) assert.equal(M.safeLink(bad), null, String(bad));
  assert.ok(M.validUrl('x', 'https://x.com/acmehq/status/1234567890'));
  assert.ok(M.validUrl('tiktok', 'https://www.tiktok.com/@acme/video/7707307745841581332'));
  assert.equal(M.validUrl('x', 'https://x.com/acmehq'), false);
  assert.equal(M.validUrl('tiktok', 'https://evil.example/@acme/video/1'), false);
  assert.equal(M.profileUrl('x', '@acmehq'), 'https://x.com/acmehq');
});

test('every icon the page names exists; markdown is shown as text blocks', async () => {
  const src = (await readFile(new URL('src/app.js', page), 'utf8')) + (await readFile(new URL('src/model.js', page), 'utf8'));
  const names = new Set([...src.matchAll(/\b(?:ic|icon)\(\s*'(\w+)'/g), ...src.matchAll(/\bicon: '(\w+)'/g), ...src.matchAll(/\bsq\([^,()]+, '(\w+)'\)/g)].map(m => m[1]));
  for (const n of Object.values(M.NODE_ICON)) names.add(n);
  for (const n of names) assert.ok(ICONS.includes(n), `icon ${n}`);
  const b = M.blocks('# Tiêu đề\n\nĐoạn **đậm** có [link](https://a.example).\n\n- một\n- hai\n\n<script>x</script>', 10);
  assert.deepEqual(b.map(x => x.kind), ['h', 'p', 'li', 'li', 'p']);
  assert.ok(b.every(x => !/[*[\]]/.test(x.text)), JSON.stringify(b));
});

test('the bundle never fetches, sets text only, has no inline script, style attribute, form or anchor, and links the kit', async () => {
  const files = [...(await readdir(page)), ...(await readdir(new URL('src/', page))).map(n => 'src/' + n)].filter(n => /\.(js|html|css)$/.test(n));
  assert.deepEqual(files.sort(), ['app.js', 'desk.css', 'index.html', 'src/app.js', 'src/icons.js', 'src/model.js']);
  for (const name of files) {
    const t = await readFile(new URL(name, page), 'utf8');
    assert.doesNotMatch(t, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(/, name);
    assert.doesNotMatch(t, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/, name);
    assert.doesNotMatch(t, /h\('form'|<form|<a\b|h\('a'|\b(?:window\.)?(?:alert|confirm|prompt)\s*\(|\.style\./, name);
    assert.doesNotMatch(t, /nest:\/\/browser\b/, `${name}: browser sign-in opens nest://settings/browser`);
    assert.doesNotMatch(t, /2found|2novel|lohi|trysoot/i, `${name}: the page is product-neutral`);
  }
  const html = await readFile(new URL('index.html', page), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);
  for (const f of ['_kit/piece.css', 'desk.css', '_kit/piece.js', 'app.js']) assert.match(html, new RegExp(`"${f.replace('.', '\\.')}"`), f);
  assert.ok(html.indexOf('_kit/piece.js') < html.indexOf('"app.js"'), 'the kit loads before the app');
  const css = await readFile(new URL('desk.css', page), 'utf8');
  const bare = css.replace(/var\(--[\w-]+, #[0-9a-f]{3,8}\)/gi, '').replace(/#000 85%/g, '');
  assert.deepEqual(bare.match(/#[0-9a-f]{3,8}\b/gi), null, 'colours come from tokens; a hex is only a var() fallback (and the #000 of a mask)');
  const links = new Set([...(await readFile(new URL('src/app.js', page), 'utf8')).matchAll(/['`](nest:\/\/[^'`$]*)/g)].map(m => m[1]));
  // Phase 2 adds the Lead composer (a draft, never sent), the team's Quyền sheet and a pre-test's report.
  assert.deepEqual([...links].sort(), ['nest://conversation/', 'nest://needs', 'nest://needs/approve/', 'nest://new?text=', 'nest://settings/browser', 'nest://settings/setup?key=MARKETING_HUB', 'nest://settings/setup?key=MARKETING_ROOT', 'nest://team/'].sort());
});

test('the shipped app.js is the current build of src/ and parses as a classic script', async () => {
  const built = await build();
  assert.equal(await readFile(new URL('app.js', page), 'utf8'), built, 'run node packs/marketing/page/tests/build.mjs');
  assert.doesNotThrow(() => new Function(built));
});

// ---------- drawn from real answers ----------

const script = await readFile(new URL('app.js', page), 'utf8');
const BAD_TEXT = /undefined|NaN|\[object|null\b|Invalid Date/;
/** A desk over a desk world: views and actions run page_view / page_action; approvals come from `approvals`. */
async function desk(w, { approvals = [], approvalsFail = null } = {}) {
  const d = mount(script, async ({ mode, input, opts }) => {
    if (mode === 'view' && input === 'approvals') {
      if (approvalsFail) throw Object.assign(new Error('x'), { code: approvalsFail });
      return { approvals, total: approvals.length };
    }
    if (mode === 'view') { assert.ok(viewOK(input), `${JSON.stringify(input)} ${JSON.stringify(viewOK.errors)}`); return w.view(input); }
    if (mode === 'action') {
      assert.ok(actionOK(input), `${JSON.stringify(input)} ${JSON.stringify(actionOK.errors)}`);
      assert.equal(opts.request_id, input.request_id, 'the call is sent under the body\'s request id');
      return { output: await w.call('page_action', input) };
    }
    if (mode === 'ask') return { text: 'ok' };
    throw new Error(mode);
  });
  await d.flush();
  return d;
}
const press = async (d, el) => { assert.ok(el, 'element to press'); el.click(); await d.flush(); };
const tab = (d, id) => press(d, d.find(`[data-k="tab:${id}"]`));
const main = (d) => text(d.app.children[0]);
const sheet = (d) => text(d.app.children[1]);

test('a hubless desk with nothing made yet: empty state, no notice (hubless is a mode), every tab drawn, no stray words', async () => {
  const w = await world({ hub: false });
  const d = await desk(w);
  assert.match(main(d), /Chưa có nội dung nào/);
  assert.doesNotMatch(main(d), /Chưa nối marketing hub|Không đọc được máy chủ/, 'no notice under the tabs');
  assert.equal(d.all('.mk-partial').length, 0);
  assert.match(main(d), /Chưa đo được/);
  for (const id of ['content', 'channels', 'library', 'numbers', 'today']) {
    await tab(d, id);
    assert.doesNotMatch(main(d), BAD_TEXT, `${id}: ${main(d).match(BAD_TEXT)?.[0]}`);
    assert.equal(d.find('[role="tab"][aria-selected="true"]')?.getAttribute('data-k'), `tab:${id}`);
  }
  await tab(d, 'channels');
  assert.match(main(d), /Máy chủ đăng bài/);
  assert.equal(d.find('[data-k="pause:all"]'), null, 'nothing posts by itself, so nothing to pause');
  await press(d, d.find('[data-k="hub:connect2"]'));
  assert.deepEqual(d.opened, ['nest://settings/setup?key=MARKETING_HUB']);
});

test('an item waiting for approval: Chờ duyệt everywhere, Duyệt… opens Nest\'s approval card, the desk never approves', async () => {
  const w = await world();
  const s = await saved(w);
  const approvals = [{ id: 'ap-7', state: 'pending', tool: 'publish_bundle', ref: s.ref, created_at: new Date(T0 - 7 * H).toISOString(), expires_at: new Date(T0 + 17 * H).toISOString() }];
  const d = await desk(w, { approvals });
  assert.match(main(d), /Vì sao bài chưa lên/);
  assert.match(main(d), /Chín bộ tiên hiệp nên đọc/);
  // One read carries the header and the tab (with_summary), so a refresh spends the hub budget once.
  const reads = d.calls.filter(c => c.mode === 'view' && c.input?.view);
  assert.ok(reads.length && reads.every(c => c.input.view !== 'summary'), 'no separate summary read');
  assert.equal(reads[0].input.with_summary, true);
  assert.deepEqual(reads[0].input.approvals.map(a => a.id), ['ap-7'], 'the approvals are passed back to the views');
  await tab(d, 'content');
  assert.match(main(d), /Chờ duyệt/);
  const row = d.all('.mk-row.click').find(r => /Chín bộ tiên hiệp/.test(text(r)));
  await press(d, row);
  assert.match(sheet(d), /Đây là nguyên văn sẽ lên/);
  assert.doesNotMatch(sheet(d), BAD_TEXT, sheet(d).match(BAD_TEXT)?.[0]);
  await press(d, d.find('[data-k="approve"]'));
  assert.deepEqual(d.opened, ['nest://needs/approve/ap-7']);
  assert.equal(d.calls.filter(c => c.mode === 'action').length, 0, 'approving is Nest\'s card, not a desk action');
  assert.equal(w.publishes(), 0);
});

test('stop needs a second press; one press sends nothing, the second stops it once', async () => {
  const w = await world();
  const s = await saved(w);
  const d = await desk(w);
  await tab(d, 'content');
  await press(d, d.all('.mk-row.click').find(r => /Chín bộ tiên hiệp/.test(text(r))));
  const stop = d.find(`[data-k="stop:${s.ref}"]`);
  await press(d, stop);
  assert.equal(d.calls.filter(c => c.mode === 'action').length, 0);
  assert.match(text(stop), /Bấm lần nữa/);
  await press(d, stop);
  const acts = d.calls.filter(c => c.mode === 'action');
  assert.deepEqual(acts.map(a => [a.input.op, a.input.ref]), [['stop', s.ref]]);
  assert.equal(d.app.children[1].childNodes.length, 0, 'the sheet closes');
  assert.match(text(d.app.children[2]), /Đã dừng/);
});

test('a lost answer: the retry sends the same request id, and a refusal frees it for a new one', async () => {
  const w = await world();
  let lose = true;
  const seen = [];
  const d = mount(script, async ({ mode, input, opts }) => {
    if (mode === 'view' && input === 'approvals') return { approvals: [], total: 0 };
    if (mode === 'view') return w.view(input);
    if (mode === 'action') {
      seen.push(opts.request_id);
      if (lose) { lose = false; throw Object.assign(new Error('lost'), { code: 'timeout' }); }
      return { output: await w.call('page_action', input) };
    }
  });
  await d.flush();
  await tab(d, 'channels');
  const pause = d.find('[data-k="pause:all"]');
  await press(d, pause);
  assert.match(text(d.app.children[2]), /Nest chưa trả lời/);
  await press(d, d.find('[data-k="pause:all"]'));
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the same intent after an unknown outcome reuses its request id');
  await d.flush();
  assert.match(main(d), /Bật lại mọi lượt đăng/);
});

test('create: one press writes the item and hands it to the Editor under ask-<ref>; a refused ask leaves a button to send it', async () => {
  const w = await world();
  let refuse = 'unsupported'; // a host with no ask first, then a lost gesture, then it goes through
  const d = mount(script, async ({ mode, input }) => {
    if (mode === 'view' && input === 'approvals') return { approvals: [], total: 0 };
    if (mode === 'view') return w.view(input);
    if (mode === 'action') { assert.ok(actionOK(input), JSON.stringify(actionOK.errors)); return { output: await w.call('page_action', input) }; }
    if (mode === 'ask') { if (refuse) { const code = refuse; refuse = refuse === 'unsupported' ? 'gesture_required' : false; throw Object.assign(new Error('x'), { code }); } return { text: 'ok' }; }
  });
  await d.flush();
  await press(d, d.find('[data-k="create"]'));
  assert.match(sheet(d), /Tạo nội dung/);
  await press(d, d.find('[data-k="cf:send"]'));
  assert.equal(d.calls.filter(c => c.mode === 'action').length, 0, 'no topic, nothing sent');
  const topic = d.find('#f-topic');
  topic.value = 'Vì sao bộ này đang được đọc nhiều';
  topic.dispatch('input');
  await press(d, d.find('[data-k="cf:send"]'));
  const create = d.calls.find(c => c.mode === 'action');
  assert.equal(create.input.op, 'create');
  assert.equal(create.input.topic, 'Vì sao bộ này đang được đọc nhiều');
  const asks = () => d.calls.filter(c => c.mode === 'ask');
  assert.equal(asks().length, 1);
  const ref = asks()[0].opts.request_id.replace(/^ask-/, '');
  assert.match(ref, M.ITEM_REF);
  assert.match(sheet(d), /Biên tập chưa nhận tin/);
  const toastText = () => text(d.find('.mk-toast') ?? d.doc.body);
  assert.match(toastText(), /Mở bàn Marketing trong Nest/, 'a host with no ask says where it works');
  await press(d, d.find('[data-k="cf:ask"]'));
  assert.match(toastText(), /Bấm nút thêm lần nữa/);
  await press(d, d.find('[data-k="cf:ask"]'));
  assert.equal(asks().length, 3);
  assert.ok(asks().every(a => a.opts.request_id === `ask-${ref}`), 'the same item is asked under the same id');
  assert.equal(d.app.children[1].childNodes.length, 0, 'the sheet closes once the Editor has it');
  assert.equal(d.find('[role="tab"][aria-selected="true"]')?.getAttribute('data-k'), 'tab:content');
  // Later, from the item: the same words under the same id, so Nest keeps one request.
  assert.match(main(d), /Vì sao bộ này đang được đọc nhiều/, 'the new item is on the desk at once');
  assert.doesNotMatch(main(d), /Chưa có nội dung nào/);
  await press(d, d.find('.mk-row.click', /Vì sao bộ này đang được đọc nhiều/));
  assert.match(sheet(d), /Đã giao cho Người viết/);
  await press(d, d.find('[data-k="reask"]'));
  assert.equal(asks().length, 4);
  assert.equal(asks()[3].opts.request_id, `ask-${ref}`);
  assert.equal(asks()[3].input, asks()[0].input, 'the resend says what the first ask said');
  assert.equal(w.publishes(), 0);
});

test('channels, a channel sheet, the library radar and a video hand-off draw from real answers', async () => {
  const w = await world();
  await saved(w);
  const d = await desk(w);
  await tab(d, 'channels');
  assert.match(main(d), /Ai đưa bài lên/);
  await press(d, d.find('[data-k="cell:acme:x"]'));
  assert.match(sheet(d), /Nhịp đăng/);
  assert.doesNotMatch(sheet(d), BAD_TEXT, sheet(d).match(BAD_TEXT)?.[0]);
  await press(d, d.find('[data-k="rules:edit"]'));
  const cap = d.find('#r-cap');
  cap.value = '99';
  cap.dispatch('input');
  await press(d, d.find('[data-k="rules:save"]'));
  assert.equal(d.calls.filter(c => c.mode === 'action').length, 0, 'out of range is caught before a call');
  cap.value = '2';
  cap.dispatch('input');
  await press(d, d.find('[data-k="rules:save"]'));
  assert.deepEqual(d.calls.filter(c => c.mode === 'action').map(c => [c.input.op, c.input.cap_per_day]), [['rules', 2]]);
  d.doc.listeners.keydown.forEach(fn => fn({ key: 'Escape', target: d.doc.body, preventDefault() {} }));
  assert.equal(d.app.children[1].childNodes.length, 0, 'Esc closes the sheet');

  await tab(d, 'library');
  assert.equal(d.find('[data-k="node:radar:acme-video/2026-11-23"]'), null, 'nothing indexed yet');
  await press(d, d.find('[data-k="lib:scan"]'));
  assert.match(text(d.app.children[2]), /Đã quét/);
  const radar = d.find('[data-k="node:radar:acme-video/2026-11-23"]');
  await press(d, radar);
  assert.match(main(d), /Bộ A/);
  await press(d, d.find('[data-k="mark:1:yes"]'));
  const { request_id: _rid, ...mark } = JSON.parse(JSON.stringify(d.calls.filter(c => c.mode === 'action').at(-1).input));
  assert.deepEqual(mark, { op: 'mark', file: 'channels/acme-video/radar/2026-11-23.md', row: 1, onboard: 'yes' });
  assert.equal(d.find('[data-k="mark:1:yes"]').getAttribute('aria-pressed'), 'true');
  assert.match(await readFile(`${w.root}/channels/acme-video/radar/2026-11-23.md`, 'utf8'), /\| 1 \| \[Bộ A\]\(https:\/\/a\.example\) \| tiên hiệp \| 12k \| Có \|/);
  await press(d, d.find('[data-k="node:campaigns:acme-video"]'));
  assert.match(main(d), /Ep 1/);

  await tab(d, 'content');
  await press(d, d.find('[data-k="stage:scheduled"]'));
  const video = d.all('.mk-row.click').find(r => /Ep 1/i.test(text(r)));
  await press(d, video);
  assert.match(sheet(d), /Video này chờ bạn đăng TikTok/);
  const url = d.find('#f-url');
  url.value = 'https://evil.example/x';
  url.dispatch('input');
  await press(d, d.find('[data-k="save-video"]'));
  assert.equal(d.calls.filter(c => c.mode === 'action' && c.input.op === 'confirm').length, 0, 'a wrong link is caught before a call');
  url.value = 'https://www.tiktok.com/@acme/video/7707307745841581332';
  url.dispatch('input');
  await press(d, d.find('[data-k="save-video"]'));
  assert.equal(d.calls.filter(c => c.mode === 'action' && c.input.op === 'confirm').length, 1);
  assert.match(await readFile(`${w.root}/channels/acme-video/metrics/videos.csv`, 'utf8'), /7707307745841581332/);
});

test('numbers and failures: "—" for no source, a failed summary offers Thử lại, approvals that cannot be read say so', async () => {
  const w = await world({ hub: false });
  await saved(w);
  const d = await desk(w, { approvalsFail: 'not_authorized' });
  assert.match(main(d), /Chưa đọc được/, 'the approval tile says it could not read approvals');
  await tab(d, 'numbers');
  assert.match(main(d), /“—” là chưa đo được, không phải 0/);
  assert.match(main(d), /—/);

  const broken = mount(script, async ({ mode, input }) => {
    if (mode === 'view' && input === 'approvals') return { approvals: [], total: 0 };
    throw Object.assign(new Error('x'), { code: 'busy' });
  });
  await broken.flush();
  assert.match(main(broken), /Không mở được bàn Marketing/);
  assert.match(main(broken), /Bàn đang bận/);
  assert.ok(broken.find('[data-k="retry"]'));
});

test('a hub out of its minute budget says so and waits, not "down"; Thử lại is one read for the header and the tab', async () => {
  const w = await world();
  await saved(w);
  w.hub.limited = true;
  const d = await desk(w);
  assert.match(main(d), /hết lượt đọc trong phút này/);
  assert.doesNotMatch(main(d), /Hub không trả lời|Không đọc được marketing hub/);
  assert.equal(d.all('.mk-partial').length, 0, 'a spent budget is a wait, not an alert');
  assert.ok(viewOK(M.viewBody('numbers', { with_summary: true })), 'with_summary is part of page_view');
  w.hub.limited = false;
  const before = d.calls.filter(c => c.mode === 'view' && c.input?.view).length;
  const hubBefore = w.hub.calls.length;
  await press(d, d.find('[data-k="hub:retry"]'));
  const reads = d.calls.filter(c => c.mode === 'view' && c.input?.view).slice(before);
  assert.equal(reads.length, 1, 'one page_view per refresh');
  assert.equal(reads[0].input.with_summary, true);
  assert.equal(w.hub.calls.slice(hubBefore).filter(c => c[0] === 'social_channels').length, 1, 'the hub is read once per refresh');
  assert.doesNotMatch(main(d), /hết lượt đọc/);
  assert.match(main(d), /Chín bộ tiên hiệp nên đọc/);
});

test('an item Nest approved that the Editor has not scheduled yet reads as approved, not waiting for the founder', () => {
  const s = M.itemState({ state: 'granted' }, T0);
  assert.deepEqual([s.tag, s.tone], ['Đã duyệt, Biên tập đang xếp lịch', 'run']);
  assert.ok(ICONS.includes(s.icon), s.icon);
  const row = M.planText({ channel: 'x', state: 'after_approval' }, { now: T0 }, 'granted');
  assert.deepEqual([row.tag, row.line], ['Đã duyệt', 'Bạn đã duyệt; Biên tập đang xếp giờ lên'], 'its plan rows do not say Nháp under the approved banner');
});
