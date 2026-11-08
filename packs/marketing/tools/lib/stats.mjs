// TikTok and YouTube numbers without a login: `yt-dlp --skip-download --dump-json <url>` prints view, like, comment and repost
// counts for any public video. The tool reads the videos of published posts (and, optionally, the latest videos of a channel
// handle) into `metrics` (source tiktok|youtube, one row per url and day). No credential, never posts; without yt-dlp it
// answers one plain need instead of failing.
import { execFile } from 'node:child_process';
import { fail, eq } from './store.mjs';
import { setSetting } from './ops.mjs';

const platformOfUrl = u => {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^(www|m|vm)\./, '');
    if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return 'tiktok';
    if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'youtube';
  } catch { /* not a url */ }
  return null;
};
export const YT_DLP_MISSING = 'Chưa cài yt-dlp nên chưa đọc được số TikTok/YouTube. Cài một lần: `brew install yt-dlp` (hoặc `pipx install yt-dlp`), rồi đặt YT_DLP_BIN nếu không nằm trong PATH.';
const SAFE_URL = /^https:\/\/[^\s'"]{1,300}$/;

/** yt-dlp's JSON for one url, or {error}. `exec` is the tests' stand-in for the binary. */
export function ytdlp(bin, args, { timeoutMs = 90_000, exec = execFile } = {}) {
  return new Promise(resolve => {
    exec(bin, args, { timeout: timeoutMs, maxBuffer: 8_000_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (err, stdout) => {
      if (err?.code === 'ENOENT') return resolve({ missing: true });
      if (err && !stdout) return resolve({ error: err.killed ? 'timeout' : 'failed' });
      const rows = [];
      for (const line of String(stdout).split('\n')) { try { const j = JSON.parse(line); if (j && typeof j === 'object') rows.push(j); } catch { /* not a json line */ } }
      resolve(rows.length ? { rows } : { error: 'no_data' });
    });
  });
}
const int = v => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/**
 * video_stats {handles?: [{url, limit?}], days?}: published video posts plus the latest `limit` (≤ 10) videos of a channel
 * handle url. One row per video and day; a second read of the day replaces the first (never doubles).
 */
export async function video_stats(input, { store, now, env, exec }) {
  const bin = env.YT_DLP_BIN || 'yt-dlp';
  const day = new Date(now).toISOString().slice(0, 10);
  const posts = (await store.query('posts', [eq('state', 'published')], { limit: 300 })).filter(p => p.url && platformOfUrl(p.url));
  const targets = new Map(posts.map(p => [p.url, { url: p.url, platform: platformOfUrl(p.url), post: p.ref }]));
  const handles = Array.isArray(input.handles) ? input.handles : [];
  if (handles.length > 5) fail('invalid_request', 'At most 5 handles.');
  for (const h of handles) {
    if (!SAFE_URL.test(String(h?.url)) || !platformOfUrl(h.url)) fail('invalid_request', 'A handle is a https tiktok.com or youtube.com address.');
  }
  if (!targets.size && !handles.length) { await setSetting(store, 'video_stats', { state: 'idle', at: new Date(now).toISOString() }); return { ok: true, status: 'idle', rows: 0, message: 'Chưa có bài video đã đăng để đọc số.', notify: false, wake: false }; }
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 40);
  const errors = [];
  const found = [];
  for (const t of [...targets.values()].slice(0, limit)) {
    const r = await ytdlp(bin, ['--skip-download', '--dump-json', '--no-warnings', '--no-playlist', t.url], { exec });
    if (r.missing) return missing(store, now);
    if (r.error) { errors.push({ url: t.url, error: r.error }); continue; }
    found.push({ ...t, j: r.rows[0] });
  }
  for (const h of handles) {
    const n = Math.min(Math.max(Number(h.limit) || 5, 1), 10);
    const r = await ytdlp(bin, ['--skip-download', '--dump-json', '--no-warnings', '--playlist-end', String(n), h.url], { exec, timeoutMs: 180_000 });
    if (r.missing) return missing(store, now);
    if (r.error) { errors.push({ url: h.url, error: r.error }); continue; }
    for (const j of r.rows) {
      const url = String(j.webpage_url ?? '');
      if (SAFE_URL.test(url) && platformOfUrl(url)) found.push({ url, platform: platformOfUrl(url), j });
    }
  }
  let rows = 0;
  const seen = new Set();
  for (const f of found) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    const views = int(f.j.view_count);
    if (views === null) { errors.push({ url: f.url, error: 'no_view_count' }); continue; }
    await store.remove('metrics', [eq('url', f.url), eq('day', day), eq('source', f.platform), eq('query', '')]);
    await store.insert('metrics', { url: f.url, source: f.platform, day, query: '', views, likes: int(f.j.like_count), comments: int(f.j.comment_count), reposts: int(f.j.repost_count), impressions: null, clicks: null, position: null });
    rows++;
  }
  const why = rows ? null : errors.length ? 'read_failed' : 'no_videos';
  await setSetting(store, 'video_stats', { state: 'ok', at: new Date(now).toISOString(), rows, errors: errors.length, ...(why ? { why } : {}) });
  return { ok: true, status: 'ok', rows, videos: seen.size, errors, ...(why ? { why, message: why === 'read_failed' ? 'yt-dlp không đọc được video nào (xem errors).' : 'Không tìm thấy video nào để đọc.' } : {}), notify: false, wake: false };
}

async function missing(store, now) {
  await setSetting(store, 'video_stats', { state: 'yt_dlp_missing', message: YT_DLP_MISSING, at: new Date(now).toISOString() });
  // A quiet skip: the reason is on the loop-health screen and in this answer; the schedule neither fails nor wakes a model.
  return { ok: true, skipped: true, status: 'yt_dlp_missing', reason_code: 'yt_dlp_missing', message: YT_DLP_MISSING, notify: false, wake: false };
}
