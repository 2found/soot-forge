import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readGroups, validateGroup, refPack, refTools } from './groups.mjs';

const root = new URL('..', import.meta.url).pathname;
const packTool = (pack, name) => JSON.parse(readFileSync(new URL(`../packs/${pack}/pack.json`, import.meta.url), 'utf8')).tools.find(t => t.name === name);
const packJson = pack => JSON.parse(readFileSync(new URL(`../packs/${pack}/pack.json`, import.meta.url), 'utf8'));
const source = id => JSON.parse(readFileSync(new URL(`../groups/${id}/group.source.json`, import.meta.url), 'utf8'));

test('the catalog lists the Đầu mối templates (no root) first and every template validates', async () => {
  const catalog = await readGroups(root);
  assert.deepEqual(catalog.groups.map(g => g.id), ['marketing-team', 'team-insight', 'team-marketing', 'team-financial', 'team-op', 'support-team', 'society-sim', 'server-watch']);
  for (const id of ['marketing-team', 'team-insight', 'team-marketing', 'team-financial', 'team-op', 'support-team', 'server-watch']) {
    const t = source(id);
    assert.equal(t.api_version, id.startsWith('team-') ? 'soot/group-template/v3' : 'soot/group-template/v2');
        assert.equal(t.root, '', `${id} asks for its Đầu mối`);
    for (const m of t.members) {
      assert.match(m.soul, /Đầu mối/, `${id}/${m.id} knows what to do as the team's Đầu mối`);
      assert.doesNotMatch(`${m.soul} ${m.mission} ${t.description}`, /Kamaji|\bthe lead\b/, `${id}/${m.id}: the Lead is in no team`);
    }
    assert.ok(t.inputs.some(i => i.confirm), `${id} confirms something before proposing`);
    for (const p of t.profiles) assert.deepEqual(Object.keys(p.members).sort(), t.members.map(m => m.id).sort(), `${id}/${p.id}`);
  }
});

test('templates carry no credentials, grants or approvals', () => {
  for (const id of ['marketing-team', 'team-insight', 'team-marketing', 'team-financial', 'team-op', 'support-team']) {
    const raw = readFileSync(new URL(`../groups/${id}/group.source.json`, import.meta.url), 'utf8');
    assert.doesNotMatch(raw, /service_token|"token"|approvals|host_use|host_packs|access"/, id);
  }
});

test('server-watch: one server-care Soot, a paused daily cron job, remediation held for an operator', async () => {
  const t = validateGroup(source('server-watch'));
  assert.deepEqual(t.members.map(m => m.id), ['care']);
  assert.ok(t.members[0].packs.includes('server-care'));
  assert.equal(t.schedules.length, 1);
  assert.equal(t.schedules[0].paused, true);
  assert.equal(t.schedules[0].cron, '0 7 * * *');
  assert.equal(t.schedules[0].every, undefined);
  const pack = JSON.parse(readFileSync(new URL('../packs/server-care/pack.json', import.meta.url), 'utf8'));
  assert.equal(pack.tools.find(x => x.name === 'remediate').run.approval, 'operator');
  assert.ok(pack.outcomes.some(o => o.id === 'alert_triaged'));
  const bad = (change, why) => assert.throws(() => validateGroup(change(structuredClone(t))), undefined, why);
  bad(x => { x.schedules[0].every = '24h'; return x; }, 'every and cron together');
  bad(x => { delete x.schedules[0].cron; return x; }, 'neither every nor cron');
  bad(x => { x.schedules[0].cron = '0 7 * *'; return x; }, 'a four-field cron');
  bad(x => { x.schedules[0].paused = 'yes'; return x; }, 'paused is a boolean');
});

test('v2 fields are refused on v1, and v2 is checked like the runtime checks it', () => {
  const v2 = source('marketing-team');
  const bad = (change, why) => assert.throws(() => validateGroup(change(structuredClone(v2))), undefined, why);
  bad(t => ({ ...t, api_version: 'soot/group-template/v1' }), 'v1 with inputs');
  bad(t => { t.root = ''; t.api_version = 'soot/group-template/v1'; delete t.inputs; delete t.profiles; delete t.schedules; return t; }, 'v1 without a root');
  bad(t => { delete t.profiles[0].members.editor; return t; }, 'a profile must name every member');
  bad(t => { t.profiles[0].members.radar.tier = 'imagen'; return t; }, 'a member tier is a language tier');
  bad(t => { t.profiles[0].schedules = ['nope']; return t; }, 'an unknown schedule');
  bad(t => { t.schedules[0].every = '30m'; return t; }, 'a cycle shorter than an hour');
  bad(t => { t.schedules[0].at = '24:00'; return t; }, 'a bad clock');
  bad(t => { t.schedules[0].timezone = 'Asia/Ho_Chi_Minh'; delete t.schedules[0].at; return t; }, 'a timezone without a time');
  bad(t => { t.inputs.push({ ...t.inputs[0] }); return t; }, 'a repeated input');
  bad(t => { t.inputs[0].secret = true; return t; }, 'an unknown input field');
  bad(t => { t.members[0].packs.push('not-a-dependency'); return t; }, 'a member selects a dependency of the template');
  bad(t => { t.members[0].packs = ['marketing', 'marketing:read']; return t; }, 'a pack once per member');
  bad(t => { t.members[0].use = []; return t; }, 'use is retired');
  assert.doesNotThrow(() => validateGroup(structuredClone(v2)));
});

test('marketing-team is hubless and asks for publish approval, required by default', () => {
  const t = validateGroup(source('marketing-team'));
  const raw = readFileSync(new URL('../groups/marketing-team/group.source.json', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /MARKETING_HUB|hub/i, 'no hub bindings or hub missions');
  const ask = t.inputs.find(i => i.id === 'publish_approval');
  assert.ok(ask?.confirm, 'publish_approval is confirmed before proposing');
  assert.match(ask.ask, /Mặc định là required/, 'the default is required');
  assert.match(ask.ask, /none:.*marketing_claim là auto/, 'only none relaxes the claim');
  assert.deepEqual(t.bindings.map(b => [b.member, b.name]), [['editor', 'MARKETING_CLAIM_KEY'], ['editor', 'PRODUCT_ADMIN_KEY']]);
  assert.match(t.members.find(m => m.id === 'editor').mission, /marketing_claim/);
  const pack = JSON.parse(readFileSync(new URL('../packs/marketing/pack.json', import.meta.url), 'utf8'));
  assert.equal(pack.tools.find(x => x.name === 'claim').run.approval, 'operator', 'approval on unless the host says auto');
  const lohi = JSON.parse(readFileSync(new URL('../examples/lohi-marketing/deployment.example.json', import.meta.url), 'utf8'));
  assert.equal(lohi.approvals.marketing_claim, 'auto', 'the Lohi recipe is publish_approval none');
});

test('company team groups: one group per team, roles by job, no private content table, support is not a member, lean budgets below the old ceiling', () => {
  const g = Object.fromEntries(['team-insight', 'team-marketing', 'team-financial', 'team-op'].map(id => [id, validateGroup(source(id))]));
  assert.deepEqual(g['team-insight'].members.map(m => m.id), ['analyst', 'radar']);
  assert.deepEqual(g['team-marketing'].members.map(m => m.id), ['writer', 'publisher']);
  assert.deepEqual(g['team-financial'].members.map(m => m.id), ['finance']);
  assert.deepEqual(g['team-financial'].members[0].packs, ['company-loop:tools=signals', 'marketing:read'], 'finance is read-only: one read tool and a read-only pack');
  assert.equal(packTool('company-loop', 'signals').run.mode, 'read');
  assert.match(g['team-financial'].members[0].mission, /never change a price|never change a price, a budget/i);
  assert.match(g['team-marketing'].members[0].mission, /no `content` table/);
  assert.match(g['team-marketing'].members[0].mission, /Never check, schedule or publish/);
  assert.deepEqual(g['team-insight'].members[1].packs, ['marketing:tools=radar_read,signals_list,signals_mark'], 'the radar carries three tools of the pack, not forty');
  assert.match(g['team-insight'].members[1].mission, /Never post, reply, sign in/);
  assert.doesNotMatch(JSON.stringify(g), /team table `content`/);
  const lean = Object.values(g).flatMap(x => Object.values(x.profiles.find(p => p.id === 'lean').members));
  assert.ok(lean.reduce((n, m) => n + m.daily_tokens, 0) < 550000, 'below the old Writer 250k + Editor 300k');
  assert.ok(lean.every(m => m.tier === 'lite' || m.tier === 'flash'));
  const bad = fn => assert.throws(() => validateGroup(fn(structuredClone(g['team-insight']))));
  bad(x => { x.members[1].packs = ['marketing', 'nope']; return x; });
  bad(x => { x.profiles[0].members.radar.tier = 'huge'; return x; });
});

const TEAMS = ['team-insight', 'team-marketing', 'team-financial', 'team-op'];

test('v3: the team templates carry a contract, a team budget per profile and member tool-chain schedules', () => {
  for (const id of TEAMS) {
    const t = validateGroup(source(id));
    assert.equal(t.api_version, 'soot/group-template/v3', id);
    assert.equal(t.contract.version, 'team-contract/v1', id);
    assert.ok(t.contract.decides.self.length && t.contract.escalates.length, `${id} says what it decides and when it escalates`);
    assert.deepEqual([t.contract.consumes, t.contract.requests], [undefined, undefined], `${id}: edges are the company's, a group alone has no other team`);
    for (const p of t.profiles) {
      assert.ok(p.team_daily_tokens >= Object.values(p.members).reduce((n, m) => n + m.daily_tokens, 0), `${id}/${p.id}: the team budget holds its members' caps`);
    }
    const lean = t.profiles.find(p => p.id === 'lean');
    assert.equal(t.contract.budget.daily_tokens, lean.team_daily_tokens, `${id}: the contract budget is the lean team budget`);
    assert.equal(lean.team_daily_tokens, Object.values(lean.members).reduce((n, m) => n + m.daily_tokens, 0), `${id}: lean team budget = sum of member caps`);
  }
});

test('v3: every tool a chain calls exists in its pack, is granted to the member that runs it and is not a write by a read-only member', () => {
  for (const id of TEAMS) {
    const t = source(id);
    for (const s of (t.schedules ?? []).filter(x => x.tool)) {
      const member = t.members.find(m => m.id === s.member);
      for (const step of [{ pack: s.tool.pack, tool: s.tool.name }, ...(s.then ?? []).map(x => ({ pack: x.pack, tool: x.tool }))]) {
        const tool = packTool(step.pack, step.tool);
        assert.ok(tool, `${id}/${s.id}: ${step.pack}.${step.tool} exists`);
        const ref = member.packs.find(r => refPack(r) === step.pack);
        assert.ok(ref, `${id}/${s.id}: ${member.id} selects ${step.pack}`);
        if (ref.endsWith(':read')) assert.equal(tool.run.mode, 'read', `${id}/${s.id}: ${step.tool} is read for a read-only selection`);
        const only = refTools(ref);
        if (only) assert.ok(only.includes(step.tool), `${id}/${s.id}: ${step.tool} is in the member's allow-list`);
      }
    }
    for (const m of t.members) for (const ref of m.packs) for (const name of refTools(ref) ?? []) assert.ok(packTool(refPack(ref), name), `${id}: ${m.id} narrows to a real tool ${name}`);
  }
});

test('v3: contract tables name real columns of their packs, and a member of the team selects each pack', () => {
  for (const id of TEAMS) {
    const t = source(id);
    for (const tb of t.contract.provides?.tables ?? []) {
      const table = packJson(tb.pack).storage.tables.find(x => x.name === tb.table);
      assert.ok(table, `${id}: ${tb.pack}.${tb.table}`);
      const cols = new Set(table.columns.map(c => c.name));
      for (const f of tb.fields) assert.ok(cols.has(f), `${id}: ${tb.table} has column ${f}`);
      assert.ok(!table.columns.some(c => c.principal && tb.fields.includes(c.name) && tb.tenant === 'all'), `${id}: no principal column leaves under tenant all`);
      assert.ok(t.members.some(m => m.packs.some(r => refPack(r) === tb.pack)), `${id}: a member selects ${tb.pack}`);
    }
  }
});

test('v3 fields are refused where the runtime refuses them', () => {
  const t = source('team-insight');
  const bad = (change, why) => assert.throws(() => validateGroup(change(structuredClone(t))), undefined, why);
  bad(x => ({ ...x, api_version: 'soot/group-template/v2' }), 'a contract on v2');
  bad(x => { delete x.schedules[1].member; return x; }, 'a chain nobody runs: the lead holds none of the team packs');
  bad(x => { x.schedules[1].member = 'nobody'; return x; }, 'a chain run by a non-member');
  bad(x => { x.members[1].packs = ['marketing:tools=signals_list']; return x; }, 'a chain tool outside the member allow-list');
  bad(x => { x.members[1].packs = ['company-loop']; return x; }, 'a chain pack the member does not select');
  bad(x => { x.schedules[1].tool.pack = 'writing'; return x; }, 'a chain pack the template does not ship');
  bad(x => { x.schedules[1].then = Array(9).fill({ pack: 'marketing', tool: 'plan' }); return x; }, 'more than eight steps');
  bad(x => { x.schedules[1].then = [{ pack: 'marketing', tool: 'plan', input_from: 'elsewhere' }]; return x; }, 'input_from other than previous');
  bad(x => { x.contract.consumes = [{ team: 'marketing', item: 'posts' }]; return x; }, 'an edge inside a group template');
  bad(x => { x.contract.provides.tables[0].pack = 'writing'; return x; }, 'a provided pack the template does not ship');
  bad(x => { x.contract.provides.tables[0].tenant = ''; return x; }, 'a table without a tenant');
  bad(x => { x.contract.escalates[0].on = 'whenever'; return x; }, 'an unknown trigger');
  bad(x => { x.profiles[0].team_daily_tokens = -1; return x; }, 'a negative team budget');
  bad(x => { x.members[1].packs = ['marketing:tools=Radar-Read']; return x; }, 'a malformed tool list');
});

test('the built catalog says which templates ask for a Đầu mối (root "")', async () => {
  const { buildLocalGroups } = await import('./support/local-groups.mjs');
  const { mkdtemp, rm, readFile: read } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const work = await mkdtemp(join(tmpdir(), 'forge-groups-root-'));
  try {
    const dist = await buildLocalGroups(root, join(work, 'dist'));
    const built = JSON.parse(await read(join(dist, 'groups.json'), 'utf8'));
    const byId = Object.fromEntries(built.groups.map(g => [g.id, g]));
    assert.equal(byId['marketing-team'].root, '', 'no root: the installer picks the Đầu mối');
    assert.equal(byId['society-sim'].root, 'moderator');
  } finally { await rm(work, { recursive: true, force: true }); }
});
