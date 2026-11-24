// The desk world the desk and page suites share: an in-memory store, an
// in-memory hub and a temp library with two products, a video channel with a
// delivered campaign, a radar, an empty videos.csv and a channel with no product.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tools/marketing.mjs';
import { fakeStore } from './fake-store.mjs';
import { fakeHub, hubEnv } from './fake-hub.mjs';

export const T0 = Date.parse('2026-11-24T02:00:00Z'); // Tuesday 09:00 in Asia/Ho_Chi_Minh
export const MIN = 60_000, H = 60 * MIN, DAY = 24 * H;
export const PUBLISH = ['cms_publish', 'social_publish', 'social_record'];

/** teamFolder: the library sits where the host's "team_folder" default puts it (<data>/team-folders/<team>/MARKETING_ROOT). */
export async function library({ teamFolder = false } = {}) {
  let root = await mkdtemp(join(tmpdir(), 'mk-desk-'));
  if (teamFolder) { root = join(root, 'team-folders', 'growth', 'MARKETING_ROOT'); await mkdir(root, { recursive: true }); }
  await writeFile(join(root, 'products.json'), JSON.stringify({ products: [
    { id: 'acme', name: 'Acme Truyện', mark: 'AT', site: 'acme.example', hub_site: 'acme', video_channels: ['acme-video'], accounts: { facebook: 'Trang Acme' } },
    { id: 'beta', name: 'Beta', hub_site: 'beta' },
  ] }));
  const camp = join(root, 'channels/acme-video/campaigns/ep-1');
  await mkdir(join(camp, '08-delivery'), { recursive: true });
  await mkdir(join(camp, '05-scripts'), { recursive: true });
  await writeFile(join(camp, 'campaign.json'), JSON.stringify({ slug: 'ep-1', product: 'acme', platforms: ['tiktok'], languages: ['vi'], series: 'hay' }));
  await writeFile(join(camp, '08-delivery/ep-1-final.mp4'), '');
  await mkdir(join(root, 'channels/acme-video/radar'), { recursive: true });
  await writeFile(join(root, 'channels/acme-video/radar/2026-11-23.md'), '# Radar\n\n| # | Tên Việt | Thể loại | Tín hiệu | Onboard? |\n| --- | --- | --- | --- | --- |\n| 1 | [Bộ A](https://a.example) | tiên hiệp | 12k | _ |\n| 2 | Bộ B | đô thị | 4k | Không |\n');
  await mkdir(join(root, 'channels/acme-video/metrics'), { recursive: true });
  await writeFile(join(root, 'channels/acme-video/metrics/videos.csv'), 'posted,series,slug,script,platform,url,duration_s,views_48h,views_7d\n');
  await mkdir(join(root, 'channels/side-show/campaigns/s-1'), { recursive: true });
  await writeFile(join(root, 'channels/side-show/campaigns/s-1/campaign.json'), JSON.stringify({ slug: 's-1', platforms: ['tiktok'] }));
  return root;
}

export async function world({ hub = true, now = T0, teamFolder = false } = {}) {
  const w = { now, root: await library({ teamFolder }) };
  w.store = fakeStore({ clock: () => w.now });
  w.hub = fakeHub({ clock: () => w.now, sites: ['acme', 'beta'] });
  w.env = { MARKETING_ROOT: w.root, ...(hub ? hubEnv() : {}) };
  // w.fetch (when set) stands in for the hub's, e.g. to compose a fake Nest runtime (fake-runtime.mjs).
  // A refusal comes back as {error: {code, message}}, as the CLI prints it.
  w.call = (name, input, ctx = {}, over = {}) => run(name, { input, ...ctx }, { store: over.store ?? w.store, now: w.now, env: over.env ?? w.env, fetchImpl: over.fetch ?? w.fetch ?? w.hub.fetch })
    .catch(e => { if (!e.code) throw e; return { error: { code: e.code, message: e.message } }; });
  w.view = (input) => w.call('page_view', input);
  w.act = (input) => w.call('page_action', { request_id: 'r-' + Math.random().toString(36).slice(2), ...input });
  w.publishes = () => w.hub.calls.filter(c => PUBLISH.includes(c[0])).length;
  return w;
}

export const BLOG = { lang: 'vi', title: 'Chín bộ tiên hiệp nên đọc', summary: 'Chín bộ đáng đọc, mỗi bộ một lý do.', body: 'Bài viết về chín bộ tiên hiệp.\n\nĐọc ở acme.example.' };
export const XPOST = { channel: 'x', lang: 'vi', text: 'Chín bộ tiên hiệp nên đọc tuần này.', link: 'https://acme.example/blog/tien-hiep' };
export async function saved(w, extra = {}) {
  return w.call('item_save', { product: 'acme', slug: 'tien-hiep', langs: [BLOG], posts: [XPOST], ...extra });
}

/** The bundle input the Editor builds from cms_read / social_list. */
export async function bundleOf(w, ref) {
  const blog = (await w.hub.fetch('http://127.0.0.1:18999/api/hub/v1/tool', { headers: { Authorization: `Bearer ${'t'.repeat(40)}` }, body: JSON.stringify({ operation: 'marketing_cms_read', input: { site: 'acme', slug: 'tien-hiep' } }) })).json();
  const b = await blog;
  const x = [...w.hub.social.values()][0];
  w.hub.calls.length = 0;
  return { ref, product: 'acme', posts: [
    { channel: 'blog', lang: 'vi', site: 'acme', slug: 'tien-hiep', revision: b.revision, title: b.title },
    { channel: 'x', lang: 'vi', id: x.id, revision: x.revision, text: x.text, link: x.link },
  ] };
}
