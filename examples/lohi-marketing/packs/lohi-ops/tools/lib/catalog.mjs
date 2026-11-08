// catalog_health: the api's catalog-health endpoint (GET {PRODUCT_API_URL}/admin/analysis/catalog-health)
// read check by check, turned into a findings table, and a Cần bạn need only for what a person must act on.
import { fail, skippedFor, lohiApi, upsert, needCard, iso, short } from './base.mjs';

const CHECKS = ['stale', 'gaps', 'thin', 'untranslated'];
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/** One finding per item: stable key, severity, and whether a person has to act. */
export function toFinding(check, it, t) {
  const slug = it.novel_slug;
  if (check === 'stale') {
    const days = it.days_since_last_chapter;
    const never = it.last_chapter_at === null;
    const severity = never || days >= t.act_stale_days ? 'high' : 'medium';
    return { key: `stale:${slug}`, check, severity, actionable: severity === 'high', subject: slug,
      line: never ? `${slug}: đang ra nhưng chưa có chương nào` : `${slug}: ${days} ngày không có chương mới (chương ${it.last_chapter_number})` };
  }
  if (check === 'gaps') {
    const severity = it.missing >= 25 ? 'high' : 'medium';
    return { key: `gaps:${slug}`, check, severity, actionable: it.missing >= t.act_gap_chapters, subject: slug,
      line: `${slug}: thiếu ${it.missing} chương (${it.ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')})` };
  }
  if (check === 'thin') {
    const empty = it.kind === 'empty';
    return { key: `thin:${slug}:${it.chapter_number}`, check, severity: empty ? 'high' : 'low', actionable: empty, subject: `${slug}#${it.chapter_number}`,
      line: `${slug} chương ${it.chapter_number}: ${empty ? 'trống' : `rất ngắn (${it.stored_bytes} byte)`}` };
  }
  const severity = it.cjk_ratio >= 0.5 ? 'high' : 'medium';
  return { key: `untranslated:${slug}:${it.chapter_number}`, check, severity, actionable: severity === 'high', subject: `${slug}#${it.chapter_number}`,
    line: `${slug} chương ${it.chapter_number}: còn ${Math.round(it.cjk_ratio * 100)}% chữ Hán chưa dịch` };
}

async function scan(deps, check, { days, limit, pages }) {
  const items = [];
  let cursor, scanned = 0, truncated = false;
  for (let p = 0; p < pages; p++) {
    const r = await lohiApi(deps, 'GET', '/admin/analysis/catalog-health', { query: { check, days, limit, cursor } });
    if (r.skipped) return { skipped: r.skipped };
    if (r.error) return { error: r.error };
    items.push(...(r.out.items ?? []));
    scanned += r.out.scanned ?? 0;
    truncated ||= !!r.out.truncated;
    cursor = r.out.next_cursor;
    if (!cursor) break;
  }
  return { items, scanned, truncated, next_cursor: cursor ?? null };
}

export async function catalog_health(input, deps) {
  const { store, now } = deps;
  const checks = Array.isArray(input.checks) && input.checks.length ? input.checks.filter(c => CHECKS.includes(c)) : CHECKS;
  if (!checks.length) fail('invalid_request', `checks is a list of ${CHECKS.join(', ')}.`);
  const t = {
    act_stale_days: Number(input.act_stale_days) || 30,
    act_gap_chapters: Number(input.act_gap_chapters) || 5,
  };
  const pages = Math.min(Math.max(Number(input.pages) || 3, 1), 10);
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
  const recent = Math.min(Math.max(Number(input.recent_days) || 3, 1), 30);
  const findings = [], scanned = {}, errors = [];
  for (const check of checks) {
    const days = check === 'stale' ? Math.min(Math.max(Number(input.stale_days) || 14, 1), 365) : recent;
    const r = await scan(deps, check, { days, limit, pages });
    if (r.skipped) return skippedFor(r.skipped);
    if (r.error) { errors.push({ check, ...r.error }); if (r.error.code === 'forbidden') break; continue; }
    scanned[check] = { novels: r.scanned, more: r.next_cursor !== null, truncated: r.truncated };
    findings.push(...r.items.map(it => toFinding(check, it, t)));
  }
  if (errors.length && !findings.length && !Object.keys(scanned).length) return { ok: false, error: { code: errors[0].code, message: errors[0].message }, errors };

  // History: first_seen survives; a finding the scan no longer reports is simply not in this run's table.
  const existing = new Map((await store.query('findings', [], { order: 'updated_at', limit: 500 })).map(r => [r.key, r]));
  let fresh = 0;
  for (const f of findings) {
    const was = existing.get(f.key);
    if (!was) fresh++;
    await upsert(store, 'findings', 'key', {
      key: f.key, check: f.check, severity: f.severity, subject: f.subject, detail: f.line, actionable: f.actionable,
      first_seen: was?.first_seen ?? iso(now), last_seen: iso(now),
    });
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.key.localeCompare(b.key));
  const actionable = findings.filter(f => f.actionable);
  const card = await needCard(store, 'catalog', {
    items: actionable.map(f => f.key), summary: `Kho truyện có ${actionable.length} điều cần xử lý`,
    lines: actionable.slice(0, 12).map(f => `• ${short(f.line, 140)}`).concat(actionable.length > 12 ? [`… và ${actionable.length - 12} mục nữa (xem bảng catalog_health).`] : []),
  });
  const counts = Object.fromEntries(CHECKS.filter(c => checks.includes(c)).map(c => [c, findings.filter(f => f.check === c).length]));
  return {
    ok: errors.length === 0, scanned, counts, new: fresh, actionable: actionable.length, errors: errors.length ? errors : undefined,
    findings: findings.slice(0, 50).map(({ key, check, severity, actionable: a, line }) => ({ key, check, severity, actionable: a, line })),
    more_findings: Math.max(findings.length - 50, 0),
    ...card,
  };
}
