// The `bbs` CLI (2build), the only way this pack touches the coding side: record a
// week in the company baseline, spawn a team, read a team's snapshot. It never
// calls land, release, integrate or seal; the founder's release go stays in bbs:team.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const exe = f => { try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; } };

/** BBS_BIN, else `bbs` on PATH, else ~/.local/bin/bbs. Null when none is runnable. */
export function findBbs(env) {
  if (env.BBS_BIN) return isAbsolute(env.BBS_BIN) && exe(env.BBS_BIN) ? env.BBS_BIN : null;
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) if (exe(join(dir, 'bbs'))) return join(dir, 'bbs');
  return env.HOME && exe(join(env.HOME, '.local', 'bin', 'bbs')) ? join(env.HOME, '.local', 'bin', 'bbs') : null;
}

/** The environment bbs (and the agent it opens) inherits: never the product key, the CS token or this pack's storage grant. */
export const bbsEnv = env => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(PRODUCT_|CS_RUNTIME_|SOOT_STORAGE_)/.test(k)));

/** Run bbs once: {missing:true} or {ok, code, stdout, stderr}. Never throws. */
export function runBbs(env, args, { cwd, timeoutMs = 60_000 } = {}) {
  const bin = findBbs(env);
  if (!bin) return Promise.resolve({ missing: true });
  return new Promise(resolve => {
    execFile(bin, args, { cwd, env: bbsEnv(env), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
    });
  });
}

/** The single-quoted form of a shell word. */
export const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
