// The request → release stage on the api (POST /novel/agent/requests/:id/stage, bs-kh1atl85), shared by the tools
// that move a request along: catalog_jobs_sync (onboarded / stopped), translate_step (first batch in) and
// release_step (audio in). The api owns the stage; a failed stage refunds the donated LT there, once per vote.
import { getState, iso, lohiApi, setState, short } from './base.mjs';

/** The one line readers see when a request names no novel the catalog can identify; it asks for a link (<=300 chars). */
export const NO_SOURCE_NOTE = 'Chưa xác định được nguồn của truyện này. Bạn gửi lại yêu cầu kèm đường dẫn (link) trang truyện giúp mình nhé.';

/** The stopped job's cause as the api names it. A copyright match and a missing source are their own causes. */
export function causeOf(state, detail) {
  if (state === 'blocked_copyright') return 'blocked_copyright';
  return /no source|nguồn|source.*(not|no) match|unknown_source/i.test(String(detail ?? '')) ? 'no_source' : 'failed';
}

/** Best-effort: a refusal (a final stage, a missing key) never breaks the step that called it. */
export async function postStage(deps, requestId, stage, { note, cause } = {}) {
  if (!requestId) return null;
  const body = { stage, ...(note ? { note: short(note, 300) } : {}), ...(cause ? { cause } : {}) };
  const r = await lohiApi(deps, 'POST', `/novel/agent/requests/${requestId}/stage`, { body });
  if (r.skipped) return { ok: false, code: 'skipped' };
  if (r.error) return { ok: false, code: r.error.code ?? 'failed' };
  return { ok: true, changed: r.out?.changed ?? null, refund: r.out?.refund ?? null };
}

// A `failed` stage is the one that refunds the donors: if the api could not be reached, it is kept here and posted
// again on the next translate_step / catalog_jobs_sync tick, never lost with the local row that already moved on.
const RETRY_KEY = 'stage_retries';
const unreached = r => r && !r.ok && (r.code === 'unreachable' || r.code === 'skipped');

export async function postFailedStage(deps, requestId, opts = {}) {
  const r = await postStage(deps, requestId, 'failed', opts);
  if (unreached(r)) {
    const q = (await getState(deps.store, RETRY_KEY)) ?? {};
    q[requestId] = { ...(opts.note ? { note: opts.note } : {}), ...(opts.cause ? { cause: opts.cause } : {}), at: iso(deps.now) };
    await setState(deps.store, RETRY_KEY, q);
  }
  return r;
}

/** Post the failed stages the api missed; returns how many it delivered (or the api refused for good). */
export async function retryFailedStages(deps) {
  const q = await getState(deps.store, RETRY_KEY);
  const ids = q ? Object.keys(q) : [];
  if (!ids.length) return 0;
  let n = 0;
  for (const id of ids.slice(0, 20)) {
    if (unreached(await postStage(deps, id, 'failed', q[id]))) continue;
    delete q[id];
    n++;
  }
  if (n) await setState(deps.store, RETRY_KEY, q);
  return n;
}
