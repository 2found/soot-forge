// App Store reviews. Reading is Apple's public customer-reviews feed (no sign-in, no key).
// Posting a reply needs the founder's App Store Connect API key (ASC_API_KEY); without it the
// tool answers a named credential need and never invents one.
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { fail, skippedFor, needsCredential, eq, upsert, iso, short } from './base.mjs';

const FEED = 'https://itunes.apple.com';
const ASC = 'https://api.appstoreconnect.apple.com';
export const DEFAULT_APP_ID = '6795186131'; // Lohi on the App Store (ios/Sources/Lohi/Quests/QuestActions.swift)
export const REPLY_MAX = 1000; // our own bar; Apple allows 5970

const label = o => (o && typeof o === 'object' ? o.label : undefined);

/** Reviews of one feed page. The first entry of page 1 can be the app itself (no rating): dropped. */
export function parseFeed(json) {
  let entries = json?.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];
  return entries.filter(e => label(e?.['im:rating']) !== undefined).map(e => ({
    rid: String(label(e.id)), rating: Number(label(e['im:rating'])), title: short(label(e.title), 200), body: short(label(e.content), 1900),
    version: label(e['im:version']) ?? null, posted_at: label(e.updated) ?? null,
  })).filter(r => r.rid && r.rid !== 'undefined' && r.rating >= 1 && r.rating <= 5);
}

export async function appstore_sync(input, deps) {
  const { store, env, fetch } = deps;
  const app = String(env.APPSTORE_APP_ID || DEFAULT_APP_ID);
  const country = String(env.APPSTORE_COUNTRY || 'vn').toLowerCase();
  if (!/^\d{6,12}$/.test(app) || !/^[a-z]{2}$/.test(country)) fail('invalid_request', 'APPSTORE_APP_ID is digits and APPSTORE_COUNTRY two letters.');
  const pages = Math.min(Math.max(Number(input.pages) || 2, 1), 10);
  const fresh = [];
  let fetched = 0;
  for (let p = 1; p <= pages; p++) {
    let res;
    try { res = await fetch(`${FEED}/${country}/rss/customerreviews/id=${app}/sortBy=mostRecent/page=${p}/json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }); }
    catch { return { ok: false, error: { code: 'unreachable', message: 'Không đọc được đánh giá App Store (itunes.apple.com).' } }; }
    if (res.status === 400 || res.status === 404) break; // past the last page
    if (!res.ok) return { ok: false, error: { code: 'unreachable', message: `App Store trả lời ${res.status}.` } };
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { break; } // an empty page is an empty body
    const rows = parseFeed(json);
    if (!rows.length) break;
    fetched += rows.length;
    for (const r of rows) {
      if (await store.one('reviews', [eq('rid', r.rid)])) continue;
      await store.insert('reviews', { ...r, country, state: 'new' });
      fresh.push(r);
    }
  }
  const open = await store.query('reviews', [], { order: 'posted_at', limit: 200 });
  const needReply = open.filter(r => (r.state === 'new' || r.state === 'drafted') && r.rating <= 3).slice(0, 10);
  const rated = open.filter(r => r.rating);
  return {
    ok: true, fetched, new_count: fresh.length,
    new: fresh.slice(0, 20).map(r => ({ rid: r.rid, rating: r.rating, title: r.title, body: short(r.body, 400), version: r.version, posted_at: r.posted_at })),
    needs_reply: needReply.map(r => ({ rid: r.rid, rating: r.rating, title: r.title, body: short(r.body, 400), state: r.state, draft: r.reply_draft ?? null })),
    average_rating: rated.length ? Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 100) / 100 : null,
    stored: open.length,
    // New reviews wake the model once, with the batch to draft replies for.
    wake: fresh.length > 0, notify: false,
  };
}

const PII = /[^\s@]+@[^\s@]+|\b\d{9,}\b/;
export async function appstore_draft(input, deps) {
  const { store } = deps;
  const rid = String(input.rid ?? '');
  const reply = String(input.reply ?? '').trim();
  if (!rid) fail('invalid_request', 'rid is the review id from appstore_sync.');
  if (!reply || reply.length > REPLY_MAX) fail('invalid_request', `reply is 1 to ${REPLY_MAX} characters.`);
  if (PII.test(reply)) fail('invalid_request', 'A public reply carries no email or phone number.');
  const row = await store.one('reviews', [eq('rid', rid)]);
  if (!row) fail('not_found', 'No such review.');
  if (row.state === 'replied') fail('invalid_request', 'This review already has a posted reply.');
  await store.update('reviews', [eq('rid', rid)], { reply_draft: reply, state: 'drafted' });
  return { ok: true, rid, state: 'drafted', chars: reply.length };
}

// ---------- posting (needs ASC_API_KEY) ----------

const b64u = b => Buffer.from(b).toString('base64url');
/** An App Store Connect API token (ES256, 10 minutes). The key is {key_id, issuer_id, private_key} JSON. */
export function ascToken(cred, nowMs) {
  let c;
  try { c = JSON.parse(cred); } catch { return null; }
  if (!c?.key_id || !c?.issuer_id || !c?.private_key) return null;
  const iat = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: c.key_id, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: c.issuer_id, iat, exp: iat + 600, aud: 'appstoreconnect-v1' }));
  try {
    const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key: createPrivateKey(c.private_key), dsaEncoding: 'ieee-p1363' });
    return `${head}.${body}.${b64u(sig)}`;
  } catch { return null; }
}

export async function appstore_post(input, deps) {
  const { store, env, fetch, now } = deps;
  const rid = String(input.rid ?? '');
  if (!rid) fail('invalid_request', 'rid is the review id from appstore_sync.');
  const row = await store.one('reviews', [eq('rid', rid)]);
  if (!row) fail('not_found', 'No such review.');
  if (row.state === 'replied') return { ok: true, rid, state: 'replied', already: true };
  if (!row.reply_draft) fail('invalid_request', 'Draft a reply first (appstore_draft).');
  if (!env.ASC_API_KEY) return needsCredential('ASC_API_KEY', 'Đăng phản hồi lên App Store cần khoá App Store Connect API của chủ tài khoản (key id, issuer id, khoá riêng .p8).');
  const token = ascToken(env.ASC_API_KEY, now);
  if (!token) return needsCredential('ASC_API_KEY', 'Khoá App Store Connect API không đúng dạng (cần JSON có key_id, issuer_id, private_key).');
  const app = String(env.APPSTORE_APP_ID || DEFAULT_APP_ID);
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const url = new URL(`${ASC}/v1/apps/${app}/customerReviews`);
  url.searchParams.set('limit', '200'); url.searchParams.set('sort', '-createdDate');
  let res;
  try { res = await fetch(url.toString(), { headers: auth, signal: AbortSignal.timeout(20_000) }); }
  catch { return { ok: false, error: { code: 'unreachable', message: 'Không gọi được App Store Connect.' } }; }
  if (res.status === 401 || res.status === 403) return needsCredential('ASC_API_KEY', `App Store Connect từ chối khoá (${res.status}); kiểm tra quyền Customer Support hoặc App Manager.`);
  if (!res.ok) return { ok: false, error: { code: 'failed', message: `App Store Connect trả lời ${res.status}.` } };
  const list = (await res.json().catch(() => ({}))).data ?? [];
  // The public feed and App Store Connect number reviews differently: match on what the reader wrote.
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const hit = list.find(r => Number(r.attributes?.rating) === row.rating && norm(r.attributes?.title) === norm(row.title) && norm(r.attributes?.body).startsWith(norm(row.body).replace(/…$/, '')));
  if (!hit) return { ok: false, error: { code: 'review_not_found', message: 'Không tìm thấy đánh giá này trong App Store Connect (có thể đã quá 200 đánh giá gần nhất).' } };
  const post = await fetch(`${ASC}/v1/customerReviewResponses`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ data: { type: 'customerReviewResponses', attributes: { responseBody: row.reply_draft }, relationships: { review: { data: { type: 'customerReviews', id: hit.id } } } } }),
  }).catch(() => null);
  if (!post || !post.ok) return { ok: false, error: { code: 'failed', message: `App Store Connect không nhận phản hồi (${post?.status ?? 'không kết nối'}).` } };
  await store.update('reviews', [eq('rid', rid)], { state: 'replied', asc_id: hit.id, replied_at: iso(now) });
  return { ok: true, rid, state: 'replied' };
}
