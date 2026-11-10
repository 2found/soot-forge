import {readlink, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {hostname} from 'node:os';

// An agent-browser daemon used to live forever (idle timeout 0), so one left
// behind by a moved or retired runtime kept Chromium's SingletonLock on a
// Soot's persistent profile and every browser step failed with an unrelated
// message. A daemon now ends after it has been idle for a while; a host may
// change that, or ask for none, with SOOT_BROWSER_IDLE_TIMEOUT_MS.
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** The idle timeout (ms) for a daemon; 0 means never, only when asked for explicitly. */
export function idleTimeoutMs(value = process.env.SOOT_BROWSER_IDLE_TIMEOUT_MS) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,9}$/.test(text)) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(Number(text), MAX_IDLE_TIMEOUT_MS);
}

const SINGLETON = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * Who holds a Chromium profile: Chromium's SingletonLock is a symlink whose
 * target is `<hostname>-<pid>`. Returns null when no one does. A lock whose
 * process is gone is removed (the three Singleton links), as Chromium itself
 * does on start, and reads as free.
 */
export async function profileOwner(profile, {host = hostname(), alive = pidAlive, readLink = readlink, remove = rm} = {}) {
  let target;
  try { target = await readLink(join(profile, 'SingletonLock')); } catch { return null; }
  const m = /^(.+)-([0-9]+)$/.exec(String(target));
  if (!m) return null;
  const pid = Number(m[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (m[1] === host && !alive(pid)) {
    for (const name of SINGLETON) await remove(join(profile, name), {force: true});
    return null;
  }
  return {pid, host: m[1], foreign: m[1] !== host};
}

/** True when a process exists (it may belong to another user). */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const SESSION = /^(sootp|sootn|soot)-([0-9a-f]{12})-(.+)$/;

/** Sessions of another runtime that name the same browser (same kind and id). */
export function siblingSessions(listed, session) {
  const own = SESSION.exec(session);
  if (!own) return [];
  return listed.filter(name => {
    const m = SESSION.exec(name);
    return m && name !== session && m[1] === own[1] && m[3] === own[3];
  });
}

/** The names `agent-browser session list --json` reports. */
export function sessionNames(listedResult) {
  return (listedResult?.data?.sessions || []).map(s => typeof s === 'string' ? s : s?.name || s?.session).filter(n => typeof n === 'string');
}

/** The refusal for a profile another process holds. Nothing is ever killed. */
export function profileInUse(label, owner, others) {
  const where = owner.foreign ? ` on host ${owner.host}` : '';
  const how = others.length
    ? `Close it with: ${others.map(n => `agent-browser --session ${n} close`).join(' ; ')} (that ends only that browser), then retry.`
    : owner.foreign
      ? 'That host must close its browser; if the profile folder was copied here, remove its SingletonLock, SingletonSocket and SingletonCookie links.'
      : `No browser session of this runtime owns it. Find the process (ps -p ${owner.pid}) and quit that browser yourself, then retry. Nothing was stopped automatically.`;
  return new Error(`browser_profile_in_use: ${label} is open in another browser process (pid ${owner.pid}${where}), so this runtime cannot use it and nothing ran. ${how}`);
}

/**
 * Refuse before launching when another process holds the profile. Owned by
 * this runtime means its daemon (`session`) is running; anything else alive is
 * foreign. A session list that cannot be read does not block: the launch then
 * reports its own failure.
 */
export async function assertProfileFree({profile, session, label}, {listSessions, ...deps} = {}) {
  const owner = await profileOwner(profile, deps);
  if (!owner) return;
  let names;
  try { names = await listSessions(); } catch { return; }
  if (names.includes(session)) return;
  throw profileInUse(label, owner, siblingSessions(names, session));
}
