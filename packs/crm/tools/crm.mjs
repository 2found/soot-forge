// Micro-CRM tools: `node tools/crm.mjs <name>` reads the soot/v1 ToolContext
// on stdin and writes one JSON output. Storage is this pack's own (`pack:crm`)
// on the runtime that runs the call; other runtimes reach it only through a
// team contract (the provided `pipeline` table and the `crm_inbox` queue).
import { pathToFileURL } from 'node:url';
import { storage, CrmError } from './lib/store.mjs';
import * as ops from './lib/ops.mjs';

export const TOOLS = {
  contact_find: ops.contact_find, contact_save: ops.contact_save, contact_merge: ops.contact_merge, contact_forget: ops.contact_forget,
  lead_record: ops.lead_record, touch_record: ops.touch_record, deal_update: ops.deal_update,
  followups_due: ops.followups_due, pipeline_report: ops.pipeline_report, inbox_file: ops.inbox_file,
};

/** Run one tool; tests pass `store` and `now`. */
export async function run(name, ctx, { env = process.env, store, now = Date.now(), fetchImpl = fetch } = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new CrmError('invalid_request', `Unknown tool ${name}.`);
  if (ctx?.api_version && ctx.api_version !== 'soot/v1') throw new CrmError('invalid_request', `Unsupported api_version ${ctx.api_version}.`);
  if (ctx?.hook && ctx.hook !== 'tool.call') throw new CrmError('invalid_request', `Unsupported hook ${ctx.hook}.`);
  return tool(ctx?.input ?? {}, {
    store: store ?? storage(env, fetchImpl), now,
    product: ctx?.product || env.SOOT_PRODUCT || null,
    principal: ctx?.principal ?? null,
    soot: ctx?.soot ?? null,
    readOnly: ctx?.read_only === true,
  });
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_000_000) throw new CrmError('invalid_request', 'Input too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function main(name) {
  try {
    process.stdout.write(JSON.stringify(await run(name, await readStdin())) + '\n');
  } catch (e) {
    const known = e instanceof CrmError;
    process.stdout.write(JSON.stringify({ error: { code: known ? e.code : 'failed', message: known ? e.message : 'The CRM tool could not complete the request.' } }) + '\n');
    if (!known || e.code === 'storage_unavailable' || e.code === 'storage_failed') process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
