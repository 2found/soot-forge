// channel-adapter v1.5 §13.3: pictures in a DM go to the host as images[] when the
// session says binding.images; otherwise, in a group, or as another kind of file,
// they are refused as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Discord} from '../platform/discord.mjs';
import {FakeDiscord, FakeRuntime, FakeTelegram, response, startAdapter, tgMessage, until} from './helpers.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600', 'hex');
const copy = response('session', 'session: handshake').body.copy;

function withImages(runtime, on = true) {
  const session = response('session', 'session: handshake');
  runtime.routes['GET /v1/channel/session'] = () => ({...session, body: {...session.body,
    binding: {...session.body.binding, images: on}, limits: {...session.body.limits, message_bytes: 12 << 20}}});
}

test('Telegram: a photo in a DM goes as images; an album-free caption is its text; too large is refused here', async t => {
  const runtime = await new FakeRuntime().start();
  const telegram = await new FakeTelegram().start();
  t.after(async () => { await runtime.stop(); await telegram.stop(); });
  withImages(runtime);
  telegram.files['photos/big.jpg'] = JPG;
  telegram.files['photos/doc.jpg'] = PNG;
  telegram.updates.push(
    tgMessage(600101, undefined, {photo: [{file_id: 'small', file_size: 900}, {file_id: 'big', file_size: 90_000}, {file_id: 'huge', file_size: 3 << 20}], caption: 'Hoá đơn này đúng chưa?'}),
    tgMessage(600102, undefined, {document: {file_id: 'doc', mime_type: 'image/png', file_name: 'shot.png'}}),
    tgMessage(600103, undefined, {document: {file_id: 'pdf', mime_type: 'application/pdf', file_name: 'a.pdf'}}),
    tgMessage(600104, undefined, {photo: [{file_id: 'only', file_size: 3 << 20}]}),
  );
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => telegram.sent().length === 2 && runtime.callsTo('/v1/channel/messages').length === 2);
  const [first, second] = runtime.callsTo('/v1/channel/messages').map(call => call.body);
  assert.equal(first.text, 'Hoá đơn này đúng chưa?');
  assert.deepEqual(first.images, [{name: `photo-${4400 + 1}.jpg`, mime: 'image/jpeg', data: JPG.toString('base64')}]);
  assert.equal(second.text, '');
  assert.deepEqual(second.images, [{name: 'shot.png', mime: 'image/png', data: PNG.toString('base64')}]);
  const said = telegram.sent().map(call => call.params.text);
  assert.equal(said[0], copy.attachment_refused, 'a PDF is still refused');
  assert.match(said[1], /2 MB/, 'a photo with no size within the bound is refused by the adapter');
  assert.equal(telegram.method('getFile').some(call => call.params.file_id === 'only'), false, 'not downloaded');
  assert.equal(await adapter.stop(), 0);
});

test('Telegram: images off on the binding → refused with the attachment sentence, nothing downloaded', async t => {
  const runtime = await new FakeRuntime().start();
  const telegram = await new FakeTelegram().start();
  t.after(async () => { await runtime.stop(); await telegram.stop(); });
  telegram.updates.push(tgMessage(600201, undefined, {photo: [{file_id: 'big', file_size: 9}]}));
  const adapter = startAdapter({platform: 'telegram', runtime, telegram});
  await until(() => telegram.sent().length === 1);
  assert.equal(telegram.sent()[0].params.text, copy.attachment_refused);
  assert.equal(telegram.method('getFile').length, 0);
  assert.equal(runtime.callsTo('/v1/channel/messages').length, 0);
  assert.equal(await adapter.stop(), 0);
});

test('Discord: image attachments split from other files; a DM picture is downloaded without the bot token', async t => {
  const unit = new Discord({token: 't'});
  unit.me = {id: '9'}; unit.applicationID = '8';
  const ev = unit.eventFromMessage({id: '1', channel_id: '5', author: {id: '7'}, content: '',
    attachments: [{id: 'a', url: 'https://cdn/a.png', filename: 'a.png', content_type: 'image/png', size: 10}, {id: 'b', url: 'https://cdn/b.zip', filename: 'b.zip', content_type: 'application/zip'}]});
  assert.equal(ev.attachment, true);
  assert.deepEqual(ev.pictures, [{ref: 'https://cdn/a.png', mime: 'image/png', name: 'a.png', size: 10}]);
  const only = unit.eventFromMessage({id: '2', channel_id: '5', author: {id: '7'}, content: '', attachments: [{id: 'c', url: 'u', filename: 'c.webp', content_type: 'image/webp; charset=binary'}]});
  assert.equal(only.attachment, false);
  assert.equal(only.pictures[0].mime, 'image/webp');

  const runtime = await new FakeRuntime().start();
  const discord = await new FakeDiscord({botID: '1100220033004400999', applicationID: '1100220033004400'}).start();
  t.after(async () => { await runtime.stop(); await discord.stop(); });
  withImages(runtime);
  discord.files['/cdn/shot.png'] = PNG;
  const adapter = startAdapter({platform: 'discord', runtime, discord});
  await until(() => discord.received.some(payload => payload.op === 2));
  discord.dispatch('READY', {session_id: 's', resume_gateway_url: discord.gatewayUrl, user: {id: '1100220033004400999'}, application: {id: '1100220033004400'}});
  await until(() => runtime.callsTo('/v1/channel/status').length >= 2 && runtime.openStreams.size > 0);
  discord.dispatch('MESSAGE_CREATE', {id: '21', channel_id: '1299999999999999999', author: {id: '223344556677889900', username: 'minh'}, content: 'cái này là gì?',
    attachments: [{id: 'p', url: `${discord.base}/cdn/shot.png`, filename: 'shot.png', content_type: 'image/png', size: PNG.length}]});
  await until(() => runtime.callsTo('/v1/channel/messages').length === 1);
  const body = runtime.callsTo('/v1/channel/messages')[0].body;
  assert.equal(body.text, 'cái này là gì?');
  assert.deepEqual(body.images, [{name: 'shot.png', mime: 'image/png', data: PNG.toString('base64')}]);
  assert.equal(discord.calls.filter(call => call.method === 'CDN').length, 1);
  assert.equal(await adapter.stop(), 0);
});
