// CL2: an approved product opportunity becomes a requirement file (in the ticket home, not the product repo), a bbs
// ticket and one `bbs:autopilot` session on the product checkout. The founder's Go on the operator-only page approves the
// idea; the session asks them to confirm the spec through the ticket's approval record (AGENT_ROLE=dashboard), which
// team_watch reads and the page answers. The session edits the checkout and never commits: a person reviews the uncommitted
// change and ships it. One build at a time per checkout, so a second Go waits as `queued`. When bbs or Orca is not there
// the handoff is `draft_ready` with the reason, never a silent drop. A runtime with no build stage (no project for the
// product, the always-on server) records the Go as `approved` with the requirement; the runtime that has the repo pulls
// it (builds_pull). With no such runtime a person does the work, and marking it done (page op task_done) starts the
// outcome clock. Each product builds in its own project (`PRODUCT_REPOS`, else `PRODUCT_REPO`); the founder can also give
// a Go to a person (`person`), and take a build that is not running away from Soot later (page op to_person).
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { eq, inList, iso, short } from './base.mjs';
import { runBbs, findBbs, shq } from './bbs.mjs';
import { productId } from './products.mjs';

export const reqName = ref => `REQ-${ref}.md`;
/** The Orca terminal the session runs in (`bbs team spawn` only opens and names it; no bbs:team project is involved). */
export const sessionIdOf = ref => `loop-${ref.toLowerCase()}`;
/** States in which a build has, or is about to have, uncommitted work in its checkout. */
export const HOLDING = ['draft_ready', 'spawned', 'starting', 'building', 'asking', 'answered', 'blocked', 'delivered'];
/** What a build says right after its session was started again on the ticket of an earlier try (team_watch gives it time to write a new status). */
export const RESTARTED = 'Đã mở lại phiên dựng trên ticket cũ; phiên mới tiếp tục từ chỗ đã lưu.';
export const isTicketId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(v);

const bullets = (xs, empty) => (xs?.length ? xs.map(x => `- ${x}`).join('\n') : empty);

/** The requirement as 2build reads an agent-drafted one: the spec is confirmed by a person, the estimate is the appetite, the metric is measured after release. */
export function requirementText(rawOpp, { baseline, at }) {
  // Model-written text stays one line per field, so it cannot open a heading or a section of its own.
  const one = s => short(s, 600);
  const opp = { ...rawOpp, title: one(rawOpp.title), summary: rawOpp.summary ? one(rawOpp.summary) : rawOpp.summary, evidence_refs: (rawOpp.evidence_refs ?? []).map(one) };
  const half = Number.isFinite(opp.expected_delta) ? Math.round((opp.expected_delta / 2) * 100) / 100 : null;
  return `# ${reqName(opp.ref).replace(/\.md$/, '')}: ${opp.title}

Source: company-loop opportunity ${opp.ref} (product ${opp.product}), approved by the founder with Go at ${at}.
Status: draft written by Soot. The founder approved the idea, not this spec: confirm the spec with them once before planning.

## Outcome

${opp.summary || opp.title}

Target outcome: \`${opp.target_outcome}\`, expected change ${opp.expected_delta} within ${opp.check_after_days} days of release${baseline != null ? ` (baseline when approved: ${baseline})` : ''}.

## Audience

People who use ${opp.product} and produced the signals under Evidence.

## Scope

- ${opp.summary || opp.title}
- Estimate when proposed: effort ${opp.est_effort}, value ${opp.est_value}, confidence ${opp.confidence}, ${opp.signal_count} signal(s).

## Non-goals

- Anything the outcome does not need: no pricing, billing or data-model change unless the outcome requires it.
- No commit, push or release: the change is left uncommitted for the founder to review and ship.

## Constraints

- Follow the repo's AGENTS.md / CLAUDE.md hard constraints.
- Prices, quotas and plan benefits stay served by the api, never compiled into a client.

## Acceptance criteria

1. A person using the product can complete the journey this change serves (${short(opp.title, 100)}), checked by using it.
2. Existing tests and QA lanes of the repo pass, with at least one non-happy-path case.

## Measured after release

- \`${opp.target_outcome}\` moves by at least ${half} (half of ${opp.expected_delta}) within ${opp.check_after_days} days of release${baseline != null ? `, from ${baseline}` : ''}. The company loop reads it on the product scoreboard; it is not a QA criterion.

## Evidence

${bullets(opp.evidence_refs, '- (none given)')}

## Open questions

None recorded; decide Mechanical and Taste questions as assumptions and list them when confirming the spec.
`;
}

async function upsert(store, opp, set) {
  const row = await store.one('handoffs', [eq('opportunity', opp.ref)]);
  if (row) { await store.update('handoffs', row.id, set); return { ...row, ...set }; }
  await store.insert('handoffs', { opportunity: opp.ref, product: opp.product ?? null, ...set });
  return { opportunity: opp.ref, product: opp.product ?? null, ...set };
}

/** Where the requirement lives: the ticket home, never the product working tree. */
export function requirementDir(env, repo) {
  const home = env.BABYSIT_HOME || (env.HOME ? join(env.HOME, '.babysit') : null);
  if (!home || !isAbsolute(home)) return null;
  return join(home, 'requirements', basename(repo).replace(/[^\w.-]+/g, '_') || 'product');
}

/** What happens next, in the founder's words: who asks them what, where the change lands, and that shipping is theirs. */
export const nextText = (ticket, repo) =>
  `Bước tiếp: phiên autopilot của ticket ${ticket} đọc yêu cầu rồi hỏi bạn xác nhận đặc tả; câu hỏi hiện ở trang Công ty và bạn trả lời ngay tại đó. Phiên dựng sửa thẳng trong ${repo}, tự review và QA, rồi để thay đổi chưa commit. Nó không commit và không phát hành: xong thì bạn xem, commit và phát hành.`;

/**
 * The project a product builds in: its `PRODUCT_REPOS` entry (`product=<project>`, split by comma or newline), else
 * `PRODUCT_REPO`; '' when none. A runtime that sets only PRODUCT_REPO behaves as before: that one repo is every product's.
 */
export function projectOf(env, product) {
  const id = productId(product);
  for (const raw of String(env.PRODUCT_REPOS ?? '').split(/[,\n]/)) {
    const at = raw.indexOf('=');
    if (id && at > 0 && productId(raw.slice(0, at)) === id && raw.slice(at + 1).trim()) return raw.slice(at + 1).trim();
  }
  return String(env.PRODUCT_REPO ?? '').trim();
}
const explicit = (env, product) => { const id = productId(product); return !!id && String(env.PRODUCT_REPOS ?? '').split(/[,\n]/).some(raw => { const at = raw.indexOf('='); return at > 0 && productId(raw.slice(0, at)) === id && !!raw.slice(at + 1).trim(); }); };
/** Does this runtime have a build stage at all (any project)? */
export const hasBuild = env => !!String(env.PRODUCT_REPO ?? '').trim() || /=\s*\S/.test(String(env.PRODUCT_REPOS ?? ''));

/**
 * Does this runtime build for this product? A `PRODUCT_REPOS` entry names the product, so it is its own. The PRODUCT_REPO
 * fallback is every product's, except that a product's own run (SOOT_PRODUCT) must be the same product.
 */
export const buildsHere = (env, product) => explicit(env, product) || (!!String(env.PRODUCT_REPO ?? '').trim() && !(env.SOOT_PRODUCT && product && env.SOOT_PRODUCT !== product));

/**
 * A project is an absolute path, or a bbs registry workspace by name (`ws`, or `ws/<repo folder>` when it lists several):
 * the name is the same on every machine, bbs knows where it is on this one. {repo} or {why}.
 */
export async function resolveProject(env, project) {
  if (project.startsWith('/')) return { repo: project };
  const [ws, name, ...rest] = project.split('/');
  if (!/^[\w.-]+$/.test(ws) || rest.length) return { why: `"${short(project, 60)}" không phải đường dẫn tuyệt đối hay tên workspace bbs.` };
  const r = await runBbs(env, ['config', 'workspace', 'show', ws]);
  if (r.missing) return { why: `Máy này chưa có bbs nên không tìm được workspace ${ws}.` };
  if (!r.ok) return { why: `bbs không có workspace ${ws} trên máy này.` };
  const paths = r.stdout.split('\n').map(l => /^\s+\S+\s{2}(\/.*?)(?:\s{2}role=\S+)?$/.exec(l)?.[1]).filter(Boolean);
  const hit = name ? paths.filter(p => basename(p) === name) : paths;
  if (hit.length === 1) return { repo: hit[0] };
  return { why: name ? `Workspace ${ws} không có kho ${name} trên máy này.` : `Workspace ${ws} có ${paths.length} kho trên máy này; ghi rõ ${ws}/<tên thư mục kho>.` };
}

/**
 * Who holds a checkout: the other build (a local handoff or a pulled build) with uncommitted work there, or null. Autopilot
 * edits the checkout it runs in, so two sessions would mix their changes. A build a person took over (a task that kept
 * its ticket and repo) still has its changes there. Rows opened for bbs:team (they carry `team_id`) worked in their own worktrees.
 */
export async function holderOf(store, repo, ref) {
  const held = (h, key) => h.repo === repo && key !== ref && !h.team_id && (h.state !== 'task' || !!h.ticket);
  const states = [inList('state', [...HOLDING, 'task'])];
  const a = (await store.query('handoffs', states, { limit: 100 })).find(h => held(h, h.opportunity));
  if (a) return a.opportunity;
  return (await store.query('builds', states, { limit: 100 })).find(h => held(h, h.handoff))?.handoff ?? null;
}

/**
 * Write the requirement (never over a file a person may have edited), open the ticket and start its autopilot session.
 * Pure of the pack store: it returns the row to keep, `{state, repo, requirement_path, ticket, command, note}`; `holder`
 * (repo -> the build already there, or null) is how the caller says a checkout is taken. The one place both halves use.
 * The repo is the product's project (`product`), resolved on this machine; one that cannot be is `no_repo` with the reason.
 * `ticket` is the one an earlier try opened: a rerun continues it and never opens a second.
 */
export async function launchBuild({ ref, requirement, product = null, ticket = null }, { env, holder = null }) {
  const none = { requirement_path: null, team_id: null, ticket: null, command: null, detail: null };
  const project = projectOf(env, product);
  const found = project ? await resolveProject(env, project) : { why: 'Chưa đặt PRODUCT_REPOS hay PRODUCT_REPO.' };
  const repo = found.repo ?? '';
  if (!repo.startsWith('/') || !existsSync(repo) || !statSync(repo).isDirectory()) {
    return { ...none, repo: repo || project || null, state: 'no_repo', note: `Chưa tìm được kho mã của sản phẩm${product ? ` ${product}` : ''} trên máy này. ${found.why ?? `Không có thư mục ${repo}.`} Sửa PRODUCT_REPOS (hoặc PRODUCT_REPO) rồi bấm Chạy lại, hoặc giao việc này cho người.` };
  }
  // A requirement a person already put in the repo is used as it is; a new one goes beside the tickets, so a Go never dirties the working tree.
  const inRepo = join(repo, 'docs', 'requirements', reqName(ref));
  const dir = requirementDir(env, repo);
  if (!existsSync(inRepo) && !dir) {
    return { ...none, repo, state: 'no_repo', note: 'Không có thư mục ticket (BABYSIT_HOME hoặc HOME) để ghi yêu cầu.' };
  }
  const reqPath = existsSync(inRepo) ? inRepo : join(dir, reqName(ref));
  try {
    if (!existsSync(reqPath)) { mkdirSync(dirname(reqPath), { recursive: true }); writeFileSync(reqPath, requirement, { flag: 'wx' }); }
  } catch (e) {
    return { ...none, repo, state: 'no_repo', note: `Không ghi được ${reqName(ref)}: ${short(e.message, 100)}` };
  }
  if (!isTicketId(ticket)) ticket = null;
  const resumed = !!ticket;
  const base = { ...none, repo, requirement_path: reqPath, ticket };
  const busy = holder ? await holder(repo) : null;
  if (busy) return { ...base, state: 'queued', note: `Kho mã đang có một thay đổi khác chưa phát hành (${busy}). Việc này chờ tới lượt: Soot tự bắt đầu khi thay đổi kia đã phát hành.` };
  const again = 'Sửa xong bấm Chạy lại ở trang Công ty.';
  if (!ticket) {
    const r = await runBbs(env, ['ticket', 'ensure', '--from-input-file', reqPath, '--no-branch'], { cwd: repo });
    if (r.missing) return { ...base, state: 'draft_ready', note: 'Đã ghi yêu cầu, nhưng máy này chưa có bbs (2build) nên chưa dựng được. Cài 2build rồi bấm Chạy lại ở trang Công ty.' };
    ticket = /^TICKET=(\S+)$/m.exec(r.stdout)?.[1] ?? null;
    if (!r.ok || !isTicketId(ticket)) return { ...base, state: 'draft_ready', note: `Chưa mở được ticket (${short(r.stderr, 140) || 'bbs ticket ensure không trả mã ticket'}). ${again}` };
    base.ticket = ticket;
  }
  // bbs knows how each agent CLI is told to run a skill unattended, and refuses here when it would stop on a prompt nobody sees.
  const agent = env.BBS_TEAM_AGENT || 'claude';
  const wc = await runBbs(env, ['team', 'worker-command', '--agent', agent, '--skill', 'autopilot', '--prompt', `--auto builder ${ticket}`, '--dir', repo], { cwd: repo });
  const line = wc.ok ? wc.stdout.trim().split('\n').pop() : '';
  if (wc.missing || !line) return { ...base, state: 'draft_ready', note: `Chưa chạy được ${agent} trong kho mã (${short(wc.stderr, 200) || 'không có bbs'}). ${again}` };
  // AGENT_ROLE=dashboard: nobody watches this terminal, so every question becomes the ticket's approval record.
  const run = `AGENT_ROLE=dashboard BABYSIT_TICKET=${ticket} ${line}`;
  const command = `cd ${shq(repo)} && ${run}`;
  const next = nextText(ticket, repo);
  const sp = await runBbs(env, ['team', 'spawn', sessionIdOf(ref), '--dir', repo, '--command', run], { cwd: repo, timeoutMs: 60_000 });
  if (!sp.ok) return { ...base, command, state: 'draft_ready', note: `Chưa mở được terminal trong Orca (${short(sp.stderr, 140)}). Mở Orca rồi bấm Chạy lại, hoặc tự chạy lệnh dưới đây trong một terminal. ${next}` };
  return { ...base, command, state: 'spawned', ...(resumed ? { detail: RESTARTED } : {}), note: `Đã ghi yêu cầu và mở phiên autopilot. ${next}` };
}

/**
 * The founder's Go on a product opportunity. With a build stage here (the product's project: PRODUCT_REPOS, else PRODUCT_REPO) the requirement is written
 * and the session started now (or queued behind the build already in that checkout). Without one (the always-on server)
 * nothing is written or started: the handoff is `approved` and carries the requirement, product and target outcome for a
 * runtime that has the repo (`builds_pull`); a company with no such runtime treats it as a task for a person (`task_done`).
 */
export async function startHandoff(opp, { store, env, now }, { baseline = null, person = false } = {}) {
  const requirement = requirementText(opp, { baseline, at: iso(now) });
  const clear = { repo: null, requirement_path: null, team_id: null, command: null, detail: null, asked: null, answer: null, answer_note: null, answer_for: null };
  // The founder gave this Go to a person: the decision is logged and the work is a task, which no build runtime pulls.
  if (person) return upsert(store, opp, { ...clear, ticket: null, state: 'task', note: PERSON_NOTE });
  if (!buildsHere(env, opp.product)) {
    return upsert(store, opp, { ...clear, state: 'approved', note: TASK_NOTE, requirement, target_outcome: opp.target_outcome ?? null, expected_delta: Number.isFinite(opp.expected_delta) ? opp.expected_delta : null });
  }
  const prior = await store.one('handoffs', [eq('opportunity', opp.ref)]);
  const ticket = prior && !prior.team_id ? prior.ticket : null;
  const out = await launchBuild({ ref: opp.ref, requirement, product: opp.product, ticket }, { env, holder: repo => holderOf(store, repo, opp.ref) });
  return upsert(store, opp, { ...out, asked: null, answer: null, answer_note: null, answer_for: null });
}

export const bbsReady = env => !!findBbs(env);

export const TASK_NOTE = 'Đã ghi quyết định và yêu cầu. Máy này không có kho mã (PRODUCT_REPOS hoặc PRODUCT_REPO) nên không tự dựng: máy dựng của sản phẩm sẽ nhận yêu cầu; nếu công ty không có máy dựng, giao việc cho người trong nhóm, xong thì đánh dấu đã xong để Soot đo kết quả từ ngày đó.';
export const PERSON_PREFIX = 'Đã ghi quyết định và một việc cho người làm.';
export const PERSON_NOTE = PERSON_PREFIX + ' Bạn chọn giao việc này cho người: xong thì đánh dấu đã xong để Soot đo kết quả từ ngày đó, hoặc bấm Để Soot dựng để Soot nhận lại.';
/** A handoff waiting for a person or for a build runtime: `approved`, the older `task`, or `no_repo` written before tasks existed with no repo set. */
export const isTask = h => h.state === 'approved' || h.state === 'task' || (h.state === 'no_repo' && !h.repo);
