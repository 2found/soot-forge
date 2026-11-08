// seo_report: novel pages (lohi2.com/truyen/<slug>) that Search Console shows but few click, with a
// concrete change per page. Reads Google with the same GSC_GOOGLE sign-in the marketing pack uses;
// the web app is not touched: the output is a report plus content opportunities for the company loop.
import { fail, skippedFor, short, addDays, ictDay } from './base.mjs';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3';
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

/** A typical organic CTR for an average position (industry curve, rounded): the bar a page is held to. */
export function expectedCtr(position) {
  const table = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
  if (!(position >= 1)) return 0;
  if (position <= 10) return table[Math.round(position) - 1] ?? 0.018;
  return position <= 20 ? 0.01 : 0.004;
}

async function googleToken(cred, fetch) {
  let c;
  try { c = JSON.parse(cred); } catch { return { error: 'signed_out' }; }
  if (c?.type !== 'google_oauth' || !c.refresh_token || !c.client_id) return { error: 'signed_out' };
  const res = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret ?? '' }).toString() });
  const out = await res.json().catch(() => ({}));
  if (res.status === 400 || res.status === 401) return { error: out.error === 'invalid_grant' ? 'revoked' : 'signed_out' };
  if (!res.ok || !out.access_token) fail('google_failed', `Google token endpoint answered ${res.status}`);
  return { token: out.access_token };
}

async function gsc(site, token, body, fetch) {
  const res = await fetch(`${GSC_API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) return { error: res.status === 403 ? 'no_access' : 'revoked' };
  if (!res.ok) fail('gsc_failed', `Search Console answered ${res.status}`);
  return { rows: (await res.json()).rows ?? [] };
}

const needsPerson = reason => ({
  status: 'needs_person', ok: false, reason,
  message: reason === 'revoked' ? 'Quyền đọc Search Console đã bị thu hồi: cần đăng nhập Google lại.' : reason === 'no_access' ? 'Tài khoản Google này không có quyền với trang Search Console của Lohi.' : 'Cần đăng nhập Google cho Search Console.',
  needs_person: { credential: 'GSC_GOOGLE', reason: `oauth_${reason}` },
});

/** The page's <title> and meta description, from the public page itself (same host as SITE_URL only). */
export async function pageMeta(url, deps, siteHost) {
  try {
    if (new URL(url).host !== siteHost) return null;
    const res = await deps.fetch(url, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
    const desc = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1]?.trim() ?? /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1]?.trim() ?? null;
    return { title, description: desc };
  } catch { return null; }
}

/** One concrete change for a page, from its numbers and its best queries. Deterministic: a Soot may refine the words. */
export function suggest(page, meta) {
  const top = page.top_queries[0]?.query;
  const out = [];
  if (page.issue === 'low_ctr') {
    if (top && meta?.title && !fold(meta.title).includes(fold(top))) out.push(`Đưa cụm "${top}" vào title (hiện: "${short(meta.title, 70)}", ${meta.title.length} ký tự); gợi ý: "${short(`${top[0].toUpperCase()}${top.slice(1)} – đọc online | Lohi`, 60)}".`);
    else if (top) out.push(`Title đã chứa hoặc chưa kiểm tra được "${top}" nhưng ít người bấm: viết lại title/meta cho rõ điều người đọc nhận được (thể loại, số chương, đang ra hay đã hoàn).`);
    if (meta && (!meta.description || meta.description.length < 70)) out.push('Meta description thiếu hoặc quá ngắn: viết 120-155 ký tự nêu thể loại, tình trạng và một câu móc.');
    else if (meta && top && !fold(meta.description).includes(fold(top))) out.push(`Meta description chưa nhắc "${top}".`);
  } else {
    out.push(`Vị trí ${page.position}: viết một bài blog hỗ trợ cho "${top ?? 'từ khoá chính'}" và dẫn liên kết nội bộ về trang truyện để đẩy lên trang một.`);
  }
  return out;
}

export async function seo_report(input, deps) {
  const { env, fetch, now } = deps;
  if (!env.GSC_GOOGLE) return skippedFor('GSC_GOOGLE');
  const site = String(input.site || env.GSC_SITE || 'sc-domain:lohi2.com');
  const days = Math.min(Math.max(Number(input.days) || 28, 7), 90);
  const minImpressions = Math.min(Math.max(Number(input.min_impressions) || 50, 1), 100_000);
  const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 40);
  const siteUrl = new URL(env.SITE_URL || 'https://lohi2.com');
  const auth = await googleToken(env.GSC_GOOGLE, fetch);
  if (auth.error) return needsPerson(auth.error);
  const end = addDays(ictDay(now), -2), start = addDays(end, -(days - 1)); // Search Console lags about two days
  const filter = [{ filters: [{ dimension: 'page', operator: 'contains', expression: '/truyen/' }] }];
  const pages = await gsc(site, auth.token, { startDate: start, endDate: end, dimensions: ['page'], dimensionFilterGroups: filter, rowLimit: 1000 }, fetch);
  if (pages.error) return needsPerson(pages.error);
  const queries = await gsc(site, auth.token, { startDate: start, endDate: end, dimensions: ['page', 'query'], dimensionFilterGroups: filter, rowLimit: 5000 }, fetch);
  if (queries.error) return needsPerson(queries.error);
  const byPage = new Map();
  for (const r of queries.rows) {
    const [page, query] = r.keys ?? [];
    if (!page || !query) continue;
    const list = byPage.get(page) ?? [];
    list.push({ query, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, position: Math.round((r.position ?? 0) * 10) / 10 });
    byPage.set(page, list);
  }
  const candidates = [];
  for (const r of pages.rows) {
    const url = r.keys?.[0];
    const impressions = r.impressions ?? 0, clicks = r.clicks ?? 0, position = Math.round((r.position ?? 0) * 10) / 10;
    if (!url || impressions < minImpressions) continue;
    const ctr = impressions ? clicks / impressions : 0;
    const issue = ctr < 0.5 * expectedCtr(position) ? 'low_ctr' : position >= 8 && position <= 20 ? 'near_page_one' : null;
    if (!issue) continue;
    const top_queries = (byPage.get(url) ?? []).sort((a, b) => b.impressions - a.impressions).slice(0, 3);
    candidates.push({ url, slug: url.split('/truyen/')[1]?.split(/[/?#]/)[0] ?? null, impressions, clicks, ctr: Math.round(ctr * 10000) / 10000, position, issue, top_queries });
  }
  candidates.sort((a, b) => b.impressions - a.impressions);
  const report = candidates.slice(0, limit);
  for (const p of report.slice(0, 8)) {
    const meta = await pageMeta(p.url, deps, siteUrl.host);
    p.current = meta;
    p.suggestions = suggest(p, meta);
  }
  for (const p of report.slice(8)) p.suggestions = suggest(p, null);
  // Content opportunities in the shape company-loop's digest_save takes (the Lead decides whether to send them).
  const opportunities = report.filter(p => p.top_queries[0] && p.top_queries[0].query.trim().split(/\s+/).length >= 2).slice(0, 3).map(p => ({
    title: short(`Bài hỗ trợ cho "${p.top_queries[0].query}"`, 140), product: 'lohi', kind: 'content', query: short(p.top_queries[0].query, 120),
    evidence_refs: [short(p.url, 200), `gsc:${days}d:${p.impressions} hiển thị, ${p.clicks} bấm, vị trí ${p.position}`],
    signal_count: p.top_queries.length, est_effort: 'S', est_value: p.impressions >= 1000 ? 'high' : 'medium', confidence: 0.4,
    target_outcome: 'signups', expected_delta: 1, check_after_days: 28,
  }));
  return { ok: true, site, window: { from: start, to: end }, pages_seen: pages.rows.length, flagged: candidates.length, pages: report, opportunities };
}
