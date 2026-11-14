import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { active, advance, create, execute, load } from '../tools/world.mjs';

async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'micro-fish-test-')); t.after(() => rm(state, { recursive: true, force: true }));
  const env = { SOOT_PACK_STATE: state }, dir = join(state, 'sims');
  const call = (who, op, input) => execute({ api_version: 'soot/v1', hook: 'tool.call', operation: 'micro-fish_' + op, soot: who, input }, op, env);
  return { state, dir, env, call };
}
const agents = n => Array.from({ length: n }, (_, i) => ({ id: `p-${i}`, name: `Người ${i}`, age: 20 + i, sex: i % 2 ? 'Nam' : 'Nữ', zone: i % 3 ? 'Đô Thị' : 'Nông Thôn', activity: 1 }));
const context = n => Array.from({ length: n }, (_, i) => ({ account: `kenh-${i}`, content: `Bài nền ${i}` }));
const brief = (over = {}) => ({ sim: 'demo', goal: 'Có nên đăng bài này', platform: 'TikTok', subjects: [{ id: 'a', label: 'Bản A', account: 'lohi', content: 'Nội dung A' }], context: context(6), rounds: 3, feed_size: 3, agents: agents(8), ...over });
const reactAll = (feed, how = () => ({ attention: 'skip' })) => feed.feed.map(p => ({ post: p.post, ...how(p) }));

test('every persona meets its subject in its first session and nothing twice', async t => {
  const f = await fixture(t); await create(f.dir, brief());
  await advance(f.dir, 'demo', { round: 1 });
  const seen = {};
  for (let round = 1; round <= 3; round++) {
    await advance(f.dir, 'demo', { round });
    for (const a of agents(8)) {
      const feed = await f.call(a.id, 'timeline', { sim: 'demo' });
      if (round === 1) assert.ok(feed.feed.some(p => p.post === 'a'), 'subject in the first feed');
      for (const p of feed.feed) { assert.ok(!(seen[a.id] ||= new Set()).has(p.post), 'no post twice'); seen[a.id].add(p.post); }
      if (feed.feed.length) await f.call(a.id, 'act', { sim: 'demo', reactions: reactAll(feed) });
    }
  }
  const again = await f.call('p-0', 'timeline', { sim: 'demo' });
  assert.deepEqual(again.feed.map(p => p.post), [...seen['p-0']].slice(-again.feed.length), 'a second call in a round returns the same feed');
});

test('identity comes from the host, not from the input', async t => {
  const f = await fixture(t); await create(f.dir, brief()); await advance(f.dir, 'demo', { round: 1 });
  await assert.rejects(f.call('stranger', 'timeline', { sim: 'demo' }), /not part of that simulation/);
  await assert.rejects(f.call('p-0', 'timeline', { sim: 'demo', agent: 'p-1' }), /unknown field agent/);
  await assert.rejects(execute({ api_version: 'soot/v1', input: { sim: 'demo' } }, 'timeline', f.env), /did not name the calling Soot/);
});

test('act refuses posts that were not shown and reactions before a feed', async t => {
  const f = await fixture(t); await create(f.dir, brief()); await advance(f.dir, 'demo', { round: 1 });
  await assert.rejects(f.call('p-0', 'act', { sim: 'demo', reactions: [{ post: 'a', attention: 'full' }] }), /timeline first/);
  const feed = await f.call('p-0', 'timeline', { sim: 'demo' });
  await assert.rejects(f.call('p-0', 'act', { sim: 'demo', reactions: [{ post: 'nope', attention: 'full' }] }), /was not in your feed/);
  await assert.rejects(f.call('p-0', 'act', { sim: 'demo', reactions: [{ post: feed.feed[0].post, attention: 'loved' }] }), /attention must be/);
  const done = await f.call('p-0', 'act', { sim: 'demo', reactions: [{ post: feed.feed[0].post, attention: 'some' }] });
  assert.equal(done.missing.length, feed.feed.length - 1);
});

test('a share reaches other people, with the sharer named and the comments carried', async t => {
  const f = await fixture(t); await create(f.dir, brief({ context: context(12), feed_size: 2 })); await advance(f.dir, 'demo', { round: 1 });
  const feed = await f.call('p-0', 'timeline', { sim: 'demo' });
  await f.call('p-0', 'act', { sim: 'demo', reactions: reactAll(feed, p => p.post === 'a' ? { attention: 'full', like: true, share: true, follow: true, comment: 'đỉnh thật', quote: 'ai xem chưa' } : { attention: 'skip' }), new_post: 'hôm nay mưa quá' });
  const world = await load(f.dir, 'demo');
  assert.equal(world.posts.filter(p => p.author === 'p-0').length, 3, 'a repost, a quote and an own post');
  assert.deepEqual(world.follows.map(x => x.account), ['lohi']);
  // Someone who never met the subject can now meet it as a share.
  await create(f.dir, brief({ sim: 'two', subjects: [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }], agents: agents(8) }));
  const tallied = await f.call('analyst', 'tally', { sim: 'demo' });
  assert.equal(tallied.subjects.a.spread.shares, 1); assert.equal(tallied.subjects.a.spread.quotes, 1);
  assert.equal(tallied.subjects.a.comments[0].text, 'đỉnh thật'); assert.equal(tallied.totals.user_posts, 3);
});

test('an A/B is between subjects: an arm never sees the other subject or its users\' posts', async t => {
  const f = await fixture(t);
  const made = await create(f.dir, brief({ subjects: [{ id: 'a', content: 'Nội dung A' }, { id: 'b', content: 'Nội dung B' }], agents: agents(10), rounds: 2 }));
  assert.deepEqual(made.arms, { a: 5, b: 5 });
  const world = await load(f.dir, 'demo');
  for (let round = 1; round <= 2; round++) {
    await advance(f.dir, 'demo', { round });
    for (const a of agents(10)) {
      const arm = world.agents[a.id].arm, other = arm === 'a' ? 'b' : 'a';
      // A later persona may first meet its subject as someone's share of it.
      const feed = await f.call(a.id, 'timeline', { sim: 'demo' });
      assert.ok(!feed.feed.some(p => p.post === other || p.content === `Nội dung ${other.toUpperCase()}` || p.content === `from ${other}`));
      if (feed.feed.length) await f.call(a.id, 'act', { sim: 'demo', reactions: reactAll(feed, p => p.content === `Nội dung ${arm.toUpperCase()}` ? { attention: arm === 'a' ? 'full' : 'skip', share: true } : { attention: 'skip' }), new_post: `from ${arm}` });
    }
  }
  const out = await f.call('analyst', 'tally', { sim: 'demo' });
  assert.equal(out.subjects.a.full.pct, 100); assert.equal(out.subjects.b.full.pct, 0);
  assert.equal(out.comparison.leader, 'a'); assert.equal(out.comparison.clear, true, '5/5 against 0/5 does not overlap');
  assert.ok(out.warnings.some(w => /directional/.test(w)));
});

test('the tally ranks a subject among the context posts and counts only recorded behaviour', async t => {
  const f = await fixture(t); await create(f.dir, brief({ rounds: 1, feed_size: 8, context: context(4) })); await advance(f.dir, 'demo', { round: 1 });
  for (const a of agents(8)) {
    const feed = await f.call(a.id, 'timeline', { sim: 'demo' });
    await f.call(a.id, 'act', { sim: 'demo', reactions: reactAll(feed, p => p.post === 'a' ? { attention: Number(a.id.slice(2)) < 2 ? 'full' : 'skip' } : { attention: p.post === 'c1' ? 'full' : 'some' }) });
  }
  const out = await f.call('analyst', 'tally', { sim: 'demo', by: 'zone' });
  assert.equal(out.subjects.a.reached, 8); assert.equal(out.subjects.a.full.k, 2); assert.equal(out.subjects.a.full.pct, 25);
  assert.deepEqual(out.subjects.a.full.ci95.map(Math.round), [7, 59]);
  assert.equal(out.feed_rank[0].post, 'c1'); assert.equal(out.subjects.a.rank_in_feed, 2); assert.equal(out.subjects.a.of, 5);
  assert.deepEqual(Object.keys(out.subjects.a.by_zone).sort(), ['Nông Thôn', 'Đô Thị']);
  assert.equal(out.complete, false); assert.ok(out.caveat);
  await assert.rejects(f.call('analyst', 'tally', { sim: 'demo', by: 'income' }), /by must be/);
});

test('interviews open after the feed closes and validate each answer by its type', async t => {
  const f = await fixture(t);
  await create(f.dir, brief({ questions: [{ id: 'clarity', type: 'scale', ask: 'Hiểu không' }, { id: 'retell', type: 'text', ask: 'Kể lại' }, { id: 'objections', type: 'tags', ask: 'Vướng gì' }, { id: 'buy', type: 'yesno', ask: 'Mua không' }] }));
  await advance(f.dir, 'demo', { round: 1 });
  await assert.rejects(f.call('p-0', 'answer', { sim: 'demo', answers: { clarity: 4 } }), /not started/);
  await advance(f.dir, 'demo', { phase: 'interview' });
  await assert.rejects(f.call('p-0', 'timeline', { sim: 'demo' }), /feed is closed/);
  await assert.rejects(f.call('p-0', 'answer', { sim: 'demo', answers: { clarity: 9 } }), /integer 1–5/);
  await assert.rejects(f.call('p-0', 'answer', { sim: 'demo', answers: { mood: 'ok' } }), /unknown field mood/);
  const rec = await f.call('p-0', 'answer', { sim: 'demo', answers: { clarity: 4, retell: 'Kể về một sát thủ', objections: ['Ad Feel', 'too-long'], buy: false } });
  assert.deepEqual(rec.skipped, []);
  await f.call('p-1', 'answer', { sim: 'demo', answers: { clarity: 2, objections: ['ad-feel'] } });
  const out = (await f.call('analyst', 'tally', { sim: 'demo' })).subjects.a.interview;
  assert.equal(out.answered, 2); assert.equal(out.clarity.mean, 3); assert.equal(out.clarity.top2.k, 1);
  assert.deepEqual(out.objections.tags[0], ['ad-feel', 2]); assert.equal(out.buy.yes.k, 0); assert.equal(out.retell.answers[0].text, 'Kể về một sát thủ');
});

test('an expert records findings without a verdict, and the brief gives the full subject', async t => {
  const f = await fixture(t); await create(f.dir, brief({ subjects: [{ id: 'a', content: 'x'.repeat(9000) }] }));
  assert.equal((await f.call('sim-expert', 'brief', { sim: 'demo' })).subjects[0].content.length, 9000);
  await assert.rejects(f.call('sim-expert', 'expert', { sim: 'demo', expert: 'hook', lens: 'Hook', findings: [], coverage: 'text only', verdict: 'GO' }), /unknown field verdict/);
  await assert.rejects(f.call('sim-expert', 'expert', { sim: 'demo', expert: 'hook', lens: 'Hook', findings: [{ severity: 'P1', subject: 'z', issue: 'i', fix: 'f' }], coverage: 'c' }), /subject is unknown/);
  await f.call('sim-expert', 'expert', { sim: 'demo', expert: 'hook', lens: 'Hook', findings: [{ severity: 'P1', subject: 'a', issue: 'Mở đầu chậm', evidence: '3 giây đầu', fix: 'Cắt câu chào' }, { severity: 'P3', issue: 'Chữ nhỏ', fix: 'Tăng cỡ' }], strengths: ['Giọng rõ'], coverage: 'Chỉ đọc kịch bản' });
  const out = (await f.call('analyst', 'tally', { sim: 'demo' })).experts;
  assert.equal(out.n, 1); assert.equal(out.blocking.length, 1); assert.equal(out.other.length, 1); assert.equal(out.lenses[0].coverage, 'Chỉ đọc kịch bản');
});

test('activity is seeded: the same round wakes the same people', async t => {
  const f = await fixture(t); await create(f.dir, brief({ agents: agents(40).map(a => ({ ...a, activity: 0.5 })) }));
  const world = await load(f.dir, 'demo'), first = active(world, 1);
  assert.deepEqual(active(world, 1), first); assert.notDeepEqual(active(world, 2), first);
  assert.ok(first.length > 10 && first.length < 30);
});

test('create validates the brief and refuses a duplicate id', async t => {
  const f = await fixture(t); await create(f.dir, brief());
  await assert.rejects(create(f.dir, brief()), /already exists/);
  await assert.rejects(create(f.dir, brief({ sim: 'x', subjects: [] })), /subjects needs/);
  await assert.rejects(create(f.dir, brief({ sim: 'x', kind: 'video' })), /unknown field kind/);
  await assert.rejects(create(f.dir, brief({ sim: 'x', agents: [{ id: 'p-1', name: 'A', activity: 0 }] })), /activity/);
  await assert.rejects(create(f.dir, brief({ sim: '../x' })), /sim must match/);
  assert.deepEqual((await f.call('analyst', 'status', {})).sims.map(s => s.sim), ['demo']);
  assert.equal((await f.call('analyst', 'profile', { sim: 'demo', persona: 'p-0' })).persona.name, 'Người 0');
});

test('parallel writers all land and leave no lock or temp file', async t => {
  const f = await fixture(t); await create(f.dir, brief({ agents: agents(24), rounds: 1 })); await advance(f.dir, 'demo', { round: 1 });
  await Promise.all(agents(24).map(async a => { const feed = await f.call(a.id, 'timeline', { sim: 'demo' }); await f.call(a.id, 'act', { sim: 'demo', reactions: reactAll(feed) }); }));
  const world = await load(f.dir, 'demo');
  assert.equal(new Set(world.reactions.map(r => r.agent)).size, 24);
  assert.deepEqual(await readdir(f.dir), ['demo.json']);
});

test('the entry point prints a safe message and a result', async t => {
  const f = await fixture(t); await create(f.dir, brief());
  const run = (op, call) => spawnSync(process.execPath, [join(import.meta.dirname, '../tools/micro-fish.mjs'), op], { input: JSON.stringify(call), env: { ...process.env, ...f.env }, encoding: 'utf8' });
  const ok = run('status', { api_version: 'soot/v1', soot: 'analyst', input: { sim: 'demo' } });
  assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).agents, 8);
  const bad = run('tally', { api_version: 'soot/v1', soot: 'analyst', input: { sim: 'missing' } });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /No simulation "missing"/);
});

test('depth is the average share of a post people got through, and a brief can decide the A/B on it', async t => {
  const two = [{ id: 'a', content: 'Nội dung A' }, { id: 'b', content: 'Nội dung B' }];
  const f = await fixture(t); await create(f.dir, brief({ subjects: two, rounds: 1, feed_size: 8, agents: agents(10), metric: 'depth' }));
  await assert.rejects(create(f.dir, brief({ sim: 'bad', metric: 'vibes' })), /metric must be/);
  await advance(f.dir, 'demo', { round: 1 });
  const world = await load(f.dir, 'demo');
  for (const a of agents(10)) {
    const feed = await f.call(a.id, 'timeline', { sim: 'demo' }), arm = world.agents[a.id].arm;
    // Nobody finishes either one: arm a leaves around 60%, arm b around 10%.
    await f.call(a.id, 'act', { sim: 'demo', reactions: reactAll(feed, p => p.post === arm ? { attention: 'some', depth: (arm === 'a' ? 55 : 5) + Number(a.id.slice(2)) } : { attention: 'skip' }) });
  }
  await assert.rejects(f.call('p-0', 'act', { sim: 'demo', reactions: [{ post: 'a', attention: 'some', depth: 140 }] }), /depth/);
  const out = await f.call('analyst', 'tally', { sim: 'demo' });
  assert.equal(out.subjects.a.full.pct, 0); assert.equal(out.subjects.a.depth.n, 5);
  assert.ok(out.subjects.a.depth.pct > 55 && out.subjects.b.depth.pct < 15);
  assert.deepEqual([out.comparison.metric, out.comparison.leader, out.comparison.clear], ['depth', 'a', true]);
  assert.equal(out.feed_rank[0].post, 'a', 'the feed is ranked by the same metric');
  assert.equal(out.feed_rank.find(r => r.post === 'c1').depth_pct, 0, 'a skip with no depth counts as 0');
});
