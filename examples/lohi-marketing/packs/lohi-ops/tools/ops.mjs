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

export const TOOLS = { catalog_health, crawl_watch, comments_pull, comments_decide, comments_resolve, appstore_sync, appstore_draft, appstore_drafts, appstore_post, seo_report, pricing_report };

export async function run(name, ctx, { env = process.env, store, now = Date.now(), fetchImpl = fetch, apiTimeoutMs, openDb } = {}) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) fail('invalid_request', `Unknown tool ${name}.`);
  const needsStore = !['seo_report', 'pricing_report'].includes(name);
  return tool(ctx?.input ?? {}, { store: store ?? (needsStore ? storage(env, fetchImpl) : null), now, env, fetch: fetchImpl, apiTimeoutMs, openDb });
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
