import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { TOOLS } from '../tools/ops.mjs';
import { readSkills } from '../../../scripts/catalog.mjs';
import { fileURLToPath } from 'node:url';

const dir = new URL('../', import.meta.url);
const read = f => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const pack = read('pack.json'), frag = read('deployment.fragment.json');
const skills = await readSkills(fileURLToPath(dir));
const names = pack.tools.map(t => t.name);

test('every manifest tool has an implementation, and the other way round', () => {
  assert.deepEqual([...names].sort(), Object.keys(TOOLS).sort());
  assert.equal(new Set(names).size, names.length);
});

test('skills exist; writes that reach readers or a rights holder wait for an operator', () => {
  assert.ok(skills.length > 0);
  for (const s of skills) assert.ok(existsSync(new URL(s.file, dir)), s.file);
  const approval = Object.fromEntries(pack.tools.filter(t => t.run.approval).map(t => [t.name, t.run.approval]));
  for (const n of ['request_reject', 'violation_resolve', 'catalog_job_request', 'catalog_jobs_decide']) assert.equal(approval[n], 'operator', n);
});

test('modes: the read tools are read, anything that stores or posts is write', () => {
  const mode = Object.fromEntries(pack.tools.map(t => [t.name, t.run.mode]));
  for (const n of ['edit_queue', 'edit_context', 'violations_list', 'quality_list', 'seo_report', 'pricing_report']) assert.equal(mode[n], 'read', n);
  for (const n of ['request_accept', 'request_reject', 'edit_verdict', 'violation_resolve', 'enrichment_enqueue', 'duplicates_scan', 'litrans_health', 'catalog_job_request', 'catalog_jobs_sync', 'catalog_jobs_pull', 'catalog_job_run', 'catalog_job_report', 'requests_pending', 'onboard_card', 'catalog_jobs_decide', 'translate_start', 'translate_step', 'request_finish', 'fix_execute', 'fix_recheck', 'chapter_retranslate', 'chapter_tts']) assert.equal(mode[n], 'write', n);
  assert.equal(mode.fixes_pull, 'read');
  assert.equal(mode.reports_open, 'read');
  assert.equal(mode.quality_sample, 'read');
  for (const n of ['quality_verdict', 'release_step']) assert.equal(mode[n], 'write', n);
});

test('only api tools carry the key; job tools carry none and need the runtime scopes', () => {
  for (const t of pack.tools) {
    const hasKey = !!t.run.secret_env?.PRODUCT_AGENT_KEY;
    // catalog_jobs_sync posts the request's stage to the api (curator key); the rest of the job tools carry none.
    if (t.name.startsWith('catalog_job') || t.name === 'radar_scan') assert.equal(hasKey, t.name === 'catalog_jobs_sync', t.name);
    for (const v of Object.values(t.run.secret_env ?? {})) assert.match(v, /^\{\{cred:[A-Z_]+\}\}$/);
  }
  assert.deepEqual(pack.needs.runtime, ['data.read', 'data.insert']);
  assert.ok(pack.needs.env.includes('CLI_DIR'));
});

test('catalog_jobs table has the columns the design names', () => {
  const t = pack.storage.tables.find(x => x.name === 'catalog_jobs');
  assert.deepEqual(t.columns.map(c => c.name), ['product', 'kind', 'subject', 'reason', 'state', 'approved_by', 'result', 'at', 'request_id', 'title', 'source_url', 'novel_slug', 'chapters', 'copyright', 'acked']);
  assert.ok(pack.storage.tables.some(x => x.name === 'findings'));
});

test('deployment fragment: names exist, crawl_watch and job runners are builder-only, no secret values', () => {
  const ref = r => r.split(':tools=')[1].split(',');
  const curator = ref(frag.server.soot_packs.curator[0]), builder = ref(frag.mac.soot_packs.builder[0]);
  for (const n of [...curator, ...builder]) assert.ok(names.includes(n), `unknown tool ${n}`);
  for (const n of ['crawl_watch', 'catalog_jobs_pull', 'catalog_job_run', 'catalog_job_report']) {
    assert.ok(!curator.includes(n), `${n} must not reach the server curator`);
    assert.ok(builder.includes(n));
  }
  for (const s of [...frag.server.schedules, ...frag.mac.schedules]) assert.ok(names.includes(s.tool.name), s.id);
  for (const a of Object.keys(frag.server.grants.approvals)) assert.ok(names.includes(a.replace('lohi-ops_', '')), a);
  assert.ok(!/(sk-|lohi_ak_|-----BEGIN|Bearer )/.test(JSON.stringify(frag)));
  assert.ok(frag.mac.schedules.some(s => s.tool.name === 'crawl_watch'));
});

test('the request loop: tables, curator-only tools, and the translate / fix tools stay off the Mac', () => {
  for (const t of ['request_outcomes', 'translations', 'fix_checks']) assert.ok(pack.storage.tables.some(x => x.name === t), t);
  const ref = r => r.split(':tools=')[1].split(',');
  const curator = ref(frag.server.soot_packs.curator[0]), builder = ref(frag.mac.soot_packs.builder[0]);
  // Role split 2026-11-12: translate and fix tools belong to Catalog Exec, decisions to the curator.
  const exec = ref(frag.server.soot_packs['s-98ffbd86-5b84-4cc4-989c-7905006042dd'][0]);
  for (const n of ['onboard_card', 'catalog_jobs_decide', 'request_finish', 'reports_open']) {
    assert.ok(curator.includes(n), n);
    assert.ok(!builder.includes(n), `${n} must not reach the builder`);
  }
  for (const n of ['translate_step', 'translate_start', 'request_finish', 'fixes_run', 'fix_context', 'fix_resolve', 'fix_recheck', 'chapter_retranslate', 'chapter_tts', 'quality_sample', 'quality_verdict', 'release_step']) {
    assert.ok(exec.includes(n), n);
    assert.ok(!builder.includes(n), `${n} must not reach the builder`);
  }
  assert.equal(frag.server.grants.approvals['lohi-ops_catalog_jobs_decide'], 'operator');
  const ids = frag.server.schedules.map(s => s.id);
  for (const id of ['ops-onboard-card', 'ops-translate-step', 'ops-fixes', 'ops-fix-recheck', 'ops-requests-chapters']) assert.ok(ids.includes(id), id);
});

test('roles: every tool that carries the Lohi key declares a known agent role, key-free tools declare none', async () => {
  const { TOOL_ROLES } = await import('../tools/lib/roles.mjs');
  const known = new Set(['agent_analyst', 'agent_moderator', 'agent_curator', 'agent_catalog_exec', 'agent_marketing']);
  for (const t of pack.tools) {
    const se = t.run.secret_env ?? {};
    const keyed = !!se.PRODUCT_AGENT_KEY;
    assert.equal(!!se.PRODUCT_ADMIN_KEY, keyed, `${t.name} carries both or neither key`);
    const roles = TOOL_ROLES[t.name];
    if (keyed) assert.ok(roles?.length && roles.every(r => known.has(r)), `${t.name} needs a role`);
    else assert.ok(!roles || roles.length === 0, `${t.name} sends no key`);
  }
  for (const [name, roles] of Object.entries(TOOL_ROLES)) assert.ok(pack.tools.some(t => t.name === name), name);
  for (const roles of Object.values(TOOL_ROLES)) assert.ok(!roles.includes('agent_mod'));
});

test('the Catalog Exec loop is tool-first: translate_step and fix_recheck never wake a model, the others only on work', () => {
  const byId = Object.fromEntries(frag.server.schedules.map(s => [s.id, s]));
  for (const id of ['ops-translate-step', 'ops-fix-recheck']) assert.equal(byId[id].wake_when, undefined, id);
  for (const id of ['ops-release-step', 'ops-fixes']) assert.deepEqual(byId[id].wake_when, { notify: true }, id);
  const execSoot = read('../../runtimes/server/config/soots/s-98ffbd86-5b84-4cc4-989c-7905006042dd/soot.json');
  assert.ok(execSoot.execution.max_run_tokens >= 64000, 'sized from the measured release verdict run (about 32000 tokens, cache reads counted) with headroom');
  const intent = frag.server.exec_loop_intent.schedules;
  assert.deepEqual(intent.map(s => s.id).sort(), ['ops-fix-recheck', 'ops-fixes', 'ops-release-step', 'ops-translate-step']);
  for (const s of intent) {
    assert.equal(s.cron, byId[s.id].cron, s.id);
    assert.equal(s.tool, byId[s.id].tool.name, s.id);
    assert.equal(typeof s.token_budget_per_run, 'number', s.id);
    assert.ok(s.token_budget_per_run <= execSoot.execution.max_run_tokens, `inside Catalog Exec max_run_tokens ${execSoot.execution.max_run_tokens}`);
  }
  assert.equal(frag.server.pending_schedules, undefined);
  assert.ok(byId['ops-requests-quality'], 'the quality request has an owner by mail');
});

test('the Mac builds the loop itself: autorun pull, a radar schedule that wakes only on failure, radar_scan builder-only', () => {
  const byId = Object.fromEntries(frag.mac.schedules.map(s => [s.id, s]));
  assert.equal(byId['ops-catalog-jobs-pull'].tool.input.autorun, true);
  assert.equal(byId['ops-radar-scan'].tool.name, 'radar_scan');
  assert.ok(frag.mac.soot_packs.builder[0].includes('radar_scan'));
  for (const list of Object.values(frag.server.soot_packs)) assert.ok(!list[0].includes('radar_scan'));
  assert.ok(pack.tools.find(t => t.name === 'catalog_jobs_pull').parameters.properties.autorun);
});
