// claude-code tools: `node tools/cc.mjs <name>` reads the ToolContext on stdin and writes one JSON output
// (`{error:{code,message}}` on a refusal). start hands a brief to a Claude Code session on this machine (a detached
// runner, tools/runner.mjs); jobs reads their state; stop ends one; watch is the tool-only schedule's reader: it
// reports each finished job once, and its result object can chain into another tool with `input_from: previous`.
import { spawn } from 'node:child_process';
import { promises as fsp, accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CcError, fail, claudeEnv, iso, compact, jobsRoot, pidAlive, killGroup, sleep, writeExit,
  readLog, readResult, inspect, listJobs, failureOf,
} from './lib/jobs.mjs';

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const STATES = ['running', 'done', 'failed', 'timed_out', 'stopped'];
const RESULT_CAP = 4096;
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs');

const only = (input, allowed) => {
  for (const k of Object.keys(input)) if (!allowed.includes(k)) fail('invalid_request', `Unknown input "${k}". Allowed: ${allowed.join(', ')}.`);
};
function int(value, name, min, max, dflt) {
  if (value === undefined || value === null || value === '') return dflt;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) fail('invalid_request', `${name} is a whole number from ${min} to ${max}.`);
  return n;
}
const minutes = (from, to) => Math.max(0, Math.round(((to - from) / 60000) * 10) / 10);

// ---------- configuration ----------
function allowedRoots(env) {
  const raw = String(env.CLAUDE_CODE_DIRS ?? '').split(delimiter).map(s => s.trim()).filter(Boolean);
  if (!raw.length) fail('not_configured', 'CLAUDE_CODE_DIRS is not set. The operator sets it in Nest (the claude-code pack\'s settings) to the folders Claude Code may work in, separated by ":" and each an absolute path.');
  const roots = [];
  for (const r of raw) {
    if (!isAbsolute(r)) fail('not_configured', 'CLAUDE_CODE_DIRS holds absolute paths only.');
    try { const real = realpathSync(r); if (real !== '/') roots.push(real); } catch { /* a root that does not exist allows nothing */ }
  }
  if (!roots.length) fail('not_configured', 'None of the folders in CLAUDE_CODE_DIRS exists (or only "/" was given). Set real folders in Nest.');
  return roots;
}
function checkDir(dir, env) {
  if (typeof dir !== 'string' || !isAbsolute(dir)) fail('invalid_request', 'dir is an absolute path.');
  let real;
  try { real = realpathSync(dir); if (!statSync(real).isDirectory()) throw new Error('not a directory'); }
  catch { fail('invalid_request', 'dir does not exist or is not a folder.'); }
  const ok = allowedRoots(env).some(root => { const rel = relative(root, real); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); });
  if (!ok) fail('dir_not_allowed', 'dir is outside the folders the operator allowed (CLAUDE_CODE_DIRS). Pick a folder inside one, or ask the operator to add it in Nest.');
  return real;
}
function claudeBin(env) {
  const runnable = p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (env.CLAUDE_BIN) {
    if (!isAbsolute(env.CLAUDE_BIN) || !runnable(env.CLAUDE_BIN)) fail('claude_not_found', 'CLAUDE_BIN is not an executable absolute path.');
    return env.CLAUDE_BIN;
  }
  for (const d of String(env.PATH ?? '').split(delimiter)) if (d && isAbsolute(d) && runnable(join(d, 'claude'))) return join(d, 'claude');
  const home = join(env.HOME ?? '', '.local', 'bin', 'claude');
  if (env.HOME && runnable(home)) return home;
  return fail('claude_not_found', 'Claude Code (claude) was not found on PATH or in ~/.local/bin. Install it, or set CLAUDE_BIN in Nest.');
}

// ---------- shapes ----------
function jobView(j, { withResult = true } = {}) {
  const { job, exit, state, dir } = j;
  const now = Date.now();
  const log = readLog(dir);
  const out = {
    id: job.id, key: job.key, title: job.title, dir: job.dir, model: job.model, effort: job.effort, state,
    started_at: job.started_at, ended_at: exit?.ended_at,
    minutes: minutes(Date.parse(job.started_at), exit ? Date.parse(exit.ended_at) : now),
    cost_usd: log.cost_usd, num_turns: log.num_turns, usage: log.usage, last_text: log.last_text,
    log: join(dir, 'log.jsonl'), result_path: join(dir, 'result.json'),
  };
  if (withResult) {
    const r = readResult(dir);
    if (r.status === 'ok') out.result = r.bytes <= RESULT_CAP ? r.value : { truncated: true, bytes: r.bytes, preview: JSON.stringify(r.value).slice(0, 600) };
    else if (r.status === 'invalid') out.result_invalid = true;
    if (state !== 'running') { const why = failureOf(j, r); if (why) out.error = why; }
  }
  return out;
}

// ---------- tools ----------
async function start(input, { env, now, timeoutMs }) {
  only(input, ['key', 'title', 'dir', 'prompt', 'model', 'effort', 'timeout_min']);
  const { key, title, prompt } = input;
  if (typeof key !== 'string' || !KEY.test(key)) fail('invalid_request', 'key is lowercase letters, digits, ".", "_" or "-", starting with a letter or digit, at most 64 characters.');
  if (typeof title !== 'string' || !title.trim() || [...title].length > 120) fail('invalid_request', 'title is 1 to 120 characters.');
  if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > 20000) fail('invalid_request', 'prompt is 1 to 20000 characters.');
  const model = input.model ?? (env.CLAUDE_CODE_MODEL || 'opus');
  if (typeof model !== 'string' || !MODEL.test(model)) fail('invalid_request', 'model is a model name or alias such as opus, sonnet or haiku.');
  const effort = input.effort ?? (env.CLAUDE_CODE_EFFORT || 'high');
  if (!EFFORTS.includes(effort)) fail('invalid_request', `effort is one of ${EFFORTS.join(', ')}.`);
  const timeoutMin = int(input.timeout_min, 'timeout_min', 5, 720, 240);
  const maxRunning = int(env.CLAUDE_CODE_MAX_RUNNING, 'CLAUDE_CODE_MAX_RUNNING', 1, 8, 1);

  allowedRoots(env); // unset or empty is refused before anything else is looked at
  const root = jobsRoot(env);
  const jobs = await listJobs(env, { now, persist: true });
  const running = jobs.filter(j => j.state === 'running');
  const same = running.find(j => j.job.key === key);
  if (same) {
    return { started: false, already: true, id: same.job.id, key, title: same.job.title, log: join(same.dir, 'log.jsonl'), result_path: join(same.dir, 'result.json') };
  }
  const dir = checkDir(input.dir, env);
  if (running.length >= maxRunning) {
    return { done: true, waiting: 'busy', running: running.map(j => ({ id: j.job.id, key: j.job.key, title: j.job.title, minutes: minutes(Date.parse(j.job.started_at), now) })) };
  }
  const bin = claudeBin(env);

  await fsp.mkdir(root, { recursive: true });
  let id = `${key}-${compact(now)}`, jobDir;
  for (let n = 1; ; n++) {
    jobDir = join(root, id);
    try { await fsp.mkdir(jobDir); break; } catch (e) { if (e.code !== 'EEXIST' || n > 20) throw e; id = `${key}-${compact(now)}-${n + 1}`; }
  }
  const resultPath = join(jobDir, 'result.json');
  const footer = `You run unattended: nobody answers questions; decide and keep going. When you finish, write the result described above as one JSON object to ${resultPath}. If you could not finish, write {"ok": false, "error": "<one line why>"} there instead.`;
  await fsp.writeFile(join(jobDir, 'prompt.md'), `${prompt.trimEnd()}\n\n---\n${footer}\n`);
  await fsp.writeFile(join(jobDir, 'job.json'), JSON.stringify({
    id, key, title: title.trim(), dir, model, effort, timeout_min: timeoutMin, timeout_ms: timeoutMs ?? timeoutMin * 60000,
    started_at: iso(now), claude_bin: bin,
  }, null, 1) + '\n');
  const runner = spawn(process.execPath, [RUNNER, jobDir], { cwd: jobDir, detached: true, stdio: 'ignore', env: claudeEnv(env) });
  runner.on('error', () => { /* seen as runner_gone */ });
  runner.unref();
  if (runner.pid) await fsp.writeFile(join(jobDir, 'runner.pid'), `${runner.pid}\n`);
  return { started: true, id, key, title: title.trim(), log: join(jobDir, 'log.jsonl'), result_path: resultPath };
}

async function jobs(input, { env, now }) {
  only(input, ['key', 'state', 'limit']);
  if (input.key !== undefined && (typeof input.key !== 'string' || !KEY.test(input.key))) fail('invalid_request', 'key is a job key.');
  if (input.state !== undefined && !STATES.includes(input.state)) fail('invalid_request', `state is one of ${STATES.join(', ')}.`);
  const limit = int(input.limit, 'limit', 1, 100, 20);
  // A read tool: a vanished runner is shown as failed, but nothing is killed or written (watch and start do that).
  const all = await listJobs(env, { now, persist: false });
  const picked = all.filter(j => (!input.key || j.job.key === input.key) && (!input.state || j.state === input.state)).slice(0, limit);
  return { count: picked.length, jobs: picked.map(j => jobView(j)) };
}

async function stop(input, { env, now }) {
  only(input, ['id']);
  if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(input.id)) fail('invalid_request', 'id is a job id (from start or jobs).');
  const dir = join(jobsRoot(env), input.id);
  let j = await inspect(dir, { now, persist: true });
  if (!j) fail('not_found', 'No such job.');
  if (j.state !== 'running') return { ok: true, already_finished: true, id: j.job.id, state: j.state };
  const runnerPid = Number.parseInt(await fsp.readFile(join(dir, 'runner.pid'), 'utf8').catch(() => ''), 10);
  const childPid = Number.parseInt(await fsp.readFile(join(dir, 'child.pid'), 'utf8').catch(() => ''), 10);
  if (runnerPid > 1) { try { process.kill(runnerPid, 'SIGKILL'); } catch { /* already gone */ } } // first, so it cannot write its own exit
  killGroup(childPid, 'SIGTERM');
  for (let i = 0; i < 30 && childPid > 1 && pidAlive(childPid); i++) await sleep(100);
  killGroup(childPid, 'SIGKILL');
  await writeExit(dir, { code: null, signal: 'SIGTERM', timed_out: false, stopped: true, ended_at: iso(Date.now()) });
  // The one who stopped it knows: watch has nothing to report.
  await fsp.writeFile(join(dir, 'reported.json'), JSON.stringify({ at: iso(now), by: 'stop' }) + '\n', { flag: 'wx' }).catch(() => {});
  j = await inspect(dir, { now, persist: false });
  return { ok: true, stopped: true, id: j.job.id, key: j.job.key, state: j.state };
}

async function watch(input, { env, now }) {
  only(input, ['key_prefix', 'emit']);
  const prefix = input.key_prefix ?? '';
  if (typeof prefix !== 'string' || !/^[a-z0-9._-]{0,64}$/.test(prefix)) fail('invalid_request', 'key_prefix is the start of a job key.');
  const emit = input.emit ?? 'job';
  if (!['result', 'job'].includes(emit)) fail('invalid_request', 'emit is "result" or "job".');
  const mine = (await listJobs(env, { now, persist: true })).filter(j => j.job.key.startsWith(prefix));
  const finished = mine.filter(j => j.state !== 'running').reverse(); // oldest first
  for (const j of finished) {
    try { await fsp.writeFile(join(j.dir, 'reported.json'), JSON.stringify({ at: iso(now), by: 'watch' }) + '\n', { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; } // reported already, or claimed by another watch
    const result = readResult(j.dir);
    const why = failureOf(j, result);
    if (why) {
      const v = jobView(j, { withResult: false });
      return { ok: false, notify: true, job: { id: v.id, key: v.key, title: v.title, state: v.state, error: why, last_text: v.last_text } };
    }
    if (emit === 'result') return result.value;
    const { result: _r, ...view } = jobView(j);
    return { job: view, result: result.value };
  }
  return { done: true, running: mine.length - finished.length };
}

export const TOOLS = { start, jobs, stop, watch };

export async function run(name, ctx, { env = process.env, now = Date.now(), timeoutMs } = {}) {
  const tool = TOOLS[name];
  if (!tool) fail('invalid_request', `Unknown tool ${name}.`);
  const input = ctx?.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_request', 'input is an object.');
  return tool(input, { env, now, timeoutMs });
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) fail('invalid_request', 'Input too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function main(name) {
  try {
    process.stdout.write(JSON.stringify(await run(name, await readStdin())) + '\n');
  } catch (e) {
    const known = e instanceof CcError;
    process.stdout.write(JSON.stringify({ error: { code: known ? e.code : 'failed', message: known ? e.message : 'The claude-code tool could not complete the request.' } }) + '\n');
    if (!known) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
