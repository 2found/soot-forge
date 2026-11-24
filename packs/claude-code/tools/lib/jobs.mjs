// Files and process helpers for claude-code jobs. A job is the folder `$SOOT_PACK_STATE/jobs/<id>/`:
//   job.json      what was asked (no prompt text)         prompt.md   the brief plus the unattended footer
//   runner.pid    the detached runner (written by start)   child.pid   the claude process group leader (runner)
//   log.jsonl     claude's stream-json stdout              stderr.log  claude's stderr
//   result.json   written by the Claude Code session       exit.json   {code, signal, timed_out, ended_at, ...}
//   reported.json written once by `watch` (or `stop`): the job's end has been handed on
// The presence of exit.json IS "finished". Nothing here talks to the network or reads a credential.
import { promises as fsp, openSync, readSync, fstatSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class CcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new CcError(code, message); };

/** The only names Claude Code inherits. Never an API key, token or SOOT_* value: the logged-in subscription is used. */
export const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'CLAUDE_CONFIG_DIR'];
export function claudeEnv(env) {
  const out = {};
  for (const name of ENV_ALLOW) if (typeof env?.[name] === 'string' && env[name] !== '') out[name] = env[name];
  return out;
}

export const iso = ms => new Date(ms).toISOString();
export const compact = ms => iso(ms).replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');

export function jobsRoot(env) {
  const state = env?.SOOT_PACK_STATE;
  if (!state || !state.startsWith('/')) fail('not_configured', 'SOOT_PACK_STATE is not set. The Soot runtime sets it per pack; run this tool through Soot.');
  return join(state, 'jobs');
}

export const readJson = async path => { try { return JSON.parse(await fsp.readFile(path, 'utf8')); } catch { return null; } };
const readPid = async path => { try { const n = Number.parseInt(await fsp.readFile(path, 'utf8'), 10); return n > 1 ? n : null; } catch { return null; } };

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** Signal a whole process group (claude and whatever it started). Never throws. */
export function killGroup(pid, signal = 'SIGKILL') {
  if (!pid) return false;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** exit.json is written once: the first writer wins (runner, stop or a reaper). */
export async function writeExit(dir, exit) {
  try { await fsp.writeFile(join(dir, 'exit.json'), JSON.stringify(exit) + '\n', { flag: 'wx' }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

/** Last `bytes` of a file as text, from a line boundary. */
export function readTail(path, bytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/** What the stream-json log says: the last assistant text and the final result event. */
export function readLog(dir) {
  let lastText = '', final = null;
  for (const line of readTail(join(dir, 'log.jsonl'), 2 * 1024 * 1024).split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const text = ev.message.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
      if (text) lastText = text;
    } else if (ev?.type === 'result') final = ev;
  }
  if (!lastText && typeof final?.result === 'string') lastText = final.result.trim();
  if (lastText.length > 1200) lastText = `…${lastText.slice(-1199)}`;
  return {
    last_text: lastText || undefined,
    cost_usd: typeof final?.total_cost_usd === 'number' ? final.total_cost_usd : undefined,
    num_turns: typeof final?.num_turns === 'number' ? final.num_turns : undefined,
    usage: final?.usage && typeof final.usage === 'object' ? final.usage : undefined,
  };
}

/** One non-empty line of claude's stderr, for a failure message. */
export function stderrLine(dir) {
  const lines = readTail(join(dir, 'stderr.log'), 4096).split('\n').map(l => l.trim()).filter(Boolean);
  const line = lines.at(-1) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** result.json: {status: 'missing'|'invalid'|'ok', value, bytes}. A result is one JSON object. */
export function readResult(dir) {
  let text;
  try { text = readFileSync(join(dir, 'result.json'), 'utf8'); } catch { return { status: 'missing' }; }
  if (text.length > 1024 * 1024) return { status: 'invalid', bytes: text.length };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid', bytes: text.length };
    return { status: 'ok', value, bytes: Buffer.byteLength(text) };
  } catch { return { status: 'invalid', bytes: text.length }; }
}

/**
 * The job as it stands. With `persist` (a write tool) a runner that vanished, or one that outlived its timeout, is
 * ended for good: its group is killed and exit.json is written. Without it (a read tool) the same verdict is derived and
 * nothing is written or killed.
 */
export async function inspect(dir, { now, persist }) {
  const job = await readJson(join(dir, 'job.json'));
  if (!job || typeof job.id !== 'string') return null;
  let exit = await readJson(join(dir, 'exit.json'));
  if (!exit) {
    const runner = await readPid(join(dir, 'runner.pid'));
    const age = now - Date.parse(job.started_at);
    const gone = runner ? !pidAlive(runner) : age > 30_000; // no pid yet = still being started
    const overdue = !gone && age > job.timeout_ms + 60_000;
    if (gone || overdue) {
      exit = await readJson(join(dir, 'exit.json')); // the runner may have finished between the two reads
      if (!exit) {
        exit = { code: null, signal: null, timed_out: overdue, runner_gone: true, ended_at: iso(now) };
        if (persist) {
          if (overdue) { try { process.kill(runner, 'SIGKILL'); } catch { /* gone meanwhile */ } }
          killGroup(await readPid(join(dir, 'child.pid')));
          if (!(await writeExit(dir, exit))) exit = (await readJson(join(dir, 'exit.json'))) ?? exit;
        }
      }
    }
  }
  return { job, exit, dir, state: stateOf(exit) };
}

export function stateOf(exit) {
  if (!exit) return 'running';
  if (exit.stopped) return 'stopped';
  if (exit.timed_out) return 'timed_out';
  if (exit.runner_gone) return 'failed';
  return exit.code === 0 ? 'done' : 'failed';
}

/** Every job, newest first. */
export async function listJobs(env, { now, persist }) {
  const root = jobsRoot(env);
  let names = [];
  try { names = await fsp.readdir(root); } catch { return []; }
  const jobs = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const j = await inspect(join(root, name), { now, persist });
    if (j) jobs.push(j);
  }
  return jobs.sort((a, b) => String(b.job.started_at).localeCompare(String(a.job.started_at)) || b.job.id.localeCompare(a.job.id));
}

/** Why a finished job is not a success, in one line; null when it is one. */
export function failureOf(j, result) {
  const { exit, state, job } = j;
  if (state === 'timed_out') return `timed out after ${Math.round(job.timeout_ms / 60000)} min`;
  if (state === 'stopped') return 'stopped';
  if (exit?.runner_gone) return 'the runner process disappeared before the session ended (runner_gone)';
  if (state === 'failed') {
    const why = exit?.error || stderrLine(j.dir);
    return `claude exited with code ${exit?.code ?? exit?.signal ?? '?'}${why ? `: ${why}` : ''}`;
  }
  if (result.status === 'missing') return 'the session finished without writing result.json';
  if (result.status === 'invalid') return 'result.json is not a JSON object';
  if (result.value.ok === false) return typeof result.value.error === 'string' && result.value.error ? result.value.error.slice(0, 300) : 'the session reported ok:false';
  return null;
}
