// Marketing desk phase 2 on the page: the words made from the server's codes,
// no internal names in what a person reads, what Tạo nội dung and Bắt đầu
// marketing refuse before they send, the links the founder pastes, and the
// kinds grid, setup sheet and community hand-off drawn from real answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import * as M from '../src/model.js';
import { mount, text } from './fake-dom.mjs';
import { world, T0 } from '../../tests/desk-world.mjs';

const page = new URL('../', import.meta.url);
const pack = JSON.parse(await readFile(new URL('../../pack.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false });
const actionOK = ajv.compile(pack.tools.find(t => t.name === 'page_action').parameters);
const script = await readFile(new URL('app.js', page), 'utf8');
const H = 3600_000;
const c = { now: T0 };
const ACME = { id: 'acme', name: 'Acme Truyện', mark: 'AT', site: 'acme.example', hub_site: 'acme', video_channels: ['acme-video'], accounts: { facebook: 'Trang Acme' } };
const WITH_TARGETS = { ...ACME, targets: [{ kind: 'reddit', sub: 'selfhosted' }, { kind: 'hn' }], newsletter: true, changelog: 'acme/CHANGELOG.md' };
const products = (w, list) => writeFile(join(w.root, 'products.json'), JSON.stringify({ products: list }));

// ---------- wording made from codes ----------

test('learn next: the why is a code with numbers, and the sentence is made here', () => {
  assert.equal(M.nextWhy({ why: 'plan_topic', why_args: { awareness: 'problem' } }), 'Đề tài kế hoạch tuần này đã chọn, viết cho người đã thấy vấn đề, chưa biết cách giải.');
  assert.equal(M.nextWhy({ why: 'plan_topic', why_args: {} }), 'Đề tài kế hoạch tuần này đã chọn.');
  assert.equal(M.nextWhy({ why: 'uncovered_query', why_args: { impressions: 1240, position: 8.4 } }), `${M.num(1240)} lượt hiện trên Google, hạng 8, chưa có bài nào.`);
  assert.equal(M.nextWhy({ why: 'uncovered_query', why_args: { impressions: 90 } }), '90 lượt hiện trên Google, chưa có bài nào.');
  assert.equal(M.nextWhy({ why: 'some_new_code' }), '', 'an unknown code reads nothing, never the code');
  assert.equal(M.nextWhy(null), '');
});

test('Cần trả lời: each class has its tag, and the place reads channel · thread · when', () => {
  const r = (cls) => M.replyText({ class: cls, channel: 'reddit', thread_title: 'I built it', at: new Date(T0 - 2 * H).toISOString() }, c);
  assert.deepEqual(['complaint', 'money', 'account', 'flagged'].map(k => [r(k).tag, r(k).tone]), [['Phàn nàn', 'wait'], ['Tiền', 'wait'], ['Chuyển Hỗ trợ', 'idle'], ['Cần xem', 'idle']]);
  assert.match(r('complaint').where, /^Reddit · dưới “I built it” · /);
  assert.equal(r('account').hint, 'Hỏi về tài khoản. Chuyển cho Hỗ trợ hoặc trả lời riêng.');
  assert.equal(r('weird').tag, 'Cần xem', 'an unknown class still waits for the founder');
  assert.equal(r('weird').hint, 'Biên tập thấy lạ nên để bạn xem.');
});

test('pre-test: go / fix / stop verdicts, a rounded score, running, failed and unavailable', () => {
  const done = (verdict, extra = {}) => M.pretestText({ state: 'done', verdict, n: 40, score: 6.6, at: new Date(T0 - H).toISOString(), reasons: ['a', 'b', 'c', 'd'], ...extra }, c);
  assert.deepEqual(['go', 'fix', 'stop'].map(v => [done(v).title, done(v).tone]), [['Nên đăng', 'ok'], ['Nên sửa trước', 'wait'], ['Chưa nên đăng', 'err']]);
  assert.match(done('go').line, /^40 người đọc giả lập · 7\/10 muốn đọc tiếp · /);
  assert.equal(done('go').reasons.length, 3, 'three reasons at most');
  assert.equal(done('fix', { stale: true }).stale, true);
  assert.equal(M.pretestText({ state: 'asked', at: new Date(T0).toISOString() }, c).state, 'running');
  assert.equal(M.pretestText({ state: 'failed', reason: 'budget' }, c).hint, 'Đội hết ngân sách AI cho hôm nay.');
  assert.equal(M.pretestText({ state: 'unavailable' }, c).title, 'Đội chưa có Micro Fish');
  assert.equal(M.pretestText(null, c).state, 'none');
});

test('plan rows: hand-off, sending, exported, written and no_account read as the founder\'s next step', () => {
  const p = (state, extra = {}) => M.planText({ state, ...extra }, c, 'scheduled');
  assert.deepEqual([p('handoff', { channel: 'tiktok' }).line, p('handoff', { channel: 'newsletter' }).tag, p('handoff', { channel: 'community' }).line, p('handoff', { channel: 'community' }).tag, p('handoff', { channel: 'x' }).tag],
    ['TikTok do bạn đăng tay', 'Chờ bạn gửi', 'Bạn đăng rồi dán link', 'Bạn đăng', 'Bạn đăng tay']);
  assert.equal(p('sending', { channel: 'newsletter' }).tag, 'Chờ duyệt lần gửi');
  assert.equal(p('exported', { channel: 'newsletter' }).line, 'Đã xuất ra file; bạn gửi bằng công cụ của bạn');
  assert.match(p('written', { channel: 'blog', at: new Date(T0 - H).toISOString() }).line, /^Đã ghi vào thư mục site /);
  assert.equal(p('no_account', { channel: 'x' }).line, 'Chưa có tài khoản X, bài này không lên');
  assert.equal(p('no_account', { channel: 'blog' }).line, 'Sản phẩm chưa có blog, bài này không lên');
  // After approval, with no hub: the founder posts by hand, the folder is written, the newsletter waits for a press.
  const a = (via) => M.planText({ state: 'after_approval', channel: 'x', via }, c, 'approval').line;
  assert.deepEqual([a('hand'), a('folder'), a('send')], ['Duyệt xong thì bạn đăng tay rồi dán link', 'Duyệt xong thì bàn ghi bài vào thư mục site', 'Duyệt xong thì bạn bấm gửi']);
});

test('blockers and cells of phase 2: community target, an approved newsletter, hand posting, no list, no blog', () => {
  const b = (kind, title_code, title_args, meta_code, meta_args) => M.blockerText({ kind, title_code, title_args, meta_code, meta_args, do: { label_code: 'post_by_hand' } }, c);
  assert.equal(b('handoff_community', 'handoff_community', { n: 1, target: 'r/selfhosted' }).title, '1 bài cộng đồng chờ bạn đăng lên r/selfhosted');
  assert.match(b('handoff_newsletter', 'handoff_newsletter', { title: 'Tuần 48' }, 'approved', { at: new Date(T0 - 3 * H).toISOString() }).meta, /^Duyệt /);
  assert.equal(b('handoff_social', 'handoff_social', { n: 2, channel: 'facebook' }).title, '2 bài Facebook chờ bạn đăng tay');
  assert.deepEqual(M.cellText({ state: 'no_list' }), { tone: 'wait', l1: 'Chưa có danh sách', l2: 'Dán danh sách người nhận' });
  assert.equal(M.cellText({ state: 'off', why: 'no_blog' }).l1, 'Chưa có blog');
  assert.equal(M.cellText({ state: 'unknown', why: 'hubless' }).l1, 'Bạn đăng tay');
  assert.equal(M.cellText({ state: 'folder', dir: 'acme/site/posts', posted_7d: 2 }).l2, 'acme/site/posts · 2 bài, 7 ngày');
  assert.equal(M.cellText({ state: 'by_hand', channel: 'community', targets: [{ kind: 'reddit', sub: 'selfhosted', label: 'r/selfhosted' }, { kind: 'hn', label: 'Hacker News' }] }).l2, 'r/selfhosted, Hacker News');
});

// ---------- glossary ----------

/** Every string and template literal with a space in it: the words a person can read. */
function copyOf(src) {
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  return [...bare.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map(m => m[1] ?? m[2]).filter(s => / /.test(s) && !/^nest:|^https?:/.test(s));
}
test('glossary: no internal name (Hub, Poster, Writer, Editor, Builder) in any copy the page shows', async () => {
  const INTERNAL = /\b(?:Hub|hub|Poster|Writer|Editor|Builder)\b/;
  for (const f of ['src/model.js', 'src/app.js']) {
    // Code inside ${…} is not copy; a literal cut at a nested template ends at its first ${.
    const hits = copyOf(await readFile(new URL(f, page), 'utf8')).filter(s => INTERNAL.test(s.replace(/\$\{[^}]*\}/g, '').replace(/\$\{.*$/s, '')));
    assert.deepEqual(hits, [], f);
  }
  // And what the model renders from codes, for a sample of every family.
  const out = [
    ...Object.values(M.WHO), ...Object.values(M.FORMAT), ...M.KINDS.flatMap(k => [k.label, k.sub]),
    ...['busy', 'owner_unavailable', 'ask_failed', 'hub_refused', 'hub_unreachable', 'folder_refused', 'product_exists'].map(code => M.errorText({ code })),
    M.itemState({ state: 'granted' }, T0).tag, M.itemState({ state: 'sending' }, T0).tag,
    M.planText({ state: 'after_approval', channel: 'x' }, c, 'granted').line, M.planText({ state: 'scheduled', channel: 'x', waiting: 'poster' }, c).line,
    M.cellText({ state: 'unknown' }).l2, M.whyText('hub'), M.whyText('hubless'),
  ];
  for (const s of out) assert.doesNotMatch(s, INTERNAL, s);
});

// ---------- what a sheet refuses before it sends ----------

test('kinds: community "Nơi khác" needs a name, launch paste needs text, a topic is optional where the spec says so', () => {
  const p = (f) => M.createProblem({ product: 'acme', topic: '', ...f });
  assert.deepEqual(p({ format: 'community', target: 'other', where: '  ', topic: 'x' }), { field: 'f-where', text: 'Ghi tên nơi đăng trước đã.' });
  assert.deepEqual(p({ format: 'launch', source: 'paste', changelog: '' }), { field: 'f-cl', text: 'Dán nội dung bản thay đổi trước đã.' });
  assert.deepEqual(p({ format: 'blog' }), { field: 'f-topic', text: 'Ghi đề tài trước đã.' });
  assert.deepEqual(p({ format: 'community', target: 'hn' }), { field: 'f-topic', text: 'Ghi đề tài trước đã.' });
  assert.equal(p({ format: 'launch', source: 'changelog' }), null, 'a launch from the CHANGELOG needs nothing typed');
  assert.equal(p({ format: 'newsletter', source: 'week' }), null);
  assert.deepEqual(p({ format: 'newsletter', source: 'topic' })?.field, 'f-topic');
  // The fields that go out pass page_action.
  const rid = M.requestId('mk');
  const bodies = [
    M.createFields({ product: 'acme', format: 'community', target: 'other', where: ' Indie Hackers ', topic: 'Tự host', channels: ['community'] }),
    M.createFields({ product: 'acme', format: 'community', target: 'reddit:selfhosted', topic: 'Tự host' }),
    M.createFields({ product: 'acme', format: 'newsletter', source: 'week', topic: '' }),
    M.createFields({ product: 'acme', format: 'launch', source: 'paste', changelog: '## 2.0\n- mới', topic: '', channels: ['blog', 'x', 'community'] }),
    M.createFields({ product: 'acme', format: 'video', topic: 'ep', channels: ['tiktok'], series: 'hay' }),
  ];
  assert.deepEqual(bodies[0].target, { kind: 'other', name: 'Indie Hackers' });
  assert.equal('channels' in bodies[0], false, 'a community post has no channel list');
  assert.equal('topic' in bodies[2], false);
  assert.deepEqual([bodies[3].source, bodies[3].changelog], ['paste', '## 2.0\n- mới']);
  for (const b of bodies) { const x = M.actionBody('create', b, rid); assert.ok(actionOK(x), `${JSON.stringify(x)} ${JSON.stringify(actionOK.errors)}`); }
});

test('setup: a name, a real site, a folder inside, an account for a checked channel; the product passes page_action', () => {
  assert.deepEqual(['', 'quabietnoi.vn', 'https://acme.example/', 'http://a.io', 'acme', 'not a site', 'x.y', 'quà.vn', 'shop.acme.dev/vi'].map(M.siteUrl),
    ['', 'https://quabietnoi.vn', 'https://acme.example', 'http://a.io', null, null, null, null, 'https://shop.acme.dev/vi']);
  const sp = (step, f, list = [{ id: 'acme', name: 'Acme Truyện' }]) => M.setupProblem(step, f, list);
  assert.deepEqual(sp('product', { name: '  ' }), { key: 'name', text: 'Ghi tên sản phẩm.' });
  assert.deepEqual(sp('product', { name: 'acme truyện' }), { key: 'name', text: 'Đã có sản phẩm tên này.' });
  assert.deepEqual(sp('product', { name: 'Quà biết nói', site: 'quà' }), { key: 'site', text: 'Chưa phải địa chỉ trang. Ví dụ: quabietnoi.vn' });
  assert.equal(sp('product', { name: 'Quà biết nói', site: '' }), null, 'a site is optional');
  assert.equal(sp('blog', { blog: 'folder', dir: '../ngoai' }).key, 'dir');
  assert.equal(sp('blog', { blog: 'folder', dir: '' }).key, 'dir');
  assert.equal(sp('blog', { blog: 'none' }), null);
  assert.deepEqual(sp('channels', { ch: { x: { on: true, value: '' } } }), { key: 'ch-x', text: 'Ghi tài khoản X, hoặc bỏ chọn kênh này.' });
  assert.deepEqual(sp('channels', { ch: { community: { on: true, value: ' ' } } }), { key: 'ch-community', text: 'Ghi nơi đăng, hoặc bỏ chọn Cộng đồng.' });
  assert.equal(sp('channels', { ch: { newsletter: { on: true, value: '' }, x: { on: false, value: '' } } }), null);
  assert.equal(M.productId('Quà biết nói'), 'qua-biet-noi');
  const prod = M.setupProduct({ name: 'Quà biết nói', site: 'quabietnoi.vn', langs: 'vi,en', about: 'Quà kèm giọng nói.', blog: 'folder', dir: '', ch: { x: { on: true, value: '@qua' }, facebook: { on: false, value: 'bỏ' }, community: { on: true, value: 'r/selfhosted, Hacker News' }, newsletter: { on: true } } });
  assert.deepEqual(prod, { id: 'qua-biet-noi', name: 'Quà biết nói', site: 'https://quabietnoi.vn', langs: ['vi', 'en'], about: 'Quà kèm giọng nói.', blog: { dir: 'qua-biet-noi/site/posts' }, channels: { x: '@qua', community: 'r/selfhosted, Hacker News', newsletter: true } });
  assert.ok(actionOK(M.actionBody('setup', { product: prod }, M.requestId('mk'))), JSON.stringify(actionOK.errors));
});

test('pasted links: TikTok and each community kind keep their own shape', () => {
  const ok = [
    ['tiktok', 'https://www.tiktok.com/@acme/video/7707307745841581332'], ['tiktok', 'https://tiktok.com/@a.b_c/video/12345?lang=vi'],
    ['reddit', 'https://www.reddit.com/r/selfhosted/comments/abc123/i_built'], ['reddit', 'https://old.reddit.com/r/selfhosted/comments/abc123'],
    ['hn', 'https://news.ycombinator.com/item?id=41234567'], ['devto', 'https://dev.to/acme/how-we-self-host-3k2j'], ['other', 'https://indiehackers.com/post/x'],
  ];
  const bad = [
    ['tiktok', 'https://www.tiktok.com/@acme'], ['tiktok', 'http://www.tiktok.com/@acme/video/7707307745841581332'], ['tiktok', 'https://evil.example/@acme/video/123456'],
    ['reddit', 'https://www.reddit.com/r/selfhosted'], ['hn', 'https://news.ycombinator.com/news'], ['hn', 'https://news.ycombinator.com/item?id=1'],
    ['devto', 'https://dev.to/acme'], ['other', 'ftp://x.example/a'],
  ];
  for (const [ch, u] of ok) assert.equal(M.validUrl(ch, u), true, `${ch} ${u}`);
  for (const [ch, u] of bad) assert.equal(M.validUrl(ch, u), false, `${ch} ${u}`);
  assert.deepEqual(['reddit', 'hn', 'devto', 'other', undefined].map(k => M.communityKind({ kind: k })), ['reddit', 'hn', 'devto', 'other', 'other']);
});

// ---------- drawn from real answers ----------

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
const acts = (d, op) => d.calls.filter(c => c.mode === 'action' && (!op || c.input.op === op));

test('Tạo nội dung: six kinds in a radio group, arrows move the choice, and each kind refuses what it is missing', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const d = await desk(w);
  await press(d, d.find('[data-k="create"]'));
  const radios = d.all('[role="radio"]');
  assert.deepEqual(radios.map(r => r.getAttribute('data-k')), M.KINDS.map(k => `cf:kind:${k.id}`));
  assert.deepEqual(radios.map(r => r.getAttribute('aria-checked')), ['true', 'false', 'false', 'false', 'false', 'false']);
  assert.ok(d.find('[role="radiogroup"]'));
  // Arrow keys: right twice is Video, left from Blog wraps to Gói ra mắt.
  const key = async (k) => { d.find('[role="radiogroup"]').dispatch('keydown', { key: k, preventDefault() {} }); await d.flush(); };
  await key('ArrowRight'); await key('ArrowRight');
  assert.equal(d.find('[aria-checked="true"]')?.getAttribute('data-k'), 'cf:kind:video');
  await key('ArrowLeft'); await key('ArrowLeft'); await key('ArrowLeft');
  assert.equal(d.find('[aria-checked="true"]')?.getAttribute('data-k'), 'cf:kind:launch');
  assert.equal(d.all('[role="radio"]').filter(r => r.getAttribute('tabindex') === '0').length, 1, 'one tab stop in the group');
  // Gói ra mắt: the CHANGELOG is the default; pasting needs text.
  assert.match(sheet(d), /Người viết đọc phần trên cùng của CHANGELOG Acme Truyện/);
  await press(d, d.find('[data-k="cf:Bản thay đổi:paste"]'));
  await press(d, d.find('[data-k="cf:send"]'));
  assert.equal(acts(d).length, 0, 'nothing written');
  assert.match(text(d.app.children[2]), /Dán nội dung bản thay đổi trước đã\./);
  // Bài cộng đồng: the product's places, then "Nơi khác…", which needs a name.
  await press(d, d.find('[data-k="cf:kind:community"]'));
  const sel = d.find('#f-target');
  assert.deepEqual(d.all('option').map(o => text(o)), ['r/selfhosted', 'Hacker News', 'Nơi khác…']);
  sel.value = 'other';
  sel.dispatch('change');
  await d.flush();
  type(d.find('#f-topic'), 'Chúng tôi tự host trên một VM 2 GB');
  await press(d, d.find('[data-k="cf:send"]'));
  assert.equal(acts(d).length, 0);
  assert.match(text(d.app.children[2]), /Ghi tên nơi đăng trước đã\./);
  type(d.find('#f-where'), 'Indie Hackers');
  await press(d, d.find('[data-k="cf:send"]'));
  const sent = acts(d, 'create');
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify([sent[0].input.format, sent[0].input.target])), ['community', { kind: 'other', name: 'Indie Hackers' }]);
  assert.equal(d.calls.filter(c => c.mode === 'ask').length, 1, 'the Editor is asked once');
  assert.equal(w.publishes(), 0);
});

test('Bắt đầu marketing: four steps refuse an empty name and a checked channel with no account, save once, end on the done panel', async () => {
  const w = await world({ hub: false });
  await rm(join(w.root, 'products.json'));
  const d = await desk(w);
  assert.match(main(d), /Bắt đầu marketing/);
  assert.match(main(d), /Chưa có/, 'the tiles stay, blind');
  await press(d, d.find('[data-k="setup:start"]'));
  assert.match(sheet(d), /Bước 1\/4/);
  await press(d, d.find('[data-k="su:next"]'));
  assert.match(sheet(d), /Ghi tên sản phẩm\./);
  assert.equal(d.find('#su-name').getAttribute('aria-invalid'), 'true');
  type(d.find('#su-name'), 'Quà biết nói');
  type(d.find('#su-site'), 'quà');
  await press(d, d.find('[data-k="su:next"]'));
  assert.match(sheet(d), /Chưa phải địa chỉ trang/);
  type(d.find('#su-site'), 'quabietnoi.vn');
  await press(d, d.find('[data-k="su:next"]'));
  // Blog: no hub here, so Máy chủ đăng bài is off and the folder is the default.
  assert.match(sheet(d), /Bước 2\/4/);
  assert.equal(d.find('[data-k="su:blog:hub"]').disabled, true);
  assert.equal(d.find('[data-k="su:blog:folder"]').getAttribute('aria-checked'), 'true');
  assert.equal(d.find('#su-dir').value, 'qua-biet-noi/site/posts');
  await press(d, d.find('[data-k="su:next"]'));
  // Nơi đăng: X checked with no account is refused in place.
  await press(d, d.find('[data-k="su:ch:x"]'));
  assert.equal(d.find('[data-k="su:ch:x"]').getAttribute('aria-checked'), 'true');
  await press(d, d.find('[data-k="su:next"]'));
  assert.match(sheet(d), /Ghi tài khoản X, hoặc bỏ chọn kênh này\./);
  type(d.find('#su-ch-x'), '@quabietnoi');
  await press(d, d.find('[data-k="su:ch:newsletter"]'));
  await press(d, d.find('[data-k="su:next"]'));
  assert.match(sheet(d), /Bước 4\/4/);
  assert.match(sheet(d), /X \(@quabietnoi\), Bản tin/);
  assert.equal(acts(d).length, 0, 'nothing is written before Lưu sản phẩm');
  // Closing a filled form asks first.
  await press(d, d.find('[aria-label="Đóng"]'));
  assert.match(sheet(d), /Bỏ phần đã nhập\?/);
  await press(d, d.find('[data-k="su:keep"]'));
  await press(d, d.find('[data-k="su:save"]'));
  const setup = acts(d, 'setup');
  assert.equal(setup.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(setup[0].input.product)), { id: 'qua-biet-noi', name: 'Quà biết nói', site: 'https://quabietnoi.vn', langs: ['vi'], blog: { dir: 'qua-biet-noi/site/posts' }, channels: { x: '@quabietnoi', newsletter: true } });
  assert.match(sheet(d), /Đã thêm Quà biết nói/);
  // The team is the growth template's job, not a step of this sheet.
  assert.doesNotMatch(sheet(d), /Nhờ Lead|đội growth/);
  assert.equal(d.find('[data-k="su:lead"]'), null);
  assert.equal(d.opened.length, 0);
  // The same name again is caught before the server, and the sheet now says it adds a product.
  await press(d, d.find('[data-k="su:close"]'));
  await d.flush();
  const again = d.find('[data-k="setup:add"]');
  if (again) {
    await press(d, again);
    await d.flush();
    assert.match(sheet(d), /Thêm sản phẩm/);
    assert.doesNotMatch(sheet(d), /Bắt đầu marketing/);
    type(d.find('#su-name'), 'quà biết nói');
    await press(d, d.find('[data-k="su:next"]'));
    assert.match(sheet(d), /Đã có sản phẩm tên này\./);
  }
  assert.equal(acts(d, 'setup').length, 1);
});

test('community hand-off: four steps, a wrong link is refused before a call, a thread of that subreddit is saved', async () => {
  const w = await world();
  await products(w, [WITH_TARGETS]);
  const body = 'I built a self-hosted reader.\n\nFeedback welcome.';
  const s = await w.call('item_save', { product: 'acme', slug: 'self-host', format: 'community', community: { target: 'reddit:selfhosted', title: 'I built a self-hosted novel reader', body, lang: 'en' } });
  assert.equal((await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'community', lang: 'en', revision: 1, title: 'I built a self-hosted novel reader', body }] })).ok, true);
  const d = await desk(w);
  assert.match(main(d), /1 bài cộng đồng chờ bạn đăng lên r\/selfhosted/);
  await press(d, d.find('[data-k="tab:content"]'));
  await press(d, d.find('[data-k="stage:scheduled"]'));
  await press(d, d.all('.mk-row.click').find(r => /self-hosted novel reader/.test(text(r))));
  const t = sheet(d);
  for (const step of ['Chép tiêu đề', 'Chép nội dung', 'Mở trang đăng', 'Dán link bài đã đăng']) assert.match(t, new RegExp(step));
  assert.match(t, /Soot không đăng lên cộng đồng thay bạn\./);
  assert.ok(d.find('[data-k="cp:title"]') && d.find('[data-k="cp:body"]'));
  type(d.find('#f-url'), 'https://www.reddit.com/r/selfhosted');
  await press(d, d.find('[data-k="save-community"]'));
  assert.equal(acts(d, 'confirm').length, 0, 'not a thread: caught before a call');
  assert.equal(d.find('#f-url').getAttribute('aria-invalid'), 'true');
  // The server's own rule (another subreddit) turns the same hint red in place.
  type(d.find('#f-url'), 'https://www.reddit.com/r/programming/comments/abc123/i_built');
  await press(d, d.find('[data-k="save-community"]'));
  assert.equal(acts(d, 'confirm').length, 1);
  assert.equal(d.find('#f-url')?.getAttribute('aria-invalid'), 'true', 'bad_url stays in the sheet');
  type(d.find('#f-url'), 'https://www.reddit.com/r/selfhosted/comments/abc123/i_built');
  await press(d, d.find('[data-k="save-community"]'));
  const confirm = acts(d, 'confirm').at(-1).input;
  assert.deepEqual([confirm.outcome, confirm.channel, confirm.lang], ['posted', 'community', 'en']);
  assert.equal(d.app.children[1].childNodes.length, 0, 'the sheet closes');
  assert.equal((await w.view({ view: 'item', ref: s.ref })).state, 'posted');
  assert.equal(w.publishes(), 0);
});

test('hubless: a Facebook hand-off on an item whose blog still waits for its slot opens the steps and Lưu link', async () => {
  const w = await world({ hub: false });
  const FB = { channel: 'facebook', lang: 'vi', text: 'Chín bộ tiên hiệp, đọc trên Acme.' };
  const s = await w.call('item_save', { product: 'acme', slug: 'tien-hiep', langs: [{ lang: 'vi', title: 'Chín bộ tiên hiệp nên đọc', summary: 'x', body: 'y' }], posts: [FB] });
  const done = await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [
    { channel: 'blog', lang: 'vi', site: 'acme', slug: 'tien-hiep', revision: s.revision, title: 'Chín bộ tiên hiệp nên đọc' },
    { channel: 'facebook', lang: 'vi', revision: s.revision, text: FB.text },
  ] });
  assert.equal(done.ok, true, JSON.stringify(done));
  const d = await desk(w);
  assert.doesNotMatch(main(d), /Chưa nối marketing hub/);
  const row = d.all('.mk-row').find(r => /bài Facebook chờ bạn đăng tay/.test(text(r)));
  assert.ok(row, main(d));
  await press(d, row.querySelectorAll('button')[0]);
  assert.match(sheet(d), /Đăng tay lên Facebook/);
  type(d.find('#f-url'), 'https://evil.example/x');
  await press(d, d.find('[data-k="save-hand"]'));
  assert.equal(acts(d, 'confirm').length, 0, 'a wrong link is caught before a call');
  type(d.find('#f-url'), 'https://www.facebook.com/acme/posts/123456');
  await press(d, d.find('[data-k="save-hand"]'));
  const c = acts(d, 'confirm');
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].input.channel, c[0].input.lang, c[0].input.outcome], ['facebook', 'vi', 'posted']);
  assert.equal(w.publishes(), 0);
});
