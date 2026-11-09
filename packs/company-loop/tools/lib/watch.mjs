// team_watch: read `bbs team snapshot <parent> --json` for every open handoff with no model.
// The parent ticket is found from the team id, never typed by a person: the /bbs:team kickoff
// creates it and claims it (`assignee` = team id, no `parent`), so the same row names it. Order:
// `bbs ticket find --json` (2build ticket_find.go) in the product repo, then `--all-projects`,
// then the ticket files under $BABYSIT_HOME/projects/*/tickets/*/index.json. `link_ticket` stays
// a hidden manual override. No parent yet is `starting`, never an error.
// A released team is the outcome `requirement_shipped` (the Lead records it) and one
// `launch` topic for the marketing plan (CL3). Nothing changed answers {done: true}.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, getState, inList, iso, setState, short } from './base.mjs';
import { runBbs } from './bbs.mjs';
import { queueTopic } from './opportunities.mjs';

// draft_ready is watched too: the founder runs the printed command by hand, and the row must move on once the team exists.
const OPEN = ['draft_ready', 'spawned', 'starting', 'building', 'blocked', 'delivered'];
/** A handoff still waiting for its command this long gets one reminder. */
export const NUDGE_AFTER_MS = 2 * 3_600_000;
export const STARTING = 'Đội đang đọc yêu cầu — chưa có việc cần bạn.';

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
  // A phase that is landed and verified but needs the founder's release go is the handover.
  const awaiting = phases.filter(p => p.state === 'delivered' && p.release !== 'none');
  if (awaiting.length && phases.every(p => settled(p) || awaiting.includes(p))) {
    return { state: 'delivered', detail: 'Bản bàn giao đã sẵn sàng: đang chờ bạn duyệt rồi cho phép phát hành.', awaiting };
  }
  return { state: 'building', detail: `Xong ${done}/${phases.length} giai đoạn.` };
}

const parseJson = text => { try { return JSON.parse(text); } catch { return null; } };
const isTicketId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(v);

/** The parent ticket the team's kickoff created: assignee is the team id and it has no parent. */
const parentOf = (rows, teamId) => {
  const mine = (Array.isArray(rows) ? rows : []).filter(r => r && r.assignee === teamId && !r.parent && isTicketId(r.id));
  mine.sort((x, y) => String(y.updated_at ?? y.created_at ?? '').localeCompare(String(x.updated_at ?? x.created_at ?? '')));
  return mine[0]?.id ?? null;
};

/** The ticket files, when the CLI cannot answer (older bbs, another project home). */
function parentFromFiles(env, teamId) {
  const home = env.BABYSIT_HOME || (env.HOME ? join(env.HOME, '.babysit') : null);
  if (!home) return null;
  const rows = [];
  try {
    for (const proj of readdirSync(join(home, 'projects'))) {
      let ids = [];
      try { ids = readdirSync(join(home, 'projects', proj, 'tickets')); } catch { continue; }
      for (const id of ids) {
        const doc = parseJson((() => { try { return readFileSync(join(home, 'projects', proj, 'tickets', id, 'index.json'), 'utf8'); } catch { return ''; } })());
        if (doc?.assignee === teamId) rows.push({ id: doc.id ?? id, assignee: doc.assignee, parent: doc.parent, updated_at: doc.updated_at, created_at: doc.created_at });
      }
    }
  } catch { return null; }
  return parentOf(rows, teamId);
}

/** {ticket} | {missing} | {} (not created yet). */
async function resolveParent(h, env) {
  if (h.ticket) return { ticket: h.ticket };
  if (!h.team_id) return {};
  for (const extra of [[], ['--all-projects']]) {
    const r = await runBbs(env, ['ticket', 'find', ...extra, '--json'], { cwd: h.repo || undefined, timeoutMs: 30_000 });
    if (r.missing) return { missing: true };
    if (!r.ok) continue;
    const body = parseJson(r.stdout);
    const t = parentOf(Array.isArray(body) ? body : body?.data, h.team_id);
    if (t) return { ticket: t };
  }
  const t = parentFromFiles(env, h.team_id);
  return t ? { ticket: t } : {};
}

/**
 * The go the founder owes: one Cần bạn card per handover, naming where to give it. The runtime files it (no model); the
 * id is the dedup, so nothing is remembered here and a card that could not be filed is filed on the next tick.
 */
const handoverGroup = h => `company:handover:${h.opportunity}`;
function handoverCard(h, title, parent, awaiting) {
  const phase = awaiting[0];
  const where = phase.ticket ? `ticket giai đoạn ${phase.ticket}` : `ticket cha ${parent}`;
  return {
    id: `${handoverGroup(h)}:${awaiting.map(p => p.id).sort().join(',')}`, group: handoverGroup(h),
    title: `Bản bàn giao ${title} chờ bạn duyệt phát hành`,
    why: `Mở terminal của đội ${h.team_id} trong Orca (bbs team list) và đọc bản bàn giao: ${parent}/recap.html trong ~/.babysit. Hài lòng thì cho phép phát hành ở phê duyệt "release" của ${where}: ${phase.ticket ? `BABYSIT_TICKET=${phase.ticket} ` : ''}bbs ticket approval resolve --action approve. Chưa ổn thì --action redirect --note "<góp ý>"; đội tự sửa. Đây là lần bấm cuối cùng của bạn.`,
    options: [{ id: 'seen', label: 'Đã xem', recommended: true }], reraise_after_hours: 72,
  };
}

/** One reminder per handoff that never started: the command to run, once. */
async function unstartedAsk(h, title, store, now) {
  if (now - Date.parse(h.updated_at ?? h.created_at ?? 0) < NUDGE_AFTER_MS) return null;
  const key = `unstarted:${h.opportunity}`;
  if (await getState(store, key)) return null;
  await setState(store, key, '1');
  return {
    keys: [`company:unstarted:${h.opportunity}`], summary: `Đội dựng "${title}" chưa bắt đầu`,
    missing: `Bạn đã Go nhưng đội ${h.team_id} chưa mở (máy chưa có bbs hoặc Orca chưa chạy). Chạy lệnh này một lần trong terminal: ${h.command ?? '(mở trang Công ty và bấm Chạy lại)'}\nSau đó Soot tự theo dõi tiếp; việc còn lại của bạn là cho phép phát hành trong terminal Orca của đội.`,
    options: [{ label: 'Đã xem', recommended: true }],
  };
}

export async function team_watch(input, deps) {
  const { store, env, now } = deps;
  const open = await store.query('handoffs', [inList('state', OPEN)], { order: 'updated_at', limit: 50 });
  if (!open.length) return { done: true };
  const changed = [], outcomes = [];
  const raise = [], settle = [];
  for (const h of open) {
    const found = await resolveParent(h, env);
    if (h.state === 'draft_ready' && (found.missing || !found.ticket)) {
      // The team does not exist yet: keep the row, remind once, never fail the other handoffs.
      if (!ask) ask = await unstartedAsk(h, (await store.one('opportunities', [eq('ref', h.opportunity)]))?.title ?? h.opportunity, store, now);
      continue;
    }
    if (found.missing) return { done: true, note: 'bbs_missing' };
    let s;
    let parent = found.ticket;
    if (!parent) {
      s = { state: 'starting', detail: STARTING };
    } else {
      if (!h.ticket) await store.update('handoffs', h.id, { ticket: parent });
      const r = await runBbs(env, ['team', 'snapshot', parent, '--json'], { cwd: h.repo || undefined, timeoutMs: 30_000 });
      if (r.missing) return { done: true, note: 'bbs_missing' };
      let data = null;
      const body = parseJson(r.stdout);
      if (body) data = body.ok === false ? null : (body.data ?? body);
      if (!r.ok || !data) {
        const detail = `Chưa đọc được trạng thái đội (${short(r.stderr || r.stdout, 100) || 'không có trả lời'}).`;
        if (detail !== h.detail) await store.update('handoffs', h.id, { detail });
        continue;
      }
      s = summarize(data);
    }
    if (s.awaiting) {
      const opp = await store.one('opportunities', [eq('ref', h.opportunity)]);
      raise.push(handoverCard(h, opp?.title ?? h.opportunity, parent, s.awaiting));
    }
    if (s.state === h.state && s.detail === h.detail) continue;
    if (!s.awaiting) settle.push(handoverGroup(h)); // the state moved off the handover: its card is done
    const set = { state: s.state, detail: s.detail, ...(s.state === 'released' ? { released_at: iso(now) } : {}) };
    await store.update('handoffs', h.id, set);
    changed.push({ ref: h.opportunity, state: s.state });
    if (s.state === 'released') {
      const opp = await store.one('opportunities', [eq('ref', h.opportunity)]);
      if (opp) await queueTopic(store, opp, 'launch', `Tính năng mới đã ra: ${opp.title}`, opp.query || opp.title);
      outcomes.push({ id: 'requirement_shipped', count: 1, ref: `req:${h.opportunity}` });
    }
  }
  const cards = { ...(raise.length ? { raise } : {}), ...(settle.length ? { settle } : {}) };
  if (!changed.length && !raise.length && !settle.length) return { done: true };
  const loud = outcomes.length > 0;
  return { changed, ...(outcomes.length ? { outcomes } : {}), ...cards, notify: loud, wake: loud };
}
