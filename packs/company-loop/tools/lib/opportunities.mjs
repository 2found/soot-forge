// CL1.2 opportunities, the CL1.4 decision (Go / Để sau / Bỏ), the CL4.3 decision log and the
// topic queue the marketing plan reads. Content opportunities cost nothing and are
// reversible, so the digest sends them straight to a topic (auto-go by "soot"); a product
// opportunity waits for the founder's tap on the operator page.
import { createHash } from 'node:crypto';
import { eq, fail, fold, getState, iso, mondayOf, ictDay, short } from './base.mjs';
import { boardFor } from './scoreboard.mjs';
import { startHandoff } from './handoff.mjs';
import { PARTS, AWARENESS, MOATS, enumProblem } from './parts.mjs';
import { scopeProduct, productId, hostProduct } from './products.mjs';

export const KINDS = ['content', 'product'];
const OUTCOME_ID = /^[a-z][a-z0-9_]{1,47}$/;
const STATES = ['proposed', 'go', 'later', 'drop'];

export const refOf = (kind, title) => `OP-${createHash('sha1').update(`${kind}:${fold(title).replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 8).toUpperCase()}`;

const GOAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const text = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
const num = v => typeof v === 'number' && Number.isFinite(v);

/** Problems of one digest item against CL1.2 (empty = fine). */
export function itemProblems(it) {
  const p = [];
  if (!it || typeof it !== 'object' || Array.isArray(it)) return ['không phải một đối tượng'];
  if (!text(it.title, 3, 140)) p.push('title 3–140 ký tự');
  if (!text(it.product, 2, 32) || !/^[a-z0-9][a-z0-9-]*$/.test(it.product)) p.push('product là mã sản phẩm (a-z, 0-9, -)');
  if (!KINDS.includes(it.kind)) p.push('kind là content hoặc product');
  if (!Array.isArray(it.evidence_refs) || !it.evidence_refs.length || it.evidence_refs.length > 8 || it.evidence_refs.some(r => !text(r, 1, 200))) p.push('evidence_refs 1–8 tham chiếu ngắn');
  if (!Number.isInteger(it.signal_count) || it.signal_count < 1) p.push('signal_count là số nguyên ≥ 1');
  if (!text(it.est_effort, 1, 40)) p.push('est_effort');
  if (!text(it.est_value, 1, 40)) p.push('est_value');
  if (!num(it.confidence) || it.confidence < 0 || it.confidence > 1) p.push('confidence từ 0 đến 1');
  // Without a target_outcome the hit rate cannot be measured, so the item cannot be marked go.
  if (typeof it.target_outcome !== 'string' || !OUTCOME_ID.test(it.target_outcome)) p.push('target_outcome (khoá số liệu hoặc mã outcome) là bắt buộc');
  if (!num(it.expected_delta) || it.expected_delta === 0) p.push('expected_delta là số khác 0');
  if (!Number.isInteger(it.check_after_days) || it.check_after_days < 1 || it.check_after_days > 180) p.push('check_after_days 1–180');
  if (it.kind === 'content' && !(text(it.query, 3, 120) && it.query.trim().split(/\s+/).length >= 2)) p.push('content cần query: một cụm tìm kiếm tiếng Việt từ 2 từ');
  if (it.kind === 'product' && !text(it.summary, 20, 600)) p.push('product cần summary 20–600 ký tự: dựng gì và vì sao');
  if (it.summary !== undefined && !text(it.summary, 1, 600)) p.push('summary tối đa 600 ký tự');
  if (it.query !== undefined && !text(it.query, 3, 120)) p.push('query tối đa 120 ký tự');
  // Five parts, three awareness levels, seven moats: each tag is one word from a closed list, named in the error.
  p.push(...enumProblem('part', it.part, PARTS, true));
  p.push(...enumProblem('awareness', it.awareness, AWARENESS, it.kind === 'content'));
  p.push(...enumProblem('moat', it.moat, MOATS, false));
  // pain: who suffers from what, from customer evidence. A product change without it is a guess.
  if (it.kind === 'product' ? !text(it.pain, 10, 200) : it.pain !== undefined && !text(it.pain, 10, 200)) p.push('pain 10–200 ký tự: ai khổ vì gì (từ lời khách)');
  // goal: optional ref to the goal this bet pushes. The loop only carries the id; the runtime owns goals.
  if (it.goal !== undefined && !(typeof it.goal === 'string' && GOAL_ID.test(it.goal))) p.push('goal là mã mục tiêu (chuỗi 1–64 ký tự: chữ, số, _ . : -), hoặc bỏ trống');
  return p;
}

/** The value of a scoreboard metric now, on the product's own board: the decision's baseline (null when the target is not a metric). */
export async function baselineFor(store, target, product) {
  const board = await boardFor(store, {}, product, await getState(store, 'host_product'));
  const v = board ? [board.north, ...board.tiles].find(t => t?.key === target)?.value : null;
  return Number.isFinite(v) ? v : null;
}

export async function logDecision(store, opp, decision, by, note, now, stage = 'digest') {
  await store.insert('decisions', {
    at: iso(now), stage, opportunity_ref: opp.ref, product: opp.product ?? null, part: opp.part ?? null, moat: opp.moat ?? null, goal: opp.goal ?? null, decision, by, note: note ? short(note, 300) : null,
    evidence_refs: opp.evidence_refs ?? [], target_outcome: opp.target_outcome, expected_delta: opp.expected_delta,
    check_after_days: opp.check_after_days, baseline_value: await baselineFor(store, opp.target_outcome, opp.product), actual_delta: null,
  });
}

export async function queueTopic(store, opp, kind, reason, query) {
  const q = short(query || opp.query || opp.title, 120);
  if (await store.one('topics', [eq('opportunity_ref', opp.ref), eq('kind', kind)])) return false;
  await store.insert('topics', { query: q, reason: short(reason, 200), opportunity_ref: opp.ref, product: opp.product ?? null, awareness: opp.awareness ?? null, kind, state: 'queued' });
  return true;
}

export const PROPOSALS_GROUP = 'company:proposals';

/**
 * The one Cần bạn card for the product opportunities still `proposed`, derived from the table on every tick, with no model and
 * nothing remembered: the id is the set of waiting refs (a new set is a new card that replaces the old one), the count in it is
 * current, and when none is proposed any more (the founder chose on the Công ty page) the card is settled. `Đã xem` only
 * acknowledges; it never wakes a model. The link is a structured field, not text in the body.
 */
export async function opportunities_card(input, deps) {
  // One product (input, else SOOT_PRODUCT) keeps its own card (its own group), so products never settle each other's.
  const want = scopeProduct(input, deps.env);
  const group = want ? `${PROPOSALS_GROUP}:${want}` : PROPOSALS_GROUP;
  const host = want ? await hostProduct(deps.store, null) : null;
  const waiting = (await deps.store.query('opportunities', [eq('state', 'proposed')], { limit: 50 })).filter(o => !want || (productId(o.product) ?? host) === want);
  if (!waiting.length) return { done: true, waiting: 0, settle: [group] };
  const key = createHash('sha1').update(waiting.map(w => w.ref).sort().join(',')).digest('hex').slice(0, 10);
  const names = waiting.slice(0, 5).map(w => `• ${short(w.title, 100)}`).join('\n');
  return { done: true, waiting: waiting.length, raise: {
    id: `${group}:${key}`, group, title: `${waiting.length} cơ hội chờ bạn chọn`,
    why: `${names}${waiting.length > 5 ? `\n… và ${waiting.length - 5} cơ hội nữa` : ''}\nMở trang Công ty: mỗi cơ hội có nút Go, Để sau, Bỏ. Soot chỉ bắt đầu dựng sau khi bạn bấm Go.`,
    link: 'nest://page/cong-ty', link_label: 'Mở Công ty',
    options: [{ id: 'seen', label: 'Đã xem', recommended: true }], reraise_after_hours: 168,
  } };
}

const view = o => ({ ref: o.ref, title: o.title, kind: o.kind, state: o.state });

export async function digest_save(input, deps) {
  const { store, now } = deps;
  const scope = scopeProduct(input, deps.env);
  // `product` (input, else the run's SOOT_PRODUCT) is the product of the whole digest: an item may leave its own out, and an
  // item of another product is refused rather than filed under the wrong one.
  const items = Array.isArray(input.opportunities) ? input.opportunities.map(it => (it && typeof it === 'object' && !Array.isArray(it) && scope && it.product === undefined ? { ...it, product: scope } : it)) : input.opportunities;
  if (!Array.isArray(items) || !items.length || items.length > 5) fail('invalid_request', 'opportunities là danh sách 1–5 cơ hội.');
  const problems = items.flatMap((it, i) => itemProblems(it).map(m => `#${i + 1} ${m}`));
  if (scope) items.forEach((it, i) => { if (it?.product && it.product !== scope) problems.push(`#${i + 1} product ${it.product} không phải ${scope}`); });
  const refs = items.map(it => refOf(it?.kind, it?.title));
  if (new Set(refs).size !== refs.length) problems.push('hai cơ hội trùng nhau');
  if (problems.length) fail('invalid_request', `Chưa lưu cơ hội nào (tất cả hoặc không): ${problems.join('; ')}.`);

  const week = mondayOf(ictDay(now));
  const saved = [], skipped = [];
  let fresh = 0;
  for (const [i, it] of items.entries()) {
    const ref = refs[i];
    const row = {
      title: it.title.trim(), product: it.product, kind: it.kind, query: it.query?.trim() ?? null, summary: it.summary?.trim() ?? null,
      evidence_refs: it.evidence_refs, signal_count: it.signal_count, est_effort: it.est_effort, est_value: it.est_value,
      confidence: it.confidence, part: it.part, awareness: it.awareness ?? null, moat: it.moat ?? null, pain: it.pain?.trim() ?? null, goal: it.goal ?? null, target_outcome: it.target_outcome, expected_delta: it.expected_delta, check_after_days: it.check_after_days, digest_week: week,
    };
    const had = await store.one('opportunities', [eq('ref', ref)]);
    if (had && (had.state === 'go' || had.state === 'drop')) { skipped.push({ ...view(had), why: had.state === 'go' ? 'đã Go' : 'đã Bỏ' }); continue; }
    if (had) await store.update('opportunities', had.id, { ...row, state: 'proposed' });
    else { await store.insert('opportunities', { ref, ...row, state: 'proposed' }); fresh++; }
    const opp = { ref, ...row };
    if (it.kind === 'content') {
      await store.update('opportunities', [eq('ref', ref)], { state: 'go' });
      await logDecision(store, opp, 'go', 'soot', 'Nội dung: không tốn tiền, không đụng mã, hoàn tác được.', now);
      await queueTopic(store, opp, 'content', it.summary || it.title, it.query);
      saved.push({ ...view(opp), state: 'go', topic: short(it.query, 80) });
    } else saved.push({ ...view(opp), state: 'proposed' });
  }

  const waiting = await store.query('opportunities', [eq('state', 'proposed')], { limit: 50 });
  const out = { saved, skipped, waiting: waiting.length };
  if (fresh) out.outcomes = [{ id: 'opportunity_found', count: fresh, ref: `digest:${week}` }];
  // The Cần bạn card is not filed here: `opportunities_card` (a tool-only schedule) keeps it from the table, no model.
  return out;
}

/** Go / Để sau / Bỏ. `by` is who decided: the founder on the page, the operator through an approval. */
export async function decide(input, deps, { by = 'operator' } = {}) {
  const { store, now } = deps;
  if (!['go', 'later', 'drop'].includes(input.decision)) fail('invalid_request', 'decision là go, later hoặc drop.');
  const opp = typeof input.id === 'string' ? await store.one('opportunities', [eq('ref', input.id)]) : null;
  if (!opp) fail('not_found', `Không có cơ hội ${input.id}.`);
  const scope = scopeProduct(input, deps.env);
  if (scope && opp.product && opp.product !== scope) fail('invalid_request', `Cơ hội ${opp.ref} thuộc sản phẩm ${opp.product}, không phải ${scope}.`);
  const note = typeof input.note === 'string' ? input.note : null;
  if (input.decision !== 'go') {
    if (opp.state === 'go') fail('invalid_request', 'Cơ hội này đã Go, không đổi lại được.');
    if (opp.state === input.decision) return { ok: true, already: true, opportunity: view(opp) };
    await store.update('opportunities', opp.id, { state: input.decision });
    await logDecision(store, opp, input.decision, by, note, now, 'gate');
    return { ok: true, opportunity: view({ ...opp, state: input.decision }) };
  }
  if (opp.state === 'go') return { ok: true, already: true, opportunity: view(opp), handoff: await store.one('handoffs', [eq('opportunity', opp.ref)]) };
  await store.update('opportunities', opp.id, { state: 'go' });
  await logDecision(store, opp, 'go', by, note, now, 'gate');
  if (opp.kind === 'content') {
    await queueTopic(store, opp, 'content', opp.summary || opp.title, opp.query);
    return { ok: true, opportunity: view({ ...opp, state: 'go' }), topic: opp.query };
  }
  const handoff = await startHandoff(opp, deps, { baseline: await baselineFor(store, opp.target_outcome, opp.product), person: input.build === 'person' });
  return { ok: true, opportunity: view({ ...opp, state: 'go' }), handoff: { state: handoff.state, requirement_path: handoff.requirement_path, team_id: handoff.team_id, note: handoff.note, command: handoff.command } };
}

const HOUR = 3_600_000;
/** How long marketing keeps a handed topic (marketing `plan` holds `plan_topic` the same 48 hours). */
export const HOLD_MS = 48 * HOUR;
/**
 * Topic states: queued -> handed (given to marketing, nothing written yet) -> written (a post with the keyword exists,
 * `post` is its id), or back to queued when the hold ends with no post. `taken` is the old name of handed: rows
 * written by earlier versions stay readable and are reconciled like handed ones.
 */
export const HANDED = ['handed', 'taken'];

/** The oldest queued topic, marked handed. In a chain (`chain: true`) it is only the query, one at a time and at most one a day. */
export async function topic_next(input, deps) {
  const { store, now } = deps;
  // One product (input, else SOOT_PRODUCT) takes only its own topics (an unlabeled one reads as the host's); none takes any.
  const want = scopeProduct(input, deps.env);
  const host = want ? await hostProduct(store, null) : null;
  const mine = t => !want || (productId(t.product) ?? host) === want;
  if (input.chain) {
    // Marketing keeps one handed topic at a time, so a second would be lost: wait until it is written or the hold ends.
    for (const st of HANDED) {
      const held = (await store.query('topics', [eq('state', st)], { order: 'updated_at', limit: 50 })).find(mine);
      if (held && now - Date.parse(held.updated_at) < HOLD_MS) return {};
    }
    const last = (await store.query('topics', [eq('state', 'written')], { order: 'updated_at', limit: 50 })).find(mine);
    if (last && now - Date.parse(last.updated_at) < 20 * HOUR) return {};
  }
  const next = (await store.query('topics', [eq('state', 'queued')], { order: 'created_at', desc: false, limit: want ? 100 : 1 })).find(mine);
  if (!next) return {};
  await store.update('topics', next.id, { state: 'handed' });
  // The awareness level rides with the topic (only when it has one) so marketing writes the post for that nấc.
  const aw = next.awareness ? { awareness: next.awareness } : {};
  return input.chain ? { query: next.query, ...aw } : { query: next.query, reason: next.reason, opportunity_ref: next.opportunity_ref, ...aw };
}

/**
 * Chain step after marketing `plan`: its output lists the keywords of the newest posts (`topic_posts`). A handed topic
 * with a post becomes `written` (with the post id); one whose 48 h hold ended with no post goes back to the queue.
 * The input is passed through unchanged so the schedule still wakes on marketing's own verdict.
 */
export async function topic_sync(input, deps) {
  const { store, now } = deps;
  const posts = Array.isArray(input.topic_posts) ? input.topic_posts.filter(p => p && typeof p.keyword === 'string' && typeof p.post === 'string') : [];
  const changed = [];
  // The post's own numbers (publish date, GSC or campaign clicks, attributed sign-ups): null when not measured, never 0.
  const own = p => ({
    post_url: typeof p.url === 'string' ? short(p.url, 300) : null,
    published_at: typeof p.published_at === 'string' && Number.isFinite(Date.parse(p.published_at)) ? new Date(p.published_at).toISOString() : null,
    post_clicks: Number.isFinite(p.clicks) ? p.clicks : null,
    post_signups: Number.isFinite(p.signups) ? p.signups : null,
  });
  for (const st of HANDED) {
    for (const t of await store.query('topics', [eq('state', st)], { order: 'created_at', desc: false, limit: 50 })) {
      const hit = posts.find(p => fold(p.keyword) === fold(t.query));
      if (hit) { await store.update('topics', t.id, { state: 'written', post: short(hit.post, 64), ...own(hit) }); changed.push({ query: t.query, state: 'written', post: hit.post }); }
      else if (now - Date.parse(t.updated_at) >= HOLD_MS) { await store.update('topics', t.id, { state: 'queued' }); changed.push({ query: t.query, state: 'queued' }); }
    }
  }
  // A written topic keeps learning how its post does (the review reads this), without being reported as a change.
  for (const t of await store.query('topics', [eq('state', 'written')], { order: 'updated_at', limit: 50 })) {
    const hit = posts.find(p => p.post === t.post);
    if (!hit) continue;
    const next = own(hit);
    if (Object.keys(next).some(k => next[k] !== null && next[k] !== (t[k] ?? null))) await store.update('topics', t.id, Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null)));
  }
  return changed.length ? { ...input, topic_sync: changed } : { ...input };
}

export { STATES };
