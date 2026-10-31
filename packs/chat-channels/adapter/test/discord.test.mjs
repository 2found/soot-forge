import assert from 'node:assert/strict';
import test from 'node:test';
import {CONTRACT_REVISION, VERSION} from '../core/main.mjs';
import {Discord, INTENTS} from '../platform/discord.mjs';
import {FakeDiscord, FakeRuntime, exchange, outboxItems, response, sseConnections, startAdapter, until} from './helpers.mjs';

const APP = '1100220033004400';
const BOT = '1100220033004400999';
const MEMBER = {id: '223344556677889900', username: 'minh'};
const GUILD = '1277777777777777777';
const CHANNEL = '1288888888888888888';
const DM = '1299999999999999999';
const items = Object.fromEntries(outboxItems().map(item => [item.receipt_id, item]));

function discordUnit() {
  const discord = new Discord({token: 't'});
  discord.me = {id: BOT};
  discord.applicationID = APP;
  return discord;
}

const message = (id, content, extra = {}) => ({id, channel_id: CHANNEL, guild_id: GUILD, author: MEMBER, content, mentions: [], attachments: [], ...extra});

test('message mapping: DM, unmentioned guild, mention stripped, reply to the bot, thread, slash text, files', () => {
  const discord = discordUnit();
  const dm = discord.eventFromMessage({id: '1300000000000000001', channel_id: DM, author: MEMBER, content: 'HJKL-MNPQ'});
  assert.deepEqual([dm.requestID, dm.chat, dm.addressed, dm.text], [`dc:${APP}:m:1300000000000000001`, {id: DM, kind: 'dm'}, true, 'HJKL-MNPQ']);
  assert.equal(discord.eventFromMessage(message('1', 'chuyện nhóm')).addressed, false);
  const mention = discord.eventFromMessage(message('1300000000000000042', `<@${BOT}> Tóm tắt giúp mình việc hôm qua`, {mentions: [{id: BOT}]}));
  assert.deepEqual([mention.addressed, mention.text, mention.chat], [true, 'Tóm tắt giúp mình việc hôm qua', {id: CHANNEL, kind: 'guild_channel', guild_id: GUILD}]);
  const reply = discord.eventFromMessage(message('2', 'đồng ý', {referenced_message: {author: {id: BOT}}, message_reference: {message_id: '1400000000000000001'}}));
  assert.deepEqual([reply.addressed, reply.replyToMessageID], [true, '1400000000000000001']);
  discord.channelTypes.set('555', 11);
  assert.equal(discord.eventFromMessage(message('3', 'x', {channel_id: '555'})).chat.kind, 'thread');
  const slash = discord.eventFromMessage({id: '4', channel_id: DM, author: MEMBER, content: '/new'});
  assert.deepEqual([slash.command, slash.text], ['new', '']);
  assert.equal(discord.eventFromMessage({id: '5', channel_id: DM, author: MEMBER, content: '', attachments: [{id: 'a'}]}).attachment, true);
  assert.equal(discord.eventFromMessage({id: '6', channel_id: DM, author: {id: '9', bot: true}, content: 'x'}), null);
  const press = discord.eventFromInteraction({id: '1311111111111111111', type: 3, token: 'itok', channel_id: DM, user: MEMBER, data: {custom_id: 'p9Ux1Ke4Wq7Mn3'}});
  assert.deepEqual([press.requestID, press.button, press.chat], [`dc:${APP}:i:1311111111111111111`, 'p9Ux1Ke4Wq7Mn3', {id: DM, kind: 'dm'}]);
});

async function setup(t) {
  const runtime = await new FakeRuntime().start();
  const discord = await new FakeDiscord({botID: BOT, applicationID: APP}).start();
  t.after(async () => { await runtime.stop(); await discord.stop(); });
  return {runtime, discord};
}

async function ready(discord, runtime) {
  await until(() => discord.received.some(payload => payload.op === 2));
  discord.dispatch('READY', {session_id: 'sess-1', resume_gateway_url: discord.gatewayUrl, user: {id: BOT}, application: {id: APP}});
  await until(() => runtime.callsTo('/v1/channel/status').length >= 2 && runtime.openStreams.size > 0);
}

test('D1/D2 happy path: guild mention → message; button → deferred toast; reply threaded with no pings', async t => {
  const {runtime, discord} = await setup(t);
  runtime.routes['POST /v1/channel/messages'] = () => response('messages', 'messages: guild mention');
  runtime.routes['POST /v1/channel/answers'] = () => response('answers', 'answers: the owner already answered in Nest');
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await ready(discord, runtime);
  const identify = discord.received.find(payload => payload.op === 2).d;
  assert.equal(identify.token, discord.token);
  assert.equal(identify.intents, INTENTS);
  assert.equal(INTENTS & (1 << 15), 1 << 15, 'Message Content intent');

  discord.dispatch('MESSAGE_CREATE', message('1299', 'không gọi bot'));
  discord.dispatch('MESSAGE_CREATE', message('1300000000000000042', `<@${BOT}> Tóm tắt giúp mình việc hôm qua`, {mentions: [{id: BOT}]}));
  discord.dispatch('INTERACTION_CREATE', {id: '1311111111111111111', type: 3, token: 'itok', application_id: APP, channel_id: DM, user: MEMBER, data: {custom_id: 'p9Ux1Ke4Wq7Mn3'}, message: {id: '1400000000000000001'}});
  await until(() => discord.callsMatching('PATCH', /^\/webhooks\//).length === 1);
  const sent = runtime.callsTo('/v1/channel/messages').map(call => call.body);
  assert.deepEqual(sent, [{...exchange('messages', 'messages: guild mention').request.body, sender: {id: MEMBER.id, name: 'minh', username: 'minh'}}]);
  assert.equal(runtime.callsTo('/v1/channel/admission').length, 2, 'the unmentioned message never reached the host');
  assert.deepEqual(discord.callsMatching('POST', /^\/interactions\//)[0], {method: 'POST', path: '/interactions/1311111111111111111/itok/callback', body: {type: 5, data: {flags: 64}}});
  assert.deepEqual(discord.callsMatching('PATCH', /^\/webhooks\//)[0].body.content, 'Đã được xử lý trong Nest: Bỏ.');

  const [, , , redelivery] = sseConnections();
  runtime.push(JSON.parse(redelivery.body.match(/^data: (.*)$/m)[1]));
  runtime.push({...items.ob_9Vb3Tt20Qc, chat: {id: DM, kind: 'dm'}});
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks).length === 2);
  const [reply, approval] = discord.callsMatching('POST', /^\/channels\/\d+\/messages$/).map(call => call.body);
  assert.deepEqual(reply.message_reference, {message_id: '1300000000000000042', fail_if_not_exists: false});
  assert.deepEqual(reply.allowed_mentions, {parse: [], replied_user: true}, 'pings only the person it answers');
  assert.deepEqual(approval.components, [{type: 1, components: [
    {type: 2, style: 1, label: 'Duyệt và chạy', custom_id: 'k7Hq2Lm9Ap0Zx4'},
    {type: 2, style: 4, label: 'Từ chối', custom_id: 'r3Dw8Ns1Bv6Yt2'}]}]);
  assert.equal(await adapter.stop(), 0);
});

test('D1: a pairing code in a guild is never claimed and is answered in DM; in DM it is claimed', async t => {
  const {runtime, discord} = await setup(t);
  runtime.routes['POST /v1/channel/pairings/claim'] = () => response('pairing', 'pairing: sender already paired');
  // Not admitted yet, so the code-shaped DM is a claim (an admitted sender's would be a message).
  runtime.routes['POST /v1/channel/admission'] = () => response('admission', 'admission: same stranger');
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await ready(discord, runtime);
  discord.dispatch('MESSAGE_CREATE', message('7', `<@${BOT}> HJKL-MNPQ`, {mentions: [{id: BOT}]}));
  discord.dispatch('MESSAGE_CREATE', {id: '1300000000000000001', channel_id: DM, author: MEMBER, content: 'HJKL-MNPQ'});
  await until(() => discord.callsMatching('POST', /^\/channels\/\d+\/messages$/).length === 2);
  const posts = discord.callsMatching('POST', /^\/channels\/\d+\/messages$/);
  const copy = response('session', 'session: handshake').body.copy;
  assert.deepEqual(posts.map(call => [call.path, call.body.content]), [
    [`/channels/${DM}/messages`, copy.pair_in_dm],
    [`/channels/${DM}/messages`, response('pairing', 'pairing: sender already paired').body.reply],
  ]);
  assert.equal(discord.callsMatching('POST', /^\/users\/@me\/channels$/)[0].body.recipient_id, MEMBER.id);
  assert.deepEqual(runtime.callsTo('/v1/channel/pairings/claim').map(call => call.body.request_id), [`dc:${APP}:m:1300000000000000001`]);
  assert.equal(await adapter.stop(), 0);
});

test('D3: a dropped Gateway resumes the same session; a redelivered message is not sent twice', async t => {
  const {runtime, discord} = await setup(t);
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await ready(discord, runtime);
  const dm = {id: '1300000000000000077', channel_id: DM, author: MEMBER, content: 'Còn đó không?'};
  discord.dispatch('MESSAGE_CREATE', dm);
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  discord.last.close(4000);
  await until(() => discord.received.some(payload => payload.op === 6));
  assert.deepEqual(discord.received.find(payload => payload.op === 6).d, {token: discord.token, session_id: 'sess-1', seq: discord.seq});
  discord.dispatch('RESUMED', {});
  discord.dispatch('MESSAGE_CREATE', dm);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 1);
  assert.equal(await adapter.stop(), 0);
});

test('D4: revoked → nothing sent; a secret in a DM is warned about (Discord cannot delete it); file refused', async t => {
  const {runtime, discord} = await setup(t);
  const admissions = [response('admission', 'admission: revoked'), response('admission', 'admission: paired owner'), response('admission', 'admission: paired owner')];
  runtime.routes['POST /v1/channel/admission'] = () => admissions.shift();
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await ready(discord, runtime);
  discord.dispatch('MESSAGE_CREATE', {id: '11', channel_id: DM, author: MEMBER, content: 'Alo?'});
  discord.dispatch('MESSAGE_CREATE', {id: '12', channel_id: DM, author: MEMBER, content: 'xoxb-' + 'FIXTURE-FIXTURE-0000'});
  discord.dispatch('MESSAGE_CREATE', {id: '13', channel_id: DM, author: MEMBER, content: '', attachments: [{id: 'f'}]});
  await until(() => discord.callsMatching('POST', /^\/channels\/\d+\/messages$/).length === 2);
  const copy = response('session', 'session: handshake').body.copy;
  assert.deepEqual(discord.callsMatching('POST', /^\/channels\/\d+\/messages$/).map(call => call.body.content), [copy.secret_warning, copy.attachment_refused]);
  assert.equal(discord.calls.filter(call => call.method === 'DELETE').length, 0);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 0);
  assert.equal(await adapter.stop(), 0);
});

test('D2: resolved edits drop the buttons; a long reply is cut to 2000 with the Nest link', async t => {
  const {runtime, discord} = await setup(t);
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await ready(discord, runtime);
  runtime.push({...items.ob_8Rz4Xa56Gf, chat: {id: DM, kind: 'dm'}});
  runtime.push({...items.ob_4Tg7Ub22Lj, text: 'Hôm qua đội làm 12 việc. '.repeat(200)});
  await until(() => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks).length === 2);
  const edit = discord.callsMatching('PATCH', /^\/channels\//)[0];
  assert.equal(edit.path, `/channels/${DM}/messages/8812`);
  assert.deepEqual(edit.body.components, []);
  const long = discord.callsMatching('POST', /^\/channels\/\d+\/messages$/)[0].body.content;
  assert.ok(long.length <= 2000);
  assert.match(long, /https:\/\/nest\.shop\.example\/chat\/c\/9f3a1c7e2b/);
  assert.equal(await adapter.stop(), 0);
});

test('Gateway close 4004/4014/4011/4012 → the §9.4 reason + exit 78', async t => {
  for (const [code, name] of [[4004, 'Discord close 4004'], [4014, 'Discord close 4014'], [4011, 'Discord close 4011'], [4012, 'Discord close 4012']]) {
    const {runtime, discord} = await setup(t);
    const adapter = startAdapter({platform: 'discord', runtime, discord});
    await until(() => discord.received.some(payload => payload.op === 2));
    discord.last.close(code);
    assert.equal(await adapter.done, 78);
    assert.deepEqual(runtime.callsTo('/v1/channel/status').at(-1).body, {...exchange('v1.1-status', `status v1.1: ${name}`).request.body,
      adapter_version: VERSION, contract_revision: CONTRACT_REVISION, platform_account: {id: BOT, username: 'dau-moi', display_name: 'Đầu mối'}}, `close ${code}`);
  }
  const {runtime, discord} = await setup(t);
  assert.equal(await startAdapter({platform: 'discord', runtime, discord: {...discord, token: 'wrong'}}).done, 78);
});
