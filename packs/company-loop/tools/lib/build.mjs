// The two halves of the product handoff that live on different runtimes.
//
// The server (no PRODUCT_REPO) records a founder's Go as an `approved` handoff that carries the requirement (handoff.mjs).
// The runtime that has the repo (a Mac with PRODUCT_REPO and bbs) pulls it, `builds_pull`, writes the requirement beside the
// tickets and starts the team exactly as a local Go does, keeps its own `builds` row, and reports back through the insight
// team's insert-only queue `handoff_events` (started, progress, handover, shipped, failed). `handoff_events_apply` on the
// server folds those events into `handoffs`. The server never waits on the Mac and never reaches it: the Mac pulls.
// The founder's Go is the only approval; pulling adds none, and nothing here lands, releases, integrates or seals.
import { eq, getState, gte, iso, setState, short, skippedFor } from './base.mjs';
import { dataQuery, dataInsert, runtimeOf } from './runtime.mjs';
import { buildsHere, hasBuild, launchBuild } from './handoff.mjs';
import { productId, scopeProduct } from './products.mjs';
import { queueTopic } from './opportunities.mjs';

const REF = /^OP-[0-9A-F]{8}$/;
const TEAM = /^[a-z][a-z0-9_-]{0,47}$/;
/** The team that owns `handoffs` and the `handoff_events` queue (default `insight`). */
export const insightTeam = env => (TEAM.test(String(env.INSIGHT_TEAM ?? '')) ? env.INSIGHT_TEAM : 'insight');

/** A build's local state -> the event the insight team is told about (draft_ready: the team does not exist yet, nothing to say). */
export const EVENT_OF = { spawned: 'started', starting: 'started', building: 'progress', blocked: 'progress', delivered: 'handover', released: 'shipped', failed: 'failed' };
/** An event -> the handoff state the server shows. A failed team reads as `blocked` with the reason in `detail`. */
export const HANDOFF_OF = { started: 'spawned', progress: 'building', handover: 'delivered', shipped: 'released', failed: 'blocked' };
const RANK = { approved: 0, task: 0, no_repo: 0, draft_ready: 0, spawned: 1, starting: 1, building: 2, blocked: 2, delivered: 3, released: 4 };

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
    const detail = b.detail ?? null;
    if (!ev || (b.pushed === ev && (ev !== 'progress' || (b.pushed_detail ?? null) === detail))) continue;
    if (rt.skip) { unsent++; continue; }
    const row = { handoff: b.handoff, state: ev, team_id: b.team_id ?? null, url: b.url ?? null, note: short(detail || b.note || '', 300) || null, at: iso(now), product: productId(b.product) };
    const r = await dataInsert(rt, insightTeam(env), 'handoff_events', row);
    if (r.error) { unsent++; continue; }
    await store.update('builds', b.id, { pushed: ev, pushed_detail: detail });
    sent++;
  }
  return { sent, unsent };
}

/**
 * builds_pull (the runtime with the repo): approved handoffs of the insight team that no local build covers yet. One product
 * (input, else SOOT_PRODUCT; its PRODUCT_REPO comes from the product's env overlay) or every approved one when none is named.
 * Tool-only, no model, no approval of its own.
 */
export async function builds_pull(input, deps) {
  const { store, env } = deps;
  if (!hasBuild(env)) return skippedFor('PRODUCT_REPO');
  const rt = runtimeOf(env, 'handoffs_unreadable');
  if (rt.skip) return rt.skip;
  const want = scopeProduct(input, env);
  const got = await dataQuery(rt, insightTeam(env), 'handoffs', { filter: { state: 'approved', ...(want ? { product: want } : {}) }, limit: 50 });
  if (got.error) return unreadable('handoffs_unreadable', got.error);
  const started = [], skipped = [], failed = [];
  for (const h of got.rows) {
    const key = h?.opportunity;
    const product = productId(h?.product);
    const requirement = typeof h?.requirement === 'string' ? h.requirement : '';
    if (typeof key !== 'string' || !REF.test(key)) { skipped.push({ why: 'bad_key' }); continue; }
    // A repo belongs to one product: a row of another product, or one that is not approved, is never built here.
    if ((want && product !== want) || !buildsHere(env, product)) { skipped.push({ handoff: key, why: 'other_product' }); continue; }
    if (h.state !== 'approved') { skipped.push({ handoff: key, why: 'not_approved' }); continue; }
    if (!requirement.startsWith('# REQ-') || requirement.length > 20_000) { skipped.push({ handoff: key, why: 'bad_requirement' }); continue; }
    const had = await store.one('builds', [eq('handoff', key)]);
    if (had && had.state !== 'no_repo') { skipped.push({ handoff: key, why: 'already_pulled' }); continue; }
    const out = await launchBuild({ ref: key, requirement, product }, { env });
    const title = short((/^# REQ-OP-[0-9A-F]{8}: (.+)$/m.exec(requirement) ?? [])[1] ?? key, 140);
    const row = await upsertBuild(store, key, { product, title, ...out, detail: null });
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
 * handoff_events_apply (the runtime that decided): fold the `handoff_events` queue into `handoffs`. Events are applied in
 * order and never move a handoff backwards; a released handoff is final. A `shipped` event records `requirement_shipped` and
 * queues the launch topic once, as a local release would. The queue is insert-only, so progress is a cursor in `state`.
 */
export async function handoff_events_apply(input, deps) {
  const { store, now } = deps;
  const want = scopeProduct(input, deps.env);
  const cursor = await getState(store, 'events_cursor');
  const events = await store.query('handoff_events', cursor ? [gte('created_at', cursor)] : [], { order: 'created_at', desc: false, limit: 200 });
  const changed = [], outcomes = [], skipped = [];
  for (const ev of events) {
    const mapped = HANDOFF_OF[ev.state];
    const h = typeof ev.handoff === 'string' ? await store.one('handoffs', [eq('opportunity', ev.handoff)]) : null;
    if (!mapped || !h) { skipped.push({ handoff: ev.handoff ?? null, why: !mapped ? 'bad_state' : 'unknown_handoff' }); continue; }
    if (ev.product && h.product && ev.product !== h.product) { skipped.push({ handoff: h.opportunity, why: 'other_product' }); continue; }
    if (want && productId(h.product) !== want) continue;
    // A handoff the founder gave to a person is not moved by the build runtime's events: the person closes it.
    if (h.state === 'released' || h.state === 'task' || RANK[mapped] < (RANK[h.state] ?? 0)) continue;
    const at = Number.isFinite(Date.parse(ev.at)) ? new Date(ev.at).toISOString() : iso(now);
    const note = ev.note ? short(ev.note, 300) : null;
    const set = { state: mapped, team_id: ev.team_id || h.team_id || null, detail: ev.state === 'failed' ? short(`Đội dựng báo lỗi: ${note ?? 'không rõ'}`, 300) : note ?? h.detail ?? null, ...(ev.url ? { url: short(ev.url, 300) } : {}), ...(mapped === 'released' ? { released_at: at } : {}) };
    if (set.state === h.state && set.detail === h.detail && set.team_id === h.team_id && !set.url) continue;
    await store.update('handoffs', h.id, set);
    changed.push({ ref: h.opportunity, state: mapped });
    if (mapped === 'released') {
      const opp = await store.one('opportunities', [eq('ref', h.opportunity)]);
      if (opp) await queueTopic(store, opp, 'launch', `Tính năng mới đã ra: ${opp.title}`, opp.query || opp.title);
      outcomes.push({ id: 'requirement_shipped', count: 1, ref: `req:${h.opportunity}` });
    }
  }
  if (events.length) await setState(store, 'events_cursor', events[events.length - 1].created_at);
  if (!changed.length) return { done: true, ...(skipped.length ? { skipped } : {}) };
  const loud = outcomes.length > 0;
  return { changed, ...(outcomes.length ? { outcomes } : {}), ...(skipped.length ? { skipped } : {}), notify: loud, wake: loud };
}
