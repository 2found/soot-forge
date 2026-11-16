// Curator tools over the Lohi api's agent_mod surface: the queues a person used to clear by hand (requests, reader
// edit suggestions, violation reports, enrichment) and the catalog checks (quality, duplicates, Litrans jobs).
// The api decides what is allowed; these tools only name the call, bound its size and keep findings.
import { fail, setupNeed, clearSetup, lohiApi, upsert, needCard, getState, setState, eq, iso, short } from './base.mjs';
import { postFailedStage, NO_SOURCE_NOTE } from './stage.mjs';
import { openJob, parseJobInput } from './jobs.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SLUG = /^[a-z0-9-]{1,100}$/;
export const clampInt = (v, lo, hi, d) => Math.min(Math.max(Math.trunc(Number(v)) || d, lo), hi);
export const needUuid = (v, name) => { if (!UUID.test(String(v ?? ''))) fail('invalid_request', `${name} must be a uuid.`); return String(v); };
export const oneOf = (v, list, name) => { if (!list.includes(v)) fail('invalid_request', `${name} is one of ${list.join(', ')}.`); return v; };

/** The api answer as a tool answer: a missing key is the quiet setup card, a refusal is a decided error. */
export async function call(deps, method, path, opts) {
  const r = await lohiApi(deps, method, path, opts);
  if (r.skipped) return { early: await setupNeed(deps, r.skipped) };
  if (r.error) return { early: { ok: false, error: { code: r.error.code, message: r.error.message, ...(r.error.status ? { status: r.error.status } : {}), ...(r.error.reason ? { reason: r.error.reason } : {}) } } };
  return { out: r.out, cleared: await clearSetup(deps, 'PRODUCT_AGENT_KEY', 'PRODUCT_API_URL') };
}
export const done = (body, cleared) => ({ ok: true, ...body, ...(cleared?.resolves_need ? { resolves_need: true } : {}) });

// ---------- requests ----------
const normTitle = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A request that reached the api's score and holds one of the day's onboard slots (`auto_onboard`, bs-kh1atl85 D3):
 * the score IS the approval, so the request is approved and its onboard job opened already approved, no card and no
 * model. One job per request whatever its state: the row stays on the api's list until the pipeline leaves
 * `onboarding`, so a request that already has a job here is left alone.
 */
async function autoOnboard(deps, it) {
  if (!deps.store) return null;
  const [had] = await deps.store.query('catalog_jobs', [eq('request_id', it.id)], { order: 'updated_at', limit: 1 });
  if (had) return { id: it.id, title: short(it.title, 80), action: 'auto_onboard', duplicate: true, job: { id: had.id, state: had.state } };
  const a = await lohiApi(deps, 'POST', `/novel/agent/requests/${it.id}/approve`, { body: {} });
  if (a.error || a.skipped || a.out?.autoOnboard !== true) return null;
  const job = parseJobInput(it.id, 'onboard', { title: it.title, source_url: it.source_url ?? '' });
  const opened = await openJob(deps, job, { approvedBy: 'policy:auto_onboard' });
  return { id: it.id, title: short(it.title, 80), action: 'auto_onboard', job: opened };
}

/**
 * Pending requests. Before a model sees them, the obvious cases are settled here (no wake): a `novel` request whose
 * novel is already published with chapters is attached to it and marked done; an exact duplicate title (accent and
 * case folded) merges into the first one, which is the paid one when there is one (the api sorts paid first); a
 * request that reached the auto-onboard score gets its onboard job, approved by the score (autoOnboard).
 * What is left is what needs judgment.
 */
export async function requests_pending(input, deps) {
  const type = input.type === undefined ? 'novel' : oneOf(input.type, ['novel', 'feature', 'audio', 'chapters', 'quality'], 'type');
  const r = await call(deps, 'GET', '/novel/agent/requests/pending', { query: { type, limit: clampInt(input.limit, 1, 50, 20), cursor: input.cursor } });
  if (r.early) return r.early;
  let items = r.out.items ?? [];
  const auto = [];
  if (type === 'novel' && input.auto_resolve !== false) {
    const left = [];
    const seen = new Map();
    for (const it of items) {
      const key = normTitle(it.title);
      // A request that earned its slot is never merged away: it is the score winner.
      if (key && seen.has(key) && !it.auto_onboard) {
        const m = await lohiApi(deps, 'POST', `/novel/agent/requests/${it.id}/merge`, { body: { targetId: seen.get(key) } });
        if (!m.error && !m.skipped) { auto.push({ id: it.id, title: short(it.title, 80), action: 'merge', into: seen.get(key) }); await recordOutcome(deps, it.id, { type, outcome: 'merged', note: `trùng ${seen.get(key)}` }); continue; }
      }
      const st = await lohiApi(deps, 'GET', '/novel/agent/novels', { query: { title: it.title } });
      const n = st.out;
      if (n?.exists && n.status === 'published' && n.chapterCount > 0 && n.slug && SLUG.test(n.slug)) {
        const a = await lohiApi(deps, 'POST', `/novel/agent/requests/${it.id}/attach-novel`, { body: { novelSlug: n.slug } });
        if (!a.error && !a.skipped) {
          await lohiApi(deps, 'POST', `/novel/agent/requests/${it.id}/done`, { body: {} });
          auto.push({ id: it.id, title: short(it.title, 80), action: 'attach', novel_slug: n.slug });
          await recordOutcome(deps, it.id, { type, outcome: 'attached', novel_slug: n.slug, note: 'truyện đã có trên Lohi' });
          continue;
        }
      }
      // A request that names no link and that nobody approved is never left pending for good: after a grace period it
      // ends `failed` / no_source with the note that asks the reader for a link (the api refunds and tells them).
      if (type === 'novel' && !it.source_url && !it.auto_onboard) {
        const ended = await askForSource(deps, it);
        if (ended) { auto.push(ended); continue; }
      }
      if (it.auto_onboard) {
        const settled = await autoOnboard(deps, it);
        if (settled) {
          auto.push(settled);
          if (key && !seen.has(key)) seen.set(key, it.id);
          continue;
        }
      }
      if (key) seen.set(key, it.id);
      left.push(it);
    }
    items = left;
  }
  const paid = items.filter(i => i.priority === 'paid');
  return done({ items, paid: paid.length, auto_resolved: auto, next_cursor: r.out.next_cursor ?? null, notify: items.length > 0 }, r.cleared);
}

/** How long a request with no link waits before the reader is asked for a link (stage needs_source, request still open). */
export const NEEDS_SOURCE_AFTER_H = 12;

/** How long after the ask the request waits for an answer before it ends failed / no_source (donors refunded). */
export const NO_SOURCE_FAIL_AFTER_H = 72;

/**
 * The no-link path of a request, two timeouts on the first-seen clock: after NEEDS_SOURCE_AFTER_H unapproved the api
 * is asked to move it to `needs_source` and tell the requester and supporters the message that asks for a link
 * (POST /requests/:id/ask — the request stays open, nothing is refunded); after NO_SOURCE_FAIL_AFTER_H from the
 * first sighting it ends `failed` / `no_source` and the donors are refunded. The outcome row is `needs_source` in
 * both cases. Returns null while it still waits.
 */
async function askForSource(deps, it) {
  const { store, now } = deps;
  if (!store) return null;
  const seen = (await getState(store, 'request_seen')) ?? {};
  const first = seen[it.id];
  if (!first) {
    seen[it.id] = iso(now);
    const keep = Object.entries(seen).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 200);
    await setState(store, 'request_seen', Object.fromEntries(keep));
    return null;
  }
  const waited = now - Date.parse(first);
  if (waited < NEEDS_SOURCE_AFTER_H * 3_600_000) return null;
  if (!seen[`${it.id}:asked`]) {
    const a = await lohiApi(deps, 'POST', `/novel/agent/requests/${it.id}/ask`, { body: { message: NO_SOURCE_NOTE } });
    // Not there yet on a prod api that still lacks the route: fall back to ending the request, which also tells the reader.
    const noAskRoute = a.error && a.error.code === 'not_found';
    if (!noAskRoute) {
      if (a.error && a.error.code !== 'unreachable' && a.error.code !== 'skipped' && a.error.code !== 'not_found' && a.error.code !== 'forbidden') {
        // A refused ask (a final stage) leaves the request to a person; a transient miss just waits for the next listing.
        if (a.error.code === 'failed' && a.error.reason === 'stage_final') { seen[`${it.id}:asked`] = iso(now); await setState(store, 'request_seen', seen); }
        else return null;
      }
      if (a.error && (a.error.code === 'unreachable' || a.error.code === 'skipped' || a.error.code === 'forbidden')) return null;
      seen[`${it.id}:asked`] = iso(now);
      await setState(store, 'request_seen', seen);
      await recordOutcome(deps, it.id, { type: 'novel', outcome: 'needs_source', note: 'không có link nguồn; đã hỏi người yêu cầu gửi link' });
      return { id: it.id, title: short(it.title, 80), action: 'needs_source' };
    }
  }
  if (waited < NO_SOURCE_FAIL_AFTER_H * 3_600_000 && seen[`${it.id}:asked`]) return null;
  const r = await postFailedStage(deps, it.id, { cause: 'no_source', note: NO_SOURCE_NOTE });
  if (r && !r.ok && r.code !== 'unreachable' && r.code !== 'skipped') return null; // the api refused (a final stage): leave it to a person
  await recordOutcome(deps, it.id, { type: 'novel', outcome: 'needs_source', note: 'không có link nguồn; đã hỏi người yêu cầu gửi link' });
  return { id: it.id, title: short(it.title, 80), action: 'needs_source' };
}

/** One row per request that left the queue: what happened and for which novel (the scoreboard reads it later). */
export async function recordOutcome(deps, requestId, { type, outcome, novel_slug = null, chapters = null, note = '' }) {
  if (!deps.store) return;
  await upsert(deps.store, 'request_outcomes', 'key', { key: String(requestId), type: type ?? null, outcome, novel_slug, chapters, note: short(note, 300), at: iso(deps.now) });
}

/**
 * approve | done (already published) | merge into an active request. Bookkeeping only: no reader sees a refusal.
 * Approving with `kind` (onboard | refresh) also opens the catalog job for the request (see openJob): a refresh of a
 * novel that exists starts approved, an onboard of a new novel waits for the daily Cần bạn card, unless the api
 * answers `autoOnboard` (the request reached the score and holds a day's slot): then the onboard starts approved too.
 */
export async function request_accept(input, deps) {
  const id = needUuid(input.id, 'id');
  const action = oneOf(input.action ?? 'approve', ['approve', 'done', 'merge'], 'action');
  if (action === 'merge') {
    const target = needUuid(input.target_id, 'target_id');
    if (target === id) fail('invalid_request', 'A request cannot merge into itself.');
    const r = await call(deps, 'POST', `/novel/agent/requests/${id}/merge`, { body: { targetId: target } });
    if (!r.early) await recordOutcome(deps, id, { type: input.type, outcome: 'merged', note: `trùng ${target}` });
    return r.early ?? done({ id, action }, r.cleared);
  }
  const kind = input.kind === undefined ? null : oneOf(input.kind, ['onboard', 'refresh'], 'kind');
  if (kind && action !== 'approve') fail('invalid_request', 'kind goes with action approve.');
  // Validate the job before the api moves the request: a bad job leaves the request pending.
  const job = kind ? parseJobInput(id, kind, input) : null;
  const r = await call(deps, 'POST', `/novel/agent/requests/${id}/${action}`, { body: {} });
  if (r.early) return r.early;
  if (action === 'done') await recordOutcome(deps, id, { type: input.type, outcome: 'done', novel_slug: input.novel_slug ?? null, note: short(input.note, 200) });
  const autoOnboarded = r.out?.autoOnboard === true;
  const opened = job ? await openJob(deps, job, autoOnboarded && kind === 'onboard' ? { approvedBy: 'policy:auto_onboard' } : {}) : null;
  return done({ id, action, ...(autoOnboarded ? { auto_onboard: true } : {}), ...(opened ? { job: opened } : {}) }, r.cleared);
}

/** Refusing a request is what the requester reads: a reason is required and an operator approves it. */
export async function request_reject(input, deps) {
  const id = needUuid(input.id, 'id');
  const reason = short(input.reason, 300);
  if (reason.length < 8) fail('invalid_request', 'reason is required (a sentence the requester can read).');
  const r = await call(deps, 'POST', `/novel/agent/requests/${id}/reject`, { body: { reason } });
  return r.early ?? done({ id, action: 'reject', reason }, r.cleared);
}

// ---------- reader edit suggestions ----------
export async function edits_pending(input, deps) {
  const r = await call(deps, 'GET', '/novel/agent/edit-queue', { query: { limit: clampInt(input.limit, 1, 50, 10), cursor: input.cursor, unreviewedOnly: input.unreviewed_only === false ? 'false' : 'true' } });
  return r.early ?? done({ items: r.out.items ?? [], next_cursor: r.out.nextCursor ?? null, notify: (r.out.items ?? []).length > 0 }, r.cleared);
}
export async function edits_context(input, deps) {
  const r = await call(deps, 'GET', `/novel/agent/edit-suggestions/${needUuid(input.id, 'id')}/context`);
  return r.early ?? done({ context: r.out }, r.cleared);
}
/** A verdict, never an accept: the api combines it with confidence and the submitter's trust (accept / reject / hand to a mod). */
export async function edit_verdict(input, deps) {
  const id = needUuid(input.id, 'id');
  const verdict = oneOf(input.verdict, ['accept', 'reject', 'unsure'], 'verdict');
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) fail('invalid_request', 'confidence is 0 to 100.');
  const reason = short(input.reason, 300);
  if (!reason) fail('invalid_request', 'reason is one short Vietnamese sentence.');
  const r = await call(deps, 'POST', `/novel/agent/edit-suggestions/${id}/verdict`, { body: { verdict, confidence: Math.round(confidence), reason } });
  return r.early ?? done({ id, result: r.out }, r.cleared);
}

// ---------- violation reports ----------
export async function violations_list(input, deps) {
  const status = input.status === undefined ? 'pending' : oneOf(input.status, ['pending', 'acknowledged'], 'status');
  const r = await call(deps, 'GET', '/novel/agent/violation-reports', { query: { status, limit: clampInt(input.limit, 1, 50, 20), offset: clampInt(input.offset, 0, 100000, 0) } });
  if (r.early) return r.early;
  const items = r.out.items ?? [];
  return done({ items, total: r.out.total ?? items.length, next_offset: r.out.next_offset ?? null, overdue: items.filter(i => i.overdue).length, notify: items.length > 0 }, r.cleared);
}
/** acknowledge, or dismiss a non-copyright report. Removing content or dismissing a copyright claim is a person's (the api refuses it too). */
export async function violation_resolve(input, deps) {
  const id = needUuid(input.id, 'id');
  const action = oneOf(input.action, ['acknowledge', 'dismiss'], 'action');
  const notes = short(input.notes, 500);
  if (!notes) fail('invalid_request', 'notes is required.');
  const r = await call(deps, 'POST', `/novel/agent/violation-reports/${id}/resolve`, { body: { action, notes } });
  return r.early ?? done({ id, action, status: r.out.status }, r.cleared);
}

// ---------- enrichment ----------
export async function enrichment_enqueue(input, deps) {
  const slug = String(input.slug ?? '');
  if (!SLUG.test(slug)) fail('invalid_request', 'slug is a novel slug (a-z, 0-9, -).');
  const r = await call(deps, 'POST', '/novel/agent/enrichment/novels', { body: { slug } });
  return r.early ?? done({ slug, queued: r.out.queued === true, job_status: r.out.job?.status ?? null }, r.cleared);
}

// ---------- catalog quality ----------
export async function quality_list(input, deps) {
  const problems = Array.isArray(input.problems) && input.problems.length ? input.problems.join(',') : undefined;
  const r = await call(deps, 'GET', '/admin/analysis/catalog-health', { query: { check: 'quality', limit: clampInt(input.limit, 1, 100, 50), cursor: input.cursor, problems } });
  if (r.early) return r.early;
  return done({ scanned: r.out.scanned ?? 0, items: r.out.items ?? [], next_cursor: r.out.next_cursor ?? null }, r.cleared);
}

// ---------- duplicates ----------
const pairKey = p => `dup:${[p.a.slug, p.b.slug].sort().join(':')}`;
export async function duplicates_scan(input, deps) {
  const { store, now } = deps;
  const pages = clampInt(input.pages, 1, 10, 3), limit = clampInt(input.limit, 1, 50, 25);
  const threshold = Math.min(Math.max(Number(input.threshold) || 0.8, 0.5), 1);
  const pairs = [];
  let cursor, scanned = 0, more = false;
  for (let i = 0; i < pages; i++) {
    const r = await call(deps, 'GET', '/admin/analysis/catalog-duplicates', { query: { threshold, limit, cursor, scope: input.scope === 'all' ? 'all' : 'published' } });
    if (r.early) return i === 0 ? r.early : { ...r.early, partial: pairs.length };
    pairs.push(...(r.out.items ?? []));
    scanned += r.out.scanned ?? 0;
    cursor = r.out.next_cursor;
    more = !!cursor;
    if (!cursor) break;
  }
  if (store) {
    for (const p of pairs) {
      const key = pairKey(p);
      const was = await store.one('findings', [{ column: 'key', op: 'eq', value: key }]);
      await upsert(store, 'findings', 'key', {
        key, check: 'duplicate', severity: p.similarity >= 0.95 ? 'high' : 'medium', subject: `${p.a.slug} ~ ${p.b.slug}`,
        detail: `${p.a.title} / ${p.b.title} (${p.basis} ${p.similarity})`, actionable: false, first_seen: was?.first_seen ?? iso(now), last_seen: iso(now),
      });
    }
  }
  return done({ scanned, more, next_cursor: cursor ?? null, pairs: pairs.slice(0, 50).map(p => ({ a: p.a, b: p.b, similarity: p.similarity, basis: p.basis })), more_pairs: Math.max(pairs.length - 50, 0) });
}

// ---------- Litrans jobs ----------
export async function litrans_health(input, deps) {
  const { store, now } = deps;
  const stalledSeconds = clampInt(input.stalled_seconds, 60, 3600, 300);
  const waitLimit = clampInt(input.queue_wait_minutes, 5, 1440, 60) * 60;
  const r = await call(deps, 'GET', '/admin/analysis/litrans-health', { query: { days: clampInt(input.days, 1, 14, 3), limit: clampInt(input.limit, 1, 50, 20), stalled_seconds: stalledSeconds, cursor: input.cursor } });
  if (r.early) return r.early;
  const h = r.out;
  const problems = [];
  if ((h.stalled_running ?? 0) > 0) problems.push({ key: 'litrans:stalled', line: `${h.stalled_running} job Litrans đang chạy nhưng không còn nhịp tim hơn ${Math.round(stalledSeconds / 60)} phút` });
  if ((h.oldest_queued_wait_seconds ?? 0) > waitLimit) problems.push({ key: 'litrans:queue', line: `Job Litrans chờ trong hàng đợi ${Math.round(h.oldest_queued_wait_seconds / 60)} phút (${h.counts?.queued ?? '?'} job đang chờ)` });
  const failed = h.failed ?? [];
  if (failed.length >= 3) problems.push({ key: 'litrans:failed', line: `${failed.length} job Litrans lỗi trong ${clampInt(input.days, 1, 14, 3)} ngày qua (vd ${failed[0].novel_slug ?? '?'}: ${short(failed[0].error, 80)})` });
  if (store) {
    for (const p of problems) {
      const was = await store.one('findings', [{ column: 'key', op: 'eq', value: p.key }]);
      await upsert(store, 'findings', 'key', { key: p.key, check: 'litrans', severity: 'high', subject: 'litrans', detail: p.line, actionable: true, first_seen: was?.first_seen ?? iso(now), last_seen: iso(now) });
    }
  }
  const card = store ? await needCard(store, 'litrans', {
    items: problems.map(p => p.key), summary: `Dịch Litrans có ${problems.length} điều cần xem`, lines: problems.map(p => `• ${short(p.line, 160)}`),
  }) : {};
  return done({ counts: h.counts, oldest_queued_wait_seconds: h.oldest_queued_wait_seconds ?? null, stalled_running: h.stalled_running ?? 0, failed, next_cursor: h.next_cursor ?? null, problems: problems.map(p => p.line), actionable: problems.length, ...card }, r.cleared);
}

// ---------- room reports the check could not judge (bs-kh1atl85 B11) ----------
/**
 * Room reports with no proposal (Lỗi dịch, Sai tên, Lặp đoạn, Đọc sai tên, or a chapter the check found healthy),
 * grouped by novel, kind and 10-chapter window with the number of distinct readers. Read-only: the curator decides
 * what to file (`chapter_retranslate`, a catalog job, or a person's line in the summary).
 */
export async function reports_open(input, deps) {
  const r = await call(deps, 'GET', '/novel/agent/content-reports/open', { query: { days: clampInt(input.days, 1, 14, 1), limit: clampInt(input.limit, 1, 50, 20) } });
  if (r.early) return r.early;
  const groups = (r.out.groups ?? []).map(g => ({
    novel_slug: g.novelSlug, novel_title: short(g.novelTitle, 80), kind: g.kind, from: g.fromChapter, to: g.toChapter, chapters: g.chapters,
    reporters: g.reporters, reports: g.reports, details: g.details, verdicts: g.verdicts, notes: (g.notes ?? []).map(n => short(n, 200)), last_at: g.lastAt,
  }));
  return done({ since: r.out.since ?? null, scanned: r.out.scanned ?? 0, truncated: r.out.truncated === true, groups, notify: groups.length > 0 }, r.cleared);
}
