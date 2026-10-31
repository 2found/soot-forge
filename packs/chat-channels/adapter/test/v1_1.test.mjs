// channel-adapter v1.1 (§9): questions in place, asker-only refusals, the §9.6 outbox
// lock and §9.4 status reasons, against the v1.1-*.json fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import {CONTRACT_REVISION} from '../core/main.mjs';
import {
  FakeDiscord, FakeRuntime, FakeTelegram, exchange, fixture, outboxItems, startAdapter, tgUser, until,
} from './helpers.mjs';

const APP = '1100220033004400';
const BOT = '1100220033004400999';
const GUILD = '1277777777777777777';
const CHANNEL = '1288888888888888888';
const MINH = {id: '223344556677889900', username: 'minh'};
const LAN = {id: '334455667788990011', username: 'Lan'};
const GUEST = {id: '445566778899001122', username: 'khách'};
const REFUSAL = 'Chỉ người hỏi mới trả lời được câu này.';

const v11 = Object.fromEntries(['v1.1-group', 'v1.1-not-ready']
  .flatMap(file => fixture(file)).flatMap(entry => entry.response?.body?.items ?? []).map(item => [item.receipt_id, item]));
const v10 = Object.fromEntries(outboxItems().map(item => [item.receipt_id, item]));
const route = (file, name) => () => exchange(file, name).response;
const acks = runtime => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks);
const withoutName = body => ({...body, sender: {id: body.sender.id}});

async function discordSetup(t) {
  const runtime = await new FakeRuntime().start();
  const discord = await new FakeDiscord({botID: BOT, applicationID: APP}).start();
  t.after(async () => { await runtime.stop(); await discord.stop(); });
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await until(() => discord.received.some(payload => payload.op === 2));
  discord.dispatch('READY', {session_id: 'sess-1', resume_gateway_url: discord.gatewayUrl, user: {id: BOT}, application: {id: APP}});
  await until(() => runtime.callsTo('/v1/channel/status').length >= 2 && runtime.openStreams.size > 0);
  return {runtime, discord, adapter};
}

const press = (id, user, custom_id, messageID = '1300000000000000061') => ({id, type: 3, token: `itok-${id}`, application_id: APP,
  guild_id: GUILD, channel_id: CHANNEL, member: {user}, data: {custom_id}, message: {id: messageID}});
const guildMessage = (id, author, content, replyTo) => ({id, channel_id: CHANNEL, guild_id: GUILD, author, content, mentions: [],
  attachments: [], referenced_message: {author: {id: BOT}}, message_reference: {message_id: replyTo}});
const toasts = discord => discord.callsMatching('PATCH', /^\/webhooks\//).map(call => call.body.content);
const posts = discord => discord.callsMatching('POST', /^\/channels\/\d+\/messages$/).map(call => call.body);

test('guild question: threaded under the asker, asker presses → applied, resolved edits the channel message', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  runtime.routes['POST /v1/channel/admission'] = route('v1.1-asker', 'asker: the asker presses a button');
  runtime.routes['POST /v1/channel/answers'] = route('v1.1-asker', 'asker: the asker presses Zalo');
  discord.nextMessageID = 1300000000000000061n;
  runtime.push(v11.ob_Gq1Ask0061);
  await until(() => acks(runtime).length === 1);
  const [question] = posts(discord);
  assert.equal(discord.callsMatching('POST', /^\/channels\//)[0].path, `/channels/${CHANNEL}/messages`);
  assert.deepEqual(question.message_reference, {message_id: '1300000000000000042', fail_if_not_exists: false});
  assert.deepEqual(question.allowed_mentions, {parse: [], replied_user: true});
  assert.deepEqual(question.components[0].components.map(button => button.custom_id), ['q1FbTk7Lm2Nx4P', 'q1ZlTk3Rb8Vd6W']);
  assert.deepEqual(acks(runtime)[0], {receipt_id: 'ob_Gq1Ask0061', status: 'delivered', platform_message_ids: ['1300000000000000061']});

  discord.dispatch('INTERACTION_CREATE', press('1320000000000000002', MINH, 'q1ZlTk3Rb8Vd6W'));
  await until(() => toasts(discord).length === 1);
  assert.deepEqual(withoutName(runtime.callsTo('/v1/channel/admission')[0].body), exchange('v1.1-asker', 'asker: the asker presses a button').request.body);
  assert.deepEqual(runtime.callsTo('/v1/channel/answers').map(call => withoutName(call.body)), [exchange('v1.1-asker', 'asker: the asker presses Zalo').request.body]);
  assert.deepEqual(toasts(discord), ['Đã trả lời: Zalo.']);

  runtime.push(v11.ob_Rs1Gld0066);
  await until(() => acks(runtime).length === 2);
  const edit = discord.callsMatching('PATCH', /^\/channels\//)[0];
  assert.equal(edit.path, `/channels/${CHANNEL}/messages/1300000000000000061`);
  assert.deepEqual(edit.body.components, []);
  assert.match(edit.body.content, /^Đã trả lời · Zalo/);
  assert.equal(posts(discord).length, 1, 'edited in place, not re-posted');
  assert.equal(await adapter.stop(), 0);
  for (const call of runtime.callsTo('/v1/channel/status')) assert.equal(call.body.contract_revision, CONTRACT_REVISION, call.body.state);
});

test('guild presses: another paired user → ephemeral refusal; unpaired → admission toast, no #10 call', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  runtime.routes['POST /v1/channel/admission'] = body => body.sender.id === GUEST.id
    ? exchange('v1.1-asker', 'asker: an unpaired user presses').response : {status: 200, body: {admitted: true}};
  runtime.routes['POST /v1/channel/answers'] = route('v1.1-asker', 'asker: another paired user');
  discord.dispatch('INTERACTION_CREATE', press('1320000000000000001', LAN, 'q1ZlTk3Rb8Vd6W'));
  await until(() => toasts(discord).length === 1);
  discord.dispatch('INTERACTION_CREATE', press('1320000000000000003', GUEST, 'q1ZlTk3Rb8Vd6W'));
  await until(() => toasts(discord).length === 2);
  assert.deepEqual(toasts(discord), [REFUSAL, REFUSAL]);
  // Every press is deferred as ephemeral (flags 64), so the toast is the presser's only.
  assert.deepEqual(discord.callsMatching('POST', /^\/interactions\//).map(call => call.body), [{type: 5, data: {flags: 64}}, {type: 5, data: {flags: 64}}]);
  assert.equal(runtime.callsTo('/v1/channel/answers').length, 1, 'the unpaired press never reaches #10');
  assert.deepEqual(runtime.callsTo('/v1/channel/answers')[0].body.request_id, `dc:${APP}:i:1320000000000000001`);
  const unpaired = runtime.callsTo('/v1/channel/admission').at(-1).body;
  assert.deepEqual({...unpaired, sender: {id: unpaired.sender.id, name: 'khách'}}, exchange('v1.1-asker', 'asker: an unpaired user presses').request.body);
  assert.equal(posts(discord).length, 0, 'nothing posted in the channel');
  assert.equal(await adapter.stop(), 0);
});

test('typed replies to a channel question: non-asker refused once, threaded; asker answers; unpaired silent', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  runtime.routes['POST /v1/channel/admission'] = body => body.sender.id === GUEST.id
    ? exchange('v1.1-asker', 'asker: an unpaired user replies').response : {status: 200, body: {admitted: true}};
  const replies = [exchange('v1.1-asker', 'asker: a paired non-asker').response, exchange('v1.1-asker', 'asker: the same non-asker').response,
    exchange('v1.1-asker', 'asker: the asker replies').response];
  runtime.routes['POST /v1/channel/messages'] = () => replies.shift();
  discord.nextMessageID = 1300000000000000071n;
  runtime.push({...v11.ob_Gq1Ask0061, receipt_id: 'ob_Gq2Ask0071', seq: 71});
  await until(() => acks(runtime).length === 1);

  discord.dispatch('MESSAGE_CREATE', guildMessage('1300000000000000090', LAN, 'Chọn khách sỉ', '1300000000000000071'));
  discord.dispatch('MESSAGE_CREATE', guildMessage('1300000000000000091', LAN, 'Khách sỉ nhé', '1300000000000000071'));
  discord.dispatch('MESSAGE_CREATE', guildMessage('1300000000000000092', MINH, 'Khách lẻ trước', '1300000000000000071'));
  discord.dispatch('MESSAGE_CREATE', guildMessage('1300000000000000093', GUEST, 'tôi chọn', '1300000000000000071'));
  await until(() => runtime.callsTo('/v1/channel/admission').length === 4);
  await until(() => posts(discord).length === 2);
  const sent = runtime.callsTo('/v1/channel/messages').map(call => withoutName(call.body));
  assert.deepEqual(sent, ['asker: a paired non-asker', 'asker: the same non-asker', 'asker: the asker replies']
    .map(name => withoutName(exchange('v1.1-asker', name).request.body)));
  const refusal = posts(discord)[1];
  assert.equal(refusal.content, REFUSAL);
  assert.deepEqual(refusal.message_reference, {message_id: '1300000000000000090', fail_if_not_exists: false});
  assert.equal(await adapter.stop(), 0);
  assert.equal(posts(discord).length, 2, 'no second refusal, nothing for the asker or the unpaired user');
});

test('§9.6 lock: invalid approval at a guild and a guild brief are skipped unposted; pointer and not-ready notices thread', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  runtime.push(v11.ob_Bad0Apr070);
  runtime.push({...v10.ob_1Mb6Yd90Hg, receipt_id: 'ob_GuildBrief', seq: 90, chat: {id: CHANNEL, kind: 'guild_channel', guild_id: GUILD}});
  runtime.push({...v11.ob_Gq1Ask0061, receipt_id: 'ob_NoAsker', seq: 91, attention: {...v11.ob_Gq1Ask0061.attention, asker: undefined}});
  runtime.push(v11.ob_Pt1Own0064);
  runtime.push(v11.ob_Nr2Gld0073);
  await until(() => acks(runtime).length === 5);
  assert.deepEqual(acks(runtime).map(ack => [ack.receipt_id, ack.status]), [
    ['ob_Bad0Apr070', 'skipped'], ['ob_GuildBrief', 'skipped'], ['ob_NoAsker', 'skipped'],
    ['ob_Pt1Own0064', 'delivered'], ['ob_Nr2Gld0073', 'delivered']]);
  const [pointer, notReady] = posts(discord);
  assert.equal(posts(discord).length, 2);
  assert.equal(pointer.content, 'Mình đã nhắn riêng để xin bạn duyệt.');
  assert.deepEqual(pointer.message_reference, {message_id: '1300000000000000077', fail_if_not_exists: false});
  assert.equal(pointer.components, undefined);
  assert.deepEqual(notReady.message_reference, {message_id: '1300000000000000100', fail_if_not_exists: false});
  assert.equal(await adapter.stop(), 0);
});

async function telegramSetup(t) {
  const runtime = await new FakeRuntime().start();
  const telegram = await new FakeTelegram().start();
  t.after(async () => { await runtime.stop(); await telegram.stop(); });
  return {runtime, telegram};
}

test('Telegram group decision: threaded with reply_parameters; a refused press is answered by answerCallbackQuery', async t => {
  const {runtime, telegram} = await telegramSetup(t);
  runtime.routes['POST /v1/channel/admission'] = () => ({status: 200, body: {admitted: false, reason: 'unpaired', toast: REFUSAL}});
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.openStreams.size > 0);
  runtime.push(v11.ob_Dc1Tgr0062);
  await until(() => acks(runtime).length === 1);
  const decision = telegram.sent()[0].params;
  assert.equal(decision.chat_id, '-1001234567890');
  assert.deepEqual(decision.reply_parameters, {message_id: 5120, allow_sending_without_reply: true});
  assert.deepEqual(decision.reply_markup.inline_keyboard.flat().map(button => button.callback_data), ['d4Ab6Cd8Ef0Gh2', 'd4Ij1Kl3Mn5Op7']);

  telegram.updates.push({update_id: 30, callback_query: {id: '4417081129300001', from: {...tgUser, id: 555}, data: 'd4Ab6Cd8Ef0Gh2',
    message: {message_id: 8811, chat: {id: -1001234567890, type: 'supergroup', title: 'Shop team'}}}});
  await until(() => telegram.method('answerCallbackQuery').length === 1);
  assert.equal(telegram.method('answerCallbackQuery')[0].params.text, REFUSAL);
  assert.equal(runtime.callsTo('/v1/channel/admission')[0].body.button, true);
  assert.equal(runtime.callsTo('/v1/channel/answers').length, 0);
  assert.equal(telegram.sent().length, 1, 'nothing posted in the group');
  assert.equal(await adapter.stop(), 0);
});

test('Telegram getUpdates 409: webhook and other poller → degraded with their reason, still polling', async t => {
  const {runtime, telegram} = await telegramSetup(t);
  telegram.fail.getUpdates = [
    {error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first'},
    {error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'},
  ];
  telegram.updates.push({update_id: 40, message: {message_id: 4440, from: tgUser, chat: {id: tgUser.id, type: 'private'}, date: 1, text: 'chào'}});
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  const degraded = runtime.callsTo('/v1/channel/status').map(call => call.body).filter(body => body.state === 'degraded');
  const pick = ({state, reason, detail, contract_revision}) => ({state, reason, detail, contract_revision});
  // The v1.1 fixtures were recorded from a revision-1 adapter; this one declares its own.
  assert.deepEqual(degraded.map(pick), [
    exchange('v1.1-status', 'status v1.1: Telegram getUpdates 409, a webhook').request.body,
    exchange('v1.1-status', 'status v1.1: Telegram getUpdates 409, another program').request.body]
    .map(body => ({...body, contract_revision: CONTRACT_REVISION})));
  assert.equal(runtime.callsTo('/v1/channel/status').at(-1).body.state, 'connected');
  assert.equal(await adapter.stop(), 0);
});
