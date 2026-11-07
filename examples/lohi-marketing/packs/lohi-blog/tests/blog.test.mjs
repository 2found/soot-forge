// The Lohi blog publisher against a local bare git remote: build and deploy are
// stubbed, git is real. The founder's checkout ($LOHI_REPO) is never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, unpublish, find, postFile, postURL, warnings, linkConnection } from '../tools/blog.mjs';
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
