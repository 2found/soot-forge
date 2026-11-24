// The Claude Code video ledger (settings.video_jobs): what the claude-code pack ran for a video, as the chain hands it
// over. The marketing pack cannot read claude-code's own job folders (they are that pack's private state), so the daily
// chain video_brief → claude-code_start → marketing_video_job records a start, and the watch chain
// claude-code_watch {emit: "job"} → marketing_video_import records how it ended. The desk's Nội dung reads it.
import { createHash } from 'node:crypto';
import { fail, eq } from './store.mjs';
import { setSetting } from './ops.mjs';

const DAY = 86_400_000;
/** A job that ended is kept this long (the claude-code pack deletes its folder after 14 days too). */
const KEEP_MS = 14 * DAY;
/** A busy answer is news until the next fire briefs again; after this it is dropped. */
const WAIT_MS = 2 * DAY;
/** A running job whose end never came (12 hours is the longest claude-code timeout) is dropped after this. */
const STALE_MS = 3 * DAY;
const MAX_JOBS = 40;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
export const JOB_STATES = ['running', 'waiting', 'done', 'failed'];

/** video_brief's request id for a key: what the session writes into its result, so an import finds its job. */
export const requestIdOf = (key) => `vb-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;

const line = (s, max) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : null) || null;
const iso = (ms) => new Date(ms).toISOString();

export async function readJobs(store) {
  const v = (await store.one('settings', [eq('key', 'video_jobs')]))?.value;
  return Array.isArray(v?.jobs) ? v.jobs.filter(j => j && typeof j.key === 'string' && JOB_STATES.includes(j.state)) : [];
}

/** Writes the ledger: one entry per key (a waiting key started later is that start), ended ones kept KEEP_MS, a busy
 *  answer WAIT_MS, a running one until its end is recorded or, when that end is lost (no watch schedule, the job folder
 *  gone), STALE_MS after it started; newest first. */
async function writeJobs(store, jobs, now) {
  const age = j => now - Date.parse(j.state === 'running' ? j.started_at ?? j.at ?? '' : j.ended_at ?? j.at ?? '');
  const keep = jobs.filter(j => age(j) < (j.state === 'running' ? STALE_MS : j.state === 'waiting' ? WAIT_MS : KEEP_MS))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, MAX_JOBS);
  await setSetting(store, 'video_jobs', { jobs: keep });
  return keep;
}

/** The product a brief key belongs to, from the brief's memo (`<product>/<folder>` slots). */
async function productOf(store, key) {
  const memo = (await store.one('settings', [eq('key', 'video_brief')]))?.value ?? {};
  const slot = Object.entries(memo.last ?? {}).find(([, v]) => v?.key === key)?.[0];
  return slot ? slot.split('/')[0] : null;
}

/**
 * `video_job` (tool only, chained after claude-code_start): records the start's answer. A started or already running
 * job is `running` with its id, log and start time. A busy machine (`waiting: "busy"`) started nothing: the entry is
 * `waiting`, and the brief's slot and source are freed so the next fire briefs that account again instead of losing
 * the day.
 */
export async function video_job(input, { store, now }) {
  const key = input.key;
  if (typeof key !== 'string' || !KEY.test(key)) fail('invalid_request', 'key is the job key claude-code_start answered.');
  const title = line(input.title, 120) ?? key;
  const jobs = await readJobs(store);
  const others = jobs.filter(j => j.key !== key);
  const product = jobs.find(j => j.key === key)?.product ?? await productOf(store, key);
  if (input.waiting === 'busy' && input.started !== true) {
    const running = (Array.isArray(input.running) ? input.running : []).slice(0, 4).map(r => ({ id: line(r?.id, 100), key: line(r?.key, 64), title: line(r?.title, 120), minutes: Number.isFinite(r?.minutes) ? r.minutes : null }));
    const freed = await freeBrief(store, key);
    await writeJobs(store, [{ key, title, product, state: 'waiting', at: iso(now), running, request_id: requestIdOf(key) }, ...others], now);
    return { ok: true, state: 'waiting', key, freed, notify: false };
  }
  if (input.started !== true && input.already !== true) fail('invalid_request', 'video_job takes claude-code_start\'s answer: {started, id, key, title, log, result_path}, {already: true, …} or {waiting: "busy", …}.');
  if (typeof input.id !== 'string' || !ID.test(input.id)) fail('invalid_request', 'id is the job id claude-code_start answered.');
  const was = jobs.find(j => j.key === key && j.id === input.id);
  const entry = { ...(was ?? {}), id: input.id, key, title, product, state: was?.state === 'done' || was?.state === 'failed' ? was.state : 'running',
    at: was?.at ?? iso(now), started_at: was?.started_at ?? iso(now), log: line(input.log, 1024), request_id: requestIdOf(key) };
  await writeJobs(store, [entry, ...others], now);
  return { ok: true, state: entry.state, id: entry.id, key, notify: false };
}

/** Frees the brief that made `key` (its slot and its source), so the next fire briefs again. True when one was freed. */
async function freeBrief(store, key) {
  const memo = (await store.one('settings', [eq('key', 'video_brief')]))?.value;
  const hit = Object.entries(memo?.last ?? {}).find(([, v]) => v?.key === key);
  if (!hit) return false;
  const [slot, v] = hit;
  const last = { ...memo.last };
  delete last[slot];
  const folder = slot.split('/')[1];
  const parents = Object.fromEntries(Object.entries(memo.parents ?? {}).filter(([k]) => k !== `${v.parent}|${folder}`));
  await setSetting(store, 'video_brief', { ...memo, last, parents });
  return true;
}

/**
 * How a job ended, from video_import: `job` is claude-code_watch's job view (emit "job"), else the entry is found by the
 * result's request_id (emit "result"). Done carries the drafts it made; failed the reason and the session's last words
 * (the log tail: a running job's log cannot be read from here). Returns the entry, or null when nothing matched and
 * there is no job to record.
 */
export async function recordEnd(store, now, { job, request_id, state, error, posts }) {
  const jobs = await readJobs(store);
  const key = typeof job?.key === 'string' && KEY.test(job.key) ? job.key : null;
  const i = jobs.findIndex(j => (job?.id && j.id === job.id) || (key && j.key === key && j.state !== 'done' && j.state !== 'failed') || (request_id && j.request_id === request_id && j.state === 'running'));
  if (i < 0 && !key) return null;
  const was = i >= 0 ? jobs[i] : { key, title: line(job?.title, 120) ?? key, product: await productOf(store, key), at: iso(now), request_id: requestIdOf(key) };
  const entry = { ...was, ...(typeof job?.id === 'string' && ID.test(job.id) ? { id: job.id } : {}), state, ended_at: iso(now),
    ...(state === 'failed' ? { error: line(error, 300) ?? 'failed', log_tail: line(job?.last_text, 400), job_state: line(job?.state, 16) } : { error: null, log_tail: null }),
    ...(posts?.length ? { posts: posts.slice(0, 4) } : {}) };
  await writeJobs(store, [entry, ...jobs.filter((_, n) => n !== i)], now);
  return entry;
}

/** The desk's Claude Code section: the ledger for a product (or all), newest first, with the minutes a running job has run. */
export function jobsView(jobs, { now, product = null }) {
  const mine = jobs.filter(j => !product || !j.product || j.product === product);
  if (!mine.length) return null;
  const counts = Object.fromEntries(JOB_STATES.map(s => [s, mine.filter(j => j.state === s).length]));
  const rows = mine.slice(0, 8).map(j => ({
    id: j.id ?? null, key: j.key, title: j.title, product: j.product ?? null, state: j.state, at: j.at, started_at: j.started_at ?? null, ended_at: j.ended_at ?? null,
    minutes: j.state === 'running' && j.started_at ? Math.max(0, Math.round((now - Date.parse(j.started_at)) / 60000)) : null,
    error: j.error ?? null, log_tail: j.log_tail ?? null, posts: j.posts ?? [], running: j.running ?? [],
  }));
  return { counts, rows };
}
