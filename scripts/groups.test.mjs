import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSkills } from './catalog.mjs';
import { readGroups, validateGroup, refPack, refTools, partOwners, PARTS } from './groups.mjs';

const root = new URL('..', import.meta.url).pathname;
const packTool = (pack, name) => JSON.parse(readFileSync(new URL(`../packs/${pack}/pack.json`, import.meta.url), 'utf8')).tools.find(t => t.name === name);
const packJson = pack => JSON.parse(readFileSync(new URL(`../packs/${pack}/pack.json`, import.meta.url), 'utf8'));
const source = id => JSON.parse(readFileSync(new URL(`../groups/${id}/group.source.json`, import.meta.url), 'utf8'));

const STANDARD = ['insight', 'growth', 'support', 'operations'];
const DEPRECATED = { 'marketing-team': 'growth', 'support-team': 'support', 'team-insight': 'insight', 'team-marketing': 'growth', 'team-financial': 'insight', 'team-op': 'operations', 'finance': 'insight' };

test('the catalog lists the five standard teams first, then the utilities, then the deprecated ids; every template validates', async () => {
  const catalog = await readGroups(root);
  assert.deepEqual(catalog.groups.map(g => g.id), [...STANDARD, 'workshop', 'society-sim', 'server-watch', ...Object.keys(DEPRECATED)]);
  for (const id of [...STANDARD, 'workshop', 'server-watch', ...Object.keys(DEPRECATED)]) {
    const t = source(id);
    assert.equal(t.api_version, STANDARD.includes(id) || ['workshop','finance'].includes(id) || id.startsWith('team-') ? 'soot/group-template/v3' : 'soot/group-template/v2');
        assert.equal(t.root, id === 'growth' ? 'editor' : '', `${id} asks for its Đầu mối, except growth: Biên tập is its Đầu mối and the wizard asks for none`);
    assert.match(t.members[0].soul, /Đầu mối/, `${id}/${t.members[0].id} knows what to do as the team's Đầu mối`);
    for (const m of t.members) {
      assert.doesNotMatch(`${m.soul} ${m.mission} ${t.description}`, /Kamaji|\bthe lead\b/, `${id}/${m.id}: the Lead is in no team`);
    }
    // growth asks nothing: the Marketing desk's setup is the one place a product is entered (re-audit N2).
    if (id === 'growth') assert.equal(t.inputs, undefined, 'growth asks no brief');
    else assert.ok(t.inputs.some(i => i.confirm), `${id} confirms something before proposing`);
    for (const p of t.profiles) assert.deepEqual(Object.keys(p.members).sort(), t.members.map(m => m.id).sort(), `${id}/${p.id}`);
  }
});

test('the Đầu mối of every current template can make a Nest screen: it selects soot-nest, a pack of skills alone', async () => {
  assert.equal(packJson('soot-nest').tools, undefined, 'soot-nest grants no tool, so a read-only member stays read-only');
  assert.ok((await readSkills(join(root, 'packs', 'soot-nest'))).some(s => s.name === 'nest-pieces'));
  for (const id of [...STANDARD, 'workshop', 'server-watch']) {
    const t = source(id);
    assert.ok(t.members[0].packs.includes('soot-nest'), `${id}/${t.members[0].id}`);
    assert.ok(t.packs.some(p => p.id === 'soot-nest'), `${id} ships soot-nest`);
  }
  assert.ok(source('workshop').members.every(m => m.packs.includes('soot-nest')), 'both workshop members talk to the founder on their own computer');
});

test('templates carry no credentials, grants or approvals', () => {
  for (const id of [...STANDARD, ...Object.keys(DEPRECATED)]) {
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
  assert.equal(lohi.grants.approvals.marketing_claim, 'auto', 'the Lohi recipe is publish_approval none');
});

test('company team groups: one group per team, roles by job, no private content table, lean budgets below the old ceiling', () => {
  const g = Object.fromEntries(STANDARD.map(id => [id, validateGroup(source(id))]));
  assert.deepEqual(g.insight.members.map(m => m.id), ['analyst'], 'insight is the analyst alone: the radar moved to growth');
  assert.deepEqual(g.growth.members.map(m => m.id), ['editor', 'writer']);
  assert.deepEqual(g.support.members.map(m => m.id), ['support', 'desk', 'reception'], 'a Soot cannot be its own feedback desk, and a public web chat gets its own member');
  assert.deepEqual(g.operations.members.map(m => m.id), ['operator', 'curator', 'moderator', 'catalog-exec']);
  const writer = g.growth.members.find(m => m.id === 'writer'), editor = g.growth.members.find(m => m.id === 'editor');
  assert.match(writer.mission, /radar/i, 'the writer watches the radar');
  assert.deepEqual(editor.packs[0], 'marketing', 'the Đầu mối holds the full marketing pack');
  assert.deepEqual(g.growth.bindings.map(b => [b.member, b.name]), [['editor', 'MARKETING_CLAIM_KEY']]);
  assert.deepEqual(g.insight.members[0].packs, ['company-loop', 'marketing:tools=campaign_report', 'team-rhythm', 'soot-nest'], 'the analyst reads the market, it does not collect it');
  assert.doesNotMatch(JSON.stringify(g.insight), /radar_read/, 'insight carries no radar');
  assert.ok(g.insight.schedules.some(s => s.id === 'money-review' && s.member === 'analyst'), 'the weekly money review is the analyst\'s');
  assert.match(g.insight.members[0].mission, /read-only|chỉ đọc/i, 'the money review is read-only');
  // growth is generic: no product is named in it, and the desk's tool-only cycles run on the Editor without a model turn.
  const growthRaw = readFileSync(new URL('../groups/growth/group.source.json', import.meta.url), 'utf8');
  assert.doesNotMatch(growthRaw, /lohi|2novel|2found|trysoot|-brand"|radar-lohi|publish_approval|site hub|marketing hub/i, 'no product, brand pack or hub wording in growth');
  // The desk's setup is the one place a product is entered: no product or voice question in the wizard, no mission
  // or cycle reading one from the brief, and the card says where the first product goes.
  assert.equal(g.growth.inputs, undefined, 'the wizard asks no product question');
  assert.doesNotMatch(JSON.stringify([g.growth.members, g.growth.schedules]), /brief\.(product|voice)|\{\{\s*(product|voice)/, 'nothing reads a product from the brief');
  assert.match(g.growth.description, /Mở bàn Marketing để thêm sản phẩm đầu tiên/);
  // Nest's wizard says "Mẫu cần <purpose> cho Biên tập" and "Kết nối <purpose> cho Biên tập": a short phrase, no sentence of its own.
  const purpose = g.growth.bindings[0].purpose;
  assert.ok([...purpose].length <= 60, purpose);
  assert.doesNotMatch(purpose, /[.;:]|Nest|Kho khóa|chat|^[A-ZĐ]/, 'a lower-case phrase that fits inside the wizard\'s sentence');
  assert.deepEqual(g.growth.default, [], 'Biên tập is the root, so the wizard asks for no Đầu mối');
  assert.match(g.growth.description, /thẻ duyệt trong Cần bạn/, 'the card says publishing already asks the founder');
  const tools = Object.fromEntries(g.growth.schedules.filter(s => s.tool).map(s => [s.tool.name, [s.member, s.cron ?? s.every]]));
  assert.deepEqual(tools, { release_due: ['editor', '*/5 * * * *'], library_scan: ['editor', '*/30 * * * *'], gsc_sync: ['editor', '24h'] });
  assert.deepEqual(g.growth.profiles.find(p => p.id === 'lean').schedules.slice(-3), ['release', 'library-scan', 'gsc-sync'], 'the lean profile keeps the tool cycles');
  assert.match(writer.packs[0], /\bfile_read\b/, 'the writer reads brand.md and notes');
  assert.match(editor.mission, /products\.json[\s\S]*brand\.md/, 'missions read the desk setup');
  assert.match(g.operations.members.find(m => m.id === 'curator').mission, /curator/i);
  // The reception is a public-facing Soot: read_skill only, no account tools; the desk sorts the feedback.
  assert.deepEqual(g.support.members.find(m => m.id === 'reception').packs, ['2found-knowledge']);
  assert.match(g.support.members.find(m => m.id === 'desk').mission, /voc/, 'the desk sorts the feedback');
  const lean = Object.values(g).flatMap(x => Object.values(x.profiles.find(p => p.id === 'lean').members));
  assert.ok(lean.every(m => ['lite', 'flash'].includes(m.tier)));
  const leanTeams = Object.fromEntries(STANDARD.map(id => [id, g[id].profiles.find(p => p.id === 'lean').team_daily_tokens]));
  assert.deepEqual(leanTeams, { insight: 130000, growth: 250000, support: 400000, operations: 400000 });
  const bad = fn => assert.throws(() => validateGroup(fn(structuredClone(g.insight))));
  bad(x => { x.members[0].packs = ['marketing', 'nope']; return x; });
  bad(x => { x.profiles[0].members.analyst.tier = 'huge'; return x; });
  bad(x => { x.profiles[0].members.radar = { tier: 'lite', daily_tokens: 1 }; return x; });
});

const TEAMS = STANDARD;

test('v3: the team templates carry a contract, a team budget per profile and member tool-chain schedules', () => {
  for (const id of TEAMS) {
    const t = validateGroup(source(id));
    assert.equal(t.api_version, 'soot/group-template/v3', id);
    assert.equal(t.contract.version, 'team-contract/v1', id);
    assert.ok(t.contract.decides.self.length && t.contract.escalates.length, `${id} says what it decides and when it escalates`);
    assert.deepEqual([t.contract.consumes, t.contract.requests], [undefined, undefined], `${id}: edges are the company's, a group alone has no other team`);
    assert.equal(t.root, id === 'growth' ? 'editor' : '', `${id}: the installer names the Đầu mối (growth: always Biên tập)`);
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
  const t = source('insight');
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
    assert.equal(byId['society-sim'].root, 'analyst');
  } finally { await rm(work, { recursive: true, force: true }); }
});

// ---- the standard set: five teams, one Đầu mối each, the five parts of a business ------------------------------------

test('standard teams: each names the parts it owns and its entries (the Đầu mối first), and together they own all five parts', async () => {
  const catalog = await readGroups(root);
  const by = Object.fromEntries(catalog.groups.map(g => [g.id, g]));
  assert.deepEqual(Object.fromEntries(STANDARD.map(id => [id, by[id].parts])), { insight: ['value'], growth: ['marketing', 'sales'], support: ['delivery'], operations: ['delivery'] });
  assert.deepEqual(Object.fromEntries(STANDARD.map(id => [id, by[id].entries])), { insight: ['analyst'], growth: ['editor'], support: ['support', 'desk', 'reception'], operations: ['operator', 'curator', 'moderator', 'catalog-exec'] });
  assert.deepEqual(STANDARD.map(id => by[id].name), ['Insight', 'Growth', 'Support', 'Operations'], 'English team names');
  // A template written for 2found's own products is marked Thử nghiệm · Nội bộ in the gallery; only growth is generic.
  assert.deepEqual(STANDARD.filter(id => by[id].audience !== 'internal'), ['growth']);
  for (const id of ['insight', 'support', 'operations', 'workshop']) assert.equal(by[id].stability, 'experimental', id);
  // Every part has an owning team template; company-loop's part check maps a part to the team that holds it.
  const owners = partOwners(catalog);
  assert.deepEqual(Object.keys(owners), PARTS);
  for (const part of PARTS.filter(p => p !== 'finance')) assert.ok(owners[part].length >= 1, `${part} has an owning team template`);
  assert.deepEqual(owners.finance, [], 'no standalone finance team: the money review covers it');
  assert.deepEqual(owners, { value: ['insight'], marketing: ['growth'], sales: ['growth'], delivery: ['support', 'operations'], finance: [] });
  // Only the entry teams that take chats list more than one entry: a member that is not an entry cannot be chatted to (2agent conversation.resolveGroup).
  assert.deepEqual(STANDARD.filter(id => by[id].entries.length > 1), ['support', 'operations']);
  for (const id of STANDARD) assert.ok(by[id].entries.every(e => source(id).members.some(m => m.id === e)), id);
  // The utilities own no part and are not part of the standard set.
  for (const id of ['society-sim', 'server-watch']) assert.equal(by[id].parts, undefined, id);
  // The first member of a standard template is its Đầu mối (the compiler's mirror and the runtime's adopt order read it).
  for (const id of STANDARD) assert.equal(source(id).members[0].id, by[id].entries[0], `${id}: the first member is the Đầu mối`);
});

test('deprecated ids stay installable unchanged and name the template that replaces them', async () => {
  const catalog = await readGroups(root);
  for (const [old, now] of Object.entries(DEPRECATED)) {
    const e = catalog.groups.find(g => g.id === old), t = validateGroup(source(old));
    assert.equal(e.stability, 'deprecated', old);
    assert.equal(e.replaced_by, now, old);
    assert.ok(STANDARD.includes(now), `${old} is replaced by a standard team`);
    assert.match(t.description, new RegExp(`^Deprecated, use \`${now}\``), old);
    assert.equal(e.parts, undefined, `${old} owns no part`);
  }
  assert.deepEqual(partOwners(catalog).marketing, ['growth'], 'a deprecated template owns nothing');
});

test('the catalog refuses a bad part, a foreign entry and an unmatched replaced_by', async () => {
  const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'forge-catalog-'));
  try {
    await cp(join(root, 'groups'), join(dir, 'groups'), { recursive: true });
    const base = JSON.parse(readFileSync(join(root, 'groups.json'), 'utf8'));
    const refuses = async (change, why) => {
      const c = structuredClone(base); change(c.groups);
      await writeFile(join(dir, 'groups.json'), JSON.stringify(c));
      await assert.rejects(readGroups(dir), undefined, why);
    };
    await writeFile(join(dir, 'groups.json'), JSON.stringify(base));
    await readGroups(dir);
    await refuses(g => { g[0].parts = ['money']; }, 'an unknown part');
    await refuses(g => { g[0].parts = ['value', 'value']; }, 'a repeated part');
    await refuses(g => { g[0].entries = ['nobody']; }, 'an entry that is not a member');
    await refuses(g => { g.find(x => x.id === 'team-op').replaced_by = 'team-insight'; }, 'replaced by a deprecated template');
    await refuses(g => { delete g.find(x => x.id === 'team-op').replaced_by; }, 'deprecated without a replacement');
    await refuses(g => { g[0].replaced_by = 'growth'; }, 'replaced_by on a live template');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workshop: builder and poster for a computer with a browser and a coding agent, the Mac pulls', async () => {
  const w = validateGroup(source('workshop'));
  const entry = (await readGroups(root)).groups.find(g => g.id === 'workshop');
  assert.deepEqual(w.members.map(m => m.id), ['builder', 'poster']);
  assert.deepEqual(entry.entries, ['builder', 'poster'], 'the builder is the Đầu mối');
  assert.equal(entry.parts, undefined, 'workshop owns no part: the standard owners stay');
  const [builder, poster] = w.members;
  assert.deepEqual(builder.packs, ['company-loop:tools=builds_pull,team_watch', 'lohi-ops:tools=catalog_jobs_pull,catalog_job_run,catalog_job_report,crawl_watch', 'marketing:tools=video_import', 'toolbox', 'team-rhythm', 'soot-nest'], 'the builder pulls approved work');
  assert.match(builder.mission, /Go in the insight team is the approval/);
  assert.ok(poster.packs.includes('browser-use') && poster.packs.some(r => refPack(r) === 'social-poster'), 'the poster uses the browser through social-poster');
  assert.ok(!poster.packs.some(r => refTools(r)?.includes('draft_save')), 'the poster never writes');
  for (const t of ['builds_pull', 'team_watch']) assert.equal(packTool('company-loop', t).run.mode, 'write', t);
  assert.deepEqual(w.schedules.map(s => s.id), ['builds-pull', 'builds-watch', 'ops-crawl-watch', 'ops-catalog-jobs-pull', 'social-post', 'social-read-x']);
  assert.match(w.description, /trình duyệt/, 'it says it needs a browser and a coding agent');
  // A chain must run with the member's own grants: the poster does not hold the loop pack.
  const bad = fn => assert.throws(() => validateGroup(fn(structuredClone(w))));
  bad(x => { x.schedules[0].member = 'poster'; return x; });
  bad(x => { x.members[0].packs = ['company-loop:tools=team_watch', 'team-rhythm']; return x; });
});
