// Lohi blog publisher (design §4.2): `node tools/blog.mjs publish|unpublish|find`
// reads {claim} from the ToolContext and answers the publisher contract.
//
// Two targets, chosen by the host env LOHI_BLOG_TARGET: `git` (the default, the blog.lohi2.com repository
// described below) and `cms` (lohi2.com/blog: the post is saved and published to the 2found hub CMS, site
// `lohi`, language `vi`, with the operator credential MARKETING_HUB; see the "CMS target" section).
//
// It never touches the founder's working tree: it keeps its own clean
// worktree of $LOHI_REPO (else its own clone of $LOHI_BLOG_REMOTE) at $SOOT_PACK_STATE/blog-worktree, reset to
// origin/main for every call. Publish writes one post file, builds the blog
// with zero warnings, commits only that file (trailer `Soot-Intent: <id>`),
// pushes fast-forward only, runs the worktree's own deploy.sh and polls the
// URL. A deploy that fails is followed by a revert push, so main matches live.
import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE = 'https://blog.lohi2.com';
export const DEFAULT_API = 'https://api.lohi2.com';
export const SITE = 'https://lohi2.com';
export const CMS_SITE = 'lohi';
export const CMS_LANGUAGE = 'vi';
export const CMS_BLOG_BASE = `${SITE}/blog`;
const CMS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
  const run = (cmd, args, opts = {}) => sh(cmd, args, { env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15', ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}), ...(opts.env ?? {}) }, cwd: opts.cwd, timeout: opts.timeout });
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
      await linkConnection(env.LOHI_REPO, wt, env);
      const r = await run('bash', [join(wt, 'blog', 'infra', 'gce', 'deploy.sh'), '--env', 'prod'], { cwd: join(wt, 'blog'), timeout: 15 * 60_000 });
      return { ok: r.ok, detail: (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300) };
    },
    fetch: globalThis.fetch,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    soot: 'lohi-editor',
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
export async function linkConnection(repo, wt, env = {}) {
  const own = join(wt, '.2server');
  const link = async file => {
    await rm(own, { recursive: true, force: true });
    await mkdir(own, { recursive: true, mode: 0o700 });
    await writeFile(join(own, '.gitignore'), '*\n', { mode: 0o600 });
    await symlink(file, join(own, basename(file)));
    return file;
  };
  if (repo) {
    for (let dir = resolve(repo); ; dir = dirname(dir)) {
      for (const name of ['connection.yaml', 'connection.json']) {
        const file = join(dir, '.2server', name);
        if (existsSync(file)) return link(file);
      }
      if (dirname(dir) === dir) break;
    }
  }
  // No checkout: the operator's own connection file, named by LOHI_CONNECTION or kept in ~/.2server.
  const file = connectionFile(env);
  return file ? link(file) : null;
}

/** The 2server connection file when the machine has no kiem-lai checkout. */
export function connectionFile(env) {
  const named = env.LOHI_CONNECTION;
  const home = env.HOME ? [join(env.HOME, '.2server', 'connection.yaml'), join(env.HOME, '.2server', 'connection.json')] : [];
  return [named, ...home].filter(Boolean).find(f => existsSync(f)) ?? null;
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

/**
 * The git repository the tool works from: the founder's checkout when LOHI_REPO
 * names one (kept for a machine that has it), else its own clone of the
 * configured remote under the pack state, made on first use.
 */
export async function repoOf(d, env, state) {
  if (env.LOHI_REPO) return env.LOHI_REPO;
  if (!state) throw Object.assign(new Error('The host gave this call no pack state directory.'), { code: 'state_missing' });
  const dir = join(state, 'blog-repo');
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(state, { recursive: true });
    await rm(dir, { recursive: true, force: true });
    // No default: a workspace that does not say where the blog lives must never push to the real one.
    const remote = env.LOHI_BLOG_REMOTE;
    if (!remote) throw Object.assign(new Error('No blog repository is configured (LOHI_BLOG_REMOTE or LOHI_REPO); nothing was cloned or pushed.'), { code: 'remote_missing' });
    const r = await d.run('git', ['clone', '--quiet', '--no-checkout', remote, dir], { timeout: 10 * 60_000 });
    if (!r.ok) { await rm(dir, { recursive: true, force: true }); throw Object.assign(new Error(`cannot clone ${remote}: ${r.stderr.trim().split('\n').pop()}`), { code: 'clone_failed' }); }
  }
  return dir;
}

/** The tool's own clean worktree at origin/main, created on first use. */
export async function worktree(d, repo, state) {
  if (!repo || !existsSync(join(repo, '.git'))) throw Object.assign(new Error('The blog repository is not a git checkout.'), { code: 'repo_missing' });
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
  if (!(await git(d, wt, ...AUTHOR, 'rebase', '--quiet', 'origin/main')).ok) { await git(d, wt, 'rebase', '--abort'); return false; }
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

const unknownTarget = env => failed(`target_invalid: LOHI_BLOG_TARGET is "${targetOf(env)}"; use git or cms`, false);

export async function publish(claim, env, deps = {}) {
  const d = { ...defaults(env), ...deps };
  if (targetOf(env) === 'cms') return publishCms(claim, env, d);
  if (targetOf(env) !== 'git') return unknownTarget(env);
  const refused = checkClaim(claim, 'publish', env, d.now());
  if (refused) return refused;
  const url = postURL(claim, env.LOHI_BLOG_URL || DEFAULT_BASE), file = postPath(claim);
  const wt = await worktree(d, await repoOf(d, env, env.SOOT_PACK_STATE), env.SOOT_PACK_STATE);

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
  if (targetOf(env) === 'cms') return unpublishCms(claim, env, d);
  if (targetOf(env) !== 'git') return unknownTarget(env);
  const refused = checkClaim(claim, 'unpublish', env, d.now());
  if (refused) return refused;
  const url = postURL(claim, env.LOHI_BLOG_URL || DEFAULT_BASE), file = postPath(claim);
  const wt = await worktree(d, await repoOf(d, env, env.SOOT_PACK_STATE), env.SOOT_PACK_STATE);
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
  if (targetOf(env) === 'cms') return findCms(claim, env, d);
  if (targetOf(env) !== 'git') return { found: false, refused: 'target_invalid' };
  const url = postURL(claim, env.LOHI_BLOG_URL || DEFAULT_BASE);
  const wt = await worktree(d, await repoOf(d, env, env.SOOT_PACK_STATE), env.SOOT_PACK_STATE);
  const sha = await intentCommit(d, wt, claim.intent_id);
  const live = sha && await onMain(d, wt, postPath(claim)) && await status(d, url) === 200;
  return live ? { found: true, url, platform_id: sha } : { found: false };
}


// ---------- CMS target (lohi2.com/blog) ----------
//
// The post is saved as a draft and then published through the hub's tools (`cms_read`, `cms_save`, `cms_publish`)
// with the MARKETING_HUB binding {service_url, service_token}: the same call `soot tool-forward` makes, made here
// so that one deterministic tool does read -> save -> publish -> verify. Whether a post may go out is still decided
// by marketing_claim (its guard and approval policy); the hub token must be a publisher for site `lohi`.

export const targetOf = env => (String(env.LOHI_BLOG_TARGET ?? '').trim().toLowerCase() || 'git');
const cmsURL = slug => `${CMS_BLOG_BASE}/${slug}`;
const norm = t => String(t ?? '').replace(/\s+/g, ' ').trim();

/** The MARKETING_HUB binding, checked the way `soot tool-forward` checks it. Throws a coded error. */
export function parseHub(raw) {
  const bad = (code, message) => Object.assign(new Error(message), { code });
  if (!raw || !String(raw).trim()) throw bad('hub_missing', 'MARKETING_HUB is not set for this Soot.');
  let b;
  try { b = JSON.parse(raw); } catch { throw bad('hub_invalid', 'MARKETING_HUB is not JSON {"service_url","service_token"}.'); }
  const keys = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b).sort().join(',') : '';
  if (keys !== 'service_token,service_url' || typeof b.service_url !== 'string' || typeof b.service_token !== 'string' || !b.service_token) throw bad('hub_invalid', 'MARKETING_HUB must be exactly {"service_url","service_token"}.');
  let u;
  try { u = new URL(b.service_url); } catch { throw bad('hub_invalid', 'MARKETING_HUB service_url is not a URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.search || u.hash || /\/v1\/tool\/?$/.test(u.pathname)) throw bad('hub_invalid', 'MARKETING_HUB service_url must be an https address (no credentials, query or /v1/tool).');
  return { url: b.service_url.replace(/\/+$/, ''), token: b.service_token, origin: u.origin };
}

/** A hub tool call. Answers the JSON body; throws {code, retry} for a refusal, an outage or a mistake the hub names. */
async function hubCall(d, hub, soot, tool, input, hook = 'tool.call') {
  const fail = (code, message, retry) => Object.assign(new Error(message), { code, retry });
  let res;
  try {
    res = await d.fetch(`${hub.url}/v1/tool`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${hub.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_version: 'soot/v1', hook, soot, operation: `marketing_${tool}`, input }),
    });
  } catch { throw fail('hub_unreachable', 'the hub did not answer', true); }
  if (res.status === 401 || res.status === 403) throw fail('hub_refused', `the hub refused the MARKETING_HUB credential (HTTP ${res.status})`, false);
  if (res.status === 400) {
    let body = null;
    try { body = await res.json(); } catch { /* not ours */ }
    throw fail('hub_invalid_input', String(body?.error?.message ?? 'the hub refused the call').slice(0, 300), false);
  }
  if (res.status !== 200) throw fail('hub_unavailable', `the hub answered HTTP ${res.status}`, true);
  try { return await res.json(); } catch { throw fail('hub_unavailable', 'the hub answered something that is not JSON', true); }
}

/** The public read API: the post as readers get it, or null (404). Never needs a credential. */
async function publicPost(d, hub, slug) {
  const url = `${hub.origin}/api/cms/v1/sites/${CMS_SITE}/posts/${slug}`;
  let res;
  try { res = await d.fetch(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); } catch { return undefined; }
  if (res.status === 404) return null;
  if (res.status !== 200) return undefined;
  try { const j = await res.json(); return j?.post && (j.post.language ?? CMS_LANGUAGE) === CMS_LANGUAGE ? j.post : null; } catch { return undefined; }
}

const uuid5 = parts => {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const cmsClaimProblem = (claim, action) => {
  if (!CMS_SLUG.test(claim.slug) || claim.slug.length > 96) return 'claim_invalid: slug is not a CMS slug (lowercase words, single hyphens)';
  if (action !== 'publish') return null;
  if (Array.from(norm(claim.title)).length > 200) return 'claim_invalid: title is over 200 characters';
  if (Array.from(norm(claim.meta)).length > 500) return 'claim_invalid: meta is over 500 characters (the CMS summary)';
  if (Buffer.byteLength(String(claim.body).trim(), 'utf8') > 40_000) return 'claim_invalid: body is over 40000 bytes';
  return null;
};

const hubFailure = e => failed(`${e.code ?? 'failed'}: ${String(e.message).slice(0, 200)}`, e.retry ?? true);

/**
 * Save (create or update by slug) and publish. Idempotent: the same claim again finds the content already in
 * the CMS and saves nothing twice; a crash between save and publish publishes the saved revision.
 */
export async function publishCms(claim, env, d) {
  const refused = checkClaim(claim, 'publish', env, d.now());
  if (refused) return refused;
  return publishPost(claim, env, d);
}

/**
 * The CMS half of publish for one post {slug, title, meta, body}, with no claim: used by publishCms (after the claim
 * verified) and by the one-off migration of the posts blog.lohi2.com already holds.
 */
export async function publishPost(post, env, deps = {}) {
  const d = { ...defaults(env), ...deps };
  const bad = cmsClaimProblem(post, 'publish');
  if (bad) return failed(bad, false);
  let hub;
  try { hub = parseHub(env.MARKETING_HUB); } catch (e) { return failed(`${e.code}: ${e.message}`, false); }
  const slug = post.slug, url = cmsURL(slug);
  const want = { title: norm(post.title), summary: norm(post.meta), body: String(post.body).trim() };
  const soot = d.soot;
  try {
    let cur = null;
    try { cur = await hubCall(d, hub, soot, 'cms_read', { site: CMS_SITE, slug }); } catch (e) { if (!(e.code === 'hub_invalid_input' && /^no post /.test(e.message))) throw e; }
    const same = cur && cur.language === CMS_LANGUAGE && norm(cur.title) === want.title && norm(cur.summary) === want.summary && String(cur.body_markdown ?? '').trim() === want.body;
    let revision = cur?.revision, status = cur?.status;
    if (!same) {
      const saved = await hubCall(d, hub, soot, 'cms_save', {
        site: CMS_SITE, slug, request_id: uuid5(['lohi-blog', CMS_SITE, slug, cur?.revision ?? 0, want]), expected_revision: cur?.revision ?? 0,
        title: want.title, summary: want.summary, body_markdown: want.body, language: CMS_LANGUAGE, status: 'draft',
      });
      revision = saved.revision; status = saved.status;
    }
    if (status !== 'published') {
      const out = await hubCall(d, hub, soot, 'cms_publish', { site: CMS_SITE, slug, revision, title: want.title, status: 'published' });
      revision = out.revision ?? revision;
    }
    // Live means the public read API returns this revision (a few tries: the write has just committed).
    for (let i = 0; i < 5; i++) {
      const live = await publicPost(d, hub, slug);
      if (live && live.revision >= revision && norm(live.title) === want.title) return { status: 'published', url, platform_id: `cms:${CMS_SITE}/${slug}@${live.revision}` };
      await d.sleep(2_000);
    }
    return failed(`verify_failed: ${CMS_SITE}/${slug} revision ${revision} is not in the public CMS read API`, true);
  } catch (e) { return hubFailure(e); }
}

export async function unpublishCms(claim, env, d) {
  const refused = checkClaim(claim, 'unpublish', env, d.now());
  if (refused) return refused;
  const bad = cmsClaimProblem(claim, 'unpublish');
  if (bad) return failed(bad, false);
  let hub;
  try { hub = parseHub(env.MARKETING_HUB); } catch (e) { return failed(`${e.code}: ${e.message}`, false); }
  const slug = claim.slug, soot = d.soot;
  try {
    let cur = null;
    try { cur = await hubCall(d, hub, soot, 'cms_read', { site: CMS_SITE, slug }); } catch (e) { if (!(e.code === 'hub_invalid_input' && /^no post /.test(e.message))) throw e; }
    if (cur && cur.status !== 'archived') await hubCall(d, hub, soot, 'cms_publish', { site: CMS_SITE, slug, revision: cur.revision, title: cur.title, status: 'archived' });
    for (let i = 0; i < 5; i++) {
      if ((await publicPost(d, hub, slug)) === null) return { status: 'removed' };
      await d.sleep(2_000);
    }
    return failed(`verify_failed: ${CMS_SITE}/${slug} is still in the public CMS read API`, true);
  } catch (e) { return hubFailure(e); }
}

/** Crash recovery: is exactly this content already live in the CMS? */
export async function findCms(claim, env, d) {
  let hub;
  try { hub = parseHub(env.MARKETING_HUB); } catch { return { found: false, refused: 'hub_missing' }; }
  const live = await publicPost(d, hub, claim.slug);
  const same = live && norm(live.title) === norm(claim.title) && norm(live.summary) === norm(claim.meta) && String(live.bodyMarkdown ?? '').trim() === String(claim.body ?? '').trim();
  return same ? { found: true, url: cmsURL(claim.slug), platform_id: `cms:${CMS_SITE}/${claim.slug}@${live.revision}` } : { found: false };
}

/** What a person must still do for the CMS target: the credential, the site and the publish right. */
export async function readyCms(env, d) {
  const missing = [];
  const need = (key, title, how) => missing.push({ key, title, how });
  let hub = null;
  try { hub = parseHub(env.MARKETING_HUB); } catch (e) {
    need(e.code, e.code === 'hub_missing' ? 'Chưa nối CMS của lohi2.com/blog' : 'Kết nối CMS (MARKETING_HUB) sai dạng', 'Nhập MARKETING_HUB cho Soot Ops trong Nest (Cài đặt → Kết nối): {"service_url":"https://2found.dev/api/hub","service_token":"…"}; token phải là của người đăng cho site lohi.');
  }
  if (hub) {
    const soot = d.soot;
    // A publish preflight changes nothing: it checks the site and the publish right before it looks for the post.
    try { await hubCall(d, hub, soot, 'cms_publish', { site: CMS_SITE, slug: 'ready-check', revision: 1, title: 'ready-check', status: 'published' }, 'tool.preflight'); } catch (e) {
      if (e.code === 'hub_refused') need('hub_refused', 'CMS từ chối khoá MARKETING_HUB', 'Token sai hoặc đã thu hồi: nhập lại MARKETING_HUB cho Soot Ops trong Nest.');
      else if (e.code === 'hub_invalid_input' && /not open to this Soot/.test(e.message)) need('hub_site', 'Token CMS không có site lohi', 'Xin quản trị hub thêm site lohi cho token này.');
      else if (e.code === 'hub_invalid_input' && /only a publisher/.test(e.message)) need('hub_publish', 'Token CMS không có quyền đăng', 'Xin quản trị hub cấp quyền đăng (publish) cho token này.');
      else if (e.code !== 'hub_invalid_input') need('hub_down', 'Chưa gọi được CMS', `Kiểm tra ${hub.origin} (${e.message}); Soot thử lại hằng ngày.`);
    }
  }
  return missing;
}

// ---------- real catalog (public Lohi endpoints only) ----------

const short = (t, n) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + '…' : x; };

/**
 * List or search the novels a guest can read: GET /novel/discovery/feed (trending|new, genre)
 * and GET /novel/novels/search?q=. Every row carries the lohi2.com page that opens it.
 */
export async function catalog(input, env, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const api = (env.LOHI_API_URL || DEFAULT_API).replace(/\/+$/, '');
  const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 20);
  const get = async url => {
    const res = await f(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`${url} answered ${res.status}`), { code: 'catalog_unavailable' });
    return res.json();
  };
  if (input.genres === true) return { genres: await get(`${api}/novel/discovery/genres`) };
  let rows, from;
  if (typeof input.query === 'string' && input.query.trim()) {
    const u = new URL(`${api}/novel/novels/search`);
    u.searchParams.set('q', input.query.trim()); u.searchParams.set('limit', String(Math.min(limit, 20)));
    if (input.genre) u.searchParams.set('genres', input.genre);
    rows = (await get(u.toString())).matches ?? []; from = 'search';
  } else {
    const u = new URL(`${api}/novel/discovery/feed`);
    u.searchParams.set('limit', '60'); u.searchParams.set('sort', input.sort === 'new' ? 'new' : 'trending');
    if (input.genre) u.searchParams.set('genres', input.genre);
    rows = await get(u.toString()); from = 'feed';
  }
  let novels = rows.filter(n => n.slug && (n.access ?? 'open') === 'open' && n.hasChapters !== false);
  if (input.completed === true) novels = novels.filter(n => n.completionStatus === 'completed');
  return {
    from,
    novels: novels.slice(0, limit).map(n => ({
      slug: n.slug, title: n.titleVi ?? n.title, author: n.authorNameVi ?? n.authorVi ?? null, genres: n.genres ?? [],
      chapters: n.totalChapters ?? null, status: n.completionStatus ?? null, summary: short(n.synopsis, 150) || null,
      url: `${SITE}/truyen/${n.slug}`,
    })),
  };
}

// ---------- readiness: every prerequisite, once, up front ----------

const bin = async (d, name) => (await d.run('sh', ['-c', `command -v ${name}`])).ok;

/** The git target's prerequisites: binaries, push access to the blog repository, the 2server connection. */
async function readyGit(env, d) {
  const missing = [];
  const need = (key, title, how) => missing.push({ key, title, how });
  for (const [name, how] of [['git', 'Cài git.'], ['go', 'Cài Go (dựng blog).'], ['2server', 'Cài 2server CLI 0.2.0 trở lên.'], ['gcloud', 'Cài gcloud và đăng nhập (`gcloud auth login`).']]) {
    if (!(await bin(d, name))) need(name, `Thiếu ${name}`, how);
  }
  const remote = env.LOHI_REPO ? null : env.LOHI_BLOG_REMOTE;
  if (!env.LOHI_REPO && !remote) need('blog_remote', 'Chưa chọn kho đăng blog', 'Điền địa chỉ kho blog (LOHI_BLOG_REMOTE) trong Thiết lập; Soot không đăng blog khi chưa có.');
  const probe = !env.LOHI_REPO && !remote ? { ok: true } : await d.run('git', env.LOHI_REPO ? ['-C', env.LOHI_REPO, 'ls-remote', '--exit-code', 'origin', 'HEAD'] : ['ls-remote', '--exit-code', remote, 'HEAD'], { timeout: 30_000 });
  if (!probe.ok) need('git_remote', 'Chưa đẩy được lên kho kiem-lai', `Thêm khoá SSH của máy này vào GitHub (ssh-add), rồi kiểm tra \`git ls-remote ${remote ?? 'origin'}\`.`);
  if (!(env.LOHI_REPO ? linkConnectionExists(env.LOHI_REPO) || connectionFile(env) : connectionFile(env))) need('connection', 'Thiếu kết nối 2server', 'Đặt tệp kết nối 2server vào ~/.2server/connection.yaml (hoặc LOHI_CONNECTION).');
  if (await bin(d, 'gcloud')) {
    const who = await d.run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { timeout: 30_000 });
    if (!who.ok || !who.stdout.trim()) need('gcloud_auth', 'gcloud chưa đăng nhập', 'Chạy `gcloud auth login` rồi `gcloud config set project lohi-dev-lohi`.');
  }
  return missing;
}

/**
 * What a person must still do for the publisher to work, as one Cần bạn item. Silent when all is ready. The
 * runtime files `ask` as a card by itself (same ask, same card), so no model wakes to relay it.
 */
export async function ready(env, deps = {}) {
  const d = { ...defaults(env), ...deps };
  const target = targetOf(env);
  const missing = target === 'cms' ? await readyCms(env, d) : target === 'git' ? await readyGit(env, d)
    : [{ key: 'target', title: 'LOHI_BLOG_TARGET sai', how: `Đặt LOHI_BLOG_TARGET là cms hoặc git (đang là "${target}").` }];
  const sig = missing.map(m => m.key).sort().join(',');
  const file = env.SOOT_PACK_STATE ? join(env.SOOT_PACK_STATE, 'ready.json') : null;
  let last = null;
  try { last = file ? JSON.parse(await readFile(file, 'utf8')).sig : null; } catch { /* first run */ }
  const changed = sig !== (last ?? '');
  if (file && changed) { await mkdir(env.SOOT_PACK_STATE, { recursive: true }); await writeFile(file, JSON.stringify({ sig, at: new Date(d.now()).toISOString() })); }
  // Nothing missing any more: the runtime closes the Cần bạn card this schedule raised (resolves_need).
  const out = { ok: missing.length === 0, missing, wake: false, notify: false, ...(missing.length === 0 ? { resolves_need: true } : {}) };
  if (missing.length) {
    out.ask = {
      summary: target === 'cms' ? 'Hoàn tất thiết lập đăng blog lên lohi2.com/blog' : 'Hoàn tất thiết lập đăng blog Lohi',
      missing: missing.map(m => `${m.title}: ${m.how}`).join('\n'),
      options: [{ label: 'Đã xong, kiểm tra lại' }],
    };
  }
  return out;
}
const linkConnectionExists = repo => { for (let dir = resolve(repo); ; dir = dirname(dir)) { if (['connection.yaml', 'connection.json'].some(n => existsSync(join(dir, '.2server', n)))) return true; if (dirname(dir) === dir) return false; } };

// ---------- entry ----------

/**
 * The publisher's answer as the next step of a schedule tool chain (claim → publish → record) reads it:
 * `ok` tells the chain to go on (record) or to stop and wake the Editor, and the record input
 * (`intent_id`, `url`, `platform_id`) is in the same object. The publisher contract's own fields stay.
 */
export const asChainStep = (out, claim) => ({ ...out, ok: out.status === 'published' || out.status === 'removed', intent_id: typeof claim?.intent_id === 'string' ? claim.intent_id : undefined });

export async function main(mode, env = process.env) {
  let out, ctxClaim;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const ctx = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const claim = ctxClaim = ctx.input?.claim;
    const soot = typeof ctx.soot === 'string' && ctx.soot ? ctx.soot : undefined;
    const deps = soot ? { soot } : {};
    out = mode === 'publish' ? asChainStep(await publish(claim, env, deps), claim) : mode === 'unpublish' ? asChainStep(await unpublish(claim, env, deps), claim) : mode === 'find' ? await find(claim, env, deps)
      : mode === 'catalog' ? await catalog(ctx.input ?? {}, env) : mode === 'ready' ? await ready(env, { soot })
      : { error: { code: 'invalid_request', message: 'mode is publish, unpublish, find, catalog or ready' } };
  } catch (e) {
    out = mode === 'catalog' || mode === 'ready' ? { error: { code: e.code ?? 'failed', message: String(e.message).slice(0, 200) } }
      : asChainStep({ status: 'failed', reason: `${e.code ?? 'failed'}: ${String(e.message).slice(0, 200)}`, retry: true }, ctxClaim);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);

