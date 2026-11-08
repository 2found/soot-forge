// signals: the compact packet (at most 3 KiB) the weekly digest reads. Numbers and refs,
// never raw text from customers: metric changes against the previous period, the top
// sources, why support handed over to a person, what the CS runtime could not answer
// (optional), the opportunities and decisions so far and the last launches.
import { eq, getJson, safeUrl, short } from './base.mjs';
import { latestBoard, labelOf } from './scoreboard.mjs';
import { hitRate } from './review.mjs';

export const MAX_BYTES = 3072;

const CS_WHY = { forbidden: () => '', unreachable: () => '', failed: () => '', bad: () => '' };

/** Knowledge gaps from the CS runtime (GET /v1/settings/knowledge, operator token), or why not. Quiet when unset. */
export async function csGaps(deps) {
  const url = safeUrl(deps.env.CS_RUNTIME_URL);
  if (!url || !deps.env.CS_RUNTIME_TOKEN) return null;
  const target = new URL('/v1/settings/knowledge', url);
  const r = await getJson(deps, target, { Authorization: `Bearer ${deps.env.CS_RUNTIME_TOKEN}` }, CS_WHY);
  if (r.error) return { error: r.error.code };
  return (Array.isArray(r.out.gaps) ? r.out.gaps : []).filter(g => g?.state === 'open' && typeof g.topic === 'string')
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 5).map(g => ({ t: short(g.topic, 80), n: g.count ?? 0 }));
}

const pct = (v, p) => (Number.isFinite(v) && Number.isFinite(p) && p > 0 ? Math.round(((v - p) / p) * 100) : null);

/** Shrink the lists, least important first, until the packet fits. */
function fit(packet) {
  const size = () => Buffer.byteLength(JSON.stringify(packet));
  const trims = [['decisions', 3], ['decisions', 1], ['sources', 3], ['reasons', 3], ['cs_gaps', 3], ['launched', 1], ['decisions', 0], ['sources', 1], ['reasons', 1], ['cs_gaps', 1], ['waiting', 3]];
  for (const [k, n] of trims) {
    if (size() <= MAX_BYTES) break;
    if (Array.isArray(packet[k])) packet[k] = packet[k].slice(0, n);
  }
  for (const t of ['title']) if (size() > MAX_BYTES) for (const list of [packet.waiting, packet.later]) for (const o of list ?? []) o[t] = short(o[t], 40);
  return packet;
}

export async function packetFor(deps) {
  const { store } = deps;
  const board = await latestBoard(store);
  if (!board) return null;
  const metrics = Object.entries(board.metrics).map(([k, m]) => ({ k, label: labelOf(k, m), v: m.value, p: m.previous ?? null, pct: pct(m.value, m.previous) }));
  const [opps, decisions, handoffs, queued] = await Promise.all([
    store.query('opportunities', [], { order: 'updated_at', limit: 60 }),
    store.query('decisions', [], { order: 'at', limit: 200 }),
    store.query('handoffs', [], { order: 'updated_at', limit: 20 }),
    store.query('topics', [eq('state', 'queued')], { limit: 50 }),
  ]);
  const gaps = await csGaps(deps).catch(() => ({ error: 'failed' }));
  const rate = hitRate(decisions);
  const packet = {
    product: board.product, period: [board.period_from, board.period_to],
    metrics,
    sources: (board.sources ?? []).slice(0, 5).map(s => ({ s: short(s.source, 30), su: s.signups, fp: s.first_payers })),
    reasons: (board.support?.handoff_reasons ?? []).slice(0, 5).map(r => ({ r: short(r.reason, 40), n: r.count })),
    support: board.support?.by_state ?? null,
    ...(gaps && !gaps.error ? { cs_gaps: gaps } : {}),
    ...(gaps?.error ? { cs_error: gaps.error } : {}),
    waiting: opps.filter(o => o.state === 'proposed').slice(0, 5).map(o => ({ ref: o.ref, title: short(o.title, 60), kind: o.kind })),
    later: opps.filter(o => o.state === 'later').slice(0, 3).map(o => ({ ref: o.ref, title: short(o.title, 60) })),
    decisions: decisions.filter(d => d.decision !== 'later').slice(0, 6).map(d => ({ ref: d.opportunity_ref, d: d.decision, by: d.by, to: d.target_outcome, exp: d.expected_delta, act: d.actual_delta })),
    hit_rate: rate.measured ? { hits: rate.hits, of: rate.measured } : null,
    launched: handoffs.filter(h => h.state === 'released').slice(0, 3).map(h => ({ ref: h.opportunity, at: String(h.released_at ?? h.updated_at).slice(0, 10) })),
    topics_queued: queued.length,
  };
  return fit(packet);
}

export async function signals(input, deps) {
  const packet = await packetFor(deps);
  if (!packet) return { done: true, empty: true, note: 'Chưa có số liệu nào để lập bản tin.' };
  return { packet, notify: true, wake: true };
}
