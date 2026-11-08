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
  const packs = Object.fromEntries(await Promise.all(['marketing', 'lohi-blog', 'browser-use'].map(async id => [id, await json(`${local[id] ?? `packs/${id}`}/pack.json`)])));
  assert.ok(!catalog.packs.some(p => p.id === 'lohi-blog'), 'lohi-blog stays out of the catalog');
  const known = id => id in local || catalog.packs.some(p => p.id === id);
  assert.equal(host.product, 'Lohi');
  assert.deepEqual(host.approvals, { marketing_claim: 'auto' });
  assert.equal(packs.marketing.tools.find(t => t.name === 'claim').run.approval, 'operator', 'the pack stays guarded; only this host relaxes it');

  const byId = Object.fromEntries(host.schedules.map(s => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['blog-ready', 'marketing-blog', 'marketing-campaigns', 'marketing-channels', 'marketing-dispatch', 'marketing-gsc', 'marketing-plan', 'marketing-probe', 'marketing-replies', 'marketing-report']);
  // Campaigns: a daily api read that wakes the Đầu mối (the Editor) for lead outcomes and the token budget.
  assert.deepEqual([byId['marketing-campaigns'].tool.name, byId['marketing-campaigns'].at, byId['marketing-campaigns'].wake_when, byId['marketing-campaigns'].soot], ['campaign_report', '07:00', { notify: true }, host.default_soot]);
  assert.ok(host.pack_grants.marketing.env.includes('PRODUCT_API_URL'), 'the api address is an operator env, never tool input');
  assert.deepEqual([byId['marketing-dispatch'].cron, byId['marketing-dispatch'].timezone, byId['marketing-dispatch'].tool.input], ['*/10 7-22 * * *', 'Asia/Ho_Chi_Minh', { schedule: true, skip: ['blog-lohi'] }], 'the dispatch records its own wakes and sleeps at night');
  // The daily plan wakes the Writer only for a free blog slot; it also keeps the facts fresh (no facts schedule).
  assert.deepEqual([byId['marketing-plan'].soot, byId['marketing-plan'].tool.name, byId['marketing-plan'].wake_when], ['lohi-writer', 'plan', { notify: true }]);
  assert.equal(byId['marketing-plan'].tool.input.wake, true);
  assert.ok(byId['marketing-plan'].tool.input.facts_url && byId['marketing-plan'].tool.input.catalog.feed);
  assert.deepEqual([byId['blog-ready'].soot, byId['blog-ready'].tool.pack, byId['blog-ready'].tool.name], [host.default_soot, 'lohi-blog', 'ready']);
  assert.deepEqual(byId['marketing-dispatch'].wake_when, { notify: true }, 'the runtime wakes on a boolean only through notify');
  assert.equal(byId['marketing-gsc'].at, '06:00');
  for (const s of host.schedules) {
    assert.ok(packs[s.tool.pack].tools.some(t => t.name === s.tool.name), s.id);
    for (const step of s.then ?? []) assert.ok(packs[step.pack].tools.some(t => t.name === step.tool), `${s.id}: then ${step.pack}_${step.tool}`);
    assert.ok(s.text, `${s.id} has its wake prompt`);
    assert.ok(host.soots.includes(`soots/${s.soot}.json`), s.id);
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
    const cap = soot.id === 'lohi-editor' ? 400000 : 250000;
    assert.ok(soot.execution.daily_tokens <= cap, soot.id);
    assert.ok(soot.execution.max_run_tokens <= soot.execution.daily_tokens, soot.id);
    for (const ref of soot.packs) assert.ok(known(ref.split(':')[0]), `${soot.id}: ${ref}`);
    for (const f of [soot.soul, soot.mission]) assert.ok((await readFile(new URL(`examples/lohi-marketing/soots/${f}`, root), 'utf8')).trim(), f);
  }
  const editor = await json('examples/lohi-marketing/soots/lohi-editor.json');
  assert.deepEqual(editor.packs.map(r => r.split(':')[0]), ['marketing', 'lohi-blog', 'browser-use']);
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
  assert.ok(!host.soots.includes('soots/lohi-radar.json'), 'no Radar Soot: the plan tool supplies the topic');
  const writer = (await json('examples/lohi-marketing/soots/lohi-writer.json')).packs;
  assert.equal(writer.length, 1);
  assert.deepEqual(writer[0].replace(/^marketing:tools=/, '').split(',').sort(), ['check', 'draft_save', 'items', 'plan', 'schedule']);
  const tools = writer[0].replace(/^marketing:tools=/, '').split(',');
  const declared = new Set((await json('packs/marketing/pack.json')).tools.map((t) => t.name));
  for (const t of tools) assert.ok(declared.has(t), `writer tool ${t} is declared by marketing`);
  assert.ok(tools.includes('draft_save') && tools.includes('plan'), 'the Writer only gets the tools it writes with');
  assert.match(await readFile(new URL('examples/lohi-marketing/soots/writer.md', root), 'utf8'), /blog-lohi/);
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
