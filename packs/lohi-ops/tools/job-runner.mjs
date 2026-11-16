// Detached interpreter of a catalog job plan: `node tools/job-runner.mjs <job dir>` with cwd = the cli checkout.
// Reads <dir>/plan.json, runs its argv arrays without a shell (log appended to <dir>/log), writes <dir>/result.json and
// then <dir>/exit (its presence IS "finished"; catalog_jobs_pull reports the end from them). No network, no secret:
// the cli loads its own .env from its cwd.
import { spawn } from 'node:child_process';
import { promises as fsp, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPlan } from './lib/runner.mjs';
import { openReadOnly } from './lib/crawl.mjs';
import { countChapters, copyrightOf } from './lib/resolve.mjs';

const OUT_KEEP = 40_000;

/** Run one argv (never a shell), append its output to the log, answer {code, out}. */
export function execArgv(argv, { cwd, env, log, timeout_ms = 30 * 60_000 }) {
  return new Promise(resolve => {
    log.write(`\n$ ${argv.join(' ')}\n`);
    let out = '';
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = chunk => { log.write(chunk); out = (out + chunk).slice(-OUT_KEEP); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { keep(`\n[timeout after ${Math.round(timeout_ms / 60_000)} min]\n`); child.kill('SIGKILL'); }, timeout_ms);
    child.on('error', e => { clearTimeout(timer); resolve({ code: 127, out: `${out}\n${e.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

export async function main(dir, { env = process.env, cwd = process.cwd() } = {}) {
  const log = createWriteStream(join(dir, 'log'), { flags: 'a' });
  let result;
  try {
    const plan = JSON.parse(await fsp.readFile(join(dir, 'plan.json'), 'utf8'));
    const childEnv = { PATH: env.PATH, HOME: env.HOME, ...(env.CLI_CATALOG_DB ? { CLI_CATALOG_DB: env.CLI_CATALOG_DB, CATALOG_DB: env.CLI_CATALOG_DB } : {}) };
    // The catalog is opened only to read what the cli just wrote (chapter counts, the copyright flag), per call, so
    // the cli's own writes are visible.
    const dbPath = env.CLI_CATALOG_DB || join(cwd, 'data', 'catalog.db');
    const read = async fn => { const db = await openReadOnly(dbPath); try { return fn(db); } finally { try { db.close(); } catch { /* read-only */ } } };
    const io = {
      exec: (argv, o) => execArgv(argv, { cwd, env: childEnv, log, timeout_ms: o?.timeout_ms }),
      countChapters: (s, n, a, b) => read(db => countChapters(db, s, n, a, b)),
      copyright: (s, n) => read(db => copyrightOf(db, s, n)),
    };
    result = await runPlan(plan, io);
  } catch (e) {
    result = { state: 'failed', detail: `runner error: ${String(e?.message ?? e).slice(0, 300)}` };
  }
  log.end();
  await fsp.writeFile(join(dir, 'result.json'), JSON.stringify(result));
  await fsp.writeFile(join(dir, 'exit'), result.state === 'failed' ? '1\n' : '0\n');
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv[2]);
