// Catalog jobs: the curator (server) asks, the builder (founder's Mac) runs the crawler.
//   catalog_job_request  curator, operator-approved: one row in the pack table `catalog_jobs` (operations team).
//   catalog_jobs_sync    curator: folds the builder's rows in its own queue table `catalog_job_events` back into
//                        `catalog_jobs` (the operations team provides the queue; the builder inserts with `soot data`).
//   catalog_jobs_pull    builder: approved jobs from the operations team (runtime CLI `soot data query`), after
//                        noticing which of its own started jobs have finished; with `autorun` it also starts them.
//   catalog_job_run      builder: runs ONE approved job as a deterministic sequence of cli commands (tools/lib/runner.mjs,
//                        detached, logged, argv arrays, no shell): crawl, refresh, repair and onboard of a new novel
//                        (dry-run -> copyright check -> stop or the real run). The only judgment left is the source of a
//                        request whose link the catalog has never seen (`needs_source`); a vague title never runs.
// The runtime CLI (`soot data ...`) is reached with the per-call token the runtime issues for the declared
// `data.read` / `data.insert` scopes (SOOT_RUNTIME_URL / SOOT_RUNTIME_TOKEN); no key is read or invented here.
import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, skippedFor, eq, gte, inList, getState, setState, upsert, needCard, iso, short } from './base.mjs';
import { postStage, postFailedStage, retryFailedStages, causeOf, NO_SOURCE_NOTE } from './stage.mjs';
import { awaitTranslation } from './release.mjs';
import { planFor, crawlArgv, radarArgv, FIRST_BATCH as RUN_FIRST } from './runner.mjs';
import { openCatalog, resolveJob, sourceForHost } from './resolve.mjs';
import { ingestRadar, isRadarEvent } from './radar.mjs';

export const PRODUCTS = ['lohi', '2novel', '2found', 'trysoot'];
export const KINDS = ['crawl', 'onboard', 'refresh', 'repair'];
const OPEN = ['requested', 'approved', 'running'];
const RANK = { requested: 0, approved: 1, running: 2, done: 3, failed: 3, blocked_copyright: 3 };
export const FIRST_BATCH = RUN_FIRST;
/** The chapters to translate on a done event: the range that was added, at most the first batch of it. */
export function firstBatch(chapters) {
  const m = /^(\d{1,6})-(\d{1,6})$/.exec(String(chapters ?? ''));
  const from = m ? Number(m[1]) : 1;
  const to = m ? Math.max(Number(m[2]), from) : FIRST_BATCH;
  return { from, to: Math.min(to, from + FIRST_BATCH - 1) };
}
const TEAM = 'operations';

/** `<source>/<novel>` (+ `#<from>-<to>` for a repair): both halves are the cli's own slugs, nothing else is accepted. */
const SUBJECT = /^([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:#(\d{1,6})-(\d{1,6}))?$/;
export function parseSubject(subject, kind) {
  const m = SUBJECT.exec(String(subject ?? ''));
  if (!m) fail('invalid_request', 'subject is "<source>/<novel>" (cli source slug and novel slug), plus "#<from>-<to>" for a repair.');
  const [, source, novel, from, to] = m;
  if (kind === 'repair') {
    if (!from || Number(from) > Number(to)) fail('invalid_request', 'a repair subject needs a chapter range: "<source>/<novel>#<from>-<to>".');
  } else if (from && kind !== 'refresh') fail('invalid_request', 'a chapter range belongs to a repair or a refresh only.');
  else if (from && Number(from) > Number(to)) fail('invalid_request', 'the chapter range runs from low to high.');
  return { source, novel, chapters: from ? `${from}-${to}` : null };
}

// ---------- the runtime CLI ----------
/** `soot <args> --json` with the call's runtime token. Answers {ok, json}; never throws for the other side. */
export function runSoot(deps, args) {
  if (deps.soot) return deps.soot(args);
  const env = deps.env ?? {};
  if (!env.SOOT_RUNTIME_URL || !env.SOOT_RUNTIME_TOKEN) return Promise.resolve({ ok: false, reason: 'no_runtime' });
  return new Promise(resolve => {
    execFile(env.SOOT_BIN || 'soot', [...args, '--json'], {
      timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: env.PATH, HOME: env.HOME, SOOT_RUNTIME_URL: env.SOOT_RUNTIME_URL, SOOT_RUNTIME_TOKEN: env.SOOT_RUNTIME_TOKEN },
    }, (err, stdout) => {
      try { resolve({ ok: !err, json: JSON.parse(stdout) }); } catch { resolve({ ok: false, json: null, reason: err ? 'soot_failed' : 'bad_json' }); }
    });
  });
}
const rowsOf = j => (Array.isArray(j) ? j : j?.items ?? j?.rows ?? j?.data ?? []);
const queryItem = (deps, item, filter) => runSoot(deps, ['data', 'query', '--team', TEAM, '--item', item, ...(filter ? ['--filter', JSON.stringify(filter)] : [])]);
export const insertItem = (deps, queue, row) => runSoot(deps, ['data', 'insert', '--team', TEAM, '--queue', queue, '--row', JSON.stringify(row)]);
const unreadable = reason => ({ ok: true, skipped: true, reason_code: reason === 'no_runtime' ? 'no_runtime' : 'data_unreadable', notify: false, wake: false });

// ---------- curator ----------
export async function catalog_job_request(input, deps) {
  const { store, now } = deps;
  const product = input.product === undefined ? 'lohi' : input.product;
  const kind = input.kind;
  if (!PRODUCTS.includes(product)) fail('invalid_request', `product is one of ${PRODUCTS.join(', ')}.`);
  if (!KINDS.includes(kind)) fail('invalid_request', `kind is one of ${KINDS.join(', ')}.`);
  parseSubject(input.subject, kind);
  const reason = short(input.reason, 300);
  if (reason.length < 8) fail('invalid_request', 'reason says why the crawler is needed (at least a short sentence).');
  const subject = String(input.subject);
  const open = (await store.query('catalog_jobs', [eq('product', product), eq('kind', kind), eq('subject', subject)], { order: 'updated_at', limit: 20 }))
    .find(r => OPEN.includes(r.state));
  if (open) return { ok: true, duplicate: true, job: { id: open.id, state: open.state, kind, subject } };
  // This tool runs only once an operator approved the exact request, so the row is born approved.
  const id = await store.insert('catalog_jobs', { product, kind, subject, reason, state: 'approved', approved_by: 'operator', at: iso(now) });
  return { ok: true, duplicate: false, job: { id, state: 'approved', kind, subject }, note: 'The Workshop builder picks it up on its next pull.' };
}

/**
 * The first batch of the chapters a done job added goes to `translations` (translate_step asks Litrans for it, at most
 * 10 chapters; the rest of the range waits in rest_from/rest_to and is translated only past the api's reader bar).
 * A batch of the same novel still in flight is never overwritten: the new chapters queue behind it.
 */
export async function queueTranslation(deps, { slug, requestId = null, chapters, announce = false }) {
  const { store, now } = deps;
  const range = firstBatch(chapters);
  const last = Math.max(Number(/^\d+-(\d+)$/.exec(String(chapters ?? ''))?.[1] ?? 0), range.to);
  const was = await store.one('translations', [eq('key', slug)]);
  if (was && ['wanted', 'queued', 'pulling'].includes(was.phase)) {
    await store.update('translations', String(was.id), { rest_from: Math.min(was.rest_from ?? range.from, range.from), rest_to: Math.max(was.rest_to ?? 0, last), announce: was.announce || announce, at: iso(now) });
    return { behind: true };
  }
  const more = last > range.to;
  await upsert(store, 'translations', 'key', { key: slug, request_id: requestId, phase: 'wanted', from_chapter: range.from, to_chapter: range.to,
    rest_from: more ? range.to + 1 : null, rest_to: more ? last : null, announce, job_id: null, detail: '', at: iso(now) });
  return { from: range.from, to: range.to, ...(more ? { rest: `${range.to + 1}-${last}` } : {}) };
}

export async function catalog_jobs_sync(input, deps) {
  const { store, now } = deps;
  await retryFailedStages(deps);
  // The queue is this team's own pack table: read it in place, from the last row already folded.
  const cursor = await getState(store, 'events_cursor');
  const batch = await store.query('catalog_job_events', cursor ? [gte('created_at', cursor)] : [], { order: 'created_at', desc: false, limit: 500 });
  // The builder's radar finds are not job events: they become jobs only through the policy (radar.mjs).
  const radarEvents = batch.filter(isRadarEvent);
  const events = batch.filter(e => e && e.job_id && RANK[e.state] >= RANK.running)
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const changed = [];
  const open = new Map((await store.query('catalog_jobs', [inList('state', OPEN)], { order: 'updated_at', limit: 500 })).map(r => [String(r.id), r]));
  for (const e of events) {
    const row = open.get(String(e.job_id));
    if (!row || RANK[e.state] <= RANK[row.state]) continue;
    const extra = {};
    if (e.novel_slug) extra.novel_slug = String(e.novel_slug).slice(0, 100);
    if (e.chapters) extra.chapters = String(e.chapters).slice(0, 20);
    if (e.copyright) extra.copyright = short(e.copyright, 300);
    await store.update('catalog_jobs', String(row.id), { state: e.state, result: short(e.detail ?? '', 500), at: iso(now), ...extra });
    row.state = e.state;
    const c = { id: row.id, kind: row.kind, subject: row.subject, state: e.state, detail: short(e.detail ?? '', 160), ...(extra.novel_slug ? { novel_slug: extra.novel_slug } : {}) };
    changed.push(c);
    if (e.state === 'done' && (row.kind === 'onboard' || row.kind === 'refresh') && extra.novel_slug) {
      // The translation of the first batch is queued for translate_step; the request closes when it lands. Chapters a
      // reader's request did not ask for (radar) are announced to the readers once they are translated.
      const queued = await queueTranslation(deps, { slug: extra.novel_slug, requestId: row.request_id ?? null, chapters: extra.chapters ?? row.chapters, announce: !row.request_id && row.approved_by === 'policy:radar' });
      const range = firstBatch(extra.chapters ?? row.chapters);
      c.translate = `${range.from}-${range.to}`;
      // The request's stage on the api: a new novel is up, its first batch is being translated.
      if (row.kind === 'onboard' && row.request_id) {
        await awaitTranslation(deps, { slug: extra.novel_slug, requestId: row.request_id, from: range.from, to: range.to });
        c.stage = await postStage(deps, row.request_id, 'translating', { note: `Đã đưa lên, đang dịch chương ${range.from}–${range.to}` });
      }
      if (queued.rest) c.translate_later = queued.rest;
    }
    if (e.state === 'blocked_copyright') {
      await upsert(store, 'request_outcomes', 'key', { key: String(row.request_id ?? row.id), type: 'novel', outcome: 'blocked_copyright', novel_slug: null, chapters: null, note: short(e.copyright ?? e.detail ?? '', 300), at: iso(now) });
    }
    // A stopped onboard ends the request's pipeline: the api refunds every donation once and the readers see why.
    if ((e.state === 'blocked_copyright' || e.state === 'failed') && row.kind === 'onboard' && row.request_id) {
      // No note from the builder: its detail is an operator log (paths, stack lines). The api tells the readers the
      // plain cause line for `cause`; a missing source gets the one fixed line that asks for a link.
      const cause = causeOf(e.state, e.detail);
      c.stage = await postFailedStage(deps, row.request_id, { cause, ...(cause === 'no_source' ? { note: NO_SOURCE_NOTE } : {}) });
      if (cause === 'no_source') await upsert(store, 'request_outcomes', 'key', { key: String(row.request_id), type: 'novel', outcome: 'no_source', novel_slug: null, chapters: null, note: short(e.detail ?? '', 300), at: iso(now) });
    }
  }
  const last = batch.map(e => String(e.created_at ?? '')).filter(Boolean).sort().pop();
  if (last && last !== cursor) await setState(store, 'events_cursor', last);
  const radar = await ingestRadar(deps, radarEvents);
  const finished = changed.filter(c => c.state === 'done' || c.state === 'failed' || c.state === 'blocked_copyright');
  // A copyright stop is for a person: one card with the matches, cleared when none is left.
  const blocked = (await store.query('catalog_jobs', [eq('state', 'blocked_copyright')], { order: 'updated_at', limit: 20 })).filter(r => !r.acked);
  const card = await needCard(store, 'copyright', { items: blocked.map(r => String(r.id)), summary: `${blocked.length} truyện bị chặn vì nghi vướng bản quyền`,
    lines: blocked.map(r => `• ${short(r.title ?? r.subject, 80)}: ${short(r.copyright ?? r.result, 120)}`) });
  const failedJobs = finished.filter(c => c.state === 'failed');
  // A model wakes only for a failed job (a follow-up may be fixable); a done job needs no line and a copyright stop is a card.
  return { ok: true, changed, failed: failedJobs.length, blocked_copyright: blocked.length, radar, notify: failedJobs.length > 0, wake: false, ...(card.ask ? { ask: card.ask } : {}), ...(card.resolves_need ? { resolves_need: true } : {}) };
}

// ---------- builder (Mac) ----------
export const jobDir = (env, id) => join(env.SOOT_PACK_STATE || '', 'catalog-jobs', String(id).replace(/[^A-Za-z0-9_-]/g, '_'));
const tail = (text, n) => String(text ?? '').trim().split('\n').slice(-6).join(' | ').slice(-n);
/** A job that waited this long for a source nobody gave it ends `no source` (the readers' LT is refunded). */
export const NEEDS_SOURCE_HOURS = 24;

/** Jobs the builder started and has not reported: look at their exit-code file, report the end once. */
async function settleStarted(deps, fsx) {
  const { store, env, now } = deps;
  const settled = [];
  for (const row of await store.query('state', [], { order: 'updated_at', limit: 200 })) {
    if (!row.key?.startsWith('job:')) continue;
    const id = row.key.slice(4), dir = jobDir(env, id);
    if (row.value?.state === 'needs_source') {
      // Nobody resolved the link in time: end it, so the request's donors are refunded rather than waiting for ever.
      if (now - Date.parse(row.value.started_at ?? iso(now)) < NEEDS_SOURCE_HOURS * 3_600_000) continue;
      const sent = await insertItem(deps, 'catalog_job_events', { job_id: id, state: 'failed', detail: 'no source: the request link was never resolved to a source novel', at: iso(now) });
      if (!sent.ok) continue;
      await setState(store, row.key, { ...row.value, state: 'failed', ended_at: iso(now) });
      settled.push({ id, state: 'failed', detail: 'no_source' });
      continue;
    }
    if (row.value?.state !== 'running') continue;
    const code = await fsx.readFile(join(dir, 'exit'), 'utf8').then(s => s.trim(), () => null);
    if (code === null) continue;
    const log = await fsx.readFile(join(dir, 'log'), 'utf8').catch(() => '');
    // The runner writes the outcome it computed (state, novel_slug, chapters, copyright); a plain command only an exit code.
    const res = await fsx.readFile(join(dir, 'result.json'), 'utf8').then(s => JSON.parse(s), () => null);
    const ok = res ? res.state !== 'failed' : code === '0';
    const state = res?.state ?? (ok ? 'done' : 'failed');
    const detail = res?.detail ?? (ok ? `exit 0. ${tail(log, 300)}` : `exit ${short(code, 8)}. ${tail(log, 300)}`);
    const event = { job_id: id, state, detail: short(detail, 480), at: iso(now),
      ...(res?.novel_slug ? { novel_slug: res.novel_slug } : {}), ...(res?.chapters ? { chapters: res.chapters } : {}), ...(res?.copyright ? { copyright: short(res.copyright, 300) } : {}) };
    const sent = await insertItem(deps, 'catalog_job_events', event);
    if (!sent.ok) continue; // reported next time
    await setState(store, row.key, { ...row.value, state, ended_at: iso(now) });
    settled.push({ id, state });
  }
  return settled;
}

async function approvedJobs(deps) {
  const got = await queryItem(deps, 'catalog_jobs', { state: 'approved' });
  if (!got.ok) return { reason: got.reason };
  return { jobs: rowsOf(got.json).filter(j => j && j.id !== undefined && j.state === 'approved') };
}

const brief = j => ({ id: String(j.id), product: j.product, kind: j.kind, subject: j.subject, reason: short(j.reason, 200), request_id: j.request_id ?? null, title: j.title ?? null, chapters: j.chapters ?? null, novel_slug: j.novel_slug ?? null, source_url: j.source_url ?? null });

/**
 * Report this Mac's finished jobs, then list the approved ones it has not started. With `autorun` it also starts them
 * (at most `max_start`, one tool call and no model): the loop `pull -> run -> settle` is deterministic, and the model is
 * woken only for what needs a decision (a link whose source nobody can derive) or a job that could not start.
 */
export async function catalog_jobs_pull(input, deps) {
  const { store } = deps;
  const settled = await settleStarted(deps, deps.fsImpl ?? fsp);
  const got = await approvedJobs(deps);
  if (got.reason) return unreadable(got.reason);
  const fresh = [];
  for (const j of got.jobs) if (!(await getState(store, `job:${j.id}`))) fresh.push(j); // already started or finished on this Mac
  if (input.autorun !== true) return { ok: true, jobs: fresh.map(brief), settled, notify: fresh.length > 0 || settled.length > 0, wake: false };
  const started = [], needs_source = [], refused = [];
  for (const j of fresh.slice(0, Math.min(Math.max(Math.trunc(Number(input.max_start)) || 3, 1), 10))) {
    let r;
    try { r = await startJob(deps, j); } catch (e) { r = { ok: false, error: { code: e.code ?? 'failed', message: short(e.message, 160) } }; }
    if (r.skipped && r.reason_code !== 'already_started') return { ok: true, started, settled, skipped: true, reason_code: r.reason_code, notify: false, wake: false };
    if (r.executed) started.push({ id: String(j.id), kind: j.kind, subject: j.subject });
    else if (r.needs_source) needs_source.push({ ...brief(j), ...r.needs_source, instruction: r.instruction });
    else if (r.failed) started.push({ id: String(j.id), kind: j.kind, subject: j.subject, failed: r.failed });
    else if (r.error) refused.push({ id: String(j.id), code: r.error.code, message: r.error.message });
  }
  // A job that can never start (a source the cli lacks, an unknown kind) is ended here, not retried every 15 minutes.
  for (const f of refused.filter(x => PERMANENT.has(x.code))) await endJob(deps, f.id, `failed: ${f.code}. ${f.message}`);
  const stuck = refused.filter(x => !PERMANENT.has(x.code));
  return { ok: true, started, needs_source, refused: stuck, settled, waiting: Math.max(fresh.length - started.length - needs_source.length - refused.length, 0), notify: needs_source.length > 0 || stuck.length > 0, wake: false };
}
const PERMANENT = new Set(['unknown_source', 'unsupported_product', 'unsupported_kind', 'invalid_request', 'unknown_novel', 'source_mismatch']);

async function endJob(deps, id, detail) {
  const sent = await insertItem(deps, 'catalog_job_events', { job_id: id, state: 'failed', detail: short(detail, 480), at: iso(deps.now) });
  if (sent.ok) await setState(deps.store, `job:${id}`, { state: 'failed', ended_at: iso(deps.now) });
  return sent.ok;
}

/** The command a plain crawl runs (kept for the README forms): `crawl catalog run`, or radar for a bare refresh. */
export function commandFor(kind, { source, novel, chapters }) {
  if (kind === 'crawl') return crawlArgv({ source, novel });
  if (kind === 'refresh' && source !== 'request' && !chapters) return radarArgv(source, [novel]);
  return null;
}

/** What the builder is told when a request's link is not in the catalog: the one judgment left in a job. */
export function sourceInstruction(job, res) {
  const link = res.source_url ?? job.source_url;
  return `Request ${job.request_id ?? job.id} (${short(job.title, 80)}) gives the link ${link}, which the cli catalog has never seen, so ${res.source_hint ? `its source pack is ${res.source_hint} (the link's host) and ` : ''}the novel id is not derivable. ` +
    `Find the novel in the source pack ${res.source_hint ? '' : 'for that host (cli/data/sources/*/config.json base_url) '}by the link alone, never by a title search. If the cli has no catalog row for it, seed one ` +
    `(cli/README.md 2b: npx tsx src/index.ts crawl catalog meta --source <source> --novel <novel> --vi-title "<title>" --landing-url "${link}"). ` +
    `Then run lohi-ops_catalog_job_run {job_id: "${job.id}", source, novel}. Cannot tell which novel the link is: do nothing, the job ends "no source" in ${NEEDS_SOURCE_HOURS} hours and the requesters get their LT back.`;
}

// ---------- opening a job from a request (curator) ----------
const CHAPTERS = /^(\d{1,6})-(\d{1,6})$/;
export function parseJobInput(requestId, kind, input) {
  const title = short(input.title, 200);
  if (!title) fail('invalid_request', 'title is the request title.');
  const sourceUrl = input.source_url ? String(input.source_url).trim().slice(0, 500) : '';
  if (sourceUrl && !/^https?:\/\/[^\s]+$/.test(sourceUrl)) fail('invalid_request', 'source_url is an http(s) link.');
  const novelSlug = input.novel_slug ? String(input.novel_slug) : '';
  if (novelSlug && !/^[a-z0-9-]{1,100}$/.test(novelSlug)) fail('invalid_request', 'novel_slug is a novel slug (a-z, 0-9, -).');
  if (kind === 'refresh' && !novelSlug) fail('invalid_request', 'a refresh names the novel_slug it refreshes.');
  const chapters = input.chapters ? String(input.chapters) : '';
  const m = CHAPTERS.exec(chapters);
  if (chapters && (!m || Number(m[1]) > Number(m[2]))) fail('invalid_request', 'chapters is "<from>-<to>".');
  const source = input.source ? String(input.source) : '';
  if (source && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) fail('invalid_request', 'source is a cli source slug.');
  return { request_id: requestId, kind, title, source_url: sourceUrl, novel_slug: novelSlug, chapters, source };
}

/**
 * The catalog job a request asks for. A refresh of a novel that exists is approved on the spot (it only adds chapters
 * to a published novel). An onboard of a new novel waits as `requested` until the daily card is answered, unless
 * `approvedBy` names the policy that already approved it (`policy:auto_onboard`: the request reached the api's score).
 * One open job per request.
 */
export async function openJob(deps, job, { approvedBy = null } = {}) {
  const { store, now } = deps;
  if (!store) return null;
  const same = (await store.query('catalog_jobs', [eq('request_id', job.request_id)], { order: 'updated_at', limit: 10 })).find(r => OPEN.includes(r.state));
  if (same) return { id: same.id, state: same.state, duplicate: true };
  const state = job.kind === 'refresh' || approvedBy ? 'approved' : 'requested';
  const reason = short(`Yêu cầu ${job.request_id}: ${job.title}${job.source ? ` [nguồn ${job.source}]` : ''}`, 300);
  const id = await store.insert('catalog_jobs', {
    product: 'lohi', kind: job.kind, subject: `request/${job.request_id}${job.kind === 'refresh' && job.chapters ? `#${job.chapters}` : ''}`, reason, state,
    approved_by: state === 'approved' ? (approvedBy ?? 'policy:refresh') : null, request_id: job.request_id, title: job.title, source_url: job.source_url || null,
    novel_slug: job.novel_slug || null, chapters: job.chapters || null, at: iso(now),
  });
  return { id, state, kind: job.kind };
}

function defaultSpawn(_argv, { cwd, dir, fsx, plan, env }) {
  // A detached node process interprets the plan: argv arrays, no shell, a log, then result.json and the exit file
  // (its presence IS "finished").
  const runner = join(dirname(fileURLToPath(import.meta.url)), '..', 'job-runner.mjs');
  const child = spawn(process.execPath, [runner, dir], { cwd, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(env?.CLI_CATALOG_DB ? { CLI_CATALOG_DB: env.CLI_CATALOG_DB } : {}) } });
  child.unref();
  return child.pid;
}

/** Write the plan and start the detached interpreter (a test injects `spawnJob`). Answers the pid. */
export async function launch(deps, { cwd, dir, plan }) {
  const fsx = deps.fsImpl ?? fsp;
  await fsx.mkdir(dir, { recursive: true });
  if (!deps.spawnJob) await fsx.writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
  return (deps.spawnJob ?? defaultSpawn)(plan.steps?.[0]?.argv ?? plan.onboard_argv, { cwd, dir, fsx, plan, env: deps.env });
}

/** Why a model-free job ended before it started (a source it cannot name): one `failed` event, with the cause the api understands. */
async function failBeforeStart(deps, job, detail, extra = {}) {
  await setState(deps.store, `job:${job.id}`, { state: 'failed', kind: job.kind, started_at: iso(deps.now), ended_at: iso(deps.now) });
  await insertItem(deps, 'catalog_job_events', { job_id: String(job.id), state: 'failed', detail: short(detail, 480), at: iso(deps.now) });
  return { ok: true, executed: false, failed: extra.code ?? 'failed', job: { id: String(job.id), kind: job.kind, subject: job.subject }, detail: short(detail, 200) };
}

const SOURCE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/, NOVEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Start ONE approved job of this Mac. `pick` is a resolved {source, novel} (the answer to `needs_source`). */
export async function startJob(deps, job, pick = null) {
  const { store, env, now } = deps;
  const id = String(job.id);
  if (job.product !== 'lohi') return { ok: false, error: { code: 'unsupported_product', message: `The crawler works on lohi only, not ${short(job.product, 20)}.` } };
  if (!KINDS.includes(job.kind)) return { ok: false, error: { code: 'unsupported_kind', message: 'Unknown job kind.' } };
  const was = await getState(store, `job:${id}`);
  if (was && was.state !== 'needs_source') return { ok: true, skipped: true, reason_code: 'already_started', notify: false, wake: false };
  const parts = parseSubject(job.subject, job.kind);
  const cli = env.CLI_DIR;
  if (!cli || !cli.startsWith('/')) return { ...skippedFor('CLI_DIR'), reason: 'no_cli_dir' };
  const fsx = deps.fsImpl ?? fsp;
  let target = { source: parts.source, novel: parts.novel };
  let prodSlug = job.novel_slug || null;
  const needsCatalog = parts.source === 'request' || pick;
  if (needsCatalog) {
    let db;
    try { db = await openCatalog(deps, env.CLI_CATALOG_DB || join(cli, 'data', 'catalog.db')); }
    catch { return { ok: false, error: { code: 'catalog_unreadable', message: 'The cli catalog could not be opened (CLI_CATALOG_DB).' } }; }
    try {
      if (pick) {
        if (!SOURCE_SLUG.test(String(pick.source ?? '')) || !NOVEL_SLUG.test(String(pick.novel ?? ''))) fail('invalid_request', 'source and novel are the cli slugs.');
        const row = db.prepare('SELECT 1 AS x FROM source_catalog WHERE source_slug = ? AND novel_slug = ?').get(pick.source, pick.novel);
        if (!row) return { ok: false, error: { code: 'unknown_novel', message: `The cli catalog has no ${pick.source}/${pick.novel}; seed it with crawl catalog meta first.` } };
        // The picked source must be the link's own site: a request link never turns into a different site's novel.
        if (job.source_url && await sourceForHost(job.source_url, { fsx, cliDir: cli }) !== pick.source) return { ok: false, error: { code: 'source_mismatch', message: 'The source is not the one the request link belongs to.' } };
        target = { source: pick.source, novel: pick.novel };
      } else {
        const res = await resolveJob(job, parts, { db, fsx, cliDir: cli });
        if (res.unresolved === 'no_source') return failBeforeStart(deps, job, `no source: ${res.why}${res.candidates ? ` (${res.candidates.join(', ')})` : ''}. The request names no link and its title does not match exactly one catalog novel.`, { code: 'no_source' });
        if (res.unresolved === 'needs_source') {
          if (!was) {
            await setState(store, `job:${id}`, { state: 'needs_source', kind: job.kind, started_at: iso(now) });
            await insertItem(deps, 'catalog_job_events', { job_id: id, state: 'running', detail: 'Waiting for the source of the request link.', at: iso(now) });
          }
          return { ok: true, executed: false, needs_source: { why: res.why, ...(res.source_hint ? { source_hint: res.source_hint } : {}) }, instruction: sourceInstruction(job, res), job: { id, kind: job.kind, subject: job.subject } };
        }
        target = { source: res.source, novel: res.novel };
      }
    } finally { try { db.close(); } catch { /* read-only */ } }
  }
  const known = await fsx.stat(join(cli, 'data', 'sources', target.source, 'config.json')).then(() => true, () => false);
  if (!known) return { ok: false, error: { code: 'unknown_source', message: `The cli has no source pack "${target.source}".` } };
  // A refresh names the prod novel: when the catalog slug differs, onboard needs --prod-slug.
  const chapters = parts.chapters ?? (job.chapters || null);
  let plan;
  try { plan = planFor(job.kind, { ...target, chapters: ['refresh', 'repair'].includes(job.kind) ? chapters : null }, job, { prodSlug: job.kind === 'refresh' ? prodSlug : null }); }
  catch (e) { fail('invalid_request', `The job cannot be planned: ${e.message}.`); }
  const pid = await launch(deps, { cwd: cli, dir: jobDir(env, id), plan });
  await setState(store, `job:${id}`, { state: 'running', kind: job.kind, started_at: iso(now), pid: pid ?? null, source: target.source, novel: target.novel });
  if (!was) await insertItem(deps, 'catalog_job_events', { job_id: id, state: 'running', detail: `${job.kind} ${target.source}/${target.novel} started`, at: iso(now) });
  return { ok: true, executed: true, job: { id, kind: job.kind, subject: job.subject }, resolved: `${target.source}/${target.novel}`, note: 'Running detached; catalog_jobs_pull reports how it ended.' };
}

/** Run ONE approved job by id; `source` + `novel` answer a `needs_source`. */
export async function catalog_job_run(input, deps) {
  const id = String(input.job_id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('invalid_request', 'job_id is the id catalog_jobs_pull returned.');
  const got = await approvedJobs(deps);
  if (got.reason) return unreadable(got.reason);
  const job = got.jobs.find(j => String(j.id) === id);
  // Only a job the operations team approved: a model cannot invent one.
  if (!job) return { ok: false, error: { code: 'not_approved', message: 'No approved job with this id on the operations team.' } };
  const pick = input.source !== undefined || input.novel !== undefined ? { source: input.source, novel: input.novel } : null;
  return startJob(deps, job, pick);
}

/** The end of a job that Claude Code ran on the builder's instruction (onboard / repair). */
export async function catalog_job_report(input, deps) {
  const { store, now } = deps;
  const id = String(input.job_id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) fail('invalid_request', 'job_id is the id catalog_jobs_pull returned.');
  if (!['done', 'failed', 'blocked_copyright'].includes(input.state)) fail('invalid_request', 'state is done, failed or blocked_copyright.');
  const local = await getState(store, `job:${id}`);
  if (!local) return { ok: false, error: { code: 'unknown_job', message: 'This Mac never started that job.' } };
  if (local.state === 'done' || local.state === 'failed') return { ok: true, skipped: true, reason_code: 'already_reported', notify: false, wake: false };
  const detail = short(input.detail ?? '', 500);
  const row = { job_id: id, state: input.state, detail, at: iso(now) };
  if (input.novel_slug !== undefined) {
    if (!/^[a-z0-9-]{1,100}$/.test(String(input.novel_slug))) fail('invalid_request', 'novel_slug is a novel slug (a-z, 0-9, -).');
    row.novel_slug = String(input.novel_slug);
  }
  if (input.chapters !== undefined) {
    if (!/^\d{1,6}-\d{1,6}$/.test(String(input.chapters))) fail('invalid_request', 'chapters is "<from>-<to>".');
    row.chapters = String(input.chapters);
  }
  if (input.state === 'blocked_copyright') {
    if (!input.copyright) fail('invalid_request', 'blocked_copyright says the match (copyright).');
    row.copyright = short(input.copyright, 300);
  } else if (input.state === 'done' && ['onboard', 'refresh'].includes(local.kind) && !row.novel_slug) fail('invalid_request', 'a done onboard or refresh names the novel_slug and chapters.');
  const sent = await insertItem(deps, 'catalog_job_events', row);
  if (!sent.ok) return unreadable(sent.reason);
  await setState(store, `job:${id}`, { ...local, state: input.state, ended_at: iso(now) });
  return { ok: true, job_id: id, state: input.state };
}
