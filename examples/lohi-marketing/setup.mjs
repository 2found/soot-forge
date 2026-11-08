#!/usr/bin/env node
// Builds a Lohi marketing workspace from this recipe and does every setup step a
// person does not have to: copies the packs and Soots, writes deployment.json
// (host settings in `env` once the runtime supports it), generates the claim
// key. What is left for a person is printed at the end.
//
//   node examples/lohi-marketing/setup.mjs <workspace-dir> [--port 7790] [--no-video] [--blog-remote <git url>]
//                                       [--product-repo <abs path>] [--cs-runtime-url <url>]
//
// Safe to run again: existing files are replaced from the recipe, the claim key
// and any credential already stored are never touched, no secret is printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDevOnly } from '../../scripts/archive.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const forge = resolve(here, '..', '..');

/** Host settings the Soots need (non-secret). `env` is a workspace field from soot 0.13.12. */
export const HOST_ENV = {
  PRODUCT_API_URL: 'https://api.lohi2.com',
  SOOT_BROWSER_PERSISTENT_SOOTS: 'lohi-editor',
  // The scoreboard contract of the Lohi api (company-loop): aggregate numbers, read with the agent_mod key.
  SCOREBOARD_URL: 'https://api.lohi2.com/admin/analysis/scoreboard',
};
// LOHI_BLOG_REMOTE has no default: a workspace set up without `--blog-remote` must never be able to push to the real blog repo.
// PRODUCT_REPO has no default either: the company loop writes a requirement file into it and spawns a bbs team there, so a scratch
// workspace never points at the real checkout unless `--product-repo` says so. CS_RUNTIME_URL (`--cs-runtime-url`) is optional.

/**
 * The founder's 2server connection, found without asking: LOHI_REPO, else the kiem-lai checkout
 * that holds this forge (a parent directory with .2server/connection.yaml or .json), else
 * ~/.2server. Returns the file or null. Never read or printed.
 */
export function findConnection({ repo = process.env.LOHI_REPO, start = forge, home = homedir() } = {}) {
  const names = ['connection.yaml', 'connection.json'];
  const roots = [];
  if (repo) roots.push(resolve(repo));
  for (let dir = resolve(start); ; dir = dirname(dir)) { roots.push(dir); if (dirname(dir) === dir) break; }
  for (const dir of roots) for (const n of names) if (existsSync(join(dir, '.2server', n))) return join(dir, '.2server', n);
  for (const n of names) if (existsSync(join(home, '.2server', n))) return join(home, '.2server', n);
  return null;
}

export function claimKeyFile(soot = 'lohi-editor', { home = process.env.SOOT_HOME || join(homedir(), '.soot'), credentialsDir } = {}) {
  return join(credentialsDir || home, 'tool-credentials', soot, 'MARKETING_CLAIM_KEY');
}

/** Creates the claim key once. Returns true when it made one. */
export function ensureClaimKey(file) {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  chmodSync(file, 0o600);
  return true;
}

function runtimeKnowsEnv(soot) {
  try {
    const schema = JSON.parse(execFileSync(soot, ['schema', 'deployment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return Boolean(schema.properties?.env);
  } catch { return false; }
}

const RECEIPT = '.soot-source.json';
const versionOf = file => { try { const v = JSON.parse(readFileSync(file, 'utf8')).version; return typeof v === 'number' || typeof v === 'string' ? String(v) : ''; } catch { return ''; } };
const newer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) > 0;

/**
 * A pack Forge already installed (it has the install receipt) is left alone unless the recipe's copy is newer: wiping it
 * would drop the receipt and dev-only files would make `soot updates` say the pack was edited on this host. Otherwise
 * the pack is copied as the release archive ships it (scripts/archive.mjs), and a receipt that is there is kept.
 */
export function installPack(forgeDir, out, id) {
  const to = join(out, 'packs', id);
  const from = join(forgeDir, 'packs', id);
  const receipt = join(to, RECEIPT);
  if (existsSync(receipt) && !newer(versionOf(join(from, 'pack.json')), versionOf(join(to, 'pack.json')))) return 'kept';
  if (existsSync(to)) for (const name of readdirSync(to)) if (name !== RECEIPT) rmSync(join(to, name), { recursive: true, force: true });
  // The release archive's own rule: a copy with a test file the archive omits is no longer the Forge copy.
  cpSync(from, to, { recursive: true, filter: s => !/[\\/]node_modules([\\/]|$)/.test(s) && !isDevOnly(relative(from, s).split(sep).join('/')) });
  return 'copied';
}

export function build(dir, { port = 7790, video = true, blogRemote, productRepo, csRuntimeUrl, soot = 'soot', home, env = runtimeKnowsEnv(soot), connection = findConnection() } = {}) {
  const out = resolve(dir);
  const host = JSON.parse(readFileSync(join(here, 'deployment.example.json'), 'utf8'));
  host.listen = `127.0.0.1:${port}`;
  if (!video) {
    host.soots = host.soots.filter(f => !f.includes('lohi-video'));
    delete host.tool_hosts?.['lohi-video'];
  }
  const packs = ['marketing', 'browser-use', 'company-loop', ...(video ? ['toolbox'] : [])];
  const hostEnv = { ...HOST_ENV, ...(blogRemote ? { LOHI_BLOG_REMOTE: blogRemote } : {}), ...(productRepo ? { PRODUCT_REPO: productRepo } : {}), ...(csRuntimeUrl ? { CS_RUNTIME_URL: csRuntimeUrl } : {}), ...(connection ? { LOHI_CONNECTION: connection } : {}) };
  if (env) host.env = hostEnv;
  mkdirSync(join(out, 'packs'), { recursive: true });
  mkdirSync(join(out, 'soots'), { recursive: true });
  for (const id of packs) installPack(forge, out, id);
  rmSync(join(out, 'packs', 'lohi-blog'), { recursive: true, force: true });
  cpSync(join(here, 'packs', 'lohi-blog'), join(out, 'packs', 'lohi-blog'), { recursive: true, filter: s => !/[\\/]tests([\\/]|$)/.test(s) });
  for (const f of host.soots) cpSync(join(here, f), join(out, f));
  for (const f of ['SOUL.md', 'writer.md', 'editor.md', ...(video ? ['video.md'] : [])]) cpSync(join(here, 'soots', f), join(out, 'soots', f));
  writeFileSync(join(out, 'deployment.json'), JSON.stringify(host, null, 2) + '\n');
  const key = claimKeyFile('lohi-editor', { home, credentialsDir: host.credentials_dir });
  return { out, packs, env, hostEnv, connection: Boolean(connection), keyMade: ensureClaimKey(key), key };
}

export const PERSON_STEPS = [
  'Đăng nhập X, Facebook, Reddit trong Nest khi Cần bạn hiện thẻ (mỗi nền tảng một lần bấm).',
  'Đăng nhập Google trong Nest cho Search Console (tuỳ chọn; không có thì chọn chủ đề theo danh mục).',
  'Đăng blog: máy cần git qua SSH tới kho kiem-lai, go, 2server, gcloud đã đăng nhập; thiếu gì Soot báo đúng một thẻ Cần bạn.',
  'Chiến dịch và bảng số công ty (tuỳ chọn): khoá API vai trò agent_mod của Lohi, nhập PRODUCT_ADMIN_KEY trong Nest.',
  'Vòng lặp công ty: mở trang Công ty, bấm Go / Để sau / Bỏ cho từng cơ hội sản phẩm (nội dung thì Soot tự chạy). Muốn Soot mở đội bbs:team thì chạy setup với --product-repo; đội cần bbs và Orca trên máy này.',
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flagValue = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = args.find((a, i) => !a.startsWith('--') && !['--port', '--blog-remote', '--product-repo', '--cs-runtime-url'].includes(args[i - 1]));
  if (!dir) { console.error('usage: node setup.mjs <workspace-dir> [--port 7790] [--no-video] [--blog-remote <git url>] [--product-repo <abs path>] [--cs-runtime-url <url>]'); process.exit(2); }
  for (const f of ['--product-repo', '--cs-runtime-url']) {
    const v = flagValue(f);
    if (args.includes(f) && (!v || v.startsWith('--'))) { console.error(`${f} needs a value.`); process.exit(2); }
  }
  const productRepo = flagValue('--product-repo');
  if (productRepo && !isAbsolute(productRepo)) { console.error('--product-repo needs an absolute path.'); process.exit(2); }
  const csRuntimeUrl = flagValue('--cs-runtime-url');
  const blogRemote = flagValue('--blog-remote');
  if (args.includes('--blog-remote') && (!blogRemote || blogRemote.startsWith('--'))) { console.error('--blog-remote needs a git address.'); process.exit(2); }
  const port = Number(args[args.indexOf('--port') + 1]) || 7790;
  const r = build(dir, { port, video: !args.includes('--no-video'), blogRemote, productRepo, csRuntimeUrl });
  console.log(`Workspace: ${r.out}`);
  console.log(`Packs: ${r.packs.join(', ')}, lohi-blog (kèm ${r.keyMade ? 'khoá ký lượt đăng vừa tự sinh' : 'khoá ký lượt đăng đã có'}, không in ra).`);
  if (!r.env) console.log(`Runtime chưa có \`env\`: khởi động với ${Object.entries(r.hostEnv).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (args.includes('--no-video')) console.log('Không có Video Soot (--no-video).');
  else console.log('Video: cài thêm `soot add 2found/soot-forge/packs/2build` khi cần làm video.');
  console.log(r.connection ? 'Kết nối 2server: đã tìm thấy và ghi vào env (LOHI_CONNECTION).' : 'Kết nối 2server: chưa thấy .2server/connection.yaml; blog-ready sẽ báo một thẻ Cần bạn.');
  console.log(blogRemote ? 'Kho đăng blog: đã ghi LOHI_BLOG_REMOTE theo --blog-remote.' : 'Kho đăng blog: chưa chọn (không có --blog-remote); Soot sẽ không đăng blog và blog-ready báo một thẻ Cần bạn.');
  console.log(productRepo ? 'Kho sản phẩm: đã ghi PRODUCT_REPO theo --product-repo (Soot ghi yêu cầu vào docs/requirements/ và mở đội bbs:team khi bạn bấm Go).' : 'Kho sản phẩm: chưa chọn (không có --product-repo); bấm Go cho cơ hội sản phẩm sẽ báo chưa có kho và không mở đội.');
  console.log('Việc chỉ người làm được:');
  PERSON_STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
