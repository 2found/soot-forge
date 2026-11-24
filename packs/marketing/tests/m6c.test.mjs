// M6c: the desk says whose folder the library is (root_kind), so a hand-off can
// say where its file is; and Kho khóa's words for the marketing folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { world, saved } from './desk-world.mjs';
import { rootKind } from '../tools/lib/root.mjs';

const pack = JSON.parse(await readFile(new URL('../pack.json', import.meta.url), 'utf8'));
const lib = (view) => view.sources.find(s => s.id === 'library');

test('rootKind: the host\'s team or Soot folder is "team", any other folder is "chosen", none is null', () => {
  assert.equal(rootKind({ MARKETING_ROOT: '/Users/an/.soot/nest/data/team-folders/growth/MARKETING_ROOT' }), 'team');
  assert.equal(rootKind({ MARKETING_ROOT: '/srv/soot/data/soot-folders/growth-editor/MARKETING_ROOT/' }), 'team', 'a Soot in no team');
  assert.equal(rootKind({ MARKETING_ROOT: 'C:\\soot\\data\\team-folders\\growth\\MARKETING_ROOT' }), 'team');
  assert.equal(rootKind({ MARKETING_ROOT: '/Users/an/Documents/marketing' }), 'chosen');
  assert.equal(rootKind({ MARKETING_ROOT: '/Users/an/MARKETING_ROOT' }), 'chosen', 'a folder the founder named so is still theirs');
  assert.equal(rootKind({ MARKETING_ROOT: '/data/team-folders/growth/OTHER' }), 'chosen', 'another credential\'s folder is not the library default');
  assert.equal(rootKind({ MARKETING_ROOT: '  ' }), null);
  assert.equal(rootKind({}), null);
});

test('page_view says root_kind in the library source: team for the default folder, chosen otherwise, absent without one', async () => {
  const team = await world({ hub: false, teamFolder: true });
  assert.equal(lib(await team.view({ view: 'summary' })).root_kind, 'team');
  const s = await saved(team);
  assert.equal(lib(await team.view({ view: 'item', ref: s.ref })).root_kind, 'team', 'the item sheet carries it too');
  const chosen = await world({ hub: false });
  assert.equal(lib(await chosen.view({ view: 'summary' })).root_kind, 'chosen');
  const none = lib(await chosen.call('page_view', { view: 'summary' }, {}, { env: {} }));
  assert.equal(none.ok, false);
  assert.equal(none.root_kind, undefined, 'no folder: nothing to say whose it is');
});

test('Kho khóa: the marketing folder describes its default without sending the founder to Kho khóa from inside it', () => {
  const root = pack.needs.credentials.MARKETING_ROOT;
  assert.equal(root.default, 'team_folder');
  assert.match(root.description, /Mặc định là thư mục riêng của đội; chọn thư mục khác nếu bạn muốn mở nó bằng Finder\./);
  assert.doesNotMatch(root.description, /Kho khóa|Nest ›|products\.json|brand\.md/);
  const old = pack.needs.credentials.PRODUCT_ADMIN_KEY;
  assert.equal(old.title, 'Khoá dùng chung (cũ, không cần nữa)');
  assert.equal(old.optional, true, 'the replaced key still works as a fallback, so it stays optional');
  assert.doesNotMatch(JSON.stringify(pack.needs.credentials), /agent_marketing|PRODUCT_API_URL|PRODUCT_AGENT_KEY\)/);
});
