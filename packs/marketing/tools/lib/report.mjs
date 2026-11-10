// The Editor's daily report (friction r2): what went out, which posts worked, what the plan does
// next, and the one or two things a person may want to know. At most six plain Vietnamese lines,
// built here so the Editor only says them (one short turn a day, no tool calls of its own).
import { eq, gte } from './store.mjs';
import { performance, topPosts } from './insight.mjs';
import { getSettings, setSetting } from './ops.mjs';
import { plan } from './plan.mjs';
import { awarenessMix } from './health.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const TZ = 'Asia/Ho_Chi_Minh';
const when = at => `${new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ })} ${new Date(at).toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: TZ })}`;
const num = n => new Intl.NumberFormat('vi-VN').format(n);
const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

export async function report(input, deps) {
  const { store, now } = deps;
  const cfg = (await store.one('settings', [eq('key', 'plan')]))?.value ?? {};
  const chKey = cfg.channel ?? 'blog-lohi';
  const lines = [];

  // 1. What went out in the last 24 hours, and what waits.
  const log = await store.query('publish_log', [eq('status', 'published'), gte('at', new Date(now - DAY).toISOString())], { order: 'at', limit: 200 });
  const sent = log.filter(r => r.action === 'publish');
  const blog = sent.filter(r => r.channel === chKey).length;
  const queue = (await store.query('queue', [], { limit: 100 })).filter(q => (q.action ?? 'publish') === 'publish');
  const refused = (await store.query('posts', [eq('state', 'refused')], { order: 'updated_at', limit: 20 })).filter(p => now - Date.parse(p.updated_at) < DAY);
  lines.push(`Hôm qua đến giờ: đăng ${sent.length} bài (blog ${blog}, mạng xã hội ${sent.length - blog}); ${queue.length} bài đang chờ đăng${refused.length ? `; ${refused.length} bài bị từ chối (${short(refused[0].reason, 70)})` : ''}.`);

  // 2. What worked.
  const perf = await performance(store, chKey, now);
  const top = topPosts(perf, 3);
  if (top.length) {
    top.forEach((p, i) => lines.push(`${i + 1}. ${p.title}: ${p.impressions != null ? `${num(p.clicks)} lượt bấm, ${num(p.impressions)} lượt hiển thị` : `${num(p.clicks ?? 0)} lượt bấm${p.signups ? `, ${num(p.signups)} đăng ký` : ''}`}.`));
  } else {
    lines.push(perf.basis === 'none' ? 'Chưa có số liệu Search Console hay chiến dịch nên chưa biết bài nào hiệu quả; kế hoạch chọn chủ đề theo danh mục.' : 'Các bài đã đăng chưa có lượt bấm nào; kế hoạch sẽ đổi thể loại.');
  }

  // 3. What the plan does next.
  const next = queue.filter(q => q.channel === chKey).sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))[0];
  let brief = null;
  try { brief = await plan({}, deps); } catch { /* the line below copes */ }
  if (next) lines.push(`Tiếp theo: bài blog đã xếp lịch lúc ${when(Date.parse(next.scheduled_at))}${brief?.topic ? `; sau đó viết về "${short(brief.topic, 60)}"` : ''}.`);
  else if (brief?.topic) lines.push(`Tiếp theo: viết về "${short(brief.topic, 60)}"${brief.insight?.why ? ` (${short(brief.insight.why, 90)})` : ''}.`);
  else lines.push('Tiếp theo: chưa đọc được danh mục truyện nên chưa chọn được chủ đề.');

  // 4. Things to know, each told once: a draft open more than a day (it never blocks the plan), a signed-out channel.
  const told = new Set((await store.one('settings', [eq('key', 'stale_told')]))?.value ?? []);
  const stale = (await store.query('posts', [eq('channel', chKey)], { order: 'updated_at', limit: 40 }))
    .filter(p => ['draft', 'checking', 'ready'].includes(p.state) && now - Date.parse(p.updated_at) >= DAY && !told.has(p.ref));
  if (stale.length) {
    lines.push(`Bài ${stale[0].ref} mở hơn một ngày (${stale[0].state === 'ready' ? 'đã kiểm tra, chưa xếp lịch' : 'chưa kiểm tra xong'}); không chặn kế hoạch.`);
    await setSetting(store, 'stale_told', [...told, ...stale.map(p => p.ref)].slice(-60));
  }
  const settings = await getSettings(store);
  if (settings.gsc && settings.gsc.state !== 'ok' && lines.length < 6) lines.push(settings.gsc.message ?? 'Search Console chưa đọc được.');
  const signedOut = (await store.query('channels', [], { limit: 50 })).filter(c => c.kind === 'social' && c.paused && c.paused_reason === 'signed_out');
  if (signedOut.length && lines.length < 6) lines.push(`${signedOut.map(c => c.platform ?? c.key).join(', ')} chưa đăng nhập: chưa tạo bài cho ${signedOut.length > 1 ? 'các kênh này' : 'kênh này'}.`);
  if (settings.paused_all && lines.length < 6) lines.push('Đang tạm dừng đăng mọi kênh.');

  // The mix of reader awareness (nấc 1/2/3) over 14 days, only when it is lopsided.
  const mix = await awarenessMix(store, now);
  if (mix.note && lines.length < 6) lines.push(mix.note[0].toUpperCase() + mix.note.slice(1));

  const out = lines.slice(0, 6);
  await setSetting(store, 'daily_report', { at: new Date(now).toISOString(), lines: out });
  return { lines: out, text: out.join('\n'), notify: true, wake: true };
}
