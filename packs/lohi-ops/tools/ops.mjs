// lohi-ops tools: `node tools/ops.mjs <name>` reads the ToolContext on stdin and writes one JSON output.
// Storage is this pack's own; addresses and keys are operator env/credentials, never tool input.
import { pathToFileURL } from 'node:url';
import { storage, OpsError, fail } from './lib/base.mjs';
import { catalog_health } from './lib/catalog.mjs';
import { crawl_watch } from './lib/crawl.mjs';
import { comments_pull, comments_decide, comments_resolve } from './lib/comments.mjs';
import { appstore_sync, appstore_draft, appstore_drafts, appstore_post } from './lib/appstore.mjs';
import { seo_report } from './lib/seo.mjs';
import { pricing_report } from './lib/pricing.mjs';
import { requests_pending, request_accept, request_reject, edits_pending, edits_context, edit_verdict, violations_list, violation_resolve, enrichment_enqueue, quality_list, duplicates_scan, litrans_health, reports_open } from './lib/curator.mjs';
import { onboard_card, catalog_jobs_answer, catalog_jobs_decide, translate_start, translate_step, request_finish, fixes_pull, fix_execute, fix_ack, chapter_retranslate, chapter_tts, fix_recheck, fixes_run, fix_context, fix_resolve } from './lib/loop.mjs';
import { catalog_job_request, catalog_jobs_sync, catalog_jobs_pull, catalog_job_run, catalog_job_report } from './lib/jobs.mjs';
import { radar_scan } from './lib/radar.mjs';
import { quality_sample, quality_verdict, release_step } from './lib/release.mjs';

export const TOOLS = { catalog_health, crawl_watch, comments_pull, comments_decide, comments_resolve, appstore_sync, appstore_draft, appstore_drafts, appstore_post, seo_report, pricing_report,
  requests_pending, request_accept, request_reject, edits_pending, edits_context, edit_verdict, violations_list, violation_resolve, enrichment_enqueue, quality_list, duplicates_scan, litrans_health, reports_open,
  catalog_job_request, catalog_jobs_sync, catalog_jobs_pull, catalog_job_run, catalog_job_report, radar_scan,
  onboard_card, catalog_jobs_answer, catalog_jobs_decide, translate_start, translate_step, request_finish, fixes_pull, fix_execute, fix_ack, chapter_retranslate, chapter_tts, fix_recheck,
  fixes_run, fix_context, fix_resolve,
  quality_sample, quality_verdict, release_step };
/** Tools that never touch the pack's own tables. */
const NO_STORE = new Set(['seo_report', 'pricing_report', 'request_reject', 'edits_pending', 'edits_context', 'edit_verdict', 'violations_list', 'violation_resolve', 'enrichment_enqueue', 'quality_list', 'fixes_pull', 'reports_open', 'fix_context']);

/** The time a tool sees: the context's `now` or SOOT_NOW when a trial runtime moved its clock (soot flow advance), else the wall clock. */
const clockNow = (env, ctx) => { const t = Date.parse(ctx?.now ?? env?.SOOT_NOW ?? ''); return Number.isFinite(t) ? t : Date.now(); };

export async function run(name, ctx, { env = process.env, event, store, now = clockNow(env, ctx), fetchImpl = fetch, apiTimeoutMs, openDb, soot, spawnJob, fsImpl } = {}) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) fail('invalid_request', `Unknown tool ${name}.`);
  const needsStore = !NO_STORE.has(name);
  return tool(ctx?.input ?? {}, { tool: name, store: store ?? (needsStore ? storage(env, fetchImpl) : null), now, env, event: ctx?.event ?? event, fetch: fetchImpl, apiTimeoutMs, openDb, soot, spawnJob, fsImpl });
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
    const known = e instanceof OpsError;
    process.stdout.write(JSON.stringify({ error: { code: known ? e.code : 'failed', message: known ? e.message : 'The lohi-ops tool could not complete the request.' } }) + '\n');
    if (!known) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
