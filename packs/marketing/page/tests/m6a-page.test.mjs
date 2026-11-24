// M6a on the page: the founder's open question, caps only for channels that
// post, Thêm sản phẩm and the missing marketing folder in setup, the TikTok and
// newsletter hand-offs, the pasted recipient list, the reply toast and the
// pre-test's prepared workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import * as M from '../src/model.js';
import { mount, text } from './fake-dom.mjs';
import { world, saved, T0 } from '../../tests/desk-world.mjs';

const pack = JSON.parse(await readFile(new URL('../../pack.json', import.meta.url), 'utf8'));
const actionOK = new Ajv2020({ strict: false }).compile(pack.tools.find(t => t.name === 'page_action').parameters);
const script = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const c = { now: T0 };

async function desk(w, extra = () => null) {
  const d = mount(script, async ({ mode, input, opts }) => {
    const x = await extra({ mode, input, opts });
    if (x) return x;
    if (mode === 'view' && input === 'approvals') return { approvals: [], total: 0 };
    if (mode === 'view') return w.view(input);
    if (mode === 'action') {
      assert.ok(actionOK(input), `${JSON.stringify(input)} ${JSON.stringify(actionOK.errors)}`);
      return { output: await w.call('page_action', input) };
    }
    if (mode === 'ask') return { text: 'ok' };
    throw new Error(mode);
  });
  await d.flush();
  return d;
}
const press = async (d, el) => { assert.ok(el, 'element to press'); el.click(); await d.flush(); };
const type = (el, v) => { assert.ok(el, 'field'); el.value = v; el.dispatch('input'); };
const sheet = (d) => text(d.app.children[1]);
const main = (d) => text(d.app.children[0]);
const toastText = (d) => text(d.app.children[2]);
const acts = (d, op) => d.calls.filter(x => x.mode === 'action' && (!op || x.input.op === op));
const tab = (d, id) => press(d, d.find(`[data-k="tab:${id}"]`));

// ---------- words ----------

test('model: a waiting item reads Chờ bạn trả lời, Hôm nay names the waits, an unknown status code stays quiet', () => {
  assert.deepEqual(M.itemState({ state: 'waiting' }), { tag: 'Chờ bạn trả lời', tone: 'wait', icon: 'message' });
  const w = M.statusText({ code: 'waits', tone: 'wait', args: { asks: 1, handoffs: 2, other: 0, replies: 0 } }, c);
  assert.match(w.text ?? w, /Đang chờ bạn/);
  assert.doesNotMatch(JSON.stringify(w), /healthy|waits/);
});

test('caps show only for channels that post: a hand-off or unused channel has no cap line', () => {
  const cadence = { x: { cap_per_day: 2 }, facebook: { cap_per_day: 1 }, tiktok: { cap_per_day: 1 } };
  const posts = M.cadenceText(cadence, { x: { state: 'ok' }, facebook: { state: 'off' }, tiktok: { state: 'manual' } });
  assert.match(posts, /X/);
  assert.doesNotMatch(posts, /Facebook|TikTok/);
  assert.equal(M.cadenceText(cadence, { x: { state: 'off' }, facebook: { state: 'by_hand' } }), '', 'no channel that posts: no line');
});

test('pre-test: unavailable and no_workspace say a prepared workspace is needed, and the setup ask names it', () => {
  assert.match(M.pretestText({ state: 'unavailable' }, c).hint, /Simulated society/);
  const nw = M.pretestText({ state: 'failed', reason: 'no_workspace' }, c);
  assert.deepEqual([nw.state, nw.title], ['unavailable', 'Chưa có chỗ chạy người đọc giả lập']);
  assert.equal(M.pretestText({ state: 'failed', reason: 'run_failed' }, c).state, 'failed', 'another failure still offers Thử lại');
  assert.match(M.PRETEST_SETUP_ASK, /society-sim/);
  assert.match(M.PRETEST_SETUP_ASK, /Micro Fish cho Biên tập/);
});

// ---------- drawn from real answers ----------

test('an item the team asked about: Hôm nay shows Chờ bạn trả lời with the question, and the sheet points at Cần bạn', async () => {
  const w = await world({ hub: false });
  const s = await saved(w);
  await w.call('item_save', { ref: s.ref, product: 'acme', waiting: 'Giá 49k còn đúng không?' });
  const d = await desk(w);
  assert.match(main(d), /Chờ bạn trả lời/);
  assert.match(main(d), /Giá 49k còn đúng không\?/);
  assert.match(main(d), /Đang chờ bạn/, 'never the green healthy line');
  await tab(d, 'content');
  await press(d, d.all('.mk-row.click').find(r => /Chín bộ tiên hiệp/.test(text(r))));
  assert.match(sheet(d), /Đội đang chờ bạn trả lời/);
  await press(d, d.find('[data-k="wait:needs"]'));
  assert.equal(d.opened.at(-1), 'nest://needs');
});

test('setup: the sheet is Thêm sản phẩm once a product exists; a missing marketing folder is said on step 1 with its fix', async () => {
  const w = await world({ hub: false });
  const d = await desk(w);
  await tab(d, 'channels');
  await press(d, d.find('[data-k="setup:add"]'));
  assert.match(sheet(d), /Thêm sản phẩm/);
  assert.doesNotMatch(sheet(d), /Bắt đầu marketing/);
  assert.equal(d.find('[data-k="su:root"]'), null, 'the folder is set: no notice');

  // The folder is not set: the server refuses with needs_credential, and step 1 says it in place.
  const none = await world({ hub: false });
  await rm(join(none.root, 'products.json'));
  const env = {};
  const e = await desk(none, async ({ mode, input }) => {
    if (mode === 'view' && input !== 'approvals') return none.call('page_view', input, {}, { env });
    if (mode === 'action') return { output: await none.call('page_action', input, {}, { env }) };
    return null;
  });
  await press(e, e.find('[data-k="setup:start"]'));
  assert.match(sheet(e), /Chưa chọn thư mục marketing/);
  await press(e, e.find('[data-k="su:root"]'));
  assert.equal(e.opened.at(-1), 'nest://settings/setup?key=MARKETING_ROOT');
  type(e.find('#su-name'), 'Quà biết nói');
  for (let i = 0; i < 3; i++) await press(e, e.find('[data-k="su:next"]'));
  await press(e, e.find('[data-k="su:save"]'));
  assert.equal(acts(e, 'setup').length, 1);
  assert.match(sheet(e), /Bước 1\/4/, 'back on step 1');
  assert.match(sheet(e), /Chọn thư mục trong Kho khóa rồi bấm Lưu lại/);
  assert.equal(e.find('#su-name').value, 'Quà biết nói', 'what was typed stays');
});

test('TikTok hand-off: caption and file path to copy, the saved handle in the hint, TikTok as the only platform, the item title', async () => {
  const w = await world({ hub: false });
  const products = JSON.parse(await readFile(join(w.root, 'products.json'), 'utf8'));
  products.products[0].accounts.tiktok = '@acmetruyen';
  await writeFile(join(w.root, 'products.json'), JSON.stringify(products));
  const cut = join(w.root, 'channels/acme-video/campaigns/ep-1/08-delivery/s1-vertical/tiktok');
  await mkdir(cut, { recursive: true });
  await writeFile(join(cut, 'ep-1.mp4'), '');
  await writeFile(join(cut, 'caption.txt'), 'Một bộ hay #truyen');
  const camp = JSON.parse(await readFile(join(w.root, 'channels/acme-video/campaigns/ep-1/campaign.json'), 'utf8'));
  await writeFile(join(w.root, 'channels/acme-video/campaigns/ep-1/campaign.json'), JSON.stringify({ ...camp, platforms: ['tiktok', 'youtube'] }));
  await w.call('library_scan', { hub: false });
  const d = await desk(w);
  await tab(d, 'content');
  await press(d, d.find('[data-k="stage:scheduled"]'));
  await press(d, d.all('.mk-row.click').find(r => /Ep 1/.test(text(r))));
  const t = sheet(d);
  assert.match(t, /Ep 1/);
  assert.doesNotMatch(t, /YouTube/, 'the desk takes a TikTok link only');
  for (const step of ['Chép chú thích', 'Chọn file video', 'Mở TikTok', 'Dán link video đã đăng']) assert.match(t, new RegExp(step));
  assert.match(t, /Tài khoản @acmetruyen\./);
  assert.ok(d.find('[data-k="cp:caption"]') && d.find('[data-k="cp:video"]'));
  assert.match(text(d.find('[data-k="cp:video"]')), /Chép đường dẫn/);
});

test('newsletter: paste the recipients (only a count comes back), export, then Đã gửi xong is the one primary step', async () => {
  const w = await world({ hub: false });
  const products = JSON.parse(await readFile(join(w.root, 'products.json'), 'utf8'));
  products.products[0].newsletter = true;
  await writeFile(join(w.root, 'products.json'), JSON.stringify(products));
  const n = { subject: 'Tuần này ở Acme', body: 'Ba bộ mới tuần này.' };
  const s = await w.call('item_save', { product: 'acme', slug: 'ban-tin', format: 'newsletter', newsletter: n });
  assert.equal((await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'newsletter', lang: 'vi', revision: 1, ...n }] })).ok, true);
  const d = await desk(w, ({ mode, input }) => (mode === 'view' && input === 'abilities' ? { email: false } : null));
  await tab(d, 'content');
  await press(d, d.find('[data-k="stage:scheduled"]'));
  await press(d, d.all('.mk-row.click').find(r => /Tuần này ở Acme/.test(text(r))));
  assert.match(sheet(d), /Chưa có danh sách người nhận/);
  assert.doesNotMatch(sheet(d), /subscribers\.csv/, 'the founder never edits a file by hand');
  // An empty press is caught before a call; a list with no address is refused in place.
  await press(d, d.find('[data-k="subs:save"]'));
  assert.equal(acts(d, 'subscribers').length, 0);
  type(d.find('#f-subs'), 'không có ai');
  await press(d, d.find('[data-k="subs:save"]'));
  assert.equal(d.find('#f-subs').getAttribute('aria-invalid'), 'true');
  assert.match(sheet(d), /Chưa thấy địa chỉ email nào/);
  type(d.find('#f-subs'), 'an@vidu.vn\nbinh@vidu.vn');
  await press(d, d.find('[data-k="subs:save"]'));
  assert.match(toastText(d), /Đã lưu 2 người nhận/);
  assert.doesNotMatch(sheet(d), /vidu\.vn/, 'no address is shown back');
  assert.match(sheet(d), /2 người đăng ký/);
  await press(d, d.find('[data-k="nl:export"]'));
  const t = sheet(d);
  assert.match(t, /Đã xuất ra file/);
  assert.ok(d.find('[data-k="nl:path:0"]') && d.find('[data-k="nl:path:1"]'), 'a path to copy for each file');
  assert.match(text(d.find('[data-k="nl:path:0"]')), /Chép đường dẫn/);
  assert.match(d.find('[data-k="nl:sent"]').className, /primary/);
  assert.doesNotMatch(d.find('[data-k="nl:export"]').className, /primary/);
  assert.doesNotMatch(t, /Bấm khi bạn đã gửi bằng công cụ khác/, 'the old footer line is gone');
  await press(d, d.find('[data-k="nl:sent"]'));
  assert.equal(acts(d, 'confirm').at(-1).input.outcome, 'sent');
});

test('Đã trả lời says the Cần bạn card closes only when one was raised', async () => {
  const w = await world({ hub: false });
  const reply = (ref) => w.store.insert('replies', { ref, channel: 'reddit', thread_url: 'https://www.reddit.com/r/selfhosted/comments/abc/x', author_handle: 'u', text: `Giá ${ref}?`, class: 'money', state: 'needs_person' });
  await saved(w);
  await reply('R-00000000D1');
  await reply('R-00000000D2');
  await w.store.insert('attention', { key: 'inc:reply:R-00000000D1:money', kind: 'inc-reply', ref: 'R-00000000D1', reason: 'money', raised_at: new Date(T0).toISOString() });
  const d = await desk(w);
  await press(d, d.find('[data-k="reply:done:R-00000000D2"]'));
  assert.match(toastText(d), /Đã ghi là xong\./);
  assert.doesNotMatch(toastText(d), /Thẻ trong Cần bạn/);
  await press(d, d.find('[data-k="reply:done:R-00000000D1"]'));
  assert.match(toastText(d), /Thẻ trong Cần bạn tự đóng/);
});

// ---------- team cards in Cần bạn ----------

test('model: the team_waits answer becomes a count; the status names the cards', () => {
  assert.equal(M.cardCount({ items: [], total: 4, teams: ['growth'] }), 4);
  assert.equal(M.cardCount({ total: -1 }), null);
  assert.equal(M.cardCount(null), null);
  const s = M.statusText({ code: 'waits', tone: 'wait', args: { asks: 0, handoffs: 0, other: 0, replies: 0, cards: 2 } }, c);
  assert.match(s.text, /2 việc của đội chờ bạn trong Cần bạn/);
  assert.deepEqual(M.viewBody('summary', { cards: 2 }), { view: 'summary', cards: 2 });
});

test('the desk reads team_waits, passes the count to page_view and offers Mở Cần bạn; an older host keeps the desk working', async () => {
  const w = await world({ hub: false });
  await saved(w);
  const d = await desk(w, ({ mode, input }) => mode === 'view' && input === 'team_waits' ? { items: [{ id: 'a1', kind: 'need', title: 'Q' }], total: 1, teams: ['growth'] } : null);
  assert.ok(d.calls.some(x => x.mode === 'view' && x.input?.cards === 1), 'page_view carries cards');
  assert.match(main(d), /1 việc của đội chờ bạn trong Cần bạn/);
  await press(d, d.find('[data-k="status:needs"]'));
  assert.ok(d.calls.some(x => x.mode === 'open' && /nest:\/\/needs$/.test(x.input ?? x.url ?? '')) || d.opened?.includes?.('nest://needs'), 'opens Cần bạn');
  const old = await desk(w, ({ mode, input }) => { if (mode === 'view' && input === 'team_waits') throw Object.assign(new Error('no'), { code: 'invalid_request' }); return null; });
  assert.ok(!old.find('[data-k="status:needs"]'));
  assert.ok(old.calls.some(x => x.mode === 'view' && typeof x.input === 'object' && !('cards' in x.input)));
});
