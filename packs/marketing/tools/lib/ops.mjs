// Hubless marketing tools (design §3.2). Each op is `(input, deps)` with
// deps = {store, now, env, fetch, soot}; the entry wires the real ones.
// The hub-mode tools in pack.json are untouched and still forward when
// MARKETING_HUB is bound; nothing here reads it.
import { randomBytes, createHash } from 'node:crypto';
import { fail, eq, gte, isNull } from './store.mjs';
import { autoChecks, briefLint, claimWindow, CHANNEL_DEFAULTS } from './guard.mjs';
import { nextSlot, DEFAULT_QUIET } from './time.mjs';
import { contentHash, signClaim, CLAIM_TTL_MS, INTENT_STALE_MS } from './claim.mjs';
import { metricsRows } from './page.mjs';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();
const ms = s => Date.parse(s ?? '');
const ref = () => 'P-' + randomBytes(5).toString('hex').toUpperCase();
const intentID = () => 'I-' + randomBytes(8).toString('hex');

// States a person reads (Bài viết tabs and badges).
export const STATE_LABEL = {
  draft: 'Nháp', checking: 'Đang kiểm tra', refused: 'Bị từ chối', ready: 'Đã kiểm tra', scheduled: 'Chờ đăng', publishing: 'Đang đăng',
  published: 'Đã đăng', failed: 'Lỗi · thử lại', pulled: 'Đã kéo ra', unpublishing: 'Đang gỡ', removed: 'Đã gỡ', uncertain: 'Chưa rõ',
};

// ---------- settings and channels ----------

export async function getSettings(store) {
  const rows = await store.query('settings', [], { limit: 100 });
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { paused_all: s.paused_all === true, quiet_hours: s.quiet_hours ?? DEFAULT_QUIET, stale_after_h: s.stale_after_h ?? 6, paused_at: s.paused_at ?? null, gsc: s.gsc ?? null };
}

export async function setSetting(store, key, value) {
  if (await store.update('settings', [eq('key', key)], { value })) return;
  try { await store.insert('settings', { key, value }); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('settings', [eq('key', key)], { value }); }
}

export async function channel(store, key) {
  const row = await store.one('channels', [eq('key', key)]);
  if (row) return row;
  const d = CHANNEL_DEFAULTS[key];
  if (!d) fail('unknown_channel', `Không có kênh "${key}".`);
  // Social channels start paused until their first sign-in (p3).
  const fresh = { key, ...d, paused: d.kind === 'social', paused_reason: d.kind === 'social' ? 'signed_out' : null, account: null };
  try { await store.insert('channels', fresh); } catch (e) { if (e.code !== 'conflict') throw e; }
  return (await store.one('channels', [eq('key', key)])) ?? fresh;
}

async function post(store, id) {
  if (typeof id !== 'string' || !id) fail('invalid_request', 'id is required.');
  const row = await store.one('posts', [eq('ref', id)]);
  if (!row) fail('not_found', `Không có bài ${id}.`);
  return row;
}
const hashOf = p => contentHash({ title: p.brief?.title ?? '', meta: p.brief?.meta ?? '', slug: p.brief?.slug ?? '', body: p.body ?? '', link: p.link ?? '' });

async function guardInputs(store, p, now) {
  const [ch, facts, log] = await Promise.all([
    channel(store, p.channel),
    store.query('facts', [], { limit: 500 }),
    store.query('publish_log', [gte('at', iso(now - 90 * DAY))], { order: 'at', limit: 500 }),
  ]);
  return { channel: ch, facts, log: log.filter(r => r.post !== p.ref), now };
}

// ---------- write side ----------

export async function draft_save(input, { store, now, soot }) {
  const { request_id, id, expected_revision, kind, channel: chKey, campaign, parent, brief, body, link, asset_ids } = input;
  if (!['article', 'social', 'video', 'reply'].includes(kind)) fail('invalid_request', 'kind is article, social, video or reply.');
  if (typeof body !== 'string' || !body.trim()) fail('invalid_request', 'body is required.');
  const ch = await channel(store, chKey);
  const fields = { kind, channel: ch.key, campaign: campaign ?? null, parent: parent ?? null, brief: brief ?? null, title: brief?.title ?? null, body, link: link ?? null, asset_ids: asset_ids ?? null };
  const lint = briefLint(fields, ch);
  if (!id) {
    if (request_id) {
      const seen = await store.one('posts', [eq('request_id', request_id)]);
      if (seen) return { id: seen.ref, revision: seen.revision, content_hash: seen.content_hash, state: seen.state, lint: briefLint(seen, ch), replayed: true };
    }
    const row = { ...fields, ref: ref(), request_id: request_id ?? null, content_hash: hashOf(fields), state: 'draft', reason: null, revision: 1, author_soot: soot ?? null };
    await store.insert('posts', row);
    return { id: row.ref, revision: 1, content_hash: row.content_hash, state: 'draft', lint };
  }
  const cur = await post(store, id);
  if (['publishing', 'published', 'unpublishing', 'uncertain'].includes(cur.state)) fail('conflict', 'Bài đang đăng, đã đăng hoặc chưa rõ đã lên chưa; gỡ hoặc xác nhận trước rồi sửa.');
  if (expected_revision !== cur.revision) fail('revision_conflict', `Bài đang ở bản ${cur.revision}.`);
  const revision = cur.revision + 1;
  const n = await store.update('posts', [eq('ref', id), eq('revision', cur.revision)], { ...fields, content_hash: hashOf(fields), state: 'draft', reason: null, revision });
  if (!n) fail('revision_conflict', 'Bài vừa được sửa ở nơi khác.');
  await store.remove('queue', [eq('post', id), isNull('intent_id')]);
  return { id, revision, content_hash: hashOf(fields), state: 'draft', lint };
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
  await store.update('posts', [eq('ref', p.ref)], { state: verdict === 'pass' ? 'ready' : 'refused', reason });
  return { verdict, auto: auto.map(({ rule, ok, detail }) => ({ rule, ok, detail })), ...(reason ? { reason } : {}) };
}

async function takenTimes(store, chKey, now, own) {
  const [queued, log] = await Promise.all([
    store.query('queue', [eq('channel', chKey)], { order: 'scheduled_at', limit: 500 }),
    store.query('publish_log', [eq('channel', chKey), gte('at', iso(now - 7 * DAY))], { order: 'at', limit: 500 }),
  ]);
  const times = [
    ...queued.filter(q => q.action !== 'unpublish' && q.post !== own).map(q => ms(q.scheduled_at)),
    ...log.filter(r => r.action === 'publish' && ['published', 'intent'].includes(r.status)).map(r => ms(r.at)),
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
  const { mine, times } = await takenTimes(store, ch.key, now, p.ref);
  if (mine?.intent_id) fail('conflict', 'Bài đang được đăng.');
  let at;
  if (input.scheduled_at) {
    at = ms(input.scheduled_at);
    if (!Number.isFinite(at)) fail('invalid_request', 'scheduled_at is an RFC 3339 time.');
  } else {
    const jitter = parseInt(createHash('sha256').update(p.ref).digest('hex').slice(0, 2), 16) % 10;
    at = nextSlot({ from: now, taken: times, cap: ch.cap_per_day ?? 1, spacingMin: ch.spacing_min ?? 0, quiet: settings.quiet_hours, jitterMin: jitter });
    if (at == null) fail('no_slot', 'Không còn khung giờ trống trong 30 ngày.');
  }
  if (mine) await store.update('queue', [eq('post', p.ref)], { scheduled_at: iso(at), action: 'publish', wait_reason: null });
  else await store.insert('queue', { post: p.ref, channel: ch.key, action: 'publish', scheduled_at: iso(at), intent_id: null, intent_at: null, attempts: 0, wait_reason: null });
  await store.update('posts', [eq('ref', p.ref)], { state: 'scheduled', reason: null });
  return { id: p.ref, scheduled_at: iso(at) };
}

async function latestCheck(store, p) {
  return (await store.query('checks', [eq('post', p.ref)], { order: 'at', limit: 1 }))[0] ?? null;
}

// ---------- the dispatcher's read ----------

export async function due(_input, { store, now }) {
  const settings = await getSettings(store);
  const rows = await store.query('queue', [{ column: 'scheduled_at', op: 'lte', value: iso(now) }], { order: 'scheduled_at', desc: false, limit: 200 });
  const channels = await store.query('channels', [], { limit: 50 });
  const byKey = Object.fromEntries(channels.map(c => [c.key, c]));
  const out = { wake: false, publish: [], unpublish: [], late: [], needs_person: [] };
  for (const c of channels) if (c.paused && c.paused_reason && c.paused_reason !== 'person') out.needs_person.push({ id: c.key, channel: c.key, reason: c.paused_reason });
  for (const q of rows) {
    const ch = byKey[q.channel];
    const stuck = q.intent_id && now - ms(q.intent_at) > INTENT_STALE_MS;
    if (q.intent_id && !stuck) continue;
    if (q.action === 'unpublish') { out.unpublish.push(q.post); continue; }
    if (now - ms(q.scheduled_at) > settings.stale_after_h * HOUR) out.late.push(q.post);
    if (settings.paused_all || ch?.paused) continue;
    out.publish.push(q.post);
  }
  // The runtime's wake_when matches the boolean `notify` (or a string at a path), so both say the same.
  out.wake = out.notify = out.publish.length + out.unpublish.length > 0;
  return out;
}

// ---------- claim → publish → record / fail ----------

function claimBody(p, ch, action, intent, now) {
  const b = p.brief ?? {};
  return {
    intent_id: intent, post: p.ref, channel: ch.key, publisher: ch.publisher, action, content_hash: p.content_hash,
    title: b.title ?? '', meta: b.meta ?? '', slug: b.slug ?? '', body: p.body ?? '', link: p.link ?? '',
    series: b.series ?? ch.rules?.series ?? null, date: new Date(now).toISOString().slice(0, 10),
    url: action === 'unpublish' ? p.url ?? null : null, expires_at: iso(now + CLAIM_TTL_MS),
  };
}

async function refuse(store, p, code, reason, { refusePost = false } = {}) {
  if (refusePost) {
    await store.update('posts', [eq('ref', p.ref)], { state: 'refused', reason });
    await store.remove('queue', [eq('post', p.ref), isNull('intent_id')]);
  } else {
    await store.update('queue', [eq('post', p.ref)], { wait_reason: reason });
  }
  return { refused: { code, reason } };
}

export async function claim(input, { store, now, env }) {
  const action = input.action ?? 'publish';
  if (!['publish', 'unpublish', 'reply'].includes(action)) fail('invalid_request', 'action is publish, unpublish or reply.');
  if (action === 'reply') return { refused: { code: 'not_available', reason: 'Trả lời bình luận chưa có ở bản này.' } };
  const key = env.MARKETING_CLAIM_KEY;
  if (!key) return { refused: { code: 'claim_key_missing', reason: 'Soot chưa có khoá MARKETING_CLAIM_KEY.' } };
  const p = await post(store, input.id);
  const q = await store.one('queue', [eq('post', p.ref)]);
  if (!q || q.action !== action) return { refused: { code: 'not_queued', reason: action === 'publish' ? 'Bài không có trong hàng đợi.' : 'Bài không chờ gỡ.' } };
  const ch = await channel(store, p.channel);
  const settings = await getSettings(store);

  // An open intent: the last attempt may have gone out. Re-issue the same
  // intent and make the publisher look before it acts (crash recovery).
  if (q.intent_id) {
    if (now - ms(q.intent_at) <= INTENT_STALE_MS) return { refused: { code: 'open_intent', reason: 'Bài đang được đăng ở lượt khác.' } };
    if (action === 'publish' && (settings.paused_all || ch.paused)) return refuse(store, p, 'paused', 'Đang tạm dừng đăng.');
    await store.update('queue', [eq('post', p.ref), eq('intent_id', q.intent_id)], { intent_at: iso(now) });
    if (!(await store.one('publish_log', [eq('intent_id', q.intent_id)]))) {
      await store.insert('publish_log', { post: p.ref, channel: ch.key, action, intent_id: q.intent_id, status: 'intent', body: p.body, link: p.link ?? null, url: p.url ?? null, platform_id: null, reason: null, at: iso(q.intent_at ?? now) });
    }
    return { claim: signClaim(claimBody(p, ch, action, q.intent_id, now), key), verify_first: true };
  }

  if (action === 'publish') {
    if (!['scheduled', 'failed'].includes(p.state)) return { refused: { code: 'not_ready', reason: `Bài đang ${STATE_LABEL[p.state]}.` } };
    if (ms(q.scheduled_at) > now) return { refused: { code: 'not_due', reason: 'Chưa tới giờ đăng.' } };
    if (p.content_hash !== hashOf(p)) return refuse(store, p, 'hash_mismatch', 'Nội dung đổi sau khi kiểm tra.', { refusePost: true });
    const gi = await guardInputs(store, p, now);
    const failed = autoChecks(p, gi).filter(a => !a.ok);
    if (failed.length) return refuse(store, p, failed[0].code, failed.map(a => a.detail).join(' · '), { refusePost: true });
    const last = await latestCheck(store, p);
    if (!last || last.verdict !== 'pass' || last.content_hash !== p.content_hash) return refuse(store, p, 'not_checked', 'Editor chưa duyệt đúng bản này.', { refusePost: true });
    const wait = claimWindow({ settings, channel: ch, log: gi.log.filter(r => r.channel === ch.key), now });
    if (wait) return refuse(store, p, wait.code, wait.reason);
  } else if (p.state !== 'published' && p.state !== 'unpublishing') {
    return { refused: { code: 'not_published', reason: 'Bài chưa đăng.' } };
  }

  // Compare-and-set: only one caller turns the open slot into an intent.
  const intent = intentID();
  const won = await store.update('queue', [eq('post', p.ref), isNull('intent_id')], { intent_id: intent, intent_at: iso(now), attempts: (q.attempts ?? 0) + 1, wait_reason: null });
  if (!won) return { refused: { code: 'open_intent', reason: 'Bài đang được đăng ở lượt khác.' } };
  // The intent row is written before anything goes out.
  await store.insert('publish_log', { post: p.ref, channel: ch.key, action, intent_id: intent, status: 'intent', body: p.body, link: p.link ?? null, url: p.url ?? null, platform_id: null, reason: null, at: iso(now) });
  await store.update('posts', [eq('ref', p.ref)], { state: action === 'publish' ? 'publishing' : 'unpublishing', reason: null });
  return { claim: signClaim(claimBody(p, ch, action, intent, now), key) };
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
  if (row.status === done) return { state: done, ...(done === 'published' ? { outcome: { id: 'post_published', ref: row.url } } : {}), replayed: true };
  if (done === 'published' && (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url))) fail('invalid_request', 'url is required.');
  const url = done === 'published' ? input.url : row.url;
  await store.update('publish_log', [eq('intent_id', row.intent_id)], { status: done, url, platform_id: input.platform_id ?? null, at: iso(now) });
  await store.update('posts', [eq('ref', row.post)], done === 'published' ? { state: 'published', url, platform_id: input.platform_id ?? null, reason: null } : { state: 'removed', reason: null });
  await store.remove('queue', [eq('post', row.post), eq('intent_id', row.intent_id)]);
  return { state: done, ...(done === 'published' ? { outcome: { id: 'post_published', ref: url } } : {}) };
}

export async function failIntent(input, { store, now }) {
  const row = await intentRow(store, input.intent_id);
  const status = input.status;
  if (!['failed', 'needs_person', 'uncertain'].includes(status)) fail('invalid_request', 'status is failed, needs_person or uncertain.');
  const reason = String(input.reason ?? '').slice(0, 500) || 'Không rõ lý do.';
  if (row.status !== 'intent') return { state: (await post(store, row.post)).state, replayed: true };
  await store.update('publish_log', [eq('intent_id', row.intent_id)], { status, reason, at: iso(now) });
  const unpub = row.action === 'unpublish';
  if (status === 'uncertain') {
    // Keep the intent: the next claim re-issues it with verify_first.
    await store.update('posts', [eq('ref', row.post)], { state: 'uncertain', reason });
    await store.update('publish_log', [eq('intent_id', row.intent_id)], { status: 'intent', reason });
    return { state: 'uncertain' };
  }
  if (status === 'needs_person') {
    await store.update('channels', [eq('key', row.channel)], { paused: true, paused_reason: reason });
  }
  const retry = status === 'failed' ? now + HOUR : now;
  await store.update('queue', [eq('post', row.post), eq('intent_id', row.intent_id)], { intent_id: null, intent_at: null, scheduled_at: iso(retry), wait_reason: reason });
  const state = unpub ? 'published' : 'failed';
  await store.update('posts', [eq('ref', row.post)], { state, reason });
  return { state };
}

export async function pause(input, { store, now }) {
  if (typeof input.paused !== 'boolean') fail('invalid_request', 'paused is true or false.');
  if (input.channel) {
    await channel(store, input.channel);
    await store.update('channels', [eq('key', input.channel)], { paused: input.paused, paused_reason: input.paused ? 'person' : null });
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

