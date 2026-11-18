// lohi-character runner (tools/soot-lohi-character) against a fake Lohi api:
// both reads carry the key and the asker's principal, an anonymous call sends
// nothing, input is validated before any request, secrets never reach output.
// tests/ is not shipped in the pack archive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const bin = new URL('../tools/soot-lohi-character', import.meta.url).pathname;
const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const KEY = 'test-only-key-not-real';
const ID = '11111111-2222-4333-8444-555555555555';
let server, base, seen = [], answer = () => [200, { ok: true }];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const [status, out] = answer(req);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/novel`;
});
after(() => server.close());

function run(cmd, input, { token = TOKEN, hook = 'tool.call', stdinToken } = {}) {
  seen = [];
  const call = { api_version: 'soot/v1', hook, event: { subject: 'job-1' }, input, ...(stdinToken ? { principal_token: stdinToken } : {}) };
  return new Promise(resolve => {
    const child = spawn(bin, [cmd], { env: { PATH: process.env.PATH, LOHI_API_BASE: base, LOHI_CHARACTER_API_KEY: KEY, ...(token ? { SOOT_PRINCIPAL_TOKEN: token } : {}) } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ code, stdout, stderr }));
    // A runner that refuses before reading stdin (a bad token, an unknown
    // command) may exit first; the write then fails with EPIPE, which is that
    // case, not a test failure.
    child.stdin.on('error', err => { if (err.code !== 'EPIPE') throw err; });
    child.stdin.end(JSON.stringify(call) + '\n');
  });
}

test('context reads the companion with the key, the principal and the encoded question', async () => {
  answer = () => [200, { companion: { id: ID }, progress: 24, beyondProgress: false, passages: [] }];
  const r = await run('context', { companion_id: ID, q: 'Ninh Diêu ở đâu?' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/context?q=Ninh%20Di%C3%AAu%20%E1%BB%9F%20%C4%91%C3%A2u%3F`);
  assert.equal(seen[0].headers['x-api-key'], KEY);
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  assert.equal(JSON.parse(r.stdout).progress, 24);
  const bare = await run('context', { companion_id: ID });
  assert.equal(bare.code, 0);
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/context`);
});

test('character reads the card and sample dialogue with the key and the principal', async () => {
  answer = () => [200, { companion: { id: ID }, progress: 24, card: ['Tên: Ninh Diêu'], dialogue: [{ chapter: 20, text: 'Kiếm đâu?' }] }];
  const r = await run('character', { companion_id: ID });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/character`);
  assert.equal(seen[0].headers['x-api-key'], KEY);
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  assert.equal(JSON.parse(r.stdout).dialogue[0].text, 'Kiếm đâu?');
  const anon = await run('character', { companion_id: ID }, { token: null });
  assert.equal(anon.code, 1);
  assert.equal(seen.length, 0);
});

test('characters and wiki search the same novel with an encoded query; wiki needs q', async () => {
  answer = () => [200, { progress: 24, characters: [], entries: [] }];
  const c = await run('characters', { companion_id: ID, q: 'Trần Bình An' });
  assert.equal(c.code, 0, c.stderr);
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/characters?q=Tr%E1%BA%A7n%20B%C3%ACnh%20An`);
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
  const all = await run('characters', { companion_id: ID });
  assert.equal(all.code, 0);
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/characters`);
  const w = await run('wiki', { companion_id: ID, q: 'Kiếm Khí Trường Thành' });
  assert.equal(w.code, 0, w.stderr);
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/wiki?q=Ki%E1%BA%BFm%20Kh%C3%AD%20Tr%C6%B0%E1%BB%9Dng%20Th%C3%A0nh`);
  const bare = await run('wiki', { companion_id: ID });
  assert.equal(bare.code, 1);
  assert.equal(seen.length, 0);
});

test('remember reads the memory route; the stdin token is used when the env has none', async () => {
  answer = () => [200, { notes: ['thích Trần Bình An'], bond: 3 }];
  const r = await run('remember', { companion_id: ID }, { token: '', stdinToken: TOKEN });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(seen[0].url, `/novel/agent/companions/${ID}/memory`);
  assert.equal(seen[0].headers['x-soot-principal'], TOKEN);
});

test('no principal: nothing is sent and the answer is principal_required', async () => {
  for (const cmd of ['context', 'remember']) {
    const r = await run(cmd, { companion_id: ID }, { token: '' });
    assert.equal(r.code, 1, cmd);
    assert.equal(JSON.parse(r.stdout).code, 'principal_required');
    assert.equal(seen.length, 0, `${cmd}: nothing sent`);
  }
});

test('a malformed token, a bad id, a wrong hook or an unknown command never reach the api', async () => {
  const bad = await run('context', { companion_id: ID }, { token: 'not a jws"\nheader = "X-Evil: 1' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /principal_invalid/);
  const id = await run('context', { companion_id: '../../admin' });
  assert.equal(id.code, 1);
  assert.match(id.stderr, /bad_input/);
  const hook = await run('context', { companion_id: ID }, { hook: 'tool.preflight' });
  assert.equal(hook.code, 1);
  const unknown = await run('write', { companion_id: ID });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown_command/);
  assert.equal(seen.length, 0);
});

test('an api refusal passes through as a decided failure; the key and token are never printed', async () => {
  answer = () => [401, { code: 'principal_invalid', error: 'expired' }];
  const r = await run('context', { companion_id: ID, q: 'x' });
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).code, 'principal_invalid');
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
});

test('the manifest declares two read tools and uses every credential it declares', async () => {
  const pack = JSON.parse(await readFile(new URL('../pack.json', import.meta.url), 'utf8'));
  assert.equal(pack.id, undefined, 'the folder is the id');
  assert.deepEqual(pack.tools.map(t => [t.name, t.run.mode]), [['character', 'read'], ['context', 'read'], ['remember', 'read'], ['characters', 'read'], ['wiki', 'read']]);
  const used = new Set(pack.tools.flatMap(t => Object.values(t.run.secret_env).map(v => v.match(/\{\{cred:([A-Z_]+)\}\}/)[1])));
  assert.deepEqual([...used].sort(), Object.keys(pack.needs.credentials).sort());
  const skill = await readFile(new URL('../skills/character/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /You are an AI/);
  assert.match(skill, /Only what the asker has read/);
});
