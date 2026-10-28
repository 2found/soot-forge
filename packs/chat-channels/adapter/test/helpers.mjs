// Test doubles: a fake Soot runtime replaying the channel-adapter.v1 fixtures, a
// fake Telegram Bot API and a fake Discord (REST + a minimal Gateway WebSocket).
import {createHash} from 'node:crypto';
import {readFileSync, mkdtempSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAdapter} from '../core/main.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures');
export const fixture = file => JSON.parse(readFileSync(join(FIXTURES, `${file}.json`), 'utf8'));
export const exchange = (file, name) => {
  const found = fixture(file).find(entry => entry.name.startsWith(name));
  if (!found) throw new Error(`no fixture ${file}: ${name}`);
  return found;
};
export const response = (file, name) => exchange(file, name).response;
export const outboxItems = () => fixture('outbox').flatMap(entry => entry.response.body.items);

// outbox.sse → [{note, body}] per "## connection" block, fixture notes stripped.
export function sseConnections() {
  const text = readFileSync(join(FIXTURES, 'outbox.sse'), 'utf8');
  return text.split(/^## /m).slice(1).map(block => {
    const [title, ...lines] = block.split('\n');
    return {title, body: lines.filter(line => !line.startsWith('#')).join('\n').trim() + '\n\n'};
  });
}

export const sseItem = item => `id: ${item.seq}\nevent: item\ndata: ${JSON.stringify(item)}\n\n`;
export const tempDir = () => mkdtempSync(join(tmpdir(), 'soot-channel-test-'));
export const until = async (predicate, timeout = 3000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : undefined; } catch { return text; }
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const reply = (res, {status = 200, headers = {}, body}) => {
  res.writeHead(status, {'content-type': 'application/json', ...headers});
  res.end(body === undefined ? '' : JSON.stringify(body));
};

// Fake runtime. `routes['POST /v1/channel/messages'] = body => response` overrides
// a route; `streams` is a queue of stream responses ({status, body}|{body, hold}).
export class FakeRuntime {
  constructor() {
    this.calls = [];
    this.streams = [];
    this.streamRequests = [];
    this.openStreams = new Set();
    this.routes = {
      'GET /v1/channel/session': () => response('session', 'session: handshake'),
      'POST /v1/channel/status': () => ({status: 200, body: {ok: true}}),
      'POST /v1/channel/admission': () => response('admission', 'admission: paired owner in DM'),
      'POST /v1/channel/conversations/resolve': () => response('resolve', 'resolve: first message'),
      'POST /v1/channel/messages': () => response('messages', 'messages: paired owner asks'),
      'POST /v1/channel/outbox/ack': body => ({status: 200, body: {acked_through: 0, results: body.acks.map(ack => ({receipt_id: ack.receipt_id, ok: true}))}}),
      'POST /v1/channel/answers': () => response('answers', 'answers: owner presses'),
      'POST /v1/channel/pairings/claim': () => response('pairing', 'pairing: owner redeems'),
    };
    this.server = createServer(async (req, res) => {
      const path = req.url.split('?')[0];
      const body = await readBody(req);
      const call = {method: req.method, path, body, headers: req.headers};
      if (path === '/v1/channel/outbox/stream') return this.stream(req, res, call);
      this.calls.push(call);
      const handler = this.routes[`${req.method} ${path}`];
      if (!handler) return reply(res, {status: 404, body: {code: 'not_found', error: 'no route'}});
      reply(res, await handler(body, call));
    });
  }

  async start() { this.url = await listen(this.server); return this; }
  async stop() {
    for (const res of this.openStreams) res.destroy();
    this.server.closeAllConnections?.();
    await new Promise(resolve => this.server.close(resolve));
  }

  stream(req, res, call) {
    this.streamRequests.push(call);
    const next = this.streams.shift() ?? {body: ': connected\n\n', hold: true};
    if (next.status && next.status !== 200) return reply(res, {status: next.status, body: next.json});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(next.body);
    if (next.hold) {
      this.openStreams.add(res);
      req.on('close', () => this.openStreams.delete(res));
    } else res.end();
  }

  // Pushes an item to every held stream.
  push(item) { for (const res of this.openStreams) res.write(sseItem(item)); }
  callsTo(path) { return this.calls.filter(call => call.path === path); }
}

// Fake Telegram Bot API.
export class FakeTelegram {
  constructor({token = 'tg-fixture-token', me = {id: 7012345678, is_bot: true, first_name: 'Đầu mối của Shop', username: 'shop_dau_moi_bot'}} = {}) {
    this.token = token;
    this.me = me;
    this.updates = [];
    this.calls = [];
    this.nextMessageID = 8811;
    this.fail = {};           // method → {error_code, description, parameters?} (once per entry)
    this.server = createServer(async (req, res) => {
      const [, botToken, method] = req.url.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
      const params = (await readBody(req)) ?? {};
      if (botToken !== this.token) return reply(res, {status: 401, body: {ok: false, error_code: 401, description: 'Unauthorized'}});
      if (method !== 'getUpdates') this.calls.push({method, params});
      const failure = this.fail[method]?.shift?.();
      if (failure) return reply(res, {status: failure.error_code, body: {ok: false, ...failure}});
      reply(res, {body: {ok: true, result: await this.handle(method, params)}});
    });
  }

  async start() { this.url = await listen(this.server); return this; }
  async stop() { this.server.closeAllConnections?.(); await new Promise(resolve => this.server.close(resolve)); }

  async handle(method, params) {
    switch (method) {
      case 'getMe': return this.me;
      case 'getUpdates': {
        this.lastOffset = params.offset;
        const ready = () => this.updates.filter(update => update.update_id >= (params.offset ?? 0));
        for (let i = 0; i < 5 && !ready().length; i++) await new Promise(resolve => setTimeout(resolve, 20));
        return ready();
      }
      case 'sendMessage': return {message_id: this.nextMessageID++, chat: {id: params.chat_id}};
      default: return true;
    }
  }

  sent() { return this.calls.filter(call => call.method === 'sendMessage'); }
  method(name) { return this.calls.filter(call => call.method === name); }
}

export const tgUser = {id: 123456789, is_bot: false, first_name: 'Lan', last_name: 'Nguyễn', username: 'lan_ng'};
export const tgStranger = {id: 987654321, is_bot: false, first_name: 'Người lạ'};
export function tgMessage(updateID, text, {from = tgUser, chat = {id: from.id, type: 'private'}, entities, ...rest} = {}) {
  const message = {message_id: 4400 + updateID % 100, from, chat, date: 1, ...rest};
  if (text !== undefined) message.text = text;
  if (entities) message.entities = entities;
  else if (text?.startsWith('/')) message.entities = [{type: 'bot_command', offset: 0, length: text.split(' ')[0].length}];
  return {update_id: updateID, message};
}

// Minimal RFC 6455 server side: enough for a Gateway double (text frames, close).
export class FakeDiscord {
  constructor({token = 'dc-fixture-token', botID = '1100220033004400999', applicationID = '1100220033004400'} = {}) {
    Object.assign(this, {token, botID, applicationID});
    this.calls = [];
    this.received = [];       // Gateway payloads from the adapter
    this.sockets = [];
    this.nextMessageID = 1400000000000000001n;
    this.fail = {};
    this.onPayload = null;
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      const path = req.url.replace(/^\/api\/v10/, '');
      if (req.headers.authorization !== `Bot ${this.token}`) return reply(res, {status: 401, body: {message: '401: Unauthorized', code: 0}});
      this.calls.push({method: req.method, path, body});
      const failure = this.fail[`${req.method} ${path.replace(/\d{5,}/g, ':id')}`]?.shift?.();
      if (failure) return reply(res, failure);
      if (path === '/users/@me') return reply(res, {body: {id: this.botID, username: 'dau-moi', global_name: 'Đầu mối'}});
      if (path === '/oauth2/applications/@me') return reply(res, {body: {id: this.applicationID}});
      if (path === '/users/@me/channels') return reply(res, {body: {id: '1299999999999999999', type: 1}});
      if (req.method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) return reply(res, {body: {id: String(this.nextMessageID++)}});
      if (req.method === 'PATCH' && /^\/channels\//.test(path)) return reply(res, {body: {id: path.split('/').pop()}});
      if (req.method === 'POST' && path.startsWith('/interactions/')) return reply(res, {status: 204});
      reply(res, {status: 204});
    });
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
  }

  async start() {
    const base = await listen(this.server);
    this.apiBase = `${base}/api/v10`;
    this.gatewayUrl = base.replace('http', 'ws') + '/gateway';
    return this;
  }
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    this.server.closeAllConnections?.();
    await new Promise(resolve => this.server.close(resolve));
  }

  upgrade(req, socket) {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection = {socket, url: req.url, send: payload => socket.write(frame(0x1, Buffer.from(JSON.stringify(payload)))),
      close: code => { const data = Buffer.alloc(2); data.writeUInt16BE(code); socket.write(frame(0x8, data)); socket.end(); }};
    this.sockets.push(socket);
    this.connections = [...(this.connections ?? []), connection];
    let buffer = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = unframe(buffer);
        if (!parsed) break;
        buffer = buffer.subarray(parsed.length);
        if (parsed.opcode === 0x8) { socket.end(); return; }
        if (parsed.opcode !== 0x1) continue;
        const payload = JSON.parse(parsed.data.toString('utf8'));
        this.received.push(payload);
        if (payload.op === 1) connection.send({op: 11});
        this.onPayload?.(payload, connection);
      }
    });
    connection.send({op: 10, d: {heartbeat_interval: 45000}});
  }

  get last() { return this.connections.at(-1); }
  dispatch(t, d, connection = this.last) { this.seq = (this.seq ?? 0) + 1; connection.send({op: 0, t, s: this.seq, d}); }
  callsMatching(method, pattern) { return this.calls.filter(call => call.method === method && pattern.test(call.path)); }
}

function frame(opcode, data) {
  const length = data.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(length), 2); return h; })();
  return Buffer.concat([header, data]);
}

function unframe(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f, masked = buffer[1] & 0x80;
  let length = buffer[1] & 0x7f, offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const data = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= buffer[maskOffset + (i % 4)];
  return {opcode, data, length: offset + length};
}

// Starts the adapter in-process against the doubles. Returns {done, stop, logs}.
export function startAdapter({platform, runtime, telegram, discord, stateDir = tempDir(), env = {}, timing = {}}) {
  const logs = [];
  const stop = new AbortController();
  const done = runAdapter({
    argv: [platform],
    env: {
      SOOT_CHANNEL_CONTRACT: 'channel-adapter.v1',
      SOOT_CHANNEL_API: runtime.url,
      SOOT_CHANNEL_TOKEN: 'sca_fixture0000000000000000000000000000000000000',
      SOOT_CHANNEL_BINDING: platform,
      SOOT_CHANNEL_PLATFORM: platform,
      SOOT_CHANNEL_PLATFORM_TOKEN: platform === 'telegram' ? telegram.token : discord.token,
      SOOT_CHANNEL_STATE_DIR: stateDir,
      ...env,
    },
    stop: stop.signal,
    log: (event, fields) => logs.push({event, ...fields}),
    platformOptions: platform === 'telegram'
      ? {apiBase: telegram.url, pollTimeout: 0}
      : {apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl},
    timing: {backoffBase: 5, ackDelayMs: 5, silenceMs: 2000, ...timing},
  });
  return {done, stop: () => { stop.abort(); return done; }, logs, stateDir};
}
