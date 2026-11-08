// signals (compact packet, ≤ 3 KiB, CS optional), page_view next step codes, and the pack's shape.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { world, ITEM } from './world.mjs';
import { startBoardApi, startCsApi, addNotes, fakeBbs, scratchRepo, KEY } from './fixtures.mjs';
import { MAX_BYTES } from '../tools/lib/signals.mjs';

const api = await startBoardApi();
const cs = await startCsApi();
after(() => { api.close(); cs.close(); });
const mk = (extra = {}) => world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: KEY, PRODUCT_REPO: scratchRepo(), BBS_BIN: fakeBbs().bin, ...extra } });
const view = (w) => w.call('page_view', {}, { page: { page: 'cong-ty' } });

test('signals without any scoreboard is a quiet stop, not a wake', async () => {
  const out = await mk().call('signals');
  assert.deepEqual([out.done, out.empty, out.notify, out.wake], [true, true, undefined, undefined]);
});

test('signals is a packet under 3 KiB that wakes the Lead; CS gaps are optional and quiet when unset', async () => {
  const w = mk();
  await w.call('scoreboard_sync');
  await w.call('digest_save', { opportunities: [ITEM.content, ITEM.product] });
  const out = await w.call('signals');
  assert.deepEqual([out.notify, out.wake], [true, true]);
  assert.ok(Buffer.byteLength(JSON.stringify(out.packet)) <= MAX_BYTES);
  assert.equal(out.packet.cs_gaps, undefined);
  assert.equal(out.packet.cs_error, undefined);
  assert.equal(out.packet.waiting.length, 1);
  assert.equal(out.packet.topics_queued, 1);
  assert.ok(out.packet.metrics.find(m => m.k === 'signups'));
  assert.ok(!JSON.stringify(out.packet).includes(KEY));
});

test('with a CS runtime the open knowledge gaps join, by count; a refused token is a short code, never a failure', async () => {
  const w = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'cs-token' });
  await w.call('scoreboard_sync');
  assert.deepEqual((await w.call('signals')).packet.cs_gaps, [{ t: 'Hoàn tiền sau 7 ngày', n: 5 }, { t: 'Đổi email', n: 2 }]);
  const bad = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'wrong' });
  await bad.call('scoreboard_sync');
  const out = await bad.call('signals');
  assert.ok(out.packet.cs_error);
  assert.equal(out.notify, true);
});

test('CS feedback: counts by kind and up to five scrubbed samples, within 1 KiB; old notes and other Soots are left out', async () => {
  cs.sessions = []; cs.messages = {};
  addNotes(cs, [
    ['feature_request', 'Muốn đọc offline cả bộ, liên hệ an@example.com hoặc 0912 345 678'],
    ['feature_request', 'Muốn chế độ tối cho web https://lohi2.com/x?token=abc'],
    ['feature_request', 'Muốn đọc offline cả bộ, liên hệ an@example.com hoặc 0912 345 678'],
    ['bug', 'Audio Pro ngắt giữa chương, đơn LOHI7F3A9 chưa vào'],
    ['complaint', 'Giá gói quá cao ' + 'x'.repeat(200)],
    ['question', 'Hỏi cách chuyển tài khoản'],
    ['bug', 'cũ', { created: '2026-09-01T00:00:00Z' }],
    ['bug', 'của Soot khác', { soot: 'support' }],
  ]);
  for (let i = 0; i < 12; i++) addNotes(cs, [['feedback', `Góp ý số ${i} ` + 'y'.repeat(50)]]);
  const w = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'cs-token' });
  await w.call('scoreboard_sync');
  const out = await w.call('signals');
  const fb = out.packet.cs_feedback;
  assert.deepEqual([fb.n.feature_request, fb.n.bug, fb.n.complaint, fb.n.question, fb.n.feedback], [3, 1, 1, 1, 12]);
  assert.ok(Buffer.byteLength(JSON.stringify(fb)) <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(out.packet)) <= MAX_BYTES);
  const text = JSON.stringify(fb);
  for (const leak of ['example.com', '0912', 'https', 'LOHI7F3A9', 'token=']) assert.ok(!text.includes(leak), leak);
  for (const list of Object.values(fb.ex)) assert.ok(list.length <= 5 && list.every(t => t.length <= 70));
  assert.equal(fb.ex.feature_request.length, 2, 'the same sample is kept once');
  assert.ok(!text.includes('Soot khác'));
  const none = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'cs-token' });
  cs.sessions = []; await none.call('scoreboard_sync');
  assert.deepEqual((await none.call('signals')).packet.cs_feedback, { n: {}, ex: {} });
  const bad = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'wrong' });
  await bad.call('scoreboard_sync');
  assert.equal((await bad.call('signals')).packet.cs_feedback, undefined);
});

test('the packet stays under 3 KiB however long the history and the titles are', async () => {
  const w = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'cs-token' });
  await w.call('scoreboard_sync');
  for (let i = 0; i < 4; i++) {
    await w.call('digest_save', { opportunities: Array.from({ length: 5 }, (_, j) => ({ ...ITEM.product, title: `Cơ hội rất dài số ${i}-${j} ` + 'x'.repeat(60), summary: ITEM.product.summary })) });
  }
  for (let i = 0; i < 60; i++) await w.store.insert('decisions', { stage: 'gate', opportunity_ref: `OP-${i}`, decision: 'go', by: 'founder', stage: 'gate', target_outcome: 'signups', expected_delta: 10, at: new Date(w.now + i).toISOString() });
  const out = await w.call('signals');
  assert.ok(Buffer.byteLength(JSON.stringify(out.packet)) <= MAX_BYTES);
});

test('page_view: the next step is one code that follows the founder through the whole loop', async () => {
  const blank = world();
  assert.equal((await view(blank)).next.code, 'setup');
  const w = mk();
  assert.equal((await view(w)).next.code, 'idle');
  api.mode = 'forbidden';
  await w.call('page_action', { op: 'sync', request_id: 'req-00000001' }, { page: { page: 'cong-ty' } }).catch(() => {});
  api.mode = 'ok';
  await w.call('scoreboard_sync');
  await w.call('digest_save', { opportunities: [ITEM.content, ITEM.product] });
  const v = await view(w);
  assert.deepEqual([v.next.code, v.next.n], ['choose', 1]);
  assert.equal(v.scoreboard.tiles.find(t => t.key === 'signups').value, 120);
  assert.equal(v.opportunities.length, 2);
  assert.ok(!JSON.stringify(v).includes(KEY));
  const ref = v.opportunities.find(o => o.kind === 'product').ref;
  await w.call('page_action', { op: 'go', id: ref, request_id: 'req-00000002' }, { page: { page: 'cong-ty' } });
  assert.equal((await view(w)).next.code, 'building');
  assert.equal((await view(w)).handoffs[0].state, 'spawned');
});

test('page_view: a refused key becomes key_refused, naming the key role in one plain line', async () => {
  const w = world({ env: { SCOREBOARD_URL: api.url, PRODUCT_ADMIN_KEY: 'wrong-key' } });
  const out = await w.call('scoreboard_sync');
  assert.equal(out.ok, false);
  assert.match(out.note ?? out.message ?? JSON.stringify(out), /admin|quản trị/i);
  assert.equal((await view(w)).next.code, 'key_refused');
});

test('page_view holds no credential: a stored sync is the proof of the key, and no sync at all is setup', async () => {
  const w = mk();
  await w.call('scoreboard_sync');
  delete w.env.PRODUCT_ADMIN_KEY; // what the read tool sees in the runtime
  assert.equal((await view(w)).setup.key, true);
  assert.equal((await view(w)).next.code, 'idle');
  delete w.env.SCOREBOARD_URL;
  assert.equal((await view(w)).next.code, 'setup');
});

test('page_action refuses an unknown op and a missing request id', async () => {
  const w = mk();
  await assert.rejects(w.call('page_action', { op: 'nope', request_id: 'req-00000003' }, { page: { page: 'cong-ty' } }), /op là/);
});

// ---------- pack shape ----------
const root = new URL('..', import.meta.url);
const pack = JSON.parse(readFileSync(new URL('pack.json', root), 'utf8'));

test('the pack is product neutral: no brand, no product word in the code, skill or page', () => {
  const files = [['tools/loop.mjs'], ['skills/digest.md'], ['page/index.html'], ['page/app.js'], ...readdirSync(new URL('tools/lib', root)).map(f => [`tools/lib/${f}`])];
  const text = files.map(([f]) => readFileSync(new URL(f, root), 'utf8')).join('\n') + JSON.stringify(pack);
  assert.ok(!/lohi|kiem-lai|truyện|lohi2\.com/i.test(text), 'a product name leaked into the pack');
});

test('declared outcomes, credentials and tools match what the code emits and reads', () => {
  assert.deepEqual(pack.outcomes.map(o => o.id).sort(), ['opportunity_found', 'requirement_shipped']);
  assert.deepEqual(Object.entries(pack.needs.credentials).map(([n, c]) => [n, c.optional, c.from]).sort(), [['CS_RUNTIME_TOKEN', true, 'operator'], ['PRODUCT_ADMIN_KEY', true, 'operator']]);
  assert.deepEqual(pack.tools.map(t => t.name).sort(), ['decide', 'digest_save', 'health_sync', 'page_action', 'page_view', 'review', 'scoreboard_sync', 'signals', 'team_watch', 'topic_next']);
  const tables = Object.fromEntries(pack.storage.tables.map(t => [t.name, t]));
  for (const t of ['scoreboard', 'opportunities', 'decisions', 'handoffs', 'topics']) assert.ok(t in tables, t);
});

test('the page bundle: three plain files, no network, no innerHTML, Vietnamese, 480 px', () => {
  const html = readFileSync(new URL('page/index.html', root), 'utf8'), js = readFileSync(new URL('page/app.js', root), 'utf8'), css = readFileSync(new URL('page/app.css', root), 'utf8');
  assert.match(html, /lang="vi"/);
  assert.match(html, /viewport/);
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|innerHTML|insertAdjacentHTML|eval\(|https?:\/\//.test(js), 'page script reaches out or injects html');
  assert.ok(!/https?:\/\/|@import/.test(css));
  assert.match(js, /request_id/);
  assert.match(js, /Bản tin|Để sau/);
});
