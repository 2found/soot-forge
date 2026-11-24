// Detached runner: `node tools/runner.mjs <job dir>`. Runs one Claude Code session for the job, sends prompt.md on
// stdin, appends claude's stdout to log.jsonl and stderr to stderr.log, kills the session's process group when the
// timeout passes and writes exit.json (its presence IS "finished"). The Soot's tools only read the files.
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeEnv, killGroup, writeExit, iso } from './lib/jobs.mjs';

const dir = process.argv[2];
const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'));
const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
const logFd = openSync(join(dir, 'log.jsonl'), 'a');
const errFd = openSync(join(dir, 'stderr.log'), 'a');

const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', job.model, '--effort', job.effort];
let child;
try {
  child = spawn(job.claude_bin, args, { cwd: job.dir, env: claudeEnv(process.env), detached: true, stdio: ['pipe', logFd, errFd] });
} catch (e) {
  await writeExit(dir, { code: 127, signal: null, timed_out: false, error: `could not start claude: ${e.message}`.slice(0, 200), ended_at: iso(Date.now()) });
  process.exit(0);
}
closeSync(logFd); closeSync(errFd);

let timedOut = false, killTimer;
child.on('error', async e => {
  clearTimeout(timer);
  await writeExit(dir, { code: 127, signal: null, timed_out: false, error: `could not start claude: ${e.message}`.slice(0, 200), ended_at: iso(Date.now()) });
  process.exit(0);
});
if (child.pid) writeFileSync(join(dir, 'child.pid'), `${child.pid}\n`);
child.stdin.on('error', () => { /* claude closed its stdin early */ });
child.stdin.end(prompt);

const timer = setTimeout(() => {
  timedOut = true;
  killGroup(child.pid, 'SIGTERM');
  killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000);
}, job.timeout_ms);

child.on('close', async (code, signal) => {
  clearTimeout(timer); clearTimeout(killTimer);
  killGroup(child.pid, 'SIGKILL'); // whatever the session left behind
  await writeExit(dir, { code, signal, timed_out: timedOut, ended_at: iso(Date.now()) });
  process.exit(0);
});
