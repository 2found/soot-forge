// CL1.2 opportunities, the CL1.4 decision (Go / Để sau / Bỏ), the CL4.3 decision log and the
// topic queue the marketing plan reads. Content opportunities cost nothing and are
// reversible, so the digest sends them straight to a topic (auto-go by "soot"); a product
// opportunity waits for the founder's tap on the operator page.
import { createHash } from 'node:crypto';
import { eq, fail, fold, iso, mondayOf, ictDay, short, getState, setState } from './base.mjs';
import { latestBoard } from './scoreboard.mjs';
import { startHandoff } from './handoff.mjs';

export const KINDS = ['content', 'product'];
const OUTCOME_ID = /^[a-z][a-z0-9_]{1,47}$/;
const STATES = ['proposed', 'go', 'later', 'drop'];

export const refOf = (kind, title) => `OP-${createHash('sha1').update(`${kind}:${fold(title).replace(/[^a-z0-9]+/g, ' ').trim()}`).digest('hex').slice(0, 8).toUpperCase()}`;

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
  return p;
}

/** The value of a scoreboard metric now: the decision's baseline (null when the target is not a metric). */
export async function baselineFor(store, target) {
  const v = (await latestBoard(store))?.metrics?.[target]?.value;
  return Number.isFinite(v) ? v : null;
}

export async function logDecision(store, opp, decision, by, note, now, stage = 'digest') {
  await store.insert('decisions', {
    at: iso(now), stage, opportunity_ref: opp.ref, decision, by, note: note ? short(note, 300) : null,
    evidence_refs: opp.evidence_refs ?? [], target_outcome: opp.target_outcome, expected_delta: opp.expected_delta,
    check_after_days: opp.check_after_days, baseline_value: await baselineFor(store, opp.target_outcome), actual_delta: null,
  });
}

export async function queueTopic(store, opp, kind, reason, query) {
  const q = short(query || opp.query || opp.title, 120);
  if (await store.one('topics', [eq('opportunity_ref', opp.ref), eq('kind', kind)])) return false;
  await store.insert('topics', { query: q, reason: short(reason, 200), opportunity_ref: opp.ref, kind, state: 'queued' });
  return true;
}

const view = o => ({ ref: o.ref, title: o.title, kind: o.kind, state: o.state });

export async function digest_save(input, deps) {
  const { store, now } = deps;
  const items = input.opportunities;
  if (!Array.isArray(items) || !items.length || items.length > 5) fail('invalid_request', 'opportunities là danh sách 1–5 cơ hội.');
  const problems = items.flatMap((it, i) => itemProblems(it).map(m => `#${i + 1} ${m}`));
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
      confidence: it.confidence, target_outcome: it.target_outcome, expected_delta: it.expected_delta, check_after_days: it.check_after_days, digest_week: week,
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
  if (waiting.length) {
    // One Cần bạn card per set of waiting proposals, filed once.
    const key = createHash('sha1').update(waiting.map(w => w.ref).sort().join(',')).digest('hex').slice(0, 10);
    if ((await getState(store, 'asked')) !== key) {
      await setState(store, 'asked', key);
      out.ask = {
        keys: [`company:proposals:${key}`], summary: `${waiting.length} cơ hội chờ bạn chọn`,
        missing: 'Mở trang Công ty ở thanh bên của Nest: mỗi cơ hội có nút Go, Để sau, Bỏ. Soot chỉ bắt đầu dựng sau khi bạn bấm Go.\nnest://page/cong-ty',
        options: [{ label: 'Đã xem', recommended: true }],
      };
    }
  }
  return out;
}

/** Go / Để sau / Bỏ. `by` is who decided: the founder on the page, the operator through an approval. */
export async function decide(input, deps, { by = 'operator' } = {}) {
  const { store, now } = deps;
  if (!['go', 'later', 'drop'].includes(input.decision)) fail('invalid_request', 'decision là go, later hoặc drop.');
  const opp = typeof input.id === 'string' ? await store.one('opportunities', [eq('ref', input.id)]) : null;
  if (!opp) fail('not_found', `Không có cơ hội ${input.id}.`);
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
  const handoff = await startHandoff(opp, deps, { baseline: await baselineFor(store, opp.target_outcome) });
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
  if (input.chain) {
    // Marketing keeps one handed topic at a time, so a second would be lost: wait until it is written or the hold ends.
    for (const st of HANDED) {
      const held = (await store.query('topics', [eq('state', st)], { order: 'updated_at', limit: 1 }))[0];
      if (held && now - Date.parse(held.updated_at) < HOLD_MS) return {};
    }
    const last = (await store.query('topics', [eq('state', 'written')], { order: 'updated_at', limit: 1 }))[0];
    if (last && now - Date.parse(last.updated_at) < 20 * HOUR) return {};
  }
  const next = (await store.query('topics', [eq('state', 'queued')], { order: 'created_at', desc: false, limit: 1 }))[0];
  if (!next) return {};
  await store.update('topics', next.id, { state: 'handed' });
  return input.chain ? { query: next.query } : { query: next.query, reason: next.reason, opportunity_ref: next.opportunity_ref };
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
