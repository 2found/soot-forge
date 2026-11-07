// Hubless marketing tools: `node tools/marketing.mjs <name>` reads the
// ToolContext on stdin and writes one JSON output. Storage is this pack's own
// (`pack:marketing`); nothing here forwards to a hub.
import { pathToFileURL } from 'node:url';
import { storage, MarketingError } from './lib/store.mjs';
import * as ops from './lib/ops.mjs';
import { page_view, page_action } from './lib/page.mjs';

export const TOOLS = {
  draft_save: ops.draft_save, items: ops.items, check: ops.check, schedule: ops.schedule, due: ops.due,
  claim: ops.claim, record: ops.record, fail: ops.failIntent, pause: ops.pause,
  page_view, page_action, facts_sync: ops.facts_sync, gsc_sync: ops.gsc_sync, seo_brief: ops.seo_brief,
};

/** Run one tool; `deps` overrides the store, clock and fetch in tests. */
export async function run(name, ctx, { env = process.env, store, now = Date.now(), fetchImpl = fetch } = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new MarketingError('invalid_request', `Unknown tool ${name}.`);
  const input = ctx?.input ?? {};
  return tool(input, { store: store ?? storage(env, fetchImpl), now, env, fetch: fetchImpl, soot: ctx?.soot ?? ctx?.page?.soot ?? null, page: ctx?.page?.page ?? null, request_id: ctx?.request_id ?? input.request_id });
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

export async function main(name) {
  try {
    const out = await run(name, await readStdin());
    process.stdout.write(JSON.stringify(out) + '\n');
    // A person must sign in again: exit 1 (a decided refusal) so the host raises its sign-in item.
    if (out?.needs_person) process.exitCode = 1;
  } catch (e) {
    const known = e instanceof MarketingError;
    process.stdout.write(JSON.stringify({ error: { code: known ? e.code : 'failed', message: known ? e.message : 'The marketing tool could not complete the request.' } }) + '\n');
    if (!known) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
