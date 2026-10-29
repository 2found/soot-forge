import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {
  FakeRuntime, FakeTelegram, exchange, outboxItems, response, sseConnections, sseItem, startAdapter, tempDir,
  tgMessage, tgStranger, tgUser, until,
} from './helpers.mjs';

const BOT = 7012345678;
const items = Object.fromEntries(outboxItems().map(item => [item.receipt_id, item]));

async function setup(t) {
  const runtime = await new FakeRuntime().start();
  const telegram = await new FakeTelegram().start();
  t.after(async () => { await runtime.stop(); await telegram.stop(); });
  return {runtime, telegram};
}

const journal = dir => {
  try { return JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')); } catch { return {}; }
};
const streaming = runtime => until(() => runtime.openStreams.size > 0);

test('T1 happy path: pair by /start code, message, reply delivered and acked', async t => {
  const {runtime, telegram} = await setup(t);
  telegram.updates.push(tgMessage(500100, '/start K7QM-4XPA'), tgMessage(500130, 'Hôm nay đội mình tốn bao nhiêu token?'));
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  await streaming(runtime);

  const status = runtime.callsTo('/v1/channel/status').map(call => call.body);
  assert.deepEqual(status[0], {state: 'connecting', adapter_version: '0.2.0', contract_revision: 1});
  assert.deepEqual(status[1], {state: 'connected', adapter_version: '0.2.0', contract_revision: 1,
    platform_account: {id: String(BOT), username: 'shop_dau_moi_bot', display_name: 'Đầu mối của Shop'}});
  const claim = runtime.callsTo('/v1/channel/pairings/claim')[0].body;
  assert.deepEqual(claim, {request_id: `tg:${BOT}:u:500100`, sender: {id: '123456789', name: 'Lan Nguyễn', username: 'lan_ng'},
    chat: {id: '123456789', kind: 'dm'}, code: 'K7QM-4XPA'});
  assert.equal(telegram.sent()[0].params.text, response('pairing', 'pairing: owner redeems').body.reply);
  // A pairing code never goes through admission: the sender is not paired yet.
  assert.equal(runtime.callsTo('/v1/channel/admission').length, 1);
  const message = runtime.callsTo('/v1/channel/messages')[0].body;
  assert.equal(message.request_id, `tg:${BOT}:u:500130`);
  assert.equal(message.text, 'Hôm nay đội mình tốn bao nhiêu token?');

  runtime.push(items.ob_7Q2mKx81Ra);
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').length === 1);
  const reply = telegram.sent().at(-1).params;
  assert.equal(reply.parse_mode, 'HTML');
  assert.match(reply.text, /<b>182\.400 token<\/b>/);
  assert.deepEqual(runtime.callsTo('/v1/channel/outbox/ack')[0].body,
    {acks: [{receipt_id: 'ob_7Q2mKx81Ra', status: 'delivered', platform_message_ids: [String(reply.chat_id && telegram.nextMessageID - 1)]}]});
  await until(() => journal(adapter.stateDir).cursor === 41);
  assert.equal(await adapter.stop(), 0);

  const saved = readFileSync(join(adapter.stateDir, 'journal.json'), 'utf8');
  assert.doesNotMatch(saved, /token|Hôm nay|K7QM/i, 'journal holds ids only');
  assert.equal(statSync(adapter.stateDir).mode & 0o777, 0o700);
  assert.equal(journal(adapter.stateDir).offset, 500131);
});

test('T1 stranger: one fixed notice, then silence, and no host message call', async t => {
  const {runtime, telegram} = await setup(t);
  const notices = [response('admission', 'admission: stranger in DM, first'), response('admission', 'admission: same stranger')];
  runtime.routes['POST /v1/channel/admission'] = () => notices.shift() ?? response('admission', 'admission: same stranger');
  runtime.routes['POST /v1/channel/pairings/claim'] = () => response('pairing', 'pairing: used code');
  telegram.updates.push(tgMessage(1, 'chào', {from: tgStranger}), tgMessage(2, 'có ai không', {from: tgStranger}), tgMessage(3, 'K7QM4XPA', {from: tgStranger}));
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.callsTo('/v1/channel/pairings/claim').length === 1);
  await until(() => telegram.sent().length === 2);
  assert.equal(await adapter.stop(), 0);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 0);
  // The code-looking third message is checked once (not admitted), then claimed.
  assert.equal(runtime.callsTo('/v1/channel/admission').length, 3);
  assert.deepEqual(telegram.sent().map(call => call.params.text), [
    response('admission', 'admission: stranger in DM, first').body.notice,
    response('pairing', 'pairing: used code').body.reply,
  ]);
});

test('T1: an admitted sender\'s code-shaped word ("Schedule") is a message, never a claim', async t => {
  const {runtime, telegram} = await setup(t);
  telegram.updates.push(tgMessage(600001, 'Schedule'), tgMessage(600002, '/start K7QM-4XPA'));
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1 && runtime.callsTo('/v1/channel/pairings/claim').length === 1);
  assert.equal(await adapter.stop(), 0);
  assert.equal(runtime.callsTo('/v1/channel/messages')[0].body.text, 'Schedule');
  assert.equal(runtime.callsTo('/v1/channel/pairings/claim')[0].body.code, 'K7QM-4XPA', 'an explicit /start payload still claims');
  assert.equal(runtime.callsTo('/v1/channel/admission').length, 1, 'admission is asked once for the word');
});

test('D1-shape on Telegram groups: unaddressed messages never reach the host; a mention is stripped', async t => {
  const {runtime, telegram} = await setup(t);
  const group = {id: -1001234567890, type: 'supergroup', title: 'Shop team'};
  telegram.updates.push(
    tgMessage(10, 'chuyện riêng của nhóm', {chat: group}),
    tgMessage(11, 'R2D2-C3P9', {chat: group}),
    tgMessage(12, '@shop_dau_moi_bot tóm tắt hôm qua', {chat: group, entities: [{type: 'mention', offset: 0, length: 17}]}),
    tgMessage(13, '@shop_dau_moi_bot K7QM-4XPA', {chat: group, entities: [{type: 'mention', offset: 0, length: 17}]}),
  );
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1 && telegram.sent().length === 1);
  await until(() => journal(adapter.stateDir).offset === 14);
  assert.equal(await adapter.stop(), 0);
  const admission = runtime.callsTo('/v1/channel/admission').map(call => call.body);
  assert.deepEqual(admission, [{sender: {id: '123456789', name: 'Lan Nguyễn', username: 'lan_ng'},
    chat: {id: '-1001234567890', kind: 'group', title: 'Shop team'}, addressed: true}]);
  assert.equal(runtime.callsTo('/v1/channel/messages')[0].body.text, 'tóm tắt hôm qua');
  assert.equal(runtime.callsTo('/v1/channel/pairings/claim').length, 0, 'a code in a group is never claimed');
  assert.equal(telegram.sent()[0].params.text, response('session', 'session: handshake').body.copy.pair_in_dm);
  assert.ok(!journal(adapter.stateDir).inbound[`tg:${BOT}:u:10`], 'unaddressed messages are not journaled either');
});

test('T2: approve button → answers + toast; a second press gets already_resolved; resolved edits the message', async t => {
  const {runtime, telegram} = await setup(t);
  const answers = [response('answers', 'answers: owner presses'), response('answers', 'answers: a second press')];
  runtime.routes['POST /v1/channel/answers'] = () => answers.shift();
  const press = (id, update, data) => ({update_id: update, callback_query: {id, from: tgUser, data,
    message: {message_id: 8812, chat: {id: 123456789, type: 'private'}}}});
  telegram.updates.push(press('4417081129384756', 20, 'k7Hq2Lm9Ap0Zx4'), press('4417081129384799', 21, 'r3Dw8Ns1Bv6Yt2'));
  telegram.fail.editMessageText = [{error_code: 400, description: 'Bad Request: message to edit not found'}];
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => telegram.method('answerCallbackQuery').length === 2);
  const sent = runtime.callsTo('/v1/channel/answers').map(({body}) => ({...body, sender: {id: body.sender.id}}));
  assert.deepEqual(sent, [exchange('answers', 'answers: owner presses').request.body, exchange('answers', 'answers: a second press').request.body]);
  assert.deepEqual(telegram.method('answerCallbackQuery').map(call => call.params.text),
    ['Đã duyệt. Soot Marketing chạy tiếp.', 'Mục này đã được xử lý: Duyệt và chạy.']);

  // The approval itself, then its resolution: the edit fails (message gone), so it is re-posted.
  await streaming(runtime);
  runtime.push(items.ob_9Vb3Tt20Qc);
  runtime.push(items.ob_8Rz4Xa56Gf);
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks).length === 2);
  const [approval, repost] = telegram.sent().slice(-2).map(call => call.params);
  assert.deepEqual(approval.reply_markup, {inline_keyboard: [[{text: 'Duyệt và chạy', callback_data: 'k7Hq2Lm9Ap0Zx4'}], [{text: 'Từ chối', callback_data: 'r3Dw8Ns1Bv6Yt2'}]]});
  assert.equal(telegram.method('editMessageText')[0].params.message_id, 8812);
  assert.deepEqual(telegram.method('editMessageText')[0].params.reply_markup, {inline_keyboard: []});
  assert.match(repost.text, /^Đã xử lý · Duyệt và chạy/);
  assert.equal(repost.reply_markup, undefined);
  const acks = runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks);
  assert.deepEqual(acks.map(ack => ack.status), ['delivered', 'delivered']);
  assert.equal(await adapter.stop(), 0);
});

test('T3: duplicate update keeps its request_id; restart mid-delivery never posts twice and resumes', async t => {
  const {runtime, telegram} = await setup(t);
  const stateDir = tempDir();
  const [first] = sseConnections();
  // Connection 1 delivers 41 and 42, but every ack fails: the process is stopped
  // after posting and before any ack landed.
  runtime.streams.push({body: first.body, hold: true});
  runtime.routes['POST /v1/channel/outbox/ack'] = () => ({status: 503, headers: {'retry-after': '0'}, body: {code: 'unavailable', error: 'restarting'}});
  let adapter = startAdapter({platform: 'telegram', runtime, telegram, stateDir});
  await until(() => telegram.sent().length === 2 && runtime.callsTo('/v1/channel/outbox/ack').length > 0);
  assert.equal(await adapter.stop(), 0);
  assert.equal(journal(stateDir).cursor, null, 'nothing acked → cursor stays');
  assert.deepEqual(Object.keys(journal(stateDir).receipts).sort(), ['ob_7Q2mKx81Ra', 'ob_9Vb3Tt20Qc']);

  // Restart: the host streams 41/42 again (nothing was acked). The journal answers.
  runtime.routes['POST /v1/channel/outbox/ack'] = body => ({status: 200, body: {acked_through: 42, results: body.acks.map(ack => ({receipt_id: ack.receipt_id, ok: true}))}});
  runtime.streams.push({body: first.body, hold: true});
  telegram.updates.push(tgMessage(500130, 'Hôm nay đội mình tốn bao nhiêu token?'), tgMessage(500130, 'Hôm nay đội mình tốn bao nhiêu token?'));
  adapter = startAdapter({platform: 'telegram', runtime, telegram, stateDir});
  await until(() => journal(stateDir).cursor === 42);
  await until(() => journal(stateDir).offset === 500131);
  assert.equal(telegram.sent().length, 2, 'no double post');
  const lastAck = runtime.callsTo('/v1/channel/outbox/ack').at(-1).body.acks;
  assert.deepEqual(lastAck.map(ack => [ack.receipt_id, ack.status, ack.platform_message_ids]),
    [['ob_7Q2mKx81Ra', 'delivered', ['8811']], ['ob_9Vb3Tt20Qc', 'delivered', ['8812']]]);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 1, 'a redelivered update is not sent twice');
  assert.equal(await adapter.stop(), 0);

  // Next start resumes the stream from the journal cursor.
  adapter = startAdapter({platform: 'telegram', runtime, telegram, stateDir});
  await until(() => runtime.streamRequests.length === 3);
  assert.equal(runtime.streamRequests[2].headers['last-event-id'], '42');
  assert.equal(await adapter.stop(), 0);
});

test('T3: a crash before the journal write re-sends the same request_id (host dedups)', async t => {
  const {runtime, telegram} = await setup(t);
  const stateDir = tempDir();
  let calls = 0;
  runtime.routes['POST /v1/channel/messages'] = () => (++calls === 1
    ? {status: 503, body: {code: 'unavailable', error: 'restarting', retry_after: 0}}
    : response('messages', 'messages: same update redelivered'));
  telegram.updates.push(tgMessage(500130, 'Hôm nay đội mình tốn bao nhiêu token?'));
  const adapter = startAdapter({platform: 'telegram', runtime, telegram, stateDir});
  await until(() => journal(stateDir).offset === 500131);
  assert.equal(await adapter.stop(), 0);
  const ids = runtime.callsTo('/v1/channel/messages').map(call => call.body.request_id);
  assert.deepEqual(ids, [`tg:${BOT}:u:500130`, `tg:${BOT}:u:500130`]);
});

test('T4: revoked sender is refused at once; host 403 on messages is final; notice item delivered', async t => {
  const {runtime, telegram} = await setup(t);
  const admissions = [response('admission', 'admission: paired owner'), response('admission', 'admission: revoked')];
  runtime.routes['POST /v1/channel/admission'] = () => admissions.shift();
  runtime.routes['POST /v1/channel/messages'] = () => response('messages', 'messages: pairing revoked between');
  telegram.updates.push(tgMessage(500160, 'Còn đó không?'), tgMessage(500161, 'Alo?'));
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => journal(adapter.stateDir).offset === 500162);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 1);
  assert.equal(telegram.sent().length, 0, 'no content, no notice after a revoke');
  await streaming(runtime);
  runtime.push({...items.ob_6Pd2Ze14Ki, chat: {id: '123456789', kind: 'dm'}});
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').length === 1);
  assert.equal(telegram.sent()[0].params.text, items.ob_6Pd2Ze14Ki.text);
  assert.equal(await adapter.stop(), 0);
});

test('secrets are deleted and warned about, files refused, /new resolved — none reach messages', async t => {
  const {runtime, telegram} = await setup(t);
  const copy = response('session', 'session: handshake').body.copy;
  runtime.routes['POST /v1/channel/conversations/resolve'] = () => response('resolve', 'resolve: /new');
  telegram.updates.push(
    tgMessage(30, 'key nè sk-ant-api03-' + 'FIXTUREFIXTUREFIXTUREFIXTUREFIXTUREFIXTURE00'),
    tgMessage(31, undefined, {photo: [{file_id: 'x'}], caption: 'xem ảnh này'}),
    tgMessage(32, '/new'),
    tgMessage(33, 'x'.repeat(17000)),
  );
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => telegram.sent().length === 4);
  assert.equal(await adapter.stop(), 0);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 0);
  assert.equal(telegram.method('deleteMessage')[0].params.message_id, 4430);
  assert.deepEqual(telegram.sent().map(call => call.params.text),
    [copy.secret_warning, copy.attachment_refused, response('resolve', 'resolve: /new').body.reply, copy.too_long]);
  assert.equal(runtime.callsTo('/v1/channel/conversations/resolve')[0].body.new, true);
});

test('reply to an outbox message carries reply_to.receipt_id from the journal', async t => {
  const {runtime, telegram} = await setup(t);
  runtime.routes['POST /v1/channel/messages'] = () => response('messages', 'messages: a reply to an open Decision');
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await streaming(runtime);
  runtime.push({...items.ob_9Vb3Tt20Qc, receipt_id: 'ob_3Fq9Lw0ZpA'});
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').length === 1);
  telegram.updates.push(tgMessage(500140, 'Giữ giá cũ, chỉ giảm phí ship', {reply_to_message: {message_id: 8811, from: {id: BOT, is_bot: true}}}));
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  assert.deepEqual(runtime.callsTo('/v1/channel/messages')[0].body.reply_to, {receipt_id: 'ob_3Fq9Lw0ZpA'});
  assert.equal(await adapter.stop(), 0);
});

test('unknown kind and Cần bạn outside a DM are skipped; platform failures ack as failed', async t => {
  const {runtime, telegram} = await setup(t);
  telegram.fail.sendMessage = [{error_code: 403, description: 'Forbidden: bot was blocked by the user'}, {error_code: 429, description: 'Too Many Requests', parameters: {retry_after: 3}}];
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await streaming(runtime);
  runtime.push({...items.ob_7Q2mKx81Ra, receipt_id: 'ob_future', seq: 50, kind: 'poll'});
  runtime.push({...items.ob_9Vb3Tt20Qc, receipt_id: 'ob_group', seq: 51, chat: {id: '-100', kind: 'group'}});
  runtime.push({...items.ob_7Q2mKx81Ra, receipt_id: 'ob_blocked', seq: 52});
  runtime.push({...items.ob_7Q2mKx81Ra, receipt_id: 'ob_limited', seq: 53});
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks).length === 4);
  const acks = runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks);
  assert.deepEqual(acks, [
    {receipt_id: 'ob_future', status: 'skipped'},
    {receipt_id: 'ob_group', status: 'skipped'},
    {receipt_id: 'ob_blocked', status: 'failed', error: {code: 'telegram_403_blocked', retryable: false}},
    {receipt_id: 'ob_limited', status: 'failed', error: {code: 'telegram_429', retryable: true}},
  ]);
  assert.ok(runtime.callsTo('/v1/channel/status').some(call => call.body.state === 'degraded'));
  assert.equal(await adapter.stop(), 0);
});

test('a malformed item is acked failed for good instead of crashing the adapter', async t => {
  const {runtime, telegram} = await setup(t);
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await streaming(runtime);
  runtime.push({...items.ob_9Vb3Tt20Qc, receipt_id: 'ob_bad', seq: 60, attention: {...items.ob_9Vb3Tt20Qc.attention, choices: {}}});
  runtime.push({...items.ob_7Q2mKx81Ra, receipt_id: 'ob_after', seq: 61});
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks).length === 2);
  assert.deepEqual(runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks).map(ack => [ack.receipt_id, ack.status, ack.error?.code]),
    [['ob_bad', 'failed', 'render_failed'], ['ob_after', 'delivered', undefined]]);
  assert.equal(await adapter.stop(), 0);
});

test('exit codes: bad bot token → status + 78; contract v2 → 78; dead credential → 0; stream_taken → 0', async t => {
  const {runtime, telegram} = await setup(t);
  let adapter = startAdapter({platform: 'telegram', runtime, telegram, env: {SOOT_CHANNEL_PLATFORM_TOKEN: 'wrong'}});
  assert.equal(await adapter.done, 78);
  assert.deepEqual(runtime.callsTo('/v1/channel/status').at(-1).body, {...exchange('v1.1-status', 'status v1.1: Telegram getMe 401').request.body, adapter_version: '0.2.0'});

  runtime.routes['GET /v1/channel/session'] = () => ({status: 200, body: {contract: 'channel-adapter.v2'}});
  assert.equal(await startAdapter({platform: 'telegram', runtime, telegram}).done, 78);
  assert.equal(await startAdapter({platform: 'telegram', runtime, telegram, env: {SOOT_CHANNEL_CONTRACT: 'channel-adapter.v2'}}).done, 78);
  assert.equal(await startAdapter({platform: 'discord', runtime, telegram, discord: {token: 'x'}, env: {SOOT_CHANNEL_PLATFORM: 'telegram'}}).done, 78);

  runtime.routes['GET /v1/channel/session'] = () => response('errors', 'errors: credential of a stopped process');
  assert.equal(await startAdapter({platform: 'telegram', runtime, telegram}).done, 0);

  runtime.routes['GET /v1/channel/session'] = () => response('session', 'session: handshake');
  runtime.streams.push({status: 409, json: {code: 'stream_taken', error: 'another adapter process holds this binding\'s stream'}});
  adapter = startAdapter({platform: 'telegram', runtime, telegram});
  assert.equal(await adapter.done, 0);
  assert.ok(adapter.logs.some(log => log.event === 'exit' && log.detail === 'stream_taken'));
  assert.ok(!JSON.stringify(adapter.logs).includes(telegram.token), 'tokens never logged');
});

test('stream: reconnects with Last-Event-ID after the host closes it and after silence', async t => {
  const {runtime, telegram} = await setup(t);
  runtime.streams.push({body: ': connected\n\n' + sseItem(items.ob_7Q2mKx81Ra)});      // closed by the host
  runtime.streams.push({body: ': connected\n\n', hold: true});                          // then silent
  const adapter = startAdapter({platform: 'telegram', runtime, telegram, timing: {silenceMs: 150}});
  await until(() => runtime.streamRequests.length >= 3, 4000);
  assert.equal(runtime.streamRequests[0].headers['last-event-id'], undefined);
  assert.equal(runtime.streamRequests[2].headers['last-event-id'], '41');
  assert.ok(adapter.logs.some(log => log.event === 'outbox_silence'));
  assert.equal(await adapter.stop(), 0);
});
