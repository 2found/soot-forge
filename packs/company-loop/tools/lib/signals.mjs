// signals: the compact packet (at most 3 KiB) the weekly digest reads. Numbers and refs,
// never raw text from customers: metric changes against the previous period, the top
// sources, why support handed over to a person, what the CS runtime could not answer
// and what readers asked for or lacked (optional), the opportunities and decisions so far and the last launches.
import { eq, getJson, getState, safeUrl, short, addDays, ictDay } from './base.mjs';
import { latestBoard, labelOf, boardFor, dataProducts } from './scoreboard.mjs';
import { hitRate } from './review.mjs';
import { productId, rowProduct } from './products.mjs';
import { partHealth, partsOf, compactParts } from './parts.mjs';

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
 * LEGACY fallback (used only when the contract item cs.voc is unavailable): what readers asked for or lacked, from the CS runtime's feedback desk: each note is a conversation of the
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
export function fit(packet) {
  const size = () => Buffer.byteLength(JSON.stringify(packet));
  // The moat and awareness tallies are summaries the digest can do without: they go before any history.
  const trims = [['cohorts', 2], ['plans', 3], ['awareness'], ['moats'], ['decisions', 3], ['decisions', 1], ['sources', 3], ['reasons', 3], ['cs_gaps', 3], ['launched', 1], ['decisions', 0], ['sources', 1], ['reasons', 1], ['cs_gaps', 1], ['waiting', 3]];
  for (const [k, n] of trims) {
    if (size() <= MAX_BYTES) break;
    if (n === undefined) delete packet[k];
    else if (Array.isArray(packet[k])) packet[k] = packet[k].slice(0, n);
  }
  if (size() > MAX_BYTES && packet.cs_feedback) packet.cs_feedback = { n: packet.cs_feedback.n };
  for (const t of ['title']) if (size() > MAX_BYTES) for (const list of [packet.waiting, packet.later]) for (const o of list ?? []) o[t] = short(o[t], 40);
  // The parts say which part is broken, the most useful line for the digest: they are compacted last.
  if (size() > MAX_BYTES && Array.isArray(packet.metrics)) packet.metrics = packet.metrics.slice(0, 12);
  if (size() > MAX_BYTES && Array.isArray(packet.metrics)) packet.metrics = packet.metrics.slice(0, 6);
  if (size() > MAX_BYTES) for (const list of [packet.sources, packet.cohorts, packet.plans, packet.launched]) if (Array.isArray(list)) list.length = 0;
  if (size() > MAX_BYTES && packet.parts) packet.parts = packet.parts.map(x => ({ p: x.p, st: x.st, own: x.own }));
  return packet;
}

export async function packetFor(deps, { voc = false, product = null } = {}) {
  const { store } = deps;
  const want = productId(product);
  const host = await getState(store, 'host_product');
  // The HTTP board as before; a company whose Soots record numbers (metrics_record) gets its newest recorded board.
  let board = want ? null : await latestBoard(store), metrics, pBoard = null;
  if (want) {
    // One product: its own board (HTTP and recorded numbers), never another product's.
    pBoard = await boardFor(store, deps.env ?? {}, want, host);
    if (!pBoard) return null;
    const raw = await latestBoard(store, want, host);
    board = { product: want, period_from: pBoard.from, period_to: pBoard.to, sources: pBoard.sources ?? [], support: { handoff_reasons: pBoard.reasons ?? [], by_state: raw?.support?.by_state ?? null }, cohorts: pBoard.cohorts, plans: pBoard.plans };
    metrics = pBoard.tiles.map(t => ({ k: t.key, label: t.label, v: t.value, p: t.previous, pct: t.pct, ...(t.unit !== 'count' && t.unit !== 'vnd' ? { u: t.unit } : {}) }));
  } else if (board) metrics = Object.entries(board.metrics).map(([k, m]) => ({ k, label: labelOf(k, m), v: m.value, p: m.previous ?? null, pct: pct(m.value, m.previous) }));
  else {
    const products = await dataProducts(store);
    const host = await getState(store, 'host_product');
    const table = products.length ? await boardFor(store, deps.env ?? {}, products.includes(host) ? host : products[0], host) : null;
    if (!table) return null;
    board = { product: table.product, period_from: table.from, period_to: table.to, sources: [], support: null, cohorts: null, plans: null };
    metrics = [table.north, ...table.tiles].filter(Boolean).map(t => ({ k: t.key, label: t.label, v: t.value, p: t.previous, pct: t.pct, ...(t.unit !== 'count' && t.unit !== 'vnd' ? { u: t.unit } : {}) }));
  }
  const [oppsAll, decisionsAll, handoffsAll, topicsAll, queuedAll] = await Promise.all([
    store.query('opportunities', [], { order: 'updated_at', limit: 60 }),
    store.query('decisions', [], { order: 'at', limit: 200 }),
    store.query('handoffs', [], { order: 'updated_at', limit: 20 }),
    store.query('topics', [], { order: 'created_at', limit: 200 }),
    store.query('topics', [eq('state', 'queued')], { limit: 50 }),
  ]);
  // With a product, every list narrows to it by the same rule as the page (a row without a label is its opportunity's, else the host's).
  const oppProduct = new Map(oppsAll.map(o => [o.ref, productId(o.product)]));
  const mine = (rows, ref) => (want ? rows.filter(r => rowProduct(r, oppProduct, host, ref) === want) : rows);
  const opps = want ? oppsAll.filter(o => (productId(o.product) ?? host ?? null) === want) : oppsAll;
  const decisions = mine(decisionsAll, 'opportunity_ref'), handoffs = mine(handoffsAll, 'opportunity');
  const topics = mine(topicsAll, 'opportunity_ref'), queued = mine(queuedAll, 'opportunity_ref');
  // The 5 parts of the product this packet is about, and how many Go decisions built each moat.
  const pid = want ?? productId(board.product);
  const partsBoard = pBoard ?? (pid ? await boardFor(store, deps.env ?? {}, pid, host) : null);
  const parts = pid ? compactParts(partHealth(await partsOf(store, pid), partsBoard)) : null;
  const moats = {};
  for (const d of decisions) if (d.decision === 'go' && d.moat && d.moat !== 'none') moats[d.moat] = (moats[d.moat] ?? 0) + 1;
  // Awareness levels the content topics of the last 8 weeks spoke to, so the digest keeps a mix.
  const since = addDays(ictDay(deps.now), -56), awareness = {};
  for (const t of topics) if (t.kind === 'content' && t.awareness && String(t.created_at).slice(0, 10) >= since) awareness[t.awareness] = (awareness[t.awareness] ?? 0) + 1;
  // CS_RUNTIME_URL is the host product's support runtime: another product's packet never carries its gaps or feedback.
  const hostCs = !want || want === productId(host);
  const gaps = hostCs ? await csGaps(deps).catch(() => ({ error: 'failed' })) : null;
  // The contract item cs.voc (read by the digest through the data tool) replaces the desk scrape; the scrape is the fallback when voc is unavailable.
  const feedback = voc || !hostCs ? null : await csFeedback(deps).catch(() => ({ error: 'failed' }));
  const rate = hitRate(decisions);
  const packet = {
    product: board.product, period: [board.period_from, board.period_to],
    metrics,
    sources: (board.sources ?? []).slice(0, 5).map(s => ({ s: short(s.source, 30), su: s.signups, fp: s.first_payers })),
    reasons: (board.support?.handoff_reasons ?? []).slice(0, 5).map(r => ({ r: short(r.reason, 40), n: r.count })),
    support: board.support?.by_state ?? null,
    // Anonymous cohorts and plans (additive fields of the scoreboard); null when the product does not serve them yet: "chưa có".
    cohorts: board.cohorts ? board.cohorts.slice(0, 4).map(c => ({ c: c.cohort, su: c.signups, w1: c.active_w1, w2: c.active_w2, w4: c.active_w4, fp: c.first_payers })) : null,
    plans: board.plans ? board.plans.slice(0, 6).map(p => ({ t: p.tier, st: p.started, ac: p.active, rev: p.revenue_vnd })) : null,
    ...(gaps && !gaps.error ? { cs_gaps: gaps } : {}),
    ...(gaps?.error ? { cs_error: gaps.error } : {}),
    ...(voc ? { cs_voc: 'contract' } : {}),
    ...(feedback && !feedback.error ? { cs_feedback: feedback } : {}),
    ...(feedback?.error && !gaps?.error ? { cs_error: feedback.error } : {}),
    waiting: opps.filter(o => o.state === 'proposed').slice(0, 5).map(o => ({ ref: o.ref, title: short(o.title, 60), kind: o.kind })),
    later: opps.filter(o => o.state === 'later').slice(0, 3).map(o => ({ ref: o.ref, title: short(o.title, 60) })),
    decisions: decisions.filter(d => d.decision !== 'later').slice(0, 6).map(d => ({ ref: d.opportunity_ref, d: d.decision, by: d.by, to: d.target_outcome, exp: d.expected_delta, act: d.actual_delta })),
    hit_rate: rate.measured ? { hits: rate.hits, of: rate.measured } : null,
    launched: handoffs.filter(h => h.state === 'released').slice(0, 3).map(h => ({ ref: h.opportunity, at: String(h.released_at ?? h.updated_at).slice(0, 10) })),
    topics_queued: queued.length,
    ...(parts ? { parts } : {}),
    ...(Object.keys(moats).length ? { moats } : {}),
    ...(Object.keys(awareness).length ? { awareness } : {}),
  };
  return fit(packet);
}

export async function signals(input, deps) {
  const packet = await packetFor(deps, { voc: input?.voc === true, product: input?.product });
  if (!packet) return { done: true, empty: true, note: 'Chưa có số liệu nào để lập bản tin.' };
  return { packet, notify: true, wake: true };
}
