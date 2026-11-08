// Loop health: for each stage of the company loop (insight, build, marketing, CS) its last run, which inputs are starving,
// the tokens it spent and what it cost the founder (taps and answers). The Công ty page shows it; this is the one place
// founder hours and token cost are measured together.
//
// Runtime numbers come from the `soot` CLI of this workspace (read-only; LOOP_SOOT_CONFIG names the deployment):
// `teams health --json` (one row per team: its schedules' last runs, the inputs it is starving for, tokens against the team
// budget) and `attention answers --json` (who answered which card, and how fast). A runtime without those commands (before
// L6) is read the old way for one more release: `schedules list`, `traces list` and `attention list`, with schedule ids
// matched to stages by name. Marketing's starving inputs arrive from a chain step (marketing_inputs_health ->
// company-loop_health_sync). Nothing here posts, spends or changes anything.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { getState, setState, iso, short } from './base.mjs';
import { latestBoard } from './scoreboard.mjs';

const DAY = 86_400_000;
export const STAGES = [
  { key: 'insight', label: 'Hiểu người dùng', schedules: ['company-scoreboard', 'company-digest', 'company-review', 'company-health'] },
  { key: 'build', label: 'Dựng sản phẩm', schedules: ['company-watch'] },
  { key: 'marketing', label: 'Tiếp thị', prefixes: ['marketing-', 'blog-', 'radar-'] },
  { key: 'cs', label: 'Hỗ trợ khách', external: true },
];

const exe = f => { try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; } };
export function findSoot(env) {
  if (env.LOOP_SOOT_BIN) return isAbsolute(env.LOOP_SOOT_BIN) && exe(env.LOOP_SOOT_BIN) ? env.LOOP_SOOT_BIN : null;
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) if (exe(join(dir, 'soot'))) return join(dir, 'soot');
  return env.HOME && exe(join(env.HOME, '.local', 'bin', 'soot')) ? join(env.HOME, '.local', 'bin', 'soot') : null;
}
const soot = (bin, config, args) => new Promise(resolve => {
  execFile(bin, [...args, '--json', '--config', config], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (err, stdout) => {
    if (err) return resolve(null);
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  });
});

// Used only by the older runtime path above: a schedule has no team there, so its stage is guessed from its id.
const stageOf = (id, stages) => stages.find(s => (s.schedules ?? []).includes(id) || (s.prefixes ?? []).some(p => id.startsWith(p)))?.key ?? null;
const cleanInput = i => (i && typeof i === 'object' && /^[a-z0-9_-]{1,24}$/.test(String(i.key))
  ? { key: i.key, label: short(i.label ?? i.key, 40), starving: i.starving === true, detail: short(i.detail, 240), rows: Number.isFinite(i.rows) ? i.rows : null } : null);

const REASONS = { never_ran: 'chưa chạy lần nào', stale: 'đã lâu không có dữ liệu mới', no_peer_key: 'thiếu khoá nối runtime của đội kia', team_unknown: 'đội kia không còn trong công ty' };
const reasonText = r => REASONS[r] ?? short(String(r ?? ''), 80);
const num = v => (Number.isFinite(v) ? v : 0);

/** One team of `soot teams health --json` as a row of the Vòng lặp view. */
function teamRow(h) {
  const sched = Array.isArray(h.schedules) ? h.schedules : [];
  const last = sched.filter(x => x.last).sort((a, b) => Date.parse(b.last) - Date.parse(a.last))[0] ?? null;
  const days = Array.isArray(h.tokens?.last_7_days) ? h.tokens.last_7_days : [];
  return {
    key: String(h.team), label: short(h.name || h.team, 60), schedules: sched.length,
    last_run: last ? { schedule: last.id, name: last.name ?? last.id, at: last.last, status: last.skip ? 'skipped' : last.ok ? 'ok' : 'failed' } : null,
    tokens_7d: days.reduce((n, d) => n + num(d), 0),
    tokens_today: num(h.tokens?.spent), budget_daily: num(h.tokens?.budget) || null, budget_percent: num(h.tokens?.percent) || null,
    skipped: sched.filter(x => x.skip).map(x => ({ schedule: x.id, key: x.skip })),
    failing: sched.filter(x => !x.ok && !x.skip && x.last).map(x => x.id),
    // The runtime's own account of what the team lacks; an optional input is a note, not hunger.
    starving: (Array.isArray(h.starving_inputs) ? h.starving_inputs : []).filter(i => !i.optional).map(i => ({ key: `${i.team}.${i.item}`, label: short(`${i.team}.${i.item}`, 60), detail: reasonText(i.reason) })),
  };
}

/** `soot teams health` and `soot attention answers`: the runtime's own per-team view. Null when this runtime does not have them. */
async function teamFacts(bin, config, now) {
  const [health, answers] = await Promise.all([
    soot(bin, config, ['teams', 'health']),
    soot(bin, config, ['attention', 'answers', '--days', '7']),
  ]);
  const teams = Array.isArray(health?.teams) ? health.teams : health?.team ? [health] : null;
  if (!teams) return null;
  const rows = teams.map(teamRow);
  const effort = answers?.effort;
  return {
    ok: true, via: 'teams', stages: rows, direct: { runs: null, tokens: null },
    // Cards the founder answered in the window and how long they waited, from the runtime's answer log.
    answered: Number.isFinite(effort?.answered) ? effort.answered : null,
    median_answer_s: Number.isFinite(effort?.median_seconds_to_answer) ? effort.median_seconds_to_answer : null,
    cards_open: Number.isFinite(effort?.open_unanswered) ? effort.open_unanswered : null,
    at: iso(now),
  };
}

/** What the runtime says: per team (or, on an older runtime, per stage) the last run, tokens, hunger and the cards. Null parts when the CLI is not reachable. */
export async function runtimeFacts(env, now, stages) {
  const bin = findSoot(env), config = env.LOOP_SOOT_CONFIG;
  if (!bin || !config || !isAbsolute(config)) return { ok: false, reason: !bin ? 'no_soot' : 'no_config' };
  const teams = await teamFacts(bin, config, now);
  if (teams) return teams;
  return legacyFacts(bin, config, now, stages);
}

/** Before L6: schedule ids matched to stages by name, runs and tokens from the traces, cards from `attention list`. */
async function legacyFacts(bin, config, now, stages) {
  const [schedules, traces, attention] = await Promise.all([
    soot(bin, config, ['schedules', 'list']),
    soot(bin, config, ['traces', 'list', '--since', '7d', '--limit', '500']),
    soot(bin, config, ['attention', 'list']),
  ]);
  if (!schedules || !traces) return { ok: false, reason: 'unreadable' };
  const sched = Array.isArray(schedules.schedules) ? schedules.schedules : [];
  const byConv = new Map(sched.filter(s => s.conversation_id).map(s => [s.conversation_id, s.id]));
  const per = new Map();
  const add = (key, tokens, model) => {
    const a = per.get(key) ?? { tokens: 0, runs: 0, model_runs: 0 };
    a.runs++; a.tokens += tokens; if (model) a.model_runs++;
    per.set(key, a);
  };
  let direct = { runs: 0, tokens: 0 };
  for (const t of Array.isArray(traces.traces) ? traces.traces : []) {
    const tokens = Number.isFinite(t.weighted_tokens) ? t.weighted_tokens : 0;
    const conv = String(t.conversation ?? '');
    const id = conv.startsWith('schedule:') ? conv.slice(9) : byConv.get(conv);
    if (t.origin === 'direct') { direct.runs++; direct.tokens += tokens; }
    else if (id) add(id, tokens, tokens > 0 || !String(t.run).startsWith('chain:'));
  }
  const stageRows = stages.map(st => {
    const mine = sched.filter(s => stageOf(s.id, stages) === st.key);
    const sum = mine.reduce((a, s) => { const p = per.get(s.id); return p ? { tokens: a.tokens + p.tokens, runs: a.runs + p.runs, model: a.model + p.model_runs } : a; }, { tokens: 0, runs: 0, model: 0 });
    const last = mine.filter(s => s.last).sort((a, b) => Date.parse(b.last) - Date.parse(a.last))[0] ?? null;
    return {
      key: st.key, label: st.label, schedules: mine.length,
      last_run: last ? { schedule: last.id, name: last.name ?? last.id, at: last.last, status: last.last_status ?? null } : null,
      tokens_7d: sum.tokens, runs_7d: sum.runs, model_wakes_7d: sum.model,
      skipped: mine.filter(s => s.last_status === 'skipped').map(s => ({ schedule: s.id, key: s.skip_reason?.key ?? null })),
      failing: mine.filter(s => s.last_status === 'failed').map(s => s.id),
    };
  });
  const items = Array.isArray(attention?.items) ? attention.items : null;
  return { ok: true, via: 'schedules', stages: stageRows, direct, cards_open: items ? items.length : null, at: iso(now) };
}

export async function health_sync(input, deps) {
  const { store, env, now } = deps;
  const stages = Array.isArray(input.stages) && input.stages.length ? input.stages : STAGES;
  const sent = (Array.isArray(input.inputs) ? input.inputs : []).map(cleanInput).filter(Boolean).slice(0, 20);
  const board = await latestBoard(store);
  const sync = await getState(store, 'sync');
  const own = [
    { key: 'scoreboard', label: 'Bảng số sản phẩm', starving: !board || sync?.ok === false, rows: board ? 1 : 0,
      detail: sync?.ok === false ? short(sync.message, 240) : board ? `Bảng số ${board.period_from}..${board.period_to}` : 'Chưa có bảng số: chưa đọc được SCOREBOARD_URL.' },
    { key: 'cohorts', label: 'Nhóm người dùng', starving: !board?.cohorts, rows: board?.cohorts?.length ?? 0, detail: board?.cohorts ? `${board.cohorts.length} nhóm theo tuần đăng ký` : 'Chưa có số theo nhóm người dùng (bảng số chưa trả cohorts).' },
    { key: 'plans', label: 'Gói đăng ký', starving: !board?.plans, rows: board?.plans?.length ?? 0, detail: board?.plans ? `${board.plans.length} gói` : 'Chưa có số theo gói (bảng số chưa trả plans).' },
    { key: 'cs', label: 'Hỗ trợ khách', starving: !env.CS_RUNTIME_URL, rows: env.CS_RUNTIME_URL ? 1 : 0, detail: env.CS_RUNTIME_URL ? 'Đã nối runtime Hỗ trợ' : 'Chưa nối Hỗ trợ (CS_RUNTIME_URL): bản tin chưa có khoảng trống kiến thức.' },
  ];
  const inputs = [...sent, ...own];
  const runtime = await runtimeFacts(env, now, stages);
  const decisions = await store.query('decisions', [], { limit: 500 });
  const since = now - 7 * DAY;
  const taps = decisions.filter(d => d.by === 'founder' && Date.parse(d.at) >= since).length;
  // Teams the runtime reports carry their own hunger; the stage list only supplies the labels of the older path and the
  // Support row (a remote team is not in `teams health`, so it stays a line of its own).
  const base = runtime.ok ? runtime.stages : stages.map(s => ({ key: s.key, label: s.label }));
  const withCs = runtime.ok && runtime.via === 'teams' && !base.some(r => r.key === 'cs' || r.key === 'support') ? [...base, { key: 'cs', label: 'Hỗ trợ khách', external: true }] : base;
  const rows = withCs.map(st => {
    const mine = inputs.filter(i => i.starving && (st.key === 'insight' ? ['scoreboard', 'cohorts', 'plans'].includes(i.key) : st.key === 'cs' ? i.key === 'cs' : st.key === 'marketing' ? ['gsc', 'signals', 'tiktok', 'youtube'].includes(i.key) : false))
      .map(i => ({ key: i.key, label: i.label, detail: i.detail }));
    return { ...st, starving: [...(st.starving ?? []), ...mine] };
  });
  const value = {
    at: iso(now), stages: rows, inputs,
    runtime: runtime.ok ? { via: runtime.via, tokens_7d: rows.reduce((n, r) => n + (r.tokens_7d ?? 0), 0), chat_runs_7d: runtime.direct.runs, chat_tokens_7d: runtime.direct.tokens } : { reason: runtime.reason },
    effort: {
      decisions_tapped_7d: taps,
      chat_instructions_7d: runtime.ok ? runtime.direct.runs : null,
      cards_open: runtime.ok ? runtime.cards_open : null,
      cards_answered_7d: runtime.ok ? runtime.answered ?? null : null,
      median_answer_s: runtime.ok ? runtime.median_answer_s ?? null : null,
      note: runtime.ok && runtime.via === 'teams'
        ? 'Số thẻ Cần bạn đã trả lời và thời gian chờ trung vị lấy từ nhật ký trả lời của runtime, cộng số lần bạn quyết định cơ hội trong 7 ngày.'
        : 'Runtime này chưa ghi riêng việc trả lời thẻ Cần bạn; đây là số lần bạn quyết định cơ hội và số lần bạn nhắn Soot trong 7 ngày.',
    },
    daily_report: Array.isArray(input.daily_report?.lines) ? input.daily_report.lines.slice(0, 6).map(l => short(l, 240)) : null,
  };
  await setState(store, 'health', value);
  return { ok: true, done: true, stages: rows.length, starving: inputs.filter(i => i.starving).length, runtime: runtime.ok };
}

export async function healthView(store, now) {
  const h = await getState(store, 'health');
  if (!h) return null;
  return { ...h, age_h: Math.max(0, Math.round((now - Date.parse(h.at)) / 3_600_000)) };
}
