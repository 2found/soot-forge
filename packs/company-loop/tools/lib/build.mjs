// The two halves of the product handoff that live on different runtimes.
//
// The server (no project for the product) records a founder's Go as an `approved` handoff that carries the requirement
// (handoff.mjs). The runtime that has the repo (a Mac with PRODUCT_REPOS and bbs) pulls it, `builds_pull`, writes the
// requirement beside the tickets, opens the ticket and starts its autopilot session exactly as a local Go does, keeps its own
// `builds` row, and reports back through the insight team's insert-only queue `handoff_events` (started, queued, progress,
// asking, stopped, handover, shipped, dropped). `handoff_events_apply` on the server folds those events into `handoffs`,
// raises the founder's cards and closes what they marked shipped. The founder answers on the server's page; the answer
// waits on the handoff row (`answer`, `answer_note`, `answer_for`) and team_watch on the Mac writes it to the ticket. The
// server never waits on the Mac and never reaches it: the Mac pulls. The founder's Go is the only approval to build;
// pulling adds none, and nothing here commits, lands, releases, integrates or seals.
import { eq, getState, gte, inList, iso, setState, short, skippedFor } from './base.mjs';
import { dataQuery, dataInsert, runtimeOf } from './runtime.mjs';
import { buildsHere, hasBuild, holderOf, HOLDING, launchBuild } from './handoff.mjs';
import { productId, scopeProduct } from './products.mjs';
import { queueTopic } from './opportunities.mjs';
import { CARD, CARD_OF, askGroup } from './cards.mjs';

const REF = /^OP-[0-9A-F]{8}$/;
const TEAM = /^[a-z][a-z0-9_-]{0,47}$/;
/** The team that owns `handoffs` and the `handoff_events` queue (default `insight`). */
export const insightTeam = env => (TEAM.test(String(env.INSIGHT_TEAM ?? '')) ? env.INSIGHT_TEAM : 'insight');

/** A build's local state -> the event the insight team is told about (draft_ready: the session does not exist yet, nothing to say). */
export const EVENT_OF = { queued: 'queued', spawned: 'started', starting: 'started', building: 'progress', asking: 'asking', blocked: 'stopped', delivered: 'handover', released: 'shipped', dropped: 'dropped' };
/** An event -> the handoff state the server shows (`failed` is what older builds wrote for a team that broke). */
export const HANDOFF_OF = { queued: 'queued', started: 'spawned', progress: 'building', asking: 'asking', stopped: 'blocked', handover: 'delivered', shipped: 'released', dropped: 'dropped', failed: 'blocked' };
/** Events told again when what they say changed: a new question, a new line of progress. */
const RETOLD = ['progress', 'asking'];
/** Handoff states no event moves: shipped, stopped by the founder, or given to a person (the person closes it). */
const CLOSED = ['released', 'dropped', 'task'];

/** A shipped requirement: one launch topic for the marketing plan, and the outcome the Lead records. */
export async function shipped(store, ref) {
  const opp = await store.one('opportunities', [eq('ref', ref)]);
  if (opp) await queueTopic(store, opp, 'launch', `Tính năng mới đã ra: ${opp.title}`, opp.query || opp.title);
  return { id: 'requirement_shipped', count: 1, ref: `req:${ref}` };
}

const unreadable = (reason_code, detail) => ({ ok: true, skipped: true, reason_code, reason: 'data_failed', ...(detail ? { detail: short(detail, 200) } : {}), notify: false, wake: false });

async function upsertBuild(store, key, set) {
  const row = await store.one('builds', [eq('handoff', key)]);
  if (row) { await store.update('builds', row.id, set); return { ...row, ...set }; }
  const id = await store.insert('builds', { handoff: key, ...set });
  return { id, handoff: key, ...set };
}

/**
 * Tell the insight team where each build stands: one `handoff_events` row per change (a `progress` row again only when its
 * detail changed). A row that could not be sent stays unsent (`pushed` behind `state`) and goes out on the next call.
 * {sent, unsent}. Without a runtime token nothing is sent and every pending row counts as unsent.
 */
export async function pushEvents(deps, rows, rt = runtimeOf(deps.env, 'events_unsendable')) {
  const { store, env, now } = deps;
  let sent = 0, unsent = 0;
  for (const b of rows) {
    const ev = EVENT_OF[b.state];
    // A question is told again when it is a new one, even with the same words.
    const detail = ev === 'asking' ? `${b.asked ?? ''} ${b.detail ?? ''}` : b.detail ?? null;
    if (!ev || (b.pushed === ev && (!RETOLD.includes(ev) || (b.pushed_detail ?? null) === detail))) continue;
    if (rt.skip) { unsent++; continue; }
    const row = { handoff: b.handoff, state: ev, ticket: b.ticket ?? null, asked: ev === 'asking' ? b.asked ?? '' : null, url: b.url ?? null, note: short(b.detail || b.note || '', 600) || null, at: iso(now), product: productId(b.product) };
    const r = await dataInsert(rt, insightTeam(env), 'handoff_events', row);
    if (r.error) { unsent++; continue; }
    await store.update('builds', b.id, { pushed: ev, pushed_detail: detail });
    sent++;
  }
  return { sent, unsent };
}

/**
 * builds_pull (the runtime with the repo): approved handoffs of the insight team that no local build covers yet, and the
 * ones waiting here for their checkout (`queued`). One product (input, else SOOT_PRODUCT; its PRODUCT_REPO comes from the
 * product's env overlay) or every one when none is named. A build is started again only when the founder sent it back:
 * "Chạy lại" on one that stopped, "Để Soot dựng" on one given to a person; it continues the same ticket. A build that could
 * not start and left no command to run by hand (`draft_ready`: no bbs, no ticket, an agent bbs refused) is tried on every pull.
 * Tool-only, no model, no approval of its own.
 */
const again = (had, state) => !had || ['no_repo', 'queued'].includes(had.state)
  // A draft with no command to run (no bbs, no ticket, an agent bbs refused) is tried again by itself: nobody could have started it by hand.
  || (had.state === 'draft_ready' && !had.command)
  || (state === 'approved' && (had.state === 'task' || (had.state === 'blocked' && had.pushed === 'stopped')));
export async function builds_pull(input, deps) {
  const { store, env } = deps;
  if (!hasBuild(env)) return skippedFor('PRODUCT_REPO');
  const rt = runtimeOf(env, 'handoffs_unreadable');
  if (rt.skip) return rt.skip;
  const want = scopeProduct(input, env);
  const rows = [], seen = new Set();
  for (const state of ['approved', 'queued']) {
    const got = await dataQuery(rt, insightTeam(env), 'handoffs', { filter: { state, ...(want ? { product: want } : {}) }, limit: 50 });
    if (got.error) return unreadable('handoffs_unreadable', got.error);
    for (const r of got.rows) if (!seen.has(r?.opportunity)) { seen.add(r?.opportunity); rows.push(r); }
  }
  // The oldest Go first: it takes a free checkout, the rest wait their turn.
  rows.sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')));
  const started = [], skipped = [], failed = [];
  for (const h of rows) {
    const key = h?.opportunity;
    const product = productId(h?.product);
    const requirement = typeof h?.requirement === 'string' ? h.requirement : '';
    if (typeof key !== 'string' || !REF.test(key)) { skipped.push({ why: 'bad_key' }); continue; }
    // A repo belongs to one product: a row of another product, or one that is not approved, is never built here.
    if ((want && product !== want) || !buildsHere(env, product)) { skipped.push({ handoff: key, why: 'other_product' }); continue; }
    if (h.state !== 'approved' && h.state !== 'queued') { skipped.push({ handoff: key, why: 'not_approved' }); continue; }
    if (!requirement.startsWith('# REQ-') || requirement.length > 20_000) { skipped.push({ handoff: key, why: 'bad_requirement' }); continue; }
    const had = await store.one('builds', [eq('handoff', key)]);
    if (!again(had, h.state)) { skipped.push({ handoff: key, why: 'already_pulled' }); continue; }
    const out = await launchBuild({ ref: key, requirement, product, ticket: had?.ticket ?? null }, { env, holder: repo => holderOf(store, repo, key) });
    const title = short((/^# REQ-OP-[0-9A-F]{8}: (.+)$/m.exec(requirement) ?? [])[1] ?? key, 140);
    // Still waiting for the same checkout, or still not startable for the same reason: nothing new to keep or to tell
    // (and the reminder for a build that never started keeps counting from the first try).
    if (out.state === 'queued' && had?.state === 'queued') { skipped.push({ handoff: key, why: 'checkout_busy' }); continue; }
    if (out.state === 'draft_ready' && had?.state === 'draft_ready' && out.note === had.note) { skipped.push({ handoff: key, why: 'not_ready' }); continue; }
    const row = await upsertBuild(store, key, { product, title, ...out, asked: null, released_at: null, pushed: null, pushed_detail: null });
    if (out.state === 'no_repo') { failed.push({ handoff: key, why: 'no_repo', note: out.note }); continue; }
    started.push({ handoff: key, state: out.state });
    await pushEvents(deps, [row], rt);
  }
  if (!started.length && !failed.length) return { done: true, ...(skipped.length ? { skipped } : {}) };
  // A repo that cannot be written is a setup problem a person must fix; a started or drafted build is quiet (the Mac watches it).
  const loud = failed.length > 0;
  return { started, failed, skipped, notify: loud, wake: loud };
}

/**
 * handoff_events_apply (the runtime that decided): fold the `handoff_events` queue into `handoffs`, in order, each event
 * once. A handoff that is shipped, dropped or with a person is not moved. A question (`asking`) waits for the founder's
 * answer on the page; the same question is not asked again while its answer is on the way to the workshop. Then the
 * founder's side of a build the workshop runs: "Đã phát hành" on the page (or a `shipped` event) records
 * `requirement_shipped` and queues the launch topic once, as a local release would, and each thing owed is one Cần bạn card
 * (a question, a build to commit and ship, a session that stopped), settled when the handoff moves on.
 * The queue is insert-only, so progress is a cursor in `state` plus the ids already folded at that instant.
 */
export async function handoff_events_apply(input, deps) {
  const { store, now } = deps;
  const want = scopeProduct(input, deps.env);
  const cursor = await getState(store, 'events_cursor');
  const done = new Set((await getState(store, 'events_done')) ?? []);
  const events = await store.query('handoff_events', cursor ? [gte('created_at', cursor)] : [], { order: 'created_at', desc: false, limit: 200 });
  const changed = [], outcomes = [], skipped = [], raise = [], settle = [];
  const cardOf = h => ({ ...h, key: h.opportunity });
  for (const ev of events) {
    if (done.has(ev.id)) continue;
    const mapped = HANDOFF_OF[ev.state];
    const h = typeof ev.handoff === 'string' ? await store.one('handoffs', [eq('opportunity', ev.handoff)]) : null;
    if (!mapped || !h) { skipped.push({ handoff: ev.handoff ?? null, why: !mapped ? 'bad_state' : 'unknown_handoff' }); continue; }
    if (ev.product && h.product && ev.product !== h.product) { skipped.push({ handoff: h.opportunity, why: 'other_product' }); continue; }
    if (want && productId(h.product) !== want) continue;
    // Closed, or marked shipped by the founder and about to close: the build runtime's events no longer move it.
    if (CLOSED.includes(h.state) || h.released_at) continue;
    const asked = mapped === 'asking' ? String(ev.asked ?? '') : null;
    if (mapped === 'asking' && h.state === 'answered' && (h.answer_for ?? '') === asked) continue;
    const at = Number.isFinite(Date.parse(ev.at)) ? new Date(ev.at).toISOString() : iso(now);
    const note = ev.note ? short(ev.note, 600) : null;
    const set = { state: mapped, ticket: ev.ticket || h.ticket || null, detail: ev.state === 'failed' ? short(`Phiên dựng báo lỗi: ${note ?? 'không rõ'}`, 300) : note ?? h.detail ?? null,
      ...(mapped === 'queued' && note ? { note } : {}), ...(mapped === 'asking' ? { asked, answer: null, answer_note: null, answer_for: null } : {}),
      ...(ev.url ? { url: short(ev.url, 300) } : {}), ...(mapped === 'released' ? { released_at: at } : {}) };
    if (set.state === h.state && set.detail === h.detail && set.ticket === (h.ticket ?? null) && (asked ?? h.asked ?? null) === (h.asked ?? null) && !set.url) continue;
    await store.update('handoffs', h.id, set);
    if (mapped !== h.state && CARD_OF[h.state]) settle.push(CARD_OF[h.state](cardOf(h)));
    changed.push({ ref: h.opportunity, state: mapped });
    if (mapped === 'released') outcomes.push(await shipped(store, h.opportunity));
  }
  if (events.length) {
    const last = events[events.length - 1].created_at;
    await setState(store, 'events_cursor', last);
    await setState(store, 'events_done', events.filter(e => e.created_at === last).map(e => e.id));
  }
  // The founder's side of every build the workshop runs (a handoff with no repo of its own here).
  const open = (await store.query('handoffs', [inList('state', [...HOLDING, 'queued'])], { order: 'updated_at', limit: 100 })).filter(h => !h.repo && (!want || productId(h.product) === want));
  for (const h of open) {
    if (h.released_at) {
      await store.update('handoffs', h.id, { state: 'released', detail: 'Đã phát hành.' });
      if (CARD_OF[h.state]) settle.push(CARD_OF[h.state](cardOf(h)));
      changed.push({ ref: h.opportunity, state: 'released' });
      outcomes.push(await shipped(store, h.opportunity));
      continue;
    }
    if (h.state === 'answered') { settle.push(askGroup(cardOf(h))); continue; }
    if (!CARD[h.state]) continue;
    const title = (await store.one('opportunities', [eq('ref', h.opportunity)]))?.title ?? h.opportunity;
    raise.push(CARD[h.state](cardOf(h), title));
  }
  const cards = { ...(raise.length ? { raise } : {}), ...(settle.length ? { settle } : {}) };
  if (!changed.length && !raise.length && !settle.length) return { done: true, ...(skipped.length ? { skipped } : {}) };
  const loud = outcomes.length > 0;
  return { changed, ...(outcomes.length ? { outcomes } : {}), ...cards, ...(skipped.length ? { skipped } : {}), notify: loud, wake: loud };
}
