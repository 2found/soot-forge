#!/usr/bin/env node
// Builds a Lohi marketing workspace from this recipe and does every setup step a
// person does not have to: copies the packs and Soots, writes deployment.json
// (host settings in `env` once the runtime supports it), generates the claim
// key. What is left for a person is printed at the end.
//
//   node examples/lohi-marketing/setup.mjs <workspace-dir> [--port 7790] [--no-video]
//
// Safe to run again: existing files are replaced from the recipe, the claim key
// and any credential already stored are never touched, no secret is printed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const forge = resolve(here, '..', '..');

/** Host settings the Soots need (non-secret). `env` is a workspace field from soot 0.13.12. */
export const HOST_ENV = {
  PRODUCT_API_URL: 'https://api.lohi2.com',
  SOOT_BROWSER_PERSISTENT_SOOTS: 'lohi-editor',
  LOHI_BLOG_REMOTE: 'git@github.com:reallongnguyen/novel-reader.git',
};

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

export function build(dir, { port = 7790, video = true, soot = 'soot', home, env = runtimeKnowsEnv(soot) } = {}) {
  const out = resolve(dir);
  const host = JSON.parse(readFileSync(join(here, 'deployment.example.json'), 'utf8'));
  host.listen = `127.0.0.1:${port}`;
  if (!video) {
    host.soots = host.soots.filter(f => !f.includes('lohi-video'));
    delete host.tool_hosts?.['lohi-video'];
  }
  const packs = ['marketing', 'browser-use', ...(video ? ['toolbox'] : [])];
  if (env) host.env = HOST_ENV;
  mkdirSync(join(out, 'packs'), { recursive: true });
  mkdirSync(join(out, 'soots'), { recursive: true });
  for (const id of packs) {
    rmSync(join(out, 'packs', id), { recursive: true, force: true });
    cpSync(join(forge, 'packs', id), join(out, 'packs', id), { recursive: true, filter: s => !/[\\/](tests|node_modules)([\\/]|$)/.test(s) });
  }
  rmSync(join(out, 'packs', 'lohi-blog'), { recursive: true, force: true });
  cpSync(join(here, 'packs', 'lohi-blog'), join(out, 'packs', 'lohi-blog'), { recursive: true, filter: s => !/[\\/]tests([\\/]|$)/.test(s) });
  for (const f of host.soots) cpSync(join(here, f), join(out, f));
  for (const f of ['SOUL.md', 'writer.md', 'editor.md', ...(video ? ['video.md'] : [])]) cpSync(join(here, 'soots', f), join(out, 'soots', f));
  writeFileSync(join(out, 'deployment.json'), JSON.stringify(host, null, 2) + '\n');
  const key = claimKeyFile('lohi-editor', { home, credentialsDir: host.credentials_dir });
  return { out, packs, env, keyMade: ensureClaimKey(key), key };
}

export const PERSON_STEPS = [
  'Đăng nhập X, Facebook, Reddit trong Nest khi Cần bạn hiện thẻ (mỗi nền tảng một lần bấm).',
  'Đăng nhập Google trong Nest cho Search Console (tuỳ chọn; không có thì chọn chủ đề theo danh mục).',
  'Đăng blog: máy cần git qua SSH tới kho kiem-lai, go, 2server, gcloud đã đăng nhập; thiếu gì Soot báo đúng một thẻ Cần bạn.',
  'Chiến dịch (tuỳ chọn): khoá API vai trò agent_mod của Lohi, nhập PRODUCT_ADMIN_KEY trong Nest.',
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--port');
  if (!dir) { console.error('usage: node setup.mjs <workspace-dir> [--port 7790] [--no-video]'); process.exit(2); }
  const port = Number(args[args.indexOf('--port') + 1]) || 7790;
  const r = build(dir, { port, video: !args.includes('--no-video') });
  console.log(`Workspace: ${r.out}`);
  console.log(`Packs: ${r.packs.join(', ')}, lohi-blog (kèm ${r.keyMade ? 'khoá ký lượt đăng vừa tự sinh' : 'khoá ký lượt đăng đã có'}, không in ra).`);
  if (!r.env) console.log(`Runtime chưa có \`env\`: khởi động với ${Object.entries(HOST_ENV).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (args.includes('--no-video')) console.log('Không có Video Soot (--no-video).');
  else console.log('Video: cài thêm `soot add 2found/soot-forge/packs/2build` khi cần làm video.');
  console.log('Việc chỉ người làm được:');
  PERSON_STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}
