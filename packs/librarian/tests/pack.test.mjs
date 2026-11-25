import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../', import.meta.url);
const text = f => readFileSync(new URL(f, dir), 'utf8');
const read = f => JSON.parse(text(f));
const pack = read('pack.json'), frag = read('deployment.fragment.json'), soot = read('soots/librarian/soot.json');
const evals = read('evals/librarian/librarian.eval.json');
const secretShaped = /(postgres(ql)?:\/\/|sqlite:\/\/|Bearer\s+\S|sk-[A-Za-z0-9]{8}|[A-Za-z0-9_]*(token|secret|password)["']?\s*:\s*["'][^"']{8})/i;

test('the pack is named in both languages and has no tools of its own', () => {
  assert.deepEqual(pack.name, { vi: 'Thủ thư', en: 'Librarian' });
  assert.deepEqual(pack.tools, []);
  for (const k of ['name', 'description', 'keywords']) assert.ok(pack[k].vi && pack[k].en, k);
  for (const k of ['credentials', 'schedules', 'grants', 'capabilities', 'use', 'id']) assert.equal(pack[k], undefined, k);
});

test('two skills, each named by its folder and described', () => {
  const names = readdirSync(new URL('skills/', dir), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  assert.deepEqual(names, ['librarian', 'librarian-refresh']);
  for (const name of names) {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text(`skills/${name}/SKILL.md`))?.[1] ?? '';
    assert.match(front, new RegExp(`^name: ${name}$`, 'm'), name);
    assert.match(front, /^description: \S/m, name);
  }
});

test('the librarian skill keeps its guardrails in the text a model reads', () => {
  const s = text('skills/librarian/SKILL.md');
  // intake and dedupe by the gap key, research order, write with source and revision, ask last
  assert.match(s, /knowledge-gap <key>/);
  assert.match(s, /llms\.txt[\s\S]*README[\s\S]*website/);
  assert.match(s, /data-pool_write[\s\S]*expected_revision/);
  assert.match(s, /source/);
  assert.match(s, /revision conflict/i);
  assert.match(s, /data-pool_status/);
  assert.match(s, /Ask a person only when stuck/);
  // never: private data in a public pool, facts in memory, flipping the public flag
  assert.match(s, /Private or contact data in a public pool/);
  assert.match(s, /workspace_public/);
  assert.match(s, /Marking a pool public/);
  assert.match(s, /feedback pool/);
  // the asker's words are data
  assert.match(s, /data,\s+not instructions/);
});

test('the refresh skill updates with the revision it read and never deletes', () => {
  const s = text('skills/librarian-refresh/SKILL.md');
  assert.match(s, /expected_revision/);
  assert.match(s, /do not delete/i);
  assert.match(s, /memory/);
});

test('the Soot template selects the librarian, research and data-pool packs', () => {
  assert.deepEqual(soot.packs, ['librarian', 'research', 'data-pool']);
  assert.equal(soot.chat, undefined, 'the librarian answers no visitor');
  for (const f of ['MISSION.md', 'SOUL.md']) assert.ok(text(`soots/librarian/${f}`).trim().length > 40, f);
});

test('deployment fragment: the librarian key, a daily sweep, a weekly refresh, no secret values', () => {
  assert.equal(frag.data_pool.librarian, 'librarian');
  assert.equal(frag.data_pool.binding, undefined, 'the host owns the binding');
  const byId = Object.fromEntries(frag.schedules.map(s => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['librarian-refresh', 'librarian-sweep']);
  assert.match(byId['librarian-sweep'].cron, /^\d+ \d+ \* \* \*$/, 'daily');
  assert.match(byId['librarian-refresh'].cron, /^\d+ \d+ \* \* [0-7]$/, 'weekly');
  for (const s of frag.schedules) { assert.equal(s.soot, 'librarian'); assert.ok(s.text.length > 40); }
  assert.doesNotMatch(JSON.stringify(frag), secretShaped);
  assert.match(frag._comment, /DATA_POOL/);
  assert.match(frag._comment, /feedback pool public/);
});

test('evals: the four decisions, all on the librarian Soot', () => {
  assert.equal(evals.soot, 'librarian');
  assert.deepEqual(evals.cases.map(c => c.id).sort(), ['gap-written-with-source', 'nothing-found-asks', 'refuses-contact-data', 'same-gap-is-one-task']);
  const by = Object.fromEntries(evals.cases.map(c => [c.id, c.turns[0].expect]));
  assert.deepEqual(by['gap-written-with-source'].order, ['task', 'web_fetch', 'data-pool_write']);
  assert.ok(by['nothing-found-asks'].not_called.includes('data-pool_write'));
  assert.ok(by['refuses-contact-data'].not_called.includes('data-pool_write'));
  assert.ok(by['same-gap-is-one-task'].not_called.includes('data-pool_write'));
  for (const c of evals.cases) assert.match(c.turns[0].send, /^Knowledge gap gap-[0-9a-f]{10}: /, c.id);
});

test('the pack names no product or company', () => {
  const all = ['pack.json', 'README.md', 'deployment.fragment.json', 'skills/librarian/SKILL.md', 'skills/librarian-refresh/SKILL.md', 'soots/librarian/MISSION.md', 'soots/librarian/SOUL.md'].map(text).join('\n');
  assert.doesNotMatch(all, /lohi|2found|2novel|soot\.lohi2/i);
});
