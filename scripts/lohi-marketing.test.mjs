// The Lohi workspace recipe (examples/lohi-marketing) matches what the packs
// declare: tools its schedules run, credentials and env it grants, the one
// approval it relaxes, and lean model tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('the Lohi recipe: product Lohi, marketing_claim auto (publish_approval none), tool-only schedules (three with a then chain) on declared tools, three paused social channels', async () => {
  const host = await json('examples/lohi-marketing/deployment.example.json');
  const catalog = await json('catalog.json');
  // lohi-blog is Lohi's own publisher: a local pack inside the recipe, never a catalog row.
  const local = { 'lohi-blog': 'examples/lohi-marketing/packs/lohi-blog' };
  const packs = Object.fromEntries(await Promise.all(['marketing', 'lohi-blog', 'browser-use', 'company-loop'].map(async id => [id, await json(`${local[id] ?? `packs/${id}`}/pack.json`)])));
  assert.ok(!catalog.packs.some(p => p.id === 'lohi-blog'), 'lohi-blog stays out of the catalog');
  const known = id => id in local || catalog.packs.some(p => p.id === id);
  assert.equal(host.product, 'Lohi');
  assert.deepEqual(host.approvals, { marketing_claim: 'auto' });
  assert.equal(packs.marketing.tools.find(t => t.name === 'claim').run.approval, 'operator', 'the pack stays guarded; only this host relaxes it');

  const byId = Object.fromEntries(host.schedules.map(s => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['blog-ready', 'company-digest', 'company-health', 'company-review', 'company-scoreboard', 'company-watch', 'finance-report', 'marketing-blog', 'marketing-campaigns', 'marketing-channels', 'marketing-dispatch', 'marketing-gsc', 'marketing-plan', 'marketing-probe', 'marketing-replies', 'marketing-report', 'marketing-video-stats', 'radar-read']);
  // Campaigns: a daily api read that wakes the Đầu mối (the Editor) for lead outcomes and the token budget.
  assert.deepEqual([byId['marketing-campaigns'].tool.name, byId['marketing-campaigns'].at, byId['marketing-campaigns'].wake_when, byId['marketing-campaigns'].soot], ['campaign_report', '07:00', { notify: true }, 'lohi-analyst']);
  assert.ok(host.pack_grants.marketing.env.includes('PRODUCT_API_URL'), 'the api address is an operator env, never tool input');
  assert.deepEqual([byId['marketing-dispatch'].cron, byId['marketing-dispatch'].timezone, byId['marketing-dispatch'].tool.input], ['*/10 7-22 * * *', 'Asia/Ho_Chi_Minh', { schedule: true, skip: ['blog-lohi'] }], 'the dispatch records its own wakes and sleeps at night');
  // The daily plan wakes the Writer only for a free blog slot; it also keeps the facts fresh (no facts schedule).
  // The company loop's next topic (if any) is merged into the plan's per-call query: topic_next, then plan with input_from previous.
  const planStep = byId['marketing-plan'].then[0];
  assert.deepEqual([byId['marketing-plan'].soot, byId['marketing-plan'].tool.pack, byId['marketing-plan'].tool.name, byId['marketing-plan'].tool.input, byId['marketing-plan'].wake_when], ['lohi-writer', 'company-loop', 'topic_next', { chain: true }, { notify: true }]);
  assert.deepEqual([byId['marketing-plan'].then.length, planStep.pack, planStep.tool, planStep.input_from], [2, 'marketing', 'plan', 'previous']);
  assert.deepEqual([byId['marketing-plan'].then[1].pack, byId['marketing-plan'].then[1].tool, byId['marketing-plan'].then[1].input_from], ['company-loop', 'topic_sync', 'previous'], 'the last step marks a handed topic written (or back to the queue) and passes the plan verdict through');
  assert.equal(planStep.input.wake, true);
  assert.ok(planStep.input.facts_url && planStep.input.catalog.feed);
  assert.deepEqual([byId['blog-ready'].soot, byId['blog-ready'].tool.pack, byId['blog-ready'].tool.name], [host.default_soot, 'lohi-blog', 'ready']);
  assert.deepEqual(byId['marketing-dispatch'].wake_when, { notify: true }, 'the runtime wakes on a boolean only through notify');
  assert.equal(byId['marketing-gsc'].at, '06:00');
  for (const s of host.schedules) {
    assert.ok(packs[s.tool.pack].tools.some(t => t.name === s.tool.name), s.id);
    for (const step of s.then ?? []) assert.ok(packs[step.pack].tools.some(t => t.name === step.tool), `${s.id}: then ${step.pack}_${step.tool}`);
    assert.ok(s.text, `${s.id} has its wake prompt`);
    assert.ok(host.soots.includes(`soots/${s.soot}.json`), s.id);
    // Each schedule's tools are granted to the Soot that runs them: a chain step the Soot cannot call would fail at 3 a.m.
    const soot = await json(`examples/lohi-marketing/soots/${s.soot}.json`);
    for (const st of [{ pack: s.tool.pack, tool: s.tool.name }, ...(s.then ?? [])]) {
      const ref = soot.packs.find(r => r.split(':')[0] === st.pack);
      assert.ok(ref, `${s.id}: ${s.soot} has no ${st.pack}`);
      if (ref.includes(':tools=')) assert.ok(ref.split(':tools=')[1].split(',').includes(st.tool), `${s.id}: ${s.soot} runs ${st.pack}_${st.tool}`);
    }
  }
  assert.deepEqual(byId['marketing-gsc'].tool.input.site, 'sc-domain:lohi2.com');
  assert.deepEqual([byId['marketing-replies'].every, byId['marketing-replies'].tool.name, byId['marketing-replies'].wake_when], ['2h', 'replies_sync', { notify: true }]);
  // Social channels are seeded paused; setup never unpauses (AC5: paused until first sign-in).
  const setup = byId['marketing-channels'].tool;
  assert.equal(setup.name, 'channels_setup');
  assert.deepEqual(setup.input.channels.map(c => c.id).sort(), ['facebook-lohi', 'reddit-lohi', 'x-lohi']);
  for (const c of setup.input.channels) {
    assert.ok(c.cap_per_day >= 1 && c.reply_cap_per_day >= 1 && c.spacing_min >= 1, c.id);
    assert.equal(c.rules.support_label, 'Chuyển Hỗ trợ Lohi', c.id);
  }
  assert.ok(setup.input.quiet_hours && setup.input.stale_after_h === 6);
  // The Editor publishes through one persistent browser profile.
  assert.ok(host.pack_grants['browser-use'].env.includes('SOOT_BROWSER_PERSISTENT_SOOTS'));

  for (const [id, grant] of Object.entries(host.pack_grants)) {
    assert.ok(known(id), id);
    for (const name of Object.keys(grant.credentials ?? {})) assert.ok(packs[id].needs.credentials[name], `${id} declares ${name}`);
    for (const name of grant.env ?? []) assert.ok(packs[id].needs.env.includes(name), `${id} declares env ${name}`);
  }
  // One claim key signs and verifies: both packs read it from the Soot's operator
  // store, which the host binds per Soot; a pack_grants env entry would be ignored.
  for (const id of ['marketing', 'lohi-blog']) {
    assert.equal(packs[id].needs.credentials.MARKETING_CLAIM_KEY.from, 'operator', `${id} reads the stored claim key`);
    assert.equal(host.pack_grants[id]?.credentials?.MARKETING_CLAIM_KEY, undefined, `${id}: no ignored env grant for the claim key`);
  }

  for (const file of host.soots) {
    const soot = await json(`examples/lohi-marketing/${file}`);
    assert.notEqual(soot.tier ?? 'pro', 'pro', `${soot.id}: lean budgets stay off the pro tier`);
    // The Editor drives the browser on the cheap model: one dispatch is ~84k tokens, so its cap fits a whole dispatch and the founder's flow never stalls.
    const cap = soot.id === 'lohi-editor' ? 300000 : 250000;
    assert.ok(soot.execution.daily_tokens <= cap, soot.id);
    assert.ok(soot.execution.max_run_tokens <= soot.execution.daily_tokens, soot.id);
    for (const ref of soot.packs) assert.ok(known(ref.split(':')[0]), `${soot.id}: ${ref}`);
    for (const f of [soot.soul, soot.mission]) assert.ok((await readFile(new URL(`examples/lohi-marketing/soots/${f}`, root), 'utf8')).trim(), f);
  }
  const editor = await json('examples/lohi-marketing/soots/lohi-editor.json');
  assert.deepEqual(editor.packs.map(r => r.split(':')[0]), ['marketing', 'company-loop', 'lohi-blog', 'browser-use']);
  // The team is split by job: the daily token ceiling of the new roles is below the old Writer 250k + Editor 300k.
  const roles = await Promise.all(['lohi-writer', 'lohi-editor', 'lohi-analyst', 'lohi-radar', 'lohi-finance'].map(id => json(`examples/lohi-marketing/soots/${id}.json`)));
  assert.ok(roles.reduce((n, r) => n + r.execution.daily_tokens, 0) < 550000, 'the lean team never raises the old budgets');
  assert.deepEqual(roles.map(r => [r.id, r.tier]), [['lohi-writer', 'flash'], ['lohi-editor', 'flash'], ['lohi-analyst', 'lite'], ['lohi-radar', 'lite'], ['lohi-finance', 'lite']]);
  assert.deepEqual(host.schedules.filter(s => !s.wake_when && !s.then && s.tool).map(s => s.id).filter(i => ['marketing-report', 'marketing-gsc', 'marketing-video-stats', 'company-review'].includes(i)).sort(), ['company-review', 'marketing-gsc', 'marketing-report', 'marketing-video-stats'], 'ops reads wake no model');
  // The Writer and the Radar never carry a browser, a publisher or the hub; the Analyst never writes or publishes.
  for (const r of roles.filter(x => x.id !== 'lohi-editor')) assert.ok(!r.packs.some(p => /^(browser-use|lohi-blog)/.test(p)), `${r.id}: no browser or publisher`);
  assert.deepEqual(roles[4].packs, ['company-loop:tools=signals'], 'Finance reads only');
  const analystTools = roles[2].packs.join(' ');
  assert.ok(!/draft_save|schedule|claim|record/.test(analystTools.replace(/campaign_|company/g, '')), 'the Analyst publishes nothing');
  // The Editor carries only what its skills and schedules call, and every schedule/chain tool it runs.
  const granted = new Set(editor.packs.find(r => r.startsWith('marketing:tools=')).slice('marketing:tools='.length).split(','));
  for (const t of granted) assert.ok(packs.marketing.tools.some(x => x.name === t), `editor tool ${t}`);
  for (const s of host.schedules.filter(x => x.soot === 'lohi-editor')) for (const st of [{ pack: s.tool.pack, tool: s.tool.name }, ...(s.then ?? [])]) if (st.pack === 'marketing') assert.ok(granted.has(st.tool), `${s.id} runs marketing_${st.tool} as the Editor`);
  assert.ok(granted.size <= 22 && !granted.has('video_import') && !granted.has('cms_save'), 'no hub or video tools in the Editor');
  const blogChain = byId['marketing-blog'];
  assert.deepEqual(blogChain.tool.input, { schedule: true, channel: 'blog-lohi' });
  assert.deepEqual(blogChain.then.map(x => `${x.pack}_${x.tool}`), ['marketing_claim', 'lohi-blog_publish', 'marketing_record']);
  assert.ok(blogChain.then.every(x => x.input_from === 'previous'));
  assert.equal(blogChain.wake_when, undefined, 'a chain wakes the Soot only through its failure path');
  assert.ok(host.soots.includes('soots/lohi-radar.json'), 'the Radar reads real sources by tool and wakes only to triage');
  const radar = byId['radar-read'];
  assert.deepEqual([radar.soot, radar.tool.name, radar.wake_when, radar.tool.input.schedule], ['lohi-radar', 'radar_read', { notify: true }, true]);
  assert.ok(radar.tool.input.sources.length >= 6 && radar.tool.input.sources.every(x => /^https:\/\//.test(x.url)), 'real https sources, read-only');
  assert.ok(!radar.tool.input.sources.some(x => /facebook|x\.com|twitter/.test(x.url)), 'no source that needs a login');
  const writer = (await json('examples/lohi-marketing/soots/lohi-writer.json')).packs;
  assert.deepEqual(writer.map(r => r.split(':')[0]), ['marketing', 'company-loop']);
  assert.equal(writer[1], 'company-loop:tools=topic_next,topic_sync', 'the Writer only runs the topic steps of the chain');
  assert.deepEqual(writer[0].replace(/^marketing:tools=/, '').split(',').sort(), ['check', 'draft_save', 'items', 'plan', 'schedule']);
  const tools = writer[0].replace(/^marketing:tools=/, '').split(',');
  const declared = new Set((await json('packs/marketing/pack.json')).tools.map((t) => t.name));
  for (const t of tools) assert.ok(declared.has(t), `writer tool ${t} is declared by marketing`);
  assert.ok(tools.includes('draft_save') && tools.includes('plan'), 'the Writer only gets the tools it writes with');
  assert.match(await readFile(new URL('examples/lohi-marketing/soots/writer.md', root), 'utf8'), /blog-lohi/);
});

test('the Lohi recipe: the company loop is Ops plus the Analyst with five schedules, a topic chain into marketing, and no default product repo', async () => {
  const host = await json('examples/lohi-marketing/deployment.example.json');
  const pack = await json('packs/company-loop/pack.json');
  const byId = Object.fromEntries(host.schedules.map(s => [s.id, s]));
  const mine = host.schedules.filter(x => x.id.startsWith('company-'));
  assert.deepEqual(mine.map(x => x.id).sort(), ['company-digest', 'company-health', 'company-review', 'company-scoreboard', 'company-watch']);
  assert.deepEqual(mine.map(x => [x.id, x.soot]).filter(([i]) => ['company-digest', 'company-health'].includes(i)).sort(), [['company-digest', 'lohi-analyst'], ['company-health', 'lohi-analyst']], 'the digest and the health view are the Analyst\'s');
  assert.deepEqual(byId['company-health'].then.map(x => `${x.pack}_${x.tool}`), ['company-loop_health_sync']);
  assert.equal(byId['company-health'].then[0].input_from, 'previous', 'the starving inputs travel into the health view');
  assert.ok(mine.filter(x => x.id !== 'company-health').every(x => x.tool.pack === 'company-loop' && x.text));
  assert.deepEqual([byId['company-scoreboard'].at, byId['company-scoreboard'].every, byId['company-scoreboard'].tool.name], ['06:15', '24h', 'scoreboard_sync']);
  assert.deepEqual([byId['company-digest'].cron, byId['company-digest'].timezone, byId['company-digest'].tool.input, byId['company-digest'].then.map(x => `${x.pack}_${x.tool}`), byId['company-digest'].wake_when], ['30 8 * * 1', 'Asia/Ho_Chi_Minh', { for_digest: true }, ['company-loop_signals'], { notify: true }]);
  assert.equal(byId['company-digest'].then[0].input_from, undefined, 'signals takes its own empty input, not the sync output');
  assert.deepEqual([byId['company-watch'].cron, byId['company-watch'].tool.name], ['*/30 7-23 * * *', 'team_watch']);
  assert.deepEqual([byId['company-review'].cron, byId['company-review'].tool.name, byId['company-review'].wake_when], ['0 8 * * 1', 'review', undefined]);
  assert.match(byId['company-digest'].text, /company-digest skill/);
  assert.ok(pack.skills.some(s => s.name === 'company-digest'));
  for (const id of ['lohi-editor', 'lohi-analyst']) {
    const soot = await json(`examples/lohi-marketing/soots/${id}.json`);
    const granted = new Set(soot.packs.find(r => r.startsWith('company-loop:tools=')).slice('company-loop:tools='.length).split(','));
    for (const t of granted) assert.ok(pack.tools.some(x => x.name === t), `${id} tool ${t}`);
    assert.ok(!granted.has('decide') && !granted.has('topic_next'), `${id} never decides for the founder`);
  }
  // Every env the pack reads is granted from the host; credentials are the Soot\'s operator store.
  for (const name of host.pack_grants['company-loop'].env) assert.ok(pack.needs.env.includes(name), name);
  assert.ok(host.pack_grants['company-loop'].env.includes('LOOP_SOOT_CONFIG') && host.pack_grants.marketing.env.includes('YT_DLP_BIN'));
  assert.equal(pack.tools.find(t => t.name === 'decide').run.approval, 'operator');
  const { HOST_ENV } = await import('../examples/lohi-marketing/setup.mjs');
  assert.equal(HOST_ENV.PRODUCT_REPO, undefined, 'a scratch workspace never points at the real repo');
  assert.equal(HOST_ENV.SCOREBOARD_URL, 'https://api.lohi2.com/admin/analysis/scoreboard');
});

test('the Lohi recipe: one video path, the Video Soot runs 2build mvf and the Editor uploads from one shared workspace', async () => {
  const host = await json('examples/lohi-marketing/deployment.example.json');
  const catalog = await json('catalog.json');
  const video = await json('examples/lohi-marketing/soots/lohi-video.json');
  assert.deepEqual(video.packs, ['marketing', '2build', 'toolbox'], 'mvf runs through run_shell; no second video pack');
  assert.ok(catalog.packs.some(p => p.id === '2build' && p.source.kind === 'github' && /^[0-9a-f]{40}$/.test(p.source.ref)), '2build is the pinned external pack');
  assert.ok(host.soots.includes('soots/lohi-video.json'));
  // FILE_ROOT is the workspace; both Soots must see the same folder, or the Editor uploads nothing.
  assert.deepEqual(host.tool_hosts['lohi-video'], host.tool_hosts['lohi-editor']);
  assert.ok(host.tool_hosts['lohi-video'].workspace);
  for (const id of ['marketing', 'browser-use']) {
    const pack = await json(`packs/${id}/pack.json`);
    assert.equal(pack.needs.credentials.FILE_ROOT.from, 'workspace', id);
    assert.equal(host.pack_grants[id].credentials.FILE_ROOT, 'workspace', id);
  }
  const mission = await readFile(new URL('examples/lohi-marketing/soots/video.md', root), 'utf8');
  assert.match(mission, /marketing-video/);
  assert.match(mission, /marketing_video_import/);
  assert.match(mission, /never post/);
});

test('setup over a Forge-installed pack keeps the receipt and the release file set', async () => {
  const { mkdtemp, writeFile, readFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { installPack } = await import('../examples/lohi-marketing/setup.mjs');
  const { packFiles } = await import('./archive.mjs');
  const forge = fileURLToPath(new URL('..', import.meta.url));
  const out = await mkdtemp(join(tmpdir(), 'setup-twice-'));
  const dest = join(out, 'packs', 'marketing');
  assert.equal(installPack(forge, out, 'marketing'), 'copied');
  const release = await packFiles(join(forge, 'packs', 'marketing'));
  // Forge installs: the release files plus the receipt.
  await writeFile(join(dest, '.soot-source.json'), '{"id":"marketing"}\n');
  for (let i = 0; i < 2; i++) assert.equal(installPack(forge, out, 'marketing'), 'kept');
  // A dev-only file that slipped in (an older setup copied tests/) is repaired only when the pack is not Forge-installed; here it is left, never the receipt.
  assert.equal(await readFile(join(dest, '.soot-source.json'), 'utf8'), '{"id":"marketing"}\n');
  const now = (await packFiles(dest, { slim: false })).filter(f => f !== '.soot-source.json');
  assert.deepEqual(now, release);
  // An older installed copy is brought to the release set and keeps its receipt.
  await writeFile(join(dest, '.soot-source.json'), '{"id":"marketing","repository":"https://github.com/2found/soot-forge/releases/download/v0.0.1/marketing-pack_0.0.1.tar.gz"}\n');
  await mkdir(join(dest, 'tests'), { recursive: true });
  await writeFile(join(dest, 'tests', 'x.mjs'), '');
  assert.equal(installPack(forge, out, 'marketing'), 'copied');
  assert.match(await readFile(join(dest, '.soot-source.json'), 'utf8'), /v0\.0\.1/);
  assert.deepEqual((await packFiles(dest, { slim: false })).filter(f => f !== '.soot-source.json'), release);
  // An installed copy with an older data shape is replaced even at the same release.
  const man = JSON.parse(await readFile(join(dest, 'pack.json'), 'utf8'));
  man.storage.version = 1;
  await writeFile(join(dest, 'pack.json'), JSON.stringify(man));
  await writeFile(join(dest, '.soot-source.json'), `{"id":"marketing","repository":"https://github.com/2found/soot-forge/releases/download/v${JSON.parse(await readFile(join(forge, 'package.json'), 'utf8')).version}/m.tar.gz"}\n`);
  assert.equal(installPack(forge, out, 'marketing'), 'copied');
});
