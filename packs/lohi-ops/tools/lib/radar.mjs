// Auto-ingest of new chapters, tool-first: no model unless something fails.
//   radar_scan (builder Mac, schedule)  sweeps carried novels with the cli's own radar (one detached plan, argv arrays),
//                                       then reports the novels that gained chapters as `radar` events on the operations
//                                       queue `catalog_job_events` (the Mac cannot insert jobs, only events).
//   ingestRadar (curator, inside catalog_jobs_sync)  the policy: a novel with readers (the api's own count) gets ONE
//                                       `refresh` job, approved_by `policy:radar`, inside a daily cap. The builder runs it
//                                       (catalog_jobs_pull autorun), catalog_jobs_sync then queues the translation of
//                                       the chapters it added, and translate_step translates them within the api's caps.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { skippedFor, getState, setState, lohiApi, eq, inList, ictDay, iso, short } from './base.mjs';
import { insertItem, jobDir, launch } from './jobs.mjs';
import { openCatalog, maxChapter } from './resolve.mjs';
import { radarArgv, sweepable } from './runner.mjs';

/** The knobs of the policy, all of them cheap to change here (and mirrored in deployment.fragment.json). */
export const RADAR = {
  minActiveReaders: 1,     // a novel nobody read in the api's window is not worth a translation
  dailyJobs: 10,           // refresh jobs the policy may open per ICT day
  window: 50,              // chapters one job asks for: the last 50 of the source (onboard imports only what prod lacks)
  novelsPerSweep: 60,      // novels one sweep checks; the next sweep goes on from there, so every novel is visited
  novelsPerStep: 20,       // novels per radar command
  minGapHours: 2,          // between the end of a sweep and the start of the next
  staleHours: 3,           // a sweep that never wrote its exit file is given up
  maxEvents: 25,           // radar events one scan reports
  seenKeep: 3000, pendingKeep: 60,
};

export const isRadarEvent = e => e?.state === 'radar' && typeof e.job_id === 'string' && e.job_id.startsWith('radar:');
const KEY = /^([a-z0-9][a-z0-9-]{0,63})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const PROD_SLUG = /^[a-z0-9-]{1,100}$/;
const COMPLETED = /^(completed|complete|finished|full|done|hoan|hoàn|完本|完结|已完结|全本)/i;

// ---------- builder (Mac) ----------
/** Novels this Mac keeps current: synced to prod, no copyright flag, not finished, on a source that has radar. */
export function carried(db) {
  return db.prepare("SELECT source_slug AS source, novel_slug AS novel, status FROM source_catalog WHERE is_prd_sync = 1 AND COALESCE(copyright_issue, 0) = 0 AND source_slug <> 'metruyenchuvn' ORDER BY source_slug, novel_slug").all()
    .filter(r => !COMPLETED.test(String(r.status ?? '').trim()) && sweepable(r));
}

/** The plan of one sweep: one radar command per source (at most `novelsPerStep` novels each); a refused source does not stop the rest. */
export function sweepPlan(batch) {
  const by = new Map();
  for (const r of batch) by.set(r.source, [...(by.get(r.source) ?? []), r.novel]);
  const steps = [];
  for (const [source, novels] of by) for (let i = 0; i < novels.length; i += RADAR.novelsPerStep) {
    steps.push({ name: `radar ${source}`, argv: radarArgv(source, novels.slice(i, i + RADAR.novelsPerStep)), timeout_ms: 30 * 60_000 });
  }
  return { v: 1, kind: 'steps', stop_on_fail: false, steps };
}

const readText = (fsx, path) => fsx.readFile(path, 'utf8').then(s => s, () => null);

export async function radar_scan(input, deps) {
  const { store, env, now } = deps;
  const cli = env.CLI_DIR, dbPath = env.CLI_CATALOG_DB || (cli ? join(cli, 'data', 'catalog.db') : null);
  if (!cli || !cli.startsWith('/') || !dbPath) return skippedFor('CLI_DIR');
  const fsx = deps.fsImpl ?? fsp;
  const st = (await getState(store, 'radar')) ?? { phase: 'idle', offset: 0 };
  const quiet = (extra = {}) => ({ ok: true, ...extra, notify: false, wake: false });

  if (st.phase === 'running') {
    const exit = await readText(fsx, join(st.dir, 'exit'));
    if (exit === null) {
      if (now - Date.parse(st.started_at) < RADAR.staleHours * 3_600_000) return quiet({ running: true });
      await setState(store, 'radar', { ...st, phase: 'idle', ended_at: iso(now) });
      return { ok: true, failed: 'sweep did not finish', notify: true, wake: false };
    }
    const res = JSON.parse((await readText(fsx, join(st.dir, 'result.json'))) ?? '{}');
    if (res.state === 'failed') {
      await setState(store, 'radar', { ...st, phase: 'idle', ended_at: iso(now) });
      return { ok: true, failed: short(res.detail ?? 'radar failed', 200), notify: true, wake: false };
    }
    const seen = (await getState(store, 'radar_seen')) ?? {};
    const db = await openCatalog(deps, dbPath);
    const found = [];
    try {
      for (const { source, novel } of st.batch ?? []) {
        const key = `${source}/${novel}`;
        const row = db.prepare('SELECT has_new_chapters AS flag FROM source_catalog WHERE source_slug = ? AND novel_slug = ?').get(source, novel);
        const max = maxChapter(db, source, novel);
        if (!row || !max) continue;
        // First sight of a novel only sets its baseline; later, a flagged novel that grew is a find.
        if (Number(row.flag) === 1 && max > (seen[key] ?? 0)) found.push({ source, novel, max, key });
        else seen[key] = Math.max(seen[key] ?? 0, max);
      }
    } finally { try { db.close(); } catch { /* read-only */ } }
    const sent = [];
    for (const f of found.slice(0, RADAR.maxEvents)) {
      const r = await insertItem(deps, 'catalog_job_events', { job_id: `radar:${f.key}`, state: 'radar', detail: short(`chương mới tới ${f.max}`, 80), at: iso(now), novel_slug: f.novel, chapters: String(f.max) });
      if (!r.ok) break; // the rest is found again next sweep: it was never marked seen
      seen[f.key] = f.max;
      sent.push(f.key);
    }
    const keys = Object.keys(seen);
    for (const k of keys.slice(0, Math.max(keys.length - RADAR.seenKeep, 0))) delete seen[k];
    await setState(store, 'radar_seen', seen);
    await setState(store, 'radar', { ...st, phase: 'idle', ended_at: iso(now), found: sent.length });
    return quiet({ swept: (st.batch ?? []).length, found: sent });
  }

  // idle: start the next sweep when the gap has passed
  if (st.ended_at && now - Date.parse(st.ended_at) < RADAR.minGapHours * 3_600_000) return quiet({ waiting: true });
  const db = await openCatalog(deps, dbPath);
  let all;
  try { all = carried(db); } finally { try { db.close(); } catch { /* read-only */ } }
  if (!all.length) return quiet({ swept: 0 });
  const from = (st.offset ?? 0) % all.length;
  const batch = [...all.slice(from), ...all.slice(0, from)].slice(0, RADAR.novelsPerSweep).map(r => ({ source: r.source, novel: r.novel }));
  const dir = jobDir(env, `radar-${now}`);
  const pid = await launch(deps, { cwd: cli, dir, plan: sweepPlan(batch) });
  await setState(store, 'radar', { phase: 'running', dir, pid: pid ?? null, started_at: iso(now), offset: from + batch.length, batch });
  return quiet({ started: true, novels: batch.length });
}

// ---------- curator (the policy) ----------
const parse = e => {
  const m = KEY.exec(String(e.job_id).slice('radar:'.length));
  const max = Number(e.chapters);
  const slug = String(e.novel_slug ?? '');
  return m && Number.isInteger(max) && max >= 1 && max <= 999999 && PROD_SLUG.test(slug) ? { source: m[1], novel: m[2], slug, max } : null;
};

/**
 * Open the refresh job of each find that passes the policy. A find the api cannot judge now (no key, unreachable) waits
 * in `radar_policy.pending`; a find over the day's cap waits for tomorrow; a novel with no readers is dropped.
 */
export async function ingestRadar(deps, events) {
  const { store, now } = deps;
  const prev = (await getState(store, 'radar_policy')) ?? {};
  const day = ictDay(now);
  let used = prev.day === day ? prev.n ?? 0 : 0;
  const queue = new Map();
  for (const f of [...(prev.pending ?? []), ...events.map(parse).filter(Boolean)]) queue.set(`${f.source}/${f.novel}`, { ...f, max: Math.max(f.max, queue.get(`${f.source}/${f.novel}`)?.max ?? 0) });
  if (!queue.size) return { opened: 0, jobs: [], dropped: 0, waiting: 0, cap: RADAR.dailyJobs, used };
  const openJobs = (await store.query('catalog_jobs', [eq('kind', 'refresh'), inList('state', ['requested', 'approved', 'running'])], { order: 'updated_at', limit: 200 })).map(r => String(r.subject ?? ''));
  const opened = [], pending = [];
  let dropped = 0, apiDown = false;
  for (const f of queue.values()) {
    if (apiDown || used >= RADAR.dailyJobs) { pending.push(f); continue; }
    if (openJobs.some(x => x.startsWith(`${f.source}/${f.novel}#`))) { dropped++; continue; }
    const s = await lohiApi(deps, 'GET', `/novel/agent/novels/${f.slug}/litrans/status`);
    if (s.skipped || (s.error && s.error.code !== 'not_found' && s.error.code !== 'failed')) { apiDown = true; pending.push(f); continue; }
    if (s.error || !(Number(s.out?.active_readers) >= RADAR.minActiveReaders)) { dropped++; continue; }
    const range = `${Math.max(f.max - RADAR.window + 1, 1)}-${f.max}`;
    const id = await store.insert('catalog_jobs', { product: 'lohi', kind: 'refresh', subject: `${f.source}/${f.novel}#${range}`, reason: 'Nguồn có chương mới, truyện đang có độc giả (radar).',
      state: 'approved', approved_by: 'policy:radar', novel_slug: f.slug, chapters: range, at: iso(now) });
    used++;
    openJobs.push(`${f.source}/${f.novel}#${range}`);
    opened.push({ id, subject: `${f.source}/${f.novel}#${range}` });
  }
  await setState(store, 'radar_policy', { day, n: used, pending: pending.slice(0, RADAR.pendingKeep) });
  return { opened: opened.length, jobs: opened, dropped, waiting: pending.length, cap: RADAR.dailyJobs, used };
}
