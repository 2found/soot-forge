// Mirrors the runtime's CompareStorage (2agent internal/config/pack_storage.go):
// a pack may only add tables or columns, and any change to its storage must
// raise storage.version. A runtime refuses a pack that breaks this with
// storage_incompatible and keeps the old version, so the release would never
// reach a host. Checked against the previous release tag, in CI and locally.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const columnKeys = ['name', 'type', 'description', 'required', 'index', 'search', 'principal', 'unique'];
const shape = tables => JSON.stringify((tables ?? []).map(t => ({
  name: t.name, ...(t.description ? {description: t.description} : {}),
  columns: (t.columns ?? []).map(c => Object.fromEntries(columnKeys.filter(k => c[k] !== undefined && c[k] !== false && c[k] !== '').map(k => [k, c[k]]))),
})));

export function compareStorage(prev, next) {
  if (!prev) return null;
  if (!next) return 'storage removed';
  const tables = new Map((next.tables ?? []).map(t => [t.name, t]));
  for (const old of prev.tables ?? []) {
    const t = tables.get(old.name);
    if (!t) return `table ${old.name} dropped`;
    const cols = new Map((t.columns ?? []).map(c => [c.name, c]));
    for (const oc of old.columns ?? []) {
      const c = cols.get(oc.name);
      if (!c) return `column ${old.name}.${oc.name} dropped`;
      if (c.unique && !oc.unique) return `${old.name}.${oc.name} made unique after rows may exist`;
      if (c.type !== oc.type) return `${old.name}.${oc.name} ${oc.type} → ${c.type}`;
    }
  }
  if (next.version <= prev.version && shape(prev.tables) !== shape(next.tables)) return `storage changed but version stayed ${prev.version}`;
  return null;
}

const git = (root, ...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();

// The newest release tag reachable from HEAD other than the source version's
// own tag (a tagged release commit compares against the release before it).
export function baseTag(root, version) {
  try { return git(root, 'describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', `v${version}`, 'HEAD'); }
  catch { return null; }
}

export async function storageRefusals(root, base, paths) {
  const out = [];
  for (const path of paths) {
    const next = JSON.parse(await readFile(join(root, path, 'pack.json'), 'utf8')).storage;
    let prev;
    try { prev = JSON.parse(git(root, 'show', `${base}:${path}/pack.json`)).storage; } catch { continue; } // new pack
    const why = compareStorage(prev, next);
    if (why) out.push(`${path}: ${why} (against ${base}); raise storage.version and only add tables or columns`);
  }
  return out;
}
