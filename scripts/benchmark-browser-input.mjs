import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// Opt-in transport microbenchmark. Runs the trusted local adapter against a
// loopback fixture, without launching Chromium, Soot, or a model provider.
// Node 24+, npm/npx on PATH, POSIX. Does not install dependencies.
import { join, dirname, delimiter, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const adapter = process.argv[2];
const reportPath = process.argv[3];
if (!adapter || !reportPath || !isAbsolute(adapter) || !isAbsolute(reportPath)) throw new Error('usage: node scripts/benchmark-browser-input.mjs ABS_ADAPTER ABS_REPORT');
if (Number(process.versions.node.split('.')[0]) < 24 || process.platform === 'win32') throw new Error('This fixture requires Node 24+ on macOS/Linux');
const root = await mkdtemp(join(tmpdir(), 'soot-browser-transport-'));
const samples = { node: [], npx: [] };
let receivedAt = 0, receivedCount = 0;
const sockets = new Set();
const server = createServer((_req, res) => { res.writeHead(404).end(); });
server.on('upgrade', (req, socket) => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n');
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, masked = !!(buffer[1] & 128);
      let len = buffer[1] & 127, offset = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      if (len === 127) throw new Error('fixture frame too large');
      if (buffer.length < offset + (masked ? 4 : 0) + len) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + len);
      if (opcode === 9) { socket.write(Buffer.concat([Buffer.from([0x8a,payload.length]),payload])); continue; }
      if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      if (opcode === 1) {
        const message = JSON.parse(payload);
        if (message.type !== 'input_keyboard' || message.text !== 'x') throw new Error('unexpected input');
        receivedCount++; receivedAt = performance.now();
      }
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const envelope = JSON.stringify({ api_version: 'soot/v1', hook: 'tool.call', operation: 'browser-use_control', soot: 'benchmark', interaction: true, event: { source: 'conversation', subject: 'benchmark' }, input: { action: 'text', text: 'x' } });
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
async function invoke(kind) {
  const start = performance.now(), before = receivedCount;
  const child = kind === 'node' ? spawn(process.execPath, [adapter, 'control'], { cwd: root, env }) : spawn('npx', ['--no-install', 'soot-browser', 'control'], { cwd: root, env });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b);
  child.stderr.on('data', b => stderr += b);
  child.stdin.end(envelope);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    if (code !== 0 || !JSON.parse(stdout).result.accepted || receivedCount !== before + 1) throw new Error(`failed ${kind}: ${code} ${stderr}`);
    return { received_ms: receivedAt - start, completed_ms: performance.now() - start };
  } finally { clearTimeout(timer); }
}
function stats(rows, field) {
  const x = rows.map(r => r[field]).sort((a, b) => a - b);
  return { min: x[0], median: (x[9] + x[10]) / 2, p95: x[18], max: x[19] };
}
try {
  await mkdir(join(root, '.browser/sessions/benchmark'), { recursive: true });
  await writeFile(join(root, '.browser/sessions/benchmark/stream.json'), JSON.stringify({ url: `ws://127.0.0.1:${server.address().port}/` }));
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  await symlink(adapter, join(root, 'node_modules/.bin/soot-browser'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'soot-browser-recon-fixture', version: '0.0.0', private: true }));
  for (let i = 0; i < 22; i++) {
    for (const kind of i % 2 ? ['npx', 'node'] : ['node', 'npx']) {
      const row = await invoke(kind);
      if (i >= 2) samples[kind].push(row);
    }
  }
  const result = { timestamp: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, iterations_per_mode: 20, warmups_per_mode: 2, adapter_sha256: createHash('sha256').update(await readFile(adapter)).digest('hex'), scope: 'Real browser-use human text executable path, fixture WebSocket receiver. Excludes Soot API/journal, Tauri IPC, Chromium input processing and display. No browser or provider launched. npx local executable resolution, offline.', received_messages: receivedCount, results: Object.fromEntries(Object.entries(samples).map(([key, rows]) => [key, { received_ms: stats(rows, 'received_ms'), completed_ms: stats(rows, 'completed_ms') }])), samples };
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
