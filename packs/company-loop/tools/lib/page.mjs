// The "Công ty" page (operator): the one next step, what needs the founder, the scorecard (north star
// and tiles with deltas and targets), the build pipeline, the decision log with outcomes and the loop's
// health. The page passes Nest's product scope (or its own switch) as input; every section narrows to
// that product, and the model says what it left out. The model carries codes and numbers; the page
// words them in Vietnamese. Every state names its next step.
import { eq, fail, getState, iso, short } from './base.mjs';
import { boardFor, dataProducts, labelOf, METRICS, scoreboard_sync } from './scoreboard.mjs';
import { hitRate, isHit } from './review.mjs';
import { decide, HOLD_MS, HANDED } from './opportunities.mjs';
import { startHandoff, bbsReady, isTask } from './handoff.mjs';
import { healthView } from './health.mjs';
import { adoptProducts, hostProduct, productId, rememberHost, rowProduct, scoreboardSources, syncKey } from './products.mjs';

const DAY = 86_400_000;
const BUILDING = ['spawned', 'starting', 'building', 'blocked'];

/** The one next step as a code: {code, n?, ref?}. */
export function nextStep({ setup, sync, proposals, handoffs, topics, handed = 0, product = null, hasData = true }) {
  const configured = (setup.key && setup.url) || setup.table;
  if (!configured) return { code: 'setup', missing: setup.url ? 'key' : 'source' };
  if (sync && sync.ok === false && sync.code === 'forbidden') return { code: 'key_refused' };
  if (product && !hasData) return { code: 'no_data' };
  if (proposals) return { code: 'choose', n: proposals };
  const draft = handoffs.find(h => h.state === 'draft_ready' || h.state === 'no_repo');
  if (draft) return { code: draft.state, ref: draft.opportunity };
  const tasks = handoffs.filter(h => h.state === 'task');
  if (tasks.length) return { code: 'task', n: tasks.length, ref: tasks[0].opportunity };
  const delivered = handoffs.find(h => h.state === 'delivered');
  if (delivered) return { code: 'release_go', ref: delivered.opportunity };
  if (handoffs.some(h => BUILDING.includes(h.state))) return { code: 'building' };
  if (sync && sync.ok === false) return { code: 'sync_failed' };
  if (handed) return { code: 'topic_handed', n: handed };
  if (topics) return { code: 'topics', n: topics };
  return { code: 'idle' };
}

/** Nest's products from the page context: [{id, name, teams}], ids as the data carries them. */
function contextProducts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list.slice(0, 64)) {
    const id = productId(p?.id);
    if (!id || out.some(x => x.id === id)) continue;
    out.push({ id, name: typeof p.name === 'string' && p.name.trim() ? short(p.name, 60) : id, teams: Array.isArray(p.teams) ? p.teams.filter(t => typeof t === 'string').slice(0, 64) : [] });
  }
  return out;
}

/** Loop health for one product: the teams of that product (and the shared ones); stage health without teams cannot split. */
function narrowHealth(health, want, products) {
  if (!health || !want) return health;
  const mine = products.find(p => p.id === want);
  if (health.runtime?.via !== 'teams' || !mine) return { ...health, split: 'shared' };
  const owned = new Set(products.flatMap(p => p.teams));
  const keep = health.stages.filter(s => mine.teams.includes(s.key) || !owned.has(s.key));
  return { ...health, stages: keep, split: 'product', left_out: health.stages.length - keep.length };
}

/** When a Go decision is (or will be) measured: its verdict and check day. */
function verdictOf(d, opp, handoff, topic) {
  if (d.decision !== 'go') return { verdict: null, check_at: null };
  if (Number.isFinite(d.actual_delta) && Number.isFinite(d.expected_delta) && d.expected_delta !== 0) return { verdict: isHit(d.actual_delta, d.expected_delta) ? 'hit' : 'miss', check_at: null };
  if (d.reviewed_at) return { verdict: 'unmeasured', check_at: null };
  const from = opp?.kind === 'product' ? handoff?.released_at : opp?.kind === 'content' ? topic?.published_at : d.at;
  const days = Number.isInteger(d.check_after_days) ? d.check_after_days : null;
  return { verdict: 'waiting', check_at: from && days ? iso(Date.parse(from) + days * DAY) : null, from: from ? 'set' : opp?.kind === 'product' ? 'release' : 'publish' };
}

export async function page_view(input, { store, env, now, soot }) {
  const ctx = contextProducts(input.products);
  const host = await hostProduct(store, input.host);
  const want = productId(input.product);
  const [opps, rawHandoffs, rawDecisions, rawTopics, health, known] = await Promise.all([
    store.query('opportunities', [], { order: 'updated_at', limit: 200 }),
    store.query('handoffs', [], { order: 'updated_at', limit: 100 }),
    store.query('decisions', [], { order: 'at', limit: 500 }),
    store.query('topics', [], { order: 'updated_at', limit: 200 }),
    healthView(store, now),
    dataProducts(store),
  ]);
  const { sources, bad } = scoreboardSources(env);
  const oppProduct = new Map(opps.map(o => [o.ref, productId(o.product)]));
  const oppOf = new Map(opps.map(o => [o.ref, o]));
  const tag = (rows, ref) => rows.map(r => ({ ...r, product: rowProduct(r, oppProduct, host, ref) }));
  const handoffsAll = tag(rawHandoffs, 'opportunity'), decisionsAll = tag(rawDecisions, 'opportunity_ref'), topicsAll = tag(rawTopics, 'opportunity_ref');
  const oppsAll = opps.map(o => ({ ...o, product: productId(o.product) }));

  // Every product the page can name: Nest's, the data's, the mapped sources', the host.
  const ids = [...new Set([...ctx.map(p => p.id), ...known, ...oppsAll.map(o => o.product), ...sources.map(s => s.product), host].filter(Boolean))];
  const nameOf = id => ctx.find(p => p.id === id)?.name ?? id;
  const inScope = p => !want || p === want;
  const split = (rows, kind) => { const keep = rows.filter(r => inScope(r.product)); return { keep, out: rows.length - keep.length, kind }; };
  const o = split(oppsAll), h = split(handoffsAll), d = split(decisionsAll), t = split(topicsAll);
  const unlabeled = want ? [...handoffsAll, ...decisionsAll, ...topicsAll].filter(r => !r.product).length : 0;

  // Sync state of the source that feeds this scope: a mapped product's own, else the single SCOREBOARD_URL.
  const mapped = want ? sources.find(s => s.product === want) : null;
  const legacy = sources.find(s => s.legacy);
  const syncSource = mapped ?? (legacy && (!want || !host || want === host) ? legacy : null) ?? (!want ? sources[0] : null);
  const sync = syncSource ? await getState(store, syncKey(syncSource)) : null;
  const anySync = sync ?? (await Promise.all(sources.map(s => getState(store, syncKey(s))))).find(Boolean) ?? null;
  const recorded = (await store.query('metrics', [], { limit: 1 })).length > 0;
  // A read tool holds no credential: a sync that ran is the proof the key is there.
  const setup = { key: !!env.PRODUCT_ADMIN_KEY || !!anySync, url: sources.length > 0, table: recorded, sources: sources.length, bad: bad.length,
    repo: !!env.PRODUCT_REPO, bbs: bbsReady(env), build: !!env.PRODUCT_REPO };

  // The scorecard: one product's board, or with every product in view and two or more of them, one row each.
  let scoreboard = null, boards = null;
  const withNumbers = ids.filter(id => known.includes(id) || sources.some(s => s.product === id));
  if (want) scoreboard = await boardFor(store, env, want, host);
  else if (withNumbers.length >= 2) {
    boards = await Promise.all(withNumbers.slice(0, 12).map(async id => {
      const b = await boardFor(store, env, id, host);
      return b ? { product: id, name: nameOf(id), from: b.from, to: b.to, source: b.source, north: b.north, tiles: b.tiles.filter(x => x.key !== b.north?.key).slice(0, 3) } : { product: id, name: nameOf(id), none: true };
    }));
  } else scoreboard = await boardFor(store, env, withNumbers[0] ?? null, host);

  const topics = t.keep.map(x => {
    const state = HANDED.includes(x.state) ? 'handed' : x.state;
    return { ref: x.opportunity_ref, product: x.product, query: x.query, kind: x.kind, state, post: x.post ?? null, at: x.updated_at, ...(state === 'handed' ? { until: iso(Date.parse(x.updated_at) + HOLD_MS) } : {}) };
  });
  const queued = topics.filter(x => x.state === 'queued');
  const handed = topics.filter(x => x.state === 'handed');
  const proposals = o.keep.filter(x => x.state === 'proposed').length;
  const titleOf = ref => oppOf.get(ref)?.title ?? ref;
  const handoffs = h.keep.map(x => ({ opportunity: x.opportunity, product: x.product, title: titleOf(x.opportunity), summary: oppOf.get(x.opportunity)?.summary ?? null,
    state: isTask(x) ? 'task' : x.state, requirement_path: x.requirement_path, team_id: x.team_id, ticket: x.ticket, command: x.command, note: x.note, detail: x.detail, released_at: x.released_at ?? null }));
  const hasData = !!scoreboard || o.keep.length > 0 || h.keep.length > 0 || d.keep.length > 0;
  const handoffOf = new Map(handoffsAll.map(x => [x.opportunity, x]));
  const topicOf = new Map(topicsAll.filter(x => x.kind === 'content').map(x => [x.opportunity_ref, x]));
  const tiles = scoreboard ? [scoreboard.north, ...scoreboard.tiles].filter(Boolean) : (boards ?? []).flatMap(b => [b.north, ...(b.tiles ?? [])]).filter(Boolean);

  return {
    page: 'cong-ty', at: iso(now), soot: typeof soot === 'string' ? soot : null, setup, sync,
    scope: {
      product: want ? { id: want, name: nameOf(want) } : null, host,
      products: ids.map(id => ({ id, name: nameOf(id), waiting: oppsAll.filter(x => x.product === id && x.state === 'proposed').length + handoffsAll.filter(x => x.product === id && (x.state === 'delivered' || isTask(x))).length })),
      left_out: { opportunities: o.out, handoffs: h.out, decisions: d.out, topics: t.out }, unlabeled,
    },
    next: nextStep({ setup, sync, proposals, handoffs, topics: queued.length, handed: handed.length, product: want, hasData }),
    scoreboard, boards,
    opportunities: o.keep.map(x => ({ ref: x.ref, product: x.product, title: x.title, kind: x.kind, state: x.state, summary: x.summary, query: x.query, evidence_refs: x.evidence_refs, signal_count: x.signal_count, est_effort: x.est_effort, est_value: x.est_value, confidence: x.confidence, target_outcome: x.target_outcome, expected_delta: x.expected_delta, check_after_days: x.check_after_days })),
    handoffs,
    decisions: d.keep.slice(0, 40).map(x => ({ at: x.at, stage: x.stage, ref: x.opportunity_ref, product: x.product, title: titleOf(x.opportunity_ref), kind: oppOf.get(x.opportunity_ref)?.kind ?? null, decision: x.decision, by: x.by, note: x.note, target_outcome: x.target_outcome, expected_delta: x.expected_delta, check_after_days: x.check_after_days, baseline_value: x.baseline_value, actual_delta: x.actual_delta,
      ...verdictOf(x, oppOf.get(x.opportunity_ref), handoffOf.get(x.opportunity_ref), topicOf.get(x.opportunity_ref)) })),
    // Names for the outcome keys an opportunity is measured by: the contract's words, then the data's own labels.
    metric_labels: { ...Object.fromEntries(Object.keys(METRICS).map(k => [k, labelOf(k)])), ...Object.fromEntries(tiles.map(x => [x.key, x.label])), waiting_human: 'Bạn đọc chờ người' },
    hit_rate: hitRate(d.keep),
    topics_queued: queued.length,
    topics,
    health: narrowHealth(health, want, ctx),
  };
}

/** Page actions. Only here (the operator-only page) a product Go is the founder's approval. */
export async function page_action(input, deps) {
  const { store, now } = deps;
  // The founder's tap is the approval: a model call (no page context) must never reach a Go.
  if (deps.page !== 'cong-ty') fail('forbidden', 'Chỉ trang Công ty (bấm của người) mới đổi được cơ hội; Soot không tự quyết.');
  // Nest names the server's product: rows from before products get it.
  if (productId(input.host)) await rememberHost(store, input.host);
  await adoptProducts(store, await hostProduct(store, input.host));
  switch (input.op) {
    case 'go': case 'later': case 'drop': {
      const out = await decide({ id: input.id, decision: input.op, note: input.note }, deps, { by: 'founder' });
      return { ok: true, ...out };
    }
    case 'retry_handoff': {
      const h = await store.one('handoffs', [eq('opportunity', String(input.id))]);
      const opp = h && await store.one('opportunities', [eq('ref', h.opportunity)]);
      if (!opp || !['draft_ready', 'no_repo', 'task'].includes(h.state)) fail('invalid_request', 'Không có bàn giao nào chờ chạy lại.');
      const out = await startHandoff(opp, deps);
      return { ok: true, handoff: { state: out.state, note: out.note, command: out.command } };
    }
    case 'task_done': {
      // A task done by a person: the outcome is measured from today, as a release would be.
      const h = await store.one('handoffs', [eq('opportunity', String(input.id))]);
      if (!h || !isTask(h)) fail('invalid_request', 'Không có việc nào đang chờ người làm với mã này.');
      await store.update('handoffs', h.id, { state: 'released', released_at: iso(now), detail: input.note ? short(`Xong: ${input.note}`, 300) : 'Xong: bạn đã đánh dấu việc này xong.' });
      return { ok: true, handoff: { state: 'released', released_at: iso(now) } };
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
  return fail('invalid_request', 'op là go, later, drop, retry_handoff, task_done, link_ticket hoặc sync.');
}
