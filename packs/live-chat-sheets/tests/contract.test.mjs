import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeToolCall, validateToolCall, encodeToolCall, validatePack, decodePack, encodeOutput, ContractError, packSchema, toolCallSchema } from '../sdk/contract.mjs';
import { readToolCall } from '../sdk/tool.mjs';

const call = { api_version: 'soot/v1', hook: 'tool.call', soot: 'helper', root: 'helper', operation: 'sample_inspect', event: { id: '1', source: 'conversation', subject: 'untrusted', text: 'Inspect' }, input: { query: 'Xin chào' } };
test('wire codec roundtrip preserves forward-compatible fields', () => {
  const expanded = { ...call, future: { version: 2 }, case_id: 'legacy', event: { ...call.event, extra: true } };
  assert.deepEqual(decodeToolCall(encodeToolCall(expanded)), expanded);
  assert.equal(decodeToolCall(encodeToolCall({ ...call, input: null })).input, null);
});
test('version, hook, missing fields, types, non-JSON and concatenated input fail without echo', () => {
  for (const bad of [ { ...call, api_version: 'soot/v2' }, { ...call, hook: 'other' }, { ...call, event: null }, { ...call, soot: 42 }, { ...call, input: NaN }, { ...call, input: undefined }, { ...call, event: { ...call.event, text: 1 } } ]) assert.throws(() => validateToolCall(bad), ContractError);
  assert.throws(() => decodeToolCall(JSON.stringify(call) + '{}'), ContractError);
  assert.throws(() => decodeToolCall('secret-not-json'), error => !error.message.includes('secret-not-json'));
});
test('UTF-8 input and envelope bounds', () => {
  assert.throws(() => encodeToolCall({ ...call, input: 'ấ'.repeat(6000) }), ContractError);
  assert.throws(() => decodeToolCall(' '.repeat(128 * 1024 + 1)), ContractError);
  assert.throws(() => encodeOutput('x'.repeat(64 * 1024)), ContractError);
  assert.throws(() => encodeOutput({ nope: undefined }), ContractError);
});
test('bounded stdin reader handles chunks and rejects invalid UTF-8/oversize', async () => {
  const data = new TextEncoder().encode(encodeToolCall(call));
  async function* chunks() { for (let i = 0; i < data.length; i++) yield data.subarray(i, i + 1); }
  assert.deepEqual(await readToolCall(chunks()), call);
  async function* large() { yield new Uint8Array(128 * 1024 + 1); }
  async function* invalid() { yield new Uint8Array([255]); }
  await assert.rejects(() => readToolCall(large()));
  await assert.rejects(() => readToolCall(invalid()));
});
test('manifest shape is strict at every level and accepts Go defaults/null recipe', () => {
  const pack = { id: 'sample', api_version: 'soot/v1', tools: [{ name: 'inspect', run: { program: 'tools/inspect.mjs', stdin: 'context', mode: 'read' } }] };
  assert.deepEqual(decodePack(JSON.stringify(pack)), pack);
  const typed = structuredClone(pack);
  typed.tools[0].description = 'Inspect status';
  typed.tools[0].parameters = { type: 'object', properties: { service: { type: 'string', enum: ['api'] } }, required: ['service'], additionalProperties: false };
  assert.deepEqual(decodePack(JSON.stringify(typed)), typed);
  for (const bad of [ { ...pack, credentials: {} }, { ...pack, capabilities: {} }, { ...pack, use: [] }, { ...pack, tools: [{ name: 'inspect', mission: 'evil' }] }, { ...pack, tools: ['inspect'] }, { ...pack, skills: Array(129).fill({ file: 'skills/s.md' }) } ]) assert.throws(() => validatePack(bad), ContractError);
  assert.throws(() => validatePack({ tools: [{ name: 'inspect', run: { program: 'node', args: [1] } }] }), ContractError);
});
test('contract entrypoint has no client or node dependencies', () => {
  const source = readFileSync(new URL('../sdk/contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:node:|\.\/client|\.\/tool)/);
});
test('generated schema constraints are all supported by the codec', () => {
  const supported = new Set(['type', 'const', 'properties', 'required', 'additionalProperties', 'items', 'pattern', 'minLength', 'minItems', 'maxItems', 'maxProperties', 'maxLength', 'enum', 'uniqueItems', 'minimum', 'maximum', '$schema', 'title', 'description']);
  const walk = schema => {
    for (const key of Object.keys(schema)) assert(supported.has(key), `Extend codec for new schema keyword ${key}`);
    for (const child of Object.values(schema.properties ?? {})) walk(child);
    if (schema.items) walk(schema.items);
    if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties);
  };
  walk(packSchema); walk(toolCallSchema);
});
test('real executable returns JSON on stdout, fails safely on invalid input', () => {
  const program = new URL('./inspect.mjs', import.meta.url);
  const good = spawnSync(process.execPath, [program.pathname], { input: encodeToolCall(call), encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).characters, 8);
  const bad = spawnSync(process.execPath, [program.pathname], { input: '{"secret":"never-leak"}', encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, ''); assert.doesNotMatch(bad.stderr, /never-leak/);
});
