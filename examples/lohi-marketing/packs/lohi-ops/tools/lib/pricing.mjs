// pricing_report: read-only analysis of the scoreboard's `plans` and `cohorts` (frozen contract: the api
// quotes every price; this tool only reads). It suggests what to test. Money decisions are the founder's:
// nothing here changes a price, a plan, a discount or a campaign.
import { skippedFor, lohiApi, addDays, ictDay, short } from './base.mjs';

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
export const MIN_SIGNUPS = 30;

/** Pure: the analysis of one scoreboard body. */
export function analyze(board) {
  const m = board.metrics ?? {};
  const signups = m.signups?.value ?? null, firstPayers = m.first_payers?.value ?? null;
  const plans = Array.isArray(board.plans) ? board.plans : null;
  const cohorts = Array.isArray(board.cohorts) ? board.cohorts : null;
  const startedTotal = plans?.reduce((s, p) => s + p.started, 0) ?? null;
  const planRows = plans?.map(p => ({ ...p, share_of_started_pct: pct(p.started, startedTotal), revenue_per_start_vnd: p.started ? Math.round(p.revenue_vnd / p.started) : null })) ?? null;
  const cohortRows = cohorts?.map(c => ({ cohort: c.cohort, signups: c.signups, payer_rate_pct: pct(c.first_payers, c.signups), w1_pct: c.active_w1 === null ? null : pct(c.active_w1, c.signups), w4_pct: c.active_w4 === null ? null : pct(c.active_w4, c.signups) })) ?? null;
  const funnel = { signups, first_payers: firstPayers, payer_rate_pct: signups ? pct(firstPayers ?? 0, signups) : null, revenue_vnd: m.revenue_vnd?.value ?? null, topups: m.topups?.value ?? null,
    revenue_per_payer_vnd: m.payers?.value ? Math.round((m.revenue_vnd?.value ?? 0) / m.payers.value) : null };

  const suggestions = [];
  const add = (topic, observation, test) => suggestions.push({ topic, observation, suggested_test: test, decision: 'founder', note: 'Giả thuyết cần thử, chưa phải kết luận; Soot không đổi giá hay gói.' });
  const enough = (signups ?? 0) >= MIN_SIGNUPS;
  if (!enough) {
    add('mẫu nhỏ', `Chỉ ${signups ?? 'chưa rõ'} đăng ký trong kỳ (cần ít nhất ${MIN_SIGNUPS}) nên tỉ lệ chưa đáng tin.`, 'Đọc lại sau khi có thêm đăng ký; chưa đổi gì dựa trên kỳ này.');
  } else {
    if (funnel.payer_rate_pct !== null && funnel.payer_rate_pct < 3) add('lần nạp đầu', `Chỉ ${funnel.payer_rate_pct}% người đăng ký nạp lần đầu.`, 'Thử một gói nạp đầu nhỏ hơn hoặc nêu rõ lợi ích ở bước nạp, đo lại tỉ lệ trong 2 tuần.');
    if (planRows && startedTotal >= 10) {
      const top = [...planRows].sort((a, b) => b.started - a.started)[0];
      if (top.share_of_started_pct >= 70) add('cơ cấu gói', `Gói ${top.tier} chiếm ${top.share_of_started_pct}% lượt bắt đầu.`, 'Thử đổi cách trình bày (gói giữa nổi bật) để xem các gói còn lại có thêm người chọn không.');
      for (const p of planRows) if (p.started === 0 && p.active === 0) add(`gói ${p.tier}`, `Gói ${p.tier} không có lượt bắt đầu và không ai đang dùng trong kỳ.`, 'Xem gói còn đúng chỗ trong bảng giá không, hoặc cần mô tả lợi ích rõ hơn.');
    }
    const seen = cohortRows?.filter(c => c.w1_pct !== null && c.signups >= 10) ?? [];
    if (seen.length) {
      const avg = Math.round(seen.reduce((s, c) => s + c.w1_pct, 0) / seen.length * 10) / 10;
      if (avg < 25) add('giữ chân', `Trung bình ${avg}% người đăng ký còn đọc ở tuần thứ nhất.`, 'Sửa trải nghiệm đầu tiên trước khi đổi giá: người không quay lại thì giá không phải rào cản.');
    }
  }
  const missing = [!plans && 'plans', !cohorts && 'cohorts'].filter(Boolean);
  return { funnel, plans: planRows, cohorts: cohortRows, suggestions, enough_data: enough, ...(missing.length ? { not_yet_available: missing } : {}) };
}

export async function pricing_report(input, deps) {
  const days = Math.min(Math.max(Number(input.days) || 28, 7), 92);
  const to = addDays(ictDay(deps.now), -1), from = addDays(to, -(days - 1));
  const r = await lohiApi(deps, 'GET', '/admin/analysis/scoreboard', { query: { from, to } });
  if (r.skipped) return skippedFor(r.skipped);
  if (r.error) return { ok: false, error: { code: r.error.code, message: r.error.message } };
  return { ok: true, range: { from, to }, ...analyze(r.out), read_only: true, summary: short(`Kỳ ${from} đến ${to}`, 60) };
}
