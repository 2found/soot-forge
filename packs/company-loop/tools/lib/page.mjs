// The "Công ty" page (operator): scoreboard tiles with deltas, opportunities with Go / Để sau / Bỏ,
// handoffs with their state and next step, the decision log with the hit rate. The model
// carries codes and numbers; the page words them in Vietnamese. Every state names its next step.
import { eq, fail, getState } from './base.mjs';
import { latestBoard, labelOf, METRICS } from './scoreboard.mjs';
import { hitRate } from './review.mjs';
import { decide, HOLD_MS, HANDED } from './opportunities.mjs';
import { startHandoff } from './handoff.mjs';
import { bbsReady } from './handoff.mjs';
import { scoreboard_sync } from './scoreboard.mjs';
import { safeUrl } from './base.mjs';
import { healthView } from './health.mjs';

const pct = (v, p) => (Number.isFinite(v) && Number.isFinite(p) && p > 0 ? Math.round(((v - p) / p) * 100) : null);

/** The one next step as a code: {code, n?, ref?, do?}. */
export function nextStep({ setup, sync, proposals, handoffs, topics, handed = 0 }) {
  if (!setup.key || !setup.url) return { code: 'setup' };
  if (sync && sync.ok === false && sync.code === 'forbidden') return { code: 'key_refused' };
  if (proposals) return { code: 'choose', n: proposals };
  const draft = handoffs.find(h => h.state === 'draft_ready' || h.state === 'no_repo');
  if (draft) return { code: draft.state, ref: draft.opportunity };
  const delivered = handoffs.find(h => h.state === 'delivered');
  if (delivered) return { code: 'release_go', ref: delivered.opportunity };
  if (handoffs.some(h => ['spawned', 'starting', 'building', 'blocked'].includes(h.state))) return { code: 'building' };
  if (handed) return { code: 'topic_handed', n: handed };
  if (topics) return { code: 'topics', n: topics };
  return { code: 'idle' };
}

export async function page_view(input, { store, env, now }) {
  const [board, opps, handoffs, decisions, allTopics, sync] = await Promise.all([
    latestBoard(store),
    store.query('opportunities', [], { order: 'updated_at', limit: 100 }),
    store.query('handoffs', [], { order: 'updated_at', limit: 50 }),
    store.query('decisions', [], { order: 'at', limit: 100 }),
    store.query('topics', [], { order: 'updated_at', limit: 50 }),
    getState(store, 'sync'),
  ]);
  // A read tool holds no credential: a sync that ran is the proof the key is there.
  const setup = { key: !!env.PRODUCT_ADMIN_KEY || !!sync, url: !!safeUrl(env.SCOREBOARD_URL), repo: !!env.PRODUCT_REPO, bbs: bbsReady(env) };
  // `taken` is the old name of `handed` (rows written before the state split): it reads as handed over, not written.
  const topics = allTopics.map(t => {
    const state = HANDED.includes(t.state) ? 'handed' : t.state;
    return { ref: t.opportunity_ref, query: t.query, kind: t.kind, state, post: t.post ?? null, at: t.updated_at, ...(state === 'handed' ? { until: new Date(Date.parse(t.updated_at) + HOLD_MS).toISOString() } : {}) };
  });
  const queued = topics.filter(t => t.state === 'queued');
  const handed = topics.filter(t => t.state === 'handed');
  const proposals = opps.filter(o => o.state === 'proposed').length;
  const titleOf = Object.fromEntries(opps.map(o => [o.ref, o.title]));
  return {
    page: 'cong-ty', setup, sync,
    next: nextStep({ setup, sync, proposals, handoffs, topics: queued.length, handed: handed.length }),
    scoreboard: board ? {
      product: board.product, from: board.period_from, to: board.period_to, comparison: board.comparison,
      tiles: Object.entries(board.metrics).map(([key, m]) => ({ key, label: labelOf(key, m), unit: m.unit ?? (key === 'revenue_vnd' ? 'vnd' : 'count'), value: m.value, previous: m.previous ?? null, pct: pct(m.value, m.previous), good: METRICS[key]?.[1] ?? 'up' })),
      cohorts: board.cohorts ?? null, plans: board.plans ?? null,
      sources: (board.sources ?? []).slice(0, 8), reasons: (board.support?.handoff_reasons ?? []).slice(0, 6),
    } : null,
    opportunities: opps.map(o => ({ ref: o.ref, title: o.title, kind: o.kind, state: o.state, summary: o.summary, query: o.query, evidence_refs: o.evidence_refs, signal_count: o.signal_count, est_effort: o.est_effort, est_value: o.est_value, confidence: o.confidence, target_outcome: o.target_outcome, expected_delta: o.expected_delta, check_after_days: o.check_after_days })),
    handoffs: handoffs.map(h => ({ opportunity: h.opportunity, title: titleOf[h.opportunity] ?? h.opportunity, state: h.state, requirement_path: h.requirement_path, team_id: h.team_id, ticket: h.ticket, command: h.command, note: h.note, detail: h.detail })),
    decisions: decisions.slice(0, 40).map(d => ({ at: d.at, stage: d.stage, ref: d.opportunity_ref, title: titleOf[d.opportunity_ref] ?? d.opportunity_ref, decision: d.decision, by: d.by, note: d.note, target_outcome: d.target_outcome, expected_delta: d.expected_delta, check_after_days: d.check_after_days, baseline_value: d.baseline_value, actual_delta: d.actual_delta })),
    // Names for the outcome keys an opportunity is measured by (the tiles carry their own).
    metric_labels: { ...Object.fromEntries(Object.keys(METRICS).map(k => [k, labelOf(k)])), waiting_human: 'Bạn đọc chờ người' },
    hit_rate: hitRate(decisions),
    topics_queued: queued.length,
    topics,
    health: await healthView(store, now),
  };
}

/** Page actions. Only here (the operator-only page) a product Go is the founder's approval. */
export async function page_action(input, deps) {
  const { store } = deps;
  // The founder's tap is the approval: a model call (no page context) must never reach a Go.
  if (deps.page !== 'cong-ty') fail('forbidden', 'Chỉ trang Công ty (bấm của người) mới đổi được cơ hội; Soot không tự quyết.');
  switch (input.op) {
    case 'go': case 'later': case 'drop': {
      const out = await decide({ id: input.id, decision: input.op, note: input.note }, deps, { by: 'founder' });
      return { ok: true, ...out };
    }
    case 'retry_handoff': {
      const h = await store.one('handoffs', [eq('opportunity', String(input.id))]);
      const opp = h && await store.one('opportunities', [eq('ref', h.opportunity)]);
      if (!opp || !['draft_ready', 'no_repo'].includes(h.state)) fail('invalid_request', 'Không có bàn giao nào chờ chạy lại.');
      const out = await startHandoff(opp, deps);
      return { ok: true, handoff: { state: out.state, note: out.note, command: out.command } };
    }
    case 'link_ticket': {
      const h = await store.one('handoffs', [eq('opportunity', String(input.id))]);
      if (!h) fail('not_found', 'Không có bàn giao này.');
      if (typeof input.ticket !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(input.ticket)) fail('invalid_request', 'ticket là mã ticket cha của dự án bbs:team.');
      await store.update('handoffs', h.id, { ticket: input.ticket });
      return { ok: true, linked: input.ticket };
    }
    case 'sync': {
      const out = await scoreboard_sync({ for_digest: true }, deps);
      return { ok: out.ok !== false, ...out };
    }
  }
  return fail('invalid_request', 'op là go, later, drop, retry_handoff, link_ticket hoặc sync.');
}
