// team_watch: read `bbs team snapshot <id> --json` for every open handoff with no model.
// A released team is the outcome `requirement_shipped` (the Lead records it) and one
// `launch` topic for the marketing plan (CL3). Nothing changed answers {done: true}.
import { eq, inList, iso, short } from './base.mjs';
import { runBbs } from './bbs.mjs';
import { queueTopic } from './opportunities.mjs';

const OPEN = ['spawned', 'building', 'blocked', 'delivered'];

/** The team's state from a snapshot: {state, detail}. */
export function summarize(data) {
  const phases = Array.isArray(data?.phases) ? data.phases : [];
  if (!phases.length) return { state: 'building', detail: 'Đội đang làm rõ yêu cầu và thiết kế.' };
  const failed = phases.find(p => p.state === 'release_failed');
  const settled = p => (p.release === 'none' || p.state === 'skipped' ? ['delivered', 'released', 'skipped'] : ['released']).includes(p.state);
  const done = phases.filter(settled).length;
  if (failed) return { state: 'blocked', detail: `Phát hành giai đoạn ${failed.id ?? ''} lỗi; đội đang xử lý.`.replace('  ', ' ') };
  if (done === phases.length) {
    return phases.some(p => p.state === 'released')
      ? { state: 'released', detail: `Đã phát hành ${phases.length}/${phases.length} giai đoạn.` }
      : { state: 'delivered', detail: 'Đã dựng xong: bạn duyệt bản giao rồi bấm phát hành trong bbs:team.' };
  }
  return { state: 'building', detail: `Xong ${done}/${phases.length} giai đoạn.` };
}

export async function team_watch(input, deps) {
  const { store, env, now } = deps;
  const open = await store.query('handoffs', [inList('state', OPEN)], { order: 'updated_at', limit: 50 });
  if (!open.length) return { done: true };
  const changed = [], outcomes = [];
  for (const h of open) {
    const r = await runBbs(env, ['team', 'snapshot', h.ticket || h.team_id, '--json'], { cwd: h.repo || undefined, timeoutMs: 30_000 });
    if (r.missing) return { done: true, note: 'bbs_missing' };
    let data = null;
    try { const body = JSON.parse(r.stdout); data = body?.ok === false ? null : (body?.data ?? body); } catch { /* unreadable below */ }
    if (!r.ok || !data) {
      const detail = `Chưa đọc được trạng thái đội (${short(r.stderr || r.stdout, 100) || 'không có trả lời'}).`;
      if (detail !== h.detail) await store.update('handoffs', h.id, { detail });
      continue;
    }
    const s = summarize(data);
    if (s.state === h.state && s.detail === h.detail) continue;
    const set = { state: s.state, detail: s.detail, ...(s.state === 'released' ? { released_at: iso(now) } : {}) };
    await store.update('handoffs', h.id, set);
    changed.push({ ref: h.opportunity, state: s.state });
    if (s.state === 'released') {
      const opp = await store.one('opportunities', [eq('ref', h.opportunity)]);
      if (opp) await queueTopic(store, opp, 'launch', `Tính năng mới đã ra: ${opp.title}`, opp.query || opp.title);
      outcomes.push({ id: 'requirement_shipped', count: 1, ref: `req:${h.opportunity}` });
    }
  }
  if (!changed.length) return { done: true };
  return { changed, ...(outcomes.length ? { outcomes } : {}), notify: outcomes.length > 0, wake: outcomes.length > 0 };
}
