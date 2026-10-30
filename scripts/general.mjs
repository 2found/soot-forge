import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { identifier, stableVersion } from './catalog.mjs';

// General is the default Soot every new Soot home starts with. Its definition lives in
// general/ and ships with each Forge release as two assets, next to the pack archives:
//   general-release_<v>.tar.gz  a soot/release-v1 archive of the definition, without packs
//   general-preset_<v>.json     the creation preset: which packs General installs and uses
// Both are deterministic: the same sources and version always give the same bytes.

const RELEASE_API = 'soot/release-v1';
const FORGE = '2found/soot-forge';
const PACKS_DIR = 'packs';
const SOOT = 'soots/general/soot.json';
// Source file in general/ -> path inside the release. The soot.json order is the manifest order.
const DEFINITION = [['soot.json', SOOT], ['SOUL.md', 'soots/general/SOUL.md'], ['mission.md', 'soots/general/mission.md']];
// A pack selection: a pack id, or `<id>:read` for its skills and read-mode tools only.
const selector = /^[a-z0-9][a-z0-9_-]{0,63}(:read)?$/;
const LEAD = 'nest-lead';

// The release's integer version. It must grow with the Forge version, so a client that
// compares integers never sees a newer Forge as older (the legacy baseline is 1).
export function deriveVersion(version) {
  const match = stableVersion.exec(version ?? '');
  if (!match) throw new Error(`General needs a stable SemVer version, got ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor >= 1000 || patch >= 1000) throw new Error(`General cannot derive a version from ${version}: minor and patch must be below 1000`);
  const derived = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(derived)) throw new Error(`General cannot derive a version from ${version}`);
  return derived;
}

function list(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length)
    throw new Error(`Invalid General preset ${label}`);
  return value;
}

// The creation preset must resolve against this repository alone: every pack it installs
// is in catalog.json and is fetched from this Forge release, including 2build.
export function validatePreset(preset, catalog) {
  const known = new Set(catalog.packs.map(pack => pack.id));
  if (!preset || typeof preset !== 'object' || Array.isArray(preset) || preset.version !== 1) throw new Error('Invalid General preset version');
  const install = list(preset.install, 'install');
  for (const id of install) if (!identifier.test(id) || !known.has(id)) throw new Error(`General preset installs ${id}, which is not in catalog.json`);
  const sources = preset.sources ?? {};
  for (const id of install) {
    if (sources[id]?.github_latest !== FORGE) throw new Error(`General preset must install ${id} from ${FORGE}`);
  }
  for (const [id, source] of Object.entries(sources)) {
    if (!install.includes(id) || !source || typeof source !== 'object' || Object.keys(source).length !== 1) throw new Error(`Invalid General preset source for ${id}`);
  }
  const packs = list(preset.packs, 'packs');
  const nest = preset.nest;
  if (!nest || typeof nest !== 'object') throw new Error('Invalid General preset nest');
  const nestPacks = list(nest.packs, 'nest.packs');
  // `common` is the runtime's built-in pack; everything else names an installed pack.
  for (const [label, group] of [['packs', packs], ['nest.packs', nestPacks]]) {
    for (const item of group) {
      if (!selector.test(item)) throw new Error(`Invalid General preset ${label} selection: ${item}`);
      const id = item.replace(/:read$/, '');
      if (id !== 'common' && !install.includes(id)) throw new Error(`General preset ${label} selects ${id}, which it does not install`);
    }
  }
  if (packs.some(item => item.replace(/:read$/, '') === LEAD)) throw new Error(`Only the default Soot may select ${LEAD}`);
  return preset;
}

export async function readGeneral(root, catalog) {
  const dir = join(root, 'general');
  const files = new Map();
  for (const [name, path] of DEFINITION) files.set(path, await readFile(join(dir, name)));
  const definition = JSON.parse(files.get(SOOT));
  if (definition.id !== 'general') throw new Error('general/soot.json must define the soot "general"');
  const preset = validatePreset(JSON.parse(await readFile(join(dir, 'preset.json'), 'utf8')), catalog);
  return { files, preset };
}

function octal(value, width) { return value.toString(8).padStart(width - 1, '0') + '\0'; }

// One ustar regular-file entry with no owner, time or name: the same bytes on every host.
function tarEntry(name, bytes) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Release path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(octal(0o600, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(bytes.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.fill(' ', 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

// Same field order as 2agent's configstate.Manifest; `files` keys sort like Go's map encoding.
function releaseManifest(version, files, preset) {
  const sorted = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) =>
    [path, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }]));
  return {
    api_version: RELEASE_API, id: 'general', version: deriveVersion(version), source_version: version,
    packs_dir: PACKS_DIR, soots: [SOOT], nest: { packs: preset.nest.packs }, files: sorted,
  };
}

export function releaseArchive(version, files, preset) {
  const manifest = releaseManifest(version, files, preset);
  const entries = [tarEntry('release.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))];
  for (const path of Object.keys(manifest.files)) entries.push(tarEntry(`files/${path}`, files.get(path)));
  const archive = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 });
  archive[9] = 255; // gzip OS field: unknown, so the bytes do not depend on the build host.
  return archive;
}

// Writes both General assets and returns their SHA256SUMS lines.
export async function buildGeneral(root, dist, version, catalog) {
  const { files, preset } = await readGeneral(root, catalog);
  const release = `general-release_${version}.tar.gz`, presetName = `general-preset_${version}.json`;
  const archive = releaseArchive(version, files, preset);
  const presetBytes = Buffer.from(JSON.stringify(preset, null, 2) + '\n');
  await writeFile(join(dist, release), archive);
  await writeFile(join(dist, presetName), presetBytes);
  const sum = bytes => createHash('sha256').update(bytes).digest('hex');
  return [`${sum(archive)}  ${release}`, `${sum(presetBytes)}  ${presetName}`];
}
