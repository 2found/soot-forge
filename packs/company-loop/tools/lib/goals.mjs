// goals_checkin: gives every active goal whose `metric.ref` names a scoreboard number its reading, so a product
// other than the host's reaches the goal without code in Soot. A ref is `<product>:<key>` (`2novel:activated_new`)
// or `company-loop:<key>` (the goal's own product, else the host's). The number is the newest stored period of that
// product from either source, an HTTP scoreboard or recorded metrics, so one rule covers both. The reading goes in
// through the workspace's `soot goals checkin` (the same route a person or the Đầu mối uses); nothing else about the
// goal changes. Guardrail refs resolve the same way but are only reported: a check-in holds one value.
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { iso, short, skippedFor } from './base.mjs';
import { findSoot } from './health.mjs';
import { boardFor } from './scoreboard.mjs';
import { productId, hostProduct } from './products.mjs';

const REF = /^([a-z0-9][a-z0-9_-]{0,63}):([a-z][a-z0-9_]{0,47})$/;
/** A measurement is not a forecast; the Đầu mối or a person overrides the confidence at the Friday check-in. */
const AUTO_CONFIDENCE = 5;
const PAGE = 200, MAX_PAGES = 5;

const cli = (bin, config, args) => new Promise(resolve => {
  execFile(bin, [...args, '--json', '--config', config], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (err, stdout) => {
    try { resolve({ ok: !err, json: JSON.parse(stdout) }); } catch { resolve({ ok: false, json: null }); }
  });
});

/** `{product, key}` of a ref, or null when it is not a scoreboard ref. */
export function parseRef(ref, goalProduct, host) {
  const m = REF.exec(String(ref ?? ''));
  if (!m) return null;
  const product = m[1] === 'company-loop' ? productId(goalProduct) ?? host : m[1];
  return product ? { product, key: m[2] } : null;
}

const marker = (product, board) => `bảng số ${product} ${board.from}..${board.to}`;
const fmt = n => String(Math.round(n * 100) / 100);

export async function goals_checkin(input, deps) {
  const { store, env, now } = deps;
  const bin = findSoot(env), config = env.LOOP_SOOT_CONFIG;
  if (!bin || !config || !isAbsolute(config)) return { ...skippedFor('LOOP_SOOT_CONFIG'), reason: !bin ? 'no_soot' : 'no_config' };
  const host = await hostProduct(store, null);
  const goals = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await cli(bin, config, ['goals', 'list', '--status', 'active', '--limit', String(PAGE), '--cursor', String(page * PAGE)]);
    if (!got.ok || !Array.isArray(got.json?.goals)) return page === 0 ? { ok: true, skipped: true, reason_code: 'goals_unreadable', notify: false, wake: false } : { ok: false, reason_code: 'goals_unreadable', message: 'Không đọc hết danh sách mục tiêu.' };
    goals.push(...got.json.goals);
    if (got.json.goals.length < PAGE) break;
  }
  const boards = new Map();
  const board = async product => { if (!boards.has(product)) boards.set(product, await boardFor(store, env, product, host)); return boards.get(product); };
  const reading = async (ref, goalProduct) => {
    const r = parseRef(ref, goalProduct, host);
    if (!r) return null;
    const b = await board(r.product);
    const tile = b?.tiles.find(t => t.key === r.key);
    return { ...r, board: b, value: Number.isFinite(tile?.value) ? tile.value : null };
  };
  const checked = [], skipped = [], guardrails = [], failed = [];
  for (const g of goals) {
    for (const r of g.guardrails ?? []) {
      const gm = await reading(r.ref, g.product);
      if (gm?.value === null || !gm) continue;
      const worse = Number.isFinite(r.limit) && (r.good === 'down' ? gm.value > r.limit : gm.value < r.limit);
      guardrails.push({ goal: g.id, ref: r.ref, value: gm.value, limit: Number.isFinite(r.limit) ? r.limit : null, breached: worse });
    }
    const m = await reading(g.metric?.ref, g.product);
    if (!m) { skipped.push({ goal: g.id, why: 'not_scoreboard_ref' }); continue; }
    if (!m.board) { skipped.push({ goal: g.id, ref: g.metric.ref, why: 'no_numbers_for_product' }); continue; }
    if (m.value === null) { skipped.push({ goal: g.id, ref: g.metric.ref, why: 'metric_not_in_board' }); continue; }
    if (g.start && m.board.to < g.start) { skipped.push({ goal: g.id, ref: g.metric.ref, why: 'period_before_start' }); continue; }
    const mark = marker(m.product, m.board);
    if (typeof g.last_checkin?.note === 'string' && g.last_checkin.note.startsWith(mark)) { skipped.push({ goal: g.id, ref: g.metric.ref, why: 'already_checked_in' }); continue; }
    const tile = m.board.tiles.find(t => t.key === m.key);
    const note = short(`${mark}: ${fmt(m.value)}${Number.isFinite(tile?.previous) ? ` (kỳ trước ${fmt(tile.previous)})` : ''}`, 300);
    if (input.dry_run) { checked.push({ goal: g.id, ref: g.metric.ref, value: m.value, period: `${m.board.from}..${m.board.to}`, dry_run: true }); continue; }
    const out = await cli(bin, config, ['goals', 'checkin', g.id, '--value', String(m.value), '--confidence', String(AUTO_CONFIDENCE), '--note', note]);
    if (out.ok) checked.push({ goal: g.id, ref: g.metric.ref, value: m.value, period: `${m.board.from}..${m.board.to}` });
    else failed.push({ goal: g.id, ref: g.metric.ref, code: short(String(out.json?.error?.code ?? out.json?.code ?? 'checkin_failed'), 40) });
  }
  return { done: true, at: iso(now), checked, skipped, failed, guardrails, notify: false, wake: failed.length > 0 };
}
