// The Lohi blog publisher against a local bare git remote: build and deploy are
// stubbed, git is real. The founder's checkout ($LOHI_REPO) is never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, unpublish, find, postFile, postURL, warnings, linkConnection, catalog, ready, asChainStep } from '../tools/blog.mjs';
import { run as marketing } from '../../../../../packs/marketing/tools/marketing.mjs';
import { fakeStore } from '../../../../../packs/marketing/tests/fake-store.mjs';
import { signClaim, contentHash } from '../../../../../packs/marketing/tools/lib/claim.mjs';

const KEY = 'k'.repeat(32);
const BASE = 'https://blog.test';
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lohi-blog-test-'));
  const origin = join(dir, 'origin.git'), seed = join(dir, 'seed'), repo = join(dir, 'founder'), state = join(dir, 'state');
  g(dir, 'init', '--bare', '-q', origin);
  g(dir, 'clone', '-q', origin, seed);
  mkdirSync(join(seed, 'blog', 'posts', 'truyen-hay'), { recursive: true });
  mkdirSync(join(seed, 'blog', 'engine'), { recursive: true });
  writeFileSync(join(seed, 'blog', 'posts', 'truyen-hay', 'cu.vi.md'), '---\ndate: 2026-01-01\n---\n# Cũ\n\nbài cũ\n');
  writeFileSync(join(seed, 'blog', 'engine', 'main.go'), 'package main\n');
  g(seed, 'add', '.'); g(seed, 'commit', '-q', '-m', 'seed'); g(seed, 'push', '-q', 'origin', 'HEAD:main');
  g(dir, 'clone', '-q', origin, repo);
  // The founder has uncommitted work in progress; the tool must never see or touch it.
  writeFileSync(join(repo, 'blog', 'posts', 'truyen-hay', 'cu.vi.md'), 'founder edit, not committed\n');
  writeFileSync(join(repo, 'scratch.txt'), 'untracked\n');
  const env = { LOHI_REPO: repo, SOOT_PACK_STATE: state, LOHI_BLOG_URL: BASE, MARKETING_CLAIM_KEY: KEY, PATH: process.env.PATH, HOME: dir };
  return { dir, origin, seed, repo, state, env, log: () => g(seed, 'fetch', '-q', 'origin') || g(seed, 'log', 'origin/main', '--format=%s|%b', '--name-status') };
}

function stubs({ live = new Set(), buildWarnings = [], deployOk = true } = {}) {
  let t = Date.parse('2026-11-10T03:00:00Z');
  const calls = { build: 0, deploy: 0, files: [] };
  return {
    calls, live,
    build: async wt => { calls.build++; calls.files.push(readFileSync(join(wt, 'blog', 'posts', 'truyen-hay', 'tien-hiep-hay.vi.md'), 'utf8')); return { ok: true, warnings: buildWarnings }; },
    deploy: async wt => {
      calls.deploy++;
      if (!deployOk) return { ok: false, detail: 'ssh: connect refused' };
      for (const f of execFileSync('git', ['ls-files', 'blog/posts'], { cwd: wt, encoding: 'utf8' }).split('\n').filter(Boolean)) live.add(f);
      for (const f of [...live]) if (!existsSync(join(wt, f))) live.delete(f);
      return { ok: true };
    },
    fetch: async url => ({ status: [...live].some(f => url === `${BASE}/${f.split('/')[2]}/${f.split('/')[3].replace('.vi.md', '')}/vi/`) ? 200 : 404 }),
    sleep: async ms => { t += ms; },
    now: () => t,
  };
}

const claim = (over = {}) => {
  const c = { intent_id: 'I-00000000000000a1', post: 'P-0123456789', channel: 'blog-lohi', publisher: 'lohi-blog', action: 'publish', title: 'Truyện tiên hiệp hay', meta: 'Chín bộ đáng đọc.', slug: 'tien-hiep-hay', body: 'Thân bài.', link: '', series: 'truyen-hay', date: '2026-11-10', url: '', expires_at: '2026-11-10T03:10:00Z', ...over };
  return signClaim({ ...c, content_hash: contentHash(c) }, KEY);
};

test('publish: one post file in one commit with the intent trailer, fast-forward on main, deployed and live', async () => {
  const w = setup(), s = stubs();
  const before = readFileSync(join(w.repo, 'blog', 'posts', 'truyen-hay', 'cu.vi.md'), 'utf8');
  const out = await publish(claim(), w.env, s);
  assert.equal(out.status, 'published', JSON.stringify(out));
  assert.equal(out.url, `${BASE}/truyen-hay/tien-hiep-hay/vi/`);
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'rev-parse', 'origin/main'), out.platform_id);
  assert.equal(g(w.seed, 'show', '--format=', '--name-only', 'origin/main'), 'blog/posts/truyen-hay/tien-hiep-hay.vi.md', 'only the post file');
  assert.match(g(w.seed, 'log', '-1', '--format=%B', 'origin/main'), /Soot-Intent: I-00000000000000a1/);
  assert.equal(g(w.seed, 'rev-list', '--count', 'origin/main'), '2', 'fast-forward: seed + post');
  assert.equal(s.calls.files[0], postFile(claim()));
  assert.equal(s.calls.files[0], '---\ndate: 2026-11-10\n---\n# Truyện tiên hiệp hay\n*Chín bộ đáng đọc.*\n\nThân bài.\n');
  // The founder's tree is exactly as it was.
  assert.equal(readFileSync(join(w.repo, 'blog', 'posts', 'truyen-hay', 'cu.vi.md'), 'utf8'), before);
  assert.ok(existsSync(join(w.repo, 'scratch.txt')));
  assert.ok(!existsSync(join(w.repo, 'blog', 'posts', 'truyen-hay', 'tien-hiep-hay.vi.md')));
  assert.equal(g(w.repo, 'rev-list', '--count', 'HEAD'), '1', 'the founder\'s branch did not move');

  // The same intent again (a crash before record): found, no second commit, no rebuild.
  const again = await publish(claim(), w.env, s);
  assert.deepEqual(again, out);
  assert.equal(s.calls.build, 1);
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'rev-list', '--count', 'origin/main'), '2');
  assert.deepEqual(await find(claim(), w.env, s), { found: true, url: out.url, platform_id: out.platform_id });
  assert.deepEqual(await find(claim({ intent_id: 'I-00000000000000ff' }), w.env, s), { found: false });
  // A different intent for a slug already on main is refused, not overwritten.
  assert.deepEqual(await publish(claim({ intent_id: 'I-00000000000000b2' }), w.env, s), { status: 'failed', reason: 'slug_taken', retry: false });
});

test('a build warning commits nothing and leaves the worktree clean', async () => {
  const w = setup(), s = stubs({ buildWarnings: ['lint truyen-hay/tien-hiep-hay: meta is 12 chars'] });
  const out = await publish(claim(), w.env, s);
  assert.deepEqual([out.status, out.retry], ['failed', false]);
  assert.match(out.reason, /^build_failed: lint/);
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'rev-list', '--count', 'origin/main'), '1');
  assert.equal(s.calls.deploy, 0);
  assert.equal(g(join(w.state, 'blog-worktree'), 'status', '--porcelain'), '');
  assert.deepEqual(warnings('go: downloading github.com/x v1\n\n'), []);
  assert.deepEqual(warnings('go: downloading a\nwarning: series truyen-hay has no index\n'), ['warning: series truyen-hay has no index']);
});

test('a failed deploy is followed by a revert push: main\'s tree matches what is live', async () => {
  const w = setup(), s = stubs({ deployOk: false });
  g(w.seed, 'fetch', '-q', 'origin');
  const tree = g(w.seed, 'rev-parse', 'origin/main^{tree}');
  const out = await publish(claim(), w.env, s);
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /^deploy_failed: ssh: connect refused/);
  assert.equal(out.retry, true);
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'rev-parse', 'origin/main^{tree}'), tree);
  assert.match(g(w.seed, 'log', '-1', '--format=%s', 'origin/main'), /^Revert "blog: publish tien-hiep-hay"/);
  assert.equal(g(w.seed, 'rev-list', '--count', 'origin/main'), '3', 'post + revert, nothing rewritten');
});

test('a deploy that succeeds but never serves the URL also reverts after 5 minutes of polling', async () => {
  const w = setup(), s = stubs();
  s.fetch = async () => ({ status: 404 });
  const out = await publish(claim(), w.env, s);
  assert.equal(out.reason, 'deploy_failed: URL not live after 5 minutes');
  assert.ok(s.now() - Date.parse('2026-11-10T03:00:00Z') >= 5 * 60_000);
});

test('a push that loses a race rebases once onto the new main', async () => {
  const w = setup(), s = stubs();
  const build = s.build;
  s.build = async wt => { // someone pushes between our fetch and our push
    writeFileSync(join(w.seed, 'other.md'), 'x'); g(w.seed, 'add', '.'); g(w.seed, 'commit', '-q', '-m', 'founder'); g(w.seed, 'push', '-q', 'origin', 'HEAD:main');
    return build(wt);
  };
  const out = await publish(claim(), w.env, s);
  assert.equal(out.status, 'published', JSON.stringify(out));
  g(w.seed, 'fetch', '-q', 'origin');
  assert.deepEqual(g(w.seed, 'log', '--format=%s', 'origin/main').split('\n'), ['blog: publish tien-hiep-hay', 'founder', 'seed']);
});

test('unpublish removes the file in one commit, deploys and waits for 404; a second unpublish is a no-op', async () => {
  const w = setup(), s = stubs();
  const pub = await publish(claim(), w.env, s);
  const down = claim({ intent_id: 'I-00000000000000c3', action: 'unpublish', url: pub.url });
  assert.deepEqual(await unpublish(down, w.env, s), { status: 'removed' });
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'show', '--format=%s', '--name-status', 'origin/main'), 'blog: unpublish tien-hiep-hay\n\nD\tblog/posts/truyen-hay/tien-hiep-hay.vi.md');
  assert.equal((await s.fetch(pub.url)).status, 404);
  const deploys = s.calls.deploy;
  assert.deepEqual(await unpublish(down, w.env, s), { status: 'removed' });
  assert.equal(s.calls.deploy, deploys, 'already gone: nothing to deploy');
});

test('a forged, expired, mis-hashed, wrong-action or wrong-publisher claim is refused before any git', async () => {
  const w = setup(), s = stubs();
  s.run = () => { throw new Error('git must not run'); };
  const good = claim();
  const cases = [
    [{ ...good, body: 'đổi' }, 'claim_forged'],
    [claim({ expires_at: '2026-11-10T02:59:00Z' }), 'claim_expired'],
    [signClaim({ ...good, sig: undefined, body: 'đổi' }, KEY), 'claim_hash_mismatch'],
    [claim({ action: 'unpublish' }), 'claim_wrong_action'],
    [claim({ publisher: 'browser' }), 'claim_wrong_publisher'],
    [claim({ slug: '../../etc' }), 'claim_invalid'],
    [undefined, 'claim_unsigned'],
  ];
  for (const [c, reason] of cases) assert.deepEqual(await publish(c, w.env, s), { status: 'failed', reason, retry: false }, reason);
  assert.deepEqual(await publish(good, { ...w.env, MARKETING_CLAIM_KEY: '' }, s), { status: 'failed', reason: 'claim_key_missing', retry: false });
  assert.deepEqual(await find({ ...good, body: 'x' }, w.env, s), { found: false, refused: 'claim_forged' });
});

test('the URL is the generator\'s vi-only path', () => {
  assert.equal(postURL({ series: 'truyen-hay', slug: 'a-b' }), 'https://blog.lohi2.com/truyen-hay/a-b/vi/');
  assert.equal(postURL({ slug: 'a-b' }, 'http://127.0.0.1:9/'), 'http://127.0.0.1:9/truyen-hay/a-b/vi/');
});

test('deploy finds the founder checkout\'s 2server connection from the tool\'s own worktree (only that file, ignored)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lohi-conn-'));
  const repo = join(root, 'kiem-lai'), wt = join(root, 'state', 'blog-worktree');
  mkdirSync(join(repo, '.2server', 'work'), { recursive: true });
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(repo, '.2server', 'connection.yaml'), 'ssh: x\n');
  writeFileSync(join(repo, '.2server', 'connection.json'), '{}');
  assert.equal(await linkConnection(repo, wt), join(repo, '.2server', 'connection.yaml'));
  assert.ok(lstatSync(join(wt, '.2server', 'connection.yaml')).isSymbolicLink());
  assert.equal(readlinkSync(join(wt, '.2server', 'connection.yaml')), join(repo, '.2server', 'connection.yaml'));
  assert.equal(existsSync(join(wt, '.2server', 'work')), false, 'the rest of the operator directory stays out');
  assert.equal(readFileSync(join(wt, '.2server', '.gitignore'), 'utf8'), '*\n');
  assert.equal(await linkConnection(repo, wt), join(repo, '.2server', 'connection.yaml'), 'a second deploy relinks');
  const bare = mkdtempSync(join(tmpdir(), 'lohi-noconn-'));
  assert.equal(await linkConnection(join(bare, 'repo'), join(bare, 'wt')), null, 'no connection: deploy.sh says so itself');
  assert.equal(await linkConnection(undefined, wt), null);
});

test('no LOHI_REPO: the publisher clones the configured remote into its own state and publishes from it', async () => {
  const w = setup(), s = stubs();
  const env = { ...w.env, LOHI_REPO: undefined, LOHI_BLOG_REMOTE: w.origin };
  delete env.LOHI_REPO;
  const out = await publish(claim(), env, s);
  assert.equal(out.status, 'published', JSON.stringify(out));
  assert.ok(existsSync(join(w.state, 'blog-repo', '.git')), 'cloned under the pack state');
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'rev-parse', 'origin/main'), out.platform_id);
  // A second call reuses the clone.
  assert.deepEqual(await publish(claim(), env, stubs({ live: s.live })), out);
});

test('no LOHI_REPO and an unreachable remote: a failed call that names the remote, nothing half-cloned', async () => {
  const w = setup();
  const env = { ...w.env, LOHI_BLOG_REMOTE: join(w.dir, 'nope.git') };
  delete env.LOHI_REPO;
  await assert.rejects(publish(claim(), env, stubs()), /cannot clone/);
  assert.ok(!existsSync(join(w.state, 'blog-repo')));
});

test('deploy finds the operator connection in ~/.2server when the machine has no checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lohi-home-'));
  mkdirSync(join(root, '.2server'), { recursive: true });
  writeFileSync(join(root, '.2server', 'connection.yaml'), 'ssh: x\n');
  const wt = join(root, 'state', 'wt');
  mkdirSync(wt, { recursive: true });
  assert.equal(await linkConnection(undefined, wt, { HOME: root }), join(root, '.2server', 'connection.yaml'));
  assert.ok(lstatSync(join(wt, '.2server', 'connection.yaml')).isSymbolicLink());
});

const FEED = [
  { slug: 'tru-tien', titleVi: 'Tru Tiên', authorNameVi: 'Tiêu Đỉnh', genres: ['Tiên Hiệp'], totalChapters: 200, completionStatus: 'completed', synopsis: 'Một câu chuyện '.repeat(30), access: 'open' },
  { slug: 'khoa', titleVi: 'Bị khoá', genres: [], totalChapters: 9, access: 'locked' },
  { slug: 'dang-ra', titleVi: 'Đang ra', genres: ['Ngôn Tình'], totalChapters: 12, completionStatus: 'ongoing', access: 'open' },
];
test('catalog: real novels with their lohi2.com link, completed-only, search and genres, public endpoints only', async () => {
  const seen = [];
  const fetch = async url => { seen.push(url); const u = new URL(url); return { ok: true, status: 200, json: async () => u.pathname.endsWith('/genres') ? ['Tiên Hiệp'] : u.pathname.endsWith('/search') ? { matches: [{ slug: 'vo-tien', titleVi: 'Vô Tiên', authorVi: 'Duệ Quang', genres: ['Tiên Hiệp'], hasChapters: true }, { slug: 'rong', titleVi: 'Rỗng', hasChapters: false }] } : FEED }; };
  const list = await catalog({ completed: true }, {}, { fetch });
  assert.deepEqual(list.novels.map(n => [n.slug, n.url]), [['tru-tien', 'https://lohi2.com/truyen/tru-tien']]);
  assert.ok(list.novels[0].summary.length <= 150 && list.novels[0].chapters === 200);
  assert.deepEqual((await catalog({ query: 'tiên' }, {}, { fetch })).novels.map(n => n.slug), ['vo-tien']);
  assert.deepEqual((await catalog({ genres: true }, {}, { fetch })).genres, ['Tiên Hiệp']);
  assert.ok(seen.every(u => u.startsWith('https://api.lohi2.com/novel/discovery/') || u.startsWith('https://api.lohi2.com/novel/novels/search')), seen.join(' '));
  await assert.rejects(catalog({}, {}, { fetch: async () => ({ ok: false, status: 403 }) }), /403/);
});

test('ready: every missing prerequisite in one Cần bạn item, raised once and quiet while unchanged', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lohi-ready-'));
  let present = new Set(['git']);
  const run = async (cmd, args) => {
    if (cmd === 'sh') return { ok: present.has(args[1].split(' ').pop()), code: 0, stdout: '', stderr: '' };
    if (cmd === 'git') return { ok: false, code: 128, stdout: '', stderr: 'Permission denied (publickey).' };
    return { ok: false, code: 1, stdout: '', stderr: '' };
  };
  const env = { SOOT_PACK_STATE: state, HOME: state, PATH: '', LOHI_BLOG_REMOTE: 'git@example.invalid:x/blog.git' };
  const first = await ready(env, { run });
  assert.equal(first.ok, false);
  assert.deepEqual(first.missing.map(m => m.key).sort(), ['2server', 'connection', 'gcloud', 'git_remote', 'go']);
  assert.equal(first.notify, true);
  assert.equal(first.ask.options[0].label, 'Đã xong, kiểm tra lại');
  assert.match(first.ask.missing, /ssh-add/);
  const second = await ready(env, { run });
  assert.deepEqual([second.ok, second.notify, second.wake], [false, false, false], 'an unchanged list never wakes again');
  present = new Set(['git', 'go', '2server', 'gcloud']);
  mkdirSync(join(state, '.2server'), { recursive: true });
  writeFileSync(join(state, '.2server', 'connection.yaml'), 'x');
  const gc = async (cmd, args) => (cmd === 'gcloud' ? { ok: true, code: 0, stdout: 'a@b.c\n', stderr: '' } : cmd === 'git' ? { ok: true, code: 0, stdout: '', stderr: '' } : run(cmd, args));
  const done = await ready(env, { run: gc });
  assert.deepEqual([done.ok, done.notify, done.missing.length], [true, false, 0]);
  assert.equal(done.ask, undefined);
});

test('chain step: a published post is ok:true and a failed or uncertain one ok:false, each carrying the intent id', () => {
  const claim = { intent_id: 'int_1' };
  assert.deepEqual(asChainStep({ status: 'published', url: 'u' }, claim), { status: 'published', url: 'u', ok: true, intent_id: 'int_1' });
  for (const status of ['failed', 'uncertain']) assert.equal(asChainStep({ status }, claim).ok, false);
  assert.equal(asChainStep({ status: 'failed' }, null).intent_id, undefined);
});

test('ready: resolves_need is not claimed while something is missing', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lohi-ready2-'));
  const run = async () => ({ ok: false, code: 1, stdout: '', stderr: '' });
  const out = await ready({ SOOT_PACK_STATE: state, HOME: state, PATH: '' }, { run });
  assert.notEqual(out.resolves_need, true);
});

test('no remote and no LOHI_REPO: nothing is cloned or pushed, and blog-ready raises one card', async () => {
  const w = setup();
  const env = { ...w.env };
  delete env.LOHI_REPO; delete env.LOHI_BLOG_REMOTE;
  await assert.rejects(publish(claim(), env, stubs()), /No blog repository is configured/);
  assert.ok(!existsSync(join(w.state, 'blog-repo')));
});

test('ready: no blog remote is one named card, never a probe of a default repository', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lohi-ready-'));
  const calls = [];
  const run = async (cmd, args) => { calls.push([cmd, ...args]); return cmd === 'sh' ? { ok: true, code: 0, stdout: '', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: '' }; };
  const out = await ready({ SOOT_PACK_STATE: state, HOME: state, PATH: '' }, { run });
  assert.ok(out.missing.some(m => m.key === 'blog_remote' && /kho đăng blog/.test(m.title)));
  assert.ok(!calls.some(c => c[0] === 'git' && c.includes('ls-remote')), 'no ls-remote of an invented remote');
});

// The live chain: marketing.due → claim → lohi-blog.publish → marketing.record. Each step reads the previous
// answer as its input (JSON round trip, then the host's parameter check: record is additionalProperties:false).
test('chain: claim → publish → record publishes the post with its URL; unpublish → record removes it', async () => {
  const T0 = Date.parse('2026-11-10T03:00:00Z');
  const store = fakeStore({ clock: () => T0 });
  const menv = { MARKETING_CLAIM_KEY: KEY };
  const call = (name, input, extra = {}) => marketing(name, { input, ...extra }, { store, now: T0, env: menv, fetchImpl: async () => { throw new Error('no network'); } });
  const params = name => JSON.parse(readFileSync(new URL('../../../../../packs/marketing/pack.json', import.meta.url), 'utf8')).tools.find(t => t.name === name).parameters;
  const step = (name, previous) => {
    const input = JSON.parse(JSON.stringify(previous));
    const p = params(name);
    if (p.additionalProperties === false) for (const k of Object.keys(input)) assert.ok(k in p.properties, `${name} does not take ${k}`);
    for (const k of p.required ?? []) assert.ok(k in input, `${name} needs ${k}`);
    return input;
  };
  await call('channels_setup', { channels: [{ id: 'blog-lohi', account: 'blog' }], quiet_hours: { from: '03:00', to: '04:00', tz: 'Asia/Ho_Chi_Minh' } });
  const meta = 'Danh sách chín bộ tiên hiệp đáng đọc nhất năm nay, mỗi bộ có một lý do riêng để bạn chọn đọc tiếp ngay hôm nay, xem ngay nhé bạn ơi.';
  const d = await call('draft_save', { request_id: 'chain-1', kind: 'article', channel: 'blog-lohi', body: 'Nếu bạn mê tiên hiệp, đây là chín bộ đáng đọc. Xem thêm [kho truyện](https://lohi2.com/novel/tien-hiep) và [thể loại](https://lohi2.com/novel/ngon-tinh).', brief: { title: 'Chín bộ tiên hiệp đáng đọc nhất năm nay', keyword: 'tiên hiệp', slug: 'tien-hiep-hay', meta, internal_links: ['https://lohi2.com/novel/tien-hiep', 'https://lohi2.com/novel/ngon-tinh'] } });
  assert.deepEqual(d.lint, []);
  await call('check', { id: d.id, revision: d.revision, verdict: 'pass', reasons: [] });
  await call('schedule', { id: d.id, scheduled_at: new Date(T0 - 60_000).toISOString() });

  const w = setup(), s = stubs();
  const due = await call('due', { schedule: true, channel: 'blog-lohi' });
  assert.deepEqual([due.id, due.action], [d.id, 'publish']);
  const claimed = await call('claim', step('claim', due));
  const out = JSON.parse(JSON.stringify(asChainStep(await publish(claimed.claim, w.env, s), claimed.claim)));
  assert.equal(out.status, 'published', JSON.stringify(out));
  const recorded = await call('record', step('record', out));
  assert.equal(recorded.state, 'published');
  assert.deepEqual(recorded.outcome, { id: 'post_published', ref: `${BASE}/truyen-hay/tien-hiep-hay/vi/` });
  const post = store.data.posts.find(p => p.ref === d.id);
  assert.deepEqual([post.state, post.url], ['published', `${BASE}/truyen-hay/tien-hiep-hay/vi/`]);
  assert.equal(store.data.publish_log.find(r => r.intent_id === out.intent_id).status, 'published');
  assert.equal(store.data.queue.length, 0);

  // Gỡ bài: the same chain shape ends in `removed`, and main gains exactly one more commit.
  await marketing('page_action', { input: { op: 'unpublish', id: d.id, request_id: 'r-unpub-0001' }, page: { soot: 'lohi-editor', page: 'hang-doi' } }, { store, now: T0, env: menv, fetchImpl: async () => { throw new Error('no network'); } });
  const claim2 = await call('claim', { action: 'unpublish', id: d.id });
  const out2 = JSON.parse(JSON.stringify(asChainStep(await unpublish(claim2.claim, w.env, s), claim2.claim)));
  assert.equal(out2.ok, true, JSON.stringify(out2));
  assert.equal((await call('record', step('record', out2))).state, 'removed');
  assert.equal(store.data.posts.find(p => p.ref === d.id).state, 'removed');
  g(w.seed, 'fetch', '-q', 'origin');
  assert.equal(g(w.seed, 'rev-list', '--count', 'origin/main'), '3', 'seed + publish + unpublish');
});
