// The CMS target of the Lohi blog publisher (LOHI_BLOG_TARGET=cms) against a local fake hub that speaks the
// hub's /v1/tool contract and the CMS public read API. Nothing here reaches 2found.dev or any credential.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, unpublish, find, ready, parseHub, asChainStep, targetOf } from '../tools/blog.mjs';
import { run as marketing } from '../../../../../packs/marketing/tools/marketing.mjs';
import { fakeStore } from '../../../../../packs/marketing/tests/fake-store.mjs';
import { fakeHub, servers, TOKEN } from './fake-hub.mjs';
import { signClaim, contentHash } from '../../../../../packs/marketing/tools/lib/claim.mjs';

const KEY = 'k'.repeat(32);
after(() => { for (const s of servers) s.close(); });

const envOf = hub => ({ LOHI_BLOG_TARGET: 'cms', MARKETING_CLAIM_KEY: KEY, MARKETING_HUB: hub.hubEnv, PATH: process.env.PATH, HOME: tmpdir() });
const quick = { sleep: async () => {} };
const BODY = '## Năm tiêu chí\n\nĐọc [Lohi](https://lohi2.com/) và [tiên hiệp](https://lohi2.com/tien-hiep).\n\n- một\n- hai\n';
const claim = (over = {}) => {
  const c = { intent_id: 'I-00000000000000a1', post: 'P-0123456789', channel: 'blog-lohi', publisher: 'lohi-blog', action: 'publish', title: 'Cách chọn truyện tiên hiệp hay', meta: 'Năm tiêu chí chọn truyện.', slug: 'cach-chon-truyen-tien-hiep-hay', body: BODY, link: '', series: 'truyen-hay', date: '2026-11-10', url: '', expires_at: new Date(Date.now() + 600_000).toISOString(), ...over };
  return signClaim({ ...c, content_hash: contentHash(c) }, KEY);
};

test('publish: save as a draft, publish that revision, verify the public read API, answer the lohi2.com/blog URL', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  const out = await publish(claim(), env, quick);
  assert.deepEqual(out, { status: 'published', url: 'https://lohi2.com/blog/cach-chon-truyen-tien-hiep-hay', platform_id: 'cms:lohi/cach-chon-truyen-tien-hiep-hay@1' });
  assert.deepEqual(hub.st.calls.map(c => [c.hook, c.tool]), [['tool.call', 'cms_read'], ['tool.call', 'cms_save'], ['tool.call', 'cms_publish']]);
  const save = hub.st.calls[1].input;
  assert.deepEqual([save.site, save.language, save.expected_revision, save.status, save.title, save.summary], ['lohi', 'vi', 0, 'draft', 'Cách chọn truyện tiên hiệp hay', 'Năm tiêu chí chọn truyện.']);
  assert.equal(save.body_markdown, BODY.trim(), 'the body the writer saved, internal lohi2.com links untouched');
  assert.ok(save.body_markdown.includes('https://lohi2.com/tien-hiep') && !save.body_markdown.includes('blog.lohi2.com'));
  assert.deepEqual(hub.st.calls[2].input, { site: 'lohi', slug: 'cach-chon-truyen-tien-hiep-hay', revision: 1, title: 'Cách chọn truyện tiên hiệp hay', status: 'published' });
  assert.equal(hub.st.calls[0].soot, 'lohi-editor');
  assert.equal(hub.st.posts.get('cach-chon-truyen-tien-hiep-hay').live, 1);
});

test('retry of the same claim: nothing is saved or published twice, the answer is the same', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  const first = await publish(claim(), env, quick);
  const again = await publish(claim(), env, quick);
  assert.deepEqual(again, first);
  assert.deepEqual([hub.st.saves, hub.st.publishes, hub.st.posts.size], [1, 1, 1]);
  // A fresh intent for identical content (a re-issued claim) is also a no-op.
  const reissued = await publish(claim({ intent_id: 'I-00000000000000b2' }), env, quick);
  assert.equal(reissued.status, 'published');
  assert.deepEqual([hub.st.saves, hub.st.publishes], [1, 1]);
});

test('same slug, new content: the post is updated in place at the next revision, never duplicated', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  await publish(claim(), env, quick);
  const out = await publish(claim({ intent_id: 'I-00000000000000b3', body: BODY + '\nThêm một đoạn.\n', title: 'Cách chọn truyện tiên hiệp hay (cập nhật)' }), env, quick);
  assert.equal(out.status, 'published');
  assert.equal(out.platform_id, 'cms:lohi/cach-chon-truyen-tien-hiep-hay@2');
  assert.equal(hub.st.posts.size, 1);
  assert.equal(hub.st.calls.filter(c => c.tool === 'cms_save').at(-1).input.expected_revision, 1);
  assert.equal(hub.st.posts.get('cach-chon-truyen-tien-hiep-hay').live, 2);
});

test('a crash between save and publish: the retry publishes the saved revision without saving again', async () => {
  const hub = await fakeHub({ failPublish: 1 }), env = envOf(hub);
  const first = await publish(claim(), env, quick);
  assert.deepEqual([first.status, first.retry, first.reason.split(':')[0]], ['failed', true, 'hub_unavailable']);
  assert.equal(hub.st.posts.get('cach-chon-truyen-tien-hiep-hay').live, null, 'nothing is live yet');
  const second = await publish(claim(), env, quick);
  assert.equal(second.status, 'published', JSON.stringify(second));
  assert.deepEqual([hub.st.saves, hub.st.publishes], [1, 1]);
});

test('non-happy: a refused credential fails once, plainly, writes nothing and does not retry', async () => {
  const hub = await fakeHub();
  const env = { ...envOf(hub), MARKETING_HUB: JSON.stringify({ service_url: `${hub.origin}/api/hub`, service_token: 'x'.repeat(40) }) };
  const out = await publish(claim(), env, quick);
  assert.equal(out.status, 'failed');
  assert.equal(out.retry, false);
  assert.match(out.reason, /^hub_refused: .*HTTP 401/);
  assert.equal(hub.st.posts.size, 0);
  assert.ok(!JSON.stringify(out).includes('xxxx'), 'the token is never echoed');
  assert.equal(asChainStep(out, { intent_id: 'I-00000000000000a1' }).ok, false);
});

test('non-happy: no MARKETING_HUB, a malformed one, an unreachable hub, a non-publisher token, a bad slug, an unknown target', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  const noHub = { ...env }; delete noHub.MARKETING_HUB;
  assert.match((await publish(claim(), noHub, quick)).reason, /^hub_missing:/);
  assert.match((await publish(claim(), { ...env, MARKETING_HUB: '{"service_url":"https://2found.dev/api/hub"}' }, quick)).reason, /^hub_invalid:/);
  assert.match((await publish(claim(), { ...env, MARKETING_HUB: JSON.stringify({ service_url: 'http://2found.dev/api/hub', service_token: TOKEN }) }, quick)).reason, /^hub_invalid:/, 'plain http is only for loopback');
  assert.equal(hub.st.calls.length, 0, 'none of these reached the hub');

  const slug = await publish(claim({ slug: 'hai--gach' }), env, quick);
  assert.match(slug.reason, /^claim_invalid: slug/);
  assert.equal(slug.retry, false);
  assert.match((await publish(claim({ meta: 'x'.repeat(501) }), env, quick)).reason, /^claim_invalid: meta/);
  assert.match((await publish(claim(), { ...env, LOHI_BLOG_TARGET: 'ftp' }, quick)).reason, /^target_invalid/);
  assert.equal(hub.st.calls.length, 0);

  const nonPub = await fakeHub({ publisher: false });
  const out = await publish(claim(), envOf(nonPub), quick);
  assert.deepEqual([out.status, out.retry], ['failed', false]);
  assert.match(out.reason, /only a publisher/);
  assert.equal(nonPub.st.publishes, 0);

  const gone = await fakeHub();
  const goneEnv = envOf(gone);
  await new Promise(r => gone.server.close(r));
  const down = await publish(claim(), goneEnv, quick);
  assert.deepEqual([down.status, down.retry, down.reason.split(':')[0]], ['failed', true, 'hub_unreachable']);
});

test('a forged or expired claim is refused before the hub is called (the claim contract is unchanged)', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  const forged = { ...claim(), title: 'Tiêu đề khác' };
  assert.equal((await publish(forged, env, quick)).reason, 'claim_forged');
  assert.equal((await publish(claim({ expires_at: '2020-01-01T00:00:00Z' }), env, quick)).reason, 'claim_expired');
  assert.equal((await publish(claim({ publisher: 'browser' }), env, quick)).reason, 'claim_wrong_publisher');
  assert.equal(hub.st.calls.length, 0);
});

test('find: false until the same content is live, then the URL and the revision', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  assert.deepEqual(await find(claim(), env, quick), { found: false });
  await publish(claim(), env, quick);
  assert.deepEqual(await find(claim(), env, quick), { found: true, url: 'https://lohi2.com/blog/cach-chon-truyen-tien-hiep-hay', platform_id: 'cms:lohi/cach-chon-truyen-tien-hiep-hay@1' });
  assert.deepEqual(await find(claim({ body: 'khác' }), env, quick), { found: false });
});

test('unpublish: the CMS post is archived and gone from the public read API; an absent post is already removed', async () => {
  const hub = await fakeHub(), env = envOf(hub);
  await publish(claim(), env, quick);
  const un = claim({ action: 'unpublish', intent_id: 'I-00000000000000c1' });
  assert.deepEqual(await unpublish(un, env, quick), { status: 'removed' });
  assert.equal(hub.st.calls.filter(c => c.tool === 'cms_publish').at(-1).input.status, 'archived');
  assert.equal(hub.st.posts.get('cach-chon-truyen-tien-hiep-hay').live, null);
  assert.equal((await find(claim(), env, quick)).found, false);
  assert.deepEqual(await unpublish(claim({ action: 'unpublish', slug: 'khong-co-bai-nay', intent_id: 'I-00000000000000c2' }), env, quick), { status: 'removed' });
});

test('ready: one plain ask for a missing, refused, site-less or non-publisher credential; quiet and resolved when all is in place', async () => {
  const state = mkdtempSync(join(tmpdir(), 'cms-ready-'));
  const hub = await fakeHub();
  const base = { ...envOf(hub), SOOT_PACK_STATE: state };
  const bare = { ...base }; delete bare.MARKETING_HUB;
  const none = await ready(bare, quick);
  assert.deepEqual([none.ok, none.missing.map(m => m.key), none.wake, none.notify], [false, ['hub_missing'], false, false]);
  assert.match(none.ask.summary, /lohi2\.com\/blog/);
  assert.match(none.ask.missing, /MARKETING_HUB/);
  assert.ok(!JSON.stringify(none).includes(TOKEN));

  const refused = await ready({ ...base, MARKETING_HUB: JSON.stringify({ service_url: `${hub.origin}/api/hub`, service_token: 'y'.repeat(40) }) }, quick);
  assert.deepEqual(refused.missing.map(m => m.key), ['hub_refused']);

  const noSite = await fakeHub({ sites: ['soot'] });
  assert.deepEqual((await ready({ ...envOf(noSite), SOOT_PACK_STATE: state }, quick)).missing.map(m => m.key), ['hub_site']);
  const nonPub = await fakeHub({ publisher: false });
  assert.deepEqual((await ready({ ...envOf(nonPub), SOOT_PACK_STATE: state }, quick)).missing.map(m => m.key), ['hub_publish']);

  const ok = await ready(base, quick);
  assert.deepEqual([ok.ok, ok.missing.length, ok.resolves_need, ok.ask], [true, 0, true, undefined]);
  assert.equal(hub.st.publishes, 0, 'the check only preflights');
  assert.ok(hub.st.calls.filter(c => c.tool === 'cms_publish').every(c => c.hook === 'tool.preflight'));
  assert.equal(hub.st.posts.size, 0);
  // It needs none of the git target's tools or settings.
  assert.equal(ok.missing.some(m => ['git', 'go', '2server', 'gcloud', 'blog_remote', 'connection'].includes(m.key)), false);
});

test('chain: due -> claim -> publish (cms) -> record keeps the lohi2.com/blog URL in posts.url and publish_log', async () => {
  const T0 = Date.parse('2026-11-10T03:00:00Z');
  const store = fakeStore({ clock: () => T0 });
  const menv = { MARKETING_CLAIM_KEY: KEY };
  const mk = (name, input) => marketing(name, { input }, { store, now: T0, env: menv, fetchImpl: async () => { throw new Error('no network'); } });
  const params = name => JSON.parse(readFileSync(new URL('../../../../../packs/marketing/pack.json', import.meta.url), 'utf8')).tools.find(t => t.name === name).parameters;
  const step = (name, previous) => {
    const input = JSON.parse(JSON.stringify(previous)), p = params(name);
    if (p.additionalProperties === false) for (const k of Object.keys(input)) assert.ok(k in p.properties, `${name} does not take ${k}`);
    return input;
  };
  await mk('channels_setup', { channels: [{ id: 'blog-lohi', account: 'blog' }], quiet_hours: { from: '03:00', to: '04:00', tz: 'Asia/Ho_Chi_Minh' } });
  const meta = 'Danh sách chín bộ tiên hiệp đáng đọc nhất năm nay, mỗi bộ có một lý do riêng để bạn chọn đọc tiếp ngay hôm nay, xem ngay nhé bạn ơi.';
  const d = await mk('draft_save', { request_id: 'cms-chain-1', kind: 'article', channel: 'blog-lohi', body: 'Nếu bạn mê tiên hiệp, đây là chín bộ đáng đọc. Xem thêm [kho truyện](https://lohi2.com/novel/tien-hiep) và [thể loại](https://lohi2.com/novel/ngon-tinh).', brief: { title: 'Chín bộ tiên hiệp đáng đọc nhất năm nay', keyword: 'tiên hiệp', slug: 'tien-hiep-hay', meta, internal_links: ['https://lohi2.com/novel/tien-hiep', 'https://lohi2.com/novel/ngon-tinh'] } });
  assert.deepEqual(d.lint, []);
  await mk('check', { id: d.id, revision: d.revision, verdict: 'pass', reasons: [] });
  await mk('schedule', { id: d.id, scheduled_at: new Date(T0 - 60_000).toISOString() });

  const hub = await fakeHub(), env = envOf(hub);
  const due = await mk('due', { schedule: true, channel: 'blog-lohi' });
  const claimed = await mk('claim', step('claim', due));
  const out = JSON.parse(JSON.stringify(asChainStep(await publish(claimed.claim, env, { ...quick, now: () => T0 }), claimed.claim)));
  assert.equal(out.status, 'published', JSON.stringify(out));
  assert.equal(out.url, 'https://lohi2.com/blog/tien-hiep-hay');
  const recorded = await mk('record', step('record', out));
  assert.deepEqual([recorded.state, recorded.outcome], ['published', { id: 'post_published', ref: 'https://lohi2.com/blog/tien-hiep-hay' }]);
  const post = store.data.posts.find(p => p.ref === d.id);
  assert.deepEqual([post.state, post.url], ['published', 'https://lohi2.com/blog/tien-hiep-hay']);
  assert.equal(store.data.publish_log.find(r => r.intent_id === out.intent_id).url, 'https://lohi2.com/blog/tien-hiep-hay');
  assert.equal(store.data.queue.length, 0);
  assert.equal(hub.st.posts.get('tien-hiep-hay').revisions[0].summary, meta);
});

test('the tool as the runtime runs it: ToolContext on stdin, MARKETING_HUB in the environment, one JSON line out', async () => {
  const hub = await fakeHub();
  const env = { ...envOf(hub), PATH: process.env.PATH };
  const ctx = { soot: 'lohi-editor', input: { claim: claim() } };
  const run = (mode, input) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [new URL('../tools/blog.mjs', import.meta.url).pathname, mode], { env }, (err, stdout) => err ? reject(err) : resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
  const out = await run('publish', ctx);
  assert.deepEqual([out.ok, out.status, out.url, out.intent_id], [true, 'published', 'https://lohi2.com/blog/cach-chon-truyen-tien-hiep-hay', 'I-00000000000000a1']);
  assert.equal(hub.st.calls[0].soot, 'lohi-editor');
  const r = await run('ready', { soot: 'lohi-editor', input: {} });
  assert.deepEqual([r.ok, r.resolves_need], [true, true]);
});

test('parseHub and targetOf: the binding is exactly service_url and service_token; the target defaults to git', () => {
  assert.deepEqual(parseHub('{"service_url":"https://2found.dev/api/hub/","service_token":"abc"}'), { url: 'https://2found.dev/api/hub', token: 'abc', origin: 'https://2found.dev' });
  for (const bad of ['', 'nope', '[]', '{"service_url":"https://a.b/api","service_token":"t","extra":1}', '{"service_url":"https://a.b/api/hub/v1/tool","service_token":"t"}', '{"service_url":"https://u:p@a.b/api","service_token":"t"}'])
    assert.throws(() => parseHub(bad), e => /^hub_/.test(e.code), bad);
  assert.deepEqual([targetOf({}), targetOf({ LOHI_BLOG_TARGET: ' CMS ' }), targetOf({ LOHI_BLOG_TARGET: 'git' })], ['git', 'cms', 'git']);
});
