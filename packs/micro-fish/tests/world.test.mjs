import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, scope } from '../tools/world.mjs';

async function fixture(t, subject = 'conv-1') {
  const state = await mkdtemp(join(tmpdir(), 'society-test-')); t.after(() => rm(state, { recursive: true, force: true }));
  const env = { SOOT_PACK_STATE: state };
  const call = (op, input, who = 'crowd', sub = subject) => execute({ api_version: 'soot/v1', hook: 'tool.call', operation: 'micro-fish_' + op, soot: who, root: 'moderator', event: { id: 'run-1', source: 'conversation', subject: sub }, input }, op, env);
  return { state, env, call };
}
const stimuli = [{ id: 'a', label: 'Phương án A', content: 'Gói 49k/tháng, nghe truyện không giới hạn.' }, { id: 'b', label: 'Phương án B', content: 'Gói 99k/tháng, kèm tải offline.' }];
const persona = (i, segment = i % 2 ? 'student' : 'office', market = i % 3 ? 'vn' : 'us') => ({ id: `p-${i}`, name: `Persona ${i}`, segment, market, bio: `Synthetic persona ${i}.`, influence: i === 1 ? 0.9 : 0.2, skepticism: 0.5 });
const scores = (sid, intent, extra = {}) => ({ stimulus: sid, attention: 3, appeal: intent, clarity: 4, trust: 3, intent, sentiment: intent >= 4 ? 1 : -1, quote: `intent ${intent}`, objections: intent < 3 ? ['too-expensive'] : [], ...extra });
const react = (id, ia, ib, more = {}) => ({ persona: id, stimuli: [scores('a', ia), scores('b', ib)], preferred: ia >= ib ? 'a' : 'b', post: `post by ${id}`, ...more });

async function seeded(t, n = 6) {
  const f = await fixture(t);
  await f.call('create', { sim: 'plan', goal: 'Chọn giá gói nghe', kind: 'pricing', markets: ['vn', 'us'], stimuli, rounds: 1, feed_size: 3 }, 'moderator');
  for (let i = 0; i < n; i += 10) await f.call('add_personas', { sim: 'plan', personas: Array.from({ length: Math.min(10, n - i) }, (_, k) => persona(i + k)) }, 'architect');
  return f;
}

test('creates a world scoped to the conversation and refuses duplicates', async t => {
  const f = await fixture(t);
  const made = await f.call('create', { sim: 'demo', goal: 'Test', kind: 'feature', stimuli: stimuli.slice(0, 1) });
  assert.equal(made.sim, 'demo');
  await assert.rejects(f.call('create', { sim: 'demo', goal: 'Test', kind: 'feature', stimuli: stimuli.slice(0, 1) }), /already exists/);
  await assert.rejects(f.call('create', { sim: 'x', goal: 'Test', kind: 'nope', stimuli }), /kind/);
  await f.call('create', { sim: 'empty', goal: 'Test', kind: 'video' });
  await f.call('add_personas', { sim: 'empty', personas: [persona(0)] });
  await assert.rejects(f.call('plan_round', { sim: 'empty', round: 0 }), /No stimulus/);
  const added = await f.call('stimulus', { sim: 'empty', stimulus: { id: 'cut-a', label: 'Bản dựng A', content: 'Kịch bản dài '.repeat(200) } });
  assert.equal(added.stimuli.length, 1);
  assert.equal((await f.call('stimulus', { sim: 'empty', stimulus: { id: 'cut-a', label: 'Bản dựng A', content: 'ngắn' } })).replaced, true);
  await assert.rejects(f.call('stimulus', { sim: 'empty', stimulus: { id: 'cut-b', label: 'B', content: 'x'.repeat(3001) } }), /3000/);
  await assert.rejects(f.call('create', { sim: 'x', goal: 'Test', kind: 'video', stimuli, extra: 1 }), /unknown field extra/);
  assert.equal((await f.call('status', {})).sims.length, 2);
  assert.equal((await f.call('status', {}, 'crowd', 'conv-2')).sims.length, 0, 'another conversation sees nothing');
  await assert.rejects(f.call('status', { sim: 'demo' }, 'crowd', 'conv-2'), /No simulation/);
  assert.notEqual(scope({ root: 'moderator', event: { subject: 'a' } }), scope({ root: 'other', event: { subject: 'a' } }));
});

test('population validates and freezes once round 0 starts', async t => {
  const f = await seeded(t);
  await assert.rejects(f.call('add_personas', { sim: 'plan', personas: [persona(0)] }), /already exists/);
  await assert.rejects(f.call('add_personas', { sim: 'plan', personas: [{ ...persona(9), influence: 2 }] }), /influence/);
  await assert.rejects(f.call('add_personas', { sim: 'plan', personas: [{ id: 'Bad Id', name: 'x', segment: 's', market: 'm', bio: 'b' }] }), /id/);
  const status = await f.call('status', { sim: 'plan' });
  assert.deepEqual(status.mix.segment, { office: 3, student: 3 });
  await f.call('react', { sim: 'plan', round: 0, reactions: [react('p-0', 4, 2)] });
  await assert.rejects(f.call('add_personas', { sim: 'plan', personas: [persona(7)] }), /fixed/);
  await assert.rejects(f.call('stimulus', { sim: 'plan', stimulus: { id: 'c', label: 'C', content: 'late' } }), /fixed/);
});

test('rounds gate on completion, feeds exclude self and memory carries forward', async t => {
  const f = await seeded(t);
  const plan0 = await f.call('plan_round', { sim: 'plan', round: 0, batch_size: 4 });
  assert.deepEqual(plan0.batches.map(b => b.length), [4, 2]);
  assert.equal((await f.call('plan_round', { sim: 'plan', round: 1 })).ready, false);
  const p0 = await f.call('packet', { sim: 'plan', round: 0, personas: ['p-0', 'p-1'] });
  assert.deepEqual(p0.personas[0].feed, []);
  assert.deepEqual([...p0.personas[0].stimulus_order].sort(), ['a', 'b']);
  await assert.rejects(f.call('react', { sim: 'plan', round: 0, reactions: [{ persona: 'p-0', stimuli: [scores('a', 4)] }] }), /score every stimulus/);
  await assert.rejects(f.call('react', { sim: 'plan', round: 0, reactions: [react('p-0', 6, 2)] }), /1–5/);
  await assert.rejects(f.call('react', { sim: 'plan', round: 0, reactions: [react('ghost', 3, 3)] }), /unknown persona/);
  await assert.rejects(f.call('react', { sim: 'plan', round: 1, reactions: [react('p-0', 3, 3)] }), /not complete/);
  await f.call('react', { sim: 'plan', round: 0, reactions: ['p-0', 'p-1', 'p-2'].map((id, i) => react(id, 4 + (i % 2), 2)) });
  await f.call('react', { sim: 'plan', round: 0, reactions: ['p-3', 'p-4', 'p-5'].map(id => react(id, 2, 3)) });
  const p1 = await f.call('packet', { sim: 'plan', round: 1, personas: ['p-0'] });
  const me = p1.personas[0];
  assert.equal(me.feed.length, 3);
  assert.ok(me.feed.every(post => post.id !== 'r0-p-0'), 'own post never in own feed');
  assert.equal(me.memory[0].intent.a, 4);
  const again = await f.call('packet', { sim: 'plan', round: 1, personas: ['p-0'] });
  assert.deepEqual(again.personas[0].feed, me.feed, 'feed is seeded and reproducible');
  await assert.rejects(f.call('react', { sim: 'plan', round: 1, reactions: [react('p-0', 4, 2, { influenced_by: ['r0-p-0'] })] }), /another persona/);
  await assert.rejects(f.call('react', { sim: 'plan', round: 1, reactions: [react('p-0', 4, 2, { influenced_by: ['r9-p-1'] })] }), /another persona/);
  assert.equal((await f.call('plan_round', { sim: 'plan', round: 1 })).remaining, 6);
});

test('tally reports shift, preference, segments, objections and warnings', async t => {
  const f = await seeded(t);
  await f.call('react', { sim: 'plan', round: 0, reactions: ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((id, i) => react(id, i < 3 ? 4 : 2, 3)) });
  await f.call('react', { sim: 'plan', round: 1, reactions: ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5'].map((id, i) => react(id, i < 5 ? 4 : 2, 3, i === 3 ? { changed: true, change_reason: 'convinced', influenced_by: ['r0-p-1'] } : {})) });
  await f.call('expert', { sim: 'plan', expert: 'vn-pricing', lens: 'VN pricing strategist', verdict: 'ITERATE', overall: 6.5, scores: { price: 5 }, findings: [{ severity: 'P1', stimulus: 'b', issue: 'Too expensive for students', fix: 'Add a 59k student plan' }], coverage: 'Pricing only' }, 'expert');
  const out = await f.call('tally', { sim: 'plan' }, 'analyst');
  assert.equal(out.complete, true);
  assert.equal(out.by_round[1].a.intent_top2, 83.3);
  assert.deepEqual(out.by_round[1].a.intent_dist, [0, 1, 0, 5, 0]);
  assert.equal(out.shift.a.won, 2);
  assert.equal(out.shift.a.lost, 0);
  assert.equal(out.preference.shares.a.pct, 83.3);
  assert.equal(out.preference.leader, 'a');
  assert.equal(out.preference.clear, false, 'n=6 cannot separate A from B');
  assert.equal(out.shift.a.direction, 'no clear change');
  assert.equal(out.objections.a.first[0][0], 'too-expensive');
  assert.equal(out.influential_posts[0].id, 'r0-p-1');
  assert.equal(out.experts.blocking[0].severity, 'P1');
  assert.ok(out.warnings.some(w => /n=6/.test(w)));
  assert.ok(Object.keys(out.by_segment).includes('student'));
  assert.ok((await f.call('tally', { sim: 'plan', by: 'market' })).by_market.vn);
  const p = await f.call('profile', { sim: 'plan', persona: 'p-3' });
  assert.equal(p.history.length, 2);
  assert.equal(p.history[1].changed, true);
});

test('parallel crowd writes all land', async t => {
  const f = await seeded(t, 24);
  const ids = Array.from({ length: 24 }, (_, i) => `p-${i}`);
  await Promise.all(Array.from({ length: 6 }, (_, b) => f.call('react', { sim: 'plan', round: 0, reactions: ids.slice(b * 4, b * 4 + 4).map(id => react(id, 3, 3)) })));
  assert.equal((await f.call('status', { sim: 'plan' })).rounds[0].reacted, 24);
  const dir = join(f.state, 'worlds', scope({ root: 'moderator', event: { subject: 'conv-1' } }));
  assert.ok((await readdir(dir)).every(name => !name.endsWith('.lock')), 'no lock left behind');
});

test('packet stays inside one tool preview', async t => {
  const f = await fixture(t);
  const long = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, label: `Phương án ${i}`, content: 'x'.repeat(2990) }));
  await f.call('create', { sim: 'big', goal: 'Size', kind: 'video', stimuli: long, rounds: 1, feed_size: 8 });
  for (const start of [0, 6]) await f.call('add_personas', { sim: 'big', personas: Array.from({ length: 6 }, (_, i) => ({ ...persona(start + i), bio: 'b'.repeat(500) })) });
  const full = s => ({ stimulus: s, attention: 3, appeal: 3, clarity: 3, trust: 3, intent: 3, sentiment: 0, quote: 'q'.repeat(200) });
  for (const start of [0, 6]) await f.call('react', { sim: 'big', round: 0, reactions: Array.from({ length: 6 }, (_, i) => ({ persona: `p-${start + i}`, stimuli: long.map(s => full(s.id)), post: 'p'.repeat(240) })) });
  const out = await f.call('packet', { sim: 'big', round: 1, personas: ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5'] });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 30000);
});

test('the executable answers through the soot/v1 stdin contract', async t => {
  const f = await fixture(t);
  const envelope = input => JSON.stringify({ api_version: 'soot/v1', hook: 'tool.call', operation: 'micro-fish_create', soot: 'moderator', root: 'moderator', event: { id: 'r', source: 'conversation', subject: 'c' }, input });
  const tool = new URL('../tools/micro-fish.mjs', import.meta.url).pathname;
  const ok = spawnSync(process.execPath, [tool, 'create'], { input: envelope({ sim: 'cli', goal: 'g', kind: 'other', stimuli: stimuli.slice(0, 1) }), env: { SOOT_PACK_STATE: f.state }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).sim, 'cli');
  const bad = spawnSync(process.execPath, [tool, 'create'], { input: envelope({ sim: 'cli', goal: 'g', kind: 'other', stimuli: stimuli.slice(0, 1) }), env: { SOOT_PACK_STATE: f.state }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /already exists/);
  const nostate = spawnSync(process.execPath, [tool, 'status'], { input: envelope({}), env: {}, encoding: 'utf8' });
  assert.match(nostate.stderr, /SOOT_PACK_STATE/);
});
