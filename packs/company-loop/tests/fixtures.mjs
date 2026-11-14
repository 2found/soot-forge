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
 * A fake `bbs`: appends each argv (with the ticket it ran on) as a JSON line to `log`. `ticket ensure` hands out
 * bs-tkt00001, bs-tkt00002…; `ticket get status|approval` print what `ticket(id, {...})` set (default: `triage`, no
 * record); `ticket approval resolve` moves that record as the real one does; `team worker-command` prints the agent
 * line; `config workspace show` prints what `workspace(name, paths)` set. `fail(name)` makes one verb fail: ensure, worker, spawn, get, resolve, company.
 */
export function fakeBbs() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-bbs-'));
  const bin = join(dir, 'bbs');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)};
const a = process.argv.slice(2), T = process.env.BABYSIT_TICKET || '';
fs.appendFileSync(path.join(dir, 'log'), JSON.stringify({ argv: a, cwd: process.cwd(), ticket: T, envKeys: Object.keys(process.env) }) + '\\n');
const has = n => fs.existsSync(path.join(dir, n));
const die = (n, msg, code = 1) => { if (has('fail-' + n)) { console.error(msg); process.exit(code); } };
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 't-' + T), 'utf8')); } catch { return {}; } };
if (a[0] === 'ticket' && a[1] === 'ensure') {
  die('ensure', 'ensure: not in a git work tree', 2);
  const n = (has('n') ? Number(fs.readFileSync(path.join(dir, 'n'), 'utf8')) : 0) + 1; fs.writeFileSync(path.join(dir, 'n'), String(n));
  console.log('TICKET=bs-tkt' + String(n).padStart(5, '0') + '\\nBRANCH=main\\nCREATED=1');
} else if (a[0] === 'ticket' && a[1] === 'get') {
  die('get', 'open index.json: no such file');
  const s = state();
  console.log(a[2] === 'status' ? (s.status ?? 'triage') : a[2] === 'approval' && s.approval ? JSON.stringify(s.approval) : '');
} else if (a[0] === 'ticket' && a[1] === 'approval' && a[2] === 'resolve') {
  die('resolve', 'approval: ticket is locked');
  const s = state(), action = a[a.indexOf('--action') + 1], note = a.includes('--note') ? a[a.indexOf('--note') + 1] : '';
  if (s.approval?.state !== 'pending') { console.error(T + ': nothing pending'); process.exit(1); }
  s.approval = { ...s.approval, state: { approve: 'approved', redirect: 'redirected', drop: 'dropped' }[action], resolved: { note } };
  fs.writeFileSync(path.join(dir, 't-' + T), JSON.stringify(s)); console.log(T + ': ' + s.approval.state);
} else if (a[0] === 'team' && a[1] === 'worker-command') {
  die('worker', 'agent "claude" has not been told to trust this directory');
  console.log(a[a.indexOf('--agent') + 1] + " --dangerously-skip-permissions '/bbs:" + a[a.indexOf('--skill') + 1] + ' ' + a[a.indexOf('--prompt') + 1] + "'");
} else if (a[0] === 'team' && a[1] === 'spawn') { die('spawn', 'orca: not running'); console.log('spawned ' + a[2]); }
else if (a[0] === 'config' && a[1] === 'workspace' && a[2] === 'show') {
  const p = path.join(dir, 'ws-' + a[3]);
  if (!fs.existsSync(p)) { console.error('workspace ' + a[3] + ': not found'); process.exit(1); }
  console.log('workspace ' + a[3]); for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) console.log('  https://github.com/acme/' + path.basename(r) + '.git  ' + r + '  role=be');
}
else if (a[0] === 'company') { die('company', 'company: invalid product', 2); console.log('scoreboard: recorded'); }
`);
  chmodSync(bin, 0o755);
  const fail = (name, on = true) => (on ? writeFileSync(join(dir, `fail-${name}`), '') : execFileSync('rm', ['-f', join(dir, `fail-${name}`)]));
  return {
    dir, bin, fail,
    calls: () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    /** What the autopilot session left on a ticket: {status?, approval?: {state, kind, note, at}}. */
    ticket: (id, state) => writeFileSync(join(dir, `t-${id}`), JSON.stringify(state)),
    /** A registry workspace as `bbs config workspace show <name>` prints it: one line per repo path. */
    workspace: (name, paths) => writeFileSync(join(dir, `ws-${name}`), JSON.stringify(paths)),
    failSpawn: on => fail('spawn', on),
    failCompany: on => fail('company', on),
  };
}

/** A scratch git repo (never the real checkout). */
export function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'product-repo-'));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  return dir;
}
