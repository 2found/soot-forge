// The request → release steps after a new novel's first batch is in Vietnamese (bs-kh1atl85): the quality sample,
// the verdict (pass → pro audio for the batch, platform-paid inside the api's daily cap; fail → one retranslate,
// then a person), and the poll that marks the request released once the audio is there. The api decides, caps and
// keeps the request's `stage`; these tools only name the call and remember where each novel is, in the pack's
// `state` table under `release:<slug>`.
import { fail, lohiApi, setupNeed, getState, setState, needCard, iso, short } from './base.mjs';
import { call, done, clampInt, needUuid, oneOf, SLUG, recordOutcome } from './curator.mjs';
import { postStage } from './stage.mjs';

const slugOf = v => { const s = String(v ?? ''); if (!SLUG.test(s)) fail('invalid_request', 'slug is a novel slug (a-z, 0-9, -).'); return s; };
const KEY = slug => `release:${slug}`;
/** Phases release_step moves; `translating` waits for translate_step, `human` for the card, `released` is the end. */
const ACTIVE = ['quality', 'retranslating', 'audio_deferred', 'audio', 'closing'];
/** A retranslated batch is sampled again after this long (Litrans works one chapter at a time). */
export const RESAMPLE_AFTER_MIN = 20;
/** An unanswered sample wakes the model again only after this long. */
export const WAKE_COOLDOWN_H = 6;

/** A new novel from a request is up and its first batch is being translated (catalog_jobs_sync, on a done onboard). */
export async function awaitTranslation(deps, { slug, requestId, from, to }) {
  if (!deps.store) return;
  if (await getState(deps.store, KEY(slug))) return; // one release per novel
  await setState(deps.store, KEY(slug), { request_id: requestId ?? null, from, to, phase: 'translating', attempt: 1, at: iso(deps.now) });
}

/**
 * The first batch is in Vietnamese (translate_step): a novel on its way to release now waits for the quality
 * verdict. True when the novel is gated, so the caller leaves the request open (it is closed at release).
 */
export async function awaitQuality(deps, { slug }) {
  if (!deps.store) return false;
  const was = await getState(deps.store, KEY(slug));
  // A released novel's later batches are ordinary chapter requests: they close as translated.
  if (!was || was.phase === 'released') return false;
  if (was.phase === 'translating') await setState(deps.store, KEY(slug), { ...was, phase: 'quality', at: iso(deps.now) });
  return true;
}

/** The sample a verdict is made from: per-chapter length, leftover Chinese, missing Book Bible names, audio. Read only. */
export async function quality_sample(input, deps) {
  const slug = slugOf(input.slug);
  const query = { from: clampInt(input.from, 1, 999999, 1), ...(input.to ? { to: clampInt(input.to, 1, 999999, 10) } : {}) };
  const r = await call(deps, 'GET', `/novel/agent/novels/${slug}/quality-sample`, { query });
  if (r.early) return r.early;
  const local = deps.store ? await getState(deps.store, KEY(slug)) : null;
  return done({ ...compactSample(r.out), attempt: local?.attempt ?? 1, request_id: local?.request_id ?? null }, r.cleared);
}

/**
 * The verdict needs the flags and the few numbers behind them, not every column of every chapter: a clean chapter is one
 * short row, a flagged one keeps its figures and at most 3 missing names. Keeps the model's context (and budget) small.
 */
export function compactSample(out) {
  if (!out || !Array.isArray(out.chapters)) return out;
  const chapters = out.chapters.slice(0, 10).map(c => {
    const flags = Array.isArray(c.flags) ? c.flags : [];
    const row = { chapter: c.chapter, flags, translated_chars: c.translated_chars };
    if (c.audio === true) row.audio = true;
    if (flags.some(f => f !== 'no_audio')) Object.assign(row, { length_ratio: c.length_ratio, leftover_cjk: c.leftover_cjk, ...(c.status && c.status !== 'translated' ? { status: c.status } : {}) });
    if (Array.isArray(c.names_missing) && c.names_missing.length) row.names_missing = c.names_missing.slice(0, 3).map(n => (typeof n === 'string' ? n : `${n.name_cn}=${n.name_vi}`));
    return row;
  });
  return { ...out, chapters };
}

/**
 * The verdict on a sample. pass: the api dispatches pro audio for the batch (or defers it past the day's cap) and
 * moves the request to `audio`. fail: the api says what is next. `retranslate` re-translates the named chapters
 * (or the whole batch) and the batch is sampled again; `human` is one Cần bạn card. A replayed verdict is a no-op.
 */
export async function quality_verdict(input, deps) {
  const { store, now } = deps;
  const slug = slugOf(input.slug);
  const verdict = oneOf(input.verdict, ['pass', 'fail'], 'verdict');
  const score = Number(input.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) fail('invalid_request', 'score is 0 to 1.');
  const reason = short(input.reason, 600);
  if (reason.length < 4) fail('invalid_request', 'reason is one short Vietnamese sentence the operator can read.');
  const local = store ? await getState(store, KEY(slug)) : null;
  const attempt = clampInt(input.attempt ?? local?.attempt, 1, 5, 1);
  const requestId = input.request_id ? needUuid(input.request_id, 'request_id') : local?.request_id ?? null;
  const from = clampInt(input.from ?? local?.from, 1, 999999, 1);
  const to = clampInt(input.to ?? local?.to, from, 999999, from + 9);
  const scores = Array.isArray(input.scores) ? input.scores.slice(0, 10).map(s => ({ chapter: clampInt(s?.chapter, 1, 999999, 1), score: Math.min(Math.max(Number(s?.score) || 0, 0), 1) })) : undefined;
  const dryRun = input.dry_run === true;
  const body = { verdict, score, reason, attempt, from, to, ...(scores ? { scores } : {}), ...(requestId ? { requestId } : {}), ...(input.voice_id ? { voiceId: short(input.voice_id, 100) } : {}), dryRun };
  const r = await call(deps, 'POST', `/novel/agent/novels/${slug}/quality-verdict`, { body });
  if (r.early) return r.early;
  const out = r.out;
  if (dryRun || !store) return done({ slug, ...out }, r.cleared);

  const base = { request_id: requestId, from, to, attempt, score, reason: short(reason, 200), at: iso(now) };
  let retranslated = null;
  if (out.verdict === 'pass') {
    const status = out.tts?.status;
    // already_voiced is checked by release_step like any dispatched batch, which closes the request.
    const phase = status === 'dispatched' || status === 'already_voiced' ? 'audio' : 'audio_deferred';
    await setState(store, KEY(slug), { ...base, phase, tts: status ?? null });
  } else if (out.next === 'retranslate' && !out.replayed) {
    const chapters = Array.isArray(input.retranslate) && input.retranslate.length
      ? [...new Set(input.retranslate.map(n => clampInt(n, from, to, from)))].slice(0, 10)
      : Array.from({ length: to - from + 1 }, (_, i) => from + i);
    retranslated = [];
    for (const n of chapters) {
      const t = await lohiApi(deps, 'POST', `/novel/agent/novels/${slug}/chapters/${n}/retranslate`, { body: {} });
      retranslated.push({ chapter: n, ok: !t.error && !t.skipped, ...(t.error ? { code: t.error.code ?? 'failed' } : {}) });
    }
    await setState(store, KEY(slug), { ...base, phase: 'retranslating', attempt: attempt + 1, started_at: iso(now) });
  } else if (out.next === 'human') {
    await setState(store, KEY(slug), { ...base, phase: 'human' });
  }
  const card = await humanCard(deps);
  return done({ slug, ...out, ...(retranslated ? { retranslated } : {}), ...(card.ask ? { ask: card.ask } : {}) }, r.cleared);
}

/** Novels whose quality failed twice: one card, cleared when none is left. */
async function humanCard(deps) {
  const rows = await releaseRows(deps.store);
  const open = rows.filter(r => r.value.phase === 'human');
  return needCard(deps.store, 'quality', {
    items: open.map(r => r.slug), summary: `${open.length} truyện mới chưa đạt chất lượng sau một lần dịch lại`,
    lines: open.map(r => `• ${r.slug} chương ${r.value.from}–${r.value.to}: ${short(r.value.reason, 140)}`),
  });
}

async function releaseRows(store, limit = 500) {
  return (await store.query('state', [], { order: 'updated_at', limit }))
    .filter(r => r.key?.startsWith('release:') && r.value)
    .map(r => ({ slug: r.key.slice('release:'.length), value: r.value }));
}

/**
 * One tick of every novel on its way to release, no model: a retranslated batch goes back to `quality` once it had
 * time; deferred audio is retried (a replayed pass verdict dispatches what is still missing); dispatched audio is
 * checked and, once every sampled chapter has it, the request is marked released (the api tells the readers).
 * Wakes the model only when a sample waits for a verdict.
 */
export async function release_step(input, deps) {
  const { store, now } = deps;
  const active = (await releaseRows(store)).filter(r => ACTIVE.includes(r.value.phase));
  const rows = active.slice(0, clampInt(input.limit, 1, 50, 20));
  const moved = [], toJudge = [];
  const woke = [];
  for (const { slug, value } of rows) {
    let v = value;
    const set = async (phase, extra = {}) => { v = { ...v, phase, at: iso(now), ...extra }; await setState(store, KEY(slug), v); moved.push({ slug, phase }); };
    // A sample waiting for a verdict is listed on every tick but wakes the model once per cooldown, so an unanswered one
    // is not paid for again every few minutes (the verdict stays possible through quality_sample / quality_verdict).
    const judge = () => {
      toJudge.push({ slug, from: v.from, to: v.to, attempt: v.attempt ?? 1, request_id: v.request_id ?? null });
      if (!v.woke_at || now - Date.parse(v.woke_at) >= WAKE_COOLDOWN_H * 3_600_000) woke.push(slug);
    };
    if (v.phase === 'quality') { judge(); continue; }
    if (v.phase === 'retranslating') {
      if (now - Date.parse(v.started_at ?? v.at) >= RESAMPLE_AFTER_MIN * 60_000) { await set('quality'); judge(); }
      continue;
    }
    if (v.phase === 'audio_deferred') {
      const r = await lohiApi(deps, 'POST', `/novel/agent/novels/${slug}/quality-verdict`, { body: { verdict: 'pass', score: v.score ?? 1, reason: v.reason || 'đạt', attempt: v.attempt ?? 1, from: v.from, to: v.to, ...(v.request_id ? { requestId: v.request_id } : {}) } });
      if (r.skipped) return setupNeed(deps, r.skipped);
      const status = r.out?.tts?.status;
      if (status === 'dispatched' || status === 'already_voiced') await set('audio', { tts: status });
      continue;
    }
    if (v.phase === 'audio') {
      const r = await lohiApi(deps, 'GET', `/novel/agent/novels/${slug}/quality-sample`, { query: { from: v.from, to: v.to } });
      if (r.skipped) return setupNeed(deps, r.skipped);
      const s = r.out?.summary;
      if (r.error || !s || !(s.sampled > 0) || s.audio < s.sampled) continue;
      const st = await postStage(deps, v.request_id, 'released', { note: `Có audio pro chương ${v.from}–${v.to}` });
      if (v.request_id && !st?.ok && st?.code !== 'stage_final') continue; // try again next tick
      await set('closing');
    }
    // Released: close the request, which is what tells everyone who voted or donated (the api's status event).
    if (v.phase === 'closing') {
      if (v.request_id) {
        const f = await lohiApi(deps, 'POST', `/novel/agent/requests/${v.request_id}/done`, { body: {} });
        if (f.error || f.skipped) continue; // closed next tick
        await recordOutcome(deps, v.request_id, { type: 'novel', outcome: 'done', novel_slug: slug, chapters: `${v.from}-${v.to}`, note: 'phát hành có audio pro' });
      }
      await set('released');
    }
  }
  for (const slug of woke) { const cur = await getState(store, KEY(slug)); if (cur) await setState(store, KEY(slug), { ...cur, woke_at: iso(now) }); }
  const released = moved.filter(m => m.phase === 'released').length;
  return { ok: true, open: active.length, moved, to_judge: toJudge, released, notify: woke.length > 0, wake: woke.length > 0 };
}
