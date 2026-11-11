// CL4.3 / §7: for a go decision past its check_after_days, fill actual_delta from the
// scoreboard (the target_outcome key is the metric; a content post: its own clicks from its publish day) and keep the hit rate:
// hit = the change reached at least half of expected_delta.
import { eq, getState, isNull, iso } from './base.mjs';
import { boardFor } from './scoreboard.mjs';
import { productId, scopeProduct } from './products.mjs';

/** A hit: actual is at least half of expected, in the direction expected points. */
export const isHit = (actual, expected) => (expected >= 0 ? actual >= expected / 2 : actual <= expected / 2);

export function hitRate(decisions) {
  const done = decisions.filter(d => d.decision === 'go' && Number.isFinite(d.actual_delta) && Number.isFinite(d.expected_delta) && d.expected_delta !== 0);
  const hits = done.filter(d => isHit(d.actual_delta, d.expected_delta)).length;
  return { hits, measured: done.length, rate: done.length ? Math.round((hits / done.length) * 100) / 100 : null };
}

/** How long a published post may stay without its own numbers after its check date before it is closed as "chưa đo". */
export const GRACE_DAYS = 14;
export const UNMEASURED = 'chưa đo';

/**
 * The topic (and so the post) a content Go became: the topic row the digest queued for this opportunity. Its own signal is
 * the post's attributed sign-ups when the decision targets sign-ups and its campaign link brought some, else the post's clicks
 * (Search Console or campaign link). Null is "not measured", never 0.
 */
function postSignal(topic, d) {
  if (d.target_outcome === 'signups' && Number.isFinite(topic?.post_signups)) return { value: topic.post_signups, by: 'signups' };
  if (Number.isFinite(topic?.post_clicks)) return { value: topic.post_clicks, by: 'clicks' };
  return null;
}

export async function review(input, deps) {
  const { store, now } = deps;
  const host = productId(await getState(store, 'host_product'));
  // One product (input, else the run's SOOT_PRODUCT) reviews only its own decisions; none reviews every product, as before.
  const want = scopeProduct(input, deps.env);
  const open = (await store.query('decisions', [eq('decision', 'go'), isNull('actual_delta')], { order: 'at', desc: false, limit: 200 }))
    .filter(d => !d.reviewed_at && (!want || (productId(d.product) ?? host) === want));
  // Each decision is measured on its own product's board (an unlabeled one: the host's).
  const boards = new Map();
  const valueOf = async (product, key) => {
    const p = productId(product) ?? host;
    if (!boards.has(p)) boards.set(p, await boardFor(store, deps.env ?? {}, p, host));
    const b = boards.get(p);
    return b ? [b.north, ...b.tiles].find(t => t?.key === key)?.value : null;
  };
  const reviewed = [], unmeasured = [];
  let waiting = 0;
  for (const d of open) {
    let from = Date.parse(d.at);
    // A shipped product change is measured from its release; a post from the day it was published. Never from the Go.
    const opp = await store.one('opportunities', [eq('ref', d.opportunity_ref)]);
    if (opp?.kind === 'product') {
      const h = await store.one('handoffs', [eq('opportunity', d.opportunity_ref)]);
      if (!h?.released_at) { waiting++; continue; }
      from = Date.parse(h.released_at);
    }
    if (opp?.kind === 'content') {
      const topic = await store.one('topics', [eq('opportunity_ref', d.opportunity_ref), eq('kind', 'content')]);
      if (!topic?.published_at) { waiting++; continue; }
      from = Date.parse(topic.published_at);
      const due = from + d.check_after_days * 86_400_000;
      if (now < due) { waiting++; continue; }
      const signal = postSignal(topic, d);
      if (!signal) {
        // The post has no number of its own (no Search Console, no campaign link): wait a little, then say so instead of scoring noise.
        if (now < due + GRACE_DAYS * 86_400_000) { waiting++; continue; }
        await store.update('decisions', d.id, { reviewed_at: iso(now) });
        unmeasured.push(d.opportunity_ref);
        continue;
      }
      await store.update('decisions', d.id, { actual_delta: signal.value, reviewed_at: iso(now) });
      reviewed.push({ ref: d.opportunity_ref, target: d.target_outcome, measured_by: signal.by, expected: d.expected_delta, actual: signal.value, hit: isHit(signal.value, d.expected_delta) });
      continue;
    }
    if (now < from + d.check_after_days * 86_400_000) { waiting++; continue; }
    const cur = await valueOf(d.product ?? opp?.product, d.target_outcome);
    if (!Number.isFinite(cur) || !Number.isFinite(d.baseline_value)) {
      await store.update('decisions', d.id, { reviewed_at: iso(now) });
      unmeasured.push(d.opportunity_ref);
      continue;
    }
    const actual = Math.round((cur - d.baseline_value) * 100) / 100;
    await store.update('decisions', d.id, { actual_delta: actual, reviewed_at: iso(now) });
    reviewed.push({ ref: d.opportunity_ref, target: d.target_outcome, expected: d.expected_delta, actual, hit: isHit(actual, d.expected_delta) });
  }
  const rate = hitRate((await store.query('decisions', [eq('decision', 'go')], { limit: 500 })).filter(d => !want || (productId(d.product) ?? host) === want));
  if (!reviewed.length && !unmeasured.length) return { done: true, waiting, hit_rate: rate };
  return { reviewed, unmeasured, ...(unmeasured.length ? { unmeasured_note: `${UNMEASURED}: bài chưa có số riêng (Search Console hoặc link chiến dịch), không chấm điểm` } : {}), waiting, hit_rate: rate, notify: false, wake: false };
}
