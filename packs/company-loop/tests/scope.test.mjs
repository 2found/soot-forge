// Every tool that used to assume one product takes an optional `product` that defaults to the run's SOOT_PRODUCT, and works
// per product. With neither, a single-product deployment behaves as before (the other test files).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, ITEM, DAY } from './world.mjs';
import { startBoardApi, KEY } from './fixtures.mjs';

const OTHER_KEY = 'novel-product-key-1234';
const home = await startBoardApi();
const novel = await startBoardApi({ key: OTHER_KEY });
novel.over = { product: '2novel' };
after(() => { home.close(); novel.close(); });
const env = { SCOREBOARD_URL: home.url, PRODUCT_ADMIN_KEY: KEY, SCOREBOARD_URLS: `2novel=${novel.url}`, SCOREBOARD_KEYS: `2novel=${OTHER_KEY}` };
const page = { page: { page: 'cong-ty' } };

test('scoreboard_sync: product (input or SOOT_PRODUCT) reads only that product\'s source; none reads all', async () => {
  home.calls.length = 0; novel.calls.length = 0;
  const w = world({ env });
  const one = await w.call('scoreboard_sync', { product: '2novel' });
  assert.equal(one.done, true);
  assert.ok(novel.calls.length && !home.calls.length, 'only the 2novel board was fetched');
  assert.deepEqual(w.rows('scoreboard').map(r => r.product), ['2novel']);
  assert.ok(novel.calls.every(c => c.key === OTHER_KEY));
  // The run's own product does the same without the model saying it; the single SCOREBOARD_URL is the host's.
  novel.calls.length = 0;
  const run = world({ env: { ...env, SOOT_PRODUCT: 'lohi' } });
  await run.call('scoreboard_sync');
  assert.ok(home.calls.length && !novel.calls.length, 'the host board only');
  // Everything, as before.
  novel.calls.length = 0; home.calls.length = 0;
  await world({ env }).call('scoreboard_sync');
  assert.ok(home.calls.length && novel.calls.length);
});

test('scoreboard_sync: a product with no source is a quiet skip naming it; a malformed product is refused', async () => {
  home.calls.length = 0; novel.calls.length = 0;
  const w = world({ env });
  await w.call('scoreboard_sync');
  const out = await w.call('scoreboard_sync', { product: 'trysoot' });
  assert.deepEqual([out.skipped, out.reason, out.product, out.notify], [true, 'no_source_for_product', 'trysoot', false]);
  await assert.rejects(w.call('scoreboard_sync', { product: 'Not A Product' }), /product là mã sản phẩm/);
});

test('digest_save: the digest\'s product fills items that omit theirs; an item of another product is refused (all or none)', async () => {
  const w = world({ env: { ...env, SOOT_PRODUCT: '2novel' } });
  const { product, ...bare } = ITEM.content;
  const ok = await w.call('digest_save', { opportunities: [bare] });
  assert.equal(ok.saved.length, 1);
  assert.equal(w.rows('opportunities')[0].product, '2novel');
  assert.equal(w.rows('topics')[0].product, '2novel');
  await assert.rejects(w.call('digest_save', { opportunities: [{ ...bare, title: 'Mục khác của 2novel' }, ITEM.product] }), /#2 product lohi không phải 2novel/);
  assert.equal(w.rows('opportunities').length, 1, 'nothing of the refused batch was saved');
  // An explicit input product wins over nothing and is checked the same way.
  const free = world();
  await free.call('digest_save', { product: 'lohi', opportunities: [{ ...bare }] });
  assert.equal(free.rows('opportunities')[0].product, 'lohi');
  // Without any product, an item still needs its own (single-product deployments unchanged).
  await assert.rejects(free.call('digest_save', { opportunities: [{ ...bare, title: 'Không có sản phẩm nào' }] }), /product là mã sản phẩm/);
});

test('opportunities_card and topic_next serve one product; the card of one product never settles another\'s', async () => {
  const w = world({ env });
  await w.call('digest_save', { opportunities: [ITEM.product, { ...ITEM.product, product: '2novel', title: 'Dịch lại chương lỗi tự động' }, ITEM.content, { ...ITEM.content, product: '2novel', title: 'Truyện ngôn tình dịch full', query: 'truyện ngôn tình dịch' }] });
  const all = await w.call('opportunities_card');
  assert.equal(all.waiting, 2);
  const lohi = await w.call('opportunities_card', { product: 'lohi' });
  const novel2 = await w.call('opportunities_card', { product: '2novel' });
  assert.deepEqual([lohi.waiting, novel2.waiting], [1, 1]);
  assert.equal(lohi.raise.group, 'company:proposals:lohi');
  assert.notEqual(lohi.raise.id, novel2.raise.id);
  await w.call('decide', { id: w.rows('opportunities').find(o => o.product === '2novel' && o.kind === 'product').ref, decision: 'later' });
  const after2 = await w.call('opportunities_card', { product: '2novel' });
  assert.deepEqual(after2.settle, ['company:proposals:2novel']);
  assert.equal((await w.call('opportunities_card', { product: 'lohi' })).waiting, 1, 'lohi still waits');
  // topic_next hands out the product's own topic.
  const t = await w.call('topic_next', { product: '2novel' });
  assert.equal(t.query, 'truyện ngôn tình dịch');
  assert.equal((await w.call('topic_next', { product: '2novel' })).query, undefined, 'no other 2novel topic queued');
  assert.equal((await w.call('topic_next', {})).query, 'truyện tiên hiệp full');
});

test('review: a product scores only its own decisions', async () => {
  const w = world({ env });
  await w.call('scoreboard_sync');
  await w.call('digest_save', { opportunities: [ITEM.content, { ...ITEM.content, product: '2novel', title: 'Truyện ngôn tình dịch full', query: 'truyện ngôn tình dịch' }] });
  w.now += 40 * DAY;
  const out = await w.call('review', { product: '2novel' });
  assert.ok(!JSON.stringify(out).includes('truyện tiên hiệp'));
  const open = w.rows('decisions').filter(d => !d.reviewed_at);
  assert.equal(open.length, 2, 'content posts wait for their own signal; nothing of lohi was touched');
  assert.equal(out.waiting, 1, 'only the 2novel decision was looked at');
});

test('metrics_record and parts_set default their product to SOOT_PRODUCT; with neither they refuse', async () => {
  const w = world({ env: { SOOT_PRODUCT: 'acme' } });
  const rec = await w.call('metrics_record', { period: { from: '2026-11-02', to: '2026-11-08' }, metrics: [{ key: 'mrr_usd', value: 10 }] });
  assert.equal(rec.product, 'acme');
  const set = await w.call('parts_set', { parts: [{ part: 'value', team: 'insight' }] });
  assert.equal(set.product, 'acme');
  const bare = world();
  await assert.rejects(bare.call('metrics_record', { metrics: [{ key: 'mrr_usd', value: 10 }] }), /product là mã sản phẩm/);
  await assert.rejects(bare.call('parts_set', { parts: [{ part: 'value' }] }), /product là mã sản phẩm/);
});

test('signals and page_view default to the run\'s product; the page narrows and says what it left out', async () => {
  const w = world({ env });
  await w.call('scoreboard_sync');
  await w.call('digest_save', { opportunities: [ITEM.product, { ...ITEM.product, product: '2novel', title: 'Dịch lại chương lỗi tự động' }] });
  const run = w;
  run.env.SOOT_PRODUCT = '2novel';
  const sig = await run.call('signals');
  assert.equal(sig.packet.product, '2novel');
  assert.deepEqual(sig.packet.waiting.map(x => x.title), ['Dịch lại chương lỗi tự động']);
  const view = await run.call('page_view', {}, page);
  assert.equal(view.scope.product.id, '2novel');
  assert.equal(view.scope.left_out.opportunities, 1);
});

test('team_watch and goals_checkin accept a product and ignore the others', async () => {
  const w = world({ env: { ...env, BBS_BIN: '/nonexistent/bbs' } });
  await w.store.insert('handoffs', { opportunity: 'OP-00000001', product: 'lohi', repo: '/tmp/x', state: 'building', team_id: 'loop-op-00000001' });
  // bbs is absent: a product with no rows of its own is done before it needs bbs.
  assert.deepEqual(await w.call('team_watch', { product: '2novel' }), { done: true });
  assert.equal((await w.call('team_watch', { product: 'lohi' })).note, 'bbs_missing');
  const g = await w.call('goals_checkin', { product: '2novel' });
  assert.equal(g.reason_code, 'goals_unreadable', 'no runtime token: quiet skip, whatever the product');
});
