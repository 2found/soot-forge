// Video posts from a 2build marketing-video (mvf) campaign folder (design §8,
// lead direction 2026-11-08). mvf makes the video; this only reads what it left
// on disk — the pretest decision, the delivery files and their QA — and turns
// them into `assets` rows and one `kind:"video"` draft per channel. A render
// failure or a hook under the pretest bar stays a draft with the reason; the
// guard rule below keeps it out of the queue at check and claim.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, realpath, open } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fail, eq, isNull } from './store.mjs';
import { platformOf } from './guard.mjs';
import { channel, getSettings, hashOf, postAssets, STATE_LABEL } from './ops.mjs';

export const VIDEO_PLATFORMS = ['x', 'facebook'];
export const POSTER_MAX = 200 * 1024; // the data URI, not the file
export const DEFAULT_BAR = 35; // % of the simulated panel that would keep watching
const PANELS = ['simulated-panel', 'micro-fish'];

// ---------- the workspace, read-only ----------

function clean(rel, what) {
  if (typeof rel !== 'string' || !rel || rel.length > 512 || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) fail('invalid_request', `${what} is a workspace-relative path.`);
  const parts = rel.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) fail('invalid_request', `${what} has an empty, hidden or parent part.`);
  return parts;
}

/** A reader confined to FILE_ROOT: no absolute path, parent, hidden part or symlink. */
export async function workspace(fileRoot) {
  if (typeof fileRoot !== 'string' || !fileRoot.startsWith('/')) fail('no_workspace', 'Soot chưa được cấp thư mục làm việc (FILE_ROOT) để đọc tệp video.');
  const root = await realpath(fileRoot).catch(() => fail('no_workspace', 'Thư mục làm việc không tồn tại.'));
  const at = async (rel, what = 'path') => {
    let p = root;
    for (const part of clean(rel, what)) {
      p = join(p, part);
      const st = await lstat(p).catch(() => null);
      if (!st) return null;
      if (st.isSymbolicLink()) fail('invalid_request', `${rel} đi qua một liên kết tượng trưng; không đọc.`);
    }
    return p;
  };
  return {
    async stat(rel) { const p = await at(rel); return p ? lstat(p) : null; },
    async text(rel, max = 256 * 1024) {
      const p = await at(rel);
      if (!p) return null;
      const st = await lstat(p);
      if (!st.isFile() || st.size > max) return null;
      return readFile(p, 'utf8');
    },
    async json(rel) { const t = await this.text(rel, 2 * 1024 * 1024); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } },
    async bytes(rel, max) { const p = await at(rel); if (!p) return null; const st = await lstat(p); return st.isFile() && st.size <= max ? readFile(p) : null; },
    async dirs(rel) { const p = await at(rel); if (!p) return []; return (await readdir(p, { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort(); },
    async sha256(rel) {
      const p = await at(rel);
      if (!p) return null;
      const st = await lstat(p);
      if (!st.isFile()) return null;
      const hash = createHash('sha256'), fh = await open(p, 'r');
      try { for await (const chunk of fh.createReadStream()) hash.update(chunk); } finally { await fh.close().catch(() => {}); }
      return { sha256: 'sha256:' + hash.digest('hex'), bytes: st.size };
    },
  };
}

// ---------- mvf's artifacts ----------

const hookText = (script, id) => {
  if (!script) return null;
  if (id === 'H1') { const b = (script.beats ?? []).find(x => x.role === 'hook') ?? script.beats?.[0]; return (b?.onscreen || b?.vo || '').trim() || null; }
  const v = (script.variants ?? []).find(x => x.id === id);
  return (v?.onscreen || v?.vo || '').trim() || null;
};

/** The latest pretest round: its decision and, when Micro Fish ran, the judged numbers per hook. */
export async function readPretest(ws, dir, sid, script, bar) {
  const rounds = await ws.dirs(`${dir}/06-pretest`);
  let best = null;
  for (const r of rounds) {
    const d = await ws.json(`${dir}/06-pretest/${r}/decision.json`);
    if (!d) continue;
    const key = `${d.decided_at ?? ''}|${r}`;
    if (!best || key > best.key) best = { key, round: r, decision: d };
  }
  if (!best) return { passed: false, bar, method: null, hooks: [], reason: 'Chưa thử câu mở đầu với Micro Fish; vẫn là nháp.' };
  const { decision, round } = best;
  const judge = await ws.json(`${dir}/06-pretest/${round}/microfish/judge.json`);
  const winner = typeof decision.winner === 'string' && decision.winner.includes('/') ? decision.winner : null;
  const hooks = Object.values(judge?.stimuli ?? {}).filter(x => x?.kind === 'candidate' && String(x.id).startsWith(`${sid}/`)).map(x => {
    const id = String(x.id).split('/')[1];
    return { id, text: hookText(script, id), score: typeof x.watch_through === 'number' ? Math.round(x.watch_through) : null, intent_top2: x.intent_top2 ?? null, n: x.n ?? null };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const chosen = winner?.startsWith(`${sid}/`) ? winner.split('/')[1] : null;
  for (const h of hooks) h.chosen = h.id === chosen;
  const top = hooks.find(h => h.chosen) ?? null;
  const out = { round, method: decision.method ?? null, sim: judge?.sim ?? decision.sim ?? null, n: hooks.find(h => h.n)?.n ?? null, bar, chosen, hooks, caveat: judge?.caveat ?? decision.caveat ?? null };
  if (!PANELS.includes(decision.method) || !judge) return { ...out, passed: false, reason: 'Chưa thử câu mở đầu với Micro Fish (cần một vòng panel mô phỏng); vẫn là nháp.' };
  if (!chosen) return { ...out, passed: false, reason: winner ? `Micro Fish chọn kịch bản khác (${winner}); video này vẫn là nháp.` : 'Micro Fish không tách được câu mở đầu khỏi bản đối chứng; vẫn là nháp.' };
  if (top?.score == null || top.score < bar) {
    const bestScore = Math.max(...hooks.map(h => h.score ?? 0), 0);
    return { ...out, passed: false, reason: `Câu tốt nhất chỉ ${bestScore}% muốn xem tiếp (cần ≥ ${bar}%). Vẫn là nháp.` };
  }
  return { ...out, passed: true, reason: null };
}

const firstFail = items => (items ?? []).find(i => i?.level === 'FAIL')?.msg ?? null;
const durationOf = items => { for (const i of items ?? []) { const m = /(\d+(?:\.\d+)?)s\b/.exec(i?.code === 'Q0' ? i.msg : ''); if (m) return Number(m[1]); } return null; };

/** One platform's delivered files, or why there are none. */
async function readPlatform(ws, dir, delivery, platform) {
  const f = delivery?.files?.[platform];
  if (!f?.video) return { error: `mvf chưa xuất tệp cho ${platform}.` };
  const video = String(f.video).startsWith(`${dir}/`) ? f.video : `${dir}/${f.video}`;
  if (f.fails) return { error: `Kiểm tra tệp ${platform} báo lỗi: ${firstFail(f.qa) ?? `${f.fails} lỗi`}.` };
  const sum = await ws.sha256(video);
  if (!sum) return { error: `Không thấy tệp video ${basename(video)}.` };
  const folder = dirname(video);
  const captions = await ws.text(`${folder}/captions.srt`, 64 * 1024);
  let poster = null;
  for (const name of ['cover.jpg', 'contact.jpg']) {
    const b = await ws.bytes(`${folder}/${name}`, POSTER_MAX);
    if (!b || b[0] !== 0xff || b[1] !== 0xd8) continue;
    const uri = 'data:image/jpeg;base64,' + b.toString('base64');
    if (uri.length <= POSTER_MAX) { poster = { path: `${folder}/${name}`, data_uri: uri }; break; }
  }
  // X's post.txt carries the thread as "[reply n]" paragraphs; the post is the first one.
  const copy = (await ws.text(`${folder}/post.txt`, 16 * 1024))?.split(/\n\n\[reply \d+\]/)[0] ?? (await ws.text(`${folder}/caption.txt`, 16 * 1024));
  const ai = delivery.ai_disclosure?.[platform] ?? (delivery.ai_disclosure?.photoreal ? 'ON' : 'off');
  return { video, ...sum, captions, poster, copy: copy?.trim() || null, duration_s: durationOf(f.qa), ai_label: ai === 'ON' };
}

// ---------- the tool ----------

const assetRef = () => 'A-' + randomBytes(5).toString('hex').toUpperCase();

/** Parse SRT into at most `max` cues for the page. */
export function srtCues(text, max = 40) {
  const out = [];
  for (const block of String(text ?? '').replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [start, end] = lines[i].split('-->').map(s => s.trim().replace(',', '.'));
    out.push({ start, end, text: lines.slice(i + 1).join(' ').trim() });
    if (out.length >= max) break;
  }
  return out;
}

/** `video_import`: the mvf campaign at `campaign` → assets + one video draft per channel. */
export async function video_import(input, deps) {
  const { store, env, soot } = deps;
  const { request_id, campaign, channels, parent, error } = input;
  // Each channel's draft is keyed `<request_id>:<channel>`, which must fit 64 characters.
  if (typeof request_id !== 'string' || !request_id || request_id.length > 31) fail('invalid_request', 'request_id is 1–31 characters.');
  clean(campaign, 'campaign');
  if (!Array.isArray(channels) || !channels.length || channels.length > 4) fail('invalid_request', 'channels lists 1–4 channels.');
  const chans = [];
  for (const key of channels) {
    const ch = await channel(store, key);
    const platform = platformOf(ch.key);
    if (!VIDEO_PLATFORMS.includes(platform)) fail('invalid_request', `Video đăng tự động trên X và Facebook; ${key} (TikTok và kênh khác) là việc người đăng.`);
    chans.push({ ch, platform });
  }
  const ws = await workspace(env.FILE_ROOT);
  const camp = await ws.json(`${campaign}/campaign.json`);
  if (!camp) fail('not_found', `Không thấy ${campaign}/campaign.json (thư mục chiến dịch mvf).`);
  const settings = await getSettings(store);
  const bar = Number.isFinite(settings.video_pretest_bar) ? settings.video_pretest_bar : DEFAULT_BAR;
  // The script and hook: the caller's, else the pretest winner, else the script's own `hook`.
  const scripts = (await ws.dirs(`${campaign}/08-delivery`));
  let sid = input.script ?? null;
  if (!sid) {
    for (const r of (await ws.dirs(`${campaign}/06-pretest`)).reverse()) {
      const d = await ws.json(`${campaign}/06-pretest/${r}/decision.json`);
      if (typeof d?.winner === 'string' && d.winner.includes('/')) { sid = d.winner.split('/')[0]; break; }
    }
  }
  sid ??= scripts[0] ?? null;
  if (!sid || !/^[A-Za-z0-9_-]{1,80}$/.test(sid)) fail('invalid_request', 'Không xác định được kịch bản (script); truyền script.');
  const script = await ws.json(`${campaign}/05-scripts/${sid}.json`);
  const pretest = await readPretest(ws, campaign, sid, script, bar);
  const canvas = input.canvas ?? '9x16';
  if (!/^[0-9]{1,2}x[0-9]{1,2}$/.test(canvas)) fail('invalid_request', 'canvas is like 9x16.');
  // mvf renders one video per script: 08-delivery/<sid>/<canvas>/, its hook in delivery.json
  // (v1.119 nested the hook: 08-delivery/<sid>/<hook>/<canvas>/).
  let hook = input.hook ?? pretest.chosen ?? script?.hook ?? 'H1';
  if (!/^H[0-9]{1,2}$/.test(hook)) fail('invalid_request', 'hook is H1, H2, …');
  let delivery = await ws.json(`${campaign}/08-delivery/${sid}/${canvas}/delivery.json`);
  if (delivery && /^H[0-9]{1,2}$/.test(delivery.hook ?? '')) hook = delivery.hook;
  delivery ??= await ws.json(`${campaign}/08-delivery/${sid}/${hook}/${canvas}/delivery.json`);
  // The pretest judged the hook mvf rendered; a different one has no score.
  if (pretest.passed && pretest.chosen !== hook) Object.assign(pretest, { passed: false, reason: `Video dựng câu mở đầu ${hook}, nhưng Micro Fish chọn ${pretest.chosen}; vẫn là nháp.` });
  const title = String(input.title ?? script?.spine?.question ?? camp.product ?? sid).slice(0, 200);
  const key = `${campaign}#${sid}/${hook}/${canvas}`;
  const out = [];
  for (const { ch, platform } of chans) {
    let hold = null, reason = null, files = null;
    if (typeof error === 'string' && error.trim()) { hold = 'render_failed'; reason = `Dựng video lỗi: ${error.trim().slice(0, 300)}. Vẫn là nháp.`; }
    else if (!delivery) { hold = 'render_failed'; reason = `Chưa có video đã dựng (${sid}/${hook}); mvf export chưa xong. Vẫn là nháp.`; }
    else if (delivery.draft) { hold = 'render_failed'; reason = 'Bản dựng là bản nháp (--draft); cần xuất bản đầy đủ. Vẫn là nháp.'; }
    else {
      files = await readPlatform(ws, campaign, delivery, platform);
      if (files.error) { hold = 'render_failed'; reason = `${files.error} Vẫn là nháp.`; files = null; }
    }
    if (!hold && !pretest.passed) { hold = 'weak_hook'; reason = pretest.reason; }
    const copy = files?.copy ?? String(script?.platforms?.[platform]?.post ?? script?.platforms?.[platform]?.caption ?? '').trim();
    const body = copy || `Video "${title}"`;
    const brief = { title, video_key: key, script: sid, hook, canvas, campaign_dir: campaign, ...(hold ? { hold } : {}) };
    const fields = { kind: 'video', channel: ch.key, campaign: null, parent: typeof parent === 'string' && /^P-[0-9A-F]{10}$/.test(parent) ? parent : null, brief, title, body, link: null };
    const hash = hashOf(fields);
    const mine = (await store.query('posts', [eq('kind', 'video'), eq('channel', ch.key)], { limit: 200 })).find(p => p.brief?.video_key === key && !['removed'].includes(p.state));
    const assetsNow = files ? [
      { kind: 'video', path: files.video, meta: { sha256: files.sha256, bytes: files.bytes, duration_s: files.duration_s, platform, canvas, ...(files.ai_label ? { ai_label: true } : {}) }, pretest },
      ...(files.captions ? [{ kind: 'captions', path: `${dirname(files.video)}/captions.srt`, meta: { text: files.captions } }] : []),
      ...(files.poster ? [{ kind: 'poster', path: files.poster.path, meta: { data_uri: files.poster.data_uri } }] : []),
    ] : [{ kind: 'video', path: null, meta: { platform, canvas, error: reason }, pretest }];
    if (mine) {
      if (['publishing', 'published', 'unpublishing', 'uncertain'].includes(mine.state)) { out.push({ id: mine.ref, channel: ch.key, state: mine.state, label: STATE_LABEL[mine.state], unchanged: true }); continue; }
      const old = await postAssets(store, mine);
      const same = mine.content_hash === hash && (mine.reason ?? null) === reason && JSON.stringify(old.map(a => [a.kind, a.path, a.meta?.sha256 ?? null]).sort()) === JSON.stringify(assetsNow.map(a => [a.kind, a.path, a.meta?.sha256 ?? null]).sort())
        && JSON.stringify(old.find(a => a.kind === 'video')?.pretest ?? null) === JSON.stringify(pretest);
      if (same) { out.push({ id: mine.ref, channel: ch.key, revision: mine.revision, state: mine.state, hold, reason, unchanged: true }); continue; }
      await store.remove('assets', [eq('post', mine.ref)]);
      const ids = [];
      for (const a of assetsNow) { const ref = assetRef(); await store.insert('assets', { ref, post: mine.ref, ...a, pretest: a.pretest ?? null }); ids.push(ref); }
      const revision = mine.revision + 1;
      await store.update('posts', [eq('ref', mine.ref)], { ...fields, asset_ids: ids, content_hash: hash, state: 'draft', reason, revision });
      await store.remove('queue', [eq('post', mine.ref), isNull('intent_id')]);
      out.push({ id: mine.ref, channel: ch.key, revision, state: 'draft', hold, reason, assets: ids });
      continue;
    }
    const rid = `${request_id}:${ch.key}`;
    const seen = await store.one('posts', [eq('request_id', rid)]);
    if (seen) { out.push({ id: seen.ref, channel: ch.key, revision: seen.revision, state: seen.state, replayed: true }); continue; }
    const ref = 'P-' + randomBytes(5).toString('hex').toUpperCase();
    const ids = [];
    for (const a of assetsNow) { const aref = assetRef(); await store.insert('assets', { ref: aref, post: ref, ...a, pretest: a.pretest ?? null }); ids.push(aref); }
    await store.insert('posts', { ...fields, ref, request_id: rid, asset_ids: ids, content_hash: hash, state: 'draft', reason, revision: 1, author_soot: soot ?? null });
    out.push({ id: ref, channel: ch.key, revision: 1, state: 'draft', hold, reason, assets: ids });
  }
  return {
    posts: out, script: sid, hook,
    pretest: { method: pretest.method, passed: pretest.passed, bar, chosen: pretest.chosen, hooks: pretest.hooks.map(({ id, score }) => ({ id, score })) },
    next: out.some(p => !p.hold && p.state === 'draft') ? 'Editor: marketing_check từng bài (đúng revision), rồi marketing_schedule.' : 'Không có bài nào đủ điều kiện xếp hàng; lý do ở từng bài.',
  };
}

/** The signed claim's media: what the browser uploads, with its hash. */
export const claimAssets = assets => (assets ?? []).filter(a => a.kind === 'video' && a.path && a.meta?.sha256)
  .map(a => ({ kind: 'video', path: a.path, sha256: a.meta.sha256, bytes: a.meta.bytes ?? null, ...(a.meta.ai_label ? { ai_label: true } : {}) }));

/** The page's video block (Hàng đợi, Bài viết detail). */
export function videoView(assets) {
  const v = (assets ?? []).find(a => a.kind === 'video');
  if (!v) return null;
  const poster = assets.find(a => a.kind === 'poster')?.meta?.data_uri ?? null;
  const captions = assets.find(a => a.kind === 'captions')?.meta?.text ?? null;
  const p = v.pretest ?? {};
  return {
    path: v.path, open_link: v.path ? `nest://data/files/${v.path.split('/').map(encodeURIComponent).join('/')}` : null,
    duration_s: v.meta?.duration_s ?? null, platform: v.meta?.platform ?? null, poster, captions: captions ? srtCues(captions) : [],
    pretest: { method: p.method ?? null, n: p.n ?? null, bar: p.bar ?? DEFAULT_BAR, passed: !!p.passed, caveat: p.caveat ?? null,
      hooks: (p.hooks ?? []).map(h => ({ id: h.id, text: h.text, score: h.score, chosen: !!h.chosen })) },
  };
}
