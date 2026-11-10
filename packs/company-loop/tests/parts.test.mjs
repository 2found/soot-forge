// The five parts, awareness levels and moats: tags on opportunities, parts_set, part health, signals {product},
// the page section, and one key per product API (SCOREBOARD_KEYS).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, ITEM, T0, DAY } from './world.mjs';
import { startBoardApi, KEY } from './fixtures.mjs';
import { partHealth, worstPart } from '../tools/lib/parts.mjs';
import { scoreboardKeys, keyFor } from '../tools/lib/products.mjs';
import { MAX_BYTES } from '../tools/lib/signals.mjs';

const PAGE = { page: { page: 'cong-ty' } };
const view = (w, input = {}) => w.call('page_view', input, PAGE);
const act = (w, input) => w.call('page_action', { request_id: 'req-part-0001', ...input }, PAGE);
const prev = { from: '2026-10-26', to: '2026-11-01' }, cur = { from: '2026-11-02', to: '2026-11-08' };
/** A product whose numbers a Soot recorded: signups fell 30%, first payers rose, support threads rose 40% (down is good). */
async function acme(w, product = 'acme') {
  await w.call('metrics_record', { product, period: prev, metrics: [{ key: 'signups', value: 100 }, { key: 'first_payers', value: 10 }, { key: 'support_threads_new', value: 10, good: 'down' }, { key: 'revenue_vnd', value: 1000, unit: 'vnd' }] });
  await w.call('metrics_record', { product, period: cur, metrics: [{ key: 'signups', value: 70, previous: 100 }, { key: 'first_payers', value: 12, previous: 10 }, { key: 'support_threads_new', value: 14, previous: 10, good: 'down' }, { key: 'revenue_vnd', value: 1050, previous: 1000, unit: 'vnd', north_star: true }] });
}

// ---------- tags on opportunities ----------
test('digest_save refuses a content item without awareness and a product without pain or part, naming the field; saves nothing', async () => {
  const w = world();
  const { awareness, ...noAwareness } = ITEM.content;
  const { pain, ...noPain } = ITEM.product;
  const { part, ...noPart } = ITEM.product;
  await assert.rejects(w.call('digest_save', { opportunities: [noAwareness] }), /#1 awareness/);
  await assert.rejects(w.call('digest_save', { opportunities: [noPain] }), /#1 pain/);
  await assert.rejects(w.call('digest_save', { opportunities: [ITEM.content, noPart] }), /#2 part/);
  await assert.rejects(w.call('digest_save', { opportunities: [{ ...ITEM.product, pain: 'ngắn' }] }), /pain 10–200/);
  await assert.rejects(w.call('digest_save', { opportunities: [{ ...ITEM.product, moat: 'lockin' }] }), /moat là một trong/);
  await assert.rejects(w.call('digest_save', { opportunities: [{ ...ITEM.content, awareness: 'nap1' }] }), /awareness là một trong/);
  assert.equal(w.rows('opportunities').length, 0);
});

test('digest_save stores the tags; part and moat reach the decision, awareness reaches the topic; product awareness and content pain are optional', async () => {
  const w = world();
  await w.call('digest_save', { opportunities: [{ ...ITEM.content, pain: 'Người mới tìm truyện không biết bắt đầu từ đâu', moat: 'brand' }, { ...ITEM.product, awareness: 'choosing', moat: 'none' }] });
  const [c, p] = [w.rows('opportunities').find(o => o.kind === 'content'), w.rows('opportunities').find(o => o.kind === 'product')];
  assert.deepEqual([c.part, c.awareness, c.moat, !!c.pain], ['marketing', 'problem', 'brand', true]);
  assert.deepEqual([p.part, p.awareness, p.moat, p.pain], ['delivery', 'choosing', 'none', ITEM.product.pain]);
  const d = w.rows('decisions')[0];
  assert.deepEqual([d.part, d.moat], ['marketing', 'brand']);
  assert.equal(w.rows('topics')[0].awareness, 'problem');
  const { moat, ...noMoat } = ITEM.product;
  await w.call('digest_save', { opportunities: [{ ...noMoat, title: 'Một việc khác không có hào' }] });
  assert.equal(w.rows('opportunities').at(-1).moat, null, 'absent moat is stored as nothing');
  // The founder's Go copies part and moat to the decision log.
  const ref = p.ref;
  await w.call('page_action', { op: 'go', id: ref, request_id: 'req-part-0002' }, PAGE);
  assert.deepEqual(w.rows('decisions').filter(x => x.opportunity_ref === ref).map(x => [x.part, x.moat]), [['delivery', 'none']]);
});

test('topic_next carries awareness, in a chain too, and a topic from before the tag has none', async () => {
  const w = world();
  await w.call('digest_save', { opportunities: [ITEM.content] });
  assert.deepEqual(await w.call('topic_next', { chain: true }), { query: ITEM.content.query, awareness: 'problem' });
  const old = world();
  await old.store.insert('topics', { query: 'truyện cũ chưa gắn nấc', reason: 'x', kind: 'content', state: 'queued' });
  assert.deepEqual(await old.call('topic_next', { chain: true }), { query: 'truyện cũ chưa gắn nấc' });
});

// ---------- parts_set ----------
test('parts_set validates all or none, upserts by product and part, keeps unsent fields and clears with an empty string', async () => {
  const w = world();
  const set = (parts, product = 'acme') => w.call('parts_set', { product, parts }, { soot: 'acme-lead' });
  await assert.rejects(set([{ part: 'sales', team: 'mkt' }, { part: 'oops' }]), /#2 part là một trong/);
  assert.equal(w.rows('parts').length, 0, 'nothing is written when one entry is wrong');
  await assert.rejects(set([{ part: 'sales' }, { part: 'sales' }]), /trùng/);
  await assert.rejects(set([{ part: 'sales', good: 'sideways' }]), /good là up hoặc down/);
  await assert.rejects(set([{ part: 'delivery', promise: 'x'.repeat(121) }]), /promise tối đa 120/);
  await assert.rejects(set([{ part: 'sales', metric: 'Bad Key' }]), /metric là khoá/);
  await assert.rejects(set([]), /1–5/);
  await assert.rejects(set(Array(6).fill({ part: 'sales' })), /1–5/);
  await assert.rejects(set([{ part: 'sales' }], 'Bad Product'), /product là mã/);
  assert.deepEqual((await set([{ part: 'delivery', team: 'cs', team_name: 'CSKH', metric: 'support_threads_new', good: 'down', promise: 'trả lời trong 2 giờ' }, { part: 'sales' }])).saved, ['delivery', 'sales']);
  await set([{ part: 'delivery', promise: 'chương mới trước 8 giờ' }]);
  const row = w.rows('parts').find(r => r.key === 'acme|delivery');
  assert.deepEqual([w.rows('parts').length, row.team, row.team_name, row.metric, row.good, row.promise, row.updated_by], [2, 'cs', 'CSKH', 'support_threads_new', 'down', 'chương mới trước 8 giờ', 'acme-lead']);
  await set([{ part: 'delivery', team: '', team_name: '' }]);
  assert.deepEqual([w.rows('parts').find(r => r.key === 'acme|delivery').team, w.rows('parts').length], [null, 2]);
});

// ---------- part health ----------
test('partHealth: ok, hong (bad move >= 10% and >= 3 units, good=down; never a target alone) and chua_do; an unowned part is chua_giao', () => {
  const tile = (key, value, previous, extra = {}) => ({ key, label: key, unit: 'count', value, previous, pct: previous > 0 ? Math.round(((value - previous) / previous) * 100) : null, good: 'up', target: null, ...extra });
  const board = { north: null, tiles: [tile('revenue_vnd', 1050, 1000), tile('signups', 70, 100), tile('first_payers', 15, 10), tile('support_threads_new', 14, 10, { good: 'down' })] };
  board.north = board.tiles[0];
  const by = items => Object.fromEntries(items.map(x => [x.part, x]));
  const h = by(partHealth([{ part: 'finance', team: 'cfo', team_name: 'Tài chính' }], board));
  assert.deepEqual([h.value.status, h.marketing.status, h.sales.status, h.delivery.status, h.finance.status], ['ok', 'hong', 'ok', 'hong', 'ok']);
  assert.deepEqual([h.marketing.metric, h.sales.metric, h.delivery.metric, h.value.metric], ['signups', 'first_payers', 'support_threads_new', 'revenue_vnd'], 'defaults');
  assert.deepEqual([h.finance.chua_giao, h.finance.team, h.sales.chua_giao], [false, 'cfo', true]);
  // A metric that moved less than 10% the bad way is fine; an explicit metric and direction override the default.
  const mild = by(partHealth([{ part: 'marketing', metric: 'first_payers', good: 'down' }], board));
  assert.equal(mild.marketing.status, 'hong', 'good=down: first payers rising 20% is the bad way');
  assert.equal(by(partHealth([{ part: 'sales', metric: 'revenue_vnd' }], board)).sales.status, 'ok');
  // A target is shown, never a reason: under a stretch target with no bad move is ok.
  const tgt = { ...board, tiles: [tile('revenue_vnd', 900, 900, { target: 1000 })], north: null };
  tgt.north = tgt.tiles[0];
  const f = by(partHealth([], tgt)).finance;
  assert.deepEqual([f.status, f.target], ['ok', 1000]);
  // Small numbers: 2 -> 1 first payers is -50% but one unit: noise, not a broken part.
  const small = { north: null, tiles: [tile('first_payers', 1, 2), tile('signups', 4, 8)] };
  const sm = by(partHealth([], small));
  assert.deepEqual([sm.sales.status, sm.marketing.status], ['ok', 'hong']);
  // No value, no such metric, no board: chua_do, never guessed.
  const empty = { north: null, tiles: [tile('signups', null, null)] };
  assert.equal(by(partHealth([], empty)).marketing.status, 'chua_do');
  assert.equal(by(partHealth([{ part: 'sales', metric: 'nope' }], board)).sales.status, 'chua_do');
  assert.deepEqual(partHealth([], null).map(x => x.status), Array(5).fill('chua_do'));
  assert.equal(worstPart(partHealth([], board)).part, 'delivery', 'the largest bad move (+40% threads, down is good) is named first');
  assert.equal(worstPart(partHealth([], null)), null);
});

// ---------- signals {product} ----------
test('signals {product} reads that product only, carries parts and moats, and stays under 3 KiB', async () => {
  const w = world();
  await acme(w, 'acme'); await acme(w, 'beta');
  await w.call('digest_save', { opportunities: [{ ...ITEM.product, product: 'acme', moat: 'switching' }, { ...ITEM.product, product: 'beta', title: 'Việc của beta khác hẳn', moat: 'brand' }, { ...ITEM.content, product: 'beta' }] });
  const ref = w.rows('opportunities').find(o => o.product === 'acme').ref;
  await w.call('page_action', { op: 'go', id: ref, request_id: 'req-part-0003' }, PAGE);
  await w.call('parts_set', { product: 'acme', parts: [{ part: 'marketing', team: 'mkt' }] });
  const out = await w.call('signals', { product: 'acme' });
  const pk = out.packet;
  assert.equal(pk.product, 'acme');
  assert.deepEqual(pk.waiting.map(x => x.title).filter(t => /beta/.test(t)), []);
  assert.equal(pk.waiting.length, 0, 'acme\'s only product item was taken by Go');
  assert.equal(pk.topics_queued, 0, 'beta\'s topic is not acme\'s');
  assert.deepEqual(pk.decisions.map(d => d.ref), [ref]);
  assert.deepEqual(pk.moats, { switching: 1 });
  const parts = Object.fromEntries(pk.parts.map(x => [x.p, x]));
  assert.deepEqual([parts.marketing.st, parts.marketing.own, parts.marketing.m, parts.sales.own, parts.delivery.st], ['hong', 'mkt', 'signups', null, 'hong']);
  assert.ok(Buffer.byteLength(JSON.stringify(pk)) <= MAX_BYTES);
  assert.equal(pk.metrics.filter(m => m.k === 'signups').length, 1);
  // Without product: as before (the newest board of any product), no filter. An unknown product has no packet.
  assert.equal((await w.call('signals', { product: 'ghost' })).empty, true);
  assert.ok((await w.call('signals', {})).packet.waiting.length >= 1);
});

test('signals keeps parts when the packet is far over 3 KiB: everything else gives way first', async () => {
  const w = world();
  const metrics = Array.from({ length: 30 }, (_, i) => ({ key: `metric_${i}`, value: 10 + i, previous: 5, label: `Số liệu số ${i} ` + 'x'.repeat(30) }));
  await w.call('metrics_record', { product: 'acme', metrics });
  await w.call('metrics_record', { product: 'acme', metrics: [{ key: 'signups', value: 70, previous: 100 }] });
  for (let i = 0; i < 4; i++) await w.call('digest_save', { opportunities: Array.from({ length: 5 }, (_, j) => ({ ...ITEM.product, product: 'acme', title: `Cơ hội rất dài số ${i}-${j} ` + 'x'.repeat(60) })) });
  for (let i = 0; i < 60; i++) await w.store.insert('decisions', { stage: 'gate', opportunity_ref: `OP-${i}`, decision: 'go', by: 'founder', product: 'acme', moat: 'brand', target_outcome: 'signups', expected_delta: 10, at: new Date(T0 + i).toISOString() });
  const pk = (await w.call('signals', { product: 'acme' })).packet;
  assert.ok(Buffer.byteLength(JSON.stringify(pk)) <= MAX_BYTES);
  assert.equal(pk.parts.length, 5);
});

// ---------- the page ----------
test('page_view: the 5 parts of the product, the moats, chips data; part_set changes one by the founder only; a hong part is the next step when nothing is more urgent', async () => {
  const w = world();
  await acme(w);
  await w.call('digest_save', { opportunities: [{ ...ITEM.product, product: 'acme', moat: 'switching' }, { ...ITEM.content, product: 'acme' }] });
  const ref = w.rows('opportunities').find(o => o.kind === 'product').ref;
  const ctx = [{ id: 'acme', name: 'Acme', teams: ['mkt', 'cs'] }];
  let v = await view(w, { product: 'acme', products: ctx });
  assert.equal(v.parts.product, 'acme');
  assert.deepEqual(v.parts.items.map(x => x.part), ['value', 'marketing', 'sales', 'delivery', 'finance']);
  assert.ok(v.parts.items.every(x => x.chua_giao));
  assert.deepEqual(v.parts.teams, [{ id: 'mkt', name: 'mkt' }, { id: 'cs', name: 'cs' }]);
  assert.ok(v.parts.metrics.some(m => m.key === 'signups'));
  const o = v.opportunities.find(x => x.ref === ref);
  assert.deepEqual([o.part, o.moat, o.pain], ['delivery', 'switching', ITEM.product.pain]);
  assert.equal(v.opportunities.find(x => x.kind === 'content').awareness, 'problem');
  assert.deepEqual(v.next, { code: 'choose', n: 1 }, 'a real ask outranks a broken part');
  await w.call('page_action', { op: 'go', id: ref, request_id: 'req-part-0004' }, PAGE);
  assert.deepEqual((await view(w, { product: 'acme', products: ctx })).moats, { switching: 1 });
  // Nothing is waiting any more and the build is not running (no repo): the broken part is named.
  const task = (await view(w, { product: 'acme', products: ctx }));
  assert.equal(task.next.code, 'task', 'a task for a person is still more urgent');
  await w.call('page_action', { op: 'task_done', id: ref, request_id: 'req-part-0005' }, PAGE);
  v = await view(w, { product: 'acme', products: ctx });
  assert.deepEqual([v.next.code, v.next.part], ['part_hong', 'delivery']);
  // The founder changes the owner, the metric and the promise.
  const out = await act(w, { op: 'part_set', product: 'acme', part: 'delivery', team: 'cs', team_name: 'CSKH', metric: 'support_threads_new', good: 'down', promise: 'trả lời trong 2 giờ' });
  assert.equal(out.ok, true);
  assert.equal(w.rows('parts')[0].updated_by, 'founder');
  const d = (await view(w, { product: 'acme', products: ctx })).parts.items.find(x => x.part === 'delivery');
  assert.deepEqual([d.team, d.team_name, d.chua_giao, d.promise, d.status, d.metric], ['cs', 'CSKH', false, 'trả lời trong 2 giờ', 'hong', 'support_threads_new']);
  // Not on the page (a model call): refused. A wrong part: refused with the field named.
  await assert.rejects(w.call('page_action', { op: 'part_set', product: 'acme', part: 'sales', team: 'x', request_id: 'req-part-0006' }), /Chỉ trang Công ty/);
  await assert.rejects(act(w, { op: 'part_set', product: 'acme', part: 'oops' }), /part là một trong/);
  // A product with no numbers: all five are "chưa đo", not fine.
  const none = await view(w, { product: 'ghost' });
  assert.deepEqual(none.parts.items.map(x => x.status), Array(5).fill('chua_do'));
});

test('page_view: with several products and none chosen there is no parts section; old rows without tags read as unset', async () => {
  const w = world();
  await acme(w, 'acme'); await acme(w, 'beta');
  const v = await view(w, {});
  assert.equal(v.parts, null);
  await w.store.insert('opportunities', { ref: 'OP-00000009', title: 'Cơ hội cũ', product: 'acme', kind: 'product', state: 'proposed' });
  await w.store.insert('decisions', { at: new Date(T0).toISOString(), opportunity_ref: 'OP-00000009', product: 'acme', decision: 'go', by: 'founder' });
  const one = await view(w, { product: 'acme' });
  assert.deepEqual([one.opportunities[0].part, one.opportunities[0].pain, one.decisions[0].moat], [null, null, null]);
  assert.deepEqual(one.moats, {});
});

// ---------- SCOREBOARD_KEYS: one key per product API ----------
const OTHER_KEY = 'beta-product-key-1234';
const home = await startBoardApi();
const beta = await startBoardApi({ key: OTHER_KEY });
after(() => { home.close(); beta.close(); });

test('a mapped source sends its own key; one without an entry sends none; the single SCOREBOARD_URL keeps PRODUCT_ADMIN_KEY', async () => {
  home.calls.length = 0; beta.calls.length = 0;
  const w = world({ env: { SCOREBOARD_URL: home.url, PRODUCT_ADMIN_KEY: KEY, SCOREBOARD_URLS: `beta=${beta.url}`, SCOREBOARD_KEYS: `beta=${OTHER_KEY}` } });
  const out = await w.call('scoreboard_sync');
  assert.equal(out.done, true);
  assert.ok(home.calls.length && home.calls.every(c => c.key === KEY), 'the legacy source uses PRODUCT_ADMIN_KEY');
  assert.ok(beta.calls.length && beta.calls.every(c => c.key === OTHER_KEY), 'a mapped source uses its own key');
  assert.ok(!home.calls.some(c => c.key === OTHER_KEY) && !beta.calls.some(c => c.key === KEY), 'no key crosses to another product');

  home.calls.length = 0; beta.calls.length = 0;
  const bare = world({ env: { SCOREBOARD_URL: home.url, PRODUCT_ADMIN_KEY: KEY, SCOREBOARD_URLS: `beta=${beta.url}` } });
  const r = await bare.call('scoreboard_sync');
  assert.ok(beta.calls.length && beta.calls.every(c => c.key === null), 'no entry, no X-API-Key header, and PRODUCT_ADMIN_KEY is not the fallback');
  assert.deepEqual(r.sources.map(s => [s.product ?? 'host', s.ok]), [['lohi', true], ['beta', false]]);
  const v = await view(bare, { product: 'beta', host: 'lohi' });
  assert.equal(v.next.code, 'key_refused');
  assert.match(bare.rows('state').find(s => s.key === 'sync:beta').value.message, /sản phẩm beta/);
  assert.ok(!JSON.stringify(v).includes(OTHER_KEY) && !JSON.stringify(r).includes(KEY));

  // Only mapped keys and no PRODUCT_ADMIN_KEY: still runs (the legacy source sends none).
  const onlyKeys = world({ env: { SCOREBOARD_URLS: `beta=${beta.url}`, SCOREBOARD_KEYS: `beta=${OTHER_KEY}` } });
  assert.equal((await onlyKeys.call('scoreboard_sync')).done, true);
  assert.equal((await world({ env: { SCOREBOARD_URLS: `beta=${beta.url}` } }).call('scoreboard_sync')).skipped, true, 'no key at all is still a quiet skip');
});

test('SCOREBOARD_KEYS: a malformed or duplicate entry is skipped and counted; keyFor never falls back for a mapped source', async () => {
  const { keys, bad } = scoreboardKeys({ SCOREBOARD_KEYS: `beta=${OTHER_KEY}\nnokey, =abc12345678, Bad Id=abcdefgh1234, gamma=short, beta=another-key-12345,delta=has space1234` });
  assert.deepEqual([...keys.keys()], ['beta']);
  assert.equal(bad, 6);
  assert.equal(keyFor({ legacy: true, product: null }, { PRODUCT_ADMIN_KEY: KEY }), KEY);
  assert.equal(keyFor({ legacy: false, product: 'beta' }, { PRODUCT_ADMIN_KEY: KEY }), null);
  const w = world({ env: { SCOREBOARD_URL: home.url, PRODUCT_ADMIN_KEY: KEY, SCOREBOARD_KEYS: 'broken' } });
  assert.equal((await view(w, {})).setup.bad_keys, 1);
});
