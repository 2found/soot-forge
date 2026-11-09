// Products: which product a row belongs to, where each product's scoreboard comes from, and which
// metric is its north star. The pack serves one company with one or more products. Every row it
// writes carries `product`. A row written before storage v4 has none. It reads as its opportunity's
// product, else the host's (Nest's context, else the product of the single SCOREBOARD_URL board),
// and the next write labels it. Nothing is dropped.
import { eq, isNull, getState, setState, safeUrl } from './base.mjs';

/** A product id as the data carries it (Nest sends the same id in the page context). */
export const PRODUCT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const productId = v => (typeof v === 'string' && PRODUCT.test(v.trim()) ? v.trim() : null);

/**
 * The HTTP scoreboard sources. `SCOREBOARD_URL` is the single source of before: its board names its own
 * product, and its state keys stay `sync` and `baseline:<week>`. `SCOREBOARD_URLS` adds one source per
 * product: `product=https://…` entries split by comma or newline. A mapped product wins over the board's own
 * label. An entry that is not that shape, or whose address is not https (or this machine), is skipped and
 * counted, never guessed.
 */
export function scoreboardSources(env) {
  const out = [], bad = [];
  const single = safeUrl(env.SCOREBOARD_URL);
  if (single) out.push({ product: null, url: single, legacy: true });
  for (const raw of String(env.SCOREBOARD_URLS ?? '').split(/[,\n]/).map(s => s.trim()).filter(Boolean)) {
    const at = raw.indexOf('=');
    const product = at > 0 ? productId(raw.slice(0, at)) : null, url = at > 0 ? safeUrl(raw.slice(at + 1)) : null;
    if (!product || !url || out.some(s => s.product === product)) { bad.push(product ?? '?'); continue; }
    out.push({ product, url, legacy: false });
  }
  return { sources: out.slice(0, 16), bad };
}
/** State keys of one source: the single URL keeps the keys it always had. */
export const syncKey = s => (s.legacy ? 'sync' : `sync:${s.product}`);
export const baselineKey = (s, week) => (s.legacy ? `baseline:${week}` : `baseline:${s.product}:${week}`);

const METRIC_KEY = /^[a-z][a-z0-9_]{0,47}$/;
/** `NORTH_STAR`: a metric key for every product, or `product=key` entries (comma separated), or both. */
export function northStarOf(env, product) {
  let all = null, own = null;
  for (const part of String(env.NORTH_STAR ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const at = part.indexOf('=');
    if (at < 0) { if (METRIC_KEY.test(part)) all = part; continue; }
    const key = part.slice(at + 1).trim();
    if (productId(part.slice(0, at)) === product && METRIC_KEY.test(key)) own = key;
  }
  return own ?? all;
}

/** The host's product: what Nest says, else what this pack learned from the single SCOREBOARD_URL board. */
export async function hostProduct(store, said) {
  return productId(said) ?? productId(await getState(store, 'host_product'));
}
export async function rememberHost(store, product) {
  const p = productId(product);
  if (p && (await getState(store, 'host_product')) !== p) await setState(store, 'host_product', p);
}

/** Which product a stored row belongs to: its own, else its opportunity's, else the host's, else null. */
export const rowProduct = (row, oppProduct, host, ref) => productId(row.product) ?? oppProduct.get(row[ref]) ?? host ?? null;

const LABELED = [['decisions', 'opportunity_ref'], ['handoffs', 'opportunity'], ['topics', 'opportunity_ref']];
/**
 * Label rows written before storage v4 (product is null) with their opportunity's product, else the host's.
 * Idempotent and bounded: write tools run it, so unlabeled rows do not linger. Returns how many rows it labeled.
 */
export async function adoptProducts(store, host) {
  let labeled = 0;
  const cache = new Map();
  const ofOpp = async ref => {
    if (!ref) return null;
    if (!cache.has(ref)) cache.set(ref, productId((await store.one('opportunities', [eq('ref', ref)]))?.product));
    return cache.get(ref);
  };
  for (const [table, ref] of LABELED) {
    for (const row of await store.query(table, [isNull('product')], { limit: 200 })) {
      const product = (await ofOpp(row[ref])) ?? productId(host);
      if (!product) continue;
      labeled += await store.update(table, row.id, { product });
    }
  }
  return labeled;
}
