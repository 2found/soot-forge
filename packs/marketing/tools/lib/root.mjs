// The marketing library on disk: MARKETING_ROOT, a folder the operator names in
// Nest (an optional `from: operator` credential). Every path a tool reads or
// writes is relative to it and checked twice: lexically (no absolute path, no
// `..`, no NUL, no dot segment) and on disk (the real path of the target, or of
// its nearest existing parent, stays inside the real root), so a symlink that
// points out of the root is refused like `..`. Walks skip dot-dirs and
// node_modules. Node built-ins only.
import { realpath, lstat, readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { join, sep, isAbsolute, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MarketingError } from './store.mjs';

const refuse = (message) => { throw new MarketingError('path_refused', message); };
const SKIP = new Set(['node_modules']);
/** A dot-dir or node_modules is never part of the library. */
const skipped = (name) => name.startsWith('.') || SKIP.has(name);

/** The library root, or why there is none: `{ok, root}` | `{ok:false, error}`. Never throws. */
export async function libraryRoot(env) {
  const raw = typeof env?.MARKETING_ROOT === 'string' ? env.MARKETING_ROOT.trim() : '';
  if (!raw) return { ok: false, error: 'not_configured' };
  if (!isAbsolute(raw) || raw.includes('\0')) return { ok: false, error: 'invalid' };
  try {
    const root = await realpath(raw);
    if (!(await stat(root)).isDirectory()) return { ok: false, error: 'invalid' };
    return { ok: true, root };
  } catch {
    return { ok: false, error: 'missing' };
  }
}

/** Whose folder the library is: 'team' when MARKETING_ROOT is the folder the host keeps for the team (the pack's
 *  "team_folder" default: <data>/team-folders/<team>/MARKETING_ROOT, or soot-folders/<soot>/… for a Soot in no
 *  team), a hidden folder the founder's file picker does not show; 'chosen' for a folder the founder picked; null
 *  when none is set. Read from the bound path itself: the host passes no other sign of the default. */
export function rootKind(env) {
  const raw = typeof env?.MARKETING_ROOT === 'string' ? env.MARKETING_ROOT.trim() : '';
  if (!raw) return null;
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const n = parts.length;
  return n >= 3 && parts[n - 1] === 'MARKETING_ROOT' && ['team-folders', 'soot-folders'].includes(parts[n - 3]) ? 'team' : 'chosen';
}

/** Lexical check of a library-relative path; returns its clean segments. */
export function segments(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 512) refuse('A library path is a relative path of at most 512 characters.');
  if (rel.includes('\0') || rel.includes('\\') || isAbsolute(rel)) refuse(`"${rel}" is not a relative library path.`);
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '..') refuse(`"${rel}" leaves the library (..).`);
    if (p === '' || p === '.') refuse(`"${rel}" has an empty or "." segment.`);
  }
  return parts;
}

const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The absolute path of `rel` under `root`, refused when it or a parent resolves outside the root. */
export async function resolveInside(root, rel) {
  const parts = segments(rel);
  // The deepest part that exists decides: its real path must stay inside.
  for (let i = parts.length; i >= 0; i--) {
    const probe = join(root, ...parts.slice(0, i));
    let real;
    try {
      real = await realpath(probe);
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw new MarketingError('library_unreadable', `Cannot read ${rel}.`);
      // A dangling link on the way is refused: realpath fails on it, lstat still sees the link.
      const link = await lstat(probe).then(s => s.isSymbolicLink(), () => false);
      if (link) refuse(`"${rel}" goes through a broken link.`);
      continue;
    }
    if (!inside(root, real)) refuse(`"${rel}" resolves outside the library.`);
    return i === parts.length ? real : join(real, ...parts.slice(i));
  }
  refuse(`"${rel}" resolves outside the library.`);
}

/** Read a UTF-8 file of the library (at most `max` bytes, else refused). */
export async function readText(root, rel, max = 512 * 1024) {
  const path = await resolveInside(root, rel);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw new MarketingError('not_found', `${rel} is not a file of the library.`);
  if (st.size > max) throw new MarketingError('too_large', `${rel} is over ${max} bytes.`);
  return readFile(path, 'utf8');
}

/** Write a UTF-8 file atomically (temp file + rename) under the root, making missing folders inside it. */
export async function writeText(root, rel, text) {
  const parts = segments(rel);
  if (parts.some(skipped)) refuse(`"${rel}" is inside a dot-folder or node_modules.`);
  // Each folder is made one level at a time and re-checked, so a link planted on the way cannot redirect it.
  let dir = root;
  for (const p of parts.slice(0, -1)) {
    dir = join(dir, p);
    try { await mkdir(dir); } catch (e) { if (e?.code !== 'EEXIST') throw new MarketingError('library_unwritable', `Cannot make ${p}.`); }
    const real = await realpath(dir);
    if (!inside(root, real)) refuse(`"${rel}" resolves outside the library.`);
  }
  const target = join(dir, parts.at(-1));
  try { if ((await lstat(target)).isSymbolicLink()) refuse(`"${rel}" is a link; the library writes only plain files.`); } catch (e) { if (e instanceof MarketingError) throw e; }
  const tmp = join(dir, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { mode: 0o644, flag: 'wx' });
    await rename(tmp, target);
  } catch (e) {
    throw new MarketingError('library_unwritable', `Cannot write ${rel}.`);
  }
  return target;
}

/** Whether a library file exists (inside the root). */
export async function exists(root, rel) {
  try { return !!(await stat(await resolveInside(root, rel))); } catch (e) { if (e instanceof MarketingError && e.code === 'path_refused') throw e; return false; }
}

/** When a library file or folder last changed (ISO), or null. A folder changes when an entry is added or removed. */
export async function mtimeOf(root, rel) {
  try { return (await stat(await resolveInside(root, rel))).mtime.toISOString(); } catch (e) { if (e instanceof MarketingError && e.code === 'path_refused') throw e; return null; }
}

/** List one folder: [{name, dir}] without dot-entries, node_modules or links that leave the root. */
export async function list(root, rel = '') {
  const path = rel ? await resolveInside(root, rel) : root;
  const out = [];
  let entries = [];
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (skipped(d.name)) continue;
    let dir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        const real = await realpath(join(path, d.name));
        if (!inside(root, real)) continue;
        dir = (await stat(real)).isDirectory();
      } catch { continue; }
    }
    out.push({ name: d.name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

