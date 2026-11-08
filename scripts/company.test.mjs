// A company of teams: the template, the Lohi overlay and a second, different company built from the same template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeCompany, validateCompany } from './company.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const template = read('groups/company-team/company.source.json');
const packs = { 'company-loop': read('packs/company-loop/pack.json'), marketing: read('packs/marketing/pack.json') };
const check = c => validateCompany(c, { root, packs });

test('the template validates: every team is an interface, contracts name real tables and columns, budgets under the ceiling', async () => {
  const r = await check(composeCompany(template));
  assert.deepEqual(r.teams, ['insight', 'marketing', 'cs', 'financial', 'build']);
  assert.ok(r.total <= template.daily_token_ceiling && r.total < 550000, 'below the old writer 250k + editor 300k');
  const insight = template.teams.find(t => t.id === 'insight');
  assert.equal(insight.lead, true, 'insight is the thin company lead');
  assert.deepEqual(template.teams.find(t => t.id === 'build').external, { runtime: 'claude-code', via: 'bbs team', note: template.teams.find(t => t.id === 'build').external.note });
  assert.equal(template.teams.find(t => t.id === 'financial').decides.alone.join(), 'write the weekly report', 'financial reads and reports only');
});

test('Lohi: the overlay adds op-catalog (a slot), fills Soot ids, keeps support external, and every Soot exists in the recipe', async () => {
  const lohi = composeCompany(template, read('examples/lohi-marketing/company.lohi.json'));
  const r = await check(lohi);
  assert.deepEqual(r.teams, ['insight', 'marketing', 'cs', 'financial', 'build', 'op-catalog']);
  assert.ok(r.contracts.includes('catalog-requests'));
  const host = read('examples/lohi-marketing/deployment.example.json');
  const soots = new Set(host.soots.map(f => read(`examples/lohi-marketing/${f}`).id));
  for (const t of lohi.teams.filter(x => !x.external && x.id !== 'op-catalog')) for (const s of t.soots) assert.ok(soots.has(s.id), `${t.id}: ${s.id} is a recipe Soot`);
  // Each team's budget is the sum of its Soots' daily caps in the recipe, and every scheduled Soot belongs to a team.
  for (const t of lohi.teams.filter(x => !x.external && x.id !== 'op-catalog')) {
    const sum = t.soots.reduce((n, s) => n + read(`examples/lohi-marketing/soots/${s.id}.json`).execution.daily_tokens, 0);
    assert.ok(sum <= t.daily_tokens, `${t.id}: Soots cap ${sum} within the team budget ${t.daily_tokens}`);
  }
  const owned = new Set(lohi.teams.flatMap(t => t.soots.map(s => s.id)));
  for (const s of host.schedules) assert.ok(owned.has(s.soot), `${s.id}: ${s.soot} belongs to a team`);
  assert.equal(lohi.teams.find(t => t.id === 'cs').external.runtime, 'cs-server');
});

test('a second company from the same template: three teams, a different op team, no financial, no cs, renamed marketing', async () => {
  const shop = composeCompany(template, {
    extends: 'company-team', id: 'shop', name: 'Shop',
    remove: ['financial', 'cs', 'build'],
    rename: { marketing: 'growth' },
    teams: { insight: { soots: [{ id: 'shop-analyst', role: 'analyst' }] } },
    add: [{ id: 'op-inventory', kind: 'group', group: 'team-op', soots: [{ id: 'shop-ops', role: 'operator' }], takes_in: [{ from: 'insight', what: 'restock opportunities', contract: 'restock' }], gives_out: [{ table: 'stock', pack: 'shop-inventory', fields: ['sku', 'qty'], note: 'stock levels' }], decides: { alone: ['reorder within the cap'], with_founder: ['a supplier change'] }, daily_tokens: 80000, escalates_when: ['stock is out'] }],
    contracts: { add: [{ id: 'restock', owner: 'insight', reader: 'op-inventory', table: 'opportunities', pack: 'company-loop', mode: 'read', fields: ['ref', 'title', 'state'] }] },
  });
  const r = await check(shop);
  assert.deepEqual(r.teams, ['insight', 'growth', 'op-inventory']);
  assert.ok(!r.contracts.includes('scoreboard') && !r.contracts.includes('build-request'), 'optional contracts of removed teams go with them');
  assert.ok(r.contracts.includes('topics'));
  const topics = shop.contracts.find(k => k.id === 'topics');
  assert.equal(topics.reader, 'growth', 'a renamed team keeps its contracts');
  assert.ok(shop.teams.find(t => t.id === 'insight').takes_in.every(i => !['build', 'cs'].includes(i.from)));
});

test('contracts are data: change a field name or queue and the company still validates; a wrong one is refused', async () => {
  const ok = composeCompany(template, { contracts: { remove: ['topics'], add: [{ id: 'topics', owner: 'insight', reader: 'marketing', table: 'topics', pack: 'company-loop', mode: 'read', fields: ['query'] }] } });
  await check(ok);
  const badField = composeCompany(template, { contracts: { remove: ['topics'], add: [{ id: 'topics', owner: 'insight', reader: 'marketing', table: 'topics', pack: 'company-loop', mode: 'read', fields: ['nope'] }] } });
  await assert.rejects(check(badField), /nope not given out/);
  const badColumn = clone => { const c = composeCompany(template); c.teams[0].gives_out.find(g => g.table === 'topics').fields.push('ghost'); c.contracts.find(k => k.id === 'topics').fields.push('ghost'); return c; };
  await assert.rejects(check(badColumn()), /no column ghost/);
});

test('refusals: a required contract to a removed team, an unknown team, budgets over the ceiling, a team with no escalation, a group that is not in the catalog', async () => {
  assert.throws(() => composeCompany(template, { remove: ['insight'] }), /needs insight/);
  assert.throws(() => composeCompany(template, { remove: ['nope'] }), /unknown team/);
  assert.throws(() => composeCompany(template, { rename: { cs: 'marketing' } }), /exists/);
  assert.throws(() => composeCompany(template, { surprise: 1 }), /unknown overlay field/);
  await assert.rejects(check(composeCompany(template, { daily_token_ceiling: 1000 })), /over the ceiling/);
  await assert.rejects(check(composeCompany(template, { teams: { insight: { escalates_when: [] } } })), /says when it escalates/);
  await assert.rejects(check(composeCompany(template, { teams: { insight: { group: 'team-nope' } } })), /not in groups.json/);
  await assert.rejects(check(composeCompany(template, { teams: { insight: { daily_tokens: 5 } } })), /not its group's/);
});

test('every group-backed team of the template uses a validated one-team group of the catalog', () => {
  const catalog = read('groups.json').groups.map(g => g.id);
  for (const t of template.teams.filter(x => x.group)) assert.ok(catalog.includes(t.group), t.group);
  assert.ok(catalog.includes('marketing-team'), 'the standalone single-team template stays');
});
