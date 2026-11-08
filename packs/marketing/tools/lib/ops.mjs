// Hubless marketing tools (design §3.2). Each op is `(input, deps)` with
// deps = {store, now, env, fetch, soot}; the entry wires the real ones.
// The hub-mode tools in pack.json are untouched and still forward when
// MARKETING_HUB is bound; nothing here reads it.
import { randomBytes, createHash } from 'node:crypto';
import { fail, eq, gte, isNull } from './store.mjs';
import { autoChecks, briefLint, claimWindow, defaultsFor, platformOf } from './guard.mjs';
import { nextSlot, DEFAULT_QUIET } from './time.mjs';
import { contentHash, signClaim, CLAIM_TTL_MS, INTENT_STALE_MS } from './claim.mjs';
import { metricsRows } from './page.mjs';
import { claimAssets } from './video.mjs';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const ms = s => Date.parse(s ?? '');
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
  return { paused_all: s.paused_all === true, quiet_hours: s.quiet_hours ?? DEFAULT_QUIET, stale_after_h: s.stale_after_h ?? 6, paused_at: s.paused_at ?? null, gsc: s.gsc ?? null, product: s.product ?? null, writer: s.writer ?? null, video_pretest_bar: Number.isFinite(s.video_pretest_bar) ? s.video_pretest_bar : null };
}

export async function setSetting(store, key, value) {
  if (await store.update('settings', [eq('key', key)], { value })) return;
  try { await store.insert('settings', { key, value }); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('settings', [eq('key', key)], { value }); }
}

export async function channel(store, key) {
  const row = await store.one('channels', [eq('key', key)]);
  if (row) return row;
  const d = defaultsFor(key);
  if (!d) fail('unknown_channel', `Không có kênh "${key}".`);
  // Social channels start paused until their first sign-in (p3).
  const fresh = { key, ...d, platform: platformOf(key) ?? d.kind, paused: d.kind === 'social', paused_reason: d.kind === 'social' ? 'signed_out' : null, account: null };
  try { await store.insert('channels', fresh); } catch (e) { if (e.code !== 'conflict') throw e; }
  return (await store.one('channels', [eq('key', key)])) ?? fresh;
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
  const { request_id, id, expected_revision, kind, channel: chKey, campaign, parent, brief, body, link, asset_ids } = input;
  if (!['article', 'social', 'video', 'reply'].includes(kind)) fail('invalid_request', 'kind is article, social, video or reply.');
  if (typeof body !== 'string' || !body.trim()) fail('invalid_request', 'body is required.');
  const ch = await channel(store, chKey);
  if (!id && request_id) {
    const seen = await store.one('posts', [eq('request_id', request_id)]);
    if (seen) return { id: seen.ref, revision: seen.revision, content_hash: seen.content_hash, state: seen.state, lint: briefLint(seen, ch), replayed: true };
  }
  // A reply answers one saved reader reply; its target comes from that row, never from the model.
  const target = kind === 'reply' ? await answerable(store, parent, ch, body, id) : null;
  const fields = { kind, channel: ch.key, campaign: campaign ?? null, parent: parent ?? null, brief: target ?? brief ?? null, title: brief?.title ?? null, body, link: link ?? null, asset_ids: asset_ids ?? null };
  const lint = briefLint(fields, ch);
  if (!id) {
    const row = { ...fields, ref: ref(), request_id: request_id ?? null, content_hash: hashOf(fields), state: 'draft', reason: null, revision: 1, author_soot: soot ?? null };
    await store.insert('posts', row);
    return { id: row.ref, revision: 1, content_hash: row.content_hash, state: 'draft', lint };
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
  const n = await store.update('posts', [eq('ref', id), eq('revision', cur.revision)], { ...fields, content_hash: hashOf(fields), state: 'draft', reason: cur.kind === 'video' && cur.brief?.hold ? cur.reason : null, revision });
  if (!n) fail('revision_conflict', 'Bài vừa được sửa ở nơi khác.');
  await store.remove('queue', [eq('post', id), isNull('intent_id')]);
  return { id, revision, content_hash: hashOf(fields), state: 'draft', lint };
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

export async function check(input, { store, now, soot }) {
  const p = await post(store, input.id);
  if (input.revision !== p.revision) fail('revision_conflict', `Bài đang ở bản ${p.revision}.`);
  if (!['draft', 'checking', 'refused', 'ready'].includes(p.state)) fail('conflict', `Bài đang ${STATE_LABEL[p.state]}; không kiểm tra lại được.`);
  if (!['pass', 'fail'].includes(input.verdict)) fail('invalid_request', 'verdict is pass or fail.');
  const auto = autoChecks(p, await guardInputs(store, p, now));
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

async function takenTimes(store, chKey, now, own, action = 'publish') {
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

// Cần bạn items (design §5): the dispatcher lists them, the woken Publisher
// files one report_blocker each and marks it with `raised`, so a schedule
// wakes once per item, not every 10 minutes.
export const NEED_LABEL = {
  signed_out: 'Đăng nhập lại', layout_changed: 'Giao diện nền tảng đổi', captcha: 'Nền tảng hỏi captcha',
  late: 'Bài lỡ giờ', uncertain: 'Không chắc đã đăng chưa',
  complaint: 'Phàn nàn', money: 'Tiền', account: 'Chuyển Hỗ trợ', flagged: 'Cần xem',
};
export const PAUSE_REASONS = ['signed_out', 'layout_changed', 'captcha'];
/** Where the person signs in, in the Soot's own browser (Nest opens it with nest://browser/<soot>). */
export const LOGIN_URL = { x: 'https://x.com/i/flow/login', facebook: 'https://www.facebook.com/login', reddit: 'https://www.reddit.com/login' };
const PLATFORM_LABEL = { x: 'X', facebook: 'Facebook', reddit: 'Reddit' };
export const SIGN_IN_STEPS = 'Bấm Mở trình duyệt → đăng nhập trong khung bên phải → bấm Đã đăng nhập';
const needKey = n => `${n.kind}:${n.id}:${n.reason}`;

export async function clearAttention(store, kind, ref) {
  await store.remove('attention', [eq('kind', kind), eq('ref', ref)]);
}

export async function due(input, { store, now, soot }) {
  const settings = await getSettings(store);
  const rows = await store.query('queue', [{ column: 'scheduled_at', op: 'lte', value: iso(now) }], { order: 'scheduled_at', desc: false, limit: 200 });
  const [channels, raised, held, open] = await Promise.all([
    store.query('channels', [], { limit: 50 }),
    store.query('attention', [], { limit: 500 }),
    store.query('posts', [eq('state', 'uncertain')], { limit: 50 }),
    store.query('replies', [eq('state', 'needs_person')], { limit: 50 }),
  ]);
  const byKey = Object.fromEntries(channels.map(c => [c.key, c]));
  const seen = new Set(raised.map(r => r.key));
  const out = { wake: false, publish: [], unpublish: [], reply: [], late: [], needs_person: [], needs: [] };
  const need = n => out.needs.push({ ...n, key: needKey(n), label: n.label ?? NEED_LABEL[n.reason] ?? n.reason, raised: seen.has(needKey(n)) });
  for (const c of channels) {
    if (!c.paused || !c.paused_reason || c.paused_reason === 'person' || c.paused_reason === 'signed_in') continue;
    out.needs_person.push({ id: c.key, channel: c.key, reason: c.paused_reason });
    const platform = c.platform ?? platformOf(c.key);
    // A sign-in names the page to open in the Soot's browser and the Nest link to that browser.
    const label = PLATFORM_LABEL[platform] ?? platform;
    const signIn = c.paused_reason === 'signed_out' && LOGIN_URL[platform]
      ? { login_url: LOGIN_URL[platform], title: `Đăng nhập ${label}`, steps: SIGN_IN_STEPS, ...(soot ? { browser: `nest://browser/${soot}` } : {}) } : {};
    need({ kind: 'channel', id: c.key, channel: c.key, platform, platform_label: label, reason: c.paused_reason, account: c.account ?? null, ...signIn });
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
    if (q.action === 'unpublish') { out.unpublish.push(q.post); continue; }
    // A paused channel is one Cần bạn item, not one per held post (claim still refuses a stale one).
    if (!q.intent_id && (settings.paused_all || ch?.paused)) continue;
    // A stale item is never posted on its own (a stuck intent is only verified, never re-posted).
    if (!q.intent_id && now - ms(q.scheduled_at) >= settings.stale_after_h * HOUR) {
      out.late.push(q.post);
      need({ kind: 'late', id: q.post, channel: q.channel, reason: 'late', scheduled_at: q.scheduled_at });
      continue;
    }
    if (settings.paused_all || ch?.paused) continue;
    (q.action === 'reply' ? out.reply : out.publish).push(q.post);
  }
  // Every platform still signed out, as one ready Cần bạn item (report_blocker takes it as is).
  const order = Object.keys(LOGIN_URL);
  const signIns = out.needs.filter(n => n.login_url).sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
  if (signIns.length) {
    const labels = signIns.map(n => n.platform_label);
    out.sign_in = {
      summary: `Đăng nhập ${labels.join(', ')}${settings.product ? ` cho ${settings.product}` : ''}`,
      missing: [...signIns.map(n => `${n.platform_label}: ${SIGN_IN_STEPS}`), ...(signIns[0].browser ? [signIns[0].browser] : [])].join('\n'),
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
  out.wake = out.notify = out.publish.length + out.unpublish.length + out.reply.length > 0 || out.needs.some(n => !n.raised);
  return out;
}

const TZ = 'Asia/Ho_Chi_Minh';
const hm = at => new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dayHm = at => `${hm(at)} ${new Date(at).toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: TZ })}`;
const REPLY_WHY = { money: 'Soot không trả lời câu hỏi về tiền', complaint: 'Soot không trả lời phàn nàn', flagged: 'Soot không chắc nên chưa trả lời' };
export const ANSWERS = { uncertain: ['Đã lên — dán liên kết', 'Chưa lên — đăng lại', 'Bỏ bài'], late: ['Đăng ngay', 'Xếp lại', 'Bỏ'], reply: ['Xong'] };

/** One need as a ready Cần bạn item {keys, summary, missing, options}; marketing_answer applies the pick. */
async function askFor(n, { store, settings, soot, byKey, replies }) {
  const ch = byKey[n.channel] ?? {};
  const L = PLATFORM_LABEL[ch.platform ?? platformOf(n.channel)] ?? (n.channel === 'blog-lohi' ? 'Blog' : n.channel);
  const browser = soot ? `nest://browser/${soot}` : null;
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
    ...(ch.publisher === 'browser' ? { platform: ch.platform ?? platformOf(ch.key), account: ch.account ?? null, subreddit: b.subreddit ?? null } : {}),
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

export async function claim(input, { store, now, env }) {
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

export async function failIntent(input, { store, now }) {
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
  if (status === 'needs_person') {
    // Only that channel pauses; the reason is the platform code Cần bạn names.
    await store.update('channels', [eq('key', row.channel)], { paused: true, paused_reason: code });
  }
  // An earlier attempt may have gone out (verify_first) and the publisher could
  // not look: keep the intent and ask a person, never free it for a second post.
  if (status === 'uncertain' || (q?.verify && !unpub)) {
    await store.update('posts', [eq('ref', row.post)], { state: 'uncertain', reason });
    await store.update('publish_log', [eq('intent_id', row.intent_id)], { status: 'intent', reason });
    return { state: 'uncertain' };
  }
  await store.update('publish_log', [eq('intent_id', row.intent_id)], { status, reason, at: iso(now) });
  const retry = status === 'failed' ? now + HOUR : now;
  await store.update('queue', [eq('post', row.post), eq('intent_id', row.intent_id)], { intent_id: null, intent_at: null, verify: false, scheduled_at: iso(retry), wait_reason: reason });
  const state = unpub ? 'published' : 'failed';
  await store.update('posts', [eq('ref', row.post)], { state, reason });
  return { state };
}

export async function pause(input, { store, now }) {
  if (typeof input.paused !== 'boolean') fail('invalid_request', 'paused is true or false.');
  if (input.signed_in !== undefined && (input.signed_in !== true || !input.channel || input.paused !== true)) fail('invalid_request', 'signed_in is true, with channel and paused: true.');
  if (input.channel) {
    const ch = await channel(store, input.channel);
    // The Soot saw the person's session: the sign-in item ends and the channel stays paused until the person's Bật.
    if (input.signed_in && !(ch.paused && ch.paused_reason === 'signed_out')) fail('conflict', `Kênh ${ch.key} không chờ đăng nhập.`);
    await store.update('channels', [eq('key', input.channel)], { paused: input.paused, paused_reason: input.paused ? (input.signed_in ? 'signed_in' : 'person') : null });
    if (input.signed_in) await clearAttention(store, 'channel', input.channel);
    // Resuming ends that episode: a later sign-out is a new Cần bạn item.
    if (!input.paused) await clearAttention(store, 'channel', input.channel);
  } else {
    await setSetting(store, 'paused_all', input.paused);
    await setSetting(store, 'paused_at', input.paused ? iso(now) : null);
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
  return { items: rows.map(p => itemOf(p)) };
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
  const url = input.url;
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) fail('invalid_request', 'url is the https address of the served price/config source.');
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

export async function gsc_sync(input, { store, now, env, fetch }) {
  const site = input.site;
  if (typeof site !== 'string' || !site) fail('invalid_request', 'site is the Search Console property, e.g. sc-domain:example.com.');
  const days = Math.min(Math.max(Number(input.days) || 3, 1), 28);
  const needsPerson = async reason => {
    // The page's note is best effort; the sign-in signal below must go out even if storage is down.
    await setSetting(store, 'gsc', { state: 'needs_person', reason, at: iso(now) }).catch(() => {});
    // `needs_person` is the host's sign-in signal (2agent operations/sign_in.go): with exit 1 the
    // host marks GSC_GOOGLE and Cần bạn shows one "Đăng nhập Google lại" item, with no model call.
    return { status: 'needs_person', reason, message: reason === 'revoked' ? 'Quyền đọc Search Console đã bị thu hồi: cần đăng nhập Google lại.' : 'Cần đăng nhập Google cho Search Console.',
      needs_person: { credential: 'GSC_GOOGLE', reason: `oauth_${reason}` } };
  };
  const auth = await googleToken(env.GSC_GOOGLE ?? '', fetch);
  if (auth.error) return needsPerson(auth.error);
  const published = await store.query('posts', [eq('state', 'published')], { limit: 500 });
  const urls = new Set(published.map(p => p.url).filter(Boolean));
  const day = d => new Date(now - d * DAY).toISOString().slice(0, 10);
  const pages = await gscQuery(site, auth.token, { startDate: day(days), endDate: day(1), dimensions: ['page', 'date'], rowLimit: 5000 }, fetch);
  if (pages.error) return needsPerson(pages.error);
  const queries = await gscQuery(site, auth.token, { startDate: day(28), endDate: day(1), dimensions: ['page', 'query'], rowLimit: 5000 }, fetch);
  if (queries.error) return needsPerson(queries.error);
  let stored = 0;
  for (const r of pages.rows) {
    const [url, d] = r.keys ?? [];
    if (!urls.has(url)) continue;
    await store.remove('metrics', [eq('url', url), eq('day', d), eq('source', 'gsc'), eq('query', '')]);
    await store.insert('metrics', { url, source: 'gsc', day: d, query: '', impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, position: r.position ?? null, views: null });
    stored++;
  }
  // Query rows are a 28-day window ending yesterday, replaced on every read.
  await store.remove('metrics', [eq('source', 'gsc'), { column: 'query', op: 'ne', value: '' }]);
  for (const r of queries.rows) {
    const [url, query] = r.keys ?? [];
    if (!urls.has(url) || !query) continue;
    await store.insert('metrics', { url, source: 'gsc', day: day(1), query, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, position: r.position ?? null, views: null });
    stored++;
  }
  await setSetting(store, 'gsc', { state: 'ok', at: iso(now) });
  return { status: 'ok', rows: stored, urls: urls.size };
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

/** Create missing channels (social ones paused until their first sign-in) and
 * fill only unset values; a founder's edit or pause is never overwritten. */
export async function channels_setup(input, { store }) {
  const list = Array.isArray(input.channels) ? input.channels : [];
  if (list.length > 20) fail('invalid_request', 'At most 20 channels.');
  const out = [];
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || !defaultsFor(c.id)) fail('unknown_channel', `Không có kênh "${c?.id}".`);
    const existed = !!(await store.one('channels', [eq('key', c.id)]));
    const row = await channel(store, c.id);
    const set = {};
    for (const f of CHANNEL_FIELDS) if (Number.isInteger(c[f]) && c[f] >= 0 && (!existed || row[f] == null) && row[f] !== c[f]) set[f] = c[f];
    if (typeof c.account === 'string' && c.account && !row.account) set.account = c.account.slice(0, 200);
    if (c.rules && typeof c.rules === 'object' && !Array.isArray(c.rules)) {
      const rules = { ...(row.rules ?? {}) };
      for (const [k, v] of Object.entries(c.rules)) if (rules[k] === undefined) rules[k] = v;
      if (JSON.stringify(rules) !== JSON.stringify(row.rules ?? {})) set.rules = rules;
    }
    if (Object.keys(set).length) await store.update('channels', [eq('key', row.key)], set);
    out.push({ id: row.key, platform: row.platform ?? platformOf(row.key), paused: !!row.paused, paused_reason: row.paused_reason ?? null, created: !existed });
  }
  const settings = await getSettings(store);
  if (input.quiet_hours && !(await store.one('settings', [eq('key', 'quiet_hours')]))) {
    const q = input.quiet_hours;
    if (!/^\d{2}:\d{2}$/.test(q.from ?? '') || !/^\d{2}:\d{2}$/.test(q.to ?? '') || typeof q.tz !== 'string') fail('invalid_request', 'quiet_hours is {from:"HH:MM", to:"HH:MM", tz}.');
    await setSetting(store, 'quiet_hours', { from: q.from, to: q.to, tz: q.tz });
  }
  if (Number.isInteger(input.stale_after_h) && !(await store.one('settings', [eq('key', 'stale_after_h')]))) await setSetting(store, 'stale_after_h', input.stale_after_h);
  // The product's name, for Cần bạn wording ("Đăng nhập X cho Lohi"); the recipe owns it.
  if (typeof input.product === 'string' && input.product.trim()) await setSetting(store, 'product', input.product.trim().slice(0, 64));
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
