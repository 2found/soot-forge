import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8'));
const tools = Object.fromEntries(Object.values(pack.capabilities).flatMap(c => c.tools ?? []).map(t => [t.name, t]));
const ajv = new Ajv({ strict: false, validateFormats: false });
const accepts = (tool, input) => ajv.compile(tools[tool].parameters)(input);

// The hub contract (2found.dev api, POST /api/hub/v1/tool) routes on these
// tool names; the browser poster's tools live in its own pack.
const HUB = ['cms_list', 'cms_read', 'cms_save', 'cms_publish', 'social_channels', 'social_queue', 'social_list', 'social_update', 'social_publish', 'social_record', 'radar_feeds', 'radar_scan', 'radar_items', 'radar_mark', 'content_stats'];
const READS = ['cms_list', 'cms_read', 'social_channels', 'social_list', 'radar_feeds', 'radar_items', 'content_stats'];

test('the capabilities are the team roles, and every hub tool is in exactly one', () => {
  assert.deepEqual(Object.keys(pack.capabilities), ['radar', 'write', 'edit', 'publish', 'measure']);
  assert.deepEqual(Object.keys(tools).sort(), [...HUB].sort());
  assert.deepEqual(pack.capabilities.publish.tools.map(t => t.name), ['cms_publish', 'social_publish', 'social_record']);
  assert.deepEqual(pack.capabilities.measure.tools.map(t => t.name), ['content_stats']);
  assert.equal(pack.capabilities.edit.tools, undefined, 'review is a skill, not a tool');
});

test('every tool forwards to the hub through the MARKETING_HUB binding and nothing else', () => {
  for (const [name, t] of Object.entries(tools)) {
    assert.equal(t.run.program, 'soot', name);
    assert.deepEqual(t.run.args, ['tool-forward', '--binding-env', 'MARKETING_HUB'], name);
    assert.deepEqual(t.run.secret_env, { MARKETING_HUB: '{{cred:MARKETING_HUB}}' }, name);
    assert.equal(t.run.resource, 'marketing_hub', name);
    assert.equal(t.run.stdin, 'context', name);
    assert.equal(t.run.mode, READS.includes(name) ? 'read' : 'write', name);
    assert.equal(t.parameters.additionalProperties, false, name);
    assert.ok(t.title && t.description, name);
  }
});

test('a site is any hub site id, so one pack serves every product', () => {
  for (const site of ['lohi', '2novel', 'my-shop']) assert.ok(accepts('cms_list', { site }), site);
  for (const site of ['Lohi', '../x', 'a--b', '', 'x'.repeat(65)]) assert.ok(!accepts('cms_list', { site }), site);
  assert.ok(accepts('social_queue', { request_id: '7d0c7d55-1f7a-4d36-a2c2-6f0cba5ad2a1', channel: 'x', language: 'vi', text: 'Xin chào', source: { site: 'lohi', slug: 'chuong-moi' } }));
});

test('content_stats takes an optional site and a bounded window', () => {
  assert.ok(accepts('content_stats', {}));
  assert.ok(accepts('content_stats', { site: 'lohi', days: 30 }));
  for (const days of [0, 91, 1.5]) assert.ok(!accepts('content_stats', { days }), String(days));
  assert.ok(!accepts('content_stats', { visits: true }));
});

test('publishing still binds the reviewed revision', () => {
  assert.ok(!accepts('cms_publish', { site: 'lohi', slug: 'a', title: 'A' }), 'revision is required');
  assert.ok(!accepts('social_publish', { id: 'SP-0000000A', channel: 'x', text: 't' }), 'expected_revision is required');
  // The hub checks a publish without posting (tool.preflight): dry runs and an approval card see why it would fail.
  for (const name of ['cms_publish', 'social_publish']) assert.equal(tools[name].run.preflight, true, name);
});

test('the pack is product-neutral: brands live in each product\'s own skill', () => {
  const files = [join(root, 'pack.json'), ...Object.values(pack.capabilities).flatMap(c => c.skills).map(s => join(root, s.file))];
  for (const file of files) {
    assert.ok(existsSync(file), file);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /2found|2novel|lohi|trysoot|FOUND_HUB|found_hub/i, file);
  }
});

test('the role skills work on tasks, team tables and team memory', () => {
  const read = name => readFileSync(join(root, 'skills', `${name}.md`), 'utf8');
  assert.match(read('radar'), /`signals`/);
  assert.match(read('write'), /`content`[\s\S]*`review`/);
  assert.match(read('edit'), /learn/);
  assert.match(read('publish'), /report_blocker/);
  assert.match(read('measure'), /`visits`[\s\S]*null/);
  for (const name of ['radar', 'write', 'edit', 'measure']) assert.match(read(name), /team\.brief|team memory/, name);
});
