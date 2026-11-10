// Products (storage v4): rows carry their product, old rows belong to the host's, the page narrows to one product and
// says what it leaves out, one or many scoreboard sources, numbers a Soot records, labels and units from the data.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { world, ITEM, DAY } from './world.mjs';
import { startBoardApi, fakeBbs, scratchRepo, KEY } from './fixtures.mjs';
import { scoreboardSources, northStarOf, adoptProducts } from '../tools/lib/products.mjs';

const api = await startBoardApi();
const other = await startBoardApi();
other.over = { product: 'ignored-label', metrics: { revenue_vnd: { label: 'Doanh thu', unit: 'vnd', value: 300_000, previous: 400_000 }, signups: { label: 'x', unit: 'count', value: 40, previous: 38 } } };
after(() => { api.close(); other.close(); });
const PAGE = { page: { page: 'cong-ty' } };
const view = (w, input = {}) => w.call('page_view', input, PAGE);
const act = (w, input) => w.call('page_action', input, PAGE);
const SACH = { ...ITEM.product, title: 'Gói đọc thử 3 ngày', product: 'sach-hay', summary: 'Cho người mới đọc thử ba ngày trước khi trả tiền để tăng người nạp lần đầu.', target_outcome: 'first_payers', expected_delta: 4 };
const CTX = [{ id: 'lohi', name: 'Lohi', teams: ['company', 'marketing'] }, { id: 'sach-hay', name: 'Sách Hay', teams: ['sach-marketing'] }];

test('sources: SCOREBOARD_URL stays the single source with its old keys; SCOREBOARD_URLS adds one per product, a bad entry is skipped', () => {
  const { sources, bad } = scoreboardSources({ SCOREBOARD_URL: 'https://a.example/s', SCOREBOARD_URLS: 'sach-hay=https://b.example/s\nnope, x=http://evil.example/s,sach-hay=https://c.example/s' });
  assert.deepEqual(sources.map(s => [s.product, s.url.host, s.legacy]), [[null, 'a.example', true], ['sach-hay', 'b.example', false]]);
  assert.equal(bad.length, 3, 'no "=", plain http to another host, a second entry for the same product');
  assert.equal(northStarOf({ NORTH_STAR: 'signups,sach-hay=first_payers' }, 'sach-hay'), 'first_payers');
  assert.equal(northStarOf({ NORTH_STAR: 'signups,sach-hay=first_payers' }, 'lohi'), 'signups');
  assert.equal(northStarOf({}, 'lohi'), null);
});

test('back-compat: rows from storage v3 have no product; they read as the host product, are labeled on the next sync, never dropped', async () => {
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY } });
  // What a v3 install left: an opportunity with a product, its decision, handoff and topic without one, and a decision
  // whose opportunity is gone.
  await w.store.insert('opportunities', { ref: 'OP-AAAA0001', title: 'Cũ', product: 'lohi', kind: 'product', state: 'go', summary: 's', target_outcome: 'signups', expected_delta: 5, check_after_days: 7 });
  await w.store.insert('decisions', { at: new Date(w.now - DAY).toISOString(), stage: 'gate', opportunity_ref: 'OP-AAAA0001', decision: 'go', by: 'founder', target_outcome: 'signups', expected_delta: 5, check_after_days: 7 });
  await w.store.insert('decisions', { at: new Date(w.now - DAY).toISOString(), stage: 'gate', opportunity_ref: 'OP-GONE0000', decision: 'drop', by: 'founder', target_outcome: 'signups', expected_delta: 5, check_after_days: 7 });
  await w.store.insert('handoffs', { opportunity: 'OP-AAAA0001', state: 'no_repo', repo: null, note: 'old' });
  await w.store.insert('topics', { query: 'cũ', opportunity_ref: 'OP-GONE0000', kind: 'content', state: 'written' });
  assert.ok([...w.rows('decisions'), ...w.rows('handoffs'), ...w.rows('topics')].every(r => r.product === null));

  // Before any sync the host is unknown: the opportunity's product still places its rows; the orphan is "unlabeled".
  let v = await view(w, { product: 'lohi' });
  assert.equal(v.decisions.length, 1);
  assert.equal(v.scope.unlabeled, 2);
  // Nest's context names the host: the orphans belong to it, in the view, with nothing written by a read tool.
  v = await view(w, { product: 'lohi', host: 'lohi' });
  assert.deepEqual([v.decisions.length, v.handoffs.length, v.topics.length, v.scope.unlabeled], [2, 1, 1, 0]);
  assert.equal(v.handoffs[0].state, 'task', 'no_repo with no repo is a task');
  assert.ok(w.rows('decisions').every(r => r.product === null), 'a read tool labels nothing');

  // The single SCOREBOARD_URL sync learns the host from its board (product "lohi") and labels the old rows.
  const out = await w.call('scoreboard_sync');
  assert.equal(out.done, true);
  assert.equal(w.rows('state').find(r => r.key === 'host_product').value, 'lohi');
  assert.ok(w.rows('state').find(r => r.key === 'sync'), 'the single source keeps its sync key');
  assert.match(w.rows('scoreboard')[0].key, /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/, 'and its row key');
  assert.deepEqual([...w.rows('decisions'), ...w.rows('handoffs'), ...w.rows('topics')].map(r => r.product), ['lohi', 'lohi', 'lohi', 'lohi']);
  assert.equal(w.rows('decisions').length, 2, 'nothing dropped');
  assert.equal(await adoptProducts(w.store, 'lohi'), 0, 'idempotent');
  // Without any context (an older Nest), the page shows every product and its one board, as before.
  v = await view(w);
  assert.equal(v.scope.product, null);
  assert.equal(v.scoreboard.product, 'lohi');
  assert.equal(v.boards, null);
});

test('new rows carry their product; scope narrows every section and counts what it leaves out', async () => {
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, SCOREBOARD_URLS: `sach-hay=${other.url}`, SCOREBOARD_KEYS: `sach-hay=${KEY}`, PRODUCT_REPO: scratchRepo(), BBS_BIN: fakeBbs().bin } });
  await w.call('scoreboard_sync');
  await w.call('digest_save', { opportunities: [ITEM.content, ITEM.product, SACH] });
  const sachRef = w.rows('opportunities').find(o => o.product === 'sach-hay').ref;
  await act(w, { op: 'go', id: sachRef, request_id: 'req-go-sach1' });
  assert.equal(w.rows('handoffs')[0].product, 'sach-hay');
  assert.ok(w.rows('decisions').every(d => d.product), 'every decision names its product');
  assert.equal(w.rows('topics')[0].product, 'lohi');

  const lohi = await view(w, { product: 'lohi', host: 'lohi', products: CTX });
  assert.deepEqual(lohi.scope.product, { id: 'lohi', name: 'Lohi' });
  assert.ok(lohi.opportunities.every(o => o.product === 'lohi') && lohi.opportunities.length === 2);
  assert.equal(lohi.handoffs.length, 0);
  assert.deepEqual(lohi.scope.left_out, { opportunities: 1, handoffs: 1, decisions: 1, topics: 0 });
  assert.equal(lohi.scoreboard.north.key, 'revenue_vnd');
  assert.equal(lohi.scoreboard.north.value, 1_200_000);
  assert.deepEqual([lohi.next.code, lohi.next.n], ['choose', 1]);

  const sach = await view(w, { product: 'sach-hay', host: 'lohi', products: CTX });
  assert.equal(sach.scoreboard.north.value, 300_000, 'the mapped source feeds its own product');
  assert.equal(sach.scoreboard.product, 'sach-hay');
  assert.equal(sach.handoffs[0].product, 'sach-hay');
  assert.equal(sach.next.code, 'building');
  assert.ok(w.rows('scoreboard').some(r => r.key.startsWith('sach-hay|') && r.product === 'sach-hay'), 'the mapping wins over the board label');
  assert.ok(w.rows('state').some(r => r.key === 'sync:sach-hay'));

  // Every product: one compact board per product, a name from Nest, the waiting count per product for the switch.
  const all = await view(w, { host: 'lohi', products: CTX });
  assert.equal(all.scoreboard, null);
  assert.deepEqual(all.boards.map(b => [b.product, b.name, b.north.key]), [['lohi', 'Lohi', 'revenue_vnd'], ['sach-hay', 'Sách Hay', 'revenue_vnd']]);
  assert.ok(all.boards.every(b => b.tiles.length <= 3 && !b.tiles.some(t => t.key === b.north.key)));
  assert.deepEqual(all.scope.products.map(p => [p.id, p.waiting]), [['lohi', 1], ['sach-hay', 0]]);
  assert.deepEqual(all.scope.left_out, { opportunities: 0, handoffs: 0, decisions: 0, topics: 0 });

  // A product Nest knows with nothing here: no_data, and the other products' rows are counted, not shown.
  const empty = await view(w, { product: 'moi', host: 'lohi', products: [...CTX, { id: 'moi', name: 'Mới', teams: [] }] });
  assert.equal(empty.next.code, 'no_data');
  assert.equal(empty.scoreboard, null);
  assert.equal(empty.scope.left_out.opportunities, 3);
});

test('a refused key on one product source is that product\'s next step, not the other\'s', async () => {
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, SCOREBOARD_URLS: `sach-hay=${other.url}`, SCOREBOARD_KEYS: `sach-hay=${KEY}` } });
  other.mode = 'forbidden';
  try {
    const out = await w.call('scoreboard_sync');
    assert.equal(out.done, true, 'one source still read');
    assert.deepEqual(out.sources.map(s => [s.product ?? 'lohi', s.ok]), [['lohi', true], ['sach-hay', false]]);
    assert.equal((await view(w, { product: 'sach-hay', host: 'lohi' })).next.code, 'key_refused');
    assert.equal((await view(w, { product: 'lohi', host: 'lohi' })).next.code, 'idle');
    // Loop health says the failing mapped source too, not only the single SCOREBOARD_URL's state.
    await w.call('health_sync', { inputs: [] });
    const sb = w.store.data.state.find(r => r.key === 'health').value.inputs.find(i => i.key === 'scoreboard');
    assert.equal(sb.starving, true);
    assert.match(sb.detail, /agent_mod/);
  } finally { other.mode = 'ok'; }
});

test('no scoreboard address: a Soot records numbers (metrics_record) with its own labels, units, targets and north star', async () => {
  const w = world({ env: {} });
  assert.equal((await view(w)).next.code, 'setup');
  assert.equal((await w.call('scoreboard_sync')).skipped, true, 'no address is still a quiet skip');
  const prev = { from: '2026-10-26', to: '2026-11-01' }, cur = { from: '2026-11-02', to: '2026-11-08' };
  await w.call('metrics_record', { product: 'acme', period: prev, metrics: [{ key: 'mrr_usd', value: 9000, unit: 'usd', label: 'MRR' }] });
  const out = await w.call('metrics_record', { product: 'acme', period: cur, source: 'Stripe export', metrics: [
    { key: 'mrr_usd', value: 9900, unit: 'usd', label: 'MRR', target: 12000, north_star: true },
    { key: 'churn_pct', value: 3.1, previous: 2.5, unit: 'percent', label: 'Churn', good: 'down' },
    { key: 'signups', value: 50, previous: 40 },
  ] }, { soot: 'acme-lead' });
  assert.deepEqual(out, { ok: true, saved: 3, product: 'acme', period: '2026-11-02..2026-11-08' });
  const v = await view(w, { product: 'acme' });
  assert.equal(v.setup.table, true);
  assert.notEqual(v.next.code, 'part_hong', 'a north star under a stretch target is not a broken part');
  const b = v.scoreboard;
  assert.equal(b.source, 'table');
  assert.equal(b.recorded_source, 'Stripe export');
  assert.deepEqual([b.north.key, b.north.label, b.north.unit, b.north.value, b.north.previous, b.north.pct, b.north.target], ['mrr_usd', 'MRR', 'usd', 9900, 9000, 10, 12000]);
  const churn = b.tiles.find(t => t.key === 'churn_pct');
  assert.deepEqual([churn.label, churn.unit, churn.good, churn.pct], ['Churn', 'percent', 'down', 24]);
  assert.equal(b.tiles.find(t => t.key === 'signups').label, 'Đăng ký mới', 'a contract key keeps its default words');
  // Writing the same period again replaces it, one row per metric.
  await w.call('metrics_record', { product: 'acme', period: cur, metrics: [{ key: 'signups', value: 55 }] });
  assert.equal(w.rows('metrics').filter(r => r.metric === 'signups').length, 1);
  assert.equal(w.rows('metrics').find(r => r.metric === 'mrr_usd' && r.period_to === cur.to).recorded_by, 'acme-lead');
  // The digest reads the recorded board when there is no address.
  const sig = await w.call('signals');
  assert.ok(sig.packet.metrics.some(m => m.k === 'mrr_usd' && m.u === 'usd'));
  // NORTH_STAR wins over the recorded flag.
  w.env.NORTH_STAR = 'acme=signups';
  assert.equal((await view(w, { product: 'acme' })).scoreboard.north.key, 'signups');
  await assert.rejects(w.call('metrics_record', { product: 'Acme!', metrics: [{ key: 'x', value: 1 }] }), /product/);
  await assert.rejects(w.call('metrics_record', { product: 'acme', metrics: [{ key: 'x', value: 'many' }, { key: 'x', value: 1 }] }), /tất cả hoặc không/);
  await assert.rejects(w.call('metrics_record', { product: 'acme', period: { from: '2026-01-01', to: '2026-03-01' }, metrics: [{ key: 'x', value: 1 }] }), /31 ngày/);
  for (const bad of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-11-02', to: '2026-13-01' }]) await assert.rejects(w.call('metrics_record', { product: 'acme', period: bad, metrics: [{ key: 'x', value: 1 }] }), /31 ngày/);
});

test('a recorded north star gets a trend from weekly periods; a period in the HTTP board is filled by recorded keys it lacks', async () => {
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY } });
  for (let k = 4; k >= 0; k--) {
    const to = new Date(Date.parse('2026-11-08T00:00:00Z') - k * 7 * DAY).toISOString().slice(0, 10);
    const from = new Date(Date.parse(to) - 6 * DAY).toISOString().slice(0, 10);
    await w.call('metrics_record', { product: 'acme', period: { from, to }, metrics: [{ key: 'orders', value: 10 + k, north_star: true }] });
  }
  const v = await view(w, { product: 'acme' });
  assert.deepEqual(v.scoreboard.north.trend, [14, 13, 12, 11, 10]);
  await w.call('scoreboard_sync');
  const { from, to } = { from: w.rows('scoreboard')[0].period_from, to: w.rows('scoreboard')[0].period_to };
  await w.call('metrics_record', { product: 'lohi', period: { from, to }, metrics: [{ key: 'nps', value: 41, label: 'NPS' }, { key: 'signups', value: 1 }] });
  const lohi = (await view(w, { product: 'lohi', host: 'lohi' })).scoreboard;
  assert.equal(lohi.source, 'both');
  assert.equal(lohi.tiles.find(t => t.key === 'signups').value, 120, 'the HTTP number wins for a key it has');
  assert.equal(lohi.tiles.find(t => t.key === 'nps').label, 'NPS');
});

test('loop health narrows to the product\'s teams (shared teams stay); stage health without teams says it is shared', async () => {
  const w = world({ env: {} });
  const stages = [{ key: 'company', label: 'Công ty' }, { key: 'marketing', label: 'Marketing' }, { key: 'sach-marketing', label: 'Sách marketing' }, { key: 'ops', label: 'Vận hành' }];
  await w.store.insert('state', { key: 'health', value: { at: new Date(w.now).toISOString(), stages, inputs: [], runtime: { via: 'teams' }, effort: {} } });
  await w.call('metrics_record', { product: 'lohi', metrics: [{ key: 'signups', value: 1 }] });
  const h = (await view(w, { product: 'sach-hay', products: CTX })).health;
  assert.deepEqual([h.split, h.left_out, h.stages.map(s => s.key)], ['product', 2, ['sach-marketing', 'ops']]);
  assert.equal((await view(w, { products: CTX })).health.stages.length, 4);
  await w.store.update('state', [{ column: 'key', op: 'eq', value: 'health' }], { value: { at: new Date(w.now).toISOString(), stages, inputs: [], runtime: { via: 'schedules' }, effort: {} } });
  const legacy = (await view(w, { product: 'sach-hay', products: CTX })).health;
  assert.equal(legacy.split, 'shared');
  assert.equal(legacy.stages.length, 4);
});

test('decisions carry their verdict: hit, miss, waiting with its check day, or waiting for the release', async () => {
  const w = world({ env: {} });
  await w.call('metrics_record', { product: 'lohi', metrics: [{ key: 'signups', value: 1 }] });
  const at = new Date(w.now - 10 * DAY).toISOString();
  await w.store.insert('opportunities', { ref: 'OP-00000001', title: 'Trúng', product: 'lohi', kind: 'content', state: 'go' });
  await w.store.insert('opportunities', { ref: 'OP-00000002', title: 'Chờ phát hành', product: 'lohi', kind: 'product', state: 'go' });
  await w.store.insert('decisions', { at, product: 'lohi', opportunity_ref: 'OP-00000001', decision: 'go', by: 'soot', expected_delta: 10, actual_delta: 6, check_after_days: 7, reviewed_at: at });
  await w.store.insert('decisions', { at, product: 'lohi', opportunity_ref: 'OP-00000002', decision: 'go', by: 'founder', expected_delta: 10, check_after_days: 30 });
  await w.store.insert('handoffs', { opportunity: 'OP-00000002', product: 'lohi', state: 'building' });
  const d = (await view(w, { product: 'lohi' })).decisions;
  assert.deepEqual(d.map(x => [x.ref, x.verdict, x.from ?? null]), [['OP-00000002', 'waiting', 'release'], ['OP-00000001', 'hit', null]]);
  await w.store.update('handoffs', [{ column: 'opportunity', op: 'eq', value: 'OP-00000002' }], { released_at: new Date(w.now).toISOString() });
  const after = (await view(w, { product: 'lohi' })).decisions[0];
  assert.equal(after.check_at, new Date(w.now + 30 * DAY).toISOString());
});
