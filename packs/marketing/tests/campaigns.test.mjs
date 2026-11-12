// Campaigns (AC7 Soot side, MK4 lead): campaign_save makes one UTM short link per
// channel through a fixture Lohi api with the frozen §7 shapes; campaign_report
// stores clicks and attributed signups, returns new signups once as `lead`
// outcomes and says 80 % of the token budget once; the Chiến dịch page model
// and the api failures (5xx, timeout, 403 key, no key) keep the Soot-side numbers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { slugOf, targetOf } from '../tools/lib/campaign.mjs';
import { startFixture } from './lohi-api-fixture.mjs';

const KEY = 'admin-key-for-tests';
const T0 = Date.parse('2026-12-05T03:00:00Z'); // 10:00 on 5/12 in Asia/Ho_Chi_Minh
const DAY = 86_400_000;
const api = await startFixture({ key: KEY });
after(() => api.close());

function world({ env = {} } = {}) {
  const w = { now: T0 };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { PRODUCT_API_URL: api.url, PRODUCT_ADMIN_KEY: KEY, ...env };
  w.call = (name, input, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: fetch, apiTimeoutMs: 300 });
  return w;
}
const CAMPAIGN = { name: 'Lohi tháng 12: truyện mới', goal: { metric: 'signups', target: 300 }, channels: ['blog-lohi', 'x-lohi', 'facebook-lohi', 'reddit-lohi'], starts: '2026-12-01', ends: '2026-12-31', token_budget: 2_000_000 };
const view = (w, input = {}) => w.call('page_view', { ...input }, { page: { page: 'chien-dich' } });

test('campaign_save: slug code, one tagged short link per channel through POST /admin/links, saved again without new links', async () => {
  api.reset();
  const w = world();
  const out = await w.call('campaign_save', CAMPAIGN);
  assert.equal(out.id, 'lohi-thang-12-truyen-moi');
  assert.equal(slugOf('Đà Lạt — mùa đông!'), 'da-lat-mua-dong');
  assert.deepEqual(out.links.map(l => l.channel), CAMPAIGN.channels);
  for (const l of out.links) assert.match(l.url, /^https:\/\/api\.lohi2\.com\/r\/[A-Za-z0-9]+$/);
  // The frozen request body; the key only in X-API-Key.
  assert.equal(api.calls.length, 4);
  const x = api.calls.find(c => c.body.channel === 'x');
  assert.deepEqual(Object.keys(x.body).sort(), ['campaign', 'channel', 'product', 'target']);
  assert.equal(x.method, 'POST'); assert.equal(x.path, '/admin/links'); assert.equal(x.key, KEY);
  assert.equal(x.body.product, 'lohi');
  assert.equal(x.body.target, 'https://lohi2.com/?utm_source=x&utm_medium=social&utm_campaign=lohi-thang-12-truyen-moi');
  assert.equal(api.calls.find(c => c.body.channel === 'blog').body.target, targetOf('https://lohi2.com/', out.id, 'blog-lohi'));
  assert.match(targetOf('https://lohi2.com/', out.id, 'blog-lohi'), /utm_source=blog&utm_medium=blog/);
  const again = await w.call('campaign_save', { ...CAMPAIGN, id: out.id, token_budget: 3_000_000 });
  assert.equal(api.calls.length, 4, 'links are made once');
  assert.equal(again.created, false);
  assert.equal((await w.store.call('campaigns', 'query', {})).rows[0].token_budget, 3_000_000);
  // Another name that folds to the same code does not overwrite it.
  await assert.rejects(w.call('campaign_save', { ...CAMPAIGN, name: 'Lohi tháng 12 — truyện mới' }), /Đã có chiến dịch mã/);
  // Bad input is refused before any api call.
  for (const bad of [{ goal: { metric: 'likes', target: 1 } }, { ends: '2026-11-01' }, { channels: [] }, { channels: ['myspace'] }, { name: '!!' }, { token_budget: -1 }])
    await assert.rejects(w.call('campaign_save', { ...CAMPAIGN, ...bad, ...(bad.name ? {} : { id: 'c-bad' }) }));
  assert.equal(api.calls.length, 4);
});

test('posts in a campaign carry it and go out with its channel link; another channel is refused', async () => {
  api.reset();
  const w = world();
  const c = await w.call('campaign_save', { ...CAMPAIGN, channels: ['x-lohi'] });
  const link = c.links[0].url;
  const d = await w.call('draft_save', { request_id: 'r1', kind: 'social', channel: 'x-lohi', campaign: c.id, body: 'Truyện mới tháng 12 trên Lohi: nghe thử chương đầu miễn phí.' });
  assert.equal(d.campaign_link, link);
  const p = (await w.call('items', { campaign: c.id })).items[0];
  assert.equal(p.campaign, c.id);
  assert.equal((await w.store.call('posts', 'query', {})).rows[0].link, link);
  // An edit without `campaign` keeps it.
  const e = await w.call('draft_save', { id: d.id, expected_revision: 1, kind: 'social', channel: 'x-lohi', body: 'Truyện mới tháng 12 trên Lohi: nghe chương đầu miễn phí.' });
  assert.equal(e.campaign_link, link);
  assert.equal((await w.store.call('posts', 'query', {})).rows[0].campaign, c.id);
  await assert.rejects(w.call('draft_save', { request_id: 'r2', kind: 'social', channel: 'facebook-lohi', campaign: c.id, body: 'x' }), /không thuộc chiến dịch/);
  await assert.rejects(w.call('draft_save', { request_id: 'r3', kind: 'social', channel: 'x-lohi', campaign: 'khong-co', body: 'x' }), /Không có chiến dịch/);
});

test('campaign_report: api numbers stored per channel; new signups are lead outcomes once; post_published still from record', async () => {
  api.reset();
  const w = world();
  const c = await w.call('campaign_save', CAMPAIGN);
  api.analysis = { clicks: [{ channel: 'blog', clicks: 312 }, { channel: 'x', clicks: 410 }], signups: [{ source: 'blog', registrations: 54, firstTopups: 4, revenue30dVnd: 196000 }, { source: 'x', registrations: 38, firstTopups: 2, revenue30dVnd: 98000 }] };
  const r1 = await w.call('campaign_report', {});
  assert.deepEqual(r1.outcomes, [{ id: 'lead', count: 92, ref: 'utm:lohi-thang-12-truyen-moi:2026-12-05' }]);
  assert.equal(r1.notify, true);
  const get = api.calls.at(-1);
  assert.equal(get.path, `/admin/analysis/campaigns/${c.id}?from=2026-12-01&to=2026-12-31`);
  // Same numbers: nothing new to record.
  const r2 = await w.call('campaign_report', { id: c.id, tokens_used: 820_000 });
  assert.deepEqual(r2.outcomes, []);
  assert.deepEqual(r2.tell, []);
  w.now += DAY;
  api.analysis.signups[1].registrations = 41;
  const r3 = await w.call('campaign_report', {});
  assert.deepEqual(r3.outcomes, [{ id: 'lead', count: 3, ref: 'utm:lohi-thang-12-truyen-moi:2026-12-06' }]);
  assert.deepEqual(r3.tokens_due, [c.id], 'the Đầu mối is woken to update the token count');
  // A page refresh reads the api but never consumes new signups.
  api.analysis.signups[0].registrations = 60;
  await w.call('page_action', { op: 'campaign_refresh', request_id: 'rq1', campaign_id: c.id }, { page: { page: 'chien-dich' } });
  assert.deepEqual((await w.call('campaign_report', {})).outcomes, [{ id: 'lead', count: 6, ref: 'utm:lohi-thang-12-truyen-moi:2026-12-06' }]);
  // A finished campaign is read for 30 more days, then no longer.
  w.now = Date.parse('2027-02-15T03:00:00Z');
  assert.deepEqual((await w.call('campaign_report', {})).campaigns, []);
});

test('the token budget: told once at 80 %, never stopped', async () => {
  api.reset();
  const w = world();
  const c = await w.call('campaign_save', CAMPAIGN);
  assert.deepEqual((await w.call('campaign_report', { id: c.id, tokens_used: 1_500_000 })).tell, []);
  const t = (await w.call('campaign_report', { id: c.id, tokens_used: 1_600_000 })).tell;
  assert.equal(t.length, 1);
  assert.match(t[0].message, /1\.600\.000 \/ 2\.000\.000 token \(80%\)/);
  assert.deepEqual((await w.call('campaign_report', { id: c.id, tokens_used: 2_400_000 })).tell, [], 'said once');
  assert.equal((await w.store.call('campaigns', 'query', {})).rows[0].state, 'active');
  await assert.rejects(w.call('campaign_report', { tokens_used: 5 }), /needs id/);
});

test('Chiến dịch page: list with goal progress, detail per channel against the goal, links and tokens', async () => {
  api.reset();
  const w = world();
  const c = await w.call('page_action', { op: 'campaign_save', request_id: 'rq-new', campaign: CAMPAIGN }, { page: { page: 'chien-dich' } });
  assert.equal(c.read.ok, true);
  await w.store.insert('posts', { ref: 'P-0000000001', kind: 'social', channel: 'x-lohi', campaign: c.id, body: 'b', state: 'published', url: 'https://x.com/lohi2com/status/1', revision: 1 });
  await w.store.insert('metrics', { url: 'https://x.com/lohi2com/status/1', source: 'x', day: '2026-12-03', query: '', impressions: 0, clicks: 0, views: 8900 });
  await w.store.insert('metrics', { url: 'https://x.com/lohi2com/status/1', source: 'x', day: '2026-11-20', query: '', impressions: 0, clicks: 0, views: 5 });
  api.analysis = { clicks: [{ channel: 'x', clicks: 410 }], signups: [{ source: 'x', registrations: 38, firstTopups: 2, revenue30dVnd: 0 }, { source: 'blog', registrations: 88, firstTopups: 7, revenue30dVnd: 0 }] };
  await w.call('campaign_report', { id: c.id, tokens_used: 820_000 });
  await w.call('campaign_save', { name: 'Audio cho người lái xe', goal: { metric: 'clicks', target: 500 }, channels: ['x-lohi', 'facebook-lohi'], starts: '2026-11-15', ends: '2026-11-30' });
  const list = await view(w);
  assert.deepEqual(list.items.map(i => [i.name, i.phase_label]), [['Lohi tháng 12: truyện mới', 'Đang chạy'], ['Audio cho người lái xe', 'Đã xong']]);
  assert.deepEqual(list.items[0].goal, { metric: 'signups', target: 300, value: 126 });
  assert.deepEqual(list.items[0].channels, ['Blog', 'X', 'Facebook', 'Reddit']);
  assert.equal(list.items[1].goal.value, null, 'never read: no number, never 0');
  const d = await view(w, { campaign: c.id });
  assert.deepEqual(d.totals, { published: 1, reach: 8900, clicks: 410, signups: 126, first_topups: 9 });
  assert.deepEqual(d.rows.find(r => r.label === 'X'), { channel: 'x-lohi', label: 'X', published: 1, reach: 8900, clicks: 410, signups: 38, first_topups: 2 });
  assert.equal(d.read.ok, true);
  assert.deepEqual([d.campaign.tokens_used, d.campaign.token_budget], [820_000, 2_000_000]);
  assert.equal(d.links.length, 4);
  assert.deepEqual(d.links_missing, []);
  await assert.rejects(view(w, { campaign: 'khong-co' }), /Không có chiến dịch/);
  // The view never writes (its storage token is read-only).
  const before = JSON.stringify(await w.store.call('campaigns', 'query', {}));
  await view(w, { campaign: c.id });
  assert.equal(JSON.stringify(await w.store.call('campaigns', 'query', {})), before);
});

for (const [name, setup, code] of [
  ['api 5xx', w => { api.mode = 'error'; }, 'api_unreachable'],
  ['api timeout', w => { api.mode = 'hang'; }, 'api_unreachable'],
  ['a 403 key', w => { w.env.PRODUCT_ADMIN_KEY = 'wrong-key'; }, 'forbidden'],
]) {
  test(`${name}: the campaign is saved without links, the page keeps Soot-side numbers and says so; no lead is made`, async () => {
    api.reset();
    const w = world();
    setup(w);
    const out = await w.call('page_action', { op: 'campaign_save', request_id: 'rq', campaign: CAMPAIGN }, { page: { page: 'chien-dich' } });
    assert.equal(out.links.length, 0);
    assert.deepEqual(out.links_missing, CAMPAIGN.channels);
    assert.equal(out.links_error.code, code);
    assert.equal(out.read.ok, false);
    assert.ok(api.calls.length <= 2, 'one failed link call stops the rest');
    await w.store.insert('posts', { ref: 'P-0000000002', kind: 'article', channel: 'blog-lohi', campaign: out.id, body: 'b', state: 'published', url: 'https://blog.lohi2.com/a/', revision: 1 });
    const d = await view(w, { campaign: out.id });
    assert.equal(d.read.ok, false);
    assert.equal(d.read.error.code, code);
    assert.ok(d.read.error.message.length > 10);
    assert.deepEqual([d.totals.published, d.totals.clicks, d.totals.signups], [1, null, null]);
    assert.deepEqual(d.links_missing, ['Blog', 'X', 'Facebook', 'Reddit']);
    const r = await w.call('campaign_report', {});
    assert.deepEqual(r.outcomes, []);
    assert.equal(r.campaigns[0].ok, false);
    // The api comes back: saving again makes the links, and a read clears the error.
    api.mode = 'ok'; w.env.PRODUCT_ADMIN_KEY = KEY;
    const fixed = await w.call('page_action', { op: 'campaign_save', request_id: 'rq2', campaign: { ...CAMPAIGN, id: out.id } }, { page: { page: 'chien-dich' } });
    assert.equal(fixed.links.length, 4);
    assert.equal(fixed.links_missing, undefined);
    assert.equal((await view(w, { campaign: out.id })).read.ok, true);
  });
}

test('no key: every campaign op answers needs_credential with a Vietnamese line that links Thiết lập, and saves nothing', async () => {
  api.reset();
  const w = world();
  delete w.env.PRODUCT_ADMIN_KEY;
  for (const [tool, input] of [['page_action', { op: 'campaign_save', request_id: 'rq', campaign: CAMPAIGN }], ['page_action', { op: 'campaign_refresh', request_id: 'rq3', campaign_id: 'x-y' }], ['campaign_save', CAMPAIGN]]) {
    const out = await w.call(tool, input, { page: { page: 'chien-dich' } });
    assert.deepEqual([out.ok, out.reason_code, out.key], [false, 'needs_credential', 'PRODUCT_AGENT_KEY'], tool);
    assert.match(out.message, /Thiết lập.*PRODUCT_AGENT_KEY|PRODUCT_AGENT_KEY.*Thiết lập/, tool);
    assert.equal(out.link, 'nest://settings/setup');
    assert.equal(out.error.code, 'needs_credential', 'the page prints this line');
  }
  assert.equal(w.store.data.campaigns.length, 0, 'nothing half-saved');
  assert.equal(api.calls.length, 0);
  // The schedule's plain read is a quiet skip, not a failure; an explicit {id, tokens_used} still updates the count.
  const r = await w.call('campaign_report', {});
  assert.deepEqual([r.skipped, r.reason_code, r.notify, r.wake], [true, 'optional_credential', false, false]);
});

test('the key goes only to PRODUCT_API_URL: no tool takes an api address from its input', () => {
  const pack = JSON.parse(readFileSync(new URL('../pack.json', import.meta.url), 'utf8'));
  for (const name of ['campaign_save', 'campaign_report', 'page_action']) {
    const t = pack.tools.find(x => x.name === name);
    assert.equal(t.run.secret_env.PRODUCT_ADMIN_KEY, '{{cred:PRODUCT_ADMIN_KEY}}', name);
    assert.ok(!Object.keys(t.parameters.properties).some(k => /api|host|base|endpoint/i.test(k)), name);
  }
  assert.equal(pack.needs.credentials.PRODUCT_ADMIN_KEY.from, 'operator');
  assert.deepEqual(pack.needs.env, ['PRODUCT_API_URL', 'YT_DLP_BIN', 'PATH', 'HOME'], 'one api address is an operator env; the rest is where yt-dlp is found');
  assert.equal(pack.tools.find(t => t.name === 'campaign_report').run.mode, 'write');
  assert.deepEqual(pack.interface.pages.find(p => p.id === 'chien-dich').provides, ['flow-marketing']);
});

test('p5 review: span ≤ 62 days, one channel per platform, https-only api, api error code kept, a new budget gets its own 80 % note, an old free-text tag stays editable', async () => {
  api.reset();
  const w = world();
  // The api reads at most 62 days: a longer campaign is refused before any call.
  await assert.rejects(w.call('campaign_save', { ...CAMPAIGN, id: 'q4', starts: '2026-10-01', ends: '2026-12-31' }), /tối đa 62 ngày/);
  await assert.rejects(w.call('campaign_save', { ...CAMPAIGN, id: 'two-x', channels: ['x-lohi', 'x-lohi2'] }), /Mỗi nền tảng một kênh/);
  assert.equal(api.calls.length, 0);
  // Plain http to a remote host never carries the admin key.
  const plain = world({ env: { PRODUCT_API_URL: 'http://api.example.com' } });
  const p = await plain.call('campaign_save', { ...CAMPAIGN, channels: ['x-lohi'] });
  assert.equal(p.links_error.code, 'no_api');
  assert.equal(api.calls.length, 0);
  // A wrong key: 403 → forbidden; a 4xx keeps the api's error code in the message.
  api.mode = 'error';
  const e = await w.call('campaign_save', { ...CAMPAIGN, channels: ['x-lohi'] });
  assert.match(e.links_error.message, /\(503 unavailable\)/);
  api.mode = 'ok';
  // 80 % told once; a raised budget is told again at its own 80 %.
  const c = await w.call('campaign_save', CAMPAIGN);
  let r = await w.call('campaign_report', { id: c.id, tokens_used: 1_700_000 });
  assert.equal(r.tell.length, 1);
  r = await w.call('campaign_report', { id: c.id, tokens_used: 1_750_000 });
  assert.equal(r.tell.length, 0);
  await w.call('campaign_save', { ...CAMPAIGN, id: c.id, token_budget: 4_000_000 });
  r = await w.call('campaign_report', { id: c.id, tokens_used: 2_000_000 });
  assert.equal(r.tell.length, 0);
  r = await w.call('campaign_report', { id: c.id, tokens_used: 3_300_000 });
  assert.equal(r.tell.length, 1);
  // A draft tagged before campaigns existed is still editable and keeps its tag.
  await w.store.insert('posts', { ref: 'P-0000000009', kind: 'social', channel: 'x-lohi', campaign: 'Lohi Dec', body: 'cũ', state: 'draft', revision: 1, content_hash: 'h' });
  const d = await w.call('draft_save', { id: 'P-0000000009', expected_revision: 1, kind: 'social', channel: 'x-lohi', body: 'Truyện mới tháng 12 trên Lohi.' });
  assert.equal(d.revision, 2);
  assert.equal((await w.store.call('posts', 'query', {})).rows.find(x => x.ref === 'P-0000000009').campaign, 'Lohi Dec');
});

test('campaign_verify: one read-only GET says ok, wrong key, key without the role, or api down; the key is never in the answer', async () => {
  api.reset();
  const w = world();
  const ok = await w.call('campaign_verify', {});
  assert.deepEqual([ok.state, ok.ok], ['ok', true]);
  assert.deepEqual(api.calls.map(c => c.method), ['GET']);
  assert.match(api.calls[0].path, /^\/admin\/analysis\/campaigns\/[^/?]+\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  const wrong = await world({ env: { PRODUCT_ADMIN_KEY: 'not-the-key' } }).call('campaign_verify', {});
  assert.deepEqual([wrong.state, wrong.message], ['wrong_key', 'Khoá không đúng.']);
  const limited = await startFixture({ key: KEY, limitedKey: 'reader-key' });
  const noRole = await world({ env: { PRODUCT_API_URL: limited.url, PRODUCT_ADMIN_KEY: 'reader-key' } }).call('campaign_verify', {});
  await limited.close();
  assert.equal(noRole.state, 'no_role');
  assert.match(noRole.message, /thiếu quyền.*agent_mod/);
  api.mode = 'error';
  const down = await w.call('campaign_verify', {});
  assert.equal(down.state, 'unreachable');
  assert.equal(JSON.stringify([ok, wrong, noRole, down]).includes('reader-key'), false);
  assert.equal((await world({ env: { PRODUCT_ADMIN_KEY: '' } }).call('campaign_verify', {})).state, 'no_key');
});

test('PRODUCT_AGENT_KEY is the marketing key; the deprecated PRODUCT_ADMIN_KEY still works as a fallback', async () => {
  api.reset();
  const w = world();
  delete w.env.PRODUCT_ADMIN_KEY;
  w.env.PRODUCT_AGENT_KEY = KEY;
  const out = await w.call('campaign_verify', {}, { page: { page: 'chien-dich' } });
  assert.notEqual(out.state, 'no_key');
  assert.equal(api.calls.length > 0, true);
});
