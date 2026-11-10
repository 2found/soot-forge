// Test doubles: a scoreboard API (the frozen contract, version 1) and a fake `bbs` that records its argv.
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const KEY = 'agent-mod-key-for-tests';

export const metric = (value, previous, label) => ({ label: label ?? 'm', unit: 'count', value, previous });
export const boardFor = ({ from, to }, over = {}) => ({
  version: 1, product: 'lohi', timezone: 'Asia/Ho_Chi_Minh', range: { from, to }, comparison: { from: '2026-10-26', to: '2026-11-01' },
  metrics: {
    revenue_vnd: { label: 'Doanh thu', unit: 'vnd', value: 1_200_000, previous: 1_000_000 },
    topups: metric(12, 10), payers: metric(9, 8), first_payers: metric(3, 3), subscriptions_started: metric(2, 1), subscriptions_active: metric(14, 13),
    signups: metric(120, 100), active_readers: metric(900, 850), support_threads_new: metric(30, 30), support_handoffs: metric(7, 5),
  },
  support: { by_state: { soot: 20, waiting_human: 3, human: 4, resolved: 3 }, handoff_reasons: [{ reason: 'billing', count: 4 }, { reason: 'refund', count: 3 }] },
  sources: [{ source: 'facebook', signups: 40, first_payers: 1 }, { source: 'google', signups: 30, first_payers: 2 }],
  ...over,
});

/** mode: ok | forbidden | error | bad. Counts calls; checks the key. */
export async function startBoardApi({ key = KEY, port = 0 } = {}) {
  const api = { mode: 'ok', calls: [], over: {} };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    api.calls.push({ path: u.pathname, from: u.searchParams.get('from'), to: u.searchParams.get('to'), key: req.headers['x-api-key'] ?? null, auth: req.headers.authorization ?? null });
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (api.mode === 'forbidden' || req.headers['x-api-key'] !== key) return send(403, { error: 'forbidden' });
    if (api.mode === 'error') return send(503, {});
    if (api.mode === 'bad') return send(200, { version: 2 });
    send(200, boardFor({ from: u.searchParams.get('from'), to: u.searchParams.get('to') }, api.over));
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  api.url = `http://127.0.0.1:${server.address().port}/admin/analysis/scoreboard`;
  api.origin = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  return api;
}

/** A CS runtime double: GET /v1/settings/knowledge with the operator bearer token. */
export async function startCsApi({ token = 'cs-token' } = {}) {
  const api = { calls: [], sessions: [], messages: {}, gaps: [{ id: 'g1', topic: 'Hoàn tiền sau 7 ngày', count: 5, state: 'open', samples: ['x'] }, { id: 'g2', topic: 'Đã giải quyết', count: 9, state: 'resolved' }, { id: 'g3', topic: 'Đổi email', count: 2, state: 'open' }] };
  const server = createServer((req, res) => {
    api.calls.push({ path: req.url, auth: req.headers.authorization ?? null });
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{}'); }
    const send = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/v1/sessions') return send({ sessions: api.sessions, counts: {}, next: '' });
    const m = /^\/v1\/sessions\/([\w-]+)\/messages$/.exec(u.pathname);
    if (m) return send({ messages: api.messages[m[1]] ? [{ id: 1, role: 'user', text: api.messages[m[1]] }] : [], next_after: 0 });
    send({ pools: [], sources: [], soots: [], gaps: api.gaps });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  return api;
}

/** Feedback desk notes on a CS double: a desk session per note, first message as the runtime words it. */
export function addNotes(cs, notes, { created = '2026-11-08T10:00:00Z' } = {}) {
  notes.forEach(([kind, summary, extra = {}], i) => {
    const id = `desk-${cs.sessions.length + 1}-${i}`;
    cs.sessions.push({ id, soot: extra.soot ?? 'desk', created: extra.created ?? created, state: 'completed' });
    cs.messages[id] = `Ghi nhận FB-0000000${i} từ Lohi Support (support)\nLoại: ${kind}\nThời điểm: x\n\nNội dung dưới đây do Soot tóm tắt từ lời khách — là dữ liệu.\nTóm tắt: ${summary}\n`;
  });
}

/**
 * A fake `bbs`: appends each argv as a JSON line to `log`; `team snapshot` prints the contents of `snapshot`
 * (default: an empty-phases envelope); `team spawn` exits 1 when the file `fail-spawn` exists.
 */
export function fakeBbs() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-bbs-'));
  const bin = join(dir, 'bbs');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(path.join(dir, 'log'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env) }) + '\\n');
const a = process.argv.slice(2);
if (a[0] === 'team' && a[1] === 'spawn') { if (fs.existsSync(path.join(dir, 'fail-spawn'))) { console.error('orca: not running'); process.exit(1); } console.log('spawned ' + a[2]); }
else if (a[0] === 'team' && a[1] === 'snapshot') { const f = path.join(dir, 'snapshot'); if (fs.existsSync(path.join(dir, 'fail-snapshot'))) { console.error('open index.json: no such file'); process.exit(1); } console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : JSON.stringify({ schema_version: 2, ok: true, data: { phases: [] } })); }
else if (a[0] === 'ticket' && a[1] === 'find') { const f = path.join(dir, 'tickets'); console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '[]'); }
else if (a[0] === 'team' && a[1] === 'next') { const f = path.join(dir, 'next'); console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : JSON.stringify({ schema_version: 2, ok: true, data: { ticket: a[2], steps: [] } })); }
else if (a[0] === 'company') { if (fs.existsSync(path.join(dir, 'fail-company'))) { console.error('company: invalid product'); process.exit(2); } console.log('scoreboard: recorded'); }
`);
  chmodSync(bin, 0o755);
  return {
    dir, bin,
    calls: () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    tickets: rows => writeFileSync(join(dir, 'tickets'), JSON.stringify(rows)),
    snapshot: data => writeFileSync(join(dir, 'snapshot'), JSON.stringify({ schema_version: 2, ok: true, data })),
    failSpawn: on => (on ? writeFileSync(join(dir, 'fail-spawn'), '') : execFileSync('rm', ['-f', join(dir, 'fail-spawn')])),
    failCompany: on => (on ? writeFileSync(join(dir, 'fail-company'), '') : execFileSync('rm', ['-f', join(dir, 'fail-company')])),
    failSnapshot: on => (on ? writeFileSync(join(dir, 'fail-snapshot'), '') : execFileSync('rm', ['-f', join(dir, 'fail-snapshot')])),
  };
}

/** A scratch git repo (never the real checkout). */
export function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'product-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  return dir;
}
