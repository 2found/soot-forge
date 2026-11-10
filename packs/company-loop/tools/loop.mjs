// company-loop tools: `node tools/loop.mjs <name>` reads the ToolContext on stdin and writes one
// JSON output. Storage is this pack's own (`pack:company-loop`); the product and CS
// addresses are operator env, never tool input.
import { pathToFileURL } from 'node:url';
import { storage, LoopError, fail } from './lib/base.mjs';
import { scoreboard_sync, metrics_record } from './lib/scoreboard.mjs';
import { signals } from './lib/signals.mjs';
import { digest_save, decide, topic_next, topic_sync, opportunities_card } from './lib/opportunities.mjs';
import { team_watch } from './lib/watch.mjs';
import { review } from './lib/review.mjs';
import { page_view, page_action } from './lib/page.mjs';
import { health_sync } from './lib/health.mjs';
import { parts_set } from './lib/parts.mjs';

export const TOOLS = {
  scoreboard_sync, metrics_record, signals, digest_save, opportunities_card, topic_next, topic_sync, team_watch, review, page_view, page_action, health_sync, parts_set,
  // Through MCP or an approval card: the operator who approves is the decider.
  decide: (input, deps) => decide(input, deps, { by: 'operator' }),
};

export async function run(name, ctx, { env = process.env, store, now = Date.now(), fetchImpl = fetch, apiTimeoutMs } = {}) {
  const tool = TOOLS[name];
  if (!tool) fail('invalid_request', `Unknown tool ${name}.`);
  return tool(ctx?.input ?? {}, { store: store ?? storage(env, fetchImpl), now, env, fetch: fetchImpl, apiTimeoutMs, soot: ctx?.soot ?? null, page: ctx?.page?.page ?? null });
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
    const known = e instanceof LoopError;
    process.stdout.write(JSON.stringify({ error: { code: known ? e.code : 'failed', message: known ? e.message : 'The company-loop tool could not complete the request.' } }) + '\n');
    if (!known) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
