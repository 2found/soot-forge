// server-care `remediate`: ask the operator's remediation endpoint to restart or
// reload one named service. The pack declares `run.approval: operator`, so the
// host holds each call until a person approves that exact input in Nest; this
// script never runs before then. With hook `tool.preflight` it only describes
// what it would ask. Credentials arrive only as SERVER_CARE_REMEDIATE.
import { pathToFileURL } from 'node:url';

const SERVICE = /^[A-Za-z0-9._@:-]{1,64}$/, ACTIONS = ['restart', 'reload'];

class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };

export function parseTarget(raw) {
  let c;
  try { c = JSON.parse(raw ?? ''); } catch { refuse('SERVER_CARE_REMEDIATE is not valid JSON.'); }
  let url;
  try { url = new URL(c?.url); } catch { refuse('SERVER_CARE_REMEDIATE.url must be an HTTPS address.'); }
  if (url.protocol !== 'https:') refuse('SERVER_CARE_REMEDIATE.url must be an HTTPS address.');
  return { url: url.href, key: typeof c.key === 'string' ? c.key : '' };
}

export function checkInput(input) {
  if (!SERVICE.test(input?.service ?? '')) refuse('service is 1-64 letters, digits or . _ @ : -');
  if (!ACTIONS.includes(input?.action)) refuse('action is restart or reload.');
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > 300) refuse('reason is 1-300 characters.');
  return { service: input.service, action: input.action, reason };
}

export async function remediate(ctx, env, fetchImpl = fetch) {
  const input = checkInput(ctx.input);
  const preview = `${input.action} ${input.service}: ${input.reason}`;
  if (ctx.hook === 'tool.preflight') { parseTarget(env.SERVER_CARE_REMEDIATE); return { preview }; }
  const target = parseTarget(env.SERVER_CARE_REMEDIATE);
  const res = await fetchImpl(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}) },
    // Under the pack's 60s run timeout, so a hung endpoint ends this call, not the run.
    body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) refuse(`The remediation endpoint answered ${res.status}.`);
  const body = await res.json().catch(() => ({}));
  return { done: true, service: input.service, action: input.action, result: typeof body?.result === 'string' ? body.result.slice(0, 500) : '' };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    const ctx = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    process.stdout.write(JSON.stringify(await remediate(ctx, process.env)) + '\n');
  } catch (e) {
    process.stderr.write((e instanceof Refusal ? e.message : 'The remediation could not be requested.') + '\n');
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
