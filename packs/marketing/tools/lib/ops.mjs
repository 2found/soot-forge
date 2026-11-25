// Hubless marketing tools (design §3.2). Each op is `(input, deps)` with
// deps = {store, now, env, fetch, soot}; the entry wires the real ones.
// The hub-mode tools in pack.json are untouched and still forward when
// MARKETING_HUB is bound; nothing here reads it.
import { randomBytes, createHash } from 'node:crypto';
import { fail, eq, gte, isNull, skippedFor } from './store.mjs';
import { setPause } from './bundle.mjs';
import { autoChecks, briefLint, internalLinks, claimWindow, defaultsFor, platformOf } from './guard.mjs';
import { nextSlot, inQuiet, DEFAULT_QUIET } from './time.mjs';
import { contentHash, signClaim, CLAIM_TTL_MS, INTENT_STALE_MS } from './claim.mjs';
import { metricsRows } from './page.mjs';
import { claimAssets } from './video.mjs';
import { campaignExists, draftCampaign } from './campaign.mjs';
import { libraryRoot } from './root.mjs';
import { loadProducts, tiktokChannelId } from './library.mjs';
import { PLATFORM_HOST, signInLink, readProfiles, reportSignedOut, siteState, handleMismatch } from './profiles.mjs';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const ms = s => Date.parse(s ?? '');
/** A stored ISO moment (rules.signed_out_at), not a blank or a stray value. */
const validAt = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const ref = () => 'P-' + randomBytes(5).toString('hex').toUpperCase();
const intentID = () => 'I-' + randomBytes(8).toString('hex');

// States a person reads (Bài viết tabs and badges).
export const CLASS_LABEL = { safe: 'an toàn', complaint: 'phàn nàn', money: 'tiền', account: 'tài khoản', flagged: 'cần xem', spam: 'rác' };
export const STATE_LABEL = {
  draft: 'Nháp', checking: 'Đang kiểm tra', refused: 'Bị từ chối', ready: 'Đã kiểm tra', scheduled: 'Chờ đăng', publishing: 'Đang đăng',
  published: 'Đã đăng', failed: 'Lỗi · thử lại', pulled: 'Đã kéo ra', unpublishing: 'Đang gỡ', removed: 'Đã gỡ', uncertain: 'Chưa rõ',
};

// ---------- settings and channels ----------

export async function getSettings(store) {
  const rows = await store.query('settings', [], { limit: 100 });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // The desk's pause-everything (settings.desk_pause.all) holds this chain too: one pause, two readers.
  return { paused_all: s.paused_all === true || !!(s.desk_pause && typeof s.desk_pause === 'object' && s.desk_pause.all), quiet_hours: s.quiet_hours ?? DEFAULT_QUIET, stale_after_h: s.stale_after_h ?? 6, paused_at: s.paused_at ?? null, gsc: s.gsc ?? null, project: s.project ?? null, writer: s.writer ?? null, video_pretest_bar: Number.isFinite(s.video_pretest_bar) ? s.video_pretest_bar : null };
}

export async function setSetting(store, key, value) {
  if (await store.update('settings', [eq('key', key)], { value })) return;
  try { await store.insert('settings', { key, value }); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('settings', [eq('key', key)], { value }); }
}

/** The browser profile id the Publisher drives for a channel (a person-named id such as "tiktok-lohi"), or null. */
export const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const profileOf = ch => (typeof ch?.rules?.profile === 'string' && PROFILE_RE.test(ch.rules.profile) ? ch.rules.profile : null);

/** A `tiktok` row stored under the old default (the founder's upload: hand, no caps, no rules) that no person set. */
export function isLegacyTiktok(row) {
  if (platformOf(row?.key) !== 'tiktok' || row.publisher !== 'hand' || row.rules?.publisher_by === 'person') return false;
  if ((row.cap_per_day ?? 0) !== 0 || (row.spacing_min ?? 0) !== 0 || (row.reply_cap_per_day ?? 0) !== 0) return false;
  return Object.keys(row.rules ?? {}).every(k => ['profile', 'product', 'video_channel'].includes(k));
}

/**
 * A stored legacy TikTok row follows the new default (browser, 2 a day, 240 minutes, TikTok's caption rules) on first use.
 * It is paused for a person ("person": no sign-in card for a channel nobody named a profile for) and resumes with Bật.
 * A row a person set to `hand` (rules.publisher_by "person") or gave any cap is never touched.
 */
async function migrateLegacy(store, row) {
  const d = defaultsFor(row.key);
  const set = { kind: d.kind, publisher: d.publisher, cap_per_day: d.cap_per_day, spacing_min: d.spacing_min, reply_cap_per_day: d.reply_cap_per_day, rules: { ...d.rules, ...(row.rules ?? {}) },
    paused: true, paused_reason: row.paused ? row.paused_reason ?? 'person' : 'person' };
  await store.update('channels', [eq('key', row.key)], set);
  return { ...row, ...set };
}

/** The legacy single `tiktok` channel: no account, so no browser profile to post from. It is never created again. */
export const LEGACY_TIKTOK = 'tiktok';
const tiktokAccountRequired = () => fail('tiktok_account_required', 'TikTok đăng theo từng tài khoản: dùng kênh tiktok-<tài khoản> (channels_setup from_products tạo sẵn từ products.json).');

export async function channel(store, key) {
  const row = await store.one('channels', [eq('key', key)]);
  // An existing `tiktok` row is returned as it is (retired, or still waiting for its repair), so its old posts resolve.
  if (row) return isLegacyTiktok(row) && key !== LEGACY_TIKTOK ? migrateLegacy(store, row) : row;
  if (key === LEGACY_TIKTOK) tiktokAccountRequired();
  const d = defaultsFor(key);
  if (!d) fail('unknown_channel', `Không có kênh "${key}".`);
  // A channel a browser drives starts paused until its first sign-in (p3).
  const browser = d.publisher === 'browser';
  const fresh = { key, ...d, platform: platformOf(key) ?? d.kind, paused: browser, paused_reason: browser ? 'signed_out' : null, account: null };
  try { await store.insert('channels', fresh); } catch (e) { if (e.code !== 'conflict') throw e; }
  return (await store.one('channels', [eq('key', key)])) ?? fresh;
}

/** The video channel folder a post was cut in: `…/channels/<folder>/campaigns/…` of its campaign_dir. */
const CAMPAIGN_FOLDER = /(?:^|\/)channels\/([a-z0-9][a-z0-9-]{0,79})\/campaigns\//;
const LEDGER_MAX = 50;
const LEGACY_PAGE = 500;

/**
 * The one-time repair of the legacy `tiktok` row (pack storage stays at version 8, so this is a data repair behind the
 * `settings.legacy_tiktok` marker, run by the write tools that touch channels). A post on it moves, with its queue,
 * publish_log and reply rows, to the `tiktok-<handle>` that **exactly one** account matches: the one account whose
 * `video_channel` is the folder the post was cut in, else the product's only account. Anything else stays where it is.
 * The row itself is then paused with reason `retired`: no sign-in card, no post, never resumed. Nothing is deleted, an
 * intent stays on its queue row and no post changes state (an uncertain post is never queued again). Without products.json
 * (due has no MARKETING_ROOT) only a folder match moves a post, and a post nothing places waits unmarked for a run with
 * the library; a full page also waits for the next run. A second run after the marker does nothing.
 */
export async function retireLegacyTiktok(store, { env, now = Date.now() } = {}) {
  const mark = (await store.one('settings', [eq('key', 'legacy_tiktok')]))?.value;
  if (mark?.at) return { ...mark, replayed: true };
  const row = await store.one('channels', [eq('key', LEGACY_TIKTOK)]);
  if (!row) { const v = { at: iso(now), row: false }; await setSetting(store, 'legacy_tiktok', v); return v; }
  // The accounts: the stored tiktok-<handle> rows, then products.json's accounts when the library is readable.
  const accounts = new Map();
  for (const c of await store.query('channels', [], { limit: 50 })) {
    if (c.key === LEGACY_TIKTOK || platformOf(c.key) !== 'tiktok' || c.paused_reason === 'retired') continue;
    accounts.set(c.key, { key: c.key, product: c.rules?.product ?? null, folder: c.rules?.video_channel ?? null });
  }
  const folderProduct = new Map();
  const lr = env ? await libraryRoot(env).catch(() => ({ ok: false })) : { ok: false };
  if (lr.ok) {
    for (const p of await loadProducts({ root: lr.root }).catch(() => [])) {
      for (const f of p.video_channels ?? []) folderProduct.set(f, p.id);
      for (const a of p.tiktok_accounts ?? []) {
        const key = tiktokChannelId(a.handle), had = accounts.get(key);
        accounts.set(key, { key, product: had?.product ?? p.id, folder: had?.folder ?? a.video_channel ?? null });
      }
    }
  }
  const all = [...accounts.values()];
  for (const a of all) if (a.folder && a.product && !folderProduct.has(a.folder)) folderProduct.set(a.folder, a.product);
  const target = (p) => {
    const folder = CAMPAIGN_FOLDER.exec(p.brief?.campaign_dir ?? '')?.[1] ?? null;
    const byFolder = folder ? all.filter(a => a.folder === folder) : [];
    if (byFolder.length) return byFolder.length === 1 ? byFolder[0].key : null;
    // Without products.json only a folder match is sure: the stored rows may not be all of a product's accounts.
    if (!lr.ok) return null;
    const products = [...new Set(all.map(a => a.product))];
    const product = (folder && folderProduct.get(folder)) ?? (products.length === 1 ? products[0] : null);
    const mine = product ? all.filter(a => a.product === product) : [];
    return mine.length === 1 ? mine[0].key : null;
  };
  const posts = await store.query('posts', [eq('channel', LEGACY_TIKTOK)], { limit: LEGACY_PAGE });
  // No account is known yet (no tiktok-<handle> row, no readable products.json): wait for one rather than keep every post
  // on the old row for good. The row is not used meanwhile: it is `hand`, so nothing posts from it.
  if (posts.length && !all.length) return { at: null, waiting: 'no_accounts', posts: posts.length };
  const moved = [], kept = [];
  for (const p of posts) {
    const to = target(p);
    if (!to) { kept.push(p.ref); continue; }
    // The post moves last: until it does, a rerun after a failure here still finds it and moves the rest.
    await store.update('queue', [eq('post', p.ref)], { channel: to });
    await store.update('publish_log', [eq('post', p.ref)], { channel: to });
    await store.update('replies', [eq('parent_post', p.ref)], { channel: to });
    await store.update('posts', [eq('ref', p.ref)], { channel: to });
    moved.push({ post: p.ref, to });
  }
  // A full page may not be all of them: the next write tool goes on (moved posts have left the page).
  if (posts.length === LEGACY_PAGE && moved.length) return { at: null, waiting: 'more', moved_n: moved.length };
  // Without products.json a post no folder places waits for it, rather than staying on the retired row for good.
  if (kept.length && !lr.ok) return { at: null, waiting: 'no_library', moved_n: moved.length, kept_n: kept.length };
  await store.update('channels', [eq('key', LEGACY_TIKTOK)], { paused: true, paused_reason: 'retired' });
  await clearAttention(store, 'channel', LEGACY_TIKTOK);
  const v = { at: iso(now), row: true, moved: moved.slice(0, LEDGER_MAX), kept: kept.slice(0, LEDGER_MAX), moved_n: moved.length, kept_n: kept.length };
  await setSetting(store, 'legacy_tiktok', v);
  return v;
}

/** The channel a new post goes on: never the legacy `tiktok` row, which only keeps its old posts. */
export async function postChannel(store, key) {
  if (key === LEGACY_TIKTOK) tiktokAccountRequired();
  return channel(store, key);
}

async function post(store, id) {
  if (typeof id !== 'string' || !id) fail('invalid_request', 'id is required.');
  const row = await store.one('posts', [eq('ref', id)]);
  if (!row) fail('not_found', `Không có bài ${id}.`);
  return row;
}
export const hashOf = p => contentHash({ title: p.brief?.title ?? '', meta: p.brief?.meta ?? '', slug: p.brief?.slug ?? '', body: p.body ?? '', link: p.link ?? '' });

/** A video post's asset rows (its file, captions, poster); none for other kinds. */
export const postAssets = (store, p) => (p.kind === 'video' ? store.query('assets', [eq('post', p.ref)], { limit: 20 }) : Promise.resolve([]));

async function guardInputs(store, p, now) {
  const [ch, facts, log, assets] = await Promise.all([
    channel(store, p.channel),
    store.query('facts', [], { limit: 500 }),
    store.query('publish_log', [gte('at', iso(now - 90 * DAY))], { order: 'at', limit: 500 }),
    postAssets(store, p),
  ]);
  return { channel: ch, facts, log: log.filter(r => r.post !== p.ref), now, assets };
}

// ---------- write side ----------

export async function draft_save(input, { store, now, soot }) {
  const { request_id, id, expected_revision, kind, channel: chKey, campaign, parent, brief, body, link, asset_ids, awareness } = input;
  if (!['article', 'social', 'video', 'reply'].includes(kind)) fail('invalid_request', 'kind is article, social, video or reply.');
  if (typeof body !== 'string' || !body.trim()) fail('invalid_request', 'body is required.');
  // nấc 1/2/3 the post speaks to; a post saved without it stays untagged (counted as chưa gắn, never guessed).
  if (awareness !== undefined && !['unaware', 'problem', 'choosing'].includes(awareness)) fail('invalid_request', 'awareness is unaware, problem or choosing.');
  const ch = await postChannel(store, chKey);
  if (ch.rules?.video_required && kind !== 'video') fail('invalid_request', `Kênh ${ch.key} chỉ đăng video (kind "video", từ marketing_video_import); bài ${kind} không đăng ở đây.`);
  if (!id && request_id) {
    const seen = await store.one('posts', [eq('request_id', request_id)]);
    if (seen) return { id: seen.ref, revision: seen.revision, content_hash: seen.content_hash, state: seen.state, lint: briefLint(seen, ch), replayed: true };
  }
  // A reply answers one saved reader reply; its target comes from that row, never from the model.
  const target = kind === 'reply' ? await answerable(store, parent, ch, body, id) : null;
  // A post in a campaign is on one of its channels and, for social and video, goes out with that channel's link.
  // An edit that leaves `campaign` out keeps the post's campaign.
  const campKey = campaign ?? (id ? (await store.one('posts', [eq('ref', id)]))?.campaign : null) ?? null;
  // A kept key that names no campaign (an older free-text tag) stays as it was; a given one must exist.
  const kept = campaign === undefined || campaign === null;
  const camp = campKey && !(kept && !(await campaignExists(store, campKey))) ? await draftCampaign(store, campKey, ch.key) : null;
  const useLink = link ?? (camp && ['social', 'video'].includes(kind) ? camp.link : null);
  const fields = { kind, channel: ch.key, campaign: campKey, parent: parent ?? null, brief: target ?? brief ?? null, title: brief?.title ?? null, body, link: useLink ?? null, asset_ids: asset_ids ?? null };
  const lint = briefLint(fields, ch);
  if (camp && !camp.link) lint.push({ field: 'link', code: 'campaign_link_missing', message: 'Chiến dịch chưa có liên kết cho kênh này; lưu lại chiến dịch để tạo.' });
  const extra = camp ? { campaign_link: camp.link } : {};
  if (!id) {
    // The same words saved again (a repeated call) are the draft already there, not a duplicate to refuse.
    const same = await store.one('posts', [eq('content_hash', hashOf(fields)), eq('channel', ch.key)]);
    if (same && ['draft', 'checking', 'ready', 'scheduled'].includes(same.state)) return { id: same.ref, revision: same.revision, content_hash: same.content_hash, state: same.state, lint, replayed: true, ...extra };
    const row = { ...fields, ref: ref(), request_id: request_id ?? null, content_hash: hashOf(fields), state: 'draft', reason: null, revision: 1, author_soot: soot ?? null, awareness: awareness ?? null };
    await store.insert('posts', row);
    return { id: row.ref, revision: 1, content_hash: row.content_hash, state: 'draft', lint, ...extra };
  }
  const cur = await post(store, id);
  if (['publishing', 'published', 'unpublishing', 'uncertain'].includes(cur.state)) fail('conflict', 'Bài đang đăng, đã đăng hoặc chưa rõ đã lên chưa; gỡ hoặc xác nhận trước rồi sửa.');
  // Editing a video's copy keeps what video_import recorded (its files, hold and campaign key).
  if (cur.kind === 'video' && kind === 'video') {
    const { title: t, keyword, meta, slug } = brief ?? {};
    fields.brief = { ...(cur.brief ?? {}), ...(t ? { title: t } : {}), ...(keyword ? { keyword } : {}), ...(meta ? { meta } : {}), ...(slug ? { slug } : {}) };
    fields.title = fields.brief.title ?? cur.title;
    fields.asset_ids = cur.asset_ids;
  }
  if (expected_revision !== cur.revision) fail('revision_conflict', `Bài đang ở bản ${cur.revision}.`);
  const revision = cur.revision + 1;
  const n = await store.update('posts', [eq('ref', id), eq('revision', cur.revision)], { ...fields, content_hash: hashOf(fields), state: 'draft', reason: cur.kind === 'video' && cur.brief?.hold ? cur.reason : null, revision, ...(awareness ? { awareness } : {}) });
  if (!n) fail('revision_conflict', 'Bài vừa được sửa ở nơi khác.');
  await store.remove('queue', [eq('post', id), isNull('intent_id')]);
  return { id, revision, content_hash: hashOf(fields), state: 'draft', lint, ...extra };
}

/** The reply row a `kind:"reply"` post answers, or a refusal: only `safe`
 * replies are answered; an `account` reply gets exactly the channel's fixed
 * pointer (`rules.support_reply`); complaint, money and flagged never. */
export async function answerable(store, parent, ch, body, self = null) {
  if (typeof parent !== 'string' || !parent) fail('invalid_request', 'A reply names the saved reply it answers in parent (R-…).');
  const r = await store.one('replies', [eq('ref', parent)]);
  if (!r || r.channel !== ch.key) fail('not_found', `Không có phản hồi ${parent} trên kênh này.`);
  // One answer per reader reply: an answered one, or one another live draft already answers, is refused.
  const others = (await store.query('posts', [eq('parent', parent)], { limit: 20 })).filter(o => o.ref !== self && !['refused', 'pulled', 'removed'].includes(o.state));
  if (r.state === 'answered' || others.length) fail('not_answerable', `Phản hồi ${parent} đã có câu trả lời${others.length ? ` (${others[0].ref})` : ''}; Soot không trả lời hai lần.`);
  const pointer = ch.rules?.support_reply;
  if (r.class === 'account') {
    if (!pointer || String(body).trim() !== pointer.trim()) fail('not_answerable', 'Câu hỏi tài khoản chỉ được trả lời bằng câu chỉ đường Hỗ trợ Lohi cố định.');
  } else if (r.class !== 'safe') {
    fail('not_answerable', `Soot không tự trả lời phản hồi loại ${CLASS_LABEL[r.class] ?? r.class}; việc này nằm ở Cần bạn.`);
  }
  return { reply_to: r.author_handle ?? null, reply_url: r.reply_url ?? null, thread_url: r.thread_url ?? null };
}

/** HEAD (then GET) each internal link once: only a 404/410 is dead; a network error or odd status is "not verified", never a failure. */
export async function checkLinks(post, channel, fetch) {
  const hosts = channel?.rules?.internal_hosts ?? [];
  const urls = [...new Set(internalLinks(post.body, hosts).map(u => u.replace(/[.,;:!?]+$/, '')))].slice(0, 12);
  if (post.kind !== 'article' || !urls.length) return null;
  const dead = [], unknown = [];
  await Promise.all(urls.map(async u => {
    let status = 0;
    for (const method of ['HEAD', 'GET']) {
      try { status = (await fetch(u, { method, redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'soot-marketing/1.0' } })).status; } catch { status = 0; }
      if (status && status !== 405 && status !== 501) break;
    }
    if (status === 404 || status === 410) dead.push(u); else if (!(status >= 200 && status < 400)) unknown.push(u);
  }));
  if (dead.length) return { rule: 'links', ok: false, code: 'dead_link', detail: `Liên kết không còn: ${dead.join(', ')}` };
  return { rule: 'links', ok: true, detail: unknown.length ? `${urls.length - unknown.length}/${urls.length} liên kết mở được; ${unknown.length} chưa kiểm tra được` : `${urls.length} liên kết nội bộ mở được` };
}

export async function check(input, { store, now, soot, fetch }) {
  const p = await post(store, input.id);
  if (input.revision !== p.revision) fail('revision_conflict', `Bài đang ở bản ${p.revision}.`);
  if (!['draft', 'checking', 'refused', 'ready'].includes(p.state)) fail('conflict', `Bài đang ${STATE_LABEL[p.state]}; không kiểm tra lại được.`);
  if (!['pass', 'fail'].includes(input.verdict)) fail('invalid_request', 'verdict is pass or fail.');
  const inputs = await guardInputs(store, p, now);
  const auto = autoChecks(p, inputs);
  const links = await checkLinks(p, inputs.channel, fetch ?? globalThis.fetch);
  if (links) auto.push(links);
  const reasons = Array.isArray(input.reasons) ? input.reasons.map(String).slice(0, 20) : [];
  const failed = auto.filter(a => !a.ok);
  const verdict = failed.length || input.verdict === 'fail' ? 'fail' : 'pass';
  await store.insert('checks', { post: p.ref, revision: p.revision, content_hash: p.content_hash, checker_soot: soot ?? null, verdict, auto, reasons, at: iso(now) });
  const reason = verdict === 'pass' ? null : [...failed.map(a => a.detail), ...(input.verdict === 'fail' ? reasons : [])].join(' · ') || 'Editor không duyệt.';
  // A video that is not rendered or whose hook is under the bar stays a draft with its reason (#p4-video-failed).
  // Any other failed rule (facts, personal data, duplicate…) still refuses it.
  const held = failed.length > 0 && failed.every(a => a.rule === 'video');
  await store.update('posts', [eq('ref', p.ref)], { state: verdict === 'pass' ? 'ready' : held ? 'draft' : 'refused', reason });
  return { verdict, ...(held ? { state: 'draft' } : {}), auto: auto.map(({ rule, ok, detail }) => ({ rule, ok, detail })), ...(reason ? { reason } : {}) };
}

export async function takenTimes(store, chKey, now, own, action = 'publish') {
  const [queued, log] = await Promise.all([
    store.query('queue', [eq('channel', chKey)], { order: 'scheduled_at', limit: 500 }),
    store.query('publish_log', [eq('channel', chKey), gte('at', iso(now - 7 * DAY))], { order: 'at', limit: 500 }),
  ]);
  const times = [
    ...queued.filter(q => (q.action ?? 'publish') === action && q.post !== own).map(q => ms(q.scheduled_at)),
    ...log.filter(r => r.action === action && ['published', 'intent'].includes(r.status)).map(r => ms(r.at)),
  ];
  return { mine: queued.find(q => q.post === own) ?? null, times };
}

export async function schedule(input, { store, now }) {
  const p = await post(store, input.id);
  if (!['ready', 'pulled', 'failed', 'scheduled'].includes(p.state)) fail('not_ready', `Chỉ xếp lịch bài đã kiểm tra; bài đang ${STATE_LABEL[p.state]}.`);
  if (p.state === 'pulled' || p.state === 'failed') {
    const last = await latestCheck(store, p);
    if (!last || last.verdict !== 'pass' || last.content_hash !== p.content_hash) fail('not_ready', 'Bài cần Editor kiểm tra lại.');
  }
  const ch = await channel(store, p.channel);
  if (ch.publisher === 'hand') fail('handoff_channel', `Kênh ${ch.key} do người sáng lập tự đăng: để bài ở bàn Marketing làm việc giao tay, không xếp lịch.`);
  const settings = await getSettings(store);
  const action = p.kind === 'reply' ? 'reply' : 'publish';
  const { mine, times } = await takenTimes(store, ch.key, now, p.ref, action);
  if (mine?.intent_id) fail('conflict', 'Bài đang được đăng.');
  let at;
  if (input.scheduled_at) {
    at = ms(input.scheduled_at);
    if (!Number.isFinite(at)) fail('invalid_request', 'scheduled_at is an RFC 3339 time.');
  } else {
    const jitter = parseInt(createHash('sha256').update(p.ref).digest('hex').slice(0, 2), 16) % 10;
    at = action === 'reply'
      ? nextSlot({ from: now, taken: times, cap: ch.reply_cap_per_day ?? 0, spacingMin: ch.rules?.reply_spacing_min ?? 0, quiet: settings.quiet_hours, jitterMin: jitter % 3 })
      : nextSlot({ from: now, taken: times, cap: ch.cap_per_day ?? 1, spacingMin: ch.spacing_min ?? 0, quiet: settings.quiet_hours, jitterMin: jitter });
    if (at == null) fail('no_slot', 'Không còn khung giờ trống trong 30 ngày.');
  }
  if (mine) await store.update('queue', [eq('post', p.ref)], { scheduled_at: iso(at), action, wait_reason: null });
  else await store.insert('queue', { post: p.ref, channel: ch.key, action, scheduled_at: iso(at), intent_id: null, intent_at: null, attempts: 0, wait_reason: null });
  await store.update('posts', [eq('ref', p.ref)], { state: 'scheduled', reason: null });
  await clearAttention(store, 'late', p.ref);
  return { id: p.ref, scheduled_at: iso(at) };
}

async function latestCheck(store, p) {
  return (await store.query('checks', [eq('post', p.ref)], { order: 'at', limit: 1 }))[0] ?? null;
}

// ---------- the dispatcher's read ----------

const NEST_LINE = /^nest:\/\/\S+$/;
const slug = i => `o${i + 1}`;

/**
 * The Cần bạn cards for the needs (`raise`) and the cards to close (`settle`), answered on the schedule's own call so the
 * runtime files them with no model. A card is one need of one incident: its id is the need key plus the time the need
 * first showed (an `inc:` row in `attention`, gone when the need is answered or resolves), so a channel that signs out
 * again later is a new card, and an unanswered one is raised again after 72 hours by the runtime. Each option runs
 * `marketing_answer` (or, for a sign-in, `marketing_pause {signed_in}`) by itself; only a pick that needs the person's
 * words wakes the Editor. A need the Editor already filed (`raised`) gets no second card.
 * Sign-ins are one card per browser profile (group `signin:<profile>`, so a newer one replaces it): its link opens that
 * profile's sign-in in Nest, and once the person records it there `due` resumes the channels and the card settles. The
 * "Đã đăng nhập" option stays for a host without the profile read, never the recommended pick.
 */
const signInGroup = n => (n.profile ? `signin:${n.profile}` : `need:${n.key}`);
async function needCards(needs, { store, settings, soot, byKey, replies, raised, now }) {
  const raise = [];
  const live = new Set();
  const signIns = new Map();
  const marks = new Map(raised.filter(r => r.key.startsWith('inc:')).map(r => [r.key.slice(4), r]));
  for (const n of needs) {
    live.add(n.key);
    if (n.raised) continue;
    let mark = marks.get(n.key);
    if (!mark) {
      mark = { key: 'inc:' + n.key, kind: 'inc-' + n.kind, ref: n.id, reason: n.reason, raised_at: iso(now) };
      try { await store.insert('attention', mark); } catch (e) { if (e.code !== 'conflict') throw e; }
    }
    const id = `need:${n.key}@${Date.parse(mark.raised_at)}`;
    if (n.login_url) {
      const group = signInGroup(n);
      if (!signIns.has(group)) signIns.set(group, []);
      signIns.get(group).push({ n, at: Date.parse(mark.raised_at) });
      continue;
    }
    const ask = await askFor(n, { store, settings, soot, byKey, replies });
    const link = ask.missing.split('\n').map(l => l.trim()).find(l => NEST_LINE.test(l));
    const labels = ask.options;
    raise.push({
      id, group: `need:${n.key}`, title: ask.summary, why: ask.missing.split('\n').filter(l => l.trim() !== link).join('\n'),
      ...(link ? { link, link_label: 'Mở' } : {}),
      options: labels.map((o, i) => (n.kind === 'uncertain' && o.label === ANSWERS.uncertain[0]
        // The person's live link is words only a turn can take: this one pick wakes the Editor.
        ? { id: slug(i), label: o.label, wake: `The person picked "${o.label}" on ${n.key}. Ask for the post's link with one report_blocker (no options), then marketing_answer {key: "${n.key}", option: "${o.label}", url}.` }
        : { id: slug(i), label: o.label, recommended: o.recommended, tool: { pack: 'marketing', name: 'answer', input: { key: n.key, option: o.label } } })),
      reraise_after_hours: 72,
    });
  }
  const settle = [];
  for (const [group, list] of signIns) {
    // In platform order. The id is the profile's oldest live incident and its channels, so a channel that resumes or
    // joins gives a new id, which replaces the card in its group.
    const order = Object.keys(LOGIN_URL);
    list.sort((a, b) => order.indexOf(a.n.platform) - order.indexOf(b.n.platform) || String(a.n.channel).localeCompare(String(b.n.channel)));
    const first = list[0], since = Math.min(...list.map(x => x.at));
    const many = list.length > 1;
    raise.push({
      id: `${group}@${since}.${createHash('sha256').update(list.map(x => x.n.channel).join(',')).digest('hex').slice(0, 8)}`, group, title: many ? `Đăng nhập ${list.map(x => x.n.platform_label).join(', ')}` : first.n.title,
      why: list.map(({ n }) => `${many ? `${n.platform_label}: ` : ''}${n.steps}. Trang đăng nhập: ${n.login_url}`).join('\n'),
      link: first.n.link, link_label: 'Đăng nhập',
      options: list.slice(0, 4).map(({ n }, i) => ({ id: many ? `signed_in_${i + 1}` : 'signed_in', label: `Đã đăng nhập ${n.platform_label}`, tool: { pack: 'marketing', name: 'pause', input: { channel: n.channel, paused: true, signed_in: true } } })),
      reraise_after_hours: 72,
    });
    // A card an older version raised per channel (group need:<key>) closes: the profile's card says it all. Settling a
    // card that is not there does nothing.
    if (group.startsWith('signin:')) for (const { n } of list) settle.push(`need:${n.key}`);
  }
  // Incidents whose need is gone: forget the mark and close the card (a profile's once none of its sign-ins is left).
  for (const [key, row] of marks) {
    if (live.has(key)) continue;
    await store.remove('attention', [eq('key', row.key)]);
    settle.push(`need:${key}`);
    const profile = row.kind === 'inc-channel' && key.endsWith(':signed_out') ? profileOf(byKey[row.ref]) : null;
    if (profile && !signIns.has(`signin:${profile}`) && !settle.includes(`signin:${profile}`)) settle.push(`signin:${profile}`);
  }
  return { ...(raise.length ? { raise } : {}), ...(settle.length ? { settle } : {}) };
}


// Cần bạn items (design §5): the dispatcher lists them, the woken Publisher
// files one report_blocker each and marks it with `raised`, so a schedule
// wakes once per item, not every 10 minutes.
export const NEED_LABEL = {
  signed_out: 'Đăng nhập lại', layout_changed: 'Giao diện nền tảng đổi', captcha: 'Nền tảng hỏi captcha',
  late: 'Bài lỡ giờ', uncertain: 'Không chắc đã đăng chưa',
  complaint: 'Phàn nàn', money: 'Tiền', account: 'Chuyển Hỗ trợ', flagged: 'Cần xem',
};
export const PAUSE_REASONS = ['signed_out', 'layout_changed', 'captcha'];
/** The platform's login page; the person signs in on the channel's browser profile (Nest: Kho khóa › Đăng nhập trình duyệt). */
export const LOGIN_URL = { x: 'https://x.com/i/flow/login', facebook: 'https://www.facebook.com/login', reddit: 'https://www.reddit.com/login', tiktok: 'https://www.tiktok.com/login' };
const PLATFORM_LABEL = { x: 'X', facebook: 'Facebook', reddit: 'Reddit', tiktok: 'TikTok' };
/** A platform's name; TikTok has one channel per account, so its name carries the account ("TikTok @lohi"). */
const channelLabel = (c, platform = c?.platform ?? platformOf(c?.key)) => (platform === 'tiktok' ? `TikTok ${c.account ?? String(c.key).replace(/^tiktok-?/, '') ?? ''}`.trim() : PLATFORM_LABEL[platform] ?? platform);
export const SIGN_IN_STEPS = 'Bấm Đăng nhập → đăng nhập trên trang vừa mở → bấm Tôi đã đăng nhập';
const needKey = n => `${n.kind}:${n.id}:${n.reason}`;

export async function clearAttention(store, kind, ref) {
  await store.remove('attention', [eq('kind', kind), eq('ref', ref)]);
  await store.remove('attention', [eq('kind', 'woke-' + kind), eq('ref', ref)]);
}

/** What a due queue row is, for waking the Editor once: the post, its action, its slot and its intent. */
const itemKey = q => `item:${q.post}:${q.action ?? 'publish'}:${String(q.scheduled_at ?? '').slice(0, 16)}:${q.intent_id ?? '-'}`;

/** The platforms `due {platform}` covers: one channel per account (tiktok-<handle>). */
const DUE_PLATFORMS = ['tiktok'];

/**
 * AC2.2: a channel paused `signed_out` whose browser profile has the platform's site signed in after the pause began
 * (`rules.signed_out_at`) is the person's sign-in in Nest: the channel resumes, its attention markers go, and its
 * Cần bạn card settles once the need is gone. A row paused before the pause time was kept gets it now (so only a
 * sign-in from here on resumes it). A sign-in as another account than the row's (Nest knows both handles) resumes
 * nothing. Without `browser.profiles.read` nothing resumes: `unread` says why.
 */
async function resumeSignedIn(channels, { store, env, fetch: fetchImpl, now }) {
  const waiting = channels.filter(c => c.paused && c.paused_reason === 'signed_out' && profileOf(c) && PLATFORM_HOST[c.platform ?? platformOf(c.key)]);
  if (!waiting.length) return { resumed: [] };
  for (const c of waiting) {
    if (validAt(c.rules?.signed_out_at)) continue;
    c.rules = { ...(c.rules ?? {}), signed_out_at: iso(now) };
    await store.update('channels', [eq('key', c.key)], { rules: c.rules });
  }
  const read = await readProfiles(env, fetchImpl);
  if (!read.ok) return { resumed: [], unread: read.why };
  const resumed = [];
  for (const c of waiting) {
    const site = siteState(read, profileOf(c), PLATFORM_HOST[c.platform ?? platformOf(c.key)]);
    if (site.state !== 'signed_in' || !(ms(site.at) > ms(c.rules.signed_out_at))) continue;
    // Signed in as another account than the row's: its posts would go out from that account, so the row keeps waiting.
    if (handleMismatch(site, c)) continue;
    await store.update('channels', [eq('key', c.key)], { paused: false, paused_reason: null });
    await store.remove('attention', [eq('kind', 'woke-item'), eq('reason', c.key)]);
    await clearAttention(store, 'channel', c.key);
    Object.assign(c, { paused: false, paused_reason: null });
    resumed.push(c.key);
  }
  return { resumed };
}

export async function due(input, { store, now, soot, env, fetch: fetchImpl }) {
  await retireLegacyTiktok(store, { env, now });
  const settings = await getSettings(store);
  const rows = await store.query('queue', [{ column: 'scheduled_at', op: 'lte', value: iso(now) }], { order: 'scheduled_at', desc: false, limit: 200 });
  const [channels, marks, held, open] = await Promise.all([
    store.query('channels', [], { limit: 50 }),
    store.query('attention', [], { limit: 500 }),
    store.query('posts', [eq('state', 'uncertain')], { limit: 50 }),
    store.query('replies', [eq('state', 'needs_person')], { limit: 50 }),
  ]);
  // A sign-in recorded in Nest resumes its channels before anything reads them (a tool chain posts on this very call).
  const signedIn = await resumeSignedIn(channels, { store, env, fetch: fetchImpl, now });
  // The markers resumeSignedIn just removed are gone (the incident marks stay: they settle the card below).
  const gone = r => (r.kind === 'woke-item' ? signedIn.resumed.includes(r.reason) : ['channel', 'woke-channel'].includes(r.kind) && signedIn.resumed.includes(r.ref));
  const raised = signedIn.resumed.length ? marks.filter(r => !gone(r)) : marks;
  const byKey = Object.fromEntries(channels.map(c => [c.key, c]));
  const seen = new Set(raised.map(r => r.key));
  const skip = Array.isArray(input.skip) ? input.skip : [];
  if (typeof input.channel === 'string') return dueChain([input.channel], { rows, channels, held, settings, now });
  if (input.platform !== undefined) {
    if (!DUE_PLATFORMS.includes(input.platform)) fail('invalid_request', `platform is one of ${DUE_PLATFORMS.join(', ')}.`);
    // Every account of the platform (tiktok-*), not the retired legacy row: one chain posts for all of them, one per fire.
    const keys = channels.filter(c => platformOf(c.key) === input.platform && c.key !== input.platform && c.paused_reason !== 'retired').map(c => c.key);
    return dueChain(keys, { rows, channels, held, settings, now });
  }
  const out = { wake: false, publish: [], unpublish: [], reply: [], late: [], needs_person: [], needs: [],
    ...(signedIn.resumed.length ? { resumed: signedIn.resumed } : {}), ...(signedIn.unread ? { sign_in_unread: signedIn.unread } : {}) };
  const items = [];
  // `woken`: the dispatch schedule already woke the Editor for this need (it may not have filed it yet); never wake twice for one.
  const need = n => out.needs.push({ ...n, key: needKey(n), label: n.label ?? NEED_LABEL[n.reason] ?? n.reason, raised: seen.has(needKey(n)), woken: seen.has('woke:' + needKey(n)) });
  for (const c of channels) {
    if (!c.paused || !c.paused_reason || ['person', 'signed_in', 'retired'].includes(c.paused_reason)) continue;
    out.needs_person.push({ id: c.key, channel: c.key, reason: c.paused_reason });
    const platform = c.platform ?? platformOf(c.key);
    // A sign-in names the platform's login page and the Nest link that opens the profile's sign-in on its site.
    const label = channelLabel(c, platform);
    const profile = profileOf(c);
    const signIn = c.paused_reason === 'signed_out' && LOGIN_URL[platform]
      ? { login_url: LOGIN_URL[platform], host: PLATFORM_HOST[platform], title: `Đăng nhập ${label}`, steps: profile ? `${SIGN_IN_STEPS} (hồ sơ trình duyệt ${profile})` : SIGN_IN_STEPS, link: signInLink(profile, PLATFORM_HOST[platform]) } : {};
    need({ kind: 'channel', id: c.key, channel: c.key, platform, platform_label: label, reason: c.paused_reason, account: c.account ?? null, ...(profile ? { profile } : {}), ...signIn });
  }
  // An uncertain post may be live: never claimed again until a person answers.
  const uncertain = new Set(held.map(p => p.ref));
  for (const p of held) need({ kind: 'uncertain', id: p.ref, channel: p.channel, reason: 'uncertain', url: p.url ?? null });
  // An account question is a handoff to the product's support, under the channel's own label.
  // Money first, then support handoffs, then complaints: the order a person should answer them.
  const URGENT = { money: 0, account: 1, complaint: 2 };
  for (const r of [...open].sort((a, b) => (URGENT[a.class] ?? 3) - (URGENT[b.class] ?? 3))) need({ kind: 'reply', id: r.ref, channel: r.channel, reason: r.class, thread_url: r.thread_url, reply_url: r.reply_url ?? null,
    ...(r.class === 'account' && byKey[r.channel]?.rules?.support_label ? { label: byKey[r.channel].rules.support_label } : {}) });
  for (const q of rows) {
    if (uncertain.has(q.post)) continue;
    const ch = byKey[q.channel];
    const stuck = q.intent_id && now - ms(q.intent_at) > INTENT_STALE_MS;
    if (q.intent_id && !stuck) continue;
    if (q.action === 'unpublish') { out.unpublish.push(q.post); items.push({ q, key: itemKey(q) }); continue; }
    // A paused channel is one Cần bạn item, not one per held post (claim still refuses a stale one).
    if (!q.intent_id && (settings.paused_all || ch?.paused)) continue;
    // A stale item is never posted on its own (a stuck intent is only verified, never re-posted).
    if (!q.intent_id && now - ms(q.scheduled_at) >= settings.stale_after_h * HOUR) {
      out.late.push(q.post);
      need({ kind: 'late', id: q.post, channel: q.channel, reason: 'late', scheduled_at: q.scheduled_at });
      continue;
    }
    if (settings.paused_all || ch?.paused) continue;
    // A channel the schedule's tool chain publishes is not the Editor's to claim.
    if (q.action !== 'reply' && (skip.includes(q.channel) || skip.includes(platformOf(q.channel)))) continue;
    (q.action === 'reply' ? out.reply : out.publish).push(q.post);
    items.push({ q, key: itemKey(q) });
  }
  // Every platform still signed out, as one ready Cần bạn item (report_blocker takes it as is).
  const order = Object.keys(LOGIN_URL);
  const signIns = out.needs.filter(n => n.login_url).sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
  if (signIns.length) {
    const labels = signIns.map(n => n.platform_label);
    out.sign_in = {
      summary: `Đăng nhập ${labels.join(', ')}${settings.project ? ` cho ${settings.project}` : ''}`,
      missing: [...signIns.map(n => `${n.platform_label}: ${SIGN_IN_STEPS}`), signIns[0].link].join('\n'),
      options: labels.slice(0, 4).map(l => ({ label: `Đã đăng nhập ${l}` })),
    };
  }
  // The one Cần bạn item to file now, ready for report_blocker as is: the sign-in first, then
  // each other need on its own (a conversation holds one item; the next comes after an answer).
  if (out.sign_in && (input.refile === true || signIns.some(n => !n.raised))) out.ask = { keys: signIns.map(n => n.key), ...out.sign_in };
  else {
    const next = out.needs.find(n => !n.raised && !n.login_url);
    if (next) out.ask = await askFor(next, { store, settings, soot, byKey, replies: open });
  }
  // The runtime's wake_when matches the boolean `notify` (or a string at a path), so both say the same.
  const scheduled = input.schedule === true;
  // On the schedule's own call a need is a card the runtime files itself (no model wakes to relay it), so only a need the
  // Editor's own turn raised before is skipped, and a need that is gone settles its card.
  const fresh = scheduled ? [] : out.needs.filter(n => !n.raised && !n.woken);
  if (scheduled) {
    delete out.ask;
    Object.assign(out, await needCards(out.needs, { store, settings, soot, byKey, replies: open, raised, now }));
  }
  // Nothing outstanding any more: the runtime closes the Cần bạn card this schedule raised (resolves_need).
  out.resolves_need = out.needs.length === 0;
  // A due item the Editor was already woken for (and could not finish: it parked on a person) never wakes it again
  // until the item changes state: a new slot, a new intent, or its channel resumed (pause clears these markers).
  const freshItems = items.filter(i => !seen.has('woke:' + i.key));
  out.waiting = items.length - freshItems.length;
  // A marker whose item is gone (published, dropped, rescheduled) is done with.
  const live = new Set(items.map(i => 'woke:' + i.key));
  for (const r of raised) if (r.kind === 'woke-item' && !live.has(r.key)) await store.remove('attention', [eq('key', r.key)]);
  out.wake = out.notify = freshItems.length > 0 || fresh.length > 0;
  // The schedule's own call remembers whom it woke for, so an unchanged item costs one model turn, ever.
  if (scheduled && out.notify) {
    for (const i of freshItems) {
      try { await store.insert('attention', { key: 'woke:' + i.key, kind: 'woke-item', ref: i.q.post, reason: i.q.channel, raised_at: iso(now) }); } catch (e) { if (e.code !== 'conflict') throw e; }
    }
  }
  return out;
}

/**
 * Tool-chain mode (`due {schedule:true, channel}`): the claim input for the one due publish on that
 * channel, `{id, action}`, or `{done:true}` (the chain stops quietly). Late, uncertain, paused and
 * in-flight items are not its business: they are Cần bạn items the Editor's own dispatch raises.
 */
/** The next due publish of one of `keys` (the oldest first) for a chain's claim, or {done: true, reason}. A paused
 *  channel posts nothing; with every channel paused the answer says so. */
function dueChain(keys, { rows, channels, held, settings, now }) {
  const live = new Set(keys.filter(k => !channels.find(c => c.key === k)?.paused));
  if (settings.paused_all || !live.size) return { done: true, reason: keys.length ? 'paused' : 'no_channel' };
  if (inQuiet(now, settings.quiet_hours ?? DEFAULT_QUIET)) return { done: true, reason: 'quiet_hours' };
  const uncertain = new Set(held.map(p => p.ref));
  for (const q of rows) {
    if (!live.has(q.channel) || (q.action ?? 'publish') !== 'publish' || uncertain.has(q.post)) continue;
    const stuck = q.intent_id && now - ms(q.intent_at) > INTENT_STALE_MS;
    if (q.intent_id && !stuck) continue;
    if (!q.intent_id && now - ms(q.scheduled_at) >= settings.stale_after_h * HOUR) continue;
    return { id: q.post, action: 'publish' };
  }
  return { done: true };
}

const TZ = 'Asia/Ho_Chi_Minh';
const hm = at => new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayHm = at => `${hm(at)} ${new Date(at).toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: TZ })}`;
const REPLY_WHY = { money: 'Soot không trả lời câu hỏi về tiền', complaint: 'Soot không trả lời phàn nàn', flagged: 'Soot không chắc nên chưa trả lời' };
export const ANSWERS = { uncertain: ['Đã lên — dán liên kết', 'Chưa lên — đăng lại', 'Bỏ bài'], late: ['Đăng ngay', 'Xếp lại', 'Bỏ'], reply: ['Xong'] };

/** One need as a ready Cần bạn item {keys, summary, missing, options}; marketing_answer applies the pick. */
async function askFor(n, { store, settings, soot, byKey, replies }) {
  const ch = byKey[n.channel] ?? {};
  const L = n.channel === 'blog-lohi' ? 'Blog' : (ch.key ? channelLabel(ch) : PLATFORM_LABEL[platformOf(n.channel)]) || n.channel;
  // The Soot's own browser, on the channel's profile when it names one (the page it met stays open there).
  const browser = soot ? `nest://browser/${soot}${profileOf(ch) ? `?profile=${encodeURIComponent(profileOf(ch))}` : ''}` : null;
  const item = (summary, missing, options, rec) => ({ keys: [n.key], summary, missing: missing.filter(Boolean).join('\n'), options: options.map(label => (label === rec ? { label, recommended: true } : { label })) });
  if (n.kind === 'channel') {
    const held = `Chưa đăng gì. Đăng ${L} đã dừng; bài vẫn ở hàng đợi.`;
    const opts = [`Chạy lại ${L}`, `Để ${L} dừng`];
    if (n.reason === 'captcha') return item(`${L} hỏi captcha`, [browser && `Giải captcha trong trình duyệt của Editor: ${browser}`, held], opts, opts[0]);
    return item(`${L} đổi giao diện: Editor không tìm thấy chỗ đăng bài`, [held, browser && `Xem trang Editor gặp: ${browser}`, `Bấm Chạy lại ${L} khi trang đã bình thường.`], opts, opts[0]);
  }
  if (n.kind === 'reply') {
    const r = replies.find(x => x.ref === n.id) ?? {};
    const why = n.reason === 'account'
      ? (ch.rules?.support_reply ? `Soot đã trả lời mẫu: "${ch.rules.support_reply}" · không gửi thông tin cá nhân` : 'Chuyển cho Hỗ trợ')
      : REPLY_WHY[n.reason] ?? 'Soot không trả lời';
    const link = r.reply_url ?? r.thread_url;
    return item(`${n.label}: "${String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 140)}"`, [`${L} · ${why}`, link && `Mở bình luận: ${link}`], ANSWERS.reply);
  }
  const p = (await store.one('posts', [eq('ref', n.id)])) ?? {};
  const title = `"${String(p.brief?.title ?? p.title ?? p.body ?? '').replace(/\s+/g, ' ').slice(0, 100)}"`;
  if (n.kind === 'uncertain') {
    const at = (await store.query('publish_log', [eq('post', n.id)], { order: 'at', limit: 1 }))[0]?.at ?? p.updated_at;
    return item(`Không chắc bài ${L}${at ? ` lúc ${hm(at)}` : ''} đã lên chưa`, [title, `Để tránh đăng hai lần, Soot không tự đăng lại. Xem trang ${L}${ch.account ? ` của ${ch.account}` : ''} rồi chọn; đã lên thì gửi kèm liên kết bài.`], ANSWERS.uncertain);
  }
  return item(`Bài lỡ giờ: ${L} · ${dayHm(n.scheduled_at)}`, [title, `Quá ${settings.stale_after_h} giờ so với giờ hẹn. Soot không tự đăng bài lỡ giờ.`], ANSWERS.late);
}

/** The Publisher filed these Cần bạn items (`due.needs[].key`). */
export async function raised(input, { store, now }) {
  const keys = Array.isArray(input.keys) ? input.keys : [];
  if (!keys.length || keys.length > 50 || keys.some(k => typeof k !== 'string' || !/^(channel|uncertain|late|reply):[A-Za-z0-9-]{1,64}:[a-z_]{1,32}$/.test(k))) fail('invalid_request', 'keys are 1–50 due.needs keys.');
  let n = 0;
  for (const key of keys) {
    const [kind, ref, reason] = key.split(':');
    try { await store.insert('attention', { key, kind, ref, reason, raised_at: iso(now) }); n++; } catch (e) { if (e.code !== 'conflict') throw e; }
  }
  return { raised: n };
}

// ---------- claim → publish → record / fail ----------

function claimBody(p, ch, action, intent, now, assets = []) {
  const b = p.brief ?? {};
  return {
    intent_id: intent, post: p.ref, channel: ch.key, publisher: ch.publisher, action, content_hash: p.content_hash,
    title: b.title ?? '', meta: b.meta ?? '', slug: b.slug ?? '', body: p.body ?? '', link: p.link ?? '',
    series: b.series ?? ch.rules?.series ?? null, date: new Date(now).toISOString().slice(0, 10),
    url: action === 'unpublish' ? p.url ?? null : null, expires_at: iso(now + CLAIM_TTL_MS),
    // Browser publishers: which platform and account to drive, and for a reply its target.
    // `profile` is the named browser profile whose sign-in this account lives in (null: the Soot's own profile).
    ...(ch.publisher === 'browser' ? { platform: ch.platform ?? platformOf(ch.key), account: ch.account ?? null, profile: profileOf(ch), subreddit: b.subreddit ?? null } : {}),
    ...(action === 'reply' ? { reply_url: b.reply_url ?? null, thread_url: b.thread_url ?? null } : {}),
    // A video post: the file the browser uploads, with the hash it must still have.
    ...(p.kind === 'video' ? { kind: 'video', ...(action === 'publish' ? { assets: claimAssets(assets) } : {}) } : {}),
  };
}

async function refuse(store, p, code, reason, { refusePost = false, state = 'refused' } = {}) {
  if (refusePost) {
    await store.update('posts', [eq('ref', p.ref)], { state, reason });
    await store.remove('queue', [eq('post', p.ref), isNull('intent_id')]);
  } else {
    await store.update('queue', [eq('post', p.ref)], { wait_reason: reason });
  }
  return { refused: { code, reason } };
}

async function claimOnce(input, { store, now, env }) {
  const action = input.action ?? 'publish';
  if (!['publish', 'unpublish', 'reply'].includes(action)) fail('invalid_request', 'action is publish, unpublish or reply.');
  const key = env.MARKETING_CLAIM_KEY;
  if (!key) return { refused: { code: 'claim_key_missing', reason: 'Soot chưa có khoá MARKETING_CLAIM_KEY.' } };
  const p = await post(store, input.id);
  const q = await store.one('queue', [eq('post', p.ref)]);
  if (!q || (q.action ?? 'publish') !== action) return { refused: { code: 'not_queued', reason: action === 'unpublish' ? 'Bài không chờ gỡ.' : 'Bài không có trong hàng đợi.' } };
  if (action !== 'unpublish' && (action === 'reply') !== (p.kind === 'reply')) return { refused: { code: 'invalid_action', reason: 'Trả lời dùng action reply; bài đăng dùng publish.' } };
  const ch = await channel(store, p.channel);
  const settings = await getSettings(store);
  const send = action !== 'unpublish';

  // An open intent: the last attempt may have gone out. Re-issue the same
  // intent and make the publisher look before it acts (crash recovery).
  if (q.intent_id) {
    if (now - ms(q.intent_at) <= INTENT_STALE_MS) return { refused: { code: 'open_intent', reason: 'Bài đang được đăng ở lượt khác.' } };
    if (send && (settings.paused_all || ch.paused)) return refuse(store, p, 'paused', 'Đang tạm dừng đăng.');
    // From here the publisher only looks; a failure keeps the intent (never a second post).
    await store.update('queue', [eq('post', p.ref), eq('intent_id', q.intent_id)], { intent_at: iso(now), verify: true });
    if (!(await store.one('publish_log', [eq('intent_id', q.intent_id)]))) {
      await store.insert('publish_log', { post: p.ref, channel: ch.key, action, intent_id: q.intent_id, status: 'intent', body: p.body, link: p.link ?? null, url: p.url ?? null, platform_id: null, reason: null, at: iso(q.intent_at ?? now) });
    }
    const media = action === 'publish' ? await postAssets(store, p) : [];
    return { claim: signClaim(claimBody(p, ch, action, q.intent_id, now, media), key), verify_first: true };
  }

  if (send) {
    if (!['scheduled', 'failed'].includes(p.state)) return { refused: { code: 'not_ready', reason: `Bài đang ${STATE_LABEL[p.state]}.` } };
    if (ms(q.scheduled_at) > now) return { refused: { code: 'not_due', reason: 'Chưa tới giờ đăng.' } };
    if (now - ms(q.scheduled_at) >= settings.stale_after_h * HOUR) return refuse(store, p, 'late', `Bài lỡ giờ: quá ${settings.stale_after_h} giờ so với lịch; Soot không tự đăng bài lỡ giờ.`);
    if (p.kind === 'reply') {
      try { await answerable(store, p.parent, ch, p.body, p.ref); } catch (e) { return refuse(store, p, e.code, e.message, { refusePost: true }); }
    }
    if (p.content_hash !== hashOf(p)) return refuse(store, p, 'hash_mismatch', 'Nội dung đổi sau khi kiểm tra.', { refusePost: true });
    const gi = await guardInputs(store, p, now);
    const failed = autoChecks(p, gi).filter(a => !a.ok);
    if (failed.length) return refuse(store, p, failed[0].code, failed.map(a => a.detail).join(' · '), { refusePost: true, state: failed.every(a => a.rule === 'video') ? 'draft' : 'refused' });
    const last = await latestCheck(store, p);
    if (!last || last.verdict !== 'pass' || last.content_hash !== p.content_hash) return refuse(store, p, 'not_checked', 'Editor chưa duyệt đúng bản này.', { refusePost: true });
    const wait = claimWindow({ settings, channel: ch, log: gi.log.filter(r => r.channel === ch.key), now, action });
    if (wait) return refuse(store, p, wait.code, wait.reason);
  } else if (p.state !== 'published' && p.state !== 'unpublishing') {
    return { refused: { code: 'not_published', reason: 'Bài chưa đăng.' } };
  }

  // Compare-and-set: only one caller turns the open slot into an intent.
  const intent = intentID();
  const won = await store.update('queue', [eq('post', p.ref), isNull('intent_id')], { intent_id: intent, intent_at: iso(now), attempts: (q.attempts ?? 0) + 1, wait_reason: null, verify: false });
  if (!won) return { refused: { code: 'open_intent', reason: 'Bài đang được đăng ở lượt khác.' } };
  // The intent row is written before anything goes out.
  await store.insert('publish_log', { post: p.ref, channel: ch.key, action, intent_id: intent, status: 'intent', body: p.body, link: p.link ?? null, url: p.url ?? null, platform_id: null, reason: null, at: iso(now) });
  await store.update('posts', [eq('ref', p.ref)], { state: send ? 'publishing' : 'unpublishing', reason: null });
  const media = action === 'publish' ? await postAssets(store, p) : [];
  return { claim: signClaim(claimBody(p, ch, action, intent, now, media), key) };
}

/** A refusal is a normal answer: `done: true` ends a tool chain quietly (the reason is already on the post). */
export async function claim(input, deps) {
  const out = await claimOnce(input, deps);
  return out.refused ? { ...out, done: true } : out;
}

async function intentRow(store, intent_id) {
  if (typeof intent_id !== 'string' || !intent_id) fail('invalid_request', 'intent_id is required.');
  const row = await store.one('publish_log', [eq('intent_id', intent_id)]);
  if (!row) fail('not_found', 'Không có lượt đăng này.');
  return row;
}

export async function record(input, { store, now }) {
  const row = await intentRow(store, input.intent_id);
  const done = row.action === 'unpublish' ? 'removed' : 'published';
  // Only a post is the post_published outcome; a reply is not.
  const outcome = url => (row.action === 'publish' ? { outcome: { id: 'post_published', ref: url } } : {});
  if (row.status === done) return { state: done, ...(done === 'published' ? outcome(row.url) : {}), replayed: true };
  if (done === 'published' && (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url))) fail('invalid_request', 'url is required.');
  const url = done === 'published' ? input.url : row.url;
  await store.update('publish_log', [eq('intent_id', row.intent_id)], { status: done, url, platform_id: input.platform_id ?? null, at: iso(now) });
  await store.update('posts', [eq('ref', row.post)], done === 'published' ? { state: 'published', url, platform_id: input.platform_id ?? null, reason: null } : { state: 'removed', reason: null });
  await store.remove('queue', [eq('post', row.post), eq('intent_id', row.intent_id)]);
  await clearAttention(store, 'uncertain', row.post);
  if (row.action === 'reply') {
    const p = await store.one('posts', [eq('ref', row.post)]);
    if (p?.parent) await store.update('replies', [eq('ref', p.parent)], { state: 'answered', reply_post: p.ref });
  }
  return { state: done, ...(done === 'published' ? outcome(url) : {}) };
}

export async function failIntent(input, { store, now, env, fetch: fetchImpl }) {
  const row = await intentRow(store, input.intent_id);
  const status = input.status;
  if (!['failed', 'needs_person', 'uncertain'].includes(status)) fail('invalid_request', 'status is failed, needs_person or uncertain.');
  const reason = String(input.reason ?? '').slice(0, 500) || 'Không rõ lý do.';
  // A pause names what the person must do; an unknown reason would ask for the wrong thing.
  const code = status === 'needs_person' ? PAUSE_REASONS.find(c => reason.startsWith(c)) : null;
  if (status === 'needs_person' && !code) fail('invalid_request', `needs_person reason starts with ${PAUSE_REASONS.join(', ')}; anything else is failed or uncertain.`);
  if (row.status !== 'intent') return { state: (await post(store, row.post)).state, replayed: true };
  const unpub = row.action === 'unpublish';
  const q = await store.one('queue', [eq('post', row.post), eq('intent_id', row.intent_id)]);
  let report = null;
  if (status === 'needs_person') {
    // Only that channel pauses; the reason is the platform code Cần bạn names.
    const ch = await store.one('channels', [eq('key', row.channel)]);
    // A sign-out keeps when it began (rules.signed_out_at), so only a sign-in after it resumes the channel (due).
    const episode = code === 'signed_out' && ch && !(ch.paused && ch.paused_reason === 'signed_out' && validAt(ch.rules?.signed_out_at));
    await store.update('channels', [eq('key', row.channel)], { paused: true, paused_reason: code, ...(episode ? { rules: { ...(ch.rules ?? {}), signed_out_at: iso(now) } } : {}) });
    // The profile's site is the one state of "signed in": say it is signed out there (best effort; the answer records it).
    const profile = profileOf(ch), host = PLATFORM_HOST[ch?.platform ?? platformOf(row.channel)];
    if (code === 'signed_out' && profile && host) report = { profile, host, ...(await reportSignedOut(env, fetchImpl, profile, host)) };
  }
  const reported = report ? { profile_report: report } : {};
  // An earlier attempt may have gone out (verify_first) and the publisher could
  // not look: keep the intent and ask a person, never free it for a second post.
  if (status === 'uncertain' || (q?.verify && !unpub)) {
    await store.update('posts', [eq('ref', row.post)], { state: 'uncertain', reason });
    await store.update('publish_log', [eq('intent_id', row.intent_id)], { status: 'intent', reason });
    return { state: 'uncertain', ...reported };
  }
  await store.update('publish_log', [eq('intent_id', row.intent_id)], { status, reason, at: iso(now) });
  // A retry the guard would refuse (quiet hours) is promised for when it can go, not for an hour from now.
  const quiet = (await getSettings(store)).quiet_hours ?? DEFAULT_QUIET;
  const retry = status === 'failed' ? nextSlot({ from: now + HOUR, cap: 1e6, quiet }) ?? now + HOUR : now;
  await store.update('queue', [eq('post', row.post), eq('intent_id', row.intent_id)], { intent_id: null, intent_at: null, verify: false, scheduled_at: iso(retry), wait_reason: reason });
  const state = unpub ? 'published' : 'failed';
  await store.update('posts', [eq('ref', row.post)], { state, reason });
  return { state, ...reported };
}

export async function pause(input, { store, now }) {
  if (typeof input.paused !== 'boolean') fail('invalid_request', 'paused is true or false.');
  if (input.signed_in !== undefined && (input.signed_in !== true || !input.channel || input.paused !== true)) fail('invalid_request', 'signed_in is true, with channel and paused: true.');
  if (input.channel) {
    const ch = await channel(store, input.channel);
    if (ch.paused_reason === 'retired') fail('conflict', `Kênh ${ch.key} đã ngừng: TikTok đăng theo từng tài khoản (tiktok-<tài khoản>).`);
    // The Soot saw the person's session: the sign-in item ends and the channel stays paused until the person's Bật.
    if (input.signed_in && !(ch.paused && ch.paused_reason === 'signed_out')) fail('conflict', `Kênh ${ch.key} không chờ đăng nhập.`);
    await store.update('channels', [eq('key', input.channel)], { paused: input.paused, paused_reason: input.paused ? (input.signed_in ? 'signed_in' : 'person') : null });
    if (input.signed_in) await clearAttention(store, 'channel', input.channel);
    if (!input.paused) await store.remove('attention', [eq('kind', 'woke-item'), eq('reason', input.channel)]);
    // Resuming ends that episode: a later sign-out is a new Cần bạn item.
    if (!input.paused) await clearAttention(store, 'channel', input.channel);
  } else {
    await setSetting(store, 'paused_all', input.paused);
    await setSetting(store, 'paused_at', input.paused ? iso(now) : null);
    if (!input.paused) { await store.remove('attention', [eq('kind', 'woke-item')]); await setPause(store, { scope: 'all' }, false, now); }
  }
  const settings = await getSettings(store);
  const channels = await store.query('channels', [], { limit: 50 });
  return { paused_all: settings.paused_all, channels: channels.map(c => ({ id: c.key, paused: !!c.paused })) };
}

// ---------- reads ----------

const itemOf = (p, q) => ({ id: p.ref, kind: p.kind, channel: p.channel, campaign: p.campaign, state: p.state, label: STATE_LABEL[p.state], title: p.brief?.title ?? p.title ?? String(p.body).slice(0, 80), reason: p.reason, url: p.url, revision: p.revision, scheduled_at: q?.scheduled_at ?? null, updated_at: p.updated_at });

export async function items(input, { store }) {
  const where = [];
  if (input.state) where.push(eq('state', input.state));
  if (input.channel) where.push(eq('channel', input.channel));
  if (input.campaign) where.push(eq('campaign', input.campaign));
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  const rows = input.query ? await store.search('posts', input.query, where, limit) : await store.query('posts', where, { order: 'updated_at', limit });
  // The queue holds the time a scheduled item goes out: items carries it, as the page does.
  const queued = rows.length ? await store.query('queue', [], { limit: 500 }) : [];
  const at = Object.fromEntries(queued.map(q => [q.post, q]));
  return { items: rows.map(p => itemOf(p, at[p.ref])) };
}

// ---------- facts ----------

export function flatten(value, prefix = '', out = []) {
  if (out.length >= 300) return out;
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else if (Array.isArray(value) && value.every(v => v && typeof v === 'object')) value.slice(0, 20).forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else out.push([prefix || 'value', value]);
  return out;
}

export async function facts_sync(input, { store, now, fetch }) {
  // The source is remembered from the first call (the recipe's schedule), so a Soot never guesses it.
  const known = (await store.one('settings', [eq('key', 'facts_url')]))?.value ?? (await store.one('settings', [eq('key', 'plan')]))?.value?.facts_url;
  const url = input.url ?? known;
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) fail('invalid_request', 'Chưa có địa chỉ nguồn giá. Bỏ qua việc đọc giá: viết bài không nêu giá, phần trăm hay ưu đãi.');
  if (input.url && input.url !== known) await setSetting(store, 'facts_url', input.url);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) fail('source_failed', `${url} answered ${res.status}`);
  const leaves = flatten(await res.json());
  let n = 0;
  for (const [key, value] of leaves) {
    const row = { value, source_url: url, fetched_at: iso(now) };
    if (!(await store.update('facts', [eq('key', key)], row))) await store.insert('facts', { key, ...row });
    n++;
  }
  return { facts: n, fetched_at: iso(now) };
}

// ---------- Search Console (design §6) ----------

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3';

async function googleToken(cred, fetch) {
  let c;
  try { c = JSON.parse(cred); } catch { return { error: 'signed_out' }; }
  if (c?.type !== 'google_oauth' || !c.refresh_token || !c.client_id) return { error: 'signed_out' };
  const res = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret ?? '' }).toString() });
  const out = await res.json().catch(() => ({}));
  if (res.status === 400 || res.status === 401) return { error: out.error === 'invalid_grant' ? 'revoked' : 'signed_out' };
  if (!res.ok || !out.access_token) fail('google_failed', `Google token endpoint answered ${res.status}`);
  return { token: out.access_token };
}

async function gscQuery(site, token, body, fetch) {
  const res = await fetch(`${GSC_API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) return { error: res.status === 403 ? 'no_access' : 'revoked' };
  if (!res.ok) fail('gsc_failed', `Search Console answered ${res.status}`);
  return { rows: (await res.json()).rows ?? [] };
}

const GSC_NOT_CONNECTED = 'Chưa đăng nhập Google cho Search Console nên chưa có dòng nào (0 dòng). Đăng nhập Google bằng tài khoản là chủ sở hữu thuộc tính Search Console của blog: nest://settings/setup?key=GSC_GOOGLE';
const GSC_WHY = {
  no_published_posts: 'Chưa có bài đã đăng nên chưa có gì để đọc từ Search Console.',
  search_console_listed_nothing: 'Search Console chưa liệt kê trang nào trong các ngày vừa rồi: bài còn mới (Google cần vài ngày để lập chỉ mục) hoặc thuộc tính chưa nhận blog.',
  no_page_matches_a_post: 'Search Console có trang nhưng không trang nào khớp bài đã đăng: kiểm tra địa chỉ bài với thuộc tính đã chọn.',
};
/** host + path with no trailing slash, query or fragment; a url that does not parse is compared as written. */
export function canonUrl(u) {
  try { const x = new URL(String(u)); return `${x.hostname.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`; } catch { return String(u ?? ''); }
}

/** The Search Console domain property of a product's site (`lohi2.com`, `https://www.x.vn/` → `sc-domain:x.vn`); null when it has none. */
export function gscProperty(site) {
  if (typeof site !== 'string' || !site.trim()) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? `sc-domain:${host}` : null;
  } catch { return null; }
}
const GSC_NO_LIBRARY = 'Chưa đọc được thư viện sản phẩm (products.json) nên chưa biết đọc Search Console của trang nào. Kiểm tra thư mục thư viện của Marketing.';
const GSC_NO_SITE = 'Chưa sản phẩm nào có trang web trong products.json nên chưa biết đọc Search Console của trang nào.';

/** Whether a page url belongs to a Search Console property (a domain property or a url prefix). */
function inGscSite(url, site) {
  try {
    if (site.startsWith('sc-domain:')) { const d = site.slice(10).toLowerCase(), h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); return h === d || h.endsWith(`.${d}`); }
    return url.startsWith(site);
  } catch { return false; }
}

export async function gsc_sync(input, { store, now, env, fetch }) {
  if (input.site !== undefined && (typeof input.site !== 'string' || !input.site)) fail('invalid_request', 'site is the Search Console property, e.g. sc-domain:example.com; leave it out to read every product\'s site.');
  const days = Math.min(Math.max(Number(input.days) || 3, 1), 28);
  const needsPerson = async reason => {
    // The page's note is best effort; the sign-in signal below must go out even if storage is down.
    await setSetting(store, 'gsc', { state: 'needs_person', reason, at: iso(now) }).catch(() => {});
    // `needs_person` is the host's sign-in signal (2agent operations/sign_in.go): with exit 1 the
    // host marks GSC_GOOGLE and Cần bạn shows one "Đăng nhập Google lại" item, with no model call.
    return { status: 'needs_person', reason, message: reason === 'revoked' ? 'Quyền đọc Search Console đã bị thu hồi: cần đăng nhập Google lại.' : 'Cần đăng nhập Google cho Search Console.',
      needs_person: { credential: 'GSC_GOOGLE', reason: `oauth_${reason}` } };
  };
  // Never signed in to Google: Search Console is optional, so this is a quiet skip, not a sign-in item.
  if (!env.GSC_GOOGLE) {
    if ((await getSettings(store)).gsc?.state !== 'ok') {
      // The host cannot raise a card for a credential that was never stored, so the reason is kept where the daily report and the
      // loop-health page read it: Search Console shows 0 rows because nobody signed Google in, not because the sync is broken.
      await setSetting(store, 'gsc', { state: 'not_connected', message: GSC_NOT_CONNECTED, at: iso(now) }).catch(() => {});
      return { ...skippedFor('GSC_GOOGLE'), message: GSC_NOT_CONNECTED };
    }
    return needsPerson('signed_out');
  }
  // No site named (the daily schedule): every product's own site from products.json, one domain property each.
  let sites = input.site ? [input.site] : [];
  if (!sites.length) {
    const lr = await libraryRoot(env);
    let products = [], unreadable = !lr.ok;
    if (lr.ok) products = await loadProducts({ root: lr.root }).catch(() => { unreadable = true; return []; });
    // A library that cannot be read is not "no product has a site": the reason shown stays the true one.
    if (unreadable) {
      await setSetting(store, 'gsc', { state: 'no_library', message: GSC_NO_LIBRARY, at: iso(now) }).catch(() => {});
      return { ok: true, skipped: true, reason_code: 'no_library', message: GSC_NO_LIBRARY, notify: false, wake: false };
    }
    sites = [...new Set(products.map(p => gscProperty(p.site)).filter(Boolean))].slice(0, 12);
    if (!sites.length) {
      await setSetting(store, 'gsc', { state: 'no_site', message: GSC_NO_SITE, at: iso(now) }).catch(() => {});
      return { ok: true, skipped: true, reason_code: 'no_site', message: GSC_NO_SITE, notify: false, wake: false };
    }
  }
  const auth = await googleToken(env.GSC_GOOGLE, fetch);
  if (auth.error) return needsPerson(auth.error);
  const published = await store.query('posts', [eq('state', 'published')], { limit: 500 });
  // A page is matched by its canonical form (host and path, no trailing slash, query or fragment): Search Console and the
  // blog may disagree on `/slug` against `/slug/`, which used to drop every row.
  const canon = new Map(published.filter(p => p.url).map(p => [canonUrl(p.url), p.url]));
  const urls = new Set(canon.keys());
  const accessText = site => `Tài khoản Google đã đăng nhập không có quyền đọc ${site}. Thêm tài khoản đó làm chủ sở hữu hoặc người dùng của thuộc tính này trong Search Console (hoặc đăng nhập lại bằng tài khoản đã xác minh ${site}).`;
  // Every property the account cannot read is named, not only the first.
  const noAccess = async list => {
    const site = list[0], message = list.map(accessText).join(' ');
    await setSetting(store, 'gsc', { state: 'no_access', message, site, ...(list.length > 1 ? { sites: list } : {}), at: iso(now) }).catch(() => {});
    return { status: 'no_access', ok: false, site, ...(list.length > 1 ? { sites: list } : {}), message, notify: false, wake: false };
  };
  const day = d => new Date(now - d * DAY).toISOString().slice(0, 10);
  // A property the account cannot read is named and skipped; the others are still read. Only all of them denied is a no_access.
  const pages = { rows: [] };
  const queries = { rows: [] };
  const denied = [];
  for (const site of sites) {
    const p = await gscQuery(site, auth.token, { startDate: day(days), endDate: day(1), dimensions: ['page', 'date'], rowLimit: 5000 }, fetch);
    if (p.error === 'no_access') { denied.push(site); continue; }
    if (p.error) return needsPerson(p.error);
    const q = await gscQuery(site, auth.token, { startDate: day(28), endDate: day(1), dimensions: ['page', 'query'], rowLimit: 5000 }, fetch);
    if (q.error === 'no_access') { denied.push(site); continue; }
    if (q.error) return needsPerson(q.error);
    pages.rows.push(...p.rows);
    queries.rows.push(...q.rows);
  }
  if (denied.length === sites.length) return noAccess(denied);
  let stored = 0;
  let matched = 0;
  for (const r of pages.rows) {
    const [seen, d] = r.keys ?? [];
    const url = canon.get(canonUrl(seen));
    if (!url) continue;
    matched++;
    await store.remove('metrics', [eq('url', url), eq('day', d), eq('source', 'gsc'), eq('query', '')]);
    await store.insert('metrics', { url, source: 'gsc', day: d, query: '', impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, position: r.position ?? null, views: null });
    stored++;
  }
  // Query rows are a 28-day window ending yesterday, replaced on every read: only for the properties read this time,
  // so one the account cannot read keeps what it had instead of being wiped by a sync that reports ok.
  const readSites = sites.filter(s => !denied.includes(s));
  const heldQueries = { column: 'query', op: 'ne', value: '' };
  if (!denied.length) await store.remove('metrics', [eq('source', 'gsc'), heldQueries]);
  else for (const u of canon.values()) if (readSites.some(s => inGscSite(u, s))) await store.remove('metrics', [eq('source', 'gsc'), eq('url', u), heldQueries]);
  for (const r of queries.rows) {
    const [seen, query] = r.keys ?? [];
    const url = canon.get(canonUrl(seen));
    if (!url || !query) continue;
    await store.insert('metrics', { url, source: 'gsc', day: day(1), query, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, position: r.position ?? null, views: null });
    stored++;
  }
  // Say why there are no rows instead of a bare 0: nothing published yet, Google listed no page, or none of its pages is ours.
  const why = stored > 0 ? null : !urls.size ? 'no_published_posts' : !pages.rows.length ? 'search_console_listed_nothing' : 'no_page_matches_a_post';
  const message = why ? GSC_WHY[why] : null;
  const part = denied.length ? { no_access: denied, no_access_message: denied.map(accessText).join(' ') } : {};
  await setSetting(store, 'gsc', { state: 'ok', at: iso(now), listed: pages.rows.length, matched, ...(why ? { why, message } : {}), ...part });
  return { status: 'ok', rows: stored, urls: urls.size, listed: pages.rows.length, matched, ...(why ? { why, message } : {}), ...(input.site ? {} : { sites }), ...part };
}

/** Page-day totals for a url over the last `days`; null when nothing was read yet (never 0). */
export function totals(rows, url, days, now) {
  const since = new Date(now - days * DAY).toISOString().slice(0, 10);
  const mine = rows.filter(r => r.url === url && !r.query && r.day >= since);
  if (!mine.length) return null;
  const impressions = mine.reduce((s, r) => s + (r.impressions ?? 0), 0);
  const clicks = mine.reduce((s, r) => s + (r.clicks ?? 0), 0);
  const weighted = mine.reduce((s, r) => s + (r.position ?? 0) * (r.impressions ?? 0), 0);
  return { impressions, clicks, position: impressions ? Math.round((weighted / impressions) * 10) / 10 : null };
}

export async function seo_brief(_input, { store, now }) {
  const rows = await metricsRows(store, now);
  const byQuery = new Map();
  for (const r of rows.filter(r => r.query)) {
    const q = byQuery.get(r.query) ?? { query: r.query, impressions: 0, clicks: 0, w: 0, urls: new Set() };
    q.impressions += r.impressions ?? 0; q.clicks += r.clicks ?? 0; q.w += (r.position ?? 0) * (r.impressions ?? 0); q.urls.add(r.url);
    byQuery.set(r.query, q);
  }
  const queries = [...byQuery.values()].map(q => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, ctr: q.impressions ? q.clicks / q.impressions : 0, position: q.impressions ? Math.round((q.w / q.impressions) * 10) / 10 : null, urls: [...q.urls] }))
    .filter(q => q.impressions >= 20 && ((q.position >= 8 && q.position <= 20) || q.ctr < 0.01))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 25);
  const published = await store.query('posts', [eq('state', 'published')], { order: 'updated_at', limit: 50 });
  return {
    queries,
    posts: published.map(p => ({ id: p.ref, title: p.brief?.title ?? p.title, url: p.url, last_14_days: totals(rows, p.url, 14, now) })),
    read_at: (await getSettings(store)).gsc?.at ?? null,
  };
}


// ---------- channels (recipe seed, p3) ----------

const CHANNEL_FIELDS = ['cap_per_day', 'spacing_min', 'reply_cap_per_day'];

/** Create missing channels (a browser channel paused until its first sign-in) and
 * fill only unset values; a founder's edit or pause is never overwritten.
 * `from_products: true` adds one TikTok channel per account in products.json (`accounts.tiktok`): `tiktok-<handle>`,
 * account `@handle`, rules `{product, video_channel}` and the account's `profile` when it names one. */
export async function channels_setup(input, { store, env, now }) {
  await retireLegacyTiktok(store, { env, now });
  const list = Array.isArray(input.channels) ? [...input.channels] : [];
  if (input.from_products === true) {
    const lr = await libraryRoot(env ?? {});
    if (!lr.ok) fail('needs_credential', 'from_products reads products.json from the marketing folder: set MARKETING_ROOT first.');
    for (const prod of await loadProducts({ root: lr.root })) {
      for (const a of prod.tiktok_accounts ?? []) {
        const id = tiktokChannelId(a.handle);
        if (list.some(c => c?.id === id)) continue;
        list.push({ id, account: `@${a.handle}`, ...(a.profile ? { profile: a.profile } : {}), rules: { product: prod.id, ...(a.video_channel ? { video_channel: a.video_channel } : {}) } });
      }
    }
  }
  if (list.length > 20) fail('invalid_request', 'At most 20 channels.');
  const out = [];
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || !defaultsFor(c.id)) fail('unknown_channel', `Không có kênh "${c?.id}".`);
    if (c.id === LEGACY_TIKTOK) tiktokAccountRequired();
    if (c.profile !== undefined && c.profile !== null && !(typeof c.profile === 'string' && PROFILE_RE.test(c.profile))) fail('invalid_request', 'profile is a browser profile id (letters, digits, . _ -, up to 64).');
    if (c.publisher !== undefined && !['browser', 'hand'].includes(c.publisher)) fail('invalid_request', 'publisher is browser or hand.');
    const existed = !!(await store.one('channels', [eq('key', c.id)]));
    const row = await channel(store, c.id);
    const set = {};
    for (const f of CHANNEL_FIELDS) if (Number.isInteger(c[f]) && c[f] >= 0 && (!existed || row[f] == null) && row[f] !== c[f]) set[f] = c[f];
    if (typeof c.account === 'string' && c.account && !row.account) set.account = c.account.slice(0, 200);
    if ((c.rules && typeof c.rules === 'object' && !Array.isArray(c.rules)) || typeof c.profile === 'string') {
      const rules = { ...(row.rules ?? {}) };
      for (const [k, v] of Object.entries(c.rules ?? {})) if (rules[k] === undefined) rules[k] = v;
      if (typeof c.profile === 'string' && !rules.profile) rules.profile = c.profile;
      if (JSON.stringify(rules) !== JSON.stringify(row.rules ?? {})) set.rules = rules;
    }
    // A channel's publisher changes only when asked, and then it is a person's word (a later default never takes it back).
    if (c.publisher && c.publisher !== row.publisher) { set.publisher = c.publisher; set.rules = { ...(set.rules ?? row.rules ?? {}), publisher_by: 'person' }; }
    if (Object.keys(set).length) await store.update('channels', [eq('key', row.key)], set);
    out.push({ id: row.key, platform: row.platform ?? platformOf(row.key), paused: !!row.paused, paused_reason: row.paused_reason ?? null, created: !existed, profile: profileOf({ rules: set.rules ?? row.rules }), publisher: set.publisher ?? row.publisher });
  }
  const settings = await getSettings(store);
  if (input.quiet_hours && !(await store.one('settings', [eq('key', 'quiet_hours')]))) {
    const q = input.quiet_hours;
    if (!/^\d{2}:\d{2}$/.test(q.from ?? '') || !/^\d{2}:\d{2}$/.test(q.to ?? '') || typeof q.tz !== 'string') fail('invalid_request', 'quiet_hours is {from:"HH:MM", to:"HH:MM", tz}.');
    await setSetting(store, 'quiet_hours', { from: q.from, to: q.to, tz: q.tz });
  }
  if (Number.isInteger(input.stale_after_h) && !(await store.one('settings', [eq('key', 'stale_after_h')]))) await setSetting(store, 'stale_after_h', input.stale_after_h);
  // The product's name, for Cần bạn wording ("Đăng nhập X cho Lohi"); the recipe owns it.
  if (typeof input.project === 'string' && input.project.trim()) await setSetting(store, 'project', input.project.trim().slice(0, 64));
  // The Soot that writes, for the pages' "Nhờ viết bài" (nest://new?soot=…).
  if (typeof input.writer === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.writer)) await setSetting(store, 'writer', input.writer);
  return { channels: out, quiet_hours: (await getSettings(store)).quiet_hours ?? settings.quiet_hours };
}

// ---------- replies (AC6, design §5) ----------

export const REPLY_CLASSES = ['safe', 'complaint', 'money', 'account', 'flagged', 'spam'];
const replyRef = (channelKey, url) => 'R-' + createHash('sha256').update(`${channelKey}|${url}`).digest('hex').slice(0, 10).toUpperCase();
const READ_EVERY_MS = 2 * HOUR;
const HANDLE_TTL_MS = 30 * DAY;

const decode = s => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
// Atom carries the comment as escaped HTML: unescape the XML, drop the tags, then unescape the HTML text.
const strip = html => decode(decode(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Comments of a Reddit thread's Atom feed (`<thread>.rss`), newest first; the post itself (t3_) is left out. */
export function redditComments(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = decode(e.match(/<id>([\s\S]*?)<\/id>/)?.[1] ?? '').trim();
    if (!id.startsWith('t1_')) continue;
    const link = e.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const author = decode(e.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)?.[1] ?? '').trim().replace(/^\/?u\//, '');
    const text = strip(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '').replace(/^submitted by .*$/, '').slice(0, 2000);
    if (link) out.push({ reply_url: decode(link), author_handle: author || null, text, platform_id: id });
  }
  return out;
}

async function watchedThreads(store, now) {
  const [sources, posts] = await Promise.all([
    store.query('sources', [eq('kind', 'reddit_thread')], { limit: 50 }),
    store.query('posts', [eq('state', 'published')], { order: 'updated_at', limit: 200 }),
  ]);
  const threads = new Map(sources.map(s => [s.url, { url: s.url, channel: s.key.split('|')[1] ?? null, parent_post: null, source: s }]));
  for (const p of posts) {
    if (platformOf(p.channel) !== 'reddit' || !p.url || now - ms(p.updated_at) > 30 * DAY) continue;
    if (!threads.has(p.url)) threads.set(p.url, { url: p.url, channel: p.channel, parent_post: p.ref, source: null });
    else threads.get(p.url).parent_post = p.ref;
  }
  return [...threads.values()];
}

/** Tool-only schedule (every 2 h): read Reddit threads by RSS, drop reader
 * handles after 30 days, and wake the Publisher only for replies to classify
 * or browser channels whose notifications were last read over 2 h ago. */
export async function replies_sync(_input, { store, now, fetch }) {
  // Person-derived data never outlives 30 days.
  const old = await store.query('replies', [{ column: 'created_at', op: 'lte', value: iso(now - HANDLE_TTL_MS) }, { column: 'author_handle', op: 'not_null' }], { limit: 500 });
  for (const r of old) await store.update('replies', [eq('ref', r.ref)], { author_handle: null });
  const channels = await store.query('channels', [], { limit: 50 });
  const redditKey = channels.find(c => platformOf(c.key) === 'reddit')?.key ?? null;
  let saved = 0;
  const errors = [];
  for (const t of await watchedThreads(store, now)) {
    const ch = channels.find(c => c.key === (t.channel ?? redditKey));
    // Without the channel's account our own comments look like readers'; read nothing.
    if (!ch || !ch.account) continue;
    let xml;
    try {
      const res = await fetch(t.url.replace(/\/?(\?.*)?$/, '/.rss'), { headers: { Accept: 'application/atom+xml', 'User-Agent': 'soot-marketing/1.0' } });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      xml = await res.text();
    } catch (e) {
      errors.push({ thread_url: t.url, error: String(e.message).slice(0, 200) });
      if (t.source) await store.update('sources', [eq('key', t.source.key)], { last_error: String(e.message).slice(0, 200) });
      continue;
    }
    const own = String(ch.account ?? '').replace(/^.*\/(u|user)\//, '').replace(/\/.*$/, '').toLowerCase();
    for (const c of redditComments(xml)) {
      if (c.author_handle?.toLowerCase() === own) continue;
      const ref = replyRef(ch.key, c.reply_url);
      if (await store.one('replies', [eq('ref', ref)])) continue;
      await store.insert('replies', { ref, channel: ch.key, thread_url: t.url, reply_url: c.reply_url, parent_post: t.parent_post, author_handle: c.author_handle, text: c.text, class: null, state: 'new', reply_post: null });
      saved++;
    }
    if (t.source) await store.update('sources', [eq('key', t.source.key)], { last_read_at: iso(now), last_error: null });
  }
  // X and Facebook are read in the browser by the woken Publisher.
  const reads = await store.query('sources', [eq('kind', 'notifications')], { limit: 50 });
  const lastRead = Object.fromEntries(reads.map(r => [r.key, ms(r.last_read_at)]));
  const published = await store.query('posts', [eq('state', 'published')], { order: 'updated_at', limit: 200 });
  const read = channels.filter(c => ['x', 'facebook'].includes(platformOf(c.key)) && !c.paused && published.some(p => p.channel === c.key)
    && !(now - (lastRead[`notifications|${c.key}`] ?? 0) < READ_EVERY_MS)).map(c => c.key);
  const classify = (await store.query('replies', [eq('state', 'new')], { limit: 50 })).map(r => ({ id: r.ref, channel: r.channel, thread_url: r.thread_url, reply_url: r.reply_url, text: r.text }));
  const wake = read.length > 0 || classify.length > 0;
  return { wake, notify: wake, read, classify, saved, purged: old.length, errors };
}

/** Save what the Publisher read and classified. `safe` replies are answered
 * through draft_save {kind:"reply", parent} → check → schedule → claim; the
 * others are never answered and become one Cần bạn item each (due.needs).
 * An `account` reply also gets the channel's fixed pointer as a draft. */
export async function reply_save(input, { store, now, soot }) {
  const ch = await channel(store, input.channel);
  if (ch.kind !== 'social') fail('invalid_request', 'Replies are read on social channels.');
  const list = Array.isArray(input.items) ? input.items : [];
  if (list.length > 50) fail('invalid_request', 'At most 50 replies per call.');
  const saved = [], drafts = [];
  for (const it of list) {
    if (!REPLY_CLASSES.includes(it?.class)) fail('invalid_request', `class is ${REPLY_CLASSES.join(', ')}.`);
    let row = it.id ? await store.one('replies', [eq('ref', it.id)]) : null;
    if (it.id && (!row || row.channel !== ch.key)) fail('not_found', `Không có phản hồi ${it.id} trên kênh này.`);
    if (!row) {
      if (typeof it.reply_url !== 'string' || !/^https:\/\//.test(it.reply_url)) fail('invalid_request', 'A new reply needs its https reply_url.');
      const ref = replyRef(ch.key, it.reply_url);
      row = await store.one('replies', [eq('ref', ref)]);
      if (!row) {
        row = { ref, channel: ch.key, thread_url: typeof it.thread_url === 'string' ? it.thread_url.slice(0, 2000) : null, reply_url: it.reply_url.slice(0, 2000), parent_post: typeof it.parent_post === 'string' ? it.parent_post : null,
          author_handle: typeof it.author_handle === 'string' ? it.author_handle.replace(/^@/, '').slice(0, 64) : null, text: String(it.text ?? '').slice(0, 2000), class: null, state: 'new', reply_post: null };
        await store.insert('replies', row);
      }
    }
    // A reply already handled keeps its outcome; a replay changes nothing.
    if (row.state !== 'new') { saved.push({ id: row.ref, class: row.class, state: row.state, replayed: true }); continue; }
    const state = it.class === 'safe' ? 'open' : it.class === 'spam' ? 'ignored' : 'needs_person';
    await store.update('replies', [eq('ref', row.ref)], { class: it.class, state });
    saved.push({ id: row.ref, class: it.class, state, ...(state === 'needs_person' ? { label: (it.class === 'account' && ch.rules?.support_label) || NEED_LABEL[it.class] } : {}) });
    if (it.class === 'account' && ch.rules?.support_reply) {
      const d = await draft_save({ request_id: `pointer-${row.ref}`, kind: 'reply', channel: ch.key, parent: row.ref, body: ch.rules.support_reply }, { store, now, soot });
      drafts.push({ reply: row.ref, post: d.id, revision: d.revision });
    }
  }
  if (['x', 'facebook'].includes(platformOf(ch.key))) {
    const key = `notifications|${ch.key}`;
    if (!(await store.update('sources', [eq('key', key)], { last_read_at: iso(now) }))) await store.insert('sources', { key, kind: 'notifications', url: null, last_read_at: iso(now), last_error: null });
  }
  return { saved, drafts };
}
