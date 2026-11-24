// claude-code: a fake `claude` (CLAUDE_BIN) stands in for the real one. Its behavior is chosen by `FAKE:` lines in the
// prompt, because the session's environment is an allowlist and carries nothing else.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../tools/cc.mjs';
import { pidAlive } from '../tools/lib/jobs.mjs';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'cc.mjs');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-test-')));
after(() => { rmSync(base, { recursive: true, force: true }); });

const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process');
const here = __dirname;
(async () => {
  let prompt = '';
  for await (const c of process.stdin) prompt += c;
  fs.writeFileSync(path.join(here, 'dump.json'), JSON.stringify({ env: process.env, argv: process.argv.slice(2), cwd: process.cwd(), prompt }));
  const has = s => prompt.includes('FAKE:' + s);
  const out = o => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } });
  const resultPath = (/to (\\S+result\\.json)\\./.exec(prompt) || [])[1];
  if (has('hang')) {
    const g = cp.spawn('sleep', ['300'], { stdio: 'ignore' }); // a grandchild in the same group
    fs.writeFileSync(path.join(here, 'grandchild.pid'), String(g.pid));
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'still going' }] } });
    setInterval(() => {}, 1000);
    return;
  }
  if (has('fail')) { console.error('boom: the model is unavailable'); process.exit(3); }
  const wait = /FAKE:sleep=(\\d+)/.exec(prompt); if (wait) await new Promise(r => setTimeout(r, Number(wait[1])));
  if (has('nores')) {} else if (has('bad')) fs.writeFileSync(resultPath, 'not json');
  else if (has('okfalse')) fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: 'no footage' }));
  else { const r = /RESULT: (\\{.*\\})/.exec(prompt); fs.writeFileSync(resultPath, r ? r[1] : '{"done":true}'); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } });
  out({ type: 'result', subtype: 'success', total_cost_usd: 0.1, num_turns: 3, usage: { input_tokens: 5, output_tokens: 7 } });
})();
`;

/** A fresh sandbox: allowed root, state dir, a fake claude and the operator env. */
let n = 0;
function sandbox(extra = {}) {
  const root = join(base, `case${++n}`);
  const allowed = join(root, 'allowed'), work = join(allowed, 'work'), state = join(root, 'state'), bin = join(root, 'bin');
  for (const d of [work, state, bin]) mkdirSync(d, { recursive: true });
  const claude = join(bin, 'claude');
  writeFileSync(claude, FAKE); chmodSync(claude, 0o755);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, SOOT_PACK_STATE: state, CLAUDE_BIN: claude, CLAUDE_CODE_DIRS: allowed,
    // everything a session must never see
    ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_AUTH_TOKEN: 'tok-secret', SOOT_RUNTIME_TOKEN: 'rt-secret', PRODUCT_ADMIN_KEY: 'pk-secret',
    GITHUB_TOKEN: 'gh-secret', SOOT_PROJECT: 'x', ...extra,
  };
  return { root, allowed, work, state, bin, claude, env, dump: () => JSON.parse(readFileSync(join(bin, 'dump.json'), 'utf8')) };
}
const call = (sb, name, input, deps = {}) => run(name, { input }, { env: sb.env, ...deps });
const brief = (extra = '') => ({ key: 'video-1', title: 'Make the video', prompt: `Make a video.\n${extra}`.trim() });
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail('timed out waiting for the condition');
    await new Promise(r => setTimeout(r, 40));
  }
}
const finished = (sb, id) => until(() => existsSync(join(sb.state, 'jobs', id, 'exit.json')));

test('a dir outside CLAUDE_CODE_DIRS, or reached through a symlink out of it, is refused', async () => {
  const sb = sandbox();
  const outside = join(sb.root, 'outside'); mkdirSync(outside);
  await assert.rejects(call(sb, 'start', { ...brief(), dir: outside }), { code: 'dir_not_allowed' });
  await assert.rejects(call(sb, 'start', { ...brief(), dir: join(sb.allowed, '..') }), { code: 'dir_not_allowed' });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(outside, join(sb.allowed, 'link'));
  await assert.rejects(call(sb, 'start', { ...brief(), dir: join(sb.allowed, 'link') }), { code: 'dir_not_allowed' });
  await assert.rejects(call(sb, 'start', { ...brief(), dir: join(sb.allowed, 'nope') }), { code: 'invalid_request' });
  await assert.rejects(call(sb, 'start', { ...brief(), dir: 'relative/path' }), { code: 'invalid_request' });
  assert.equal(existsSync(join(sb.state, 'jobs')), false);
});

test('unset CLAUDE_CODE_DIRS is not_configured and says where to set it', async () => {
  const sb = sandbox({ CLAUDE_CODE_DIRS: undefined });
  await assert.rejects(call(sb, 'start', { ...brief(), dir: sb.work }), e => e.code === 'not_configured' && /CLAUDE_CODE_DIRS/.test(e.message) && /Nest/.test(e.message));
});

test('input is validated: unknown keys, bad key, long prompt, effort, timeout', async () => {
  const sb = sandbox();
  const ok = { ...brief(), dir: sb.work };
  for (const bad of [{ extra: 1 }, { key: 'Bad Key' }, { key: '-x' }, { prompt: '' }, { prompt: 'x'.repeat(20001) }, { title: 'x'.repeat(121) }, { effort: 'ultra' }, { timeout_min: 4 }, { timeout_min: 721 }, { model: '--help' }]) {
    await assert.rejects(call(sb, 'start', { ...ok, ...bad }), { code: 'invalid_request' }, JSON.stringify(bad).slice(0, 60));
  }
});

test('start answers the job, runs claude in dir with the brief and footer, and the defaults', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief('RESULT: {"file":"out.txt"}'), dir: sb.work });
  assert.equal(out.started, true);
  assert.match(out.id, /^video-1-\d{8}T\d{6}Z$/);
  assert.equal(out.result_path, join(sb.state, 'jobs', out.id, 'result.json'));
  assert.equal(out.log, join(sb.state, 'jobs', out.id, 'log.jsonl'));
  await finished(sb, out.id);
  const d = sb.dump();
  assert.deepEqual(d.argv, ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', 'opus', '--effort', 'high']);
  assert.equal(realpathSync(d.cwd), realpathSync(sb.work));
  assert.ok(d.prompt.startsWith('Make a video.'));
  assert.ok(d.prompt.includes(`You run unattended: nobody answers questions; decide and keep going. When you finish, write the result described above as one JSON object to ${out.result_path}. If you could not finish, write {"ok": false, "error": "<one line why>"} there instead.`));
  assert.equal(readFileSync(join(sb.state, 'jobs', out.id, 'prompt.md'), 'utf8'), d.prompt);
  const list = await call(sb, 'jobs', {});
  const j = list.jobs[0];
  assert.deepEqual([j.state, j.cost_usd, j.num_turns, j.last_text, j.result], ['done', 0.1, 3, 'all done', { file: 'out.txt' }]);
  assert.deepEqual(j.usage, { input_tokens: 5, output_tokens: 7 });
  assert.equal(j.model, 'opus'); assert.equal(j.effort, 'high'); assert.equal(j.key, 'video-1');
});

test('model and effort come from the input, else CLAUDE_CODE_MODEL / CLAUDE_CODE_EFFORT', async () => {
  const sb = sandbox({ CLAUDE_CODE_MODEL: 'sonnet', CLAUDE_CODE_EFFORT: 'low' });
  const a = await call(sb, 'start', { ...brief(), dir: sb.work });
  await finished(sb, a.id);
  assert.deepEqual(sb.dump().argv.slice(-4), ['--model', 'sonnet', '--effort', 'low']);
  const b = await call(sb, 'start', { ...brief(), key: 'video-2', dir: sb.work, model: 'haiku', effort: 'max' });
  await finished(sb, b.id);
  assert.deepEqual(sb.dump().argv.slice(-4), ['--model', 'haiku', '--effort', 'max']);
});

test('the session environment is an allowlist: no API key, token, SOOT_* or *_KEY reaches claude', async () => {
  const sb = sandbox({ CLAUDE_CONFIG_DIR: '/tmp/cfg', LANG: 'en_US.UTF-8', TERM: 'xterm' });
  const out = await call(sb, 'start', { ...brief(), dir: sb.work });
  await finished(sb, out.id);
  const names = Object.keys(sb.dump().env);
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'CLAUDE_CONFIG_DIR'];
  assert.deepEqual(names.filter(k => !allowed.includes(k) && !/^(__CF|PWD|SHLVL|_$|OLDPWD)/.test(k)), []);
  assert.ok(!names.some(k => /ANTHROPIC|_KEY|_TOKEN|^SOOT_/.test(k)), names.join());
  assert.equal(sb.dump().env.CLAUDE_CONFIG_DIR, '/tmp/cfg');
  assert.ok(sb.dump().env.HOME && sb.dump().env.PATH);
});

test('the same key while it runs answers the running job; a second session is never started', async () => {
  const sb = sandbox();
  const first = await call(sb, 'start', { ...brief('FAKE:sleep=1500'), dir: sb.work });
  const again = await call(sb, 'start', { ...brief('another brief'), dir: sb.work });
  assert.equal(again.already, true);
  assert.equal(again.id, first.id);
  assert.equal(again.result_path, first.result_path);
  await finished(sb, first.id);
  assert.equal((await call(sb, 'jobs', {})).count, 1);
  // once finished, the key may be used again
  const next = await call(sb, 'start', { ...brief(), dir: sb.work });
  assert.equal(next.started, true); assert.notEqual(next.id, first.id);
  await finished(sb, next.id);
});

test('over CLAUDE_CODE_MAX_RUNNING the answer is busy, not done, so a chain records it; a higher limit lets two run', async () => {
  const sb = sandbox();
  const first = await call(sb, 'start', { ...brief('FAKE:sleep=1500'), dir: sb.work });
  const busy = await call(sb, 'start', { ...brief(), key: 'video-2', dir: sb.work });
  assert.deepEqual([busy.done, busy.started, busy.waiting, busy.key, busy.title, busy.running.map(r => r.key)], [undefined, false, 'busy', 'video-2', 'Make the video', ['video-1']]);
  assert.equal((await call(sb, 'jobs', {})).count, 1);
  await finished(sb, first.id);
  const two = sandbox({ CLAUDE_CODE_MAX_RUNNING: '2' });
  const a = await call(two, 'start', { ...brief('FAKE:sleep=800'), dir: two.work });
  const b = await call(two, 'start', { ...brief('FAKE:sleep=800'), key: 'video-2', dir: two.work });
  assert.ok(a.started && b.started);
  await finished(two, a.id); await finished(two, b.id);
});

test('watch emits the result verbatim once, then done', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief('RESULT: {"file":"out.txt","caption":"hi","n":[1,2]}\nFAKE:sleep=1500'), dir: sb.work });
  assert.deepEqual(await call(sb, 'watch', { emit: 'result' }), { done: true, running: 1 }); // still running
  await finished(sb, out.id);
  assert.deepEqual(await call(sb, 'watch', { key_prefix: 'video-', emit: 'result' }), { file: 'out.txt', caption: 'hi', n: [1, 2] });
  assert.deepEqual(await call(sb, 'watch', { emit: 'result' }), { done: true, running: 0 });
});

test('watch emit job (default) wraps the job and the result; key_prefix filters', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief(), dir: sb.work });
  await finished(sb, out.id);
  assert.deepEqual(await call(sb, 'watch', { key_prefix: 'other-' }), { done: true, running: 0 });
  const w = await call(sb, 'watch', {});
  assert.deepEqual([w.job.id, w.job.state, w.job.cost_usd, w.result], [out.id, 'done', 0.1, { done: true }]);
  assert.equal(w.job.result, undefined);
  assert.deepEqual(await call(sb, 'watch', {}), { done: true, running: 0 });
});

test('watch reports one job per call, oldest first', async () => {
  const sb = sandbox();
  const a = await call(sb, 'start', { ...brief('RESULT: {"which":"a"}'), key: 'a', dir: sb.work }, { now: Date.parse('2026-11-24T01:00:00Z') });
  await finished(sb, a.id);
  const b = await call(sb, 'start', { ...brief('RESULT: {"which":"b"}'), key: 'b', dir: sb.work }, { now: Date.parse('2026-11-24T02:00:00Z') });
  await finished(sb, b.id);
  assert.deepEqual(await call(sb, 'watch', { emit: 'result' }), { which: 'a' });
  assert.deepEqual(await call(sb, 'watch', { emit: 'result' }), { which: 'b' });
  assert.deepEqual(await call(sb, 'watch', { emit: 'result' }), { done: true, running: 0 });
});

test('a failed exit is ok:false, notify:true with the reason and last words', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief('FAKE:fail'), dir: sb.work });
  await finished(sb, out.id);
  const w = await call(sb, 'watch', { emit: 'result' });
  assert.equal(w.ok, false); assert.equal(w.notify, true);
  assert.deepEqual([w.job.id, w.job.key, w.job.state, w.job.last_text], [out.id, 'video-1', 'failed', 'working on it']);
  assert.match(w.job.error, /code 3.*boom/);
  assert.deepEqual(await call(sb, 'watch', {}), { done: true, running: 0 });
  const [j] = (await call(sb, 'jobs', { state: 'failed' })).jobs;
  assert.equal(j.id, out.id);
});

test('no result, a result that is not an object, and ok:false are all failures that notify', async () => {
  const sb = sandbox();
  for (const [mode, rx] of [['nores', /without writing result\.json/], ['bad', /not a JSON object/], ['okfalse', /no footage/]]) {
    const out = await call(sb, 'start', { ...brief(`FAKE:${mode}`), key: mode, dir: sb.work });
    await finished(sb, out.id);
    const w = await call(sb, 'watch', { key_prefix: mode, emit: 'result' });
    assert.equal(w.ok, false, mode); assert.equal(w.notify, true);
    assert.match(w.job.error, rx);
  }
});

test('a session past its timeout is killed with its whole group; watch reports timed_out', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief('FAKE:hang'), dir: sb.work }, { timeoutMs: 700 });
  const pidFile = join(sb.bin, 'grandchild.pid');
  const grandchild = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8')));
  assert.ok(pidAlive(grandchild));
  await finished(sb, out.id);
  const exit = JSON.parse(readFileSync(join(sb.state, 'jobs', out.id, 'exit.json'), 'utf8'));
  assert.equal(exit.timed_out, true);
  await until(() => !pidAlive(grandchild));
  const w = await call(sb, 'watch', {});
  assert.equal(w.notify, true); assert.equal(w.job.state, 'timed_out'); assert.match(w.job.error, /timed out/);
});

test('stop kills the group and records stopped; watch stays quiet about it', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief('FAKE:hang'), dir: sb.work });
  const pidFile = join(sb.bin, 'grandchild.pid');
  const grandchild = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8')));
  const stopped = await call(sb, 'stop', { id: out.id });
  assert.deepEqual([stopped.ok, stopped.state], [true, 'stopped']);
  assert.equal(JSON.parse(readFileSync(join(sb.state, 'jobs', out.id, 'exit.json'), 'utf8')).stopped, true);
  await until(() => !pidAlive(grandchild));
  assert.deepEqual(await call(sb, 'watch', {}), { done: true, running: 0 });
  assert.equal((await call(sb, 'jobs', { state: 'stopped' })).count, 1);
  assert.deepEqual(await call(sb, 'stop', { id: out.id }), { ok: true, already_finished: true, id: out.id, state: 'stopped' });
  await assert.rejects(call(sb, 'stop', { id: 'nope-1' }), { code: 'not_found' });
  // the key is free again
  const again = await call(sb, 'start', { ...brief(), dir: sb.work });
  assert.equal(again.started, true);
  await finished(sb, again.id);
});

test('a runner that vanished is failed (runner_gone): jobs derives it, watch makes it final', async () => {
  const sb = sandbox();
  const id = 'video-9-20261124T010000Z', dir = join(sb.state, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ id, key: 'video-9', title: 'Gone', dir: sb.work, model: 'opus', effort: 'high', timeout_min: 5, timeout_ms: 300000, started_at: new Date().toISOString(), claude_bin: sb.claude }));
  writeFileSync(join(dir, 'runner.pid'), '999999\n');
  const [j] = (await call(sb, 'jobs', {})).jobs;
  assert.equal(j.state, 'failed'); assert.match(j.error, /runner_gone/);
  assert.equal(existsSync(join(dir, 'exit.json')), false); // a read tool writes nothing
  const w = await call(sb, 'watch', {});
  assert.equal(w.ok, undefined); assert.equal(w.notify, true); assert.match(w.job.error, /runner_gone/);
  assert.equal(existsSync(join(dir, 'exit.json')), true);
});

test('watch ends a job past its timeout whose runner is long gone', async () => {
  const sb = sandbox();
  const id = 'old-20261120T010000Z', dir = join(sb.state, 'jobs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ id, key: 'old', title: 'Old', dir: sb.work, model: 'opus', effort: 'high', timeout_min: 5, timeout_ms: 300000, started_at: '2026-11-20T01:00:00.000Z', claude_bin: sb.claude }));
  const w = await call(sb, 'watch', {});
  assert.equal(w.notify, true); assert.equal(w.job.state, 'failed');
});

test('jobs filters by key and state, newest first, with a long last_text and a large result trimmed', async () => {
  const sb = sandbox({ CLAUDE_CODE_MAX_RUNNING: '3' });
  const a = await call(sb, 'start', { ...brief(), key: 'a', dir: sb.work }, { now: Date.parse('2026-11-24T01:00:00Z') });
  const big = JSON.stringify({ blob: 'x'.repeat(6000) });
  const b = await call(sb, 'start', { ...brief(`RESULT: ${big}`), key: 'b', dir: sb.work }, { now: Date.parse('2026-11-24T02:00:00Z') });
  await finished(sb, a.id); await finished(sb, b.id);
  const all = await call(sb, 'jobs', {});
  assert.deepEqual(all.jobs.map(j => j.key), ['b', 'a']);
  assert.deepEqual((await call(sb, 'jobs', { key: 'a' })).jobs.map(j => j.key), ['a']);
  assert.equal((await call(sb, 'jobs', { state: 'running' })).count, 0);
  assert.equal((await call(sb, 'jobs', { limit: 1 })).count, 1);
  assert.equal(all.jobs[0].result.truncated, true);
  await assert.rejects(call(sb, 'jobs', { state: 'weird' }), { code: 'invalid_request' });
});

test('the entry script reads the context on stdin and prints {error:{code,message}} for a refusal', () => {
  const sb = sandbox({ CLAUDE_CODE_DIRS: undefined });
  const go = (name, input) => {
    const r = spawnSync(process.execPath, [TOOL, name], { input: JSON.stringify({ input }), env: sb.env, encoding: 'utf8' });
    return JSON.parse(r.stdout);
  };
  assert.equal(go('start', { ...brief(), dir: sb.work }).error.code, 'not_configured');
  assert.equal(go('nope', {}).error.code, 'invalid_request');
  assert.deepEqual(go('jobs', {}), { count: 0, jobs: [] });
  assert.deepEqual(go('watch', {}), { done: true, running: 0 });
});

test('watch emit job hands a failure on as {notify, job}, never ok:false, so the next tool records it', async () => {
  const sb = sandbox();
  const out = await call(sb, 'start', { ...brief('FAKE:fail'), dir: sb.work });
  await finished(sb, out.id);
  const w = await call(sb, 'watch', { key_prefix: 'video-', emit: 'job' });
  assert.equal(w.ok, undefined); assert.equal(w.done, undefined); assert.equal(w.notify, true);
  assert.deepEqual([w.job.id, w.job.key, w.job.title, w.job.state, w.job.last_text], [out.id, 'video-1', 'Make the video', 'failed', 'working on it']);
  assert.match(w.job.error, /code 3/);
  assert.equal(w.result, undefined);
  assert.deepEqual(await call(sb, 'watch', { emit: 'job' }), { done: true, running: 0 });
});

test('start and watch delete job folders that ended more than 14 days ago; a running job and a read tool never do', async () => {
  const sb = sandbox();
  const old = await call(sb, 'start', { ...brief(), key: 'old', dir: sb.work });
  await finished(sb, old.id);
  const recent = await call(sb, 'start', { ...brief(), key: 'recent', dir: sb.work });
  await finished(sb, recent.id);
  // A running job (no exit.json, a live runner) has no end to age from: it is kept.
  const live = await call(sb, 'start', { ...brief('FAKE:sleep=1500'), key: 'live', dir: sb.work });
  const jobs = join(sb.state, 'jobs');
  const exitOf = id => join(jobs, id, 'exit.json');
  const ended = JSON.parse(readFileSync(exitOf(old.id), 'utf8'));
  writeFileSync(exitOf(old.id), JSON.stringify({ ...ended, ended_at: new Date(Date.now() - 15 * 86_400_000).toISOString() }));
  // jobs is a read tool: it deletes nothing.
  assert.equal((await call(sb, 'jobs', {})).count, 3);
  assert.ok(existsSync(join(jobs, old.id)));
  assert.deepEqual(await call(sb, 'watch', { key_prefix: 'none-' }), { done: true, running: 0 });
  assert.equal(existsSync(join(jobs, old.id)), false, 'an expired job is deleted');
  assert.equal(existsSync(exitOf(live.id)), false, 'the running job was not ended');
  assert.ok(existsSync(join(jobs, recent.id)), 'a job that ended today is kept');
  assert.ok(existsSync(join(jobs, live.id)), 'a running job is kept');
  await finished(sb, live.id);
});
