// The 5 parts of a product business (value, marketing, sales, delivery, finance), the 3 awareness levels
// of a reader and the 7 moats: light data, no model. `parts_set` says who owns a part and which scoreboard
// metric watches it; `partHealth` is the one pure function the digest packet and the Công ty page share,
// so both name the same broken part. A part with no row still has a default metric, used only when that
// metric exists on the product's board.
import { eq, fail, short } from './base.mjs';
import { productId } from './products.mjs';

export const PARTS = ['value', 'marketing', 'sales', 'delivery', 'finance'];
export const PART_NAMES = { value: 'Tạo giá trị', marketing: 'Marketing', sales: 'Bán hàng', delivery: 'Giao giá trị', finance: 'Tài chính' };
/** nấc 1 chưa biết mình có vấn đề, nấc 2 biết vấn đề chưa biết cách giải, nấc 3 đang chọn mua của ai. */
export const AWARENESS = ['unaware', 'problem', 'choosing'];
export const MOATS = ['scale', 'network', 'counter', 'switching', 'brand', 'cornered', 'process', 'none'];

const METRIC_KEY = /^[a-z][a-z0-9_]{0,47}$/;
/** A metric moved the bad way by at least this share of the previous period: the part is broken. */
export const HONG_PCT = 10;
/** ...and by at least this many units: 1 → 0 first payers is noise on a small product, not a broken part. */
export const HONG_MIN = 3;

// Candidate metrics per part, first one on the board wins. Value follows the north star.
const DEFAULTS = {
  value: b => [b.north?.key, 'active_users'],
  marketing: () => ['signups'],
  sales: () => ['first_payers', 'revenue_vnd'],
  delivery: () => ['support_threads_new'],
  finance: () => ['revenue_vnd'],
};

/** Enum problems of a tag, named by field (empty = fine). `need` says whether an absent value is a problem. */
export const enumProblem = (field, v, list, need) => (v === undefined || v === null ? (need ? [`${field} là một trong ${list.join('|')}`] : []) : list.includes(v) ? [] : [`${field} là một trong ${list.join('|')}`]);

const pctOf = (v, p) => (Number.isFinite(v) && Number.isFinite(p) && p > 0 ? Math.round(((v - p) / p) * 100) : null);

/**
 * The health of the 5 parts of one product. `rows` are its `parts` rows, `board` is boardFor's answer (or null).
 * Per part: owner (team id, team_name; `chua_giao` true when neither is set), metric with value, previous, pct,
 * status `ok | hong | chua_do`. hong = the metric moved the bad way by >= 10% and >= 3 units against the previous period
 * (a target is shown, never a reason: a stretch target is not a broken part); chua_do = no value on the latest board
 * (never guessed as fine).
 */
export function partHealth(rows, board) {
  const tiles = new Map((board?.tiles ?? []).map(t => [t.key, t]));
  return PARTS.map(part => {
    const row = (rows ?? []).find(r => r.part === part) ?? null;
    const key = row?.metric || DEFAULTS[part](board ?? {}).find(k => k && tiles.has(k)) || null;
    const t = key ? tiles.get(key) : null;
    const value = Number.isFinite(t?.value) ? t.value : null, previous = Number.isFinite(t?.previous) ? t.previous : null;
    const pct = Number.isFinite(t?.pct) ? t.pct : pctOf(value, previous);
    const good = row?.good === 'down' || row?.good === 'up' ? row.good : t?.good === 'down' ? 'down' : 'up';
    const target = Number.isFinite(t?.target) ? t.target : null;
    let status = 'ok';
    if (value === null) status = 'chua_do';
    else {
      const moved = previous === null ? 0 : value - previous;
      const bad = pct !== null && Math.abs(moved) >= HONG_MIN && (good === 'down' ? pct >= HONG_PCT : pct <= -HONG_PCT);
      if (bad) status = 'hong';
    }
    const team = row?.team || null, team_name = row?.team_name || null;
    return {
      part, name: PART_NAMES[part], team, team_name, chua_giao: !team && !team_name,
      metric: key, label: t?.label ?? key, unit: t?.unit ?? 'count', value, previous, pct, good, target,
      promise: row?.promise || null, status, custom: !!row,
    };
  });
}

/** The part to name as the next step: the worst `hong` one (largest bad move). */
export function worstPart(items) {
  const bad = items.filter(x => x.status === 'hong');
  const score = x => (x.pct === null ? 0 : x.good === 'down' ? x.pct : -x.pct);
  return bad.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Compact form for the digest packet: {p, st, m, pct, own}. */
export const compactParts = items => items.map(x => ({ p: x.part, st: x.status, m: x.metric, pct: x.pct, own: x.team ?? null }));

/** Validate and upsert 1-5 parts of one product (all or none). `by` is who changed it: a Soot id or `founder`. */
export async function setParts(store, productIn, list, by, now) {
  const product = productId(productIn);
  if (!product) fail('invalid_request', 'product là mã sản phẩm (a-z, 0-9, -, _).');
  if (!Array.isArray(list) || !list.length || list.length > 5) fail('invalid_request', 'parts là danh sách 1–5 bộ phận.');
  const problems = [], seen = new Set();
  const clean = list.map((p, i) => {
    const at = `#${i + 1}`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { problems.push(`${at} không phải một đối tượng`); return null; }
    problems.push(...enumProblem('part', p.part, PARTS, true).map(m => `${at} ${m}`));
    if (PARTS.includes(p.part)) { if (seen.has(p.part)) problems.push(`${at} ${p.part} trùng`); seen.add(p.part); }
    const set = {};
    // A missing field keeps what is stored; an empty string clears it.
    const text = (f, max) => {
      if (p[f] === undefined) return;
      if (typeof p[f] !== 'string' || p[f].trim().length > max) return problems.push(`${at} ${f} tối đa ${max} ký tự`);
      set[f] = p[f].trim() || null;
    };
    text('team', 64); text('team_name', 60); text('promise', 120);
    if (p.metric !== undefined) { if (p.metric === '' ) set.metric = null; else if (typeof p.metric === 'string' && METRIC_KEY.test(p.metric)) set.metric = p.metric; else problems.push(`${at} metric là khoá số liệu (a-z, 0-9, _)`); }
    if (p.good !== undefined) { if (p.good === '' ) set.good = null; else if (p.good === 'up' || p.good === 'down') set.good = p.good; else problems.push(`${at} good là up hoặc down`); }
    return { part: p.part, set };
  });
  if (problems.length) fail('invalid_request', `Chưa đổi bộ phận nào (tất cả hoặc không): ${problems.join('; ')}.`);
  const at = new Date(now).toISOString();
  for (const { part, set } of clean) {
    const key = `${product}|${part}`, row = { ...set, updated_by: short(by, 64) };
    if (await store.update('parts', [eq('key', key)], row) === 0) await store.insert('parts', { key, product, part, team: null, team_name: null, metric: null, good: null, promise: null, ...row });
  }
  return { ok: true, product, saved: clean.map(c => c.part), at };
}

/** parts_set: the owner team, the watching metric and the public promise of up to 5 parts of a product. */
export async function parts_set(input, deps) {
  const by = typeof deps.soot === 'string' && deps.soot ? deps.soot : 'soot';
  return setParts(deps.store, input.product, input.parts, by, deps.now);
}

export const partsOf = (store, product) => store.query('parts', [eq('product', product)], { limit: 10 });
