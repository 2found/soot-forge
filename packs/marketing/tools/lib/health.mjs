// Which inputs of the marketing stage are starving, in words a person acts on ("GSC 0 dòng", "chưa có số TikTok").
// A read: the company loop's health chain hands this answer to company-loop_health_sync, so the founder sees one screen.
import { eq, gte } from './store.mjs';
import { getSettings } from './ops.mjs';

const DAY = 86_400_000;

export async function inputs_health(_input, { store, now }) {
  const since = n => new Date(now - n * DAY).toISOString().slice(0, 10);
  const settings = await getSettings(store);
  const stats = (await store.one('settings', [eq('key', 'video_stats')]))?.value ?? null;
  const radar = (await store.query('sources', [], { limit: 100 }));
  const [gsc, tiktok, youtube, signals, posts] = await Promise.all([
    store.query('metrics', [eq('source', 'gsc'), gte('day', since(28))], { limit: 500 }),
    store.query('metrics', [eq('source', 'tiktok'), gte('day', since(14))], { limit: 200 }),
    store.query('metrics', [eq('source', 'youtube'), gte('day', since(14))], { limit: 200 }),
    store.query('signals', [], { limit: 500 }),
    store.query('posts', [], { limit: 500 }),
  ]);
  const published = posts.filter(p => p.state === 'published');
  const videos = published.filter(p => p.kind === 'video' || /tiktok\.com|youtube\.com|youtu\.be/.test(p.url ?? ''));
  const input = (key, label, rows, starvingText, okText) => ({ key, label, rows, starving: rows === 0, detail: rows === 0 ? starvingText : okText });
  const gscWhy = settings.gsc?.message ?? (settings.gsc?.state === 'ok' ? 'Search Console đã đọc nhưng chưa có dòng nào cho bài đã đăng.' : 'Search Console chưa đọc lần nào.');
  const out = [
    input('gsc', 'Search Console', gsc.length, `GSC 0 dòng — ${gscWhy}`, `GSC ${gsc.length} dòng (28 ngày)`),
    input('signals', 'Tín hiệu thị trường', signals.length, radar.length ? `Chưa có tín hiệu thị trường${radar.every(r => r.last_error) ? ': mọi nguồn đều lỗi' : ''}.` : 'Chưa có tín hiệu thị trường: chưa cấu hình nguồn radar.', `${signals.length} tín hiệu, ${signals.filter(s => s.state === 'kept').length} đã giữ`),
    input('tiktok', 'Số TikTok', tiktok.length, stats?.state === 'yt_dlp_missing' ? `Chưa có số TikTok — ${stats.message}` : videos.some(p => /tiktok\.com/.test(p.url ?? '')) ? 'Chưa có số TikTok: đã có video đăng nhưng chưa đọc được số.' : 'Chưa có số TikTok: chưa có video TikTok nào được đăng kèm địa chỉ.', `${tiktok.length} video TikTok có số (14 ngày)`),
    input('youtube', 'Số YouTube', youtube.length, stats?.state === 'yt_dlp_missing' ? `Chưa có số YouTube — ${stats.message}` : 'Chưa có số YouTube: chưa có video YouTube nào được đăng kèm địa chỉ.', `${youtube.length} video YouTube có số (14 ngày)`),
  ];
  return { inputs: out, posts: { published: published.length, videos: videos.length } };
}
