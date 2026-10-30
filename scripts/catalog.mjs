import { lstat, readdir, readFile, cp, mkdir } from 'node:fs/promises';
import { resolve, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';

export const run = promisify(execFile);
export const identifier = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const repoName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const commit = /^[0-9a-f]{40}$/;
export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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
  keys(catalog, ['version', 'repository', 'packs', 'retired'], 'catalog');
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
    keys(source, source?.kind === 'bundled' ? ['kind', 'path'] : ['kind', 'repository', 'path', 'ref', 'version'], 'source');
    safePath(source.path);
    if (source.kind === 'bundled') {
      if (source.path !== `packs/${pack.id}`) throw new Error(`Bundled pack ${pack.id} must live at packs/${pack.id}`);
    } else if (source.kind === 'github') {
      if (typeof source.repository !== 'string' || !repoName.test(source.repository) ||
          source.repository.endsWith('.git') || typeof source.ref !== 'string' || !commit.test(source.ref))
        throw new Error(`External pack ${pack.id} requires owner/repo and a full lowercase commit`);
      // The upstream release the pinned commit belongs to, as bare SemVer (tag v<version>).
      // Installers compare it with a receipt's version; materialize() proves the tag points at ref.
      if (typeof source.version !== 'string' || !stableVersion.test(source.version))
        throw new Error(`External pack ${pack.id} requires source.version as a stable SemVer such as 1.2.3`);
    } else throw new Error(`Unknown source kind for ${pack.id}`);
  }
  validateRetired(catalog.retired ?? [], ids);
  return catalog;
}

// A retired pack was merged into a listed one. Installers move every grant of
// <id> and <id>_<tool> onto the pack and the tool names mapped here, then remove
// the old copy; a tool left out of the map keeps its name.
function validateRetired(retired, ids) {
  if (!Array.isArray(retired) || retired.length > 64) throw new Error('Invalid retired list');
  const seen = new Set();
  for (const entry of retired) {
    keys(entry, ['id', 'into', 'tools'], 'retired entry');
    if (typeof entry.id !== 'string' || !identifier.test(entry.id) || ids.has(entry.id) || seen.has(entry.id))
      throw new Error(`Retired pack ${entry.id} must be a unique id no longer listed`);
    seen.add(entry.id);
    if (!ids.has(entry.into)) throw new Error(`Retired pack ${entry.id} must merge into a listed pack`);
    const map = entry.tools ?? {};
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 64 ||
        Object.entries(map).some(([from, to]) => !identifier.test(from) || typeof to !== 'string' || !identifier.test(to)))
      throw new Error(`Invalid tools map for retired pack ${entry.id}`);
  }
}

// Every tool a retired entry maps to exists in the pack it merged into.
export function checkRetiredTarget(entry, manifest) {
  const tools = new Set((manifest.tools ?? []).map(tool => tool.name));
  for (const to of Object.values(entry.tools ?? {}))
    if (!tools.has(to)) throw new Error(`Retired pack ${entry.id}: ${entry.into} has no tool ${to}`);
}

// `git ls-remote --tags` output for refs/tags/v<version>{,^{}}: the peeled (^{}) line of an
// annotated tag holds the commit; a lightweight tag lists the commit directly.
export function tagCommit(lsRemote, version) {
  const tag = `refs/tags/v${version}`;
  const rows = lsRemote.split('\n').map(line => line.trim().split(/\s+/)).filter(([, name]) => name === tag || name === `${tag}^{}`);
  return (rows.find(([, name]) => name.endsWith('^{}')) ?? rows[0])?.[0];
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

const envName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const credName = /^[A-Z][A-Z0-9_]{0,63}$/;
const credUse = /\{\{cred:([A-Z][A-Z0-9_]*)\}\}/g;
// A tool whose name says it changes something outside the conversation cannot be a read.
const writeVerb = /(^|_)(create|save|send|publish|delete|remove|unshare|upload|write|edit|update|append|post|deploy|revoke|mint|setup|export|download|convert|render|generate|synthesize|compose|assemble|prepare|action|manage|configure|record|handoff|upsert|mark|scan|queue|react|expert|stimulus|control)(_|$)/;

// The model a pack must satisfy beyond the schema: skills and tools are unique and
// exist, every executable tool declares its mode, every {{cred:NAME}} is declared in
// needs.credentials and every declared one is used, and tools never set run.env.
export function checkPackModel(manifest, expectedID) {
  const problems = [];
  const skills = new Set(), tools = new Set(), used = new Set();
  for (const skill of manifest.skills ?? []) {
    const name = skill.name || `${expectedID}_${posix.basename(skill.file, posix.extname(skill.file))}`;
    if (!identifier.test(name) || skills.has(name)) problems.push(`Invalid or duplicate skill: ${name}`);
    skills.add(name);
  }
  for (const tool of manifest.tools ?? []) {
    if (!identifier.test(tool.name) || tools.has(tool.name)) problems.push(`Invalid or duplicate tool: ${tool.name}`);
    tools.add(tool.name);
    const run = tool.run;
    if (!run) continue;
    if (!['read', 'write', 'repair'].includes(run.mode)) problems.push(`Tool ${tool.name} must declare run.mode read, write or repair`);
    else if (run.mode === 'read' && writeVerb.test(tool.name)) problems.push(`Tool ${tool.name} is named like a change but declares run.mode read`);
    if (!identifier.test(run.resource || `${expectedID}_${tool.name}`)) problems.push(`Tool ${tool.name} has an invalid resource`);
    if (run.env?.length) problems.push(`Tool ${tool.name} sets run.env; inherited names belong to needs.env`);
    for (const ref of Object.values(run.secret_env ?? {})) for (const match of ref.matchAll(credUse)) used.add(match[1]);
  }
  const needs = manifest.needs ?? {};
  const declared = new Set(Object.keys(needs.credentials ?? {}));
  for (const name of used) if (!declared.has(name)) problems.push(`Credential ${name} is used by a tool but not declared in needs.credentials`);
  for (const [name, need] of Object.entries(needs.credentials ?? {})) {
    if (!credName.test(name)) problems.push(`Invalid credential name: ${name}`);
    if (!used.has(name)) problems.push(`Credential ${name} is declared but no tool reads {{cred:${name}}}`);
    const from = need.from ?? 'operator';
    if (!['operator', 'workspace', 'data_pool'].includes(from) && !(from.startsWith('env:') && envName.test(from.slice(4))))
      problems.push(`Credential ${name} has an unknown source: ${from}`);
    if (!need.title || !need.description) problems.push(`Credential ${name} needs a title and a description for the person who supplies it`);
    if ([...(need.title ?? '')].length > 80 || [...(need.description ?? '')].length > 500) problems.push(`Credential ${name}: title is at most 80 and description at most 500 characters`);
  }
  for (const [index, name] of (needs.env ?? []).entries())
    if (!envName.test(name) || needs.env.indexOf(name) !== index) problems.push(`Invalid or duplicate needs.env name: ${name}`);
  const area = manifest.interface?.tool_area;
  if (area) {
    const byName = new Map((manifest.tools ?? []).map(tool => [tool.name, tool]));
    if (area.view_tool && byName.get(area.view_tool)?.run?.mode !== 'read') problems.push(`Interface view_tool ${area.view_tool} must be a read tool of the pack`);
    if (area.action_tool && !byName.has(area.action_tool)) problems.push(`Interface action_tool ${area.action_tool} is not a tool of the pack`);
  }
  if (problems.length) throw new Error(`Pack ${expectedID}: ${problems.join('; ')}`);
}

export async function validatePack(root, expectedID) {
  await validateTree(root);
  const raw = await readFile(join(root, 'pack.json'));
  if (raw.length > 64 * 1024) throw new Error('Pack manifest exceeds 64 KiB');
  const manifest = JSON.parse(raw);
  if (!checkManifest(manifest)) throw new Error(`Invalid pack manifest: ${JSON.stringify(checkManifest.errors)}`);
  if (manifest.api_version !== 'soot/v1' || manifest.id !== expectedID) throw new Error(`Pack manifest id/version mismatch: ${expectedID}`);
  for (const retired of ['capabilities', 'use']) if (retired in manifest) throw new Error(`Pack ${expectedID} has retired field ${retired}`);
  checkPackModel(manifest, expectedID);
  for (const skill of manifest.skills ?? []) {
    safePath(skill.file);
    const info = await lstat(join(root, skill.file));
    if (!info.isFile() || info.size > 128 * 1024) throw new Error(`Missing/oversized skill: ${skill.file}`);
  }
  for (const tool of manifest.tools ?? []) {
    if (!tool.run) continue;
    safePath(tool.run.program);
    if (tool.run.directory && tool.run.directory !== '.') safePath(tool.run.directory);
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
    const tags = await git('ls-remote', '--tags', `https://github.com/${source.repository}.git`, `refs/tags/v${source.version}`, `refs/tags/v${source.version}^{}`);
    if (tagCommit(tags.stdout, source.version) !== source.ref)
      throw new Error(`External ${pack.id}: tag v${source.version} does not point at pinned commit ${source.ref}`);
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
