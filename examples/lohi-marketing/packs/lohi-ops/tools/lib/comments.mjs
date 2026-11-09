// Comment moderation. The api lists comments (flagged by readers, and the newest visible ones);
// the model classifies them; this pack decides what its own rules let it act on:
// only a clear spam/abuse/scam verdict (confidence >= HIDE_MIN) is hidden, by the api, at most
// HIDE_CAP per call. Anything unsure, or an "ok" that is not confident, is escalated to a person.
// The api is the only writer; a comment is never deleted, and `keep` restores a hidden one.
import { fail, skippedFor, lohiApi, eq, upsert, needCard, iso, short } from './base.mjs';

export const HIDE_MIN = 0.9;
export const KEEP_MIN = 0.7;
export const HIDE_CAP = 15;
const HIDE_VERDICTS = new Set(['spam', 'abuse', 'scam']);
const VERDICTS = new Set([...HIDE_VERDICTS, 'ok', 'unsure']);

// Comments no judgment is needed for: a short thanks, praise or an emoji, from the newest visible ones (never one a reader
// reported). Every word must be on the list, so any unknown word, link, number run or contact goes to the model as before.
const fold = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
const THANKS = new Set(['cam', 'on', 'camon', 'thanks', 'thank', 'thankyou', 'tks', 'thx', 'ty', 'cảm', 'cám']);
const PRAISE = new Set(['hay', 'tuyet', 'voi', 'dinh', 'tot', 'ok', 'oke', 'okay', 'good', 'great', 'nice', 'love', 'like', 'wow', 'xuat', 'sac', 'ung', 'ho', 'thich', 'hihi', 'haha', 'hehe', 'dang', 'doc', 'cuon', 'hap', 'dan', 'cute', 'dep', 'qua', 'rat', 'lam', 'cuc', 'sieu', 'that', 'nhat']);
const FILLER = new Set(['truyen', 'chuong', 'bo', 'nay', 'ad', 'admin', 'tac', 'gia', 'dich', 'nhom', 'nhieu', 'nhe', 'nha', 'a', 'ah', 'ạ', 'ban', 'you', 'so', 'much', 'rat', 'va', 'cho', 'minh', 'em', 'anh', 'chi', 'moi', 'nguoi', 'tiep', 'di', 'nua', 'cap', 'nhat', 'luon', 'the', 'day', 'la', 'de', 'cuong']);
export const AUTO_KEEP_MAX_CHARS = 60;
/** 'thanks' | 'praise' | 'emoji' when the comment is harmless on its face, else null. */
export function harmless(body) {
  const raw = String(body ?? '').trim();
  if (!raw || raw.length > AUTO_KEEP_MAX_CHARS) return null;
  if (/https?:|www\.|@|\.(com|vn|net|org|me|ly)\b|\d{4,}/i.test(raw)) return null;
  const words = fold(raw).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(raw) || /^[\s!.?~♥❤]+$/.test(raw) ? 'emoji' : null;
  if (words.length > 8 || words.some(w => !THANKS.has(w) && !PRAISE.has(w) && !FILLER.has(w))) return null;
  return words.some(w => THANKS.has(w)) ? 'thanks' : words.some(w => PRAISE.has(w)) ? 'praise' : null;
}

const apiFail = e => ({ ok: false, error: { code: e.code, message: e.message } });

export async function comments_pull(input, deps) {
  const { store } = deps;
  const scopes = input.scope === 'flagged' ? ['flagged'] : input.scope === 'recent' ? ['recent'] : ['flagged', 'recent'];
  const limit = Math.min(Math.max(Number(input.limit) || 40, 1), 100);
  const days = Math.min(Math.max(Number(input.days) || 2, 1), 30);
  const known = new Map((await store.query('comments', [], { order: 'updated_at', limit: 500 })).map(r => [r.reply_id, r]));
  const items = [];
  let skippedKnown = 0;
  for (const scope of scopes) {
    const r = await lohiApi(deps, 'GET', '/admin/moderation/replies', { query: { scope, limit, days } });
    if (r.skipped) return skippedFor(r.skipped);
    if (r.error) return apiFail(r.error);
    for (const it of r.out.items ?? []) {
      const was = known.get(it.id);
      if (was && was.state !== 'pending') { skippedKnown++; continue; }
      if (items.some(x => x.id === it.id)) continue;
      items.push({ id: it.id, source: scope, body: it.body, report_reason: it.report_reason ?? null, created_at: it.created_at });
    }
  }
  // Harmless ones are kept here, in the tool: no model wake, no api call (an unreported comment has nothing to dismiss).
  const autoKept = [];
  const judge = [];
  for (const it of items) {
    const kind = it.source === 'recent' && !it.report_reason ? harmless(it.body) : null;
    if (kind) {
      await upsert(store, 'comments', 'reply_id', { reply_id: it.id, source: it.source, excerpt: short(it.body, 160), state: 'kept', verdict: 'ok', confidence: 1, why: `tự giữ: ${kind}`, decided_at: iso(deps.now) });
      autoKept.push(it.id);
    } else judge.push(it);
  }
  const batch = judge.slice(0, limit);
  for (const it of batch) {
    await upsert(store, 'comments', 'reply_id', { reply_id: it.id, source: it.source, excerpt: short(it.body, 160), state: 'pending' });
  }
  return {
    ok: true, count: batch.length, auto_kept: autoKept.length, skipped_known: skippedKnown, items: batch,
    // The schedule wakes the model (wake_when notify) only when there is something to judge.
    notify: batch.length > 0,
    rules: `Phân loại từng bình luận: spam, abuse, scam, ok hoặc unsure. Chỉ spam/abuse/scam rõ ràng (độ tin cậy >= ${HIDE_MIN}) mới bị ẩn; ok chắc chắn (>= ${KEEP_MIN}) thì giữ; còn lại là unsure để người quyết.`,
  };
}

export async function comments_decide(input, deps) {
  const { store, now } = deps;
  const verdicts = Array.isArray(input.verdicts) ? input.verdicts : [];
  if (!verdicts.length || verdicts.length > 50) fail('invalid_request', 'verdicts is a list of 1 to 50 {id, verdict, confidence, why}.');
  const dry = input.dry_run === true;
  const out = { hidden: [], kept: [], escalated: [], rejected: [], errors: [] };
  let hides = 0;
  for (const v of verdicts) {
    const id = String(v?.id ?? '');
    const confidence = Number(v?.confidence);
    if (!VERDICTS.has(v?.verdict) || !/^[0-9a-f-]{36}$/i.test(id) || !(confidence >= 0 && confidence <= 1)) { out.rejected.push({ id: id.slice(0, 36), reason: 'invalid verdict' }); continue; }
    const row = await store.one('comments', [eq('reply_id', id)]);
    if (!row) { out.rejected.push({ id, reason: 'not pulled by comments_pull' }); continue; }
    if (row.state !== 'pending') { out.rejected.push({ id, reason: `already ${row.state}` }); continue; }
    const why = short(v.why, 200);
    const base = { verdict: v.verdict, confidence, why, decided_at: iso(now) };
    const hideable = HIDE_VERDICTS.has(v.verdict) && confidence >= HIDE_MIN && hides < HIDE_CAP;
    const keepable = v.verdict === 'ok' && confidence >= KEEP_MIN;
    if (hideable) {
      hides++;
      if (dry) { out.hidden.push({ id, dry_run: true }); await store.update('comments', [eq('reply_id', id)], { ...base, state: 'dry_run' }); continue; }
      const r = await lohiApi(deps, 'POST', `/admin/moderation/replies/${id}/hide`, { body: { reason: v.verdict } });
      if (r.skipped) return skippedFor(r.skipped);
      if (r.error) { out.errors.push({ id, ...r.error }); if (r.error.code === 'forbidden') break; continue; }
      await store.update('comments', [eq('reply_id', id)], { ...base, state: 'hidden' });
      out.hidden.push({ id, reason: v.verdict });
    } else if (keepable) {
      // Only a reader-flagged comment has an open report to dismiss; an unflagged ok needs no call.
      if (row.source === 'flagged' && !dry) {
        const r = await lohiApi(deps, 'POST', `/admin/moderation/replies/${id}/keep`);
        if (r.skipped) return skippedFor(r.skipped);
        if (r.error) { out.errors.push({ id, ...r.error }); if (r.error.code === 'forbidden') break; continue; }
      }
      await store.update('comments', [eq('reply_id', id)], { ...base, state: dry ? 'dry_run' : 'kept' });
      out.kept.push({ id });
    } else {
      // Unsure, low confidence, or past the per-call hide cap: a person decides.
      await store.update('comments', [eq('reply_id', id)], { ...base, state: 'escalated' });
      out.escalated.push({ id, verdict: v.verdict, confidence, excerpt: row.excerpt });
    }
  }
  const pending = await store.query('comments', [eq('state', 'escalated')], { order: 'updated_at', desc: false, limit: 100 });
  const card = await needCard(store, 'comments', {
    items: pending.map(p => p.reply_id), summary: `${pending.length} bình luận cần bạn quyết (ẩn hay giữ)`,
    lines: pending.slice(0, 10).map(p => `• ${p.reply_id.slice(0, 8)}: "${short(p.excerpt, 110)}" (${p.verdict} ${p.confidence})`),
    options: [{ label: 'Đã xem, để Soot xử lý theo lời tôi' }],
  });
  return { ok: out.errors.length === 0, dry_run: dry, ...out, awaiting_person: pending.length, ...card };
}

export async function comments_resolve(input, deps) {
  const { store, now } = deps;
  const id = String(input.id ?? '');
  const action = input.action;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !['hide', 'keep'].includes(action)) fail('invalid_request', 'id is a comment id, action is hide or keep.');
  const row = await store.one('comments', [eq('reply_id', id)]);
  if (!row || row.state !== 'escalated') fail('invalid_request', 'Only a comment escalated to a person can be resolved here.');
  const r = action === 'hide'
    ? await lohiApi(deps, 'POST', `/admin/moderation/replies/${id}/hide`, { body: { reason: ['spam', 'abuse', 'scam', 'other'].includes(input.reason) ? input.reason : 'other' } })
    : await lohiApi(deps, 'POST', `/admin/moderation/replies/${id}/keep`);
  if (r.skipped) return skippedFor(r.skipped);
  if (r.error) return apiFail(r.error);
  await store.update('comments', [eq('reply_id', id)], { state: action === 'hide' ? 'hidden' : 'kept', decided_at: iso(now), why: short(`người quyết: ${action}`, 200) });
  const left = await store.query('comments', [eq('state', 'escalated')], { limit: 100 });
  const card = left.length ? {} : await needCard(store, 'comments', { items: [], summary: '', lines: [] });
  return { ok: true, id, state: action === 'hide' ? 'hidden' : 'kept', awaiting_person: left.length, ...card };
}
