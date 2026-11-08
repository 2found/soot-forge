#!/usr/bin/env node
// Builds a Lohi marketing workspace from this recipe and does every setup step a
// person does not have to: copies the packs and Soots, writes deployment.json
// (host settings in `env` once the runtime supports it), generates the claim
// key. What is left for a person is printed at the end.
//
//   node examples/lohi-marketing/setup.mjs <workspace-dir> [--port 7790] [--video|--no-video] [--blog-remote <git url>]
//                                       [--product-repo <abs path>] [--cs-runtime-url <url>]
//
// The Video Soot is added when the workspace already has the 2build pack
// (--video insists, --no-video leaves it out).
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
  // Where a person answers the readers waiting for one (Lohi admin support queue); named in the daily Cần bạn card.
  SUPPORT_QUEUE_URL: 'https://lohi2.com/admin/support',
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
const forgeVersion = JSON.parse(readFileSync(join(forge, 'package.json'), 'utf8')).version;
/** A pack manifest has no top-level version; the release it came from is in the receipt URL, its data shape in storage.version. */
const releaseOf = dir => { try { return /\/download\/v?([0-9][0-9.]*)\//.exec(JSON.parse(readFileSync(join(dir, RECEIPT), 'utf8')).repository)?.[1] ?? ''; } catch { return ''; } };
const storageOf = dir => { try { const v = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')).storage?.version; return typeof v === 'number' ? v : 0; } catch { return 0; } };
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
  // Kept only when the installed copy is the recipe's release or newer: an older release, or an older data shape, is replaced.
  if (existsSync(receipt) && !(releaseOf(to) && newer(forgeVersion, releaseOf(to))) && storageOf(from) <= storageOf(to)) return 'kept';
  if (existsSync(to)) for (const name of readdirSync(to)) if (name !== RECEIPT) rmSync(join(to, name), { recursive: true, force: true });
  // The release archive's own rule: a copy with a test file the archive omits is no longer the Forge copy.
  cpSync(from, to, { recursive: true, filter: s => !/[\\/]node_modules([\\/]|$)/.test(s) && !isDevOnly(relative(from, s).split(sep).join('/')) });
  return 'copied';
}

/** An optional local pack of this recipe: copied (without tests) when the recipe has it, its fragment merged into the host. */
export function installLocalPack(out, id, host, from = join(here, 'packs', id)) {
  if (!existsSync(join(from, 'pack.json'))) return { installed: false };
  rmSync(join(out, 'packs', id), { recursive: true, force: true });
  cpSync(from, join(out, 'packs', id), { recursive: true, filter: s => !/[\\/](tests|node_modules)([\\/]|$)/.test(s) });
  const file = join(from, 'deployment.fragment.json');
  if (!existsSync(file)) return { installed: true };
  const frag = JSON.parse(readFileSync(file, 'utf8'));
  host.pack_grants = { ...host.pack_grants, ...(frag.pack_grants ?? {}) };
  host.approvals = { ...host.approvals, ...(frag.approvals ?? {}) };
  const have = new Set(host.schedules.map(x => x.id));
  host.schedules = [...host.schedules.filter(x => !(frag.replace_schedules ?? []).includes(x.id)), ...(frag.schedules ?? []).filter(x => !have.has(x.id) || (frag.replace_schedules ?? []).includes(x.id))];
  return { installed: true, soot_packs: frag.soot_packs };
}

export function build(dir, { port = 7790, video, blogRemote, productRepo, csRuntimeUrl, soot = 'soot', home, env = runtimeKnowsEnv(soot), connection = findConnection() } = {}) {
  const out = resolve(dir);
  // The Video Soot selects the 2build pack, which comes from 2found/2build, not
  // from this setup. Without it the whole workspace would fail to load, so the
  // Soot is added only when the pack is there (asked for, or by default).
  const has2build = existsSync(join(out, 'packs', '2build', 'pack.json'));
  if (video && !has2build) throw new Error('Video Soot cần pack 2build: chạy `soot add 2found/soot-forge/packs/2build` trong workspace rồi chạy lại setup (hoặc bỏ --video).');
  video ??= has2build;
  const host = JSON.parse(readFileSync(join(here, 'deployment.example.json'), 'utf8'));
  host.listen = `127.0.0.1:${port}`;
  if (!video) {
    host.soots = host.soots.filter(f => !f.includes('lohi-video'));
    delete host.tool_hosts?.['lohi-video'];
  }
  const packs = ['marketing', 'browser-use', 'company-loop', ...(video ? ['toolbox'] : [])];
  const hostEnv = { ...HOST_ENV, ...(blogRemote ? { LOHI_BLOG_REMOTE: blogRemote } : {}), ...(productRepo ? { PRODUCT_REPO: productRepo } : {}), ...(csRuntimeUrl ? { CS_RUNTIME_URL: csRuntimeUrl } : {}), ...(connection ? { LOHI_CONNECTION: connection } : {}) };
  // The Vòng lặp view asks this workspace's own soot CLI for runs and tokens: it needs the deployment file's absolute path.
  hostEnv.LOOP_SOOT_CONFIG = join(out, 'deployment.json');
  if (env) host.env = hostEnv;
  mkdirSync(join(out, 'packs'), { recursive: true });
  mkdirSync(join(out, 'soots'), { recursive: true });
  for (const id of packs) installPack(forge, out, id);
  rmSync(join(out, 'packs', 'lohi-blog'), { recursive: true, force: true });
  cpSync(join(here, 'packs', 'lohi-blog'), join(out, 'packs', 'lohi-blog'), { recursive: true, filter: s => !/[\\/]tests([\\/]|$)/.test(s) });
  // The slot for the Ops publisher pack (`lohi-ops`, built apart): when the recipe ships packs/lohi-ops it is copied like lohi-blog
  // and its optional deployment.fragment.json ({pack_grants, soot_packs: {<soot>: [refs]}, schedules}) is merged in. Absent: nothing changes.
  const ops = installLocalPack(out, 'lohi-ops', host);
  for (const f of host.soots) cpSync(join(here, f), join(out, f));
  // A local pack may bring its own Soots (packs/<id>/soots/*.json + mission files): they join the workspace's soots/.
  const packSoots = join(out, 'packs', 'lohi-ops', 'soots');
  if (ops.installed && existsSync(packSoots)) {
    for (const f of readdirSync(packSoots)) {
      cpSync(join(packSoots, f), join(out, 'soots', f));
      if (f.endsWith('.json') && !host.soots.includes(`soots/${f}`)) host.soots.push(`soots/${f}`);
    }
    rmSync(packSoots, { recursive: true, force: true });
  }
  if (ops.soot_packs) for (const [id, refs] of Object.entries(ops.soot_packs)) {
    const file = join(out, 'soots', `${id}.json`);
    const soot = JSON.parse(readFileSync(file, 'utf8'));
    soot.packs = [...soot.packs.filter(r => !refs.some(x => x.split(':')[0] === r.split(':')[0])), ...refs];
    writeFileSync(file, JSON.stringify(soot, null, 2) + '\n');
  }
  for (const f of ['SOUL.md', 'writer.md', 'editor.md', 'analyst.md', 'radar.md', 'finance.md', ...(video ? ['video.md'] : [])]) cpSync(join(here, 'soots', f), join(out, 'soots', f));
  writeFileSync(join(out, 'deployment.json'), JSON.stringify(host, null, 2) + '\n');
  const key = claimKeyFile('lohi-editor', { home, credentialsDir: host.credentials_dir });
  if (ops.installed) packs.push('lohi-ops');
  return { out, packs, video, env, hostEnv, connection: Boolean(connection), keyMade: ensureClaimKey(key), key };
}

export const personSteps = ({ productRepo } = {}) => [
  'Đăng nhập X, Facebook, Reddit trong Nest khi Cần bạn hiện thẻ (mỗi nền tảng một lần bấm).',
  'Đăng nhập Google trong Nest cho Search Console (tuỳ chọn; không có thì chọn chủ đề theo danh mục). Chưa đăng nhập thì mục Vòng lặp ghi đúng "GSC chưa nối".',
  'Số TikTok/YouTube (tuỳ chọn): cài yt-dlp một lần (`brew install yt-dlp`); chưa cài thì mục Vòng lặp ghi "chưa có số TikTok".',
  'Đăng blog: máy cần git qua SSH tới kho kiem-lai, go, 2server, gcloud đã đăng nhập; thiếu gì Soot báo đúng một thẻ Cần bạn.',
  'Chiến dịch và bảng số công ty (tuỳ chọn): khoá API vai trò agent_mod của Lohi, nhập PRODUCT_ADMIN_KEY trong Nest.',
  'Vòng lặp công ty: mở trang Công ty, bấm Go / Để sau / Bỏ cho từng cơ hội sản phẩm (nội dung thì Soot tự chạy). ' + (productRepo ? 'Bấm Go thì Soot mở đội bbs:team; đội cần bbs và Orca trên máy này.' : 'Muốn Soot mở đội bbs:team thì chạy setup với --product-repo; đội cần bbs và Orca trên máy này.'),
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flagValue = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = args.find((a, i) => !a.startsWith('--') && !['--port', '--blog-remote', '--product-repo', '--cs-runtime-url'].includes(args[i - 1]));
  if (!dir) { console.error('usage: node setup.mjs <workspace-dir> [--port 7790] [--video|--no-video] [--blog-remote <git url>] [--product-repo <abs path>] [--cs-runtime-url <url>]'); process.exit(2); }
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
  if (args.includes('--video') && args.includes('--no-video')) { console.error('Chọn một: --video hoặc --no-video.'); process.exit(2); }
  let r;
  try {
    r = build(dir, { port, video: args.includes('--no-video') ? false : args.includes('--video') || undefined, blogRemote, productRepo, csRuntimeUrl });
  } catch (e) { console.error(e.message); process.exit(2); }
  console.log(`Workspace: ${r.out}`);
  console.log(`Packs: ${r.packs.join(', ')}, lohi-blog (kèm ${r.keyMade ? 'khoá ký lượt đăng vừa tự sinh' : 'khoá ký lượt đăng đã có'}, không in ra).`);
  if (!r.env) console.log(`Runtime chưa có \`env\`: khởi động với ${Object.entries(r.hostEnv).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (r.video) console.log('Video Soot: có (pack 2build đã cài).');
  else if (args.includes('--no-video')) console.log('Không có Video Soot (--no-video).');
  else console.log('Video Soot: chưa thêm vì workspace chưa có pack 2build. Muốn làm video: `soot add 2found/soot-forge/packs/2build` rồi chạy lại setup.');
  console.log(r.connection ? 'Kết nối 2server: đã tìm thấy và ghi vào env (LOHI_CONNECTION).' : 'Kết nối 2server: chưa thấy .2server/connection.yaml; blog-ready sẽ báo một thẻ Cần bạn.');
  console.log(blogRemote ? 'Kho đăng blog: đã ghi LOHI_BLOG_REMOTE theo --blog-remote.' : 'Kho đăng blog: chưa chọn (không có --blog-remote); Soot sẽ không đăng blog và blog-ready báo một thẻ Cần bạn.');
  console.log(productRepo ? 'Kho sản phẩm: đã ghi PRODUCT_REPO theo --product-repo (Soot ghi yêu cầu vào docs/requirements/ và mở đội bbs:team khi bạn bấm Go).' : 'Kho sản phẩm: chưa chọn (không có --product-repo); bấm Go cho cơ hội sản phẩm sẽ báo chưa có kho và không mở đội.');
  console.log('Việc chỉ người làm được:');
  personSteps({ productRepo }).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
