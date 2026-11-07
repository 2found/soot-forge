// Lohi blog publisher (design §4.2): `node tools/blog.mjs publish|unpublish|find`
// reads {claim} from the ToolContext and answers the publisher contract.
//
// It never touches the founder's working tree: it keeps its own clean
// worktree of $LOHI_REPO at $SOOT_PACK_STATE/blog-worktree, reset to
// origin/main for every call. Publish writes one post file, builds the blog
// with zero warnings, commits only that file (trailer `Soot-Intent: <id>`),
// pushes fast-forward only, runs the worktree's own deploy.sh and polls the
// URL. A deploy that fails is followed by a revert push, so main matches live.
import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE = 'https://blog.lohi2.com';
const SLUG = /^[a-z0-9-]{3,80}$/, SERIES = /^[a-z0-9-]{1,64}$/, INTENT = /^I-[0-9a-f]{16}$/;
const AUTHOR = ['-c', 'user.name=Soot Marketing', '-c', 'user.email=marketing@soot.invalid'];

// ---------- claim verification (a copy of the marketing pack's; tests pin both to one vector) ----------

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export function contentHash({ title = '', meta = '', slug = '', body = '', link = '' } = {}) {
  return 'sha256:' + createHash('sha256').update(canonical({ title, meta, slug, body, link })).digest('hex');
}
export function verifyClaim(claim, key, now = Date.now()) {
  if (!key) return 'claim_key_missing';
  if (!claim || typeof claim !== 'object' || typeof claim.sig !== 'string') return 'claim_unsigned';
  const { sig, ...rest } = claim;
  const want = createHmac('sha256', key).update(canonical(rest)).digest();
  const got = Buffer.from(sig, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'claim_forged';
  const exp = Date.parse(claim.expires_at ?? '');
  if (!Number.isFinite(exp) || exp <= now) return 'claim_expired';
  if (claim.content_hash !== contentHash(claim)) return 'claim_hash_mismatch';
  return null;
}

// ---------- process helpers ----------

export function sh(cmd, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

/** Generator stderr minus Go's own download notes; any line left is a warning. */
export const warnings = stderr => String(stderr).split('\n').map(l => l.trim()).filter(l => l && !/^go: (downloading|finding|extracting|upgraded)\b/.test(l));

function defaults(env) {
  const run = (cmd, args, opts = {}) => sh(cmd, args, { env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}), ...(opts.env ?? {}) }, cwd: opts.cwd, timeout: opts.timeout });
  return {
    run,
    async build(wt) {
      const out = await mkdtemp(join(tmpdir(), 'lohi-blog-build-'));
      try {
        const r = await run('go', ['run', '.', '-posts', '../posts', '-out', out], { cwd: join(wt, 'blog', 'engine'), timeout: 10 * 60_000, env: { GOFLAGS: '-mod=mod' } });
        return { ok: r.ok, warnings: warnings(r.stderr) };
      } finally { await rm(out, { recursive: true, force: true }); }
    },
    async deploy(wt) {
      await linkConnection(env.LOHI_REPO, wt);
      const r = await run('bash', [join(wt, 'blog', 'infra', 'gce', 'deploy.sh'), '--env', 'prod'], { cwd: join(wt, 'blog'), timeout: 15 * 60_000 });
      return { ok: r.ok, detail: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300) };
    },
    fetch: globalThis.fetch,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

// ---------- worktree ----------

/**
 * 2server finds its VM connection as the nearest .2server/connection.yaml
 * (or .json) above the working directory. The tool's worktree lives under the
 * pack state, outside the founder's checkout, so deploy.sh would find none:
 * link the checkout's connection file (only that file, never the rest of the
 * operator directory) into the worktree's own ignored .2server.
 */
export async function linkConnection(repo, wt) {
  if (!repo) return null;
  for (let dir = resolve(repo); ; dir = dirname(dir)) {
    for (const name of ['connection.yaml', 'connection.json']) {
      const file = join(dir, '.2server', name);
      if (!existsSync(file)) continue;
      const own = join(wt, '.2server');
      await rm(own, { recursive: true, force: true });
      await mkdir(own, { recursive: true, mode: 0o700 });
      await writeFile(join(own, '.gitignore'), '*\n', { mode: 0o600 });
      await symlink(file, join(own, name));
      return file;
    }
    if (dirname(dir) === dir) return null;
  }
}


async function git(d, cwd, ...args) {
  const r = await d.run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd });
  return r;
}
async function must(d, cwd, ...args) {
  const r = await git(d, cwd, ...args);
  if (!r.ok) throw Object.assign(new Error(`git ${args[0]}: ${r.stderr.trim().split('\n').pop()}`), { code: 'git_failed' });
  return r.stdout.trim();
}

/** The tool's own clean worktree at origin/main, created on first use. */
export async function worktree(d, repo, state) {
  if (!repo || !existsSync(join(repo, '.git'))) throw Object.assign(new Error('LOHI_REPO is not a git checkout.'), { code: 'repo_missing' });
  if (!state) throw Object.assign(new Error('The host gave this call no pack state directory.'), { code: 'state_missing' });
  const wt = join(state, 'blog-worktree');
  await must(d, repo, 'fetch', '--quiet', 'origin', 'main');
  if (!existsSync(join(wt, '.git'))) {
    await mkdir(state, { recursive: true });
    await git(d, repo, 'worktree', 'prune');
    await must(d, repo, 'worktree', 'add', '--detach', '--force', wt, 'origin/main');
  }
  await must(d, wt, 'checkout', '--quiet', '--detach', '--force', 'origin/main');
  await must(d, wt, 'reset', '--quiet', '--hard', 'origin/main');
  await must(d, wt, 'clean', '-fdq');
  return wt;
}

const postPath = c => join('blog', 'posts', c.series || 'truyen-hay', `${c.slug}.vi.md`);
export const postURL = (c, base = DEFAULT_BASE) => `${base.replace(/\/+$/, '')}/${c.series || 'truyen-hay'}/${c.slug}/vi/`;

/** The markdown the generator reads: flat front matter date, H1 title, italic meta line, body. */
export function postFile(c) {
  const meta = String(c.meta ?? '').replace(/\s+/g, ' ').trim();
  return `---\ndate: ${c.date}\n---\n# ${String(c.title).trim()}\n${meta ? `*${meta}*\n` : ''}\n${String(c.body).trim()}\n`;
}

async function intentCommit(d, wt, id) {
  return must(d, wt, 'log', 'origin/main', '--fixed-strings', `--grep=Soot-Intent: ${id}`, '--format=%H', '-n', '1');
}
const onMain = async (d, wt, file) => (await git(d, wt, 'cat-file', '-e', `origin/main:${file}`)).ok;

async function status(d, url) {
  try { return (await d.fetch(url, { method: 'GET', redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } })).status; } catch { return 0; }
}
async function poll(d, url, live) {
  const end = d.now() + 5 * 60_000;
  for (;;) {
    const s = await status(d, url);
    if (live ? s === 200 : s === 404 || s === 410) return true;
    if (d.now() >= end) return false;
    await d.sleep(10_000);
  }
}

/** Push fast-forward only; on a rejection, one fetch-rebase-retry. */
async function push(d, wt) {
  if ((await git(d, wt, 'push', '--quiet', 'origin', 'HEAD:main')).ok) return true;
  await must(d, wt, 'fetch', '--quiet', 'origin', 'main');
  if (!(await git(d, wt, 'rebase', '--quiet', 'origin/main')).ok) { await git(d, wt, 'rebase', '--abort'); return false; }
  return (await git(d, wt, 'push', '--quiet', 'origin', 'HEAD:main')).ok;
}

async function revertPush(d, wt, sha) {
  await must(d, wt, 'fetch', '--quiet', 'origin', 'main');
  await must(d, wt, 'checkout', '--quiet', '--detach', '--force', 'origin/main');
  if (!(await git(d, wt, ...AUTHOR, 'revert', '--no-edit', sha)).ok) return false;
  return push(d, wt);
}

const failed = (reason, retry) => ({ status: 'failed', reason, retry });

function checkClaim(claim, action, env, now) {
  const bad = verifyClaim(claim, env.MARKETING_CLAIM_KEY, now);
  if (bad) return failed(bad, false);
  if (claim.action !== action) return failed('claim_wrong_action', false);
  if (claim.publisher !== 'lohi-blog') return failed('claim_wrong_publisher', false);
  if (!INTENT.test(claim.intent_id ?? '') || !SLUG.test(claim.slug ?? '') || (claim.series && !SERIES.test(claim.series))) return failed('claim_invalid', false);
  if (action === 'publish' && (!claim.title || !claim.body || !/^\d{4}-\d{2}-\d{2}$/.test(claim.date ?? ''))) return failed('claim_invalid', false);
  return null;
}

// ---------- publisher contract ----------

export async function publish(claim, env, deps = {}) {
  const d = { ...defaults(env), ...deps };
  const refused = checkClaim(claim, 'publish', env, d.now());
  if (refused) return refused;
  const url = postURL(claim, env.LOHI_BLOG_URL || DEFAULT_BASE), file = postPath(claim);
  const wt = await worktree(d, env.LOHI_REPO, env.SOOT_PACK_STATE);

  // Crash recovery: an earlier attempt of this intent may already be on main.
  let sha = await intentCommit(d, wt, claim.intent_id);
  if (sha && await onMain(d, wt, file)) {
    if (await status(d, url) === 200) return { status: 'published', url, platform_id: sha };
  } else {
    if (await onMain(d, wt, file)) return failed('slug_taken', false);
    await mkdir(join(wt, 'blog', 'posts', claim.series || 'truyen-hay'), { recursive: true });
    await writeFile(join(wt, file), postFile(claim));
    const built = await d.build(wt);
    if (!built.ok || built.warnings.length) {
      await must(d, wt, 'clean', '-fdq');
      return failed(`build_failed: ${(built.warnings[0] ?? 'the blog did not build').slice(0, 200)}`, false);
    }
    await must(d, wt, 'add', '--', file);
    await must(d, wt, ...AUTHOR, 'commit', '--quiet', '--only', '-m', `blog: publish ${claim.slug}`, '-m', `Soot-Intent: ${claim.intent_id}`, '--', file);
    if (!(await push(d, wt))) return failed('push_rejected', true);
    sha = await must(d, wt, 'rev-parse', 'HEAD');
  }
  const deployed = await d.deploy(wt);
  if (!deployed.ok || !(await poll(d, url, true))) {
    const reverted = await revertPush(d, wt, sha);
    return failed(reverted ? `deploy_failed${deployed.ok ? ': URL not live after 5 minutes' : deployed.detail ? `: ${deployed.detail}` : ''}` : 'deploy_failed_revert_failed', reverted);
  }
  return { status: 'published', url, platform_id: sha };
}

export async function unpublish(claim, env, deps = {}) {
  const d = { ...defaults(env), ...deps };
  const refused = checkClaim(claim, 'unpublish', env, d.now());
  if (refused) return refused;
  const url = postURL(claim, env.LOHI_BLOG_URL || DEFAULT_BASE), file = postPath(claim);
  const wt = await worktree(d, env.LOHI_REPO, env.SOOT_PACK_STATE);
  let sha = null;
  if (await onMain(d, wt, file)) {
    await must(d, wt, 'rm', '--quiet', '--', file);
    await must(d, wt, ...AUTHOR, 'commit', '--quiet', '-m', `blog: unpublish ${claim.slug}`, '-m', `Soot-Intent: ${claim.intent_id}`);
    if (!(await push(d, wt))) return failed('push_rejected', true);
    sha = await must(d, wt, 'rev-parse', 'HEAD');
  } else if (await status(d, url) !== 200) {
    return { status: 'removed' };
  }
  const deployed = await d.deploy(wt);
  if (!deployed.ok || !(await poll(d, url, false))) {
    const reverted = sha ? await revertPush(d, wt, sha) : true;
    return failed(reverted ? 'deploy_failed' : 'deploy_failed_revert_failed', reverted);
  }
  return { status: 'removed' };
}

export async function find(claim, env, deps = {}) {
  const d = { ...defaults(env), ...deps };
  const bad = verifyClaim(claim, env.MARKETING_CLAIM_KEY, d.now());
  if (bad || claim.publisher !== 'lohi-blog' || !SLUG.test(claim.slug ?? '')) return { found: false, refused: bad ?? 'claim_invalid' };
  const url = postURL(claim, env.LOHI_BLOG_URL || DEFAULT_BASE);
  const wt = await worktree(d, env.LOHI_REPO, env.SOOT_PACK_STATE);
  const sha = await intentCommit(d, wt, claim.intent_id);
  const live = sha && await onMain(d, wt, postPath(claim)) && await status(d, url) === 200;
  return live ? { found: true, url, platform_id: sha } : { found: false };
}

// ---------- entry ----------

export async function main(mode, env = process.env) {
  let out;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const ctx = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const claim = ctx.input?.claim;
    out = mode === 'publish' ? await publish(claim, env) : mode === 'unpublish' ? await unpublish(claim, env) : mode === 'find' ? await find(claim, env) : { error: { code: 'invalid_request', message: 'mode is publish, unpublish or find' } };
  } catch (e) {
    out = { status: 'failed', reason: `${e.code ?? 'failed'}: ${String(e.message).slice(0, 200)}`, retry: true };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);

