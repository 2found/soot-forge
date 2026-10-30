import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readGroups, validateGroup } from './groups.mjs';

const root = new URL('..', import.meta.url).pathname;
const source = id => JSON.parse(readFileSync(new URL(`../groups/${id}/group.source.json`, import.meta.url), 'utf8'));

test('the catalog lists the Kamaji-led templates first and every template validates', async () => {
  const catalog = await readGroups(root);
  assert.deepEqual(catalog.groups.map(g => g.id), ['marketing-team', 'support-team', 'society-sim']);
  for (const id of ['marketing-team', 'support-team']) {
    const t = source(id);
    assert.equal(t.api_version, 'soot/group-template/v2');
    assert.equal(t.root, '', `${id} is led by the host's lead`);
    assert.ok(t.inputs.some(i => i.confirm), `${id} confirms something before proposing`);
    for (const p of t.profiles) assert.deepEqual(Object.keys(p.members).sort(), t.members.map(m => m.id).sort(), `${id}/${p.id}`);
  }
});

test('templates carry no credentials, grants or approvals', () => {
  for (const id of ['marketing-team', 'support-team']) {
    const raw = readFileSync(new URL(`../groups/${id}/group.source.json`, import.meta.url), 'utf8');
    assert.doesNotMatch(raw, /service_token|"token"|approvals|host_use|host_packs|access"/, id);
  }
});

test('v2 fields are refused on v1, and v2 is checked like the runtime checks it', () => {
  const v2 = source('marketing-team');
  const bad = (change, why) => assert.throws(() => validateGroup(change(structuredClone(v2))), undefined, why);
  bad(t => ({ ...t, api_version: 'soot/group-template/v1' }), 'v1 with inputs');
  bad(t => { t.root = ''; t.api_version = 'soot/group-template/v1'; delete t.inputs; delete t.profiles; delete t.schedules; return t; }, 'v1 without a root');
  bad(t => { delete t.profiles[0].members.editor; return t; }, 'a profile must name every member');
  bad(t => { t.profiles[0].members.radar.tier = 'imagen'; return t; }, 'a member tier is a language tier');
  bad(t => { t.profiles[0].schedules = ['nope']; return t; }, 'an unknown schedule');
  bad(t => { t.schedules[0].every = '30m'; return t; }, 'a cycle shorter than an hour');
  bad(t => { t.schedules[0].at = '24:00'; return t; }, 'a bad clock');
  bad(t => { t.schedules[0].timezone = 'Asia/Ho_Chi_Minh'; delete t.schedules[0].at; return t; }, 'a timezone without a time');
  bad(t => { t.inputs.push({ ...t.inputs[0] }); return t; }, 'a repeated input');
  bad(t => { t.inputs[0].secret = true; return t; }, 'an unknown input field');
  bad(t => { t.members[0].packs.push('not-a-dependency'); return t; }, 'a member selects a dependency of the template');
  bad(t => { t.members[0].packs = ['marketing', 'marketing:read']; return t; }, 'a pack once per member');
  bad(t => { t.members[0].use = []; return t; }, 'use is retired');
  assert.doesNotThrow(() => validateGroup(structuredClone(v2)));
});
