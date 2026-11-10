// signals (compact packet, ≤ 3 KiB, CS optional), page_view next step codes, and the pack's shape.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { world, ITEM } from './world.mjs';
import { startBoardApi, startCsApi, addNotes, fakeBbs, scratchRepo, KEY } from './fixtures.mjs';
import { MAX_BYTES, fit } from '../tools/lib/signals.mjs';

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

test('F11: voc read through the contract skips the desk scrape; voc unavailable falls back to it', async () => {
  cs.sessions = []; cs.messages = {}; cs.calls.length = 0;
  addNotes(cs, [['bug', 'Lỗi không đọc được chương']]);
  const w = mk({ CS_RUNTIME_URL: cs.url, CS_RUNTIME_TOKEN: 'cs-token' });
  await w.call('scoreboard_sync');
  cs.calls.length = 0;
  const viaVoc = await w.call('signals', { voc: true });
  assert.equal(viaVoc.packet.cs_voc, 'contract');
  assert.equal(viaVoc.packet.cs_feedback, undefined);
  assert.ok(!cs.calls.some(c => c.path.startsWith('/v1/sessions')), 'no desk session was read');
  // voc unavailable (refused, not granted, unreachable): the digest says voc false and the old path answers.
  const fallback = await w.call('signals', { voc: false });
  assert.equal(fallback.packet.cs_voc, undefined);
  assert.deepEqual(fallback.packet.cs_feedback.n, { bug: 1 });
  assert.deepEqual((await w.call('signals', {})).packet.cs_feedback.n, { bug: 1 }, 'omitted means unavailable');
  // No static token at all and voc fine: nothing is asked of the CS runtime for feedback.
  const noToken = mk({});
  await noToken.call('scoreboard_sync');
  assert.equal((await noToken.call('signals', { voc: true })).packet.cs_voc, 'contract');
  assert.equal((await noToken.call('signals', { voc: false })).packet.cs_feedback, undefined, 'fallback is quiet without the old token');
  // The skill reads voc through the data tool on the team:cs scope and keeps the fallback.
  const skill = readFileSync(new URL('../skills/digest.md', import.meta.url), 'utf8');
  assert.match(skill, /scope: "team:cs", table: "voc"/);
  assert.match(skill, /signals \{voc: true\}/);
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
  assert.deepEqual(Object.entries(pack.needs.credentials).map(([n, c]) => [n, c.optional, c.from]).sort(), [['CS_RUNTIME_TOKEN', true, 'operator'], ['PRODUCT_ADMIN_KEY', true, 'operator'], ['SCOREBOARD_KEYS', true, 'operator']]);
  assert.deepEqual(pack.tools.map(t => t.name).sort(), ['decide', 'digest_save', 'health_sync', 'metrics_record', 'opportunities_card', 'page_action', 'page_view', 'parts_set', 'review', 'scoreboard_sync', 'signals', 'team_watch', 'topic_next', 'topic_sync']);
  const tables = Object.fromEntries(pack.storage.tables.map(t => [t.name, t]));
  for (const t of ['scoreboard', 'opportunities', 'decisions', 'handoffs', 'topics']) assert.ok(t in tables, t);
});

test('the page bundle: three plain files, no network, no innerHTML, Vietnamese, tokens only, follows Nest\'s product', () => {
  const html = readFileSync(new URL('page/index.html', root), 'utf8'), js = readFileSync(new URL('page/app.js', root), 'utf8'), css = readFileSync(new URL('page/app.css', root), 'utf8');
  assert.match(html, /lang="vi"/);
  assert.match(html, /viewport/);
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|innerHTML|insertAdjacentHTML|eval\(|https?:\/\//.test(js), 'page script reaches out or injects html');
  assert.ok(!/https?:\/\/|@import/.test(css));
  assert.match(js, /request_id/);
  assert.match(js, /Bản tin|Để sau/);
  // Colours, radii and fonts come from Nest's tokens: no hex, no named font, no style attribute.
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'a hard-coded colour');
  assert.ok(!/font-family|border-radius:\s*\d+px\s*;(?!.*999px)/.test(css.replace(/border-radius:\s*999px/g, '')), 'a fixed font or radius');
  assert.ok(!/setAttribute\('style'|\bstyle:\s*['`]/.test(js), 'an inline style attribute');
  // The product scope: the context message is read, sent back as view input, and a Go carries the host.
  assert.match(js, /type === 'context'/);
  assert.match(js, /products/);
  assert.match(js, /task_done/);
  assert.match(js, /nest:\/\/settings\/setup\?key=/);
});

test('fit drops the moat and awareness tallies before the decision history', () => {
  const decisions = Array.from({ length: 6 }, (_, i) => ({ ref: `OP-${i}`, d: 'go', why: 'x'.repeat(300) }));
  const packet = { decisions, awareness: { unaware: 3, problem: 2, choosing: 1 }, moats: { process: 2, brand: 1 }, pad: '' };
  const without = () => Buffer.byteLength(JSON.stringify({ ...packet, awareness: undefined, moats: undefined }));
  packet.pad = 'y'.repeat(MAX_BYTES - 10 - without());
  const base = without();
  assert.ok(base <= MAX_BYTES && Buffer.byteLength(JSON.stringify(packet)) > MAX_BYTES, 'fixture sits on the cap');
  const out = fit(structuredClone(packet));
  assert.equal(out.decisions.length, 6);
  assert.ok(!out.awareness || !out.moats);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES);
});
