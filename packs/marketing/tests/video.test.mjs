// One video path (AC4): a 2build marketing-video (mvf) campaign folder becomes
// assets and one video draft per channel, passes the same guard and caps, and
// shows in Hàng đợi with its poster, captions and pretest. A render failure or
// a weak hook stays a draft with the reason; nothing is queued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { verifyClaim } from '../tools/lib/claim.mjs';
import { srtCues, POSTER_MAX } from '../tools/lib/video.mjs';

const KEY = 'k'.repeat(32);
const T0 = Date.parse('2026-11-10T03:00:00Z');
const MIN = 60_000;
const CAMP = 'marketing/campaigns/tien-hiep';
const DIR = `${CAMP}/08-delivery/s1/9x16`; // mvf ≥ 1.122: one video per script, the hook in delivery.json
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
const MP4 = Buffer.from('fake mp4 bytes for the test');
const SRT = '1\n00:00:00,000 --> 00:00:02,000\nĐọc chín bộ tiên hiệp\n\n2\n00:00:02,000 --> 00:00:04,500\nmỗi bộ một lý do\n';

function put(root, rel, data) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); }

/** An mvf-shaped campaign: script s1 with hooks H1/H2, a Micro Fish round, and the delivered x + facebook files. */
function campaign({ h1 = 28, h2 = 46, method = 'simulated-panel', winner = 's1/H2', delivered = true, fails = 0, draft = false, rendered = 'H2' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mvf-'));
  put(root, `${CAMP}/campaign.json`, { slug: 'tien-hiep', product: 'novel-app' });
  put(root, `${CAMP}/05-scripts/s1.json`, { id: 's1', spine: { question: 'Chín bộ tiên hiệp đáng đọc' }, beats: [{ role: 'hook', onscreen: 'Bạn đọc tiên hiệp mà bỏ qua bộ này?' }], variants: [{ id: 'H2', onscreen: 'Chín bộ tiên hiệp, một tối là mê' }] });
  put(root, `${CAMP}/06-pretest/r1/decision.json`, { method, winner, decided_at: '2026-11-08T02:00:00Z' });
  put(root, `${CAMP}/06-pretest/r1/microfish/judge.json`, { sim: 'micro-fish', caveat: 'Panel mô phỏng, không phải người thật.', stimuli: {
    A: { id: 's1/H1', kind: 'candidate', n: 40, watch_through: h1, intent_top2: 20 },
    B: { id: 's1/H2', kind: 'candidate', n: 40, watch_through: h2, intent_top2: 31 },
    C: { id: 'control', kind: 'control', n: 40, watch_through: 22 } } });
  if (delivered) {
    const files = {};
    for (const [p, copy] of [['x', 'post.txt'], ['facebook', 'caption.txt']]) {
      put(root, `${DIR}/${p}/s1-H2-${p}.mp4`, MP4);
      put(root, `${DIR}/${p}/captions.srt`, SRT);
      put(root, `${DIR}/${p}/cover.jpg`, JPEG);
      put(root, `${DIR}/${p}/contact.jpg`, Buffer.concat([JPEG, Buffer.alloc(300 * 1024)]));
      put(root, `${DIR}/${p}/${copy}`, p === 'x' ? 'Chín bộ tiên hiệp đáng đọc năm nay, xem thử 16 giây.\n\n[reply 1] Danh sách đầy đủ ở blog.\n' : 'Tối nay đọc gì? Chín bộ tiên hiệp, mỗi bộ một lý do riêng.');
      files[p] = { video: `08-delivery/s1/9x16/${p}/s1-H2-${p}.mp4`, fails: p === 'x' ? fails : 0, warns: 0,
        qa: [{ level: 'PASS', code: 'Q0', msg: '1080x1920 30fps 16.32s 5.2MB' }, ...(p === 'x' && fails ? [{ level: 'FAIL', code: 'Q3', msg: 'chữ tràn khỏi vùng an toàn' }] : [])] };
    }
    put(root, `${DIR}/delivery.json`, { script: 's1', hook: rendered, canvas: '9x16', files, draft, ai_disclosure: { photoreal: false, x: 'off', facebook: 'ON', why: ['generated art'] } });
  }
  return root;
}

function world(root) {
  const w = { now: T0 };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { MARKETING_CLAIM_KEY: KEY, FILE_ROOT: root };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: async () => { throw new Error('no network'); } });
  w.page = (op, input = {}) => w.call('page_action', { op, request_id: `r-${Math.random()}`, ...input }, { page: { page: 'hang-doi' } });
  w.import = (over = {}) => w.call('video_import', { request_id: 'v-1', campaign: CAMP, channels: ['x-lohi', 'facebook-lohi'], ...over });
  return w;
}

async function seeded(root) {
  const w = world(root);
  await w.call('channels_setup', { channels: [{ id: 'x-lohi', account: 'acct' }, { id: 'facebook-lohi', account: 'https://www.facebook.com/acct' }] });
  for (const id of ['x-lohi', 'facebook-lohi']) await w.page('resume', { channel: id });
  return w;
}

test('an mvf campaign becomes one video draft per channel with its video, captions and poster; check → schedule → a claim that carries the signed file', async () => {
  const root = campaign();
  try {
    const w = await seeded(root);
    const out = await w.import();
    assert.equal(out.script, 's1');
    assert.equal(out.hook, 'H2', 'the Micro Fish winner');
    assert.deepEqual(out.pretest.hooks, [{ id: 'H2', score: 46 }, { id: 'H1', score: 28 }]);
    assert.equal(out.pretest.passed, true);
    assert.deepEqual(out.posts.map(p => [p.channel, p.state, p.hold]), [['x-lohi', 'draft', null], ['facebook-lohi', 'draft', null]]);
    const x = w.store.data.posts.find(p => p.channel === 'x-lohi');
    assert.equal(x.kind, 'video');
    assert.equal(x.body, 'Chín bộ tiên hiệp đáng đọc năm nay, xem thử 16 giây.');
    assert.equal(x.brief.video_key, `${CAMP}#s1/H2/9x16`);
    const fb = w.store.data.posts.find(p => p.channel === 'facebook-lohi');
    assert.equal(fb.body, 'Tối nay đọc gì? Chín bộ tiên hiệp, mỗi bộ một lý do riêng.');
    assert.equal(w.store.data.assets.find(a => a.post === fb.ref && a.kind === 'video').meta.ai_label, true, 'mvf says Facebook needs its AI label');
    const assets = w.store.data.assets.filter(a => a.post === x.ref);
    assert.deepEqual(assets.map(a => a.kind).sort(), ['captions', 'poster', 'video']);
    const video = assets.find(a => a.kind === 'video');
    assert.equal(video.path, `${DIR}/x/s1-H2-x.mp4`);
    assert.equal(video.meta.sha256, 'sha256:' + createHash('sha256').update(MP4).digest('hex'));
    assert.equal(video.meta.duration_s, 16.32);
    const poster = assets.find(a => a.kind === 'poster').meta.data_uri;
    assert.ok(poster.startsWith('data:image/jpeg;base64,') && poster.length <= POSTER_MAX);
    assert.equal(assets.find(a => a.kind === 'poster').path, `${DIR}/x/cover.jpg`, 'frame 0, not the contact sheet');

    for (const p of out.posts) {
      const c = await w.call('check', { id: p.id, revision: p.revision, verdict: 'pass', reasons: [] });
      assert.equal(c.verdict, 'pass', JSON.stringify(c.auto));
      assert.deepEqual(c.auto.find(a => a.rule === 'video')?.ok, true);
    }
    const s = await w.call('schedule', { id: x.ref, scheduled_at: new Date(w.now - MIN).toISOString() });
    assert.ok(s.scheduled_at);

    const view = await w.call('page_view', {}, { page: { page: 'hang-doi' } });
    const item = JSON.stringify(view).includes(x.ref) && findItem(view, x.ref);
    assert.equal(item.kind, 'video');
    assert.equal(item.video.poster, poster);
    assert.equal(item.video.open_link, `nest://data/files/${DIR}/x/s1-H2-x.mp4`);
    assert.deepEqual(item.video.captions.map(c => c.text), ['Đọc chín bộ tiên hiệp', 'mỗi bộ một lý do']);
    assert.deepEqual(item.video.pretest.hooks.map(h => [h.id, h.score, h.chosen]), [['H2', 46, true], ['H1', 28, false]]);
    assert.equal(item.video.pretest.hooks[0].text, 'Chín bộ tiên hiệp, một tối là mê');

    const { claim } = await w.call('claim', { id: x.ref, action: 'publish' });
    assert.equal(verifyClaim(claim, KEY, w.now), null);
    assert.equal(claim.kind, 'video');
    assert.deepEqual(claim.assets, [{ kind: 'video', path: video.path, sha256: video.meta.sha256, bytes: MP4.length }], 'X needs no AI label here');
    assert.equal(video.meta.ai_label, undefined);
    const tampered = { ...claim, assets: [{ ...claim.assets[0], path: 'other.mp4' }] };
    assert.notEqual(verifyClaim(tampered, KEY, w.now), null, 'the uploaded file is signed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function findItem(view, ref) {
  const seen = [];
  const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.id === ref && v.video !== undefined) seen.push(v); Object.values(v).forEach(walk); } };
  walk(view);
  assert.ok(seen.length, 'the queued video is in Hàng đợi');
  return seen[0];
}

test('Kéo khỏi hàng đợi pulls a queued video', async () => {
  const root = campaign();
  try {
    const w = await seeded(root);
    const [p] = (await w.import({ channels: ['x-lohi'] })).posts;
    await w.call('check', { id: p.id, revision: p.revision, verdict: 'pass', reasons: [] });
    await w.call('schedule', { id: p.id });
    assert.equal((await w.page('pull', { id: p.id })).state, 'pulled');
    assert.equal(w.store.data.queue.filter(q => q.post === p.id).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#p4-video-failed: a render failure stays a draft with "Lỗi dựng" and its reason, even after check; nothing is queued', async () => {
  for (const [name, opts, over, re] of [
    ['error passed', {}, { error: 'HyperFrames render exited 1' }, /HyperFrames render exited 1/],
    ['no delivery', { delivered: false }, {}, /mvf export chưa xong/],
    ['QA FAIL', { fails: 1 }, { channels: ['x-lohi'] }, /chữ tràn khỏi vùng an toàn/],
    ['draft render', { draft: true }, {}, /--draft/],
  ]) {
    const root = campaign(opts);
    try {
      const w = await seeded(root);
      const out = await w.import(over);
      for (const p of out.posts) {
        assert.equal(p.hold, 'render_failed', name);
        assert.match(p.reason, re, name);
        const c = await w.call('check', { id: p.id, revision: p.revision, verdict: 'pass', reasons: [] });
        assert.equal(c.state, 'draft', name);
        assert.equal(c.auto.find(a => a.rule === 'video').ok, false, name);
        await assert.rejects(w.call('schedule', { id: p.id }), name);
      }
      assert.equal(w.store.data.queue.length, 0, name);
      const list = await w.call('page_view', {}, { page: { page: 'bai-viet' } });
      assert.match(JSON.stringify(list), /Lỗi dựng/, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('#p4-video-failed: a hook under the pretest bar, or no Micro Fish round, stays a draft with "Câu mở đầu yếu"', async () => {
  for (const [name, opts, re] of [
    ['under the bar', { h1: 20, h2: 30 }, /30% muốn xem tiếp \(cần ≥ 35%\)/],
    ['no panel', { method: 'owner' }, /Chưa thử câu mở đầu với Micro Fish/],
    ['no winner', { winner: null }, /không tách được/],
    ['another hook rendered', { rendered: 'H1' }, /dựng câu mở đầu H1, nhưng Micro Fish chọn H2/],
  ]) {
    const root = campaign(opts);
    try {
      const w = await seeded(root);
      const out = await w.import({ script: 's1' });
      assert.equal(out.pretest.passed, false, name);
      for (const p of out.posts) {
        assert.equal(p.hold, 'weak_hook', name);
        assert.match(p.reason, re, name);
        const c = await w.call('check', { id: p.id, revision: p.revision, verdict: 'pass', reasons: [] });
        assert.equal(c.state, 'draft', name);
      }
      assert.equal(w.store.data.queue.length, 0, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('a held video that also breaks a hard rule is refused, a claim-time video failure stays a draft, and a long request_id is refused', async () => {
  const root = campaign({ h1: 20, h2: 30 });
  try {
    const w = await seeded(root);
    await assert.rejects(w.import({ request_id: 'r'.repeat(32) }), /request_id/, 'the per-channel key must fit');
    const [p] = (await w.import({ channels: ['x-lohi'] })).posts;
    assert.equal(p.hold, 'weak_hook');
    const d = await w.call('draft_save', { id: p.id, expected_revision: p.revision, kind: 'video', channel: 'x-lohi', body: 'Gọi 0912 345 678 để nhận truyện.' });
    const c = await w.call('check', { id: p.id, revision: d.revision, verdict: 'pass', reasons: [] });
    assert.equal(c.state, undefined, 'not just held');
    assert.equal(w.store.data.posts.find(x => x.ref === p.id).state, 'refused', 'personal data refuses it, the hold does not hide that');
  } finally { rmSync(root, { recursive: true, force: true }); }
  const ok = campaign();
  try {
    const w = await seeded(ok);
    const [p] = (await w.import({ channels: ['x-lohi'] })).posts;
    await w.call('check', { id: p.id, revision: p.revision, verdict: 'pass', reasons: [] });
    await w.call('schedule', { id: p.id, scheduled_at: new Date(w.now - MIN).toISOString() });
    const v = w.store.data.assets.find(a => a.post === p.id && a.kind === 'video');
    v.pretest = { ...v.pretest, passed: false, reason: 'Câu mở đầu dưới mức; vẫn là nháp.' };
    const r = await w.call('claim', { id: p.id, action: 'publish' });
    assert.equal(r.refused.code, 'weak_hook');
    assert.equal(w.store.data.posts.find(x => x.ref === p.id).state, 'draft', 'the same hold as at check');
    assert.equal(w.store.data.queue.filter(q => q.post === p.id).length, 0);
  } finally { rmSync(ok, { recursive: true, force: true }); }
});

test('re-importing is idempotent, and a fixed campaign updates the same drafts', async () => {
  const root = campaign({ h1: 20, h2: 30 });
  try {
    const w = await seeded(root);
    const a = await w.import();
    const b = await w.import({ request_id: 'v-2' });
    assert.deepEqual(b.posts.map(p => [p.id, p.unchanged]), a.posts.map(p => [p.id, true]));
    // The founder's bar stays; a new pretest round with a stronger hook lands.
    put(root, `${CAMP}/06-pretest/r2/decision.json`, { method: 'simulated-panel', winner: 's1/H2', decided_at: '2026-11-08T05:00:00Z' });
    put(root, `${CAMP}/06-pretest/r2/microfish/judge.json`, { stimuli: { B: { id: 's1/H2', kind: 'candidate', n: 40, watch_through: 51 } } });
    const c = await w.import({ request_id: 'v-3' });
    assert.deepEqual(c.posts.map(p => [p.id, p.revision, p.hold]), a.posts.map(p => [p.id, 2, null]));
    assert.equal(w.store.data.posts.length, 2);
    assert.equal(w.store.data.assets.length, 6, 'old assets replaced');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TikTok is a handoff, and the import reads only inside FILE_ROOT', async () => {
  const root = campaign();
  try {
    const w = await seeded(root);
    await w.call('channels_setup', { channels: [{ id: 'reddit-lohi', account: 'acct' }] });
    await assert.rejects(w.import({ channels: ['reddit-lohi'] }), /TikTok và kênh khác/);
    for (const campaign of ['../x', '/etc', 'a/.hidden', 'a//b']) await assert.rejects(w.import({ campaign }), { code: 'invalid_request' }, campaign);
    const link = mkdtempSync(join(tmpdir(), 'mvf-link-'));
    symlinkSync(join(root, 'marketing'), join(link, 'marketing'));
    w.env.FILE_ROOT = link;
    await assert.rejects(w.import(), /liên kết tượng trưng/);
    rmSync(link, { recursive: true, force: true });
    delete w.env.FILE_ROOT;
    await assert.rejects(w.import(), { code: 'no_workspace' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captions parse into page cues', () => {
  assert.deepEqual(srtCues(SRT), [{ start: '00:00:00.000', end: '00:00:02.000', text: 'Đọc chín bộ tiên hiệp' }, { start: '00:00:02.000', end: '00:00:04.500', text: 'mỗi bộ một lý do' }]);
});
