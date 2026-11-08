// signals: the compact packet (at most 3 KiB) the weekly digest reads. Numbers and refs,
// never raw text from customers: metric changes against the previous period, the top
// sources, why support handed over to a person, what the CS runtime could not answer
// and what readers asked for or lacked (optional), the opportunities and decisions so far and the last launches.
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

const KINDS = ['feature_request', 'bug', 'complaint', 'question', 'feedback'];
const FEEDBACK_DAYS = 14, FEEDBACK_SESSIONS = 40, FEEDBACK_BYTES = 1024, SAMPLES = 5;

/** A short, general line: no address, link, number run, handle or long id survives. */
export const scrub = text => short(String(text ?? '')
  .replace(/https?:\/\/\S+|www\.\S+/gi, '')
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
  .replace(/@\w+/g, '')
  .replace(/\+?\d[\d .-]{5,}\d/g, '')
  .replace(/\b[A-Za-z0-9_-]{16,}\b/g, '')
  .replace(/\b[A-Z]{2,8}[-\s]?[A-Z0-9]*\d[A-Z0-9]*\b/g, ''), 70);

/**
 * What readers asked for or lacked, from the CS runtime's feedback desk: each note is a conversation of the
 * `desk` Soot (source event) whose first message holds `Loại:` and `Tóm tắt:`. Counts by kind plus up to five
 * scrubbed samples per kind, at most 1 KiB. Null when unset; {error} on a failure.
 */
export async function csFeedback(deps) {
  const url = safeUrl(deps.env.CS_RUNTIME_URL);
  if (!url || !deps.env.CS_RUNTIME_TOKEN) return null;
  const headers = { Authorization: `Bearer ${deps.env.CS_RUNTIME_TOKEN}` };
  const list = await getJson(deps, new URL('/v1/sessions?source=event&limit=100', url), headers, CS_WHY);
  if (list.error) return { error: list.error.code };
  const since = deps.now - FEEDBACK_DAYS * 86_400_000;
  const desk = (Array.isArray(list.out.sessions) ? list.out.sessions : [])
    .filter(x => x?.soot === 'desk' && typeof x.id === 'string' && /^[\w-]+$/.test(x.id) && !(Date.parse(x.created) < since))
    .slice(0, FEEDBACK_SESSIONS);
  const notes = (await Promise.all(desk.map(async x => {
    const m = await getJson(deps, new URL(`/v1/sessions/${x.id}/messages?limit=1`, url), headers, CS_WHY);
    const text = String(m.out?.messages?.[0]?.text ?? '');
    const kind = /^Loại:\s*(\w+)/m.exec(text)?.[1], summary = /^Tóm tắt:\s*(.+)$/m.exec(text)?.[1];
    return KINDS.includes(kind) ? { kind, summary: scrub(summary) } : null;
  }))).filter(Boolean);
  if (!notes.length) return { n: {}, ex: {} };
  const n = {}, ex = {};
  for (const x of notes) {
    n[x.kind] = (n[x.kind] ?? 0) + 1;
    if (x.summary && (ex[x.kind] ??= []).length < SAMPLES && !ex[x.kind].includes(x.summary)) ex[x.kind].push(x.summary);
  }
  const out = { n, ex };
  for (let keep = SAMPLES; keep >= 0 && Buffer.byteLength(JSON.stringify(out)) > FEEDBACK_BYTES; keep--) {
    for (const k of Object.keys(ex)) ex[k] = ex[k].slice(0, keep);
  }
  return out;
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
  if (size() > MAX_BYTES && packet.cs_feedback) packet.cs_feedback = { n: packet.cs_feedback.n };
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
  const feedback = await csFeedback(deps).catch(() => ({ error: 'failed' }));
  const rate = hitRate(decisions);
  const packet = {
    product: board.product, period: [board.period_from, board.period_to],
    metrics,
    sources: (board.sources ?? []).slice(0, 5).map(s => ({ s: short(s.source, 30), su: s.signups, fp: s.first_payers })),
    reasons: (board.support?.handoff_reasons ?? []).slice(0, 5).map(r => ({ r: short(r.reason, 40), n: r.count })),
    support: board.support?.by_state ?? null,
    ...(gaps && !gaps.error ? { cs_gaps: gaps } : {}),
    ...(gaps?.error ? { cs_error: gaps.error } : {}),
    ...(feedback && !feedback.error ? { cs_feedback: feedback } : {}),
    ...(feedback?.error && !gaps?.error ? { cs_error: feedback.error } : {}),
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
