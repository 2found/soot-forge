import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { remediate } from '../tools/remediate.mjs';

const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
const ENV = { SERVER_CARE_REMEDIATE: JSON.stringify({ url: 'https://ops.example/remediate', key: 'k' }) };
const input = { service: 'api', action: 'restart', reason: 'readiness failed three times' };

test('the pack declares alert_triaged and a remediation that waits for an operator', () => {
  assert.deepEqual(pack.outcomes.map(o => o.id), ['alert_triaged']);
  const tool = pack.tools.find(t => t.name === 'remediate');
  assert.equal(tool.run.approval, 'operator');
  assert.equal(tool.run.preflight, true);
  assert.notEqual(tool.run.mode, 'read');
});

test('preflight describes the call and sends nothing; the approved call posts once', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ result: 'ok' })); };
  assert.deepEqual(await remediate({ hook: 'tool.preflight', input }, ENV, fetchImpl), { preview: 'restart api: readiness failed three times' });
  assert.equal(calls, 0);
  const out = await remediate({ hook: 'tool.call', input }, ENV, fetchImpl);
  assert.equal(out.done, true);
  assert.equal(calls, 1);
});

test('bad input, a non-HTTPS target and a failing endpoint are refused', async () => {
  for (const bad of [{ ...input, service: 'a b' }, { ...input, action: 'rm -rf' }, { ...input, reason: '' }]) {
    await assert.rejects(remediate({ hook: 'tool.call', input: bad }, ENV, async () => new Response('{}')));
  }
  await assert.rejects(remediate({ hook: 'tool.call', input }, { SERVER_CARE_REMEDIATE: '{"url":"http://ops.example"}' }, async () => new Response('{}')));
  await assert.rejects(remediate({ hook: 'tool.call', input }, ENV, async () => new Response('{}', { status: 500 })));
});
