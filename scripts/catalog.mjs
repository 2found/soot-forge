import { lstat, readdir, readFile, cp, mkdir } from 'node:fs/promises';
import { resolve, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';

export const run = promisify(execFile);
const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const repoName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const commit = /^[0-9a-f]{40}$/;
const skipped = new Set(['.git', '.gitignore', 'node_modules', 'fixtures', 'bin', 'data', 'dist', '__pycache__']);
const checkManifest = new Ajv2020({ strict: false, allErrors: true }).compile(
  JSON.parse(readFileSync(new URL('../schemas/pack.json', import.meta.url), 'utf8')));

function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} fields`);
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`Invalid ${label}`);
}
export function safePath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(path) ||
      path.startsWith('/') || path.endsWith('/') || posix.normalize(path) !== path ||
      path.split('/').some(part => part === '..' || part.startsWith('.')))
    throw new Error('Pack path must be a clean repository-relative folder');
  return path;
}

export function validateCatalog(catalog) {
  keys(catalog, ['version', 'repository', 'packs'], 'catalog');
  if (catalog.version !== 1 || catalog.repository !== '2found/soot-forge' ||
      !Array.isArray(catalog.packs) || catalog.packs.length > 256) throw new Error('Invalid catalog version/repository/packs');
  const ids = new Set();
  for (const pack of catalog.packs) {
    keys(pack, ['id', 'name', 'description', 'tags', 'source'], 'pack entry');
    if (typeof pack.id !== 'string' || !identifier.test(pack.id) || ids.has(pack.id)) throw new Error(`Invalid or duplicate pack id: ${pack.id}`);
    ids.add(pack.id);
    text(pack.name, 80, 'name'); text(pack.description, 300, 'description');
    if (!Array.isArray(pack.tags) || pack.tags.length > 8 || new Set(pack.tags).size !== pack.tags.length ||
        pack.tags.some(tag => typeof tag !== 'string' || !identifier.test(tag))) throw new Error(`Invalid tags for ${pack.id}`);
    const source = pack.source;
    keys(source, source?.kind === 'bundled' ? ['kind', 'path'] : ['kind', 'repository', 'path', 'ref'], 'source');
    safePath(source.path);
    if (source.kind === 'bundled') {
      if (source.path !== `packs/${pack.id}`) throw new Error(`Bundled pack ${pack.id} must live at packs/${pack.id}`);
    } else if (source.kind === 'github') {
      if (typeof source.repository !== 'string' || !repoName.test(source.repository) ||
          source.repository.endsWith('.git') || typeof source.ref !== 'string' || !commit.test(source.ref))
        throw new Error(`External pack ${pack.id} requires owner/repo and a full lowercase commit`);
    } else throw new Error(`Unknown source kind for ${pack.id}`);
  }
  return catalog;
}

export function sourceLink(pack, catalogRef = 'main') {
  const source = pack.source;
  const repository = source.kind === 'bundled' ? '2found/soot-forge' : source.repository;
  return `https://github.com/${repository}/tree/${source.kind === 'bundled' ? catalogRef : source.ref}/${source.path}`;
}
export function installCommand(pack, catalogRef = 'main') { return `soot add ${sourceLink(pack, catalogRef)}`; }

// Do not follow contributor symlinks, even when they target files in the pack.
// Keep archives bounded and portable. No dependency or contributor scripts run.
export async function validateTree(root) {
  let files = 0, bytes = 0;
  async function walk(path, depth) {
    if (depth > 32) throw new Error('Pack tree is too deep');
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Pack contains a non-regular file: ${path}`);
    if (info.isFile()) {
      if (++files > 4096 || (bytes += info.size) > 64 * 1024 * 1024) throw new Error('Pack exceeds 4096 files or 64 MiB');
      return;
    }
    for (const name of await readdir(path)) {
      if (skipped.has(name)) continue;
      if (name.startsWith('.') || name === '.env' || name.includes('\\')) throw new Error(`Hidden or non-portable pack file: ${name}`);
      await walk(join(path, name), depth + 1);
    }
  }
  await walk(root, 0);
}

export async function validatePack(root, expectedID) {
  await validateTree(root);
  const raw = await readFile(join(root, 'pack.json'));
  if (raw.length > 64 * 1024) throw new Error('Pack manifest exceeds 64 KiB');
  const manifest = JSON.parse(raw);
  if (!checkManifest(manifest)) throw new Error(`Invalid pack manifest: ${JSON.stringify(checkManifest.errors)}`);
  if (manifest.api_version !== 'soot/v1' || manifest.id !== expectedID) throw new Error(`Pack manifest id/version mismatch: ${expectedID}`);
  if (!manifest.capabilities || Array.isArray(manifest.capabilities) || typeof manifest.capabilities !== 'object') throw new Error(`Invalid capabilities: ${expectedID}`);
  for (const selector of manifest.use ?? []) {
    const parts = selector.split('/');
    if (parts.length > 2 || parts.some(part => !identifier.test(part)) ||
        ((parts.length === 1 || parts[0] === expectedID) && !Object.hasOwn(manifest.capabilities, parts.at(-1))))
      throw new Error(`Unknown or invalid recipe selector: ${selector}`);
  }
  for (const [name, capability] of Object.entries(manifest.capabilities)) {
    if (!identifier.test(name) || !capability || typeof capability !== 'object') throw new Error(`Invalid capability: ${name}`);
    const skills = new Set(), tools = new Set();
    for (const skill of capability.skills ?? []) {
      const skillName = skill.name || `${expectedID}_${posix.basename(skill.file, posix.extname(skill.file))}`;
      if (!identifier.test(skillName) || skills.has(skillName)) throw new Error(`Invalid or duplicate skill: ${skillName}`);
      skills.add(skillName);
      safePath(skill.file);
      const info = await lstat(join(root, skill.file));
      if (!info.isFile() || info.size > 128 * 1024) throw new Error(`Missing/oversized skill: ${skill.file}`);
    }
    for (const tool of capability.tools ?? []) {
      if (!identifier.test(tool.name) || tools.has(tool.name)) throw new Error(`Invalid or duplicate tool: ${tool.name}`);
      tools.add(tool.name);
      if (tool.run) {
        safePath(tool.run.program);
        if (tool.run.directory && tool.run.directory !== '.') safePath(tool.run.directory);
        if (!['read', 'write', 'repair'].includes(tool.run.mode || 'read') || !identifier.test(tool.run.resource || `${expectedID}_${tool.name}`))
          throw new Error(`Executable tool ${tool.name} needs a mode and resource`);
      }
    }
  }
  return manifest;
}

export async function readCatalog(root) {
  const file = await readFile(join(root, 'catalog.json'));
  if (file.length > 256 * 1024) throw new Error('Catalog exceeds 256 KiB');
  return validateCatalog(JSON.parse(file));
}

export async function materialize(pack, root, work) {
  const source = pack.source;
  let directory = resolve(root, source.path);
  if (source.kind === 'github') {
    const repo = join(work, 'repositories', pack.id);
    await mkdir(repo, { recursive: true });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    const git = (...args) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', ...args], { cwd: repo, env, timeout: 120_000, maxBuffer: 1024 * 1024 });
    await git('init');
    await git('fetch', '--depth=1', '--no-tags', `https://github.com/${source.repository}.git`, source.ref);
    await git('checkout', '--detach', 'FETCH_HEAD');
    const { stdout } = await git('rev-parse', 'HEAD');
    if (stdout.trim() !== source.ref) throw new Error(`External commit mismatch: ${pack.id}`);
    directory = join(repo, source.path);
  }
  // Validate each ancestor; a symlink at the selected folder's parent can escape
  // the repository even if none of the pack's own descendants is a symlink.
  const repoRoot = source.kind === 'github' ? join(work, 'repositories', pack.id) : resolve(root);
  let ancestor = repoRoot;
  for (const part of source.path.split('/')) {
    ancestor = join(ancestor, part);
    if (!(await lstat(ancestor)).isDirectory()) throw new Error(`Pack path is not a regular directory: ${ancestor}`);
  }
  await validatePack(directory, pack.id);
  const dest = join(work, 'packs', pack.id);
  await mkdir(join(work, 'packs'), { recursive: true });
  await cp(directory, dest, { recursive: true, filter: path => !skipped.has(path.split(/[\\/]/).at(-1)) });
  return dest;
}
