// team_watch: read each open build's ticket with no model (`bbs ticket get status`, `bbs ticket get approval`).
// The autopilot session talks through the ticket: a pending approval record is its question to the founder (one Cần bạn
// card; the page answers it), status `in_review` is the build left uncommitted for a person to commit and ship, `blocked`
// is a session that stopped. Shipping is a person's: the page's "Đã phát hành" (or a ticket closed as `done`) is the
// outcome `requirement_shipped` (the Lead records it) and one `launch` topic for the marketing plan (CL3). A `queued`
// handoff starts once its checkout is free. Handoffs opened for bbs:team before this (they carry `team_id`) are no
// longer read; the page marks them shipped. Nothing changed answers {done: true}.
// Two sets are watched. `handoffs` this runtime started itself (the single-runtime path: it owns the whole lifecycle, the
// cards and the outcome) and `builds`, the rows of builds_pull on the runtime with the repo. A build is reported to the
// insight team as `handoff_events`, and what the founder decided on the insight team's page comes back the other way, read
// from its `handoffs` row: the answer to a question (written to the ticket here, where bbs is), "Đã phát hành", and a
// build given to a person. A build never records an outcome or a topic here, and raises only the reminder for a session
// that never started. One product (input, else SOOT_PRODUCT) watches only its own rows.
import { eq, inList, iso, short } from './base.mjs';
import { productId, scopeProduct, hostProduct } from './products.mjs';
import { insightTeam, pushEvents, shipped } from './build.mjs';
import { runBbs } from './bbs.mjs';
import { HOLDING, RESTARTED, isTicketId, startHandoff } from './handoff.mjs';
import { dataQuery, runtimeOf } from './runtime.mjs';
import { CARD, CARD_OF, unstartedCard, unstartedId } from './cards.mjs';

export { NUDGE_AFTER_MS } from './cards.mjs';

const OPEN = [...HOLDING, 'queued'];
export const STARTING = 'Phiên dựng đang đọc yêu cầu — chưa có việc cần bạn.';
const ASK = { spec: 'Xác nhận đặc tả', plan: 'Câu hỏi về kế hoạch' };
const VERDICT = ['approve', 'redirect', 'drop'];
/** How long a restarted session has to write its first status before the ticket's old `blocked` is believed again. */
export const RESTART_GRACE_MS = 15 * 60_000;

const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };

/** The build's state from its ticket: {state, detail, asked?}, or null when the session has not started. */
export function summarize(status, approval, released) {
  if (released || status === 'done') return { state: 'released', detail: 'Đã phát hành.' };
  if (approval?.state === 'pending') return { state: 'asking', detail: `${ASK[approval.kind] ?? 'Câu hỏi'}: ${short(approval.note || '(không có nội dung)', 500)}`, asked: String(approval.at ?? '') };
  if (approval?.state === 'dropped') return { state: 'dropped', detail: 'Bạn đã dừng việc này; phiên dựng không làm tiếp.' };
  if (status === 'in_review') return { state: 'delivered', detail: 'Đã dựng, review và QA xong; thay đổi nằm chưa commit trong kho mã. Bạn xem, commit và phát hành.' };
  if (status === 'blocked' || status === 'cancelled') return { state: 'blocked', detail: 'Phiên dựng đã dừng và chưa xong.' };
  if (status === 'in_progress') return { state: 'building', detail: 'Đang dựng và tự kiểm (review, QA).' };
  // An answered question or a written plan proves the session ran, even before it marks the ticket in progress.
  if (approval?.state || status === 'planned') return { state: 'building', detail: 'Đang lập kế hoạch.' };
  return null;
}

/** Write the founder's verdict to the ticket's approval record, as the bbs dashboard does: {ok} or {why}. */
export async function resolveApproval(env, h, action, note) {
  if (!VERDICT.includes(action) || !isTicketId(h.ticket)) return { why: 'câu trả lời không hợp lệ' };
  const r = await runBbs(env, ['ticket', 'approval', 'resolve', '--action', action, ...(note ? ['--note', note] : [])], { cwd: h.repo || undefined, ticket: h.ticket, timeoutMs: 30_000 });
  if (r.missing) return { why: 'máy này không có bbs' };
  return r.ok ? { ok: true } : { why: short(r.stderr || r.stdout, 140) || 'bbs không trả lời' };
}

/**
 * What the founder decided about a build on the insight team's page, applied here: {closed} when the build is no longer
 * this runtime's to watch (shipped, or given to a person), {unsent} when an answer could not be written to the ticket.
 */
async function applyDecision(b, deps, rt) {
  const { store, env, now } = deps;
  const got = await dataQuery(rt, insightTeam(env), 'handoffs', { filter: { opportunity: b.handoff }, limit: 1 });
  const h = got.rows?.find(r => r?.opportunity === b.handoff);
  if (!h) return {};
  if (h.state === 'released' || h.released_at) {
    // The founder said it is out: the checkout is free, and the insight team already knows.
    const at = Number.isFinite(Date.parse(h.released_at)) ? new Date(h.released_at).toISOString() : iso(now);
    await store.update('builds', b.id, { state: 'released', detail: 'Đã phát hành.', released_at: at, pushed: 'shipped', pushed_detail: 'Đã phát hành.' });
    return { closed: 'released' };
  }
  if (h.state === 'task') {
    // Given to a person: nothing more is read or reported; a ticket it opened keeps the checkout until the person is done.
    if (b.state !== 'task') await store.update('builds', b.id, { state: 'task', detail: 'Bạn đã giao việc này cho người.' });
    return { closed: b.state === 'task' ? null : 'task' };
  }
  if (b.state === 'task') return { closed: null }; // back with Soot: builds_pull starts it again
  // An answer is for one question: an older one never reaches a newer question.
  if (b.state !== 'asking' || h.state !== 'answered' || !h.answer || (h.answer_for ?? '') !== (b.asked ?? '')) return {};
  // The ticket may have moved since the last tick (answered at the bbs dashboard, a new question): the verdict is written
  // only while the question it answers is the one still pending.
  const cur = await runBbs(env, ['ticket', 'get', 'approval'], { cwd: b.repo || undefined, ticket: b.ticket, timeoutMs: 30_000 });
  if (cur.missing || !cur.ok) return { unsent: cur.missing ? 'máy này không có bbs' : short(cur.stderr, 140) || 'chưa đọc được ticket' };
  const pending = parseJson(cur.stdout);
  if (pending?.state !== 'pending' || String(pending.at ?? '') !== (h.answer_for ?? '')) return {};
  const r = await resolveApproval(env, b, h.answer, typeof h.answer_note === 'string' ? h.answer_note.trim() : '');
  return r.ok ? {} : { unsent: r.why };
}

export async function team_watch(input, deps) {
  const { store, env, now } = deps;
  const want = scopeProduct(input, env);
  const host = want ? await hostProduct(store, null) : null;
  const mine = r => !want || (productId(r.product) ?? host) === want;
  // A handoff folded from events (no repo of its own) belongs to the runtime that has the repo, never to this watch.
  const handoffs = (await store.query('handoffs', [inList('state', OPEN)], { order: 'updated_at', limit: 50 })).filter(h => h.repo && mine(h));
  const builds = (await store.query('builds', [inList('state', [...OPEN, 'task'])], { order: 'updated_at', limit: 50 })).filter(mine);
  const items = [
    ...handoffs.map(row => ({ row, table: 'handoffs', key: row.opportunity, build: false })),
    ...builds.map(row => ({ row, table: 'builds', key: row.handoff, build: true })),
  ];
  const changed = [], outcomes = [], raise = [], settle = [], unsent = [];
  const rt = builds.length ? runtimeOf(env, 'handoffs_unreadable') : { skip: true };
  const titleOf = async it => (it.build ? it.row.title : (await store.one('opportunities', [eq('ref', it.key)]))?.title) ?? it.key;
  const cardOf = it => ({ ...it.row, key: it.key });
  for (const it of items) {
    const h = it.row;
    if (it.build && !rt.skip) {
      const d = await applyDecision(h, deps, rt);
      if (d.unsent) unsent.push({ ref: it.key, why: d.unsent });
      if (d.closed) changed.push({ ref: it.key, state: d.closed });
      if (d.closed !== undefined) continue;
    }
    let s = null, read = false;
    if (h.released_at) s = summarize('', null, true);
    else if (h.team_id || h.state === 'queued' || h.state === 'task') continue;
    else if (isTicketId(h.ticket)) {
      const at = { cwd: h.repo || undefined, ticket: h.ticket, timeoutMs: 30_000 };
      const status = await runBbs(env, ['ticket', 'get', 'status'], at);
      const approval = status.missing ? status : await runBbs(env, ['ticket', 'get', 'approval'], at);
      if (!status.missing && (!status.ok || !approval.ok)) {
        const detail = `Chưa đọc được ticket ${h.ticket} (${short(status.stderr || approval.stderr, 100) || 'không có trả lời'}).`;
        if (detail !== h.detail) await store.update(it.table, h.id, { detail });
        continue;
      }
      if (!status.missing) { s = summarize(status.stdout.trim(), parseJson(approval.stdout), false); read = true; }
      // A session just started again on a ticket that had stopped: the old status stands until the new session writes its own.
      if (s?.state === 'blocked' && h.state === 'spawned' && h.detail === RESTARTED && now - Date.parse(h.updated_at ?? 0) < RESTART_GRACE_MS) continue;
    }
    if (!s) {
      // Not started (no ticket yet, bbs gone, or the session never ran): remind once, never fail the other builds.
      const card = h.state === 'draft_ready' ? unstartedCard(cardOf(it), await titleOf(it), now) : null;
      if (card) raise.push(card);
      if (!read || h.state !== 'spawned') continue;
      s = { state: 'starting', detail: STARTING };
    }
    const next = { ...h, ...s };
    if (!it.build && CARD[s.state]) raise.push(CARD[s.state]({ ...next, key: it.key }, await titleOf(it)));
    if (s.state === h.state && s.detail === h.detail && (s.asked ?? h.asked ?? null) === (h.asked ?? null)) continue;
    const left = s.state !== h.state ? CARD_OF[h.state] : null;
    if (left && (!it.build || left === unstartedId)) settle.push(left(cardOf(it)));
    await store.update(it.table, h.id, { state: s.state, detail: s.detail, ...(s.asked ? { asked: s.asked } : {}), ...(s.state === 'released' && !h.released_at ? { released_at: iso(now) } : {}) });
    if (s.state !== h.state) changed.push({ ref: it.key, state: s.state });
    if (s.state === 'released' && !it.build) outcomes.push(await shipped(store, it.key));
  }
  // A checkout that became free takes the oldest waiting Go; startHandoff keeps the rest queued. (A queued build is started by builds_pull.)
  const queued = handoffs.filter(h => h.state === 'queued' && !h.team_id).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  for (const h of queued) {
    const opp = await store.one('opportunities', [eq('ref', h.opportunity)]);
    const out = opp ? await startHandoff(opp, deps) : null;
    if (out && out.state !== 'queued') changed.push({ ref: h.opportunity, state: out.state });
  }
  // Builds tell the insight team where they stand (also the ones whose last report could not be sent).
  const sync = await pushEvents(deps, (await store.query('builds', [], { order: 'updated_at', limit: 100 })).filter(mine));
  const extra = { ...(sync.sent || sync.unsent ? { events: sync } : {}), ...(unsent.length ? { answers_unsent: unsent } : {}) };
  if (!changed.length && !raise.length && !settle.length && !sync.sent) return { done: true, ...(sync.unsent ? { events_unsent: sync.unsent } : {}), ...(unsent.length ? { answers_unsent: unsent } : {}) };
  const loud = outcomes.length > 0;
  return { changed, ...(outcomes.length ? { outcomes } : {}), ...(raise.length ? { raise } : {}), ...(settle.length ? { settle } : {}), ...extra, notify: loud, wake: loud };
}
