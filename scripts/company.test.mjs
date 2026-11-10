// The company compiler (soot-forge/company-template/v1 -> soot/company-template/v1) and what the runtime says about it.
// Compiling is pure and always tested. The checks need the runtime binary (`soot company check`): set LOOP_SOOT_BIN to a build of
// the L6 runtime; without it those tests are skipped, since this file keeps no validation of its own to fall back on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileCompany, checkCompany, readPins, shapeCompany, mergeOverlays, sootBin } from './company.mjs';
import { buildLocalGroups } from './support/local-groups.mjs';
import { build } from '../examples/lohi-marketing/setup.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const template = read('groups/company-team/company.source.json');
const lohi = read('examples/lohi-marketing/company.lohi.json');
const remotes = read('examples/lohi-marketing/remotes.lohi.json');
const bin = process.env.LOOP_SOOT_BIN || '';
const haveRuntime = bin && existsSync(bin);
const runtime = { skip: haveRuntime ? false : 'LOOP_SOOT_BIN does not name an L6 soot binary' };

const work = mkdtempSync(join(tmpdir(), 'forge-company-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
// Pinned archives of the four team templates, built from this tree.
const dist = await buildLocalGroups(root, join(work, 'dist'), '0.0.0', { ledByFirstMember: true });
const pins = await readPins(dist);
const create = { mode: 'create', root, pins, remotes };
const codes = r => r.diagnostics.map(d => d.code);
const env = { ...process.env, LOOP_SOOT_BIN: bin };
const check = (overlay, options = create) => checkCompany(template, overlay, { ...options, bin, env });

// A second company from the same template: three teams, a different op team, no financial, no cs, renamed marketing.
const shop = {
  extends: 'company-team', id: 'shop', name: 'Shop',
  remove: ['financial', 'cs', 'build'],
  rename: { marketing: 'growth' },
  teams: { insight: { soots: [{ id: 'shop-analyst', role: 'analyst' }] } },
  add: [{ id: 'op-inventory', kind: 'group', group: 'team-op', soots: [{ id: 'shop-ops', role: 'operator' }], takes_in: [{ from: 'insight', what: 'restock opportunities', contract: 'restock' }], gives_out: [{ table: 'stock', pack: 'shop-inventory', fields: ['sku', 'qty'], note: 'stock levels' }], decides: { alone: ['reorder within the cap'], with_founder: ['a supplier change'] }, daily_tokens: 80000, escalates_when: ['stock is out'] }],
  contracts: { add: [{ id: 'restock', owner: 'insight', reader: 'op-inventory', table: 'opportunities', pack: 'company-loop', mode: 'read', fields: ['ref', 'title', 'state'] }] },
};

// ---- the compiler (pure) --------------------------------------------------------------------------------------------

test('compile: W2 files go in unchanged; teams, edges, remote, lead and ceiling come out as the runtime names them', async () => {
  const { company, notes } = await compileCompany(template, lohi, create);
  assert.equal(company.api_version, 'soot/company-template/v1');
  assert.deepEqual(company.teams.map(t => t.id), ['insight', 'marketing', 'cs', 'financial', 'op-catalog'], 'build (Claude Code) has no runtime form and is left out');
  assert.match(notes.join('\n'), /team build runs on claude-code/);
  assert.deepEqual(company.company, { name: 'Lohi', lead_team: 'insight', daily_token_ceiling: 550000 });
  assert.deepEqual(company.remotes, { 'cs-server': { url: 'https://soot.lohi2.com', token_env: 'CS_RUNTIME_TOKEN' } });
  const byId = Object.fromEntries(company.teams.map(t => [t.id, t]));
  assert.deepEqual(byId.cs.remote, { runtime: 'cs-server', group: 'support' });
  assert.equal(byId.cs.template, undefined, 'a remote team has no roster and no template');
  assert.deepEqual(byId.cs.contract.provides.tables.map(t => `${t.pack}.${t.table}`), ['lohi-cs.voc']);
  assert.equal(byId.insight.template.sha256, pins['team-insight'].sha256);
  assert.equal(byId.insight.profile, 'lean');
  // takes_in becomes consumes (optional and why kept), a read contract becomes the reader's edge, decides is renamed.
  assert.deepEqual(byId.insight.contract.consumes.map(c => [c.team, c.item, c.optional ?? false]), [['marketing', 'metrics', false], ['cs', 'voc', true]]);
  assert.deepEqual(byId.marketing.contract.consumes[0], { team: 'insight', item: 'topics', fields: ['query', 'reason', 'opportunity_ref', 'state'], why: 'chủ đề nội dung cần viết' });
  assert.deepEqual(byId.financial.contract.decides, { self: ['viết báo cáo hằng tuần'], with_person: ['không bao giờ tự động xử lý tiền: mọi thay đổi do người sáng lập quyết'] });
  assert.deepEqual(byId.financial.contract.provides.events, ['weekly_finance_report']);
  assert.deepEqual(byId.insight.contract.escalates[0], { when: 'một khóa bảng số liệu bị từ chối hoặc sản phẩm không trả số liệu', on: 'input_starving', after: '24h' }, 'the trigger is a code of the company file, not a match on the text');
  // No trigger depends on the wording: every escalation the group templates give a code has the same code in the compiled company.
  const codes = c => (c.contract.escalates ?? []).filter(e => e.on).map(e => e.on).sort();
  assert.deepEqual(codes(byId.marketing), ['chain_failed', 'queue_waiting']);
  assert.deepEqual(codes(byId.financial), ['budget_80']);
  assert.deepEqual(codes(byId['op-catalog']), ['chain_failed']);
  assert.equal(byId.marketing.contract.budget.daily_tokens, 250000);
  assert.deepEqual(byId['op-catalog'].contract.provides, undefined, "the job pack's table is provided once the pack is installed (adopt)");
  assert.match(notes.join('\n'), /lohi-ops\.findings is provided once/);
  // A team without a description cannot be saved from Nest (group_purpose_required), so every compiled team carries one.
  assert.deepEqual(company.teams.filter(t => !t.description).map(t => t.id), [], 'every team says what it is for');
});

test('compile: adopt mode names the Soots of the overlay, leaves budgets to the runtime (sum of member caps) and keeps an explicit one', async () => {
  const { company } = await compileCompany(template, lohi, { mode: 'adopt', root, remotes });
  const byId = Object.fromEntries(company.teams.map(t => [t.id, t]));
  assert.deepEqual(byId.insight.members, ['lohi-analyst', 'lohi-radar']);
  assert.deepEqual(byId['op-catalog'].members, ['lohi-catalog'], 'the Soot the lohi-ops pack ships');
  assert.equal(byId.insight.template, undefined);
  assert.equal(byId.insight.contract.budget, undefined, 'no explicit budget: the runtime sums the members');
  assert.equal(byId.marketing.contract.budget.daily_tokens, 250000, 'the overlay set it on purpose');
  assert.deepEqual(byId['op-catalog'].contract.provides.tables.map(t => t.table), ['findings'], 'adopt owns the pack table');
  assert.equal(byId.financial.members.length, 1);
});

test('compile: adopt with the deployment derives each team budget from its members\' caps, else drops budget_80', async () => {
  // Pure: a minimal deployment whose Soot files carry (or omit) execution.daily_tokens, as setup.mjs writes them.
  const ws = mkdtempSync(join(work, 'caps-'));
  const ids = ['lohi-analyst', 'lohi-radar', 'lohi-writer', 'lohi-editor', 'lohi-finance', 'lohi-catalog'];
  const cap = { 'lohi-analyst': 60000, 'lohi-radar': 40000, 'lohi-finance': 0 };
  mkdirSync(join(ws, 'soots'));
  for (const id of ids) writeFileSync(join(ws, 'soots', `${id}.json`), JSON.stringify({ id, ...(cap[id] ? { execution: { daily_tokens: cap[id] } } : {}) }));
  writeFileSync(join(ws, 'deployment.json'), JSON.stringify({ soots: ids.map(id => `soots/${id}.json`) }));
  const { company, notes } = await compileCompany(template, lohi, { mode: 'adopt', root, remotes, config: join(ws, 'deployment.json') });
  const byId = Object.fromEntries(company.teams.map(t => [t.id, t]));
  assert.equal(byId.insight.contract.budget.daily_tokens, 100000, 'the sum of the members\' caps, the value adopt derives');
  assert.equal(byId.marketing.contract.budget.daily_tokens, 250000, 'an explicit budget is kept as set');
  assert.equal(byId.financial.contract.budget, undefined, 'no member cap: no budget is invented');
  assert.ok(!(byId.financial.contract.escalates ?? []).some(e => e.on === 'budget_80'), 'budget_80 without a budget is left out');
  assert.match(notes.join('\n'), /team financial: no member has a daily token cap/);
  // Without the deployment nothing changes: adopt derives the budget when it applies.
  const { company: plain } = await compileCompany(template, lohi, { mode: 'adopt', root, remotes });
  assert.equal(plain.teams.find(t => t.id === 'insight').contract.budget, undefined);
});

test('compile: remove and rename go to the runtime as its overlay, patches and adds are shaped here; nothing is validated', async () => {
  const { company } = await compileCompany(template, shop, create);
  assert.deepEqual(company.overlay, { remove: ['financial', 'cs'], rename: { marketing: 'growth' } }, 'the runtime removes what it holds; build has no runtime form and is not its to remove');
  assert.deepEqual((await compileCompany(template, shop, { mode: 'create', root, pins })).company.overlay, { remove: ['financial'], rename: { marketing: 'growth' } }, 'cs without a remote is left out by the compiler');
  assert.deepEqual(company.teams.map(t => t.id), ['insight', 'marketing', 'cs', 'financial', 'op-inventory']);
  const { company: ex } = await compileCompany(template, { remove: ['marketing', 'financial'] }, create);
  assert.deepEqual(ex.overlay.remove, ['marketing', 'financial']);
  // A contract naming a table nobody gives out compiles: refusing it is the runtime's job.
  const bad = await compileCompany(template, { contracts: { add: [{ id: 'ghost', owner: 'insight', reader: 'marketing', table: 'ghost', pack: 'company-loop', mode: 'read', fields: ['x'] }] } }, create);
  assert.ok(bad.company.teams.find(t => t.id === 'marketing').contract.consumes.some(c => c.item === 'ghost'));
  assert.throws(() => shapeCompany(template, { surprise: 1 }), /unknown overlay field/);
  assert.throws(() => shapeCompany(template, { extends: 'other' }), /extends other/);
  assert.deepEqual(mergeOverlays({ remove: ['a'], teams: { x: { daily_tokens: 1 } } }, { remove: ['b'], teams: { y: {} } }), { remove: ['a', 'b'], teams: { x: { daily_tokens: 1 }, y: {} } });
});

test('compile: create needs a pinned archive for every group; adopt needs none', async () => {
  await assert.rejects(compileCompany(template, {}, { mode: 'create', root, pins: {} }), /no pinned archive for group team-insight/);
  await compileCompany(template, {}, { mode: 'adopt', root });
});

test('the company template is internal and experimental in the catalog, and says nothing public about it', () => {
  const catalog = read('groups.json');
  assert.deepEqual(catalog.companies.map(c => [c.id, c.stability, c.audience]), [['company-team', 'experimental', 'internal']]);
  for (const g of catalog.groups.filter(x => x.id.startsWith('team-'))) assert.deepEqual([g.stability, g.audience], ['experimental', 'internal'], g.id);
  assert.doesNotMatch(JSON.stringify(catalog), /company OS|autonomous company|AI employee|replace your team|all-in-one/i);
});

// ---- the runtime's verdict ------------------------------------------------------------------------------------------

test('the template and the Lohi overlay compile and pass `soot company check`; a second company from the same template does too', runtime, async () => {
  for (const [name, overlay] of [['template', {}], ['lohi', lohi], ['shop', shop]]) {
    const r = await check(overlay);
    assert.deepEqual(r.diagnostics, [], name);
    assert.equal(r.ok, true, name);
  }
  const r = await check(shop);
  assert.deepEqual(r.teams, ['insight', 'growth', 'op-inventory']);
  assert.ok(r.edges.some(e => e.from === 'growth' && e.to === 'insight' && e.item === 'topics'), 'a renamed team keeps its edges');
  assert.ok(r.edges.some(e => e.from === 'op-inventory' && e.item === 'opportunities'), 'the added contract is an edge');
  assert.ok(!r.edges.some(e => e.to === 'financial' || e.from === 'financial'), 'the removed team took its optional edges');
  const l = await check(lohi);
  assert.deepEqual(l.teams, ['insight', 'marketing', 'cs', 'financial', 'op-catalog']);
});

test('Lohi adopt: the setup.mjs workspace and the adopt-mode company pass `soot company check --config`', runtime, async () => {
  const ws = join(work, 'ws');
  build(ws, { env: true, video: false, connection: null, home: join(work, 'home') });
  const r = await check(lohi, { mode: 'adopt', root, remotes, config: join(ws, 'deployment.json') });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.teams, ['insight', 'marketing', 'cs', 'financial', 'op-catalog']);
  // Every Soot of the overlay is a Soot of the recipe, and every scheduled Soot belongs to a team.
  const host = JSON.parse(readFileSync(join(ws, 'deployment.json'), 'utf8'));
  const owned = new Set(r.company.teams.flatMap(t => t.members ?? []));
  for (const s of host.schedules) assert.ok(owned.has(s.soot), `${s.id}: ${s.soot} belongs to a team`);
  for (const id of owned) assert.ok(host.soots.some(f => f.endsWith(`/${id}.json`)), `${id} is a Soot of the workspace`);
  // Without the deployment, adopting names it as the missing input.
  const none = await check(lohi, { mode: 'adopt', root, remotes });
  assert.deepEqual(codes(none), ['company_needs_deployment']);
});

test('refusals are the runtime\'s: a required edge, the lead, an unknown team, a bad contract, a budget over the ceiling', runtime, async () => {
  // insight needs marketing's metrics (not optional): removing marketing is refused with the runtime's code.
  const edge = await check({ remove: ['marketing'] });
  assert.equal(edge.ok, false);
  assert.deepEqual(codes(edge), ['company_edge_required']);
  assert.match(edge.diagnostics[0].message, /insight needs marketing\.metrics/);
  assert.deepEqual(codes(await check({ remove: ['insight'] })), ['company_lead_removed']);
  assert.deepEqual(codes(await check({ remove: ['nope'] })), ['company_unknown_team']);
  // An optional edge goes with its removed team.
  assert.equal((await check({ remove: ['financial'] })).ok, true);
  const badField = { contracts: { remove: ['topics'], add: [{ id: 'topics', owner: 'insight', reader: 'marketing', table: 'topics', pack: 'company-loop', mode: 'read', fields: ['nope'] }] } };
  assert.deepEqual(codes(await check(badField)), ['contract_field_unknown']);
  const ghost = { teams: { insight: { } }, contracts: { add: [{ id: 'ghost', owner: 'insight', reader: 'marketing', table: 'ghost', pack: 'company-loop', mode: 'read', fields: ['x'] }] } };
  assert.deepEqual(codes(await check(ghost)), ['contract_item_unknown']);
  assert.deepEqual(codes(await check({ daily_token_ceiling: 1000 })), ['company_over_ceiling']);
  // A contract is data: a narrower field list still passes.
  const narrow = { contracts: { remove: ['topics'], add: [{ id: 'topics', owner: 'insight', reader: 'marketing', table: 'topics', pack: 'company-loop', mode: 'read', fields: ['query'] }] } };
  assert.equal((await check(narrow)).ok, true);
});

test('Lohi end to end: setup.mjs builds the recipe, `soot company adopt` moves it onto teams, `soot check` passes; the saved copy is the way back', runtime, async () => {
  const home = join(work, 'adopt-home'), ws = join(work, 'adopt-ws'), out = join(work, 'lohi.company.json');
  mkdirSync(home, { mode: 0o700 });
  build(ws, { env: true, video: false, connection: null, home });
  chmodSync(ws, 0o700); // the runtime keeps its config revisions beside the deployment and wants a private directory
  const deployment = join(ws, 'deployment.json');
  copyFileSync(deployment, join(work, 'pre-adopt.json'));
  const soot = (...args) => execFileSync(bin, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, SOOT_HOME: home } });
  assert.match(soot('check', '--config', deployment), /Valid: 6 Soot/);
  const { company } = await compileCompany(template, lohi, { mode: 'adopt', root, remotes });
  writeFileSync(out, JSON.stringify(company));
  assert.equal(JSON.parse(soot('company', 'adopt', out, '--config', deployment, '--json')).teams, 5);
  assert.match(soot('check', '--config', deployment), /Valid: 6 Soot/);
  const after = JSON.parse(readFileSync(deployment, 'utf8')), before = JSON.parse(readFileSync(join(work, 'pre-adopt.json'), 'utf8'));
  assert.deepEqual(Object.keys(after.groups).sort(), ['cs', 'financial', 'insight', 'marketing', 'op-catalog']);
  assert.ok(after.schedules.length === before.schedules.length && after.schedules.every(x => x.group), 'every schedule joined its team');
  assert.ok(after.schedules.every((x, i) => x.tool && x.soot === before.schedules[i].soot), 'a tool chain keeps its member');
  const sum = id => Object.keys(after.groups[id].members).reduce((n, m) => n + JSON.parse(readFileSync(join(ws, 'soots', `${m}.json`), 'utf8')).execution.daily_tokens, 0);
  for (const id of ['insight', 'marketing', 'financial', 'op-catalog']) assert.equal(after.groups[id].contract.budget.daily_tokens, sum(id), `${id}: the team budget is the sum of its members' caps`);
  assert.ok(after.access.every(g => g.subject.startsWith('team:') && g.scope.startsWith('soot:') && g.level === 'read'), 'team: read grants on the old soot: scopes');
  assert.deepEqual(after.access.map(g => g.scope).sort(), ['soot:lohi-analyst', 'soot:lohi-catalog', 'soot:lohi-editor', 'soot:lohi-finance', 'soot:lohi-radar', 'soot:lohi-writer']);
  assert.equal(after.default_groups['lohi-writer'], 'marketing', 'each Soot can still be chatted to directly');
  assert.deepEqual(after.company, { name: 'Lohi', lead_team: 'insight', daily_token_ceiling: 550000 });
  assert.equal(before.groups, undefined, 'the copy taken before the adopt has no teams');
});
