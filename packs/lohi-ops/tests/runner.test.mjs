import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFor, runPlan, addedRange, crawlArgv, radarArgv } from '../tools/lib/runner.mjs';
import { resolveByTitle, resolveByUrl, resolveByProdSlug, resolveJob, foldTitle, normUrl } from '../tools/lib/resolve.mjs';
import { execArgv, main } from '../tools/job-runner.mjs';
import { fakeCatalog } from './helpers.mjs';

const RID = '11111111-2222-3333-4444-555555555555';
const j = a => a.join(' ');

test('planFor: refresh and repair are the chapters-only onboard forms, validated, no shell', () => {
  const r = planFor('refresh', { source: 'ixdzs-hk', novel: '568746', chapters: '100-149' }, {}, { prodSlug: 'than-hoang' });
  assert.equal(j(r.steps[0].argv), 'npx tsx src/index.ts onboard --source ixdzs-hk --novel 568746 --prod-slug than-hoang --chapters 100-149 --chapters-only --no-announce');
  assert.deepEqual(r.result, { novel_slug: 'than-hoang', chapters: '100-149', tail: true, has_request: false });
  const q = planFor('refresh', { source: 's', novel: 'n', chapters: '5-9' }, { request_id: RID });
  assert.ok(j(q.steps[0].argv).endsWith(`--no-announce --request-id ${RID}`));
  const p = planFor('repair', { source: 's', novel: 'n', chapters: '3-4' });
  assert.ok(j(p.steps[0].argv).endsWith('--chapters 3-4 --chapters-only --overwrite --no-announce'));
  assert.ok(j(planFor('refresh', { source: 's', novel: 'n' }).steps[0].argv).includes('crawl catalog radar'));
  assert.equal(j(planFor('crawl', { source: 's', novel: 'n' }).steps[0].argv.slice(3, 6)), 'crawl catalog run');
  for (const bad of [['repair', { source: 's', novel: 'n' }], ['refresh', { source: 's', novel: 'n', chapters: '9-2' }], ['refresh', { source: 'S;x', novel: 'n', chapters: '1-2' }], ['refresh', { source: 's', novel: 'n$(x)', chapters: '1-2' }], ['nuke', { source: 's', novel: 'n' }]]) {
    assert.throws(() => planFor(bad[0], bad[1]), bad[0]);
  }
  assert.throws(() => planFor('refresh', { source: 's', novel: 'n', chapters: '1-2' }, { request_id: 'not-a-uuid' }));
  assert.throws(() => crawlArgv({ source: 's', novel: 'a b' }));
  assert.ok(radarArgv('s', ['a', 'b']).join(' ').endsWith('--novel a --novel b'));
});

test('planFor onboard: a request is a draft with its request id; a catalog onboard is neither', () => {
  const a = planFor('onboard', { source: 's', novel: 'n' }, { request_id: RID });
  assert.equal(a.kind, 'onboard'); assert.equal(a.range, '1-10');
  assert.ok(j(a.onboard_argv).endsWith(`--request-id ${RID} --keep-draft`));
  const b = planFor('onboard', { source: 's', novel: 'n' }, {});
  assert.ok(!j(b.onboard_argv).includes('--keep-draft'));
});

test('addedRange: what onboard says it imported, the tail of the range for a refresh', () => {
  const out = 'Import range: 100-149\nChapters to import: 5\n';
  assert.deepEqual(addedRange(out, '100-149', { tail: true }), { chapters: '145-149', added: 5 });
  assert.deepEqual(addedRange(out, '100-149'), { chapters: '100-149', added: 5 });
  assert.deepEqual(addedRange('Import range: 1-10\nChapters to import: 0', '1-10', { tail: true }), { chapters: null, added: 0 });
  assert.deepEqual(addedRange('noise', '7-8'), { chapters: '7-8', added: null });
});

/** An io whose exec answers per command word and records the calls. */
function fakeIo({ have = 10, copyright = { issue: false, reason: '' }, answers = {} } = {}) {
  const calls = [];
  const io = {
    calls,
    async exec(argv) {
      calls.push(j(argv.slice(3)));
      const key = Object.keys(answers).find(k => j(argv).includes(k));
      return key ? answers[key] : { code: 0, out: 'Import range: 1-10\nChapters to import: 10\n' };
    },
    async countChapters() { return have; },
    async copyright() { return copyright; },
  };
  return io;
}

test('runPlan onboard: dry-run, copyright check, then the real run; never publishes past a flag', async () => {
  const plan = planFor('onboard', { source: 's', novel: 'n' }, { request_id: RID });
  const io = fakeIo();
  const r = await runPlan(plan, io);
  assert.deepEqual([r.state, r.novel_slug, r.chapters], ['done', 'n', '1-10']);
  assert.deepEqual(io.calls.map(c => c.split(' ')[0] + (c.includes('--dry-run') ? '-dry' : c.includes('copyright') ? '-cr' : '')), ['onboard-dry', 'crawl-cr', 'onboard']);
  assert.ok(io.calls[2].includes(`--request-id ${RID} --keep-draft`));
  // flagged: stops with the reason, the real run never happens
  const flagged = fakeIo({ copyright: { issue: true, reason: 'Tencent giữ bản quyền' } });
  const b = await runPlan(plan, flagged);
  assert.deepEqual([b.state, b.copyright], ['blocked_copyright', 'Tencent giữ bản quyền']);
  assert.equal(flagged.calls.length, 2);
  // a dry-run or a copyright command that fails is a failure, never a publish
  for (const word of ['--dry-run', 'catalog copyright']) {
    const io2 = fakeIo({ answers: { [word]: { code: 1, out: 'boom' } } });
    const f = await runPlan(plan, io2);
    assert.equal(f.state, 'failed'); assert.ok(!io2.calls.some(c => c.startsWith('onboard') && !c.includes('--dry-run')));
  }
});

test('runPlan onboard: crawls the first 10 when the catalog lacks them; a crawl that brings nothing fails', async () => {
  const plan = planFor('onboard', { source: 's', novel: 'n' }, {});
  const io = fakeIo({ have: 0 });
  assert.equal((await runPlan(plan, io)).state, 'failed');
  assert.ok(io.calls[0].startsWith('crawl catalog run') && io.calls[0].includes('--from 1 --to 10'));
  let n = 0;
  const io2 = fakeIo(); io2.countChapters = async () => (n++ ? 10 : 0);
  assert.equal((await runPlan(plan, io2)).state, 'done');
});

test('runPlan steps: a refresh reports the tail it added; nothing new is done without a slug; a sweep survives one refused source', async () => {
  const plan = planFor('refresh', { source: 's', novel: 'n', chapters: '100-149' }, {});
  const r = await runPlan(plan, { exec: async () => ({ code: 0, out: 'Import range: 100-149\nChapters to import: 5' }) });
  assert.deepEqual([r.state, r.novel_slug, r.chapters], ['done', 'n', '145-149']);
  const none = await runPlan(plan, { exec: async () => ({ code: 0, out: 'Import range: 100-149\nChapters to import: 0' }) });
  assert.equal(none.state, 'done'); assert.equal(none.novel_slug, undefined);
  const req = await runPlan(planFor('refresh', { source: 's', novel: 'n', chapters: '5-9' }, { request_id: RID }), { exec: async () => ({ code: 0, out: 'Import range: 5-9\nChapters to import: 0' }) });
  assert.equal(req.chapters, '5-9'); // a reader's request still goes to translation
  const fail = await runPlan(plan, { exec: async () => ({ code: 2, out: 'x' }) });
  assert.equal(fail.state, 'failed');
  const codes = [1, 0];
  const sweep = { v: 1, kind: 'steps', stop_on_fail: false, steps: [{ name: 'a', argv: ['x'] }, { name: 'b', argv: ['y'] }] };
  assert.equal((await runPlan(sweep, { exec: async () => ({ code: codes.shift(), out: '' }) })).state, 'done');
  assert.equal((await runPlan(sweep, { exec: async () => ({ code: 1, out: '' }) })).state, 'failed');
});

test('job-runner: runs argv without a shell, writes log, result.json, then exit', async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'jr-'));
  const argv = [process.execPath, '-e', 'console.log("Import range: 1-3\\nChapters to import: 3"); console.log(process.argv[1])', '$(touch pwned); `x`'];
  await fsp.writeFile(join(dir, 'plan.json'), JSON.stringify({ v: 1, kind: 'steps', steps: [{ name: 'x', argv }], result: { novel_slug: 'n', chapters: '1-3', tail: false, has_request: false } }));
  const res = await main(dir, { env: { PATH: process.env.PATH }, cwd: dir });
  assert.deepEqual([res.state, res.novel_slug, res.chapters], ['done', 'n', '1-3']);
  assert.equal(await fsp.readFile(join(dir, 'exit'), 'utf8'), '0\n');
  assert.match(await fsp.readFile(join(dir, 'log'), 'utf8'), /\$\(touch pwned\)/);
  await assert.rejects(fsp.access(join(dir, 'pwned')));
  assert.equal(JSON.parse(await fsp.readFile(join(dir, 'result.json'), 'utf8')).state, 'done');
  // a plan that cannot be read is a failed result, still with an exit file
  const bad = await fsp.mkdtemp(join(tmpdir(), 'jr-'));
  assert.equal((await main(bad, { env: {}, cwd: bad })).state, 'failed');
  assert.equal(await fsp.readFile(join(bad, 'exit'), 'utf8'), '1\n');
  const timeout = await execArgv([process.execPath, '-e', 'setTimeout(()=>{}, 5000)'], { cwd: dir, env: {}, log: { write() {} }, timeout_ms: 100 });
  assert.notEqual(timeout.code, 0);
});

// ---------- resolution ----------
const CATALOG = [
  { source: 'ixdzs-hk', novel: '568746', title: 'Thần Hoàng Vô Địch', cn_title: '神皇无敌', landing_url: 'https://ixdzs.hk/read/568746/', prd: 1 },
  { source: 'piaotia-com', novel: 'a-1', title: 'Đại Chúa Tể', landing_url: 'https://www.piaotia.com/bookinfo/1.html' },
  { source: 'twkan-com', novel: 'b-2', title: 'Đại chúa tể', landing_url: 'https://twkan.com/book/2.html' },
  { source: 'ixdzs-hk', novel: '111', title: 'Kiếm', landing_url: null },
  { source: 'ixdzs-hk', novel: 'than-hoang', title: 'Khác Hẳn', prd: 1 },
  { source: 'piaotia-com', novel: 'than-hoang', title: 'Khác Hẳn Hai', prd: 1 },
];

test('resolveByTitle: one accent / case folded match only; ambiguous, short or unknown never resolve', async () => {
  const db = await fakeCatalog(CATALOG);
  assert.equal(foldTitle('Thần  Hoàng, Vô Địch!'), 'than hoang vo dich');
  assert.deepEqual(resolveByTitle(db, 'than hoang vo dich').row.novel, '568746');
  assert.equal(resolveByTitle(db, '神皇无敌').source, 'ixdzs-hk');
  assert.deepEqual([resolveByTitle(db, 'Đại chúa tể').found, resolveByTitle(db, 'Đại chúa tể').why], [false, 'ambiguous']);
  assert.equal(resolveByTitle(db, 'Kiếm').why, 'title_too_short');
  assert.equal(resolveByTitle(db, 'Một truyện chưa có').why, 'no_match');
});

test('resolveByUrl and resolveJob: the link finds its catalog row; an unseen link needs a source; a refresh follows its prod slug', async () => {
  const db = await fakeCatalog(CATALOG);
  assert.equal(normUrl('HTTPS://www.IXDZS.hk/read/568746/?a=1#x'), 'ixdzs.hk/read/568746');
  assert.equal(resolveByUrl(db, 'https://ixdzs.hk/read/568746').novel, '568746');
  assert.equal(resolveByUrl(db, 'https://ixdzs.hk/read/999').why, 'unknown_link');
  const ctx = { db, cliDir: '/cli', fsx: { readdir: async () => ['ixdzs-hk'], readFile: async () => JSON.stringify({ base_url: 'https://ixdzs.hk' }) } };
  const parts = { source: 'request', novel: RID, chapters: null };
  assert.deepEqual((await resolveJob({ kind: 'onboard', source_url: 'https://ixdzs.hk/read/568746/', title: 'x' }, parts, ctx)).novel, '568746');
  const unseen = await resolveJob({ kind: 'onboard', source_url: 'https://ixdzs.hk/read/777/', title: 'x' }, parts, ctx);
  assert.deepEqual([unseen.unresolved, unseen.source_hint], ['needs_source', 'ixdzs-hk']);
  const vague = await resolveJob({ kind: 'onboard', title: 'Đại chúa tể' }, parts, ctx);
  assert.deepEqual([vague.unresolved, vague.why], ['no_source', 'title:ambiguous']);
  assert.equal((await resolveJob({ kind: 'onboard', title: 'Thần Hoàng Vô Địch' }, parts, ctx)).novel, '568746');
  assert.equal(resolveByProdSlug(db, '568746', '1-5').source, 'ixdzs-hk');
  assert.equal(resolveByProdSlug(db, 'than-hoang', '1-5').why, 'ambiguous');
  const withCh = await fakeCatalog(CATALOG, [['piaotia-com', 'than-hoang', 90, 100]]);
  assert.equal(resolveByProdSlug(withCh, 'than-hoang', '90-100').source, 'piaotia-com');
  // an explicit source/novel subject is trusted as given
  assert.deepEqual(await resolveJob({}, { source: 'a', novel: 'b' }, ctx), { source: 'a', novel: 'b' });
});
