import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConnection } from './setup.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'conn-'));
const put = (dir, name = 'connection.yaml') => { mkdirSync(join(dir, '.2server'), { recursive: true }); writeFileSync(join(dir, '.2server', name), 'x'); return join(dir, '.2server', name); };

test('findConnection: the checkout above the forge wins, then ~/.2server, else null', () => {
  const repo = tmp(), home = tmp(), empty = tmp();
  const file = put(repo);
  const deep = join(repo, '2agent', 'soot-forge'); mkdirSync(deep, { recursive: true });
  assert.equal(findConnection({ repo: undefined, start: deep, home }), file);
  assert.equal(findConnection({ repo, start: empty, home }), file, 'LOHI_REPO first');
  const homeFile = put(home, 'connection.json');
  assert.equal(findConnection({ repo: undefined, start: empty, home }), homeFile);
  assert.equal(findConnection({ repo: undefined, start: empty, home: tmp() }), null);
});

test('build: no default blog remote, --blog-remote writes only what it is given', async () => {
  const { build, HOST_ENV } = await import('./setup.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(HOST_ENV.LOHI_BLOG_REMOTE, undefined, 'the real blog repo is never a default');
  const none = build(tmp(), { env: true, video: false, connection: null, home: tmp() });
  assert.equal(none.hostEnv.LOHI_BLOG_REMOTE, undefined);
  assert.equal(JSON.parse(readFileSync(join(none.out, 'deployment.json'), 'utf8')).env.LOHI_BLOG_REMOTE, undefined);
  const set = build(tmp(), { env: true, video: false, connection: null, home: tmp(), blogRemote: '/tmp/scratch.git' });
  assert.equal(JSON.parse(readFileSync(join(set.out, 'deployment.json'), 'utf8')).env.LOHI_BLOG_REMOTE, '/tmp/scratch.git');
});

test('build: the Forge packs are copied exactly as the release archive ships them (so the runtime adopts them by digest)', async () => {
  const { build } = await import('./setup.mjs');
  const { packFiles } = await import('../../scripts/archive.mjs');
  const { join: j, resolve: r } = await import('node:path');
  const out = build(tmp(), { env: true, video: false, connection: null, home: tmp() }).out;
  for (const id of ['marketing', 'browser-use', 'company-loop']) {
    const want = (await packFiles(r(import.meta.dirname, '..', '..', 'packs', id))).sort();
    const got = (await packFiles(j(out, 'packs', id), { slim: false })).sort();
    assert.deepEqual(got, want, `${id}: installed files differ from the release archive's`);
  }
});

test('build: --product-repo has no default; the company loop gets the scoreboard address and the repo only when given', async () => {
  const { build, HOST_ENV } = await import('./setup.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(HOST_ENV.PRODUCT_REPO, undefined, 'the real checkout is never a default');
  assert.match(HOST_ENV.SCOREBOARD_URL, /^https:\/\/.+\/scoreboard$/);
  const none = build(tmp(), { env: true, video: false, connection: null, home: tmp() });
  const d0 = JSON.parse(readFileSync(join(none.out, 'deployment.json'), 'utf8'));
  assert.equal(d0.env.PRODUCT_REPO, undefined);
  assert.equal(d0.env.SCOREBOARD_URL, HOST_ENV.SCOREBOARD_URL);
  const set = build(tmp(), { env: true, video: false, connection: null, home: tmp(), productRepo: '/tmp/scratch-product' });
  assert.equal(JSON.parse(readFileSync(join(set.out, 'deployment.json'), 'utf8')).env.PRODUCT_REPO, '/tmp/scratch-product');
});

test('build: the Video Soot is added only when the workspace has the 2build pack (a missing pack would stop the whole workspace loading)', async () => {
  const { build } = await import('./setup.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const soots = out => JSON.parse(readFileSync(join(out, 'deployment.json'), 'utf8')).soots;
  const bare = build(tmp(), { env: true, connection: null, home: tmp() });
  assert.equal(bare.video, false);
  assert.ok(!soots(bare.out).some(f => f.includes('lohi-video')), 'no 2build pack: no Video Soot');
  assert.ok(!existsSync(join(bare.out, 'soots', 'video.md')));
  assert.throws(() => build(tmp(), { env: true, video: true, connection: null, home: tmp() }), /pack 2build/, '--video without the pack is refused');
  const dir = tmp();
  mkdirSync(join(dir, 'packs', '2build'), { recursive: true });
  writeFileSync(join(dir, 'packs', '2build', 'pack.json'), '{}');
  const withPack = build(dir, { env: true, connection: null, home: tmp() });
  assert.equal(withPack.video, true);
  assert.ok(soots(withPack.out).some(f => f.includes('lohi-video')));
  assert.equal(build(dir, { env: true, video: false, connection: null, home: tmp() }).video, false, '--no-video wins');
});

test('personSteps: the bbs:team step asks for --product-repo only when it was not given', async () => {
  const { personSteps } = await import('./setup.mjs');
  assert.match(personSteps().at(-1), /--product-repo/);
  assert.doesNotMatch(personSteps({ productRepo: '/tmp/p' }).at(-1), /--product-repo/);
});

test('recipe: every env a Forge pack asks for is granted (a missing name holds the pack update for a person)', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve: r } = await import('node:path');
  const host = JSON.parse(readFileSync(r(import.meta.dirname, 'deployment.example.json'), 'utf8'));
  for (const id of ['company-loop', 'marketing', 'browser-use']) {
    const pack = JSON.parse(readFileSync(r(import.meta.dirname, '..', '..', 'packs', id, 'pack.json'), 'utf8'));
    const granted = host.pack_grants?.[id]?.env ?? [];
    assert.deepEqual((pack.needs?.env ?? []).filter(e => !granted.includes(e)), [], `${id}: env not granted by the recipe`);
  }
});

test('build: the lean team (Ops, Writer, Analyst, Radar) is installed with its missions; LOOP_SOOT_CONFIG points at this workspace; --no-video keeps working', async () => {
  const { build } = await import('./setup.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const r = build(tmp(), { env: true, video: false, connection: null, home: tmp() });
  const host = JSON.parse(readFileSync(join(r.out, 'deployment.json'), 'utf8'));
  assert.deepEqual(host.soots.sort(), ['soots/lohi-analyst.json', 'soots/lohi-catalog.json', 'soots/lohi-editor.json', 'soots/lohi-finance.json', 'soots/lohi-radar.json', 'soots/lohi-writer.json']);
  for (const f of ['analyst.md', 'radar.md', 'editor.md', 'writer.md', 'SOUL.md', 'catalog.md']) assert.ok(existsSync(join(r.out, 'soots', f)), f);
  // The op-catalog Soot comes from the lohi-ops pack: its files leave the pack dir, its approvals reach the host.
  assert.ok(!existsSync(join(r.out, 'packs', 'lohi-ops', 'soots')));
  assert.equal(host.approvals['lohi-ops_appstore_post'], 'operator');
  assert.equal(host.approvals['lohi-ops_comments_resolve'], 'operator');
  assert.equal(host.env.LOOP_SOOT_CONFIG, join(r.out, 'deployment.json'));
  assert.equal(host.env.LOOP_SOOT_BIN, undefined, 'no machine path baked in: the CLI is found on PATH');
  assert.ok(existsSync(join(r.out, 'packs', 'lohi-ops', 'pack.json')), 'the recipe ships lohi-ops: it is installed');
  assert.ok(r.packs.includes('lohi-ops'));
  assert.ok(!host.tool_hosts['lohi-video']);
  assert.ok(host.schedules.every(s => host.soots.includes(`soots/${s.soot}.json`)), 'no schedule points at a left-out Soot');
});

test('installLocalPack: the lohi-ops slot copies the pack without tests and merges its fragment; a missing pack or a duplicate schedule changes nothing', async () => {
  const { installLocalPack } = await import('./setup.mjs');
  const { readFileSync, existsSync } = await import('node:fs');
  const out = tmp(); mkdirSync(join(out, 'packs'), { recursive: true });
  const host = { pack_grants: { marketing: { env: ['PATH'] } }, schedules: [{ id: 'marketing-gsc' }, { id: 'marketing-report' }] };
  assert.deepEqual(installLocalPack(out, 'lohi-ops', host, join(tmp(), 'nope')), { installed: false });
  assert.deepEqual(host.schedules.map(s => s.id), ['marketing-gsc', 'marketing-report']);
  const src = tmp();
  mkdirSync(join(src, 'tests'), { recursive: true });
  writeFileSync(join(src, 'pack.json'), '{}'); writeFileSync(join(src, 'tests', 'x.mjs'), '');
  writeFileSync(join(src, 'deployment.fragment.json'), JSON.stringify({ pack_grants: { 'lohi-ops': { env: ['PATH'] } }, soot_packs: { 'lohi-editor': ['lohi-ops'] }, replace_schedules: ['marketing-gsc'], schedules: [{ id: 'marketing-gsc', note: 'new' }, { id: 'marketing-report', note: 'dup' }, { id: 'ops-new' }] }));
  const r = installLocalPack(out, 'lohi-ops', host, src);
  assert.equal(r.installed, true);
  assert.ok(existsSync(join(out, 'packs', 'lohi-ops', 'pack.json')) && !existsSync(join(out, 'packs', 'lohi-ops', 'tests')));
  assert.ok(host.pack_grants['lohi-ops'] && host.pack_grants.marketing);
  assert.deepEqual(host.schedules.map(s => [s.id, s.note]), [['marketing-report', undefined], ['marketing-gsc', 'new'], ['ops-new', undefined]], 'replace_schedules swaps; an existing id never doubles');
  assert.deepEqual(r.soot_packs, { 'lohi-editor': ['lohi-ops'] });
});

test('recipe: no workspace env name starts with SOOT_ (the runtime reserves them and refuses the whole deployment)', async () => {
  const { build, HOST_ENV } = await import('./setup.mjs');
  const { readFileSync } = await import('node:fs');
  const r = build(tmp(), { env: true, video: false, connection: null, home: tmp() });
  const host = JSON.parse(readFileSync(join(r.out, 'deployment.json'), 'utf8'));
  for (const name of Object.keys(host.env)) if (name !== 'SOOT_BROWSER_PERSISTENT_SOOTS') assert.doesNotMatch(name, /^SOOT_/, name);
  for (const g of Object.values(host.pack_grants)) for (const name of g.env ?? []) if (name !== 'SOOT_BROWSER_PERSISTENT_SOOTS') assert.doesNotMatch(name, /^SOOT_/, name);
  assert.ok('LOOP_SOOT_CONFIG' in host.env && !('LOOP_SOOT_CONFIG' in HOST_ENV));
});
