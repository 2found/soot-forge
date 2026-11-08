// CL4.3 / §7: for a go decision past its check_after_days, fill actual_delta from the
// scoreboard (the target_outcome key is the metric) and keep the hit rate:
// hit = the change reached at least half of expected_delta.
import { eq, isNull, iso } from './base.mjs';
import { latestBoard } from './scoreboard.mjs';

/** A hit: actual is at least half of expected, in the direction expected points. */
export const isHit = (actual, expected) => (expected >= 0 ? actual >= expected / 2 : actual <= expected / 2);

export function hitRate(decisions) {
  const done = decisions.filter(d => d.decision === 'go' && Number.isFinite(d.actual_delta) && Number.isFinite(d.expected_delta) && d.expected_delta !== 0);
  const hits = done.filter(d => isHit(d.actual_delta, d.expected_delta)).length;
  return { hits, measured: done.length, rate: done.length ? Math.round((hits / done.length) * 100) / 100 : null };
}

export async function review(input, deps) {
  const { store, now } = deps;
  const open = (await store.query('decisions', [eq('decision', 'go'), isNull('actual_delta')], { order: 'at', desc: false, limit: 200 })).filter(d => !d.reviewed_at);
  const board = await latestBoard(store);
  const reviewed = [], unmeasured = [];
  let waiting = 0;
  for (const d of open) {
    let from = Date.parse(d.at);
    // A shipped product change is measured from its release, not from the day the founder said Go.
    const opp = await store.one('opportunities', [eq('ref', d.opportunity_ref)]);
    if (opp?.kind === 'product') {
      const h = await store.one('handoffs', [eq('opportunity', d.opportunity_ref)]);
      if (!h?.released_at) { waiting++; continue; }
      from = Date.parse(h.released_at);
    }
    if (now < from + d.check_after_days * 86_400_000) { waiting++; continue; }
    const cur = board?.metrics?.[d.target_outcome]?.value;
    if (!Number.isFinite(cur) || !Number.isFinite(d.baseline_value)) {
      await store.update('decisions', d.id, { reviewed_at: iso(now) });
      unmeasured.push(d.opportunity_ref);
      continue;
    }
    const actual = Math.round((cur - d.baseline_value) * 100) / 100;
    await store.update('decisions', d.id, { actual_delta: actual, reviewed_at: iso(now) });
    reviewed.push({ ref: d.opportunity_ref, target: d.target_outcome, expected: d.expected_delta, actual, hit: isHit(actual, d.expected_delta) });
  }
  const rate = hitRate(await store.query('decisions', [eq('decision', 'go')], { limit: 500 }));
  if (!reviewed.length && !unmeasured.length) return { done: true, waiting, hit_rate: rate };
  return { reviewed, unmeasured, waiting, hit_rate: rate, notify: false, wake: false };
}
