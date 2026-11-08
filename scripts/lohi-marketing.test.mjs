// The Lohi workspace recipe (examples/lohi-marketing) matches what the packs
// declare: tools its schedules run, credentials and env it grants, the one
// approval it relaxes, and lean model tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));

test('the Lohi recipe: product Lohi, marketing_claim auto, five tool-only schedules on declared tools, three paused social channels', async () => {
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
  assert.deepEqual(Object.keys(byId).sort(), ['marketing-channels', 'marketing-dispatch', 'marketing-facts', 'marketing-gsc', 'marketing-replies']);
  assert.equal(byId['marketing-dispatch'].every, '10m');
  assert.deepEqual(byId['marketing-dispatch'].wake_when, { notify: true }, 'the runtime wakes on a boolean only through notify');
  assert.deepEqual([byId['marketing-gsc'].at, byId['marketing-facts'].at], ['06:00', '05:30']);
  for (const s of host.schedules) {
    assert.ok(packs[s.tool.pack].tools.some(t => t.name === s.tool.name), s.id);
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
    assert.ok(soot.execution.daily_tokens <= 150000, soot.id);
    for (const ref of soot.packs) assert.ok(known(ref.split(':')[0]), `${soot.id}: ${ref}`);
    for (const f of [soot.soul, soot.mission]) assert.ok((await readFile(new URL(`examples/lohi-marketing/soots/${f}`, root), 'utf8')).trim(), f);
  }
  const editor = await json('examples/lohi-marketing/soots/lohi-editor.json');
  assert.deepEqual(editor.packs, ['marketing', 'lohi-blog', 'browser-use'], 'the editor claims and publishes, blog and browser');
  assert.match(await readFile(new URL('examples/lohi-marketing/soots/writer.md', root), 'utf8'), /blog-lohi/);
});
