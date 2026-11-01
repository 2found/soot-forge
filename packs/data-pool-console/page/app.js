// Built from src/ by tests/build.mjs; do not edit.
'use strict';
(() => {
// ---- src/bridge.js ----
const __bridge = (() => {
// soot-pages bridge v1, frame side. The page never fetches: every read and
// write is a `call` posted to Nest (or the runtime's standalone shell), which
// runs this pack's view/action tool and posts back one `result`. Messages that
// are not exactly bridge v1 are ignored, as Nest does on its side.

/** @typedef {{ request_id: string, status: string, at: string }} Receipt */
/** @typedef {{ ok: true, output: any, receipt?: Receipt } | { ok: false, error: { code: string, message: string } }} CallResult */
/** @typedef {{ theme: 'light' | 'dark', locale: 'vi' | 'en', tokens: Record<string, string> }} Init */

const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A random id from getRandomValues, which works in an opaque-origin frame where randomUUID may not. */
function randomID(prefix = 'r', bytes = 12, random = globalThis.crypto) {
  const data = random.getRandomValues(new Uint8Array(bytes));
  return prefix + '-' + Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} value @param {string[]} allowed */
function exactKeys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every(k => allowed.includes(k)) && required.every(k => keys.includes(k));
}
const isTokens = (/** @type {unknown} */ t) => !!t && typeof t === 'object' && !Array.isArray(t) &&
  Object.entries(t).every(([k, v]) => /^--[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 256);

/** Parse a Nest → frame message; anything else is null and dropped. @param {unknown} m */
function parseNestMessage(m) {
  if (!m || typeof m !== 'object' || /** @type {any} */ (m).v !== 1) return null;
  const msg = /** @type {any} */ (m);
  switch (msg.type) {
    case 'init':
      if (!exactKeys(msg, ['v', 'type', 'theme', 'locale', 'tokens']) || !['light', 'dark'].includes(msg.theme) || !['vi', 'en'].includes(msg.locale) || !isTokens(msg.tokens)) return null;
      return msg;
    case 'theme':
      if (!exactKeys(msg, ['v', 'type', 'theme', 'tokens']) || !['light', 'dark'].includes(msg.theme) || !isTokens(msg.tokens)) return null;
      return msg;
    case 'result':
      if (typeof msg.id !== 'string' || !BRIDGE_ID.test(msg.id)) return null;
      if (msg.ok === true && exactKeys(msg, ['v', 'type', 'id', 'ok', 'output', 'receipt'], ['v', 'type', 'id', 'ok', 'output'])) return msg;
      if (msg.ok === false && exactKeys(msg, ['v', 'type', 'id', 'ok', 'error']) && exactKeys(msg.error, ['code', 'message']) &&
        typeof msg.error.code === 'string' && typeof msg.error.message === 'string') return msg;
      return null;
  }
  return null;
}

/** Apply Nest's tokens through CSSOM (the page CSP allows it; inline styles are not). */
function applyTheme(/** @type {{ theme: string, tokens: Record<string, string> }} */ msg, root = globalThis.document?.documentElement) {
  if (!root) return;
  for (const [name, value] of Object.entries(msg.tokens)) root.style.setProperty(name, value);
  root.dataset.theme = msg.theme;
}

/**
 * @param {{ post: (message: object) => void, listen: (handler: (data: unknown, source: unknown) => void) => void,
 *   parent?: unknown, timeoutMs?: number, onInit?: (init: Init) => void, onTheme?: (msg: any) => void }} io
 */
function createBridge(io) {
  /** @type {Map<string, { resolve: (r: CallResult) => void, timer: any }>} */
  const waiting = new Map();
  const timeoutMs = io.timeoutMs ?? 30000;
  io.listen((data, source) => {
    if (io.parent !== undefined && source !== io.parent) return;
    const msg = parseNestMessage(data);
    if (!msg) return;
    if (msg.type === 'init') io.onInit?.(msg);
    else if (msg.type === 'theme') io.onTheme?.(msg);
    else {
      const entry = waiting.get(msg.id);
      if (!entry) return;
      waiting.delete(msg.id); clearTimeout(entry.timer);
      entry.resolve(msg.ok ? { ok: true, output: msg.output, ...(msg.receipt ? { receipt: msg.receipt } : {}) } : { ok: false, error: msg.error });
    }
  });
  return {
    ready() { io.post({ v: 1, type: 'ready' }); },
    /**
     * One call. A missing result within the timeout resolves as `no_response`: for an
     * action the outcome is then unknown, never assumed failed.
     * @param {'view' | 'action'} mode @param {object} input @param {string} [requestID]
     * @returns {Promise<CallResult>}
     */
    call(mode, input, requestID) {
      if (mode === 'action' && !(requestID && REQUEST_ID.test(requestID))) throw new Error('action needs a request_id');
      const id = randomID('c', 8);
      return new Promise(resolve => {
        const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: { code: 'no_response', message: 'no result from the host' } }); }, timeoutMs);
        waiting.set(id, { resolve, timer });
        io.post({ v: 1, type: 'call', id, mode, input, ...(requestID ? { request_id: requestID } : {}) });
      });
    },
    pending() { return waiting.size; },
  };
}
return { REQUEST_ID, randomID, parseNestMessage, applyTheme, createBridge };
})();

// ---- src/model.js ----
const __model = (() => {
// What the page sends and how it reads the answer. The body of every call is
// the data-pool interface body {kind, input} (docs/nest-interface.md): the same
// one Nest's link sheets and knowledge picker send, so the page and those
// callers share one contract with the view/action tools.

const VIEW_KINDS = ['overview', 'pools', 'query', 'activity', 'status'];
const ACTION_KINDS = ['write', 'manage'];

/** @param {string} kind @param {object} [input] */
function viewBody(kind, input = {}) {
  if (!VIEW_KINDS.includes(kind)) throw new Error(`unsupported data-pool view: ${kind}`);
  return { kind, input };
}
/** @param {string} kind @param {object} input */
function actionBody(kind, input) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unsupported data-pool action: ${kind}`);
  return { kind, input };
}

const PAGE = 20;
const listDocuments = (/** @type {string} */ pool, after = '') => viewBody('query', { action: 'list', pool, limit: PAGE, ...(after ? { after } : {}) });
const searchDocuments = (/** @type {string} */ pool, /** @type {string} */ query, offset = 0) => viewBody('query', { action: 'search', pool, query, offset, limit: PAGE });
const readDocument = (/** @type {string} */ pool, /** @type {string} */ id, offset = 0) => viewBody('query', { action: 'read', pool, id, offset, limit: 8192 });
const listPools = (organized = false, after = '') => viewBody('pools', { limit: PAGE, ...(organized ? { parent: '' } : {}), ...(after ? { after } : {}) });
const poolDetail = (/** @type {string} */ pool) => viewBody('pools', { pool });
const activity = (/** @type {string} */ pool, after = '') => viewBody('activity', { pool, limit: PAGE, ...(after ? { after } : {}) });
const requestStatus = (/** @type {string} */ requestID) => viewBody('status', { request_id: requestID });

/**
 * A document save. Revision and pool generation are the ones the person read; the
 * service refuses a stale pair as a conflict and the page keeps the draft.
 * @param {{ pool: string, id: string, title: string, content?: string, url?: string, source?: string, tags: string[], revision: number, generation: string }} d
 * @param {string} requestID
 */
function saveDocument(d, requestID) {
  return actionBody('write', {
    action: 'upsert', pool: d.pool, id: d.id, title: d.title, generation: d.generation, expected_revision: d.revision,
    tags: d.tags, ...(d.url ? { url: d.url } : { content: d.content ?? '', ...(d.source ? { source: d.source } : {}) }), request_id: requestID,
  });
}
/** @param {{ pool: string, generation: string }} pool @param {{ id: string, revision: number }} doc @param {string} requestID */
const removeDocument = (pool, doc, requestID) => actionBody('write', { action: 'remove', pool: pool.pool, id: doc.id, generation: pool.generation, expected_revision: doc.revision, request_id: requestID });
/** @param {{ pool: string, name: string, organized?: boolean }} p @param {string} requestID */
const createPool = (p, requestID) => actionBody('manage', { action: 'pool_create', pool: p.pool, name: p.name, ...(p.organized ? { parent: '', inherit: true } : {}), request_id: requestID });
/** @param {{ id: string, generation: string, policy_revision: number }} pool @param {string} requestID */
const removePool = (pool, requestID) => actionBody('manage', { action: 'pool_remove', pool: pool.id, generation: pool.generation, expected_policy_revision: pool.policy_revision, request_id: requestID });

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
function classify(result, sentAt) {
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
function viewOutput(result) {
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
const RECOVERY_KEY = 'soot.kho-tai-lieu.pending.v1';
const RECOVERY_FIELDS = ['request_id', 'kind', 'action', 'pool', 'at'];

/** @param {{ request_id: string, kind: string, action: string, pool: string, at: string }} pending */
function recoveryRecord(pending) {
  return Object.fromEntries(RECOVERY_FIELDS.map(k => [k, String(/** @type {any} */ (pending)[k] ?? '')]));
}
/** @param {() => Storage | undefined} storage @returns {boolean} whether it was stored */
function remember(storage, /** @type {any} */ pending) {
  try {
    const s = storage();
    if (!s) return false;
    if (pending) s.setItem(RECOVERY_KEY, JSON.stringify(recoveryRecord(pending)));
    else s.removeItem(RECOVERY_KEY);
    return true;
  } catch { return false; }
}
/** @param {() => Storage | undefined} storage */
function recall(storage) {
  try {
    const raw = storage()?.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const ok = (/** @type {unknown} */ v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
    if (!saved || typeof saved !== 'object' || !/^[A-Za-z0-9_-]{8,64}$/.test(saved.request_id) || !ACTION_KINDS.includes(saved.kind) || !ok(saved.action, 32) || !ok(saved.pool)) return null;
    return recoveryRecord(saved);
  } catch { return null; }
}
return { VIEW_KINDS, ACTION_KINDS, viewBody, actionBody, PAGE, listDocuments, searchDocuments, readDocument, listPools, poolDetail, activity, requestStatus, saveDocument, removeDocument, createPool, removePool, classify, viewOutput, RECOVERY_KEY, recoveryRecord, remember, recall };
})();

// ---- src/text.js ----
const __text = (() => {
// The page's words in Vietnamese and English (D2.4: the labels belong to the
// pack, not to Nest). Nothing here prints an id, a byte count or a revision
// number on its own; those stay in the support details.

const vi = {
  title: 'Kho tài liệu', intro: 'Tài liệu Soot được đọc khi trả lời. Sửa ở đây, Soot dùng bản mới từ câu trả lời tới.',
  collection: 'Bộ sưu tập', chooseCollection: 'Chọn bộ sưu tập', moreCollections: 'Xem thêm bộ sưu tập', newCollection: 'Tạo bộ sưu tập',
  collectionName: 'Tên bộ sưu tập', create: 'Tạo', cancel: 'Huỷ', reload: 'Tải lại',
  noCollections: 'Chưa có bộ sưu tập nào', noCollectionsHint: 'Bộ sưu tập là một ngăn chứa tài liệu liên quan, ví dụ “Chính sách hoàn tiền”. Tạo bộ đầu tiên, rồi cấp quyền đọc cho Soot ở Quyền hạn.',
  tabDocuments: 'Tài liệu', tabGrants: 'Quyền đọc', tabActivity: 'Hoạt động',
  search: 'Tìm', searchLabel: 'Tìm tài liệu', searchHint: 'Tìm trong bộ sưu tập (gõ sai vẫn tìm được)', clearSearch: 'Bỏ tìm kiếm',
  resultsFor: (/** @type {number} */ n, /** @type {string} */ q) => `${n} kết quả gần đúng cho “${q}”`,
  notFound: (/** @type {string} */ q) => `Không tìm thấy “${q}”`, emptyCollection: 'Bộ sưu tập chưa có tài liệu', emptyHint: 'Bấm “Thêm tài liệu” để dán nội dung, hoặc “Nhập từ đường dẫn” với một trang công khai.',
  addDocument: 'Thêm tài liệu', importURL: 'Nhập từ đường dẫn', firstPage: 'Về trang đầu', nextPage: 'Trang sau',
  back: 'Danh sách', edit: 'Sửa tài liệu', readMore: 'Đọc tiếp', remove: 'Xoá tài liệu…', removeCollection: 'Xoá bộ sưu tập…',
  removeDocHint: 'Xoá tài liệu khỏi bộ sưu tập. Các cuộc trò chuyện cũ vẫn giữ nguyên.',
  confirmRemoveDoc: (/** @type {string} */ name) => `Xoá tài liệu “${name}”? Không hoàn tác được.`,
  confirmRemovePool: (/** @type {string} */ name, /** @type {number} */ n) => `Xoá bộ sưu tập “${name}” cùng ${n} tài liệu, quyền và lịch sử của nó? Không hoàn tác được. Bộ còn bộ con thì chưa xoá được.`,
  confirmYes: 'Xoá', fieldTitle: 'Tiêu đề', fieldBody: 'Nội dung', fieldURL: 'Địa chỉ trang web công khai', urlHint: 'Chỉ một trang. Địa chỉ nội bộ sẽ bị từ chối.',
  fieldTags: 'Nhãn', tagsHint: 'Phân cách bằng dấu phẩy.', fieldSource: 'Địa chỉ gốc của nội dung (nếu có)',
  editing: (/** @type {number} */ r) => r ? `Bản sửa ${r} · bạn đang sửa` : 'Tài liệu mới', save: 'Lưu', fieldNeeded: 'Cần điền ô này.', urlInvalid: 'Địa chỉ phải là trang web công khai (http hoặc https).', tooLong: 'Nội dung dài hơn mức sửa trực tiếp được. Hãy rút gọn, hoặc nhập từ một đường dẫn công khai.',
  tooLongToEdit: 'Tài liệu dài hơn mức sửa trực tiếp được; có thể thay bằng một đường dẫn công khai.',
  conflict: 'Có người vừa lưu bản mới của tài liệu này nên bản của bạn chưa được lưu. Bản sửa của bạn vẫn được giữ.',
  conflictPool: 'Bộ sưu tập vừa đổi nên thay đổi chưa được lưu. Tải lại rồi thử lại.',
  yourVersion: 'Bản của bạn', viewLatest: 'Xem bản mới nhất', copyMine: 'Sao chép bản của bạn', copied: 'Đã sao chép.', copyFailed: 'Không sao chép được; hãy chọn và sao chép thủ công.',
  overwrite: 'Lưu đè lên bản mới nhất…', latestLoaded: 'Đã tải bản mới nhất. Bản của bạn vẫn ở dưới; bấm Lưu để lưu đè lên bản này.',
  unknown: 'Không biết lần lưu trước đã tới máy chủ chưa (mất kết nối giữa chừng). Gửi lại đúng yêu cầu đó sẽ không tạo bản thứ hai.',
  resend: 'Gửi lại', checkStatus: 'Kiểm tra trạng thái',
  recovered: 'Trang vừa mở lại khi một thay đổi chưa được xác nhận. Kiểm tra trạng thái trước; nội dung bản sửa không được lưu trên thiết bị.',
  recoveredMissing: 'Máy chủ chưa nhận thay đổi đó. Nội dung không được lưu trên thiết bị, hãy nhập lại.',
  replayed: (/** @type {string} */ at) => `Đã lưu một lần${at ? ', lúc ' + at : ''}. Lần gửi lại chỉ nhận lại xác nhận cũ.`,
  saved: { upsert: 'Đã lưu · Soot dùng bản này từ câu trả lời tới', remove: 'Đã xoá tài liệu.', pool_create: 'Đã tạo bộ sưu tập.', pool_remove: 'Đã xoá bộ sưu tập.' },
  failed: 'Kho dữ liệu chưa lưu được. Bản sửa của bạn vẫn được giữ, bạn có thể thử lại.',
  busy: 'Máy chủ đang bận. Thử lại sau ít phút.', retry: 'Thử lại', loading: 'Đang tải…', working: 'Đang xử lý…',
  noStorage: 'Không lưu được thông tin khôi phục trên thiết bị. Đừng tải lại trang trước khi kiểm tra xong yêu cầu.',
  loadFailed: 'Chưa đọc được kho dữ liệu. Kiểm tra dịch vụ kho dữ liệu đang chạy và khoá giao diện đã được cấp.',
  grantsIntro: 'Soot nào được đọc bộ sưu tập này. Trang này chỉ hiển thị; đổi quyền ở Quyền hạn của từng Soot.',
  grantSoot: 'Soot', grantLevel: 'Quyền', hostManager: 'Người quản lý máy chủ', changeAt: 'Đổi ở Quyền hạn',
  levels: { '': 'Không có quyền', read: 'Đọc', write: 'Đọc và ghi', manage: 'Quản lý' }, readers: (/** @type {string[]} */ n) => n.length ? `Đọc được: ${n.join(', ')}` : 'Chưa Soot nào đọc được',
  documents: (/** @type {number} */ n) => `${n} tài liệu`,
  activityIntro: (/** @type {number} */ n) => `Giữ tối đa ${n} sự kiện. Nhật ký truy cập không xác nhận dữ liệu đã được dùng trong câu trả lời.`,
  noActivity: 'Chưa có hoạt động nào trong bộ sưu tập này.', newest: 'Mới nhất', older: 'Trang trước đó', expired: 'Các hoạt động cũ hơn đã hết thời gian lưu.',
  events: { pool_create: 'Tạo bộ sưu tập', pool_update: 'Sắp xếp bộ sưu tập', pool_remove: 'Xoá bộ sưu tập', append: 'Thêm quan sát', upsert: 'Thêm / cập nhật', remove: 'Xoá tài liệu', grant: 'Cấp quyền', revoke: 'Thu hồi quyền', read: 'Đọc tài liệu', list: 'Xem danh sách', search: 'Tìm dữ liệu' },
  statuses: { succeeded: 'Đã hoàn tất', failed: 'Thất bại', rejected: 'Đã từ chối', pending: 'Đang xử lý', uncertain: 'Chưa xác nhận' },
  human: (/** @type {string} */ via) => `Người dùng · qua ${via}`, unrecorded: 'Chưa ghi nhận', untitled: 'Tài liệu chưa đặt tên',
  source: 'Xuất xứ', noSource: 'Chưa ghi địa chỉ gốc', bySoot: 'Do Soot thêm vào', noTags: 'Chưa có nhãn', changed: 'Tài liệu đã đổi. Tải lại từ đầu để xem cùng một bản.',
  support: 'Thông tin hỗ trợ', requestID: 'Mã yêu cầu',
};

/** @type {typeof vi} */
const en = {
  title: 'Library', intro: 'Documents your Soots read when they answer. Edit here and the next answer uses the new version.',
  collection: 'Collection', chooseCollection: 'Choose a collection', moreCollections: 'More collections', newCollection: 'New collection',
  collectionName: 'Collection name', create: 'Create', cancel: 'Cancel', reload: 'Reload',
  noCollections: 'No collections yet', noCollectionsHint: 'A collection holds related documents, such as “Refund policy”. Create the first one, then let Soots read it under Permissions.',
  tabDocuments: 'Documents', tabGrants: 'Readers', tabActivity: 'Activity',
  search: 'Search', searchLabel: 'Search documents', searchHint: 'Search this collection (typos are fine)', clearSearch: 'Clear search',
  resultsFor: (n, q) => `${n} close matches for “${q}”`,
  notFound: q => `Nothing found for “${q}”`, emptyCollection: 'This collection has no documents', emptyHint: 'Choose “Add document” to paste text, or “Import from a link” for a public page.',
  addDocument: 'Add document', importURL: 'Import from a link', firstPage: 'First page', nextPage: 'Next page',
  back: 'List', edit: 'Edit document', readMore: 'Read more', remove: 'Delete document…', removeCollection: 'Delete collection…',
  removeDocHint: 'Removes the document from the collection. Past conversations stay as they are.',
  confirmRemoveDoc: name => `Delete “${name}”? This cannot be undone.`,
  confirmRemovePool: (name, n) => `Delete “${name}” with its ${n} documents, permissions and history? This cannot be undone. A collection with sub-collections cannot be deleted yet.`,
  confirmYes: 'Delete', fieldTitle: 'Title', fieldBody: 'Content', fieldURL: 'Public web page address', urlHint: 'One page only. Internal addresses are refused.',
  fieldTags: 'Tags', tagsHint: 'Separate with commas.', fieldSource: 'Where this content came from (optional)',
  editing: r => r ? `Version ${r} · you are editing` : 'New document', save: 'Save', fieldNeeded: 'This field is required.', urlInvalid: 'The address must be a public web page (http or https).', tooLong: 'This is longer than can be edited here. Shorten it, or import it from a public link.',
  tooLongToEdit: 'This document is longer than can be edited here; you can replace it with a public link.',
  conflict: 'Someone saved a newer version of this document, so yours was not saved. Your edits are kept.',
  conflictPool: 'The collection changed, so nothing was saved. Reload and try again.',
  yourVersion: 'Your version', viewLatest: 'View the latest version', copyMine: 'Copy your version', copied: 'Copied.', copyFailed: 'Could not copy; select and copy it by hand.',
  overwrite: 'Save over the latest version…', latestLoaded: 'Latest version loaded. Your text is below; Save writes it over this version.',
  unknown: 'We do not know whether the last save reached the server (the connection dropped). Resending that same request never makes a second copy.',
  resend: 'Resend', checkStatus: 'Check status',
  recovered: 'The page reopened while a change was unconfirmed. Check its status first; the edited content was not stored on this device.',
  recoveredMissing: 'The server never received that change. The content was not stored on this device; enter it again.',
  replayed: at => `Saved once${at ? ' at ' + at : ''}. The resend only fetched the earlier confirmation.`,
  saved: { upsert: 'Saved · Soots use this version from the next answer', remove: 'Document deleted.', pool_create: 'Collection created.', pool_remove: 'Collection deleted.' },
  failed: 'The library could not save this. Your edits are kept; you can try again.',
  busy: 'The server is busy. Try again in a few minutes.', retry: 'Try again', loading: 'Loading…', working: 'Working…',
  noStorage: 'Recovery details could not be stored on this device. Do not reload until the request is checked.',
  loadFailed: 'Could not read the library. Check that the data-pool service runs and the interface key is granted.',
  grantsIntro: 'Which Soots may read this collection. This page only shows it; change it under each Soot’s Permissions.',
  grantSoot: 'Soot', grantLevel: 'Access', hostManager: 'Host manager', changeAt: 'Change under Permissions',
  levels: { '': 'No access', read: 'Read', write: 'Read and write', manage: 'Manage' }, readers: n => n.length ? `Readable by: ${n.join(', ')}` : 'No Soot can read it yet',
  documents: n => `${n} documents`,
  activityIntro: n => `Keeps at most ${n} events. Access records do not prove a source was used in an answer.`,
  noActivity: 'No activity in this collection yet.', newest: 'Newest', older: 'Older', expired: 'Older activity has expired.',
  events: { pool_create: 'Collection created', pool_update: 'Collection arranged', pool_remove: 'Collection deleted', append: 'Observation added', upsert: 'Added / updated', remove: 'Document deleted', grant: 'Access granted', revoke: 'Access revoked', read: 'Document read', list: 'List viewed', search: 'Searched' },
  statuses: { succeeded: 'Done', failed: 'Failed', rejected: 'Refused', pending: 'In progress', uncertain: 'Unconfirmed' },
  human: via => `A person · via ${via}`, unrecorded: 'Not recorded', untitled: 'Untitled document',
  source: 'Source', noSource: 'No source address', bySoot: 'Added by a Soot', noTags: 'No tags', changed: 'The document changed. Reload it from the start to read one version.',
  support: 'Support details', requestID: 'Request ID',
};

const STRINGS = { vi, en };
/** @param {string} locale */
const strings = locale => locale === 'en' ? en : vi;

/** A document title for a person: a `soot://` address or slug reads as words, keeping a date's dashes. */
function docTitle(/** @type {string | undefined} */ title, id = '', t = vi) {
  const raw = (title || id).trim();
  if (!raw || (/\s/.test(raw) && !/^[a-z][\w+.-]*:\/\//i.test(raw))) return raw || t.untitled;
  const last = raw.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? raw;
  const words = last.replace(/\.(md|txt|markdown)$/i, '').replace(/(?<!\d)[-_]+|[-_]+(?!\d)/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : raw;
}
const sourceLine = (/** @type {string | undefined} */ source, t = vi) => !source ? t.noSource : /^soot:\/\//i.test(source) ? t.bySoot : source;
/** @param {{ kind: string, soot: string } | undefined} actor @param {(id: string) => string} name */
const actorLabel = (actor, name, t = vi) => actor ? actor.kind === 'human' ? t.human(name(actor.soot)) : name(actor.soot) : t.unrecorded;
const utf8Bytes = (/** @type {string} */ text) => new TextEncoder().encode(text).length;
/** With no limit known nothing is editable inline, as before. */
const overInlineLimit = (/** @type {number} */ bytes, /** @type {number | undefined} */ limit) => bytes > (limit || 0);
/** Readers of a collection: direct or inherited grants, group grants through their members, and host managers. */
function readerIds(/** @type {any} */ d) {
  const ids = new Set(d.host_managers ?? []);
  for (const soot of d.bound_soots ?? []) if (d.effective_permissions?.[soot] ?? d.grants?.[soot]) ids.add(soot);
  for (const [group, level] of Object.entries(d.effective_group_grants ?? {})) if (level) for (const soot of d.groups?.[group] ?? []) ids.add(soot);
  return [...ids];
}
const parseTags = (/** @type {string} */ text) => [...new Set(text.split(',').map(s => s.trim()).filter(Boolean))];
return { STRINGS, strings, docTitle, sourceLine, actorLabel, utf8Bytes, overInlineLimit, readerIds, parseTags };
})();

// ---- src/app.js ----
const __app = (() => {
// Kho tài liệu: the data-pool console as a soot-pages page (D2.1). Plain DOM,
// no framework, no network: reads and writes go through the bridge to this
// pack's view/action tools. Parity: docs/nest-interface.md and 2agent
// docs/nest-data-pool.md § Human controls.
const { createBridge, applyTheme, randomID } = __bridge;
const M = __model;
const { strings, docTitle, sourceLine, actorLabel, utf8Bytes, overInlineLimit, readerIds, parseTags } = __text;

/** @typedef {{ id: string, name: string, generation: string, policy_revision: number, parent?: string, inherit?: boolean }} Pool */
/** @typedef {{ id: string, title: string, source?: string, tags?: string[], revision: number, updated_at: string, writer?: { kind: string, soot: string } }} Doc */

const storage = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };
const S = {
  t: strings('vi'), locale: 'vi', started: false,
  /** @type {any} */ overview: null, /** @type {Pool[]} */ pools: [], poolNext: '',
  /** @type {any} */ detail: null, /** @type {Doc[]} */ docs: [], docNext: '', searched: '', query: '', searchOffset: 0, paged: false,
  /** @type {Doc | null} */ selected: null, content: '', offset: 0, complete: false,
  /** @type {any} */ draft: null, conflict: false, latestLoaded: false, tab: 'documents',
  /** @type {any[]} */ activity: [], activityNext: '', oldest: 0,
  busy: false, goTo: '', /** @type {{ kind: 'info' | 'success' | 'wait', text: string } | null} */ notice: null, loadError: '',
  /** @type {any} */ pending: null, /** @type {{ text: string, run: () => void } | null} */ confirm: null, creating: false,
};

const bridge = createBridge({
  post: m => window.parent.postMessage(m, '*'),
  listen: h => window.addEventListener('message', e => h(e.data, e.source)),
  parent: window.parent === window ? undefined : window.parent,
  onInit: init => { applyTheme(init); S.locale = init.locale; S.t = strings(init.locale); document.documentElement.lang = init.locale; start(); },
  onTheme: msg => applyTheme(msg),
});

// ---- calls ----
const view = async (/** @type {object} */ body) => M.viewOutput(await bridge.call('view', body));
const organized = () => !!S.overview?.organization_version;
const fail = (/** @type {any} */ e) => e?.code === 'busy' ? { kind: /** @type {const} */ ('wait'), text: S.t.busy } : { kind: /** @type {const} */ ('info'), text: e?.message || S.t.loadFailed };

/** Run one read; the page refuses a second while one is in flight. @param {() => Promise<void>} work */
async function run(work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } catch (e) { S.notice = fail(e); } finally { S.busy = false; render(); }
}

async function load() {
  S.loadError = '';
  try {
    S.overview = await view(M.viewBody('overview'));
    const page = await view(M.listPools(organized()));
    S.pools = page.pools ?? []; S.poolNext = page.next ?? '';
    const keep = S.goTo && S.pools.some(p => p.id === S.goTo) ? S.goTo : S.detail?.pool?.id && S.pools.some(p => p.id === S.detail.pool.id) ? S.detail.pool.id : S.pending?.pool && S.pools.some(p => p.id === S.pending.pool) ? S.pending.pool : S.pools[0]?.id;
    S.goTo = '';
    if (keep) await openPool(keep); else S.detail = null;
  } catch (e) { S.loadError = /** @type {any} */ (e)?.code === 'busy' ? S.t.busy : S.t.loadFailed; S.notice = null; }
}
async function openPool(/** @type {string} */ id) {
  const [detail, docs] = await Promise.all([view(M.poolDetail(id)), view(M.listDocuments(id))]);
  Object.assign(S, { detail, docs: docs.documents ?? [], docNext: docs.next ?? '', searched: '', query: '', searchOffset: 0, paged: false, selected: null, content: '', complete: false });
  if (S.tab === 'activity') await loadActivity();
}
async function browse(after = '', term = S.searched, offset = 0) {
  const id = S.detail.pool.id;
  const data = await view(term ? M.searchDocuments(id, term, offset) : M.listDocuments(id, after));
  Object.assign(S, { docs: data.documents ?? data.hits?.map((/** @type {any} */ h) => h.document) ?? [], docNext: data.next ?? '', searchOffset: data.next_offset ?? 0, searched: term, paged: !!after || offset > 0, selected: null });
}
async function readDoc(/** @type {string} */ id, more = false) {
  const data = await view(M.readDocument(S.detail.pool.id, id, more ? S.offset : 0));
  if (more && S.selected?.revision !== data.document.revision) { S.notice = { kind: 'info', text: S.t.changed }; return; }
  S.selected = data.document; S.content = more ? S.content + data.content : data.content; S.offset = data.next_offset; S.complete = data.complete;
}
async function loadActivity(after = '') {
  const data = await view(M.activity(S.detail.pool.id, after));
  S.activity = data.activity ?? []; S.activityNext = data.next ?? ''; S.oldest = data.oldest_sequence ?? 0;
}

// ---- changes: one request id per intent, kept until a terminal answer ----
/** @param {{ kind: string, input: any }} body */
async function mutate(body) {
  if (S.pending || S.busy) return;
  const p = { request_id: body.input.request_id, kind: body.kind, action: body.input.action, pool: body.input.pool, at: new Date().toISOString(), body, state: 'sending' };
  S.pending = p; S.notice = null; S.conflict = false;
  if (!M.remember(storage, p)) S.notice = { kind: 'info', text: S.t.noStorage };
  await send();
}
async function send() {
  const p = S.pending; if (!p?.body) return;
  S.busy = true; p.state = 'sending'; render();
  const sentAt = Date.now();
  const result = await bridge.call('action', p.body, p.request_id);
  S.busy = false;
  await settle(M.classify(result, sentAt));
}
/** @param {ReturnType<typeof M.classify>} c */
async function settle(c) {
  const p = S.pending; if (!p) return;
  if (c.state === 'unknown' || c.state === 'busy') { p.state = c.state; S.notice = c.state === 'busy' ? { kind: 'wait', text: S.t.busy } : null; render(); return; }
  S.pending = null; M.remember(storage, null);
  if (c.state === 'conflict') { S.conflict = !!S.draft; S.notice = { kind: 'info', text: S.draft ? S.t.conflict : S.t.conflictPool }; render(); return; }
  if (c.state === 'rejected' || c.state === 'failed') { S.notice = { kind: 'info', text: c.state === 'failed' ? S.t.failed : c.message || S.t.failed }; render(); return; }
  const at = c.replayed ? new Date(c.output?.document?.updated_at ?? p.at).toLocaleTimeString(S.locale === 'en' ? 'en-GB' : 'vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
  S.notice = { kind: 'success', text: c.replayed ? S.t.replayed(at) : /** @type {any} */ (S.t.saved)[p.action] || S.t.saved.upsert };
  S.draft = null; S.conflict = false; S.latestLoaded = false; S.selected = null; S.confirm = null; S.creating = false;
  S.goTo = p.action === 'pool_create' ? p.pool : '';
  await run(load);
}
async function checkStatus() {
  const p = S.pending; if (!p || S.busy) return;
  S.busy = true; render();
  try {
    const receipt = await view(M.requestStatus(p.request_id));
    S.busy = false; await settle(M.classify({ ok: true, output: receipt }));
  } catch (e) {
    S.busy = false;
    if (p.recovered) { S.pending = null; M.remember(storage, null); S.notice = { kind: 'info', text: S.t.recoveredMissing }; }
    else S.notice = fail(e);
    render();
  }
}

// ---- drafts ----
function edit(/** @type {'text' | 'url'} */ mode, /** @type {Doc | undefined} */ doc) {
  S.draft = { pool: S.detail.pool.id, id: doc?.id || randomID('doc', 8), title: doc?.title || '', content: doc ? S.content : '', source: doc?.source || '', url: '', tags: doc?.tags?.join(', ') || '', revision: doc?.revision || 0, generation: S.detail.pool.generation, mode };
  S.selected = null; S.notice = null; S.conflict = false; S.latestLoaded = false; S.tab = 'documents';
}
function saveDraft() {
  const d = S.draft;
  return mutate(M.saveDocument({ ...d, tags: parseTags(d.tags), ...(d.mode === 'url' ? { url: d.url } : { url: '' }) }, randomID('kho')));
}
/** The conflict path: read the latest, keep the person's text, save over that revision when they say so. */
async function viewLatest() {
  await run(async () => {
    const data = await view(M.readDocument(S.detail.pool.id, S.draft.id));
    const fresh = await view(M.poolDetail(S.detail.pool.id));
    S.detail = fresh; S.selected = data.document; S.content = data.content; S.complete = data.complete;
    S.draft.revision = data.document.revision; S.draft.generation = fresh.pool.generation; S.latestLoaded = true;
    S.notice = { kind: 'info', text: S.t.latestLoaded };
  });
}
async function copyMine() {
  const text = S.draft?.content ?? '';
  try { await navigator.clipboard.writeText(text); S.notice = { kind: 'success', text: S.t.copied }; }
  catch { /** @type {HTMLTextAreaElement | null} */ (document.querySelector('#d-body'))?.select(); S.notice = { kind: 'info', text: S.t.copyFailed }; }
  render();
}

// ---- rendering ----
/** @param {string} tag @param {Record<string, any>} [props] @param {...any} children */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(4)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  return el;
}
const btn = (/** @type {string} */ label, /** @type {() => any} */ onclick, cls = '', disabled = false) => h('button', { type: 'button', class: 'btn ' + cls, disabled: disabled || S.busy || undefined, onclick }, label);
// No form element: the frame's sandbox has no allow-forms, so a submit never fires. Enter in a single-line field acts instead.
const onEnter = (/** @type {() => void} */ act) => (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); act(); } };
const later = (/** @type {() => Promise<void>} */ work) => () => void run(work);
const date = (/** @type {string} */ iso, time = false) => { const d = new Date(iso); return isNaN(+d) ? '' : time ? d.toLocaleString(S.locale === 'en' ? 'en-GB' : 'vi-VN') : d.toLocaleDateString(S.locale === 'en' ? 'en-GB' : 'vi-VN'); };
const name = (/** @type {string} */ id) => id;

function noticeView() {
  const t = S.t, p = S.pending, out = [];
  if (p) {
    if (p.recovered) out.push(h('div', { class: 'notice', role: 'status' }, h('span', { class: 'grow' }, t.recovered), btn(t.checkStatus, checkStatus, 'sm')));
    else if (p.state === 'unknown') out.push(h('div', { class: 'notice', role: 'status' }, h('span', { class: 'grow' }, t.unknown), btn(t.checkStatus, checkStatus, 'sm quiet'), btn(t.resend, send, 'sm')));
    else if (p.state === 'busy') out.push(h('div', { class: 'status wait', role: 'status' }, t.busy + ' ', btn(t.retry, send, 'sm')));
    else out.push(h('p', { class: 'muted', role: 'status' }, t.working));
    out.push(h('details', { class: 'support' }, h('summary', {}, t.support), h('p', { class: 'mono' }, `${t.requestID}: ${p.request_id}`)));
  }
  if (S.notice) out.push(h('div', { class: 'notice ' + S.notice.kind, role: S.notice.kind === 'success' ? 'status' : 'alert' }, h('span', { class: 'grow' }, S.notice.text)));
  if (S.confirm) {
    const c = S.confirm;
    out.push(h('div', { class: 'notice confirm', role: 'alertdialog' }, h('span', { class: 'grow' }, c.text), btn(t.cancel, () => { S.confirm = null; render(); }, 'quiet sm'), btn(t.confirmYes, () => { S.confirm = null; c.run(); }, 'danger sm')));
  }
  return out;
}

function headerView() {
  const t = S.t, blocked = !!S.pending;
  const options = S.pools.map(p => h('option', { value: p.id, selected: S.detail?.pool?.id === p.id || undefined }, p.name));
  return h('div', { class: 'row toolbar' },
    S.pools.length ? h('label', { class: 'sr-only', for: 'pool' }, t.chooseCollection) : null,
    S.pools.length ? h('select', { id: 'pool', class: 'input pool', disabled: S.busy || blocked || !!S.draft || undefined, onchange: (/** @type {Event} */ e) => { const id = /** @type {HTMLSelectElement} */ (e.target).value; void run(() => openPool(id)); } }, options) : null,
    S.poolNext ? btn(t.moreCollections, later(async () => { const page = await view(M.listPools(organized(), S.poolNext)); S.pools = [...S.pools, ...(page.pools ?? [])]; S.poolNext = page.next ?? ''; }), 'quiet sm') : null,
    h('span', { class: 'sp' }),
    btn(t.reload, later(load), 'quiet sm', blocked),
    S.overview ? btn(t.newCollection, () => { S.creating = true; render(); document.getElementById('c-name')?.focus(); }, 'sm', blocked) : null);
}

function createView() {
  const t = S.t;
  const submit = () => { const value = /** @type {HTMLInputElement} */ (document.getElementById('c-name')).value.trim(); if (value) void mutate(M.createPool({ pool: randomID('collection', 8), name: value, organized: organized() }, randomID('kho'))); else document.getElementById('c-name')?.focus(); };
  return h('div', { class: 'card stack', role: 'group', 'aria-label': t.newCollection },
    h('div', { class: 'field' }, h('label', { for: 'c-name' }, t.collectionName), h('input', { id: 'c-name', class: 'input', required: true, maxLength: 128, onkeydown: onEnter(submit) })),
    h('div', { class: 'row' }, h('span', { class: 'sp' }), btn(t.cancel, () => { S.creating = false; render(); }, 'quiet'), btn(t.create, submit, 'primary', !!S.pending)));
}

function search() { const q = /** @type {HTMLInputElement} */ (document.getElementById('q')).value.trim(); void run(() => browse('', q)); }
function listView() {
  const t = S.t, d = S.detail;
  return [
    h('div', { class: 'row' },
      h('div', { class: 'row grow', role: 'search' },
        h('label', { class: 'sr-only', for: 'q' }, t.searchLabel), h('input', { id: 'q', class: 'input grow', type: 'search', placeholder: t.searchHint, value: S.searched, onkeydown: onEnter(search) }),
        btn(t.search, search)),
      btn(t.importURL, () => { edit('url'); render(); }, '', !!S.pending), btn(t.addDocument, () => { edit('text'); render(); }, 'primary', !!S.pending)),
    S.searched && S.docs.length ? h('div', { class: 'row' }, h('span', { class: 'muted', role: 'status' }, t.resultsFor(S.docs.length, S.searched)), btn(t.clearSearch, later(() => browse('', '')), 'quiet sm')) : null,
    !S.docs.length ? h('div', { class: 'empty' }, h('b', {}, S.searched ? t.notFound(S.searched) : t.emptyCollection), h('p', { class: 'muted' }, S.searched ? '' : t.emptyHint), S.searched ? btn(t.clearSearch, later(() => browse('', '')), 'sm') : null)
      : h('ul', { class: 'card list', 'aria-label': t.tabDocuments }, S.docs.map(doc => h('li', {}, h('button', { type: 'button', class: 'edge', disabled: S.busy || undefined, onclick: later(() => readDoc(doc.id)) },
          h('b', { class: 'grow' }, docTitle(doc.title, doc.id, t)), h('span', { class: 'who' }, `${actorLabel(doc.writer, name, t)} · ${date(doc.updated_at)}`))))),
    S.paged || S.docNext || S.searchOffset > 0 ? h('div', { class: 'row' }, h('span', { class: 'sp' }), S.paged ? btn(t.firstPage, later(() => browse('', S.searched)), 'sm') : null,
      S.docNext || S.searchOffset > 0 ? btn(t.nextPage, later(() => browse(S.docNext, S.searched, S.searchOffset)), 'sm') : null) : null,
    h('hr', { class: 'rule' }),
    h('div', { class: 'row' }, h('span', { class: 'who grow' }, t.documents(d.documents ?? S.docs.length)),
      btn(t.removeCollection, () => { S.confirm = { text: t.confirmRemovePool(d.pool.name, d.documents ?? 0), run: () => void mutate(M.removePool(d.pool, randomID('kho'))) }; render(); }, 'danger sm', !!S.pending)),
  ];
}

function docView() {
  const t = S.t, doc = /** @type {Doc} */ (S.selected), limit = S.overview?.limits?.inline_content_bytes;
  const tooLong = overInlineLimit(utf8Bytes(S.content), limit);
  return h('article', { class: 'stack doc', 'aria-label': docTitle(doc.title, doc.id, t) },
    h('div', { class: 'row' }, btn('← ' + t.back, () => { S.selected = null; render(); }, 'quiet sm'), h('span', { class: 'sp' }),
      btn(t.edit, () => { edit('text', doc); render(); }, 'sm', !S.complete || tooLong || !!S.pending)),
    h('h2', { tabIndex: -1 }, docTitle(doc.title, doc.id, t)),
    h('p', { class: 'who' }, `${actorLabel(doc.writer, name, t)} · ${date(doc.updated_at)}`),
    h('details', {}, h('summary', {}, t.source), h('p', { class: 'muted' }, sourceLine(doc.source, t)), h('p', { class: 'muted' }, `${date(doc.updated_at, true)} · ${doc.tags?.join(' · ') || t.noTags}`)),
    // Content is shown as source text, never rendered or executed.
    h('pre', { class: 'content' }, S.content),
    !S.complete ? btn(t.readMore, later(() => readDoc(doc.id, true)), 'sm') : null,
    S.complete && tooLong ? h('p', { class: 'muted' }, t.tooLongToEdit) : null,
    h('hr', { class: 'rule' }),
    h('div', { class: 'row' }, h('span', { class: 'who grow' }, t.removeDocHint),
      btn(t.remove, () => { S.confirm = { text: t.confirmRemoveDoc(docTitle(doc.title, doc.id, t)), run: () => void mutate(M.removeDocument({ pool: S.detail.pool.id, generation: S.detail.pool.generation }, doc, randomID('kho'))) }; render(); }, 'danger sm', !!S.pending)));
}

function editorView() {
  const t = S.t, d = S.draft, limit = S.overview?.limits?.inline_content_bytes;
  const tooLong = d.mode === 'text' && overInlineLimit(utf8Bytes(d.content), limit);
  const bind = (/** @type {string} */ key) => (/** @type {Event} */ e) => { d[key] = /** @type {HTMLInputElement} */ (e.target).value; if (d.invalid) { d.invalid = ''; document.querySelectorAll('[data-invalid]').forEach(n => n.setAttribute('hidden', '')); document.querySelectorAll('[aria-invalid]').forEach(n => n.removeAttribute('aria-invalid')); } if (key === 'content') document.getElementById('too-long')?.toggleAttribute('hidden', !(d.mode === 'text' && overInlineLimit(utf8Bytes(d.content), limit))); };
  const submit = () => {
    if (S.busy || S.pending) return;
    const missing = !d.title.trim() ? 'd-title' : d.mode === 'url' ? (!/^https?:\/\/\S+$/i.test(d.url.trim()) ? 'd-url' : '') : (!d.content.trim() ? 'd-body' : '');
    if (missing) { d.invalid = missing; render(); document.getElementById(missing)?.focus(); return; }
    if (!tooLongNow()) void saveDraft();
  };
  const tooLongNow = () => d.mode === 'text' && overInlineLimit(utf8Bytes(d.content), limit);
  const bad = (/** @type {string} */ id) => d.invalid === id ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-err` } : {};
  const err = (/** @type {string} */ id) => h('p', { id: `${id}-err`, class: 'error', 'data-invalid': '', hidden: d.invalid !== id || undefined }, id === 'd-url' && d.url.trim() ? t.urlInvalid : t.fieldNeeded);
  return h('div', { class: 'stack editor', role: 'group', 'aria-label': d.revision ? t.edit : t.addDocument },
    S.conflict && S.latestLoaded && S.selected ? h('div', { class: 'card latest' }, h('b', {}, docTitle(S.selected.title, S.selected.id, t)), h('pre', { class: 'content' }, S.content)) : null,
    h('div', { class: 'field' }, h('label', { for: 'd-title' }, t.fieldTitle), h('input', { id: 'd-title', class: 'input', required: true, maxLength: 256, value: d.title, oninput: bind('title'), ...bad('d-title') }), err('d-title')),
    d.mode === 'url'
      ? h('div', { class: 'field' }, h('label', { for: 'd-url' }, t.fieldURL), h('input', { id: 'd-url', class: 'input', type: 'url', required: true, value: d.url, oninput: bind('url'), ...bad('d-url') }), err('d-url'), h('p', { class: 'muted' }, t.urlHint))
      : h('div', { class: 'field' }, h('label', { for: 'd-body' }, S.conflict ? t.yourVersion : t.fieldBody), h('textarea', { id: 'd-body', class: 'input', rows: 10, required: true, value: d.content, oninput: bind('content'), ...bad('d-body') }), err('d-body'),
          h('p', { id: 'too-long', class: 'error', hidden: !tooLong || undefined }, t.tooLong)),
    h('div', { class: 'field' }, h('label', { for: 'd-tags' }, t.fieldTags), h('input', { id: 'd-tags', class: 'input', value: d.tags, oninput: bind('tags') }), h('p', { class: 'muted' }, t.tagsHint)),
    d.mode === 'text' ? h('details', {}, h('summary', {}, t.source), h('div', { class: 'field' }, h('label', { for: 'd-source' }, t.fieldSource), h('input', { id: 'd-source', class: 'input', value: d.source, oninput: bind('source') }))) : null,
    S.conflict
      ? h('div', { class: 'row' }, btn(t.viewLatest, viewLatest), h('span', { class: 'sp' }), btn(t.copyMine, copyMine), btn(t.overwrite, submit, 'primary', !!S.pending || !S.latestLoaded))
      : h('div', { class: 'row' }, h('span', { class: 'who' }, t.editing(d.revision)), h('span', { class: 'sp' }),
          btn(t.cancel, () => { S.draft = null; S.notice = null; render(); }, 'quiet', !!S.pending),
          btn(t.save, submit, 'primary', !!S.pending)));
}

function grantsView() {
  const t = S.t, d = S.detail, managers = new Set(d.host_managers ?? []);
  const rows = [...new Set([...(d.host_managers ?? []), ...(d.bound_soots ?? [])])];
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, t.grantsIntro), h('p', { class: 'who' }, t.readers(readerIds(d).map(name))),
    h('div', { class: 'card tbl' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t.grantSoot), h('th', {}, t.grantLevel), h('th', {}))),
      h('tbody', {}, rows.map(id => h('tr', {}, h('td', {}, h('b', {}, name(id))),
        h('td', {}, managers.has(id) ? t.hostManager : /** @type {any} */ (t.levels)[d.effective_permissions?.[id] ?? d.grants?.[id] ?? ''] ?? t.levels['']),
        h('td', { class: 'who' }, managers.has(id) ? '' : t.changeAt)))))));
}

function activityView() {
  const t = S.t;
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, t.activityIntro(S.overview?.limits?.activity_retention ?? 0)),
    !S.activity.length ? h('p', { class: 'muted' }, t.noActivity)
      : h('ul', { class: 'card list' }, S.activity.map(a => h('li', { class: 'edge' }, h('b', { class: 'grow' }, `${/** @type {any} */ (t.events)[a.action] || a.action} · ${/** @type {any} */ (t.statuses)[a.status] || a.status}`), h('span', { class: 'who' }, `${actorLabel(a.actor, name, t)} · ${date(a.at, true)}`)))),
    h('div', { class: 'row' }, btn(t.newest, later(() => loadActivity()), 'sm'), S.activityNext ? btn(t.older, later(() => loadActivity(S.activityNext)), 'sm') : null),
    S.oldest > 1 ? h('p', { class: 'muted' }, t.expired) : null);
}

function tabsView() {
  const t = S.t, tabs = /** @type {const} */ ([['documents', t.tabDocuments], ['grants', t.tabGrants], ['activity', t.tabActivity]]);
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': t.collection }, tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(S.tab === id), disabled: !!S.draft || !!S.pending || undefined,
    onclick: () => { S.tab = id; if (id === 'activity') void run(() => loadActivity()); else render(); } }, label)));
}

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const focus = document.activeElement?.id;
  const body = [];
  if (!S.started || (S.busy && !S.overview && !S.loadError)) body.push(h('div', { class: 'stack', 'aria-hidden': 'true' }, h('div', { class: 'skel w60' }), h('div', { class: 'skel w85' }), h('div', { class: 'skel w40' })), h('p', { class: 'sr-only', role: 'status' }, t.loading));
  else if (S.loadError) body.push(h('div', { class: S.loadError === t.busy ? 'status wait' : 'notice', role: 'alert' }, S.loadError + ' ', btn(t.retry, later(load), 'sm')));
  else {
    body.push(headerView(), ...noticeView());
    if (S.creating) body.push(createView());
    if (!S.pools.length && !S.creating) body.push(h('div', { class: 'empty' }, h('b', {}, t.noCollections), h('p', { class: 'muted' }, t.noCollectionsHint)));
    if (S.detail) {
      body.push(h('div', { class: 'row' }, h('h2', { class: 'grow' }, S.detail.pool.name)), tabsView());
      if (S.tab === 'grants') body.push(grantsView());
      else if (S.tab === 'activity') body.push(activityView());
      else body.push(S.draft ? editorView() : S.selected ? docView() : listView());
    }
    if (S.busy) body.push(h('p', { class: 'sr-only', role: 'status' }, t.working));
  }
  root.replaceChildren(h('header', { class: 'head' }, h('h1', {}, t.title), h('p', { class: 'muted' }, t.intro)), ...body.flat(4).filter(Boolean));
  if (focus) document.getElementById(focus)?.focus();
}

function start() {
  if (S.started) return;
  S.started = true;
  const saved = M.recall(storage);
  if (saved) S.pending = { ...saved, recovered: true, state: 'unknown' };
  void run(load);
}

// A page opened outside a host (or a host that never sends init) still starts, in Vietnamese.
window.addEventListener('beforeunload', e => { if (S.draft || S.pending?.body) e.preventDefault(); });
render();
bridge.ready();
setTimeout(start, 1500);

})();
})();
