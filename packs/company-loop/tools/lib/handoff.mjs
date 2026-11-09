// CL2: an approved product opportunity becomes a requirement file (in the ticket home, not the product repo) and
// a `bbs team` project. The founder's Go on the operator-only page is the approval; this
// file never calls land, release, integrate or seal. When bbs or Orca is not there the
// handoff is `draft_ready` with the exact command, never a silent drop.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { eq, iso, short } from './base.mjs';
import { runBbs, findBbs, shq } from './bbs.mjs';

export const reqName = ref => `REQ-${ref}.md`;
export const teamIdOf = ref => `loop-${ref.toLowerCase()}`;

const bullets = (xs, empty) => (xs?.length ? xs.map(x => `- ${x}`).join('\n') : empty);

/** The requirement in the shape bbs:team's kickoff asks for: outcome, audience, scope, non-goals, criteria, evidence. */
export function requirementText(rawOpp, { baseline, at }) {
  // Model-written text stays one line per field, so it cannot open a heading or a section of its own.
  const one = s => short(s, 600);
  const opp = { ...rawOpp, title: one(rawOpp.title), summary: rawOpp.summary ? one(rawOpp.summary) : rawOpp.summary, evidence_refs: (rawOpp.evidence_refs ?? []).map(one) };
  const half = Number.isFinite(opp.expected_delta) ? Math.round((opp.expected_delta / 2) * 100) / 100 : null;
  return `# ${reqName(opp.ref).replace(/\.md$/, '')}: ${opp.title}

Source: company-loop opportunity ${opp.ref} (product ${opp.product}), approved by the founder with Go at ${at}.
Status: draft written by Soot; the team clarifies it, and the founder confirms the spec at the Brief touchpoint.

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
- No release without the founder's go at handover (bbs:team's own release gate).

## Constraints

- Follow the repo's AGENTS.md / CLAUDE.md hard constraints.
- Prices, quotas and plan benefits stay served by the api, never compiled into a client.

## Acceptance criteria

1. A person using the product can complete the journey this change serves (${short(opp.title, 100)}), checked by using it.
2. The change can move \`${opp.target_outcome}\` by at least ${half} (half of ${opp.expected_delta}) within ${opp.check_after_days} days; the company loop measures it on the scoreboard.
3. Existing tests and QA lanes of the repo pass, with at least one non-happy-path case.

## Evidence

${bullets(opp.evidence_refs, '- (none given)')}

## Open questions

None recorded; the team decides Mechanical and Taste questions as assumptions.
`;
}

/** The exact command a founder can run by hand. */
export function spawnCommand(repo, teamId, reqPath, agent = 'claude') {
  const inner = `${agent} ${shq(`/bbs:team --team-id ${teamId} --auto ${/^[\w./@+:-]+$/.test(reqPath) ? reqPath : shq(reqPath)}`)}`;
  return { argv: ['team', 'spawn', teamId, '--dir', repo, '--auto', '--command', inner], text: `cd ${shq(repo)} && bbs team spawn ${teamId} --dir ${shq(repo)} --auto --command ${shq(inner)}` };
}

async function upsert(store, opp, set) {
  const row = await store.one('handoffs', [eq('opportunity', opp.ref)]);
  if (row) { await store.update('handoffs', row.id, set); return { ...row, ...set }; }
  await store.insert('handoffs', { opportunity: opp.ref, ...set });
  return { opportunity: opp.ref, ...set };
}

/** Where the requirement lives: the ticket home, never the product working tree. */
export function requirementDir(env, repo) {
  const home = env.BABYSIT_HOME || (env.HOME ? join(env.HOME, '.babysit') : null);
  if (!home || !isAbsolute(home)) return null;
  return join(home, 'requirements', basename(repo).replace(/[^\w.-]+/g, '_') || 'product');
}

/** What happens next, in the founder's words: where the team works, what it needs from him, and where the release go is. */
export const nextText = (teamId, reqPath) =>
  `Bước tiếp: đội ${teamId} đọc yêu cầu (${reqPath}), tự làm rõ, thiết kế và dựng trong Orca; tiến độ hiện ở trang Công ty. Kho mã của bạn không bị ghi gì. Lần duy nhất cần bạn là cho phép phát hành, và việc đó làm trong terminal Orca của đội (bbs ticket approval resolve --action approve), không làm ở Nest.`;

/** Write the requirement (never over a file a person may have edited) and spawn the team. */
export async function startHandoff(opp, { store, env, now }, { baseline = null } = {}) {
  const repo = String(env.PRODUCT_REPO ?? '');
  if (!repo.startsWith('/') || !existsSync(repo) || !statSync(repo).isDirectory()) {
    return upsert(store, opp, { repo: repo || null, requirement_path: null, team_id: null, state: 'no_repo', note: 'Chưa đặt PRODUCT_REPO (đường dẫn tuyệt đối tới kho mã của sản phẩm).', command: null });
  }
  // A requirement a person already put in the repo is used as it is; a new one goes beside the tickets, so a Go never dirties the working tree.
  const inRepo = join(repo, 'docs', 'requirements', reqName(opp.ref));
  const dir = requirementDir(env, repo);
  if (!existsSync(inRepo) && !dir) {
    return upsert(store, opp, { repo, requirement_path: null, team_id: null, state: 'no_repo', note: 'Không có thư mục ticket (BABYSIT_HOME hoặc HOME) để ghi yêu cầu.', command: null });
  }
  const reqPath = existsSync(inRepo) ? inRepo : join(dir, reqName(opp.ref));
  let wrote = false;
  try {
    if (!existsSync(reqPath)) { mkdirSync(dirname(reqPath), { recursive: true }); writeFileSync(reqPath, requirementText(opp, { baseline, at: iso(now) }), { flag: 'wx' }); wrote = true; }
  } catch (e) {
    return upsert(store, opp, { repo, requirement_path: null, team_id: null, state: 'no_repo', note: `Không ghi được ${reqName(opp.ref)}: ${short(e.message, 100)}`, command: null });
  }
  const teamId = teamIdOf(opp.ref);
  const cmd = spawnCommand(repo, teamId, reqPath, env.BBS_TEAM_AGENT || 'claude');
  const r = await runBbs(env, cmd.argv, { cwd: repo, timeoutMs: 60_000 });
  const base = { repo, requirement_path: reqPath, team_id: teamId, command: cmd.text };
  const next = nextText(teamId, reqPath);
  if (r.missing) return upsert(store, opp, { ...base, state: 'draft_ready', note: `Máy này chưa có bbs nên đội chưa bắt đầu: bạn chạy lệnh dưới đây một lần. Soot tiếp tục theo dõi và sẽ báo nếu đội vẫn chưa bắt đầu. ${next}` });
  if (!r.ok) return upsert(store, opp, { ...base, state: 'draft_ready', note: `bbs team spawn không chạy được (${short(r.stderr, 140)}); bạn chạy lệnh dưới đây khi Orca đã mở. Soot tiếp tục theo dõi và sẽ báo nếu đội vẫn chưa bắt đầu. ${next}` });
  return upsert(store, opp, { ...base, state: 'spawned', note: `${wrote ? 'Đã ghi yêu cầu và mở đội bbs:team.' : 'Yêu cầu đã có sẵn; đã mở đội bbs:team.'} ${next}` });
}

export const bbsReady = env => !!findBbs(env);
