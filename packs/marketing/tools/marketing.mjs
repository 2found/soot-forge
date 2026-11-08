// Hubless marketing tools: `node tools/marketing.mjs <name>` reads the
// ToolContext on stdin and writes one JSON output. Storage is this pack's own
// (`pack:marketing`); nothing here forwards to a hub.
import { pathToFileURL } from 'node:url';
import { storage, MarketingError } from './lib/store.mjs';
import * as ops from './lib/ops.mjs';
import { page_view, page_action, answer } from './lib/page.mjs';
import { video_import } from './lib/video.mjs';
import { campaign_save, campaign_report } from './lib/campaign.mjs';
import { plan } from './lib/plan.mjs';
import { channels_probe } from './lib/probe.mjs';
import { report } from './lib/report.mjs';

export const TOOLS = {
  draft_save: ops.draft_save, items: ops.items, check: ops.check, schedule: ops.schedule, due: ops.due,
  claim: ops.claim, record: ops.record, fail: ops.failIntent, pause: ops.pause,
  page_view, page_action, facts_sync: ops.facts_sync, gsc_sync: ops.gsc_sync, seo_brief: ops.seo_brief,
  channels_setup: ops.channels_setup, raised: ops.raised, answer, replies_sync: ops.replies_sync, reply_save: ops.reply_save,
  video_import, campaign_save, campaign_report, plan, channels_probe, report,
};

/** Run one tool; `deps` overrides the store, clock and fetch in tests. */
export async function run(name, ctx, { env = process.env, store, now = Date.now(), fetchImpl = fetch, apiTimeoutMs } = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new MarketingError('invalid_request', `Unknown tool ${name}.`);
  const input = ctx?.input ?? {};
  return tool(input, { store: store ?? storage(env, fetchImpl), now, env, fetch: fetchImpl, apiTimeoutMs, soot: ctx?.soot ?? ctx?.page?.soot ?? null, page: ctx?.page?.page ?? null, request_id: ctx?.request_id ?? input.request_id });
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) throw new MarketingError('invalid_request', 'Input too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** A person must sign in again: the host sign-in shape `{needs_person: {credential}}`
 * exits 1 (a decided refusal) so the host raises its sign-in item. `due` always
 * lists its needs_person items as an array, which is not that signal. */
export const signInExit = out => typeof out?.needs_person?.credential === 'string';

export async function main(name) {
  try {
    const out = await run(name, await readStdin());
    process.stdout.write(JSON.stringify(out) + '\n');
    if (signInExit(out)) process.exitCode = 1;
  } catch (e) {
    const known = e instanceof MarketingError;
    process.stdout.write(JSON.stringify({ error: { code: known ? e.code : 'failed', message: known ? e.message : 'The marketing tool could not complete the request.' } }) + '\n');
    if (!known) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
