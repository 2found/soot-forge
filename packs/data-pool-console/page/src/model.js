// @ts-check
// What the page sends and how it reads the answer. The body of every call is
// the data-pool interface body {kind, input} (docs/nest-interface.md): the same
// one Nest's link sheets and knowledge picker send, so the page and those
// callers share one contract with the view/action tools.

export const VIEW_KINDS = ['overview', 'pools', 'query', 'activity', 'status'];
export const ACTION_KINDS = ['write', 'manage'];

/** @param {string} kind @param {object} [input] */
export function viewBody(kind, input = {}) {
  if (!VIEW_KINDS.includes(kind)) throw new Error(`unsupported data-pool view: ${kind}`);
  return { kind, input };
}
/** @param {string} kind @param {object} input */
export function actionBody(kind, input) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unsupported data-pool action: ${kind}`);
  return { kind, input };
}

export const PAGE = 20;
export const listDocuments = (/** @type {string} */ pool, after = '') => viewBody('query', { action: 'list', pool, limit: PAGE, ...(after ? { after } : {}) });
export const searchDocuments = (/** @type {string} */ pool, /** @type {string} */ query, offset = 0) => viewBody('query', { action: 'search', pool, query, offset, limit: PAGE });
export const readDocument = (/** @type {string} */ pool, /** @type {string} */ id, offset = 0) => viewBody('query', { action: 'read', pool, id, offset, limit: 8192 });
export const listPools = (organized = false, after = '') => viewBody('pools', { limit: PAGE, ...(organized ? { parent: '' } : {}), ...(after ? { after } : {}) });
export const poolDetail = (/** @type {string} */ pool) => viewBody('pools', { pool });
export const activity = (/** @type {string} */ pool, after = '') => viewBody('activity', { pool, limit: PAGE, ...(after ? { after } : {}) });
export const requestStatus = (/** @type {string} */ requestID) => viewBody('status', { request_id: requestID });

/**
 * A document save. Revision and pool generation are the ones the person read; the
 * service refuses a stale pair as a conflict and the page keeps the draft.
 * @param {{ pool: string, id: string, title: string, content?: string, url?: string, source?: string, tags: string[], revision: number, generation: string }} d
 * @param {string} requestID
 */
export function saveDocument(d, requestID) {
  return actionBody('write', {
    action: 'upsert', pool: d.pool, id: d.id, title: d.title, generation: d.generation, expected_revision: d.revision,
    tags: d.tags, ...(d.url ? { url: d.url } : { content: d.content ?? '', ...(d.source ? { source: d.source } : {}) }), request_id: requestID,
  });
}
/** @param {{ pool: string, generation: string }} pool @param {{ id: string, revision: number }} doc @param {string} requestID */
export const removeDocument = (pool, doc, requestID) => actionBody('write', { action: 'remove', pool: pool.pool, id: doc.id, generation: pool.generation, expected_revision: doc.revision, request_id: requestID });
/** @param {{ pool: string, name: string, organized?: boolean }} p @param {string} requestID */
export const createPool = (p, requestID) => actionBody('manage', { action: 'pool_create', pool: p.pool, name: p.name, ...(p.organized ? { parent: '', inherit: true } : {}), request_id: requestID });
/** @param {{ id: string, generation: string, policy_revision: number }} pool @param {string} requestID */
export const removePool = (pool, requestID) => actionBody('manage', { action: 'pool_remove', pool: pool.id, generation: pool.generation, expected_policy_revision: pool.policy_revision, request_id: requestID });

/**
 * One reading of a call result.
 * - done: the service stored a terminal `succeeded` receipt (`replayed` when it was an earlier save).
 * - conflict: a revision/generation went stale; the draft stays.
 * - rejected: refused with a reason; nothing changed.
 * - failed: the service stored a terminal failure.
 * - busy: the host had no free slot (429); nothing ran, the same request may be sent again.
 * - unknown: no answer, or still running; check the request before anything else.
 * @param {import('./bridge.js').CallResult} result @param {number} [sentAt]
 * @returns {{ state: 'done' | 'conflict' | 'rejected' | 'failed' | 'busy' | 'unknown', replayed?: boolean, message?: string, output?: any }}
 */
export function classify(result, sentAt) {
  if (!result.ok) {
    const { code, message } = result.error;
    if (code === 'busy') return { state: 'busy' };
    if (code === 'no_response' || code === 'request_in_flight' || code === 'timeout') return { state: 'unknown', message };
    if (/conflict|stale|revision/i.test(message) || code === 'conflict') return { state: 'conflict', message };
    return { state: 'rejected', message };
  }
  const out = result.output ?? {};
  if (out.status === 'error') return { state: out.code === 'conflict' ? 'conflict' : 'rejected', message: out.message, output: out };
  if (out.status === 'failed') return { state: 'failed', message: out.reason, output: out };
  if (out.status === 'succeeded') {
    const earlier = !!result.receipt && sentAt !== undefined && Date.parse(result.receipt.at) < sentAt - 1000;
    return { state: 'done', replayed: !!out.replay || earlier, output: out };
  }
  if (out.status === 'pending' || out.status === 'uncertain') return { state: 'unknown', output: out };
  return { state: 'unknown', message: 'unrecognized receipt', output: out };
}

/** A view answer: its output, or an Error carrying the host's code. @param {import('./bridge.js').CallResult} result */
export function viewOutput(result) {
  if (result.ok) {
    if (result.output?.status === 'error') throw Object.assign(new Error(result.output.message || 'refused'), { code: result.output.code || 'rejected' });
    return result.output;
  }
  throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

// Draft recovery (D2.2): only the request id and binding metadata survive a
// reload, never document contents or credentials. Storage may be blocked (an
// opaque-origin frame, private mode): every access is guarded and the page
// works without it.
export const RECOVERY_KEY = 'soot.kho-tai-lieu.pending.v1';
const RECOVERY_FIELDS = ['request_id', 'kind', 'action', 'pool', 'at'];

/** @param {{ request_id: string, kind: string, action: string, pool: string, at: string }} pending */
export function recoveryRecord(pending) {
  return Object.fromEntries(RECOVERY_FIELDS.map(k => [k, String(/** @type {any} */ (pending)[k] ?? '')]));
}
/** @param {() => Storage | undefined} storage @returns {boolean} whether it was stored */
export function remember(storage, /** @type {any} */ pending) {
  try {
    const s = storage();
    if (!s) return false;
    if (pending) s.setItem(RECOVERY_KEY, JSON.stringify(recoveryRecord(pending)));
    else s.removeItem(RECOVERY_KEY);
    return true;
  } catch { return false; }
}
/** @param {() => Storage | undefined} storage */
export function recall(storage) {
  try {
    const raw = storage()?.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const ok = (/** @type {unknown} */ v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
    if (!saved || typeof saved !== 'object' || !/^[A-Za-z0-9_-]{8,64}$/.test(saved.request_id) || !ACTION_KINDS.includes(saved.kind) || !ok(saved.action, 32) || !ok(saved.pool)) return null;
    return recoveryRecord(saved);
  } catch { return null; }
}
