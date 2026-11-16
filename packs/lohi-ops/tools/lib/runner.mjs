// The deterministic sequences a catalog job runs on the Mac, as plain data (a plan) and one pure interpreter over an
// injected `io`. Every command is an argv array run without a shell, with validated slugs and ranges only. The plan is
// written to `<job dir>/plan.json`; tools/job-runner.mjs (a detached node process) interprets it and writes
// `result.json` then `exit`, which catalog_jobs_pull reads to report the end (state, novel_slug, chapters, copyright).
export const FIRST_BATCH = 10;
const CLI = ['npx', 'tsx', 'src/index.ts'];
const MIN = 60_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, SRC = /^[a-z0-9][a-z0-9-]{0,63}$/, RANGE = /^(\d{1,6})-(\d{1,6})$/, UUID = /^[0-9a-f-]{36}$/i;

const check = (re, v, what) => { if (!re.test(String(v))) throw new Error(`bad ${what}`); return String(v); };
const ANSI = /\u001b\[[0-9;]*m/g;
const tail = (text, n) => String(text ?? '').replace(ANSI, '').trim().split('\n').slice(-6).join(' | ').slice(-n);

/** `crawl catalog run` for a novel, or radar for the novels of one source. */
export const crawlArgv = ({ source, novel }, { from, to } = {}) => [...CLI, 'crawl', 'catalog', 'run', '--source', check(SRC, source, 'source'), '--novel', check(SLUG, novel, 'novel'),
  ...(from ? ['--from', String(from), '--to', String(to)] : []), '--concurrency', '1', '--chapter-concurrency', '3'];
export const radarArgv = (source, novels) => [...CLI, 'crawl', 'catalog', 'radar', '--source', check(SRC, source, 'source'), ...novels.flatMap(n => ['--novel', check(SLUG, n, 'novel')])];

/**
 * The plan for one job whose source and novel are known.
 *  crawl    crawl catalog run (the novel, whole)
 *  refresh  onboard --chapters A-B --chapters-only --no-announce [--request-id]; a bare refresh (no range) is radar
 *  repair   onboard --chapters A-B --chapters-only --overwrite --no-announce
 *  onboard  [crawl 1-10 when the catalog lacks them] dry-run -> copyright check -> stop or the real run (draft for a request)
 */
export function planFor(kind, { source, novel, chapters }, job = {}, { prodSlug } = {}) {
  check(SRC, source, 'source'); check(SLUG, novel, 'novel');
  const rid = job.request_id ? check(UUID, job.request_id, 'request id') : null;
  const prod = prodSlug && prodSlug !== novel ? check(/^[a-z0-9-]{1,100}$/, prodSlug, 'prod slug') : null;
  const slug = prod ?? novel;
  const m = chapters ? RANGE.exec(chapters) : null;
  if (chapters && (!m || Number(m[1]) > Number(m[2]))) throw new Error('bad chapters');
  if (kind === 'crawl') return { v: 1, kind: 'steps', steps: [{ name: 'crawl', argv: crawlArgv({ source, novel }), timeout_ms: 180 * MIN }] };
  if (kind === 'refresh' && !chapters) return { v: 1, kind: 'steps', steps: [{ name: 'radar', argv: radarArgv(source, [novel]), timeout_ms: 30 * MIN }] };
  const onboard = ['onboard', '--source', source, '--novel', novel, ...(prod ? ['--prod-slug', prod] : [])];
  if (kind === 'refresh' || kind === 'repair') {
    if (!chapters) throw new Error('a repair needs a chapter range');
    const argv = [...CLI, ...onboard, '--chapters', chapters, '--chapters-only', ...(kind === 'repair' ? ['--overwrite'] : []), '--no-announce', ...(rid ? ['--request-id', rid] : [])];
    return { v: 1, kind: 'steps', steps: [{ name: kind, argv, timeout_ms: 30 * MIN }], result: { novel_slug: slug, chapters, tail: kind === 'refresh', has_request: !!rid } };
  }
  if (kind === 'onboard') {
    const range = `1-${FIRST_BATCH}`;
    return { v: 1, kind: 'onboard', source, novel, slug, request_id: rid, keep_draft: !!rid, range, to: FIRST_BATCH, onboard_argv: [...CLI, ...onboard, ...(rid ? ['--request-id', rid, '--keep-draft'] : [])] };
  }
  throw new Error('unknown kind');
}

/** The chapters an onboard really wrote, from its own output; falls back to what was asked. */
export function addedRange(out, requested, { tail: isTail = false } = {}) {
  const text = String(out ?? '').replace(ANSI, '');
  const range = /Import range:\s*(\d+)-(\d+)/.exec(text), count = /Chapters to import:\s*(\d+)/.exec(text);
  if (!range) return { chapters: requested ?? null, added: null };
  const [from, to] = [Number(range[1]), Number(range[2])], n = count ? Number(count[1]) : null;
  // A refresh imports only what prod lacks, and what prod lacks is the tail of the range.
  if (isTail && n !== null) return n > 0 ? { chapters: `${Math.max(from, to - n + 1)}-${to}`, added: n } : { chapters: null, added: 0 };
  return { chapters: `${from}-${to}`, added: n };
}

const failed = (detail, extra = {}) => ({ state: 'failed', detail: String(detail).slice(0, 500), ...extra });

/**
 * Interpret a plan. `io` = { exec(argv, {timeout_ms}) -> {code, out}, countChapters(source, novel, from, to) -> n,
 * copyright(source, novel) -> {issue, reason} }. Answers {state: done | failed | blocked_copyright, detail, novel_slug?, chapters?, copyright?}.
 */
export async function runPlan(plan, io) {
  if (plan.kind === 'onboard') return runOnboard(plan, io);
  let last = { code: 0, out: '' };
  const codes = [];
  for (const s of plan.steps) {
    last = await io.exec(s.argv, { timeout_ms: s.timeout_ms });
    codes.push(last.code);
    if (last.code !== 0 && plan.stop_on_fail !== false) return failed(`${s.name} exit ${last.code}. ${tail(last.out, 300)}`);
  }
  // A sweep (radar per source) goes on past a refused source: it is a failure only when nothing worked.
  const good = codes.filter(c => c === 0).length;
  if (plan.stop_on_fail === false && !good) return failed(`${codes.length} step(s), none ok. ${tail(last.out, 300)}`);
  if (plan.stop_on_fail === false) return { state: 'done', detail: `${good}/${codes.length} step(s) ok.` };
  const res = { state: 'done', detail: `exit 0. ${tail(last.out, 300)}` };
  if (plan.result?.novel_slug) {
    const a = addedRange(last.out, plan.result.chapters, { tail: plan.result.tail });
    // Nothing new to write: a reader's request still goes on to translation of the chapters it named.
    if (a.added === 0 && !plan.result.has_request) return { ...res, detail: 'Không có chương mới để nhập (prod đã có đủ).' };
    if (a.added === 0) a.chapters = plan.result.chapters;
    Object.assign(res, { novel_slug: plan.result.novel_slug, chapters: a.chapters });
  }
  return res;
}

async function runOnboard(plan, io) {
  const { source, novel, range, to } = plan;
  if (await io.countChapters(source, novel, 1, to) < 1) {
    const c = await io.exec(crawlArgv({ source, novel }, { from: 1, to }), { timeout_ms: 60 * MIN });
    if (c.code !== 0) return failed(`crawl exit ${c.code}. ${tail(c.out, 300)}`);
    if (await io.countChapters(source, novel, 1, to) < 1) return failed('crawl brought no chapters');
  }
  const dry = await io.exec([...plan.onboard_argv, '--chapters', range, '--dry-run'], { timeout_ms: 15 * MIN });
  if (dry.code !== 0) return failed(`dry-run exit ${dry.code}. ${tail(dry.out, 300)}`);
  const cr = await io.exec([...CLI, 'crawl', 'catalog', 'copyright', '--source', source, '--novel', novel], { timeout_ms: 15 * MIN });
  if (cr.code !== 0) return failed(`copyright check exit ${cr.code}. ${tail(cr.out, 300)}`); // unproven is not clear: never publish on it
  const cp = await io.copyright(source, novel);
  if (cp.issue) return { state: 'blocked_copyright', detail: 'Nghi vướng bản quyền, không đăng.', copyright: cp.reason || `${source}/${novel} bị đánh dấu bản quyền` };
  const real = await io.exec([...plan.onboard_argv, '--chapters', range], { timeout_ms: 30 * MIN });
  if (real.code !== 0) return failed(`onboard exit ${real.code}. ${tail(real.out, 300)}`);
  const a = addedRange(real.out, range);
  return { state: 'done', detail: `onboard ok. ${tail(real.out, 240)}`, novel_slug: plan.slug, chapters: a.chapters };
}
