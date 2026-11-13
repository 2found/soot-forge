import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACK = join(import.meta.dirname, '..'), DRIVER = join(PACK, 'tools/driver.mjs');

// A stand-in for the runtime: `soot run --soot <id>` plays that Soot by calling
// the pack's tools the way the host would, with the caller named by the host.
const FAKE_SOOT = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { execute } = await import(${JSON.stringify(join(PACK, 'tools/world.mjs'))});
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const ws = join(arg('--config'), '..'), id = arg('--soot'), message = readFileSync(0, 'utf8');
const env = { SOOT_PACK_STATE: join(ws, 'data/pack-state/micro-fish') };
const call = (op, input) => execute({ api_version: 'soot/v1', soot: id, input }, op, env);
const out = state => { console.log(JSON.stringify({ state, conversation_id: process.argv.includes('--conversation') ? arg('--conversation') : 'conv-' + id, text: 'ok ' + id })); process.exit(state === 'completed' ? 0 : 1); };
if (process.env.FAKE_FAIL) out('failed');
if (process.env.FAKE_UNLOADED) { console.log(JSON.stringify({ state: '', diagnostics: [{ code: 'agent_selection_required' }] })); process.exit(1); }
const sim = /(?:Mã phiên|Session code|Mô phỏng|mô phỏng|session|simulation)[: ]+([a-z0-9_-]+)/i.exec(message)?.[1];
if (id.endsWith('-analyst')) out('completed');
if (id.endsWith('-expert')) { await call('expert', { sim, expert: /"([a-z0-9-]+)"/.exec(message)[1], lens: 'lens', findings: [{ severity: 'P1', issue: 'slow open', fix: 'cut it' }], coverage: 'text only' }); out('completed'); }
if (/micro-fish_answer/.test(message)) { await call('answer', { sim, answers: { clarity: 4, retell: 'nhớ là có một sát thủ', objections: ['ad-feel'] } }); out('completed'); }
const feed = await call('timeline', { sim });
if (feed.feed.length) await call('act', { sim, reactions: feed.feed.map(p => ({ post: p.post, attention: p.content === 'Bản A' ? 'full' : 'skip', share: p.content === 'Bản A' })) });
out('completed');
`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'micro-fish-driver-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, 'ws'), bin = join(root, 'bin');
  await mkdir(join(ws, 'soots'), { recursive: true }); await mkdir(bin);
  await writeFile(join(ws, 'deployment.json'), JSON.stringify({ data_dir: 'data', packs_dir: 'packs', workers: 1, soots: ['soots/sim-analyst/soot.json', 'soots/sim-expert/soot.json'] }));
  await writeFile(join(bin, 'soot'), FAKE_SOOT); await chmod(join(bin, 'soot'), 0o755);
  await writeFile(join(bin, 'package.json'), '{"type":"module"}');
  const brief = join(root, 'brief.json');
  await writeFile(join(root, 'a.md'), 'Bản A');
  await writeFile(brief, JSON.stringify({ sim: 'drive', goal: 'Bản nào đáng đăng', platform: 'TikTok', subjects: [{ id: 'a', account: 'kenh', file: 'a.md' }, { id: 'b', account: 'kenh', content: 'Bản B' }], audience: { n: 12, age: [18, 40] }, rounds: 2, experts: [{ id: 'editor', lens: 'Biên tập' }] }));
  const drive = (args, env = {}) => spawnSync(process.execPath, [DRIVER, ...args, '--workspace', ws], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MICRO_FISH_RETRY_WAITS: '0', ...env } });
  return { root, ws, brief, drive };
}

test('populate turns the audience into persona Soots once, each with only its own tools', async t => {
  const f = await workspace(t);
  const first = JSON.parse(f.drive(['populate', f.brief]).stdout);
  assert.deepEqual(first, { added: 12, personas: 12, selected: 12 });
  assert.equal(JSON.parse(f.drive(['populate', f.brief]).stdout).added, 0, 'the same brief meets the same people');
  const deployment = JSON.parse(await readFile(join(f.ws, 'deployment.json'), 'utf8'));
  assert.equal(deployment.soots.length, 14); assert.equal(deployment.workers, 8);
  const id = (await readdir(join(f.ws, 'soots')))[0], soot = JSON.parse(await readFile(join(f.ws, 'soots', id, 'soot.json'), 'utf8'));
  assert.deepEqual(soot.packs, ['micro-fish:tools=timeline,act,answer']);
  assert.match(soot.name, /^\p{Lu}\p{Ll}+ \p{Lu}/u, 'a person\'s name, not an id');
  const soul = await readFile(join(f.ws, 'soots', id, 'SOUL.md'), 'utf8');
  assert.match(soul, new RegExp(`^Bạn là ${soot.name}, \\d+ tuổi`)); assert.match(soul, /không phải trợ lý/);
  const bad = f.drive(['populate', f.brief.replace('brief.json', 'none.json')]);
  assert.notEqual(bad.status, 0);
});

test('run plays the rounds, interviews, experts and report, and can be read back', async t => {
  const f = await workspace(t); f.drive(['populate', f.brief]);
  const run = f.drive(['run', f.brief, '--out', join(f.root, 'runs')]);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(result.state, 'completed'); assert.equal(result.failed, 0); assert.match(run.stderr, /round 2\/2/);
  const tally = JSON.parse(await readFile(result.tally, 'utf8'));
  assert.equal(tally.complete, true); assert.equal(tally.population, 12);
  assert.equal(tally.subjects.a.full.pct, 100); assert.equal(tally.subjects.b.full.pct, 0);
  assert.equal(tally.subjects.a.interview.answered, tally.subjects.a.reached, 'everyone who met it was interviewed');
  assert.equal(tally.subjects.a.interview.retell.answers[0].attention, 'full');
  assert.ok(tally.subjects.a.spread.shares > 0); assert.equal(tally.experts.blocking.length, 1);
  assert.equal(await readFile(result.report, 'utf8'), 'ok sim-analyst\n');
  assert.equal(JSON.parse(f.drive(['tally', 'drive', '--by', 'age']).stdout).subjects.a.assigned, 6);
  assert.deepEqual(JSON.parse(f.drive(['sims']).stdout).sims.map(s => s.sim), ['drive']);
  const again = JSON.parse(f.drive(['run', f.brief, '--no-report']).stdout.trim().split('\n').pop());
  assert.equal(again.sessions, 0, 'a finished simulation is not played twice');
});

test('a run whose sessions fail stops where it is and resumes from the record', async t => {
  const f = await workspace(t); f.drive(['populate', f.brief]);
  const stopped = f.drive(['run', f.brief, '--no-report'], { FAKE_FAIL: '1' });
  assert.equal(stopped.status, 2);
  const why = JSON.parse(stopped.stdout.trim().split('\n').pop());
  assert.equal(why.state, 'stopped'); assert.equal(why.phase, 'round 1'); assert.equal(why.completed, 0);
  assert.equal(JSON.parse(f.drive(['tally', 'drive']).stdout).phase, 'feed', 'no interview on an unplayed feed');
  const resumed = JSON.parse(f.drive(['run', f.brief, '--no-report']).stdout.trim().split('\n').pop());
  assert.equal(resumed.state, 'completed');
  assert.equal(JSON.parse(f.drive(['tally', 'drive']).stdout).complete, true);
});

test('an audience the library cannot fill is refused before anything is written', async t => {
  const f = await workspace(t);
  await writeFile(f.brief, JSON.stringify({ sim: 'x', goal: 'g', subjects: [{ id: 'a', content: 'A' }], audience: { n: 50, age: [18, 19] } }));
  const out = f.drive(['populate', f.brief]);
  assert.equal(out.status, 1); assert.match(out.stderr, /audience filter leaves \d+ personas/);
  assert.deepEqual(await readdir(join(f.ws, 'soots')), []);
});

test('a persona the runtime never loaded stops the run at once, with the fix', async t => {
  const f = await workspace(t); f.drive(['populate', f.brief]);
  const out = f.drive(['run', f.brief, '--no-report'], { FAKE_UNLOADED: '1', MICRO_FISH_RETRY_WAITS: '600' });
  assert.equal(out.status, 1); assert.match(out.stderr, /soot migrate adopt/);
});
