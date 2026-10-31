// channel-adapter v1.2 (§10, contract_revision 2): anyone admitted, the limit notices,
// one place per chat, the owner chat (claim, items, presses, left) and member counts,
// against the v1.2-*.json fixtures. A revision-1 host (no `places` in its session) gets
// exactly the v1.1 behaviour.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {CONTRACT_REVISION, VERSION} from '../core/main.mjs';
import {FakeDiscord, FakeRuntime, FakeTelegram, exchange, fixture, startAdapter, until} from './helpers.mjs';

const TG_BOT = 7012345678;
const BOT_NAME = 'shop_dau_moi_bot';
const APP = '1100220033004400';
const DC_BOT = '1100220033004400999';
const GUILD = '1277777777777777777';
const CHANNEL = '1288888888888888888';
const OPS = {id: -1009876543210, type: 'group', title: 'Đội vận hành'};
const TEST_GROUP = {id: -1004444444444, type: 'supergroup', title: 'Nhóm thử'};
const SHOP = {id: -1001234567890, type: 'supergroup', title: 'Shop team'};
const OWNER = {id: 123456789, is_bot: false, first_name: 'Chủ shop'};
const LAN = {id: 5566778899, is_bot: false, first_name: 'Lan'};
const KHOA = {id: 7788990011, is_bot: false, first_name: 'Khoa'};
const STRANGER = {id: 987654321, is_bot: false, first_name: 'Người lạ'};
const HUNG = {id: '556677889900112233', username: 'hung.dev', global_name: 'Hùng'};
const MINH = {id: '223344556677889900', global_name: 'minh'};
const NOT_AUTHORIZED = 'Bạn không có quyền xử lý việc này.';

const ex = (file, name) => exchange(`v1.2-${file}`, name);
const route = (file, name) => () => ex(file, name).response;
const v12 = Object.fromEntries(['admission', 'places', 'owner-chat', 'targeting', 'compat']
  .flatMap(file => fixture(`v1.2-${file}`)).flatMap(entry => entry.response?.body?.items ?? []).map(item => [item.receipt_id, item]));
const acks = runtime => runtime.callsTo('/v1/channel/outbox/ack').flatMap(call => call.body.acks);
const bodies = (runtime, path) => runtime.callsTo(path).map(call => call.body);
const SESSION = 'GET /v1/channel/session';

// Fixtures show the optional display fields only where they illustrate something; the
// adapter may send them on any request (§3, §10.11). Everything else is the fixture.
const OPTIONAL = new Set(['name', 'username', 'title', 'member_count']);
function fit(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) || !expected || typeof expected !== 'object') return actual;
  const out = {};
  for (const [key, value] of Object.entries(actual)) if (key in expected || !OPTIONAL.has(key)) out[key] = fit(value, expected[key]);
  return out;
}
const assertFits = (actual, expected, message) => assert.deepEqual(fit(actual, expected), expected, message);

async function telegramSetup(t, {places = true} = {}) {
  const runtime = await new FakeRuntime().start();
  const telegram = await new FakeTelegram().start();
  t.after(async () => { await runtime.stop(); await telegram.stop(); });
  if (places) runtime.routes[SESSION] = route('owner-chat', 'owner chat: the session');
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => runtime.openStreams.size > 0);
  return {runtime, telegram, adapter};
}

let nextGroupMessage = 7100;
// A Telegram group message; `mention` appends "@bot" after the text, as in #chat-owner-claim.
function tgGroup(updateID, text, {from, chat, mention = false, ...rest}) {
  const entities = [];
  if (text.startsWith('/')) entities.push({type: 'bot_command', offset: 0, length: text.split(' ')[0].length});
  if (mention) {
    text += ` @${BOT_NAME}`;
    entities.push({type: 'mention', offset: text.length - BOT_NAME.length - 1, length: BOT_NAME.length + 1});
  }
  return {update_id: updateID, message: {message_id: ++nextGroupMessage, from, chat, date: 1, text, entities, ...rest}};
}
const tgPress = (id, from, data, chat, messageID = 8811) => ({update_id: Number(String(id).slice(-6)), callback_query: {
  id: String(id), from, data, message: {message_id: messageID, chat}}});
const sent = telegram => telegram.sent().map(call => call.params);

async function discordSetup(t, {places = true} = {}) {
  const runtime = await new FakeRuntime().start();
  const discord = await new FakeDiscord({botID: DC_BOT, applicationID: APP}).start();
  t.after(async () => { await runtime.stop(); await discord.stop(); });
  if (places) runtime.routes[SESSION] = route('owner-chat', 'owner chat: the session');
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await until(() => discord.received.some(payload => payload.op === 2));
  discord.dispatch('READY', {session_id: 'sess-1', resume_gateway_url: discord.gatewayUrl, user: {id: DC_BOT}, application: {id: APP}});
  await until(() => runtime.callsTo('/v1/channel/status').length >= 2 && runtime.openStreams.size > 0);
  return {runtime, discord, adapter};
}
const dcMention = (id, author, content) => ({id, channel_id: CHANNEL, guild_id: GUILD, author, content: `<@${DC_BOT}> ${content}`,
  mentions: [{id: DC_BOT}], attachments: []});
const dcPress = (id, user, custom_id) => ({id, type: 3, token: `itok-${id}`, application_id: APP, guild_id: GUILD, channel_id: CHANNEL,
  member: {user}, data: {custom_id}, message: {id: '1300000000000000061'}});
const posts = discord => discord.callsMatching('POST', /^\/channels\/\d+\/messages$/).map(call => call.body);

test('status: every report declares contract_revision 2 and adapter 0.3.0 (§10.1)', async t => {
  const {runtime, adapter} = await telegramSetup(t);
  const expected = ex('compat', 'compat v1.2: a revision-2 adapter').request.body;
  assert.equal(CONTRACT_REVISION, expected.contract_revision);
  assert.equal(VERSION, expected.adapter_version);
  await until(() => bodies(runtime, '/v1/channel/status').some(body => body.state === 'connected'));
  const connected = bodies(runtime, '/v1/channel/status').find(body => body.state === 'connected');
  assert.deepEqual(Object.keys(connected).sort(), Object.keys(expected).sort());
  for (const body of bodies(runtime, '/v1/channel/status')) assert.equal(body.contract_revision, 2, body.state);
  assert.equal(await adapter.stop(), 0);
});

test('SF-1: unlinked and linked speakers in one guild channel are admitted and both messages go to the place; /new there → threaded new_dm_only', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  discord.dispatch('GUILD_CREATE', {id: GUILD, member_count: 240, channels: [{id: CHANNEL, type: 0, name: 'help'}]});
  runtime.routes['POST /v1/channel/admission'] = body => body.sender.id === HUNG.id
    ? ex('admission', 'v1.2 admission: an unlinked user mentions').response
    : ex('admission', 'v1.2 admission: a linked member in the same guild').response;
  const accepted = [ex('places', 'v1.2 places: Hùng\'s message').response, ex('places', 'v1.2 places: minh\'s message').response];
  runtime.routes['POST /v1/channel/messages'] = () => accepted.shift();
  runtime.routes['POST /v1/channel/conversations/resolve'] = route('places', 'v1.2 places: /new in a group');
  discord.dispatch('MESSAGE_CREATE', dcMention('1310000000000000003', HUNG, 'Bot ơi, gói Pro có xuất hoá đơn không?'));
  discord.dispatch('MESSAGE_CREATE', dcMention('1310000000000000004', MINH, 'Mình cũng muốn biết hạn thanh toán.'));
  discord.dispatch('MESSAGE_CREATE', dcMention('1310000000000000005', MINH, '/new'));
  await until(() => posts(discord).length === 1);

  const [hung, minh] = bodies(runtime, '/v1/channel/admission');
  assertFits(hung, ex('admission', 'v1.2 admission: an unlinked user mentions').request.body);
  assert.deepEqual(hung.chat, {id: CHANNEL, kind: 'guild_channel', guild_id: GUILD, title: '#help', member_count: 240});
  assertFits(minh, ex('admission', 'v1.2 admission: a linked member in the same guild').request.body);
  const messages = bodies(runtime, '/v1/channel/messages');
  assertFits(messages[0], ex('places', 'v1.2 places: Hùng\'s message').request.body);
  assertFits(messages[1], ex('places', 'v1.2 places: minh\'s message').request.body);
  assert.equal(messages[0].chat.member_count, undefined, 'member_count only on admission and claim');
  assertFits(bodies(runtime, '/v1/channel/conversations/resolve')[0], ex('places', 'v1.2 places: /new in a group').request.body);

  const [refusal] = posts(discord);
  assert.equal(refusal.content, 'Lệnh /new chỉ dùng được trong tin nhắn riêng với bot.');
  assert.deepEqual(refusal.message_reference, {message_id: '1310000000000000005', fail_if_not_exists: false});
  assert.equal(await adapter.stop(), 0);
});

test('SF-2/SF-3: rate_limited and guest_budget notices are posted once, threaded, then silence; a linked member still talks', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  telegram.memberCounts[String(SHOP.id)] = 12;
  const answers = ['an unlinked user over the per-person limit', 'the same person again within the hour',
    'the binding pool is used up', 'another unlinked person in the same place', 'a linked member while the pool is used up']
    .map(name => ex('admission', `v1.2 admission: ${name}`).response);
  runtime.routes['POST /v1/channel/admission'] = () => answers.shift();
  const spam = {id: 556677889, is_bot: false, first_name: 'spam4you'};
  const updates = [
    tgGroup(700001, '???', {from: spam, chat: SHOP, mention: true}),
    tgGroup(700002, 'alo', {from: spam, chat: SHOP, mention: true}),
    tgGroup(700003, 'cho mình hỏi thêm', {from: {...spam, id: 667788990}, chat: SHOP, mention: true}),
    tgGroup(700004, 'mình nữa', {from: {...spam, id: 778899001}, chat: SHOP, mention: true}),
    tgGroup(700005, 'tóm tắt ticket hôm nay', {from: LAN, chat: SHOP, mention: true}),
  ];
  telegram.updates.push(...updates);
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);

  assert.deepEqual(sent(telegram).map(params => [params.text, params.reply_parameters.message_id]), [
    ['Bạn gửi hơi nhanh, đợi một lát rồi hỏi lại nhé.', updates[0].message.message_id],
    ['Soot đã hết lượt trả lời khách hôm nay.', updates[2].message.message_id]]);
  assert.equal(bodies(runtime, '/v1/channel/messages')[0].text, 'tóm tắt ticket hôm nay');
  for (const body of bodies(runtime, '/v1/channel/admission')) assert.equal(body.chat.member_count, 12);
  assert.equal(telegram.method('getChatMemberCount').length, 1, 'cached per chat');
  assert.equal(await adapter.stop(), 0);
});

test('pool 0: an unlinked DM is refused with no text; the linked owner still talks (§10.2)', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  runtime.routes['POST /v1/channel/admission'] = body => body.sender.id === String(STRANGER.id)
    ? ex('admission', 'v1.2 admission: pool 0 → an unlinked person').response
    : ex('admission', 'v1.2 admission: pool 0 → the linked owner').response;
  telegram.updates.push({update_id: 700010, message: {message_id: 10, from: STRANGER, chat: {id: STRANGER.id, type: 'private'}, date: 1, text: 'chào bot'}});
  telegram.updates.push({update_id: 700011, message: {message_id: 11, from: OWNER, chat: {id: OWNER.id, type: 'private'}, date: 1, text: 'chào'}});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  const [stranger, owner] = bodies(runtime, '/v1/channel/admission');
  assert.deepEqual(stranger, ex('admission', 'v1.2 admission: pool 0 → an unlinked person').request.body);
  assertFits(owner, ex('admission', 'v1.2 admission: pool 0 → the linked owner').request.body);
  assert.equal(telegram.sent().length, 0);
  assert.equal(telegram.method('getChatMemberCount').length, 0, 'no count for a DM');
  assert.equal(await adapter.stop(), 0);
});

test('an unlinked person admitted in a DM who pastes a pairing code claims it; a linked one who types a code-shaped word sends a message', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  runtime.routes['POST /v1/channel/admission'] = body => ({status: 200, body: {admitted: true,
    principal: body.sender.id === String(STRANGER.id) ? {kind: 'anyone', linked: false} : {kind: 'owner', linked: true}, place: {class: 'dm'}}});
  runtime.routes['POST /v1/channel/pairings/claim'] = () => ({status: 200, body: {reply: 'Đã liên kết.'}});
  telegram.updates.push({update_id: 700020, message: {message_id: 20, from: STRANGER, chat: {id: STRANGER.id, type: 'private'}, date: 1, text: 'QRST-UVWX'}});
  telegram.updates.push({update_id: 700021, message: {message_id: 21, from: OWNER, chat: {id: OWNER.id, type: 'private'}, date: 1, text: 'Schedule'}});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  assert.deepEqual(bodies(runtime, '/v1/channel/pairings/claim').map(body => [body.sender.id, body.code]), [[String(STRANGER.id), 'QRST-UVWX']]);
  assert.equal(bodies(runtime, '/v1/channel/messages')[0].text, 'Schedule');
  assert.equal(await adapter.stop(), 0);
});

test('blocked: a message and a press are silent (no notice, no toast text, no #10), even if a host wrongly sends text', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  const answers = [ex('admission', 'v1.2 admission: a blocked person → blocked').response,
    ex('admission', 'v1.2 admission: INVALID').response, ex('admission', 'v1.2 admission: a blocked person presses').response];
  runtime.routes['POST /v1/channel/admission'] = () => answers.shift();
  discord.dispatch('MESSAGE_CREATE', dcMention('1310000000000000010', HUNG, 'alo'));
  discord.dispatch('MESSAGE_CREATE', dcMention('1310000000000000011', HUNG, 'alo nữa'));
  discord.dispatch('INTERACTION_CREATE', dcPress('1320000000000000010', HUNG, 'q1ZlTk3Rb8Vd6W'));
  await until(() => discord.callsMatching('DELETE', /^\/webhooks\//).length === 1);
  const admissions = bodies(runtime, '/v1/channel/admission');
  assertFits(admissions[0], ex('admission', 'v1.2 admission: a blocked person → blocked').request.body);
  assertFits(admissions[2], ex('admission', 'v1.2 admission: a blocked person presses').request.body);
  assert.equal(posts(discord).length, 0);
  assert.equal(discord.callsMatching('PATCH', /^\/webhooks\//).length, 0, 'the deferred answer is deleted, not filled');
  assert.equal(runtime.callsTo('/v1/channel/messages').length + runtime.callsTo('/v1/channel/answers').length, 0);
  assert.equal(await adapter.stop(), 0);
});

test('blocked in a DM: no notice either, even if a host wrongly sends text', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  runtime.routes['POST /v1/channel/admission'] = route('admission', 'v1.2 admission: INVALID');
  telegram.updates.push({update_id: 700030, message: {message_id: 30, from: STRANGER, chat: {id: STRANGER.id, type: 'private'}, date: 1, text: 'chào bot'}});
  await until(() => runtime.callsTo('/v1/channel/admission').length === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(telegram.sent().length, 0);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 0);
  assert.equal(await adapter.stop(), 0);
});

test('SF-8 claim: /owner in a group is claimed (never sent as a message), replies threaded, a 429 is not retried; /owner in a DM is a message', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  telegram.memberCounts[String(OPS.id)] = 7;
  let unavailable = 1;
  const outcomes = {
    'tg:7012345678:u:600101': () => (unavailable-- > 0 ? {status: 503, body: {code: 'unavailable'}} : ex('owner-chat', 'owner chat: the linked owner sends').response),
    'tg:7012345678:u:600102': route('owner-chat', 'owner chat: an unknown, expired'),
    'tg:7012345678:u:600103': route('owner-chat', 'owner chat: someone who is not the linked owner'),
    'tg:7012345678:u:600104': route('owner-chat', 'owner chat: the binding already has'),
    'tg:7012345678:u:600106': route('owner-chat', 'owner chat: too many failed claims'),
  };
  runtime.routes['POST /v1/channel/places/claim'] = body => outcomes[body.request_id]();
  runtime.routes['POST /v1/channel/admission'] = () => ({status: 200, body: {admitted: true, principal: {kind: 'owner', linked: true}, place: {class: 'dm'}}});
  const updates = [
    tgGroup(600101, '/owner QRST-UVWX', {from: OWNER, chat: OPS, mention: true}),
    tgGroup(600102, '/owner ABCD-EFGH', {from: OWNER, chat: TEST_GROUP, mention: true}),
    tgGroup(600103, `/Owner@${BOT_NAME} WXYZ-2345`, {from: LAN, chat: TEST_GROUP}),
    tgGroup(600104, '/owner WXYZ-2345', {from: OWNER, chat: TEST_GROUP}),
    tgGroup(600106, '/owner jklm npqr', {from: {id: 7788990011, is_bot: false}, chat: TEST_GROUP}),
    {update_id: 600105, message: {message_id: 12, from: OWNER, chat: {id: OWNER.id, type: 'private'}, date: 1, text: '/owner WXYZ-2345',
      entities: [{type: 'bot_command', offset: 0, length: 6}]}},
  ];
  telegram.updates.push(...updates);
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);

  const claims = bodies(runtime, '/v1/channel/places/claim');
  assert.deepEqual(claims.slice(0, 2), [0, 1].map(() => ex('owner-chat', 'owner chat: the linked owner sends').request.body),
    'a 503 repeats the same claim with the same request_id');
  assertFits(claims[2], ex('owner-chat', 'owner chat: an unknown, expired').request.body);
  assert.deepEqual(claims[3], ex('owner-chat', 'owner chat: someone who is not the linked owner').request.body);
  assertFits(claims[4], ex('owner-chat', 'owner chat: the binding already has').request.body);
  assertFits(claims[5], {...ex('owner-chat', 'owner chat: too many failed claims').request.body, code: 'jklm npqr'});
  assert.equal(claims.length, 6, 'the 429 is final');

  assert.deepEqual(sent(telegram).map(params => [String(params.chat_id), params.text, params.reply_parameters?.message_id]), [
    [String(OPS.id), ex('owner-chat', 'owner chat: the linked owner sends').response.body.reply, updates[0].message.message_id],
    [String(TEST_GROUP.id), 'Mã không đúng hoặc đã hết hạn. Tạo mã mới trong Nest → Kênh chat.', updates[1].message.message_id],
    [String(TEST_GROUP.id), 'Chỉ chủ sở hữu đã liên kết mới đặt được kênh này.', updates[2].message.message_id],
    [String(TEST_GROUP.id), 'Bot này đã có kênh chủ sở hữu. Gỡ kênh cũ trong Nest trước.', updates[3].message.message_id]]);
  assert.equal(runtime.callsTo('/v1/channel/admission').length, 1, 'only the DM message asks admission');
  assert.equal(bodies(runtime, '/v1/channel/messages')[0].text, '/owner WXYZ-2345');
  assert.equal(await adapter.stop(), 0);
});

test('SF-8 claim: a host that serves places only after a revision-2 status is read again, so /owner is claimed after a restart', async t => {
  const runtime = await new FakeRuntime().start();
  const telegram = await new FakeTelegram().start();
  t.after(async () => { await runtime.stop(); await telegram.stop(); });
  // The real host: `places` only once this process declared contract_revision 2.
  const v11 = runtime.routes[SESSION];
  let declared = false;
  runtime.routes['POST /v1/channel/status'] = body => { declared ||= body.contract_revision === 2; return {status: 200, body: {ok: true}}; };
  runtime.routes[SESSION] = () => (declared ? ex('owner-chat', 'owner chat: the session').response : v11());
  runtime.routes['POST /v1/channel/places/claim'] = route('owner-chat', 'owner chat: the linked owner sends');
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  t.after(() => adapter.stop());
  await until(() => runtime.openStreams.size > 0);
  telegram.memberCounts[String(OPS.id)] = 7;
  telegram.updates.push(tgGroup(600140, '/owner QRST-UVWX', {from: OWNER, chat: OPS, mention: true}));
  await until(() => runtime.callsTo('/v1/channel/places/claim').length === 1);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 0, '/owner is never sent as a message');
  assert.equal(runtime.callsTo('/v1/channel/session').length, 2);
  assert.equal(await adapter.stop(), 0);
});

test('SF-8 targeting: owner-chat items post with their buttons, the shared group gets only the pointer, invalid items are skipped, one answer edits every chat', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  telegram.nextMessageID = 9101;
  const order = ['ob_TgApr00301', 'ob_TgApr00302', 'ob_TgApr00303', 'ob_TgPtr00304', 'ob_OcApr00201', 'ob_OcGrt00203',
    'ob_TgTm000310', 'ob_BadShr0311', 'ob_BadOcn0312', 'ob_TgRes00305', 'ob_TgRes00306', 'ob_TgRes00307'];
  for (const [index, receipt] of order.entries()) {
    runtime.push(v12[receipt]);
    await until(() => acks(runtime).length === index + 1);
  }
  assert.deepEqual(acks(runtime).map(ack => [ack.receipt_id, ack.status]), order.map(receipt =>
    [receipt, receipt.startsWith('ob_Bad') ? 'skipped' : 'delivered']));

  const posted = Object.fromEntries(sent(telegram).map((params, index) => [order[index], params]));
  assert.equal(sent(telegram).length, 7);
  const tokens = params => params.reply_markup?.inline_keyboard.flat().map(button => button.callback_data);
  assert.equal(posted.ob_TgApr00303.chat_id, String(OPS.id));
  assert.deepEqual(tokens(posted.ob_TgApr00303), v12.ob_TgApr00303.attention.choices.map(choice => choice.token));
  assert.deepEqual(tokens(posted.ob_OcApr00201), ['oc1ApTk7Lm2Nx4', 'oc1RjTk3Rb8Vd6']);
  assert.deepEqual(tokens(posted.ob_OcGrt00203), ['oc3RjTk3Rb8Vd6']);
  assert.match(posted.ob_OcGrt00203.text, /\n\nCấp quyền trong Nest$/);
  assert.deepEqual(tokens(posted.ob_TgTm000310), v12.ob_TgTm000310.attention.choices.map(choice => choice.token), 'a team decision without asker');
  assert.equal(posted.ob_TgPtr00304.chat_id, String(SHOP.id));
  assert.equal(posted.ob_TgPtr00304.text, 'Việc này cần chủ sở hữu duyệt. Mình đã báo riêng cho chủ sở hữu.');
  assert.deepEqual(posted.ob_TgPtr00304.reply_parameters, {message_id: 5301, allow_sending_without_reply: true});
  assert.equal(posted.ob_TgPtr00304.reply_markup, undefined);

  const edits = telegram.method('editMessageText').map(call => [String(call.params.chat_id), call.params.message_id, call.params.reply_markup]);
  assert.deepEqual(edits, [['123456789', 9101, {inline_keyboard: []}], ['5566778899', 9102, {inline_keyboard: []}],
    [String(OPS.id), 9103, {inline_keyboard: []}]]);
  assert.equal(await adapter.stop(), 0);
});

test('SF-8 presses in the owner chat: approver in scope → applied; out of scope, a grant, an unlinked person → not_authorized toast; a typed reply is a place message', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  telegram.memberCounts[String(OPS.id)] = 7;
  runtime.routes['POST /v1/channel/admission'] = body => ({
    [LAN.id]: ex('owner-chat', 'owner chat: an approver presses a button there').response,
    [KHOA.id]: ex('owner-chat', 'owner chat: an unlinked person in the owner chat presses').response,
  })[body.sender.id] ?? {status: 200, body: {admitted: true, principal: {kind: 'owner', linked: true}, place: {class: 'owner_chat'}}};
  const presses = {
    oc1ApTk7Lm2Nx4: 'owner chat: the approver presses Duyệt và chạy on an approval in scope',
    oc2ApTk7Lm2Nx4: 'owner chat: the approver presses Duyệt và chạy on another Soot',
    oc3RjTk3Rb8Vd6: 'owner chat: the approver presses Từ chối on a grant',
    oc2RjTk3Rb8Vd6: 'owner chat: the unlinked person\'s press',
  };
  runtime.routes['POST /v1/channel/answers'] = body => ex('owner-chat', presses[body.token]).response;
  runtime.routes['POST /v1/channel/messages'] = route('owner-chat', 'owner chat: a typed reply');
  telegram.nextMessageID = 8000;
  runtime.push(v12.ob_OcApr00202);
  await until(() => acks(runtime).length === 1);

  telegram.updates.push(
    tgPress('5500000000000001', LAN, 'oc1ApTk7Lm2Nx4', OPS),
    tgPress('5500000000000002', LAN, 'oc2ApTk7Lm2Nx4', OPS),
    tgPress('5500000000000003', LAN, 'oc3RjTk3Rb8Vd6', OPS),
    tgPress('5500000000000004', KHOA, 'oc2RjTk3Rb8Vd6', OPS),
    {update_id: 600110, message: {message_id: 7001, from: {id: OWNER.id, is_bot: false}, chat: OPS, date: 1, text: 'duyệt',
      reply_to_message: {message_id: 8000, from: {id: TG_BOT, is_bot: true}}}},
  );
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);

  assert.deepEqual(telegram.method('answerCallbackQuery').map(call => call.params.text),
    ['Đã duyệt. Soot CSKH chạy tiếp.', NOT_AUTHORIZED, NOT_AUTHORIZED, NOT_AUTHORIZED]);
  const answers = bodies(runtime, '/v1/channel/answers');
  assert.deepEqual(answers.map(body => body.token), Object.keys(presses));
  for (const [index, name] of Object.values(presses).entries()) assertFits(answers[index], ex('owner-chat', name).request.body);
  const admissions = bodies(runtime, '/v1/channel/admission');
  assert.deepEqual(admissions[0], ex('owner-chat', 'owner chat: an approver presses a button there').request.body);
  assertFits(admissions[3], ex('owner-chat', 'owner chat: an unlinked person in the owner chat presses').request.body);
  assertFits(bodies(runtime, '/v1/channel/messages')[0], ex('owner-chat', 'owner chat: a typed reply').request.body);
  assert.equal(telegram.sent().length, 1, 'nothing posted in the owner chat but the item');
  assert.equal(await adapter.stop(), 0);
});

test('SF-8 left: Telegram my_chat_member left/kicked of the bot → places/left; other member changes are ignored', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t);
  const change = (updateID, user, status, chat = OPS) => ({update_id: updateID, my_chat_member: {chat, from: OWNER, date: 1,
    old_chat_member: {user, status: 'member'}, new_chat_member: {user, status}}});
  const bot = {id: TG_BOT, is_bot: true, username: BOT_NAME};
  telegram.updates.push(change(600118, bot, 'administrator'), change(600119, {id: LAN.id}, 'left'),
    change(600120, bot, 'kicked'), change(600121, bot, 'left', TEST_GROUP),
    change(600122, bot, 'kicked', {id: OWNER.id, type: 'private'}));
  await until(() => runtime.callsTo('/v1/channel/places/left').length === 2);
  await new Promise(resolve => setTimeout(resolve, 100));
  const left = bodies(runtime, '/v1/channel/places/left');
  assert.deepEqual(left[0], ex('owner-chat', 'owner chat: the bot was removed').request.body);
  assert.deepEqual(left[1], {request_id: 'tg:7012345678:u:600121', chat: {id: String(TEST_GROUP.id), kind: 'group', title: 'Nhóm thử'}});
  assert.equal(left.length, 2, 'a DM block or another member leaving is not a place left');
  assert.equal(await adapter.stop(), 0);
});

test('SF-8 left: Discord CHANNEL_DELETE, THREAD_DELETE and GUILD_DELETE → one places/left per known chat, every time; an outage is not a removal', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  const THREAD = '1288888888888888899';
  const GONE_THREAD = '1288888888888888898', CATEGORY = '1288888888888888801', FORUM = '1288888888888888802';
  discord.dispatch('GUILD_CREATE', {id: GUILD, member_count: 240,
    channels: [{id: CATEGORY, type: 4, name: 'Hỗ trợ'}, {id: CHANNEL, type: 0, name: 'help'}, {id: FORUM, type: 15, name: 'hỏi đáp'}],
    threads: [{id: THREAD, type: 11, name: 'hỏi nhanh'}, {id: GONE_THREAD, type: 11, name: 'cũ'}]});
  discord.dispatch('GUILD_DELETE', {id: GUILD, unavailable: true});
  discord.dispatch('CHANNEL_DELETE', {id: CHANNEL, type: 0, guild_id: GUILD});
  discord.dispatch('CHANNEL_DELETE', {id: CHANNEL, type: 0, guild_id: GUILD});
  discord.dispatch('CHANNEL_DELETE', {id: '1299999999999999999', type: 1});
  discord.dispatch('CHANNEL_DELETE', {id: CATEGORY, type: 4, guild_id: GUILD});
  discord.dispatch('THREAD_DELETE', {id: GONE_THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL});
  await until(() => runtime.callsTo('/v1/channel/places/left').length === 3);
  discord.dispatch('GUILD_DELETE', {id: GUILD});
  await until(() => runtime.callsTo('/v1/channel/places/left').length === 4);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(bodies(runtime, '/v1/channel/places/left'), [
    {request_id: `dc:${APP}:l:${CHANNEL}`, chat: {id: CHANNEL, kind: 'guild_channel', guild_id: GUILD}},
    {request_id: `dc:${APP}:l:${CHANNEL}`, chat: {id: CHANNEL, kind: 'guild_channel', guild_id: GUILD}},
    {request_id: `dc:${APP}:l:${GONE_THREAD}`, chat: {id: GONE_THREAD, kind: 'thread', guild_id: GUILD}},
    {request_id: `dc:${APP}:l:${THREAD}`, chat: {id: THREAD, kind: 'thread', guild_id: GUILD}}],
    'a category or forum is never a chat; a deleted thread is left once and forgotten');
  assert.equal(await adapter.stop(), 0);
});

test('Discord press in an owner chat by someone without the permission → ephemeral not_authorized toast', async t => {
  const {runtime, discord, adapter} = await discordSetup(t);
  runtime.routes['POST /v1/channel/admission'] = () => ({status: 200, body: {admitted: true, principal: {kind: 'anyone', linked: false}, place: {class: 'owner_chat'}}});
  runtime.routes['POST /v1/channel/answers'] = route('owner-chat', 'owner chat: the unlinked person\'s press');
  discord.dispatch('INTERACTION_CREATE', dcPress('1320000000000000020', HUNG, 'oc2RjTk3Rb8Vd6'));
  await until(() => discord.callsMatching('PATCH', /^\/webhooks\//).length === 1);
  assert.equal(discord.callsMatching('PATCH', /^\/webhooks\//)[0].body.content, NOT_AUTHORIZED);
  assert.deepEqual(discord.callsMatching('POST', /^\/interactions\//)[0].body, {type: 5, data: {flags: 64}});
  assert.equal(posts(discord).length, 0);
  assert.equal(await adapter.stop(), 0);
});

test('revision-1 host (no places): /owner is a message, no places/left, no member_count; v1.1 items and /new in a guild as before', async t => {
  const {runtime, telegram, adapter} = await telegramSetup(t, {places: false});
  telegram.memberCounts[String(OPS.id)] = 7;
  runtime.routes['POST /v1/channel/admission'] = () => ({status: 200, body: {admitted: true}});
  const bot = {id: TG_BOT, is_bot: true, username: BOT_NAME};
  telegram.updates.push(tgGroup(600130, '/owner QRST-UVWX', {from: OWNER, chat: OPS, mention: true}),
    {update_id: 600131, my_chat_member: {chat: OPS, from: OWNER, date: 1, old_chat_member: {user: bot, status: 'member'}, new_chat_member: {user: bot, status: 'kicked'}}},
    tgGroup(600132, 'chào', {from: OWNER, chat: OPS, mention: true}));
  await until(() => runtime.callsTo('/v1/channel/messages').length === 2);
  assert.deepEqual(bodies(runtime, '/v1/channel/messages').map(body => body.text), ['/owner QRST-UVWX', 'chào']);
  assert.equal(runtime.callsTo('/v1/channel/places/claim').length + runtime.callsTo('/v1/channel/places/left').length, 0);
  for (const body of bodies(runtime, '/v1/channel/admission')) assert.deepEqual(body.chat, {id: String(OPS.id), kind: 'group', title: OPS.title});
  assert.equal(telegram.method('getChatMemberCount').length, 0);

  runtime.push(v12.ob_CpApr00402);
  await until(() => acks(runtime).length === 1);
  assert.deepEqual(acks(runtime)[0].status, 'delivered');
  assert.equal(await adapter.stop(), 0);
});

test('revision-1 host on Discord: a v1.1 asker question is asked in place; /new in a guild maps a fresh conversation', async t => {
  const {runtime, discord, adapter} = await discordSetup(t, {places: false});
  runtime.routes['POST /v1/channel/admission'] = route('compat', 'compat v1.2: revision 1, a paired member');
  runtime.routes['POST /v1/channel/conversations/resolve'] = route('compat', 'compat v1.2: revision 1, /new in a guild');
  runtime.push(v12.ob_CpAsk00401);
  await until(() => acks(runtime).length === 1);
  assert.equal(acks(runtime)[0].status, 'delivered');
  assert.deepEqual(posts(discord)[0].message_reference, {message_id: '1320000000000000102', fail_if_not_exists: false});
  discord.dispatch('MESSAGE_CREATE', dcMention('1320000000000000101', MINH, '/new'));
  await until(() => posts(discord).length === 2);
  assertFits(bodies(runtime, '/v1/channel/admission')[0], ex('compat', 'compat v1.2: revision 1, a paired member').request.body);
  assertFits(bodies(runtime, '/v1/channel/conversations/resolve')[0], ex('compat', 'compat v1.2: revision 1, /new in a guild').request.body);
  assert.equal(posts(discord)[1].content, 'Đã mở cuộc trò chuyện mới với Đầu mối. Cuộc cũ vẫn còn trong Nest.');
  assert.equal(await adapter.stop(), 0);
});

test('fixture copy: the digest in CONTRACT.md is the digest of the files', () => {
  const dir = join(import.meta.dirname, 'fixtures');
  const listing = readdirSync(dir).filter(name => name !== 'CONTRACT.md').sort()
    .map(name => `${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')}  ${name}\n`).join('');
  const digest = createHash('sha256').update(listing).digest('hex').slice(0, 16);
  assert.ok(readFileSync(join(dir, 'CONTRACT.md'), 'utf8').includes(`\`${digest}\``), `CONTRACT.md should name digest ${digest}`);
});
