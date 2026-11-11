// The `soot` CLI against this tool's own runtime, with the per-call token the host grants for `needs.runtime`
// (SOOT_RUNTIME_URL + SOOT_RUNTIME_TOKEN, never the operator token, passes no --config). goals.mjs uses it for goals,
// the build half of the handoff for team-contract items (`data.read`, `data.insert`): another team's table is read and
// its queue written without a model.
import { execFile } from 'node:child_process';
import { short } from './base.mjs';
import { findSoot } from './health.mjs';

/** One `soot … --json` call: {ok, json, why}. `why` is the CLI's own error line (it never prints the token). */
export const cli = (bin, call, args) => new Promise(resolve => {
  execFile(bin, [...args, '--json'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, SOOT_RUNTIME_URL: call.url, SOOT_RUNTIME_TOKEN: call.token } }, (err, stdout, stderr) => {
    const why = short(String(stderr ?? '') || (err ? err.message : ''), 200);
    try { resolve({ ok: !err, json: JSON.parse(stdout), why }); } catch { resolve({ ok: false, json: null, why }); }
  });
});

/** {bin, call} when the runtime gave this call a token and a `soot` binary exists, else {skip}: the quiet skipped shape. */
export function runtimeOf(env, reason_code) {
  const call = { url: env.SOOT_RUNTIME_URL, token: env.SOOT_RUNTIME_TOKEN };
  if (!call.url || !call.token) return { skip: { ok: true, skipped: true, reason_code, reason: 'no_runtime_token', notify: false, wake: false } };
  const bin = findSoot(env);
  if (!bin) return { skip: { ok: true, skipped: true, reason_code, reason: 'no_soot', notify: false, wake: false } };
  return { bin, call };
}

const ITEM = /^[a-z][a-z0-9_-]{0,47}$/;
const rowsOf = json => (Array.isArray(json) ? json : json?.rows ?? json?.items ?? json?.data ?? []);

/** Rows of a team-contract item: `soot data query --team <t> --item <i> [--filter json] [--limit n]`. {rows} or {error}. */
export async function dataQuery({ bin, call }, team, item, { filter, limit = 50 } = {}) {
  if (!ITEM.test(team) || !ITEM.test(item)) return { error: 'bad_item' };
  const r = await cli(bin, call, ['data', 'query', '--team', team, '--item', item, ...(filter ? ['--filter', JSON.stringify(filter)] : []), '--limit', String(limit)]);
  if (!r.ok || !r.json) return { error: r.why || 'data_query_failed' };
  const rows = rowsOf(r.json);
  return Array.isArray(rows) ? { rows } : { error: 'bad_answer' };
}

/** One row into another team's queue: `soot data insert --team <t> --queue <q> --row json`. {ok} or {error}. */
export async function dataInsert({ bin, call }, team, queue, row) {
  if (!ITEM.test(team) || !ITEM.test(queue)) return { error: 'bad_item' };
  const r = await cli(bin, call, ['data', 'insert', '--team', team, '--queue', queue, '--row', JSON.stringify(row)]);
  return r.ok ? { ok: true } : { error: r.why || r.json?.code || 'data_insert_failed' };
}
