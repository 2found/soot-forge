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
  const byName = new Map((manifest.tools ?? []).map(tool => [tool.name, tool]));
  for (const area of [manifest.interface?.tool_area, ...(manifest.interface?.tool_areas ?? [])].filter(Boolean)) {
    if (area.view_tool && byName.get(area.view_tool)?.run?.mode !== 'read') problems.push(`Interface view_tool ${area.view_tool} must be a read tool of the pack`);
    if (area.action_tool && !byName.has(area.action_tool)) problems.push(`Interface action_tool ${area.action_tool} is not a tool of the pack`);
  }
  problems.push(...checkPresentation(manifest, byName));
  if (problems.length) throw new Error(`Pack ${expectedID}: ${problems.join('; ')}`);
}

const pageID = /^[a-z][a-z0-9-]{1,47}$/;
const programID = /^[a-z][a-z0-9-]{1,31}$/;
const bundleDir = /^[A-Za-z0-9._/-]{1,256}\/$/;
// LocalizedText (pack-manifest-ui): a string or {vi, en?}, each at most max characters.
export function localizedText(value, max) {
  const ok = v => typeof v === 'string' && v.trim() !== '' && [...v].length <= max && !/[\x00-\x1f\x7f]/.test(v);
  if (typeof value === 'string') return ok(value);
  return !!value && typeof value === 'object' && !Array.isArray(value) && ok(value.vi) &&
    (value.en === undefined || ok(value.en)) && Object.keys(value).every(key => key === 'vi' || key === 'en');
}

// soot-pages §1 and pack-manifest-ui §1: pages and programs name tools of the
// pack with the right mode, so the host refusal (page_invalid) never reaches an
// installed pack. Presentation only: none of this grants an operation.
function checkPresentation(manifest, byName) {
  const problems = [];
  if (manifest.label !== undefined && !localizedText(manifest.label, 48)) problems.push('label must be a string or {vi, en?} of at most 48 characters');
  if (typeof manifest.description === 'object' && !localizedText(manifest.description, 280)) problems.push('description must be a string or {vi, en?} of at most 280 characters');
  for (const lang of ['vi', 'en']) {
    const words = manifest.keywords?.[lang];
    if (words !== undefined && !(Array.isArray(words) && words.length <= 16 && words.every(w => typeof w === 'string' && w.trim() !== '' && [...w].length <= 32))) problems.push(`keywords.${lang} must be at most 16 words of at most 32 characters`);
  }
  if (manifest.keywords !== undefined && Object.keys(manifest.keywords ?? {}).some(key => key !== 'vi' && key !== 'en')) problems.push('keywords holds only vi and en');
  for (const area of [manifest.interface?.tool_area, ...(manifest.interface?.tool_areas ?? [])].filter(Boolean)) {
    const c = area.capabilities;
    if (c === undefined) continue;
    if (!['none', 'pointer', 'keyboard', 'full', undefined].includes(c.input) || !['none', 'websocket', undefined].includes(c.stream) || !['none', 'frames', undefined].includes(c.pacing)) problems.push(`Tool area ${area.id}: unsupported capabilities`);
    if (area.stream !== undefined && c.stream !== undefined && area.stream !== c.stream) problems.push(`Tool area ${area.id}: stream and capabilities.stream disagree`);
  }
  // channel.platforms (pack-manifest-ui §2), mirroring the host's
  // ChannelPlatform.validate and DecodePlatformUI, so a refused declaration
  // never reaches an installed pack.
  const platforms = new Set();
  for (const pl of manifest.channel?.platforms ?? []) {
    const at = `Platform ${pl?.id}`;
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(pl?.id ?? '') || pl.id === 'web' || platforms.has(pl.id)) problems.push(`${at}: invalid or duplicate id`);
    platforms.add(pl?.id);
    if (!['supervised', 'remote'].includes(pl?.mode)) problems.push(`${at}: mode must be supervised or remote`);
    const prefix = /^[a-z][a-z0-9]{1,15}$/;
    if (pl?.request_prefix != null ? !prefix.test(pl.request_prefix) : !prefix.test(pl?.id ?? '')) problems.push(`${at}: request_prefix must be ^[a-z][a-z0-9]{1,15}$ (required when the id is not one)`);
    const ui = pl?.ui;
    if (ui === undefined) continue;
    const allowed = (o, names) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => names.includes(k));
    if (!allowed(ui, ['label', 'icon', 'guide', 'fields', 'errors'])) { problems.push(`${at}: ui holds only label, icon, guide, fields, errors`); continue; }
    if (!localizedText(ui.label, 48) || !/^[a-z0-9-]{1,64}$/.test(ui.icon ?? '')) problems.push(`${at}: ui needs a label and a lowercase icon name`);
    if (ui.guide !== undefined && !(Array.isArray(ui.guide) && ui.guide.length <= 12 && ui.guide.every(g => localizedText(g, 280)))) problems.push(`${at}: ui.guide is at most 12 localized steps`);
    const keys = new Set();
    if (ui.fields !== undefined && !(Array.isArray(ui.fields) && ui.fields.length <= 12)) problems.push(`${at}: ui.fields is at most 12 fields`);
    for (const f of Array.isArray(ui.fields) ? ui.fields : []) {
      if (!allowed(f, ['key', 'label', 'kind', 'help']) || !/^[a-z][a-z0-9_]{0,47}$/.test(f.key ?? '') || keys.has(f.key) || !['secret', 'text'].includes(f.kind) || !localizedText(f.label, 48) || (f.help !== undefined && !localizedText(f.help, 280))) problems.push(`${at}: ui field ${f?.key}: unique key, kind secret or text, with a label`);
      keys.add(f?.key);
    }
    if (ui.errors !== undefined && !(allowed(ui.errors, Object.keys(ui.errors ?? {})) && Object.entries(ui.errors).every(([code, text]) => /^[a-z][a-z0-9_]{0,63}$/.test(code) && localizedText(text, 400)))) problems.push(`${at}: ui.errors maps lowercase codes to localized text`);
  }
  const pages = new Set();
  for (const page of manifest.interface?.pages ?? []) {
    const at = `Page ${page.id}`;
    if (!pageID.test(page.id ?? '')) problems.push(`${at}: invalid id`);
    else if (pages.has(page.id)) problems.push(`${at}: duplicate_id`);
    pages.add(page.id);
    if (!localizedText(page.label, 48)) problems.push(`${at}: label must be a string or {vi, en?} of at most 48 characters`);
    if (!/^[a-z0-9-]{1,64}$/.test(page.icon ?? '')) problems.push(`${at}: icon must be a lowercase icon name`);
    if (!['rail', 'data', 'settings'].includes(page.placement)) problems.push(`${at}: unknown_placement ${page.placement}`);
    if (!['operator', 'member'].includes(page.access)) problems.push(`${at}: access must be operator or member`);
    if (page.settings_group !== undefined && (page.placement !== 'settings' || !['server', 'soot'].includes(page.settings_group))) problems.push(`${at}: settings_group is server or soot, only on a settings page`);
    if (typeof page.bundle !== 'string' || !bundleDir.test(page.bundle)) problems.push(`${at}: bundle must be a pack folder ending in /`);
    const view = byName.get(page.view_tool);
    if (!view?.run) problems.push(`${at}: tool_missing view_tool ${page.view_tool}`);
    else if (view.run.mode !== 'read') problems.push(`${at}: view_not_read ${page.view_tool}`);
    else if (view.run.stdin !== 'context') problems.push(`${at}: stdin_not_context ${page.view_tool}`);
    if (page.provides !== undefined && !(Array.isArray(page.provides) && page.provides.length <= 8 && page.provides.every(c => typeof c === 'string' && pageID.test(c)))) problems.push(`${at}: provides is at most 8 capability names`);
    if (page.action_tool !== undefined) {
      const action = byName.get(page.action_tool);
      if (!action?.run) problems.push(`${at}: tool_missing action_tool ${page.action_tool}`);
      else if (action.run.stdin !== 'context') problems.push(`${at}: stdin_not_context ${page.action_tool}`);
    }
  }
  // outcomes (host config.validateOutcomes): what a finished unit of work is.
  const outcomes = new Set();
  if ((manifest.outcomes ?? []).length > 32) problems.push('at most 32 outcomes');
  for (const [i, o] of (manifest.outcomes ?? []).entries()) {
    const at = `Outcome ${o?.id ?? i}`;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(o?.id ?? '') || outcomes.has(o.id)) problems.push(`${at}: invalid or duplicate id`);
    outcomes.add(o?.id);
    if (!localizedText(o?.label, 80)) problems.push(`${at}: label needs vi text`);
    if (typeof o?.unit !== 'string' || !o.unit.trim() || o.unit.length > 32) problems.push(`${at}: unit is 1..32 characters`);
    if (o?.void_window !== undefined && !(/^(\d+h)?(\d+m)?(\d+s)?$/.test(o.void_window) && o.void_window !== '')) problems.push(`${at}: void_window is a duration such as 72h`);
    if (o?.void_on !== undefined && o.void_on !== 'binding_activity') problems.push(`${at}: void_on is binding_activity`);
  }
  const programs = new Set();
  for (const program of manifest.programs ?? []) {
    const at = `Program ${program.id}`;
    if (!programID.test(program.id ?? '') || programs.has(program.id)) problems.push(`${at}: invalid or duplicate id`);
    programs.add(program.id);
    if (!localizedText(program.label, 48)) problems.push(`${at}: label must be a string or {vi, en?} of at most 48 characters`);
    if (!Number.isInteger(program.size_mb) || program.size_mb < 0 || program.size_mb > 100000) problems.push(`${at}: size_mb must be a whole number of MB`);
    if (byName.get(program.check_op)?.run?.mode !== 'read') problems.push(`${at}: check_op ${program.check_op} must be a read tool of the pack`);
    const install = byName.get(program.install_op)?.run?.mode;
    if (install !== 'write' && install !== 'repair') problems.push(`${at}: install_op ${program.install_op} must be a write tool of the pack`);
  }
  return problems;
}

// A page bundle is a pack folder holding index.html, at most 5 MiB (soot-pages §1).
export async function checkPageBundles(root, manifest) {
  for (const page of manifest.interface?.pages ?? []) {
    const folder = safePath(page.bundle.replace(/\/$/, ''));
    let bytes = 0;
    async function size(path) {
      const info = await lstat(path);
      if (info.isFile()) { bytes += info.size; return; }
      for (const name of await readdir(path)) if (!skipped.has(name)) await size(join(path, name));
    }
    const index = await lstat(join(root, folder, 'index.html')).catch(() => null);
    if (!index?.isFile()) throw new Error(`Page ${page.id}: bundle_missing ${page.bundle}index.html`);
    await size(join(root, folder));
    if (bytes > 5 * 1024 * 1024) throw new Error(`Page ${page.id}: bundle_too_large (${bytes} bytes; at most 5 MiB)`);
  }
}

export async function validatePack(root, expectedID) {
  await validateTree(root);
  const raw = await readFile(join(root, 'pack.json'));
  if (raw.length > 16 * 1024 * 1024) throw new Error('Pack manifest exceeds 16 MiB');
  const manifest = JSON.parse(raw);
  if (!checkManifest(manifest)) throw new Error(`Invalid pack manifest: ${JSON.stringify(checkManifest.errors)}`);
  if (manifest.api_version !== 'soot/v1' || manifest.id !== expectedID) throw new Error(`Pack manifest id/version mismatch: ${expectedID}`);
  for (const retired of ['capabilities', 'use']) if (retired in manifest) throw new Error(`Pack ${expectedID} has retired field ${retired}`);
  checkPackModel(manifest, expectedID);
  await checkPageBundles(root, manifest);
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
