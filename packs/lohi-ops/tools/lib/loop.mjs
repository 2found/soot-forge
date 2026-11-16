// The request loop, end to end: the daily onboard card and its answer, the translation of the first batch,
// the one-chapter and support-action fixes with their re-check, and closing a request with an outcome.
// Every api call goes through the agent_mod routes, which hold the caps; these tools only name the call.
import { randomBytes } from 'node:crypto';
import { fail, lohiApi, setupNeed, getState, setState, upsert, needCard, eq, inList, ictDay, iso, short } from './base.mjs';
import { call, done, clampInt, needUuid, oneOf, SLUG, recordOutcome } from './curator.mjs';
import { FIRST_BATCH } from './jobs.mjs';
import { postFailedStage, postStage, retryFailedStages } from './stage.mjs';
import { awaitQuality } from './release.mjs';

const slugOf = v => { const s = String(v ?? ''); if (!SLUG.test(s)) fail('invalid_request', 'slug is a novel slug (a-z, 0-9, -).'); return s; };
const chapterOf = v => { const n = Math.trunc(Number(v)); if (!(n >= 1 && n <= 999999)) fail('invalid_request', 'chapter is a positive number.'); return n; };
const refusalOf = e => e?.reason ?? e?.code ?? 'failed';

// ---------- the daily onboard card ----------
/**
 * Onboarding a NEW novel is the one catalog write a person approves, once a day: every `requested` onboard job in ONE
 * card, with the copyright result where the builder already has one. Refresh jobs never come here.
 */
export async function onboard_card(input, deps) {
  const { store, now } = deps;
  // Only the schedule's own step may raise the card (the host sets event.source, a model cannot): a model's call (the
  // curator holds the grant the step needs) neither raises a card nor spends the day's slot.
  if (deps.event?.source !== 'schedule') return { ok: true, refused: 'schedule_only', note: 'The daily card is raised by the 09:00 schedule; nothing to do here.', notify: false, wake: false };
  const today = ictDay(now);
  const open = (await store.query('catalog_jobs', [eq('kind', 'onboard'), eq('state', 'requested')], { order: 'updated_at', desc: false, limit: 50 }));
  const last = await getState(store, 'onboard_card');
  const gone = last?.nonce && !open.length; // everything on the last card was decided elsewhere: close it
  if (!open.length) return { ok: true, pending: 0, notify: false, wake: false, ...(gone ? { settle: [last.card] } : {}) };
  if (last?.day === today && input.force !== true) return { ok: true, pending: open.length, carded_today: true, notify: false, wake: false };
  // Only a schedule step raises this card (the curator is not granted the tool), so the day is spent only by a raise.
  // The options run catalog_jobs_answer without a model: only the card's step may run it (the curator holds the grant the step needs), and it acts only on the jobs
  // stored here under this nonce, so the click on the card is the whole approval.
  const nonce = randomBytes(12).toString('hex');
  const ids = open.map(r => String(r.id));
  const cardId = `onboard:${today}:${nonce.slice(0, 8)}`;
  await setState(store, 'onboard_card', { day: today, card: cardId, nonce, ids, at: iso(now) });
  const lines = open.map(r => `• ${short(r.title ?? r.subject, 80)}${r.source_url ? ` (${short(r.source_url, 80)})` : ''}: bản quyền ${r.copyright ? short(r.copyright, 100) : 'sẽ kiểm trước khi đăng; trùng thì dừng, không đăng'}`);
  const answer = action => ({ pack: 'lohi-ops', name: 'catalog_jobs_answer', input: { action, nonce } });
  const raise = {
    id: cardId, group: 'onboard', title: `${open.length} truyện mới xin lên kệ hôm nay`, why: lines.join('\n').slice(0, 1400),
    options: [
      { id: 'approve', label: 'Duyệt tất cả', recommended: true, tool: answer('approve') },
      { id: 'decline', label: 'Từ chối tất cả', tool: answer('decline') },
      { id: 'later', label: 'Để sau' },
    ],
  };
  return { ok: true, pending: open.length, jobs: open.map(r => ({ id: r.id, title: r.title ?? null, request_id: r.request_id ?? null })), notify: false, wake: false, raise };
}

/**
 * The click on the daily card (an option's tool, never a model's call): approve or decline the jobs that card listed.
 * Not operator-gated, because the person pressing the button is the approval; it acts only on the ids stored with the
 * card's one-time nonce, so a model that guessed the tool name could neither approve anything else nor approve twice.
 */
export async function catalog_jobs_answer(input, deps) {
  const { store, now } = deps;
  // A card option runs as the schedule's own step (host-set event.source 'schedule'); the curator is granted the tool only
  // because that step needs the grant, and a model's call is refused here as well as by the one-time nonce.
  if (deps.event?.source !== 'schedule') return { ok: false, error: { code: 'card_only', message: 'Only the daily card runs this.' } };
  const action = oneOf(input.action, ['approve', 'decline'], 'action');
  const st = await getState(store, 'onboard_card');
  if (!st?.nonce || st.nonce !== String(input.nonce ?? '') || st.answered) return { ok: false, error: { code: 'card_expired', message: 'This card was already answered or replaced.' } };
  const rows = (await store.query('catalog_jobs', [inList('state', ['requested'])], { order: 'updated_at', limit: 200 })).filter(r => (st.ids ?? []).includes(String(r.id)));
  const changed = [];
  for (const r of rows) {
    await store.update('catalog_jobs', String(r.id), action === 'approve' ? { state: 'approved', approved_by: 'operator', at: iso(now) } : { state: 'declined', at: iso(now) });
    changed.push(String(r.id));
  }
  await setState(store, 'onboard_card', { ...st, answered: action, answered_at: iso(now) });
  return { ok: true, action, changed, notify: false, wake: false };
}

/** The person's answer to a card: approve or decline requested onboard jobs, or acknowledge a copyright stop. */
export async function catalog_jobs_decide(input, deps) {
  const { store, now } = deps;
  const action = oneOf(input.action, ['approve', 'decline', 'ack'], 'action');
  const ids = Array.isArray(input.ids) ? input.ids.map(String).slice(0, 50) : [];
  if (!ids.length) fail('invalid_request', 'ids lists the job ids on the card.');
  const rows = (await store.query('catalog_jobs', [inList('state', ['requested', 'blocked_copyright'])], { order: 'updated_at', limit: 200 })).filter(r => ids.includes(String(r.id)));
  const changed = [];
  for (const r of rows.length ? rows : []) {
    if (action === 'ack') { if (r.state === 'blocked_copyright') { await store.update('catalog_jobs', String(r.id), { acked: true }); changed.push(r.id); } continue; }
    if (r.state !== 'requested') continue;
    await store.update('catalog_jobs', String(r.id), action === 'approve' ? { state: 'approved', approved_by: 'operator', at: iso(now) } : { state: 'declined', at: iso(now) });
    changed.push(r.id);
  }
  return { ok: true, action, changed };
}

// ---------- translating the first batch ----------
const OPEN_PHASE = ['wanted', 'queued', 'pulling'];

/** Queue a translation by hand (beyond the first batch needs the readers served by the api). */
export async function translate_start(input, deps) {
  const { store, now } = deps;
  const slug = slugOf(input.slug);
  const from = chapterOf(input.from), to = chapterOf(input.to ?? input.from + FIRST_BATCH - 1);
  if (to < from || to - from + 1 > FIRST_BATCH) fail('invalid_request', `the range is at most ${FIRST_BATCH} chapters.`);
  if (input.beyond_first_batch === true) {
    const s = await call(deps, 'GET', `/novel/agent/novels/${slug}/litrans/status`);
    if (s.early) return s.early;
    if (!s.out.beyond_first_batch_allowed) return { ok: false, error: { code: 'not_enough_readers', message: `Needs ${s.out.readers_threshold} active readers; has ${s.out.active_readers}.` } };
  }
  const requestId = input.request_id ? needUuid(input.request_id, 'request_id') : null;
  const was = await store.one('translations', [eq('key', slug)]);
  if (was && OPEN_PHASE.includes(was.phase)) return { ok: true, duplicate: true, phase: was.phase };
  await upsert(store, 'translations', 'key', { key: slug, request_id: requestId, phase: 'wanted', from_chapter: from, to_chapter: to, job_id: null, detail: '', at: iso(now) });
  return { ok: true, queued: true, slug, from, to };
}

/** One tick of every open translation: ask, wait, pull, tell the requesters. No model. */
export async function translate_step(input, deps) {
  const { store, now } = deps;
  await retryFailedStages(deps);
  const rows = (await store.query('translations', [inList('phase', OPEN_PHASE)], { order: 'updated_at', desc: false, limit: clampInt(input.limit, 1, 20, 5) }));
  const moved = [];
  // Chapters that waited behind a batch the api could not be asked about at the time (status unreadable).
  for (const t of (await store.query('translations', [eq('phase', 'done')], { order: 'updated_at', desc: false, limit: 20 })).filter(r => r.rest_from)) await chainRest(deps, t);
  for (const t of rows) {
    const base = `/novel/agent/novels/${t.key}`;
    const set = async (phase, extra = {}) => { await store.update('translations', String(t.id), { phase, at: iso(now), ...extra }); moved.push({ slug: t.key, phase, ...(extra.detail ? { detail: extra.detail } : {}) }); };
    // A request whose translation stopped ends there (B5): the api refunds its donors and tells the readers why.
    const stop = async (detail) => {
      await set('failed', { detail });
      if (t.request_id) await postFailedStage(deps, t.request_id, { cause: 'failed', note: `Dịch chương ${t.from_chapter}–${t.to_chapter} chưa thành, người duyệt sẽ xem.` });
    };
    if (t.phase === 'wanted') {
      const r = await lohiApi(deps, 'POST', `${base}/translate`, { body: { from: t.from_chapter, to: t.to_chapter } });
      if (r.skipped) return setupNeed(deps, r.skipped);
      if (r.error) {
        if (r.error.status === 404 || r.error.status === 422) await stop(short(refusalOf(r.error), 120));
        continue; // 429 (caps) and 409 (a job is running) wait for the next tick
      }
      await set('queued', { job_id: r.out.job?.id ?? null });
    } else {
      const r = await lohiApi(deps, 'GET', `${base}/litrans/jobs/${t.job_id}`);
      if (r.skipped) return setupNeed(deps, r.skipped);
      if (r.error) { if (r.error.status === 404) await stop('job not found'); continue; }
      const st = r.out.job?.status;
      if (st === 'failed' || st === 'canceled') { await stop(short(r.out.job?.error ?? st, 120)); continue; }
      if (st !== 'done') continue;
      if (t.phase === 'queued') {
        const p = await lohiApi(deps, 'POST', `${base}/litrans/pull`, { body: { from: t.from_chapter, to: t.to_chapter } });
        if (p.error) { if (p.error.status !== 409) await stop(short(refusalOf(p.error), 120)); continue; }
        await set('pulling', { job_id: p.out.job?.id ?? null });
      } else {
        await set('done');
        // The first batch of a new novel from a request goes through the quality gate and gets its audio before
        // the request closes (release.mjs closes it at release); everything else is closed as translated now.
        if (await awaitQuality(deps, { slug: t.key })) {
          if (t.request_id) await postStage(deps, t.request_id, 'quality', { note: `Đã dịch chương ${t.from_chapter}–${t.to_chapter}, đang kiểm chất lượng` });
        } else if (t.request_id) await finishRequest(deps, t.request_id, 'translated', { novel_slug: t.key, chapters: `${t.from_chapter}-${t.to_chapter}`, type: 'chapters' });
        // Auto-ingested chapters (radar) are told to the readers once they are in Vietnamese: the room announcement
        // the cli skipped with --no-announce. Best-effort: a refusal never holds the next batch back.
        if (t.announce) {
          const chapterNumbers = Array.from({ length: t.to_chapter - t.from_chapter + 1 }, (_, i) => t.from_chapter + i);
          const a = await lohiApi(deps, 'POST', `/novel/agent/onboard/novels/${t.key}/chapters/announce`, { body: { chapterNumbers } });
          moved[moved.length - 1].announced = !a.error && !a.skipped;
        }
        await chainRest(deps, t);
      }
    }
  }
  // A translation that stopped is a card for a person (never a model wake): the novel, the range and why.
  const failedRows = (await store.query('translations', [eq('phase', 'failed')], { order: 'updated_at', limit: 20 })).filter(t => now - Date.parse(t.at ?? iso(now)) < FAILED_CARD_DAYS * 86_400_000);
  const card = await needCard(store, 'translations', {
    items: failedRows.map(t => String(t.key)), summary: `${failedRows.length} đợt dịch chưa thành`,
    lines: failedRows.map(t => `• ${t.key} chương ${t.from_chapter}–${t.to_chapter}: ${short(t.detail, 100)}`),
  });
  return { ok: true, open: rows.length, moved, notify: false, wake: false, ...(card.ask ? { ask: card.ask } : {}), ...(card.resolves_need ? { resolves_need: true } : {}) };
}
const FAILED_CARD_DAYS = 3;

/**
 * The batch just landed and more chapters wait behind it (a refresh that added up to 50): the next 10 are asked for
 * only when the api says the novel has the readers for it (beyond_first_batch_allowed). Otherwise the rest is dropped,
 * not retried: the api's bar is the policy, a novel that earns it later gets its chapters from the next radar find.
 */
async function chainRest(deps, t) {
  if (!t.rest_from || !t.rest_to || t.rest_to < t.rest_from) return;
  const { store, now } = deps;
  const s = await lohiApi(deps, 'GET', `/novel/agent/novels/${t.key}/litrans/status`);
  if (s.skipped || s.error) return; // asked again at the next tick: the row still holds the rest
  if (!s.out.beyond_first_batch_allowed) {
    await store.update('translations', String(t.id), { rest_from: null, rest_to: null, detail: short(`chương ${t.rest_from}–${t.rest_to} chờ đủ ${s.out.readers_threshold} độc giả`, 120), at: iso(now) });
    return;
  }
  const from = t.rest_from, to = Math.min(t.rest_to, from + FIRST_BATCH - 1);
  await store.update('translations', String(t.id), { phase: 'wanted', from_chapter: from, to_chapter: to, rest_from: to < t.rest_to ? to + 1 : null, rest_to: to < t.rest_to ? t.rest_to : null, job_id: null, detail: '', at: iso(now) });
}

// ---------- closing a request ----------
async function finishRequest(deps, id, outcome, extra) {
  const r = await lohiApi(deps, 'POST', `/novel/agent/requests/${id}/${outcome === 'translated' ? 'translated' : 'done'}`, { body: {} });
  if (r.error || r.skipped) return { ok: false, error: r.error ?? { code: 'skipped' } };
  await recordOutcome(deps, id, { type: extra.type, outcome, novel_slug: extra.novel_slug ?? null, chapters: extra.chapters ?? null, note: extra.note ?? '' });
  return { ok: true };
}

/** `done` (the novel or the chapters are up) or `translated` (the chapters are in Vietnamese): the api tells the requesters. */
export async function request_finish(input, deps) {
  const id = needUuid(input.id, 'id');
  const outcome = oneOf(input.outcome ?? 'done', ['done', 'translated'], 'outcome');
  const slug = input.novel_slug ? slugOf(input.novel_slug) : null;
  // A finished request names the novel it ended with: "done" with no novel is how a vague request got closed as served
  // (and its readers told so) in the live run; the refusal sends the model back to the skill instead.
  if (!slug) fail('invalid_request', 'A finished request names the novel (novel_slug). A request with no novel and no link is not finished: leave it, the pack asks the reader for a link.');
  const r = await finishRequest(deps, id, outcome, { type: input.type, novel_slug: slug, chapters: input.chapters, note: short(input.note, 200) });
  return r.ok ? { ok: true, id, outcome, requesters_notified: true } : { ok: false, error: r.error };
}

/** The person has seen a fix that could not be done by the pack: stop carding it. */
export async function fix_ack(input, deps) {
  const keys = Array.isArray(input.keys) ? input.keys.map(String).slice(0, 50) : [];
  if (!keys.length) fail('invalid_request', 'keys lists the action ids on the card.');
  let n = 0;
  for (const k of keys) n += await deps.store.update('fix_checks', [eq('key', k)], { acked: true });
  return { ok: true, acknowledged: n };
}

// ---------- fixes with a re-check ----------
const RECHECK_AFTER_MIN = 10, GIVE_UP_AFTER_H = 6;

export async function fixes_pull(input, deps) {
  const r = await call(deps, 'GET', '/novel/agent/support-actions', { query: { limit: clampInt(input.limit, 1, 50, 10) } });
  if (r.early) return r.early;
  const items = r.out.items ?? [];
  // Only a row the curator can run wakes a model: a wide one is a person's, and fix_recheck (scheduled, no model) cards it.
  // A review task (fix_chapter mode review) or a person's hold is not runnable as listed (WP7: fixes_run handles both).
  const runnable = items.filter(i => !i.wide && !i.needs_review && !i.needs_person).length;
  return done({ items, wide: items.filter(i => i.wide).length, runnable, notify: runnable > 0 }, r.cleared);
}

/**
 * A refusal the next pass clears by itself: a daily cap (429, reset at ICT midnight), a Litrans job still running for
 * the novel, or a support thread not yet handed over. The task stays pending in the api, so it is retried, never carded.
 */
const TRANSIENT_REASONS = new Set(['litrans_job_active', 'not_waiting_human']);
const transient = early => early?.error?.status === 429 || TRANSIENT_REASONS.has(early?.error?.reason);

const checkKind = (a, mode) => (a.kind === 'fix_chapter' && (mode ?? a.mode) === 'revoice' ? 'requeue_tts' : a.kind);

/** Run one listed item through the api's execute (its review and caps); record the re-check or the refusal. */
async function executeListed(deps, a) {
  const { store, now } = deps;
  const { from } = spanOf(a.params ?? {});
  const base = { key: a.id, kind: checkKind(a), novel_slug: a.params?.novelSlug ?? null, chapter: from };
  const r = await call(deps, 'POST', `/novel/agent/support-actions/${a.id}/execute`, { body: {} });
  if (r.early) {
    const why = r.early.error?.reason ?? r.early.error?.code;
    if (transient(r.early)) return { id: a.id, executed: false, retry: why ?? 'later' };
    if (why) await upsert(store, 'fix_checks', 'key', { ...base, state: 'refused', detail: short(why, 80), at: iso(now) });
    return { id: a.id, executed: false, refused: why ?? 'failed' };
  }
  // A re-voice that started some chapters and not others settles executed; the rest is a person's card now.
  const missed = Array.isArray(r.out.result?.failed) ? r.out.result.failed.map(f => f?.chapterNumber).filter(Number.isInteger) : [];
  if (missed.length) {
    await upsert(store, 'fix_checks', 'key', { ...base, state: 'failed', detail: short(`chưa tạo lại chương ${missed.join(', ')}`, 80), at: iso(now) });
    return { id: a.id, executed: true, status: r.out.status ?? null, missed };
  }
  await upsert(store, 'fix_checks', 'key', { ...base, state: 'pending_recheck', detail: '', started_at: iso(now), at: iso(now) });
  return { id: a.id, executed: true, status: r.out.status ?? null };
}

/**
 * The scheduled fix pass (WP7, no model): every pending task the api will run as it stands (a re-crawl, a re-voice, a
 * reader-quoted replacement inside the api's bounds) is executed here, within the api's caps. Only a review task
 * (fix_chapter mode review: a report the automatic check could not judge) wakes the model, once per task; a wide scope
 * or a person's hold is carded by fix_recheck.
 */
export async function fixes_run(input, deps) {
  const { store, now } = deps;
  const r = await call(deps, 'GET', '/novel/agent/support-actions', { query: { limit: clampInt(input.limit, 1, 50, 20) } });
  if (r.early) return r.early;
  const ran = [], to_review = [];
  for (const a of r.out.items ?? []) {
    if (a.wide || a.needs_person) continue;
    const seen = await store.one('fix_checks', [eq('key', a.id)]);
    // A review task a later reader's exact quote turned runnable (api joinPendingAction) runs now, not after the 6h give-up.
    if (seen && !(seen.state === 'reviewing' && !a.needs_review)) continue;
    if (a.needs_review) {
      const { from } = spanOf(a.params ?? {});
      await upsert(store, 'fix_checks', 'key', { key: a.id, kind: a.kind, novel_slug: a.params?.novelSlug ?? null, chapter: from, state: 'reviewing', detail: '', started_at: iso(now), at: iso(now) });
      to_review.push({ id: a.id, issue: a.params?.issue ?? null, novel_slug: a.params?.novelSlug ?? null, chapter: from, reporter_count: a.reporter_count ?? 1 });
      continue;
    }
    ran.push(await executeListed(deps, a));
  }
  return done({ ran, to_review, notify: to_review.length > 0 }, r.cleared);
}

/** A review task, for the judgement: the issue, Lạc Phong's summary, how many readers, the chapter text. Never who. */
export async function fix_context(input, deps) {
  const id = needUuid(input.id, 'id');
  const r = await call(deps, 'GET', `/novel/agent/support-actions/${id}/context`);
  if (r.early) return r.early;
  return done(r.out, r.cleared);
}

const RESOLVE_OUTCOMES = ['replace', 'revoice', 'recrawl', 'not_reproduced', 'needs_person'];

/**
 * Catalog Exec's decision on a review task: the concrete fix it found (a verbatim quote from the chapter and its
 * replacement, a re-voice or a re-crawl; the api reviews and runs it within its caps), not reproduced (closed; Lạc Phong
 * tells the readers), or needs_person (a card). Lạc Phong tells every reporter when the task settles.
 */
export async function fix_resolve(input, deps) {
  const { store, now } = deps;
  const id = needUuid(input.id, 'id');
  const outcome = oneOf(input.outcome, RESOLVE_OUTCOMES, 'outcome');
  const reason = short(input.reason, 300);
  if (!reason || reason.length < 3) fail('invalid_request', 'reason says in one Vietnamese sentence why.');
  const body = { outcome, reason };
  if (outcome === 'replace') {
    if (typeof input.find !== 'string' || !input.find || typeof input.replace !== 'string') fail('invalid_request', 'replace needs find (verbatim from the chapter) and replace.');
    Object.assign(body, { find: input.find, replace: input.replace });
    if (input.expect_occurrences !== undefined) body.expectOccurrences = clampInt(input.expect_occurrences, 1, 3, 1);
    if (input.summary) body.summary = short(input.summary, 300);
  }
  const r = await call(deps, 'POST', `/novel/agent/support-actions/${id}/resolve`, { body });
  const prior = await store.one('fix_checks', [eq('key', id)]);
  const base = { key: id, kind: outcome === 'revoice' ? 'requeue_tts' : 'fix_chapter', novel_slug: prior?.novel_slug ?? null, chapter: prior?.chapter ?? null };
  if (r.early) {
    const why = r.early.error?.reason ?? r.early.error?.code;
    // A cap or a running Litrans job: the task is still pending and still under review; resolve it again later.
    if (transient(r.early)) return r.early;
    if (why) await upsert(store, 'fix_checks', 'key', { ...base, state: 'refused', detail: short(why, 80), at: iso(now) });
    return r.early;
  }
  const state = outcome === 'not_reproduced' ? 'closed' : outcome === 'needs_person' ? 'refused' : 'pending_recheck';
  await upsert(store, 'fix_checks', 'key', { ...base, state, detail: outcome === 'needs_person' ? short(reason, 80) : '', started_at: iso(now), at: iso(now) });
  return done({ id, outcome, status: r.out.status ?? null }, r.cleared);
}

const spanOf = p => { const from = p.fromChapter ?? p.chapterNumber ?? null; return { from, to: p.toChapter ?? from }; };

/** Run one pending support action within the api's caps; a wide one goes to a person, the rest is re-checked later. */
export async function fix_execute(input, deps) {
  const { store, now } = deps;
  const id = needUuid(input.id, 'id');
  const list = await call(deps, 'GET', '/novel/agent/support-actions', { query: { limit: 50 } });
  if (list.early) return list.early;
  const a = (list.out.items ?? []).find(i => i.id === id);
  if (!a) return { ok: false, error: { code: 'not_pending', message: 'No pending support action with this id.' } };
  const { from } = spanOf(a.params ?? {});
  if (a.wide) {
    await upsert(store, 'fix_checks', 'key', { key: id, kind: a.kind, novel_slug: a.params?.novelSlug ?? null, chapter: from, state: 'wide', detail: `${a.chapters} chương`, at: iso(now) });
    return { ok: true, executed: false, wide: true, chapters: a.chapters, notify: false, wake: false };
  }
  const r = await call(deps, 'POST', `/novel/agent/support-actions/${id}/execute`, { body: {} });
  if (r.early) {
    // Any refusal or failed run (cap, not_recrawlable, execute_failed) is a person's card: the reader was told the team looks next.
    const why = r.early.error?.reason ?? r.early.error?.code;
    if (why) await upsert(store, 'fix_checks', 'key', { key: id, kind: a.kind, novel_slug: a.params?.novelSlug ?? null, chapter: from, state: 'refused', detail: short(why, 80), at: iso(now) });
    return r.early;
  }
  await upsert(store, 'fix_checks', 'key', { key: id, kind: a.kind, novel_slug: a.params?.novelSlug ?? null, chapter: from, state: 'pending_recheck', detail: '', started_at: iso(now), at: iso(now) });
  return done({ id, executed: true, kind: a.kind, status: r.out.status ?? null }, r.cleared);
}

/** One-chapter fixes the curator starts itself. */
export async function chapter_retranslate(input, deps) {
  const slug = slugOf(input.slug), chapter = chapterOf(input.chapter);
  const r = await call(deps, 'POST', `/novel/agent/novels/${slug}/chapters/${chapter}/retranslate`, { body: {} });
  if (r.early) return r.early;
  await upsert(deps.store, 'fix_checks', 'key', { key: `retranslate:${slug}:${chapter}`, kind: 'retranslate', novel_slug: slug, chapter, state: 'pending_recheck', detail: '', started_at: iso(deps.now), at: iso(deps.now) });
  return done({ slug, chapter, remaining: r.out.remaining ?? null }, r.cleared);
}
export async function chapter_tts(input, deps) {
  const slug = slugOf(input.slug), chapter = chapterOf(input.chapter);
  const voice = short(input.voice_id, 100);
  if (!voice) fail('invalid_request', 'voice_id is the voice the audio used (see the chapter health).');
  const r = await call(deps, 'POST', `/novel/agent/novels/${slug}/chapters/${chapter}/tts`, { body: { voiceId: voice } });
  if (r.early) return r.early;
  await upsert(deps.store, 'fix_checks', 'key', { key: `tts:${slug}:${chapter}`, kind: 'requeue_tts', novel_slug: slug, chapter, state: 'pending_recheck', detail: '', started_at: iso(deps.now), at: iso(deps.now) });
  return done({ slug, chapter, remaining: r.out.remaining ?? null }, r.cleared);
}

/**
 * Look again at what was fixed: a pass is closed (the api told the reader when the action settled: a line in their support
 * DM, or the room line for a room report), a fail or a wide scope is ONE card. A wide pending action nobody ran is carded
 * here too, so fixes_pull never wakes a model for it.
 */
export async function fix_recheck(input, deps) {
  const { store, now } = deps;
  const queue = await lohiApi(deps, 'GET', '/novel/agent/support-actions', { query: { limit: 50 } });
  if (!queue.skipped && !queue.error) {
    for (const a of (queue.out.items ?? []).filter(i => i.wide || i.needs_person)) {
      if (await store.one('fix_checks', [eq('key', a.id)])) continue;
      const hold = a.wide ? { state: 'wide', detail: `${a.chapters} chương` } : { state: 'refused', detail: short(a.hold ?? 'needs_person', 80) };
      await upsert(store, 'fix_checks', 'key', { key: a.id, kind: a.kind, novel_slug: a.params?.novelSlug ?? null, chapter: spanOf(a.params ?? {}).from, ...hold, at: iso(now) });
    }
  }
  // A review task the model has not resolved in GIVE_UP_AFTER_H is a person's card.
  for (const f of await store.query('fix_checks', [eq('state', 'reviewing')], { order: 'updated_at', desc: false, limit: 50 })) {
    if (now - Date.parse(f.started_at ?? f.at ?? iso(now)) > GIVE_UP_AFTER_H * 3_600_000) await store.update('fix_checks', String(f.id), { state: 'refused', detail: 'chưa soát xong', at: iso(now) });
  }
  const rows = await store.query('fix_checks', [inList('state', ['pending_recheck', 'wide', 'refused', 'failed'])], { order: 'updated_at', desc: false, limit: 50 });
  const passed = [];
  for (const f of rows) {
    if (f.state !== 'pending_recheck') continue;
    const age = now - Date.parse(f.started_at ?? f.at ?? iso(now));
    if (age < RECHECK_AFTER_MIN * 60_000 || !f.novel_slug || !f.chapter) continue;
    const r = await lohiApi(deps, 'GET', `/novel/agent/novels/${f.novel_slug}/chapters/${f.chapter}/health`);
    if (r.skipped) return setupNeed(deps, r.skipped);
    if (r.error) continue;
    const items = r.out.health?.items ?? [];
    const bad = items.find(i => i.number === f.chapter) ?? null;
    const defect = f.kind === 'requeue_tts' ? (bad && bad.audio !== 'ok' && bad.audio !== 'none' ? bad.audio : null) : (bad && bad.body !== 'ok' ? bad.body : null);
    if (!defect) { await store.update('fix_checks', String(f.id), { state: 'passed', at: iso(now) }); passed.push({ slug: f.novel_slug, chapter: f.chapter, kind: f.kind }); }
    else if (age > GIVE_UP_AFTER_H * 3_600_000) await store.update('fix_checks', String(f.id), { state: 'failed', detail: short(defect, 80), at: iso(now) });
  }
  const open = (await store.query('fix_checks', [inList('state', ['wide', 'refused', 'failed'])], { order: 'updated_at', limit: 20 })).filter(f => !f.acked);
  const card = await needCard(store, 'fixes', {
    items: open.map(f => String(f.key)), summary: `${open.length} việc sửa chương cần bạn xem`,
    lines: open.map(f => `• ${f.novel_slug ?? '?'} chương ${f.chapter ?? '?'} (${f.kind}): ${f.state === 'wide' ? `phạm vi rộng ${f.detail}` : f.state === 'failed' ? `đã sửa nhưng vẫn lỗi (${f.detail})` : `api từ chối (${f.detail})`}`),
  });
  return { ok: true, passed, needs_person: open.length, notify: false, wake: false, ...(card.ask ? { ask: card.ask } : {}), ...(card.resolves_need ? { resolves_need: true } : {}) };
}
