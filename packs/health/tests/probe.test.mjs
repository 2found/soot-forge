// health probe (tools/probe) against a local server: argv and HEALTH_TARGETS,
// statuses and unreachable are observations, bad config fails before any
// request, bodies and redirect targets never reach the output.
// tests/ is not shipped in the pack archive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const bin = new URL('../tools/probe', import.meta.url).pathname;
const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
let server, base, hits = 0;

before(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === '/down') return res.writeHead(503).end('secret-body');
    if (req.url === '/moved') return res.writeHead(302, { location: 'https://elsewhere.example/x' }).end();
    res.writeHead(200).end('secret-body');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { env: { PATH: process.env.PATH, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('the manifest runs the sh probe as a read tool and asks for HEALTH_TARGETS', () => {
  const tool = pack.tools.find(t => t.name === 'probe');
  assert.equal(tool.run.program, 'tools/probe');
  assert.equal(tool.run.mode, 'read');
  assert.deepEqual(pack.needs.env, ['HEALTH_TARGETS']);
});

test('one argv URL reports status and latency, never the body', async () => {
  const out = await run([`${base}/ok`]);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^endpoint status=200 latency_ms=\d+\n$/);
  assert.doesNotMatch(out.stdout, /secret-body/);
});

test('HEALTH_TARGETS probes every named target; 5xx, redirects and unreachable are observations', async () => {
  const targets = `up=${base}/ok,down=${base}/down moved=${base}/moved gone=http://127.0.0.1:1/`;
  const out = await run(['http://127.0.0.1:9/ignored'], { HEALTH_TARGETS: targets });
  assert.equal(out.code, 0, out.stderr);
  const lines = out.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^up status=200 /);
  assert.match(lines[1], /^down status=503 /);
  assert.match(lines[2], /^moved status=302 /);
  assert.match(lines[3], /^gone unreachable/);
  assert.doesNotMatch(out.stdout, /elsewhere|secret-body/);
});

test('bad config fails before any request is sent', async () => {
  const bad = [
    `ok=${base}/ok bad=ftp://example.com/`,
    `ok=${base}/ok noequals`,
    `ok=${base}/ok b@d=${base}/ok`,
    `ok=${base}/ok creds=http://user:pw@127.0.0.1/`,
    `ok=${base}/ok frag=${base}/ok#x`,
    Array.from({ length: 17 }, (_, i) => `t${i}=${base}/ok`).join(' '),
  ];
  for (const HEALTH_TARGETS of bad) {
    hits = 0;
    const out = await run([], { HEALTH_TARGETS });
    assert.equal(out.code, 1, HEALTH_TARGETS);
    assert.equal(out.stdout, '');
    assert.equal(hits, 0, `no request for ${HEALTH_TARGETS}`);
  }
  for (const args of [[], ['not-a-url'], [`${base}/a`, `${base}/b`]]) {
    const out = await run(args);
    assert.equal(out.code, 1, args.join(' '));
  }
});

test('glob characters in a target are not expanded', async () => {
  const out = await run([], { HEALTH_TARGETS: `star=${base}/*` });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^star status=200 /);
});
