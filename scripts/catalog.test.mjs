import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCatalog, validatePack, checkPackModel, checkPieceBundles, materialize, sourceLink, installCommand, readCatalog, tagCommit, checkRetiredTarget } from './catalog.mjs';
import { archivePack } from './archive.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const entry = { id: 'example', name: 'Example', description: 'Example pack.', tags: ['research'], source: { kind: 'bundled', path: 'packs/example' } };
function catalog(pack = entry) { return { version: 1, repository: '2found/soot-forge', packs: [structuredClone(pack)] }; }
const linked = { ...entry, source: { kind: 'github', repository: 'someone/repo', path: 'packs/example', ref: 'a'.repeat(40), version: '1.2.3' } };

test('validation rejects unknown flags and missing or duplicate installer options', async () => {
  const exec = promisify(execFile);
  for (const args of [['--unknown'], ['--soot'], ['--soot', '--remote'], ['--remote', '--remote'], ['--soot', 'soot', '--soot', 'soot']]) {
    await assert.rejects(exec(process.execPath, [join(import.meta.dirname, 'validate.mjs'), ...args]), error => error.code === 1 && /Usage:/.test(error.stderr));
  }
});

test('both contribution modes produce GitHub folder install commands', () => {
  validateCatalog(catalog()); validateCatalog(catalog(linked));
  assert.equal(sourceLink(entry), 'https://github.com/2found/soot-forge/tree/main/packs/example');
  assert.equal(installCommand(linked), `soot add https://github.com/someone/repo/tree/${'a'.repeat(40)}/packs/example`);
  assert.match(installCommand(entry, 'v1.2.3'), /tree\/v1\.2\.3\/packs\/example$/);
});

test('PR metadata rejects duplicate IDs, unknown fields, traversal and moving refs', () => {
  const mutations = [
    c => c.packs.push(c.packs[0]), c => c.version = 2, c => c.repository = 'other/repo',
    c => delete c.packs[0].id, c => c.packs[0].id = {}, c => c.packs[0].id = 'Bad Name', c => c.packs[0].unknown = true,
    c => c.packs[0].name = 'unsafe\nname', c => c.packs[0].source.path = 'packs/../private',
    c => c.packs[0].source.path = '/tmp/example', c => c.packs[0].source.path = 'packs/.git',
    c => c.packs[0].source.path = 'packs/other', c => c.packs[0].source.extra = true,
    c => c.packs[0].source = { ...linked.source, ref: 'main' },
    c => c.packs[0].source = { ...linked.source, repository: 'https://github.com/owner/repo' },
    c => c.packs[0].source = { ...linked.source, repository: 'owner/repo;echo' },
    c => c.packs[0].tags = ['tag', 'tag'], c => c.packs[0].tags = [1],
    c => c.packs[0].source = { ...linked.source, version: undefined }, c => c.packs[0].source = { ...linked.source, version: 'v1.2.3' },
    c => c.packs[0].source = { ...linked.source, version: '1.2' }, c => c.packs[0].source = { ...linked.source, version: '1.2.3-rc.1' },
    c => c.packs[0].source = { ...linked.source, version: 123 }, c => c.packs[0].source.version = '1.2.3',
  ];
  for (const mutate of mutations) {
    const value = catalog(); mutate(value);
    assert.throws(() => validateCatalog(value));
  }
});

test('a retired pack merges into a listed one by an explicit tool map', () => {
  const retired = { id: 'old', into: 'example', tools: { view: 'website_view' } };
  validateCatalog({ ...catalog(), retired: [retired] });
  for (const bad of [
    { ...retired, id: 'example' }, { ...retired, into: 'missing' },
    { ...retired, capabilities: { configure: 'website' } }, { ...retired, tools: ['view'] }, { ...retired, extra: true },
  ]) assert.throws(() => validateCatalog({ ...catalog(), retired: [bad] }), JSON.stringify(bad));
  assert.throws(() => validateCatalog({ ...catalog(), retired: [retired, retired] }));
  const manifest = { tools: [{ name: 'website_view' }] };
  checkRetiredTarget(retired, manifest);
  assert.throws(() => checkRetiredTarget({ ...retired, tools: { view: 'view' } }, manifest), /no tool view/);
});

test('outcomes and piece capabilities are checked like the host checks them', () => {
  const tool = { name: 'view', run: { program: 'tools/run', mode: 'read', stdin: 'context' } };
  const base = () => ({ id: 'p', skills: [], tools: [tool], outcomes: [{ id: 'conversation_resolved', label: { vi: 'Đã giải quyết' }, unit: 'conversation', void_window: '72h', void_on: 'binding_activity' }],
    interface: { pieces: [{ id: 'library', slot: 'data.tab', label: 'Kho', icon: 'library', access: 'operator', data: { view_tool: 'view' }, bundle: 'page/', provides: ['knowledge'] }] } });
  checkPackModel(base(), 'p');
  const bad = (change, pattern) => assert.throws(() => checkPackModel(change(base()), 'p'), pattern);
  bad(p => { p.outcomes[0].void_on = 'always'; return p; }, /void_on/);
  bad(p => { p.outcomes[0].void_window = 'soon'; return p; }, /void_window/);
  bad(p => { p.outcomes.push(p.outcomes[0]); return p; }, /duplicate/);
  bad(p => { p.outcomes[0].unit = ''; return p; }, /unit/);
  bad(p => { p.interface.pieces[0].provides = ['Knowledge!']; return p; }, /provides/);
});

test('the pack model: write tools are marked, and needs match the credentials tools read', () => {
  const need = { title: 'Key', description: 'The key.' };
  const tool = (name, mode, cred) => ({ name, run: { program: 'tools/run', mode, ...(cred ? { secret_env: { KEY: `{{cred:${cred}}}` } } : {}) } });
  const pack = { id: 'p', skills: [{ name: 's', file: 'skills/s.md' }], tools: [tool('list', 'read', 'KEY'), tool('save', 'write', 'KEY')], needs: { credentials: { KEY: need } } };
  checkPackModel(pack, 'p');
  const bad = (change, pattern) => assert.throws(() => checkPackModel(change(structuredClone(pack)), 'p'), pattern);
  bad(p => { delete p.tools[1].run.mode; return p; }, /run\.mode/);
  bad(p => { p.tools[1].run.mode = 'read'; return p; }, /named like a change/);
  bad(p => { delete p.needs; return p; }, /not declared/);
  bad(p => { p.needs.credentials.SPARE = need; return p; }, /declared but no tool/);
  bad(p => { p.needs.credentials.KEY.from = 'keychain'; return p; }, /unknown source/);
  bad(p => { p.tools[0].run.env = ['PATH']; return p; }, /run\.env/);
  bad(p => { p.tools.push(tool('list', 'read')); return p; }, /duplicate tool/);
});

test('materialization rejects symlink ancestors, missing skills, mismatched ID and forbidden or retired manifest fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'packs/example'); await mkdir(directory, { recursive: true });
  const manifest = { api_version: 'soot/v1', id: 'example', skills: [{ name: 'guide', file: 'guide.md' }] };
  await writeFile(join(directory, 'pack.json'), JSON.stringify(manifest));
  await assert.rejects(validatePack(directory, 'example'), /ENOENT/);
  await writeFile(join(directory, 'guide.md'), 'Read first.');
  await validatePack(directory, 'example');
  await assert.rejects(validatePack(directory, 'wrong'), /mismatch/);
  await writeFile(join(directory, 'pack.json'), JSON.stringify({ ...manifest, schedules: [] }));
  await assert.rejects(validatePack(directory, 'example'), /Invalid pack manifest/);
  for (const retired of [{ use: [] }, { capabilities: {} }]) {
    await writeFile(join(directory, 'pack.json'), JSON.stringify({ ...manifest, ...retired }));
    await assert.rejects(validatePack(directory, 'example'), /retired|Invalid pack manifest/);
  }
  await writeFile(join(directory, 'pack.json'), JSON.stringify(manifest));
  await symlink('guide.md', join(directory, 'link.md'));
  await assert.rejects(validatePack(directory, 'example'), /non-regular/);
  await rm(join(directory, 'link.md'));
  const escape = join(root, 'escape'); await mkdir(escape);
  await symlink('../packs', join(escape, 'packs'));
  await assert.rejects(materialize(entry, escape, join(root, 'work')), /regular directory/);
});

test('packaging is reproducible and preserves executable modes without running tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'example'); await mkdir(directory);
  await writeFile(join(directory, 'pack.json'), '{"id":"example"}');
  await writeFile(join(directory, 'never-run.sh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const a = join(root, 'a.tar.gz'), b = join(root, 'b.tar.gz');
  await archivePack(directory, a, 'example'); await archivePack(directory, b, 'example');
  assert.deepEqual(await readFile(a), await readFile(b));
});

test('the real catalog is standalone and every hosted pack validates', async t => {
  const root = join(import.meta.dirname, '..');
  const work = await mkdtemp(join(tmpdir(), 'forge-catalog-')); t.after(() => rm(work, { recursive: true, force: true }));
  const current = await readCatalog(root);
  assert.ok(current.packs.some(pack => pack.id === '2build' && pack.source.kind === 'github'));
  for (const pack of current.packs.filter(pack => pack.source.kind === 'bundled')) await materialize(pack, root, work);
});

test('an upstream tag must resolve to the pinned commit, peeled for annotated tags', () => {
  const ref = 'b'.repeat(40), tagObject = 'c'.repeat(40);
  assert.equal(tagCommit(`${tagObject}\trefs/tags/v1.2.3\n${ref}\trefs/tags/v1.2.3^{}\n`, '1.2.3'), ref);
  assert.equal(tagCommit(`${ref}\trefs/tags/v1.2.3\n`, '1.2.3'), ref);
  assert.equal(tagCommit(`${ref}\trefs/tags/v1.2.30\n${ref}\trefs/tags/1.2.3\n`, '1.2.3'), undefined);
  assert.equal(tagCommit('', '1.2.3'), undefined);
});

test('every external entry names the upstream release its pin belongs to', async () => {
  const current = await readCatalog(join(import.meta.dirname, '..'));
  const external = current.packs.filter(pack => pack.source.kind === 'github');
  assert.ok(external.length > 0);
  for (const pack of external) assert.match(pack.source.version, /^\d+\.\d+\.\d+$/);
});

test('pieces and programs name pack tools with the right mode, or the pack is refused', () => {
  const tool = (name, mode, stdin = 'context') => ({ name, description: name, run: { program: 'soot', args: [], mode, ...(stdin ? { stdin } : {}) } });
  const base = () => ({
    api_version: 'soot/v1', id: 'library', label: { vi: 'Kho tài liệu', en: 'Library' },
    tools: [tool('view', 'read'), tool('action', 'write'), tool('chromium_check', 'read', ''), tool('chromium_install', 'write', '')],
    interface: { pieces: [{ id: 'library', slot: 'data.tab', label: 'Kho tài liệu', icon: 'library', access: 'operator', data: { view_tool: 'view', action_tool: 'action' }, bundle: 'page/' }] },
    programs: [{ id: 'chromium', label: { vi: 'Trình duyệt Chromium' }, size_mb: 170, check_op: 'chromium_check', install_op: 'chromium_install' }],
  });
  checkPackModel(base(), 'library');
  const refusals = [
    [m => m.interface.pieces[0].data.view_tool = 'action', /view_not_read/],
    [m => m.interface.pieces[0].data.view_tool = 'missing', /tool_missing/],
    [m => delete m.tools[0].run.stdin, /stdin_not_context/],
    [m => delete m.tools[1].run.stdin, /stdin_not_context action/],
    [m => m.interface.pieces[0].data.action_tool = 'nope', /tool_missing action_tool/],
    [m => m.interface.pieces.push(structuredClone(m.interface.pieces[0])), /duplicate_id/],
    [m => m.interface.pieces[0].slot = 'toolbar', /unknown_slot/],
    [m => m.interface.pieces[0].slot = 'data', /unknown_slot/],
    [m => m.interface.pieces[0].slot = 'tool-area', /slot_not_allowed/],
    [m => m.interface.pieces[0].slot = 'project.tab', /tab_required/],
    [m => m.interface.pieces[0].tab = { id: 'marketing', label: 'Marketing' }, /tab_not_allowed/],
    [m => { m.interface.pieces[0].slot = 'project.tab'; m.interface.pieces[0].tab = { id: 'Marketing', label: 'Marketing' }; }, /tab id/],
    [m => { const [a] = m.interface.pieces; a.slot = 'project.tab'; a.tab = { id: 'marketing', label: { vi: 'Marketing' } }; m.interface.pieces.push({ ...structuredClone(a), id: 'queue', tab: { id: 'marketing', label: { vi: 'Tiếp thị' } } }); }, /tab_conflict/],
    [m => m.interface.pieces[0].group = 'server', /group_not_allowed/],
    [m => { m.interface.pieces[0].slot = 'settings'; m.interface.pieces[0].group = 'team'; }, /group_not_allowed/],
    [m => m.interface.pieces[0].order = 1000, /order/],
    [m => m.interface.pieces[0].provides = ['flow-marketing'], /flow-/],
    [m => m.interface.pieces = [], /1 to 8 pieces/],
    [m => { m.interface.pages = m.interface.pieces; delete m.interface.pieces; }, /interface.pages is retired/],
    [m => m.interface.pieces[0].access = 'public', /access/],
    [m => m.interface.pieces[0].id = 'Kho', /invalid id/],
    [m => m.interface.pieces[0].bundle = 'page', /bundle/],
    [m => m.interface.pieces[0].label = { en: 'Library' }, /label/],
    [m => m.label = 'x'.repeat(49), /label must be/],
    [m => m.description = { vi: '' }, /description must be/],
    [m => delete m.programs[0].install_op, /install_op undefined must be a write tool/],
    [m => m.programs[0].check_op = 'chromium_install', /check_op chromium_install must be a read tool/],
    [m => m.programs[0].size_mb = 1.5, /size_mb/],
    [m => m.programs.push(structuredClone(m.programs[0])), /duplicate id/],
    [m => m.interface.pieces[0].icon = 'Library Icon', /icon/],
    [m => m.keywords = { vi: ['x'.repeat(33)] }, /keywords.vi/],
    [m => m.keywords = { fr: ['livre'] }, /only vi and en/],
    [m => m.interface.tool_area = { id: 'b', kind: 'browser', view_tool: 'view', capabilities: { input: 'mouse' } }, /unsupported capabilities/],
    [m => m.interface.tool_area = { id: 'b', kind: 'browser', view_tool: 'view', stream: 'none', capabilities: { stream: 'websocket' } }, /disagree/],
  ];
  for (const [mutate, reason] of refusals) {
    const manifest = base(); mutate(manifest);
    assert.throws(() => checkPackModel(manifest, 'library'), reason, reason.source);
  }
});

test('channel.platforms declarations follow the host rules: id, mode, request_prefix and the setup ui', async () => {
  const shipped = JSON.parse(await readFile(join(import.meta.dirname, '..', 'packs', 'chat-channels', 'pack.json'), 'utf8'));
  checkPackModel(shipped, 'chat-channels');
  assert.deepEqual(shipped.channel.platforms.map(p => [p.id, p.mode, p.request_prefix]), [['telegram', 'supervised', 'tg'], ['discord', 'supervised', 'dc']], 'the prefixes the adapter and existing receipts use');
  for (const p of shipped.channel.platforms) {
    assert.ok(p.ui.guide.some(step => /https:\/\//.test(step)), `${p.id}: the guide links its bot console`);
    assert.deepEqual(p.ui.fields.map(f => [f.key, f.kind]), [['bot_token', 'secret']]);
    assert.ok(p.ui.errors.platform_token_rejected, `${p.id}: says where a new token comes from`);
  }
  const base = () => ({ api_version: 'soot/v1', id: 'zalo', channel: { platforms: [{ id: 'zalo', mode: 'supervised', ui: { label: 'Zalo', icon: 'message-circle', fields: [{ key: 'bot_token', label: 'Mã', kind: 'secret' }], errors: { zalo_refused: 'Zalo từ chối.' } } }] } });
  checkPackModel(base(), 'zalo');
  const refusals = [
    [m => m.channel.platforms[0].id = 'web', /invalid or duplicate id/],
    [m => m.channel.platforms.push(structuredClone(m.channel.platforms[0])), /invalid or duplicate id/],
    [m => m.channel.platforms[0].mode = 'polling', /mode must be/],
    [m => { m.channel.platforms[0].id = 'zalo-oa'; }, /request_prefix/],
    [m => m.channel.platforms[0].request_prefix = 'Z', /request_prefix/],
    [m => m.channel.platforms[0].ui.icon = 'Zalo Logo', /icon/],
    [m => delete m.channel.platforms[0].ui.label, /label/],
    [m => m.channel.platforms[0].ui.extra = 1, /holds only/],
    [m => m.channel.platforms[0].ui.fields[0].kind = 'password', /ui field bot_token/],
    [m => m.channel.platforms[0].ui.fields.push({ key: 'bot_token', label: 'x', kind: 'text' }), /ui field bot_token/],
    [m => m.channel.platforms[0].ui.guide = Array(13).fill('x'), /ui.guide/],
    [m => m.channel.platforms[0].ui.errors = { 'Bad-Code': 'x' }, /ui.errors/],
  ];
  for (const [mutate, reason] of refusals) {
    const manifest = base(); mutate(manifest);
    assert.throws(() => checkPackModel(manifest, 'zalo'), reason, reason.source);
  }
});

test('a piece bundle must hold index.html and stay within 5 MiB', async t => {
  const root = await mkdtemp(join(tmpdir(), 'piece-bundle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { interface: { pieces: [{ id: 'library', bundle: 'page/' }] } };
  await assert.rejects(checkPieceBundles(root, manifest), /bundle_missing/);
  await mkdir(join(root, 'page')); await writeFile(join(root, 'page', 'index.html'), '<!doctype html>');
  await checkPieceBundles(root, manifest);
  await writeFile(join(root, 'page', 'big.js'), Buffer.alloc(5 * 1024 * 1024));
  await assert.rejects(checkPieceBundles(root, manifest), /bundle_too_large/);
});

test('team-cs ships only generic skills and role Soots that hand off to members (P4.4, P4.5)', async () => {
  const dir = join(import.meta.dirname, '..', 'packs', 'team-cs');
  const read = async path => JSON.parse(await readFile(join(dir, path), 'utf8'));
  const manifest = await read('pack.json');
  assert.deepEqual(manifest.skills.map(s => s.name), ['cs-triage', 'handoff-policy', 'tone', 'person-memory']);
  assert.deepEqual(manifest.tools, [], 'team-cs owns no tools; product tools come from the product pack');
  const catalog = JSON.parse(await readFile(join(import.meta.dirname, '..', 'catalog.json'), 'utf8'));
  const products = catalog.packs.filter(p => p.id !== 'team-cs' && p.id !== 'live-chat').map(p => p.id);
  for (const name of ['cs-triage', 'cs-escalation']) {
    const soot = await read(`soots/${name}/soot.json`);
    assert.equal(soot.id, name);
    assert.deepEqual(soot.packs, ['live-chat', 'team-cs'], `${name} selects only the base and this pack`);
    assert.deepEqual(soot.interaction, { mode: 'interactive', handoff: 'members' });
    assert.ok(!soot.skills, `${name} declares no skill of its own`);
    assert.ok(!soot.packs.some(p => products.includes(p.split(':')[0])), `${name} imports no product pack`);
  }
  let cases = 0;
  for (const file of ['triage', 'direct-dm', 'memory']) cases += (await read(`evals/team-cs/${file}.eval.json`)).cases.length;
  assert.ok(cases >= 7, `P4.7 needs ≥ 7 eval cases, found ${cases}`);
});

for (const [pack, name] of [['data-pool-console', 'Kho tài liệu'], ['website-chat', 'Live chat settings']]) test(`the ${name} page bundle passes its own tests (bridge, bodies, no network, current app.js)`, async () => {
  const file = join(import.meta.dirname, '..', 'packs', pack, 'page', 'tests', 'page.test.mjs');
  const { NODE_TEST_CONTEXT, ...env } = process.env; // a nested run reports to stdout, not to this runner
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', file], { env });
  assert.match(stdout, /^# fail 0$/m);
});

test('every pack Nest lists carries its own localized label, description and keywords (D6.4)', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = join(import.meta.dirname, '..', 'packs');
  for (const id of await readdir(root)) {
    const manifest = JSON.parse(await readFile(join(root, id, 'pack.json'), 'utf8').catch(() => 'null'));
    if (!manifest) continue;
    for (const field of ['label', 'description']) assert.ok(manifest[field]?.vi && manifest[field]?.en, `${id}: ${field} in vi and en`);
    assert.ok(manifest.keywords?.vi?.length && manifest.keywords?.en?.length, `${id}: keywords in vi and en`);
  }
});

test('lohi-cs layers on team-cs with no skill conflict, keeps credit-bearing ops operator-approved and holds no price (AC-P4-7, X9)', async () => {
  const read = async path => JSON.parse(await readFile(join(import.meta.dirname, '..', 'packs', path), 'utf8'));
  const lohi = await read('lohi-cs/pack.json');
  checkPackModel(lohi, 'lohi-cs');
  const names = new Map();
  for (const id of ['live-chat', 'team-cs', 'lohi-cs']) for (const s of (await read(`${id}/pack.json`)).skills ?? []) {
    assert.ok(!names.has(s.name), `skill ${s.name} is in both ${names.get(s.name)} and ${id}`);
    names.set(s.name, id);
  }
  const run = name => lohi.tools.find(t => t.name === name).run;
  assert.equal(run('lohi_recover_topup').approval, 'operator', 'recover_topup credits LT');
  assert.equal(run('lohi_recover_topup').preflight, true, 'its dry run is the approval card');
  assert.equal(run('lohi_fix_chapter').approval, 'operator');
  for (const t of lohi.tools) for (const v of Object.values(t.run.secret_env ?? {})) assert.match(v, /^\{\{cred:LOHI_CS(_EXEC|_BASE)?\}\}$/, `${t.name}: credentials are named only`);
  const { readdir } = await import('node:fs/promises');
  const seed = join(import.meta.dirname, '..', 'packs', 'lohi-cs', 'knowledge', 'lohi-support');
  const pages = await readdir(seed);
  assert.ok(pages.length >= 3);
  for (const page of pages) assert.doesNotMatch(await readFile(join(seed, page), 'utf8'), /\d[\d.,]*\s*(đ|₫|vnđ|vnd|k\b|nghìn|LT\b)/i, `${page}: prices only come from lohi_lookup features`);
  const evals = JSON.parse(await readFile(join(seed, '..', '..', 'evals', 'lohi-cs', 'support.eval.json'), 'utf8'));
  const called = new Set(evals.cases.flatMap(c => c.turns.flatMap(t => t.expect.called ?? [])));
  // The subject view tool is run by the host for Nest and the run envelope, never chosen by the model.
  const subjectTool = lohi.interface?.subject?.view_tool;
  if (subjectTool) assert.equal(lohi.tools.find(t => t.name === subjectTool)?.run.mode, 'read', `${subjectTool}: the subject view tool is a read tool of this pack`);
  for (const t of lohi.tools) if (t.name !== subjectTool) assert.ok(called.has(`lohi-cs_${t.name}`), `an eval case calls ${t.name}`);
  assert.ok(evals.cases.some(c => c.tags.includes('price')), 'one price question from features');
});

test('the lohi-cs runner passes its own tests (principal header, anonymous refusal, no secret in argv)', async () => {
  const file = join(import.meta.dirname, '..', 'packs', 'lohi-cs', 'tests', 'tool.test.mjs');
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', file], { env });
  assert.match(stdout, /^# fail 0$/m);
});

test('a pack tab sorts after Nest\'s own tabs (goals 10, support 20) and before Kết quả (900), its pieces in their declared order', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = join(import.meta.dirname, '..', 'packs');
  for (const id of await readdir(dir)) {
    let pack; try { pack = JSON.parse(await readFile(join(dir, id, 'pack.json'), 'utf8')); } catch { continue; }
    const tabs = (pack.interface?.pieces ?? []).filter(p => p.slot === 'project.tab');
    for (const p of tabs) { const order = p.order ?? 500; assert.ok(order > 20 && order < 900, `${id}/${p.id}: order ${order} sorts its tab among Nest's own`); }
  }
  const marketing = JSON.parse(await readFile(join(dir, 'marketing', 'pack.json'), 'utf8')).interface.pieces.filter(p => p.slot === 'project.tab');
  assert.deepEqual([...marketing].sort((a, b) => a.order - b.order).map(p => p.id), ['posts', 'queue', 'campaigns']);
});
