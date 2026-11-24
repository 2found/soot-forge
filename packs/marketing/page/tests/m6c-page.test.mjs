// M6c on the page: when the library is the team's own folder (the default, a
// hidden folder of Soot), the TikTok and newsletter hand-offs say where the
// file is in words and offer a folder the founder can open; a chosen folder
// keeps the plain path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mount, text } from './fake-dom.mjs';
import { world } from '../../tests/desk-world.mjs';

const script = await readFile(new URL('../app.js', import.meta.url), 'utf8');

async function desk(w, extra = () => null) {
  const d = mount(script, async ({ mode, input }) => {
    const x = await extra({ mode, input });
    if (x) return x;
    if (mode === 'view' && input === 'approvals') return { approvals: [], total: 0 };
    if (mode === 'view') return w.view(input);
    if (mode === 'action') return { output: await w.call('page_action', input) };
    if (mode === 'ask') return { text: 'ok' };
    throw new Error(mode);
  });
  await d.flush();
  return d;
}
const press = async (d, el) => { assert.ok(el, 'element to press'); el.click(); await d.flush(); };
const sheet = (d) => text(d.app.children[1]);
const tab = (d, id) => press(d, d.find(`[data-k="tab:${id}"]`));
const PICK = 'nest://settings/setup?key=MARKETING_ROOT';

async function tiktokWorld(teamFolder) {
  const w = await world({ hub: false, teamFolder });
  const cut = join(w.root, 'channels/acme-video/campaigns/ep-1/08-delivery/s1-vertical/tiktok');
  await mkdir(cut, { recursive: true });
  await writeFile(join(cut, 'ep-1.mp4'), '');
  await writeFile(join(cut, 'caption.txt'), 'Một bộ hay #truyen');
  await w.call('library_scan', { hub: false });
  const d = await desk(w);
  await tab(d, 'content');
  await press(d, d.find('[data-k="stage:scheduled"]'));
  await press(d, d.all('.mk-row.click').find(r => /Ep 1/.test(text(r))));
  return d;
}

test('TikTok from the team folder: where the video is in words, Chép đường dẫn kept, and a folder easier to open', async () => {
  const d = await tiktokWorld(true);
  const t = sheet(d);
  assert.match(t, /Video nằm trong thư mục riêng của đội, một thư mục ẩn trên máy chạy Soot mà Finder không hiện sẵn\./);
  assert.match(t, /⌘⇧G/);
  assert.doesNotMatch(t, /team-folders/, 'the hidden path is copied, not shown');
  assert.match(text(d.find('[data-k="cp:video"]')), /Chép đường dẫn/);
  await press(d, d.find('[data-k="cp:root"]'));
  assert.equal(d.opened.at(-1), PICK);
  assert.match(text(d.find('[data-k="cp:root"]')), /Chọn thư mục dễ mở hơn/);
});

test('TikTok from a chosen folder: the path as before, no folder offer', async () => {
  const d = await tiktokWorld(false);
  assert.match(sheet(d), /08-delivery\/s1-vertical\/tiktok\/ep-1\.mp4/);
  assert.doesNotMatch(sheet(d), /thư mục ẩn/);
  assert.ok(d.find('[data-k="cp:video"]'));
  assert.equal(d.find('[data-k="cp:root"]'), null);
});

async function exported(teamFolder) {
  const w = await world({ hub: false, teamFolder });
  const products = JSON.parse(await readFile(join(w.root, 'products.json'), 'utf8'));
  products.products[0].newsletter = true;
  await writeFile(join(w.root, 'products.json'), JSON.stringify(products));
  await mkdir(join(w.root, 'acme/newsletter'), { recursive: true });
  await writeFile(join(w.root, 'acme/newsletter/subscribers.csv'), 'email\nan@vidu.vn\n');
  const n = { subject: 'Tuần này ở Acme', body: 'Ba bộ mới tuần này.' };
  const s = await w.call('item_save', { product: 'acme', slug: 'ban-tin', format: 'newsletter', newsletter: n });
  assert.equal((await w.call('publish_bundle', { ref: s.ref, product: 'acme', posts: [{ channel: 'newsletter', lang: 'vi', revision: 1, ...n }] })).ok, true);
  const d = await desk(w, ({ mode, input }) => (mode === 'view' && input === 'abilities' ? { email: false } : null));
  await tab(d, 'content');
  await press(d, d.find('[data-k="stage:scheduled"]'));
  await press(d, d.all('.mk-row.click').find(r => /Tuần này ở Acme/.test(text(r))));
  await press(d, d.find('[data-k="nl:export"]'));
  return d;
}

test('newsletter export in the team folder: Ở đâu says it is hidden, paths to copy, and a folder easier to open', async () => {
  const d = await exported(true);
  const t = sheet(d);
  assert.match(t, /Đã xuất ra file/);
  assert.match(t, /Trong thư mục riêng của đội, một thư mục ẩn trên máy chạy Soot mà Finder không hiện sẵn/);
  assert.match(t, /⌘⇧G/);
  assert.match(text(d.find('[data-k="nl:path:0"]')), /Chép đường dẫn/);
  await press(d, d.find('[data-k="nl:root"]'));
  assert.equal(d.opened.at(-1), PICK);
});

test('newsletter export in a chosen folder: the plain where, no folder offer', async () => {
  const d = await exported(false);
  assert.match(sheet(d), /Thư mục bản tin của sản phẩm, trong thư mục marketing/);
  assert.doesNotMatch(sheet(d), /thư mục ẩn|⌘⇧G/);
  assert.ok(d.find('[data-k="nl:path:0"]'));
  assert.equal(d.find('[data-k="nl:root"]'), null);
});
