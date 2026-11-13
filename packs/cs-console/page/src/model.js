// @ts-check
// Khách hàng page: the bodies console_view / console_action accept, the
// answers they give, and the words a person reads. Pure, so the tests prove
// the page and the tools agree without a browser.

/** @typedef {'need' | 'human' | 'soot' | 'done'} Status */
/** @typedef {{ key: string, name: string, status: Status, channels: string[], levels: string[], latest: string, conversations: number, tags: string[] }} Row */
/** @typedef {{ at: string, conversation: string, channel: string, role: 'c' | 's' | 'm', author: string, text: string, internal: boolean }} Entry */
/** @typedef {{ customer: { key: string, name: string, status: Status, channels: string[], levels: string[], principals: string[] },
 *   control: { conversation: string, owner: string, state: string, revision: number, can_control: boolean },
 *   timeline: Entry[], timeline_truncated?: boolean, notes_truncated?: boolean, memory: { id: string, content: string }[], facts: { label: string, value: string }[], facts_state: string,
 *   notes: { id: string, body: string, author: string, at: string }[], tags: { id: string, tag: string }[], links: { id: string, alias: string, proof: string }[] }} Detail */

// ---- bodies: exactly the tools' parameters ----
export const listBody = (q = '', cursor = '') => ({ kind: 'customers', ...(q.trim() ? { q: q.trim().slice(0, 100) } : {}), ...(cursor ? { cursor } : {}) });

const RANK = { need: 0, human: 1, soot: 2, done: 3 };
const union = (/** @type {string[]} */ a, /** @type {string[]} */ b) => [...new Set([...a, ...b])].sort();
/**
 * The next page of people joins the rows already shown: a person whose
 * conversations span two pages is one row with both counted.
 * @param {Row[]} have @param {Row[]} more @returns {Row[]}
 */
export function mergeRows(have, more) {
  const byKey = new Map(have.map(r => [r.key, r]));
  for (const r of more) {
    const o = byKey.get(r.key);
    byKey.set(r.key, !o ? r : { ...o, status: RANK[r.status] < RANK[o.status] ? r.status : o.status, channels: union(o.channels, r.channels), levels: union(o.levels, r.levels),
      latest: String(r.latest) > String(o.latest) ? r.latest : o.latest, conversations: o.conversations + r.conversations, tags: union(o.tags, r.tags) });
  }
  return [...byKey.values()].sort((a, b) => RANK[a.status] - RANK[b.status] || String(b.latest).localeCompare(String(a.latest)));
}
export const detailBody = (/** @type {string} */ key) => ({ kind: 'customer', key });

/**
 * One write. The request id is the person's intent: kept until a terminal
 * answer, resent with the same body. It also rides in the body because the
 * control route needs it as its own idempotency id.
 * @param {string} requestID @param {Record<string, unknown>} body
 */
export const actionBody = (requestID, body) => ({ ...body, request_id: requestID });
export const controlBody = (/** @type {Detail['control']} */ c) => ({ kind: 'control', conversation: c.conversation, action: c.owner === 'human' || c.state === 'waiting_human' || c.state === 'blocked' ? 'resume' : 'takeover', expected_revision: c.revision });
export const tagBody = (/** @type {string} */ key, /** @type {string} */ tag, remove = false) => ({ kind: 'tag', key, tag: tag.trim(), ...(remove ? { remove: true } : {}) });
export const noteBody = (/** @type {string} */ key, /** @type {string} */ body) => ({ kind: 'note', key, body: body.trim() });
export const linkBody = (/** @type {string} */ proof) => ({ kind: 'link', proof: proof.trim() });

// ---- answers ----
/** A view answer's output, or a thrown {code}. @param {any} r */
export function viewOutput(r) {
  if (!r?.ok) throw Object.assign(new Error('view failed'), { code: r?.error?.code ?? 'failed' });
  if (r.output?.error) throw Object.assign(new Error('refused'), { code: r.output.error.code, message: r.output.error.message });
  return r.output;
}

const UNKNOWN = ['no_response', 'request_in_flight', 'timeout', 'result_unknown', 'unavailable'];
/** @param {any} r @returns {{ state: 'done' | 'unknown' | 'busy' | 'rejected', code?: string, message?: string, output?: any, replayed?: boolean }} */
export function classify(r) {
  if (r?.ok) {
    if (r.output?.error) return { state: 'rejected', code: r.output.error.code, message: r.output.error.message };
    return { state: 'done', output: r.output, replayed: r.replayed === true };
  }
  const code = r?.error?.code ?? 'failed';
  if (code === 'busy') return { state: 'busy', code };
  if (UNKNOWN.includes(code) || /^http_5/.test(code)) return { state: 'unknown', code };
  return { state: 'rejected', code, message: r?.error?.message };
}

export function strings(/** @type {string} */ locale) {
  const vi = {
    title: 'Khách hàng', purpose: 'Mỗi người một dòng thời gian qua mọi kênh của đội. Chỉ thấy các cuộc trò chuyện trong quyền của Soot này.',
    loading: 'Đang tải…', none: 'Chưa có khách đã xác thực trong các cuộc trò chuyện của đội.', search: 'Tìm khách', reload: 'Tải lại',
    status: { need: 'Cần người', human: 'Người đang trả lời', soot: 'Soot đang trả lời', done: 'Đã xong' },
    verified: 'Đã xác thực', paired: 'Đã ghép cặp', takeover: 'Tiếp quản', resume: 'Trả lại Soot', sootHolds: 'Soot đang giữ', youHold: 'Người đang giữ',
    facts: 'Dữ liệu sản phẩm', factsNote: 'Tra trực tiếp từ sản phẩm lúc mở — không lưu trong trang.', factsOff: 'Chưa nối dữ liệu sản phẩm.', factsDown: 'Không tra được dữ liệu sản phẩm lúc này.',
    memory: 'Soot nhớ về người này', noMemory: 'Chưa có gì.', timeline: 'Dòng thời gian', internal: 'Riêng tư',
    tags: 'Nhãn', addTag: 'Thêm nhãn', notes: 'Ghi chú của đội', addNote: 'Lưu ghi chú', delete: 'Xoá',
    links: 'Danh tính đã liên kết', linkHelp: 'Dán bằng chứng liên kết do sản phẩm ký (ví dụ khi người dùng xác nhận Telegram trong ứng dụng). Không liên kết theo tên hay email.', link: 'Liên kết', unlink: 'Gỡ liên kết', noLinkKeys: 'Chưa cấu hình khoá sản phẩm để xác minh liên kết.',
    unknown: 'Chưa biết kết quả. Bấm Thử lại — cùng yêu cầu sẽ không chạy hai lần.', retry: 'Thử lại', busy: 'Máy chủ đang bận, thử lại sau ít phút.', done: 'Đã lưu.', replayed: 'Yêu cầu này đã chạy trước đó.',
    loadMore: 'Tải thêm khách', listTruncated: 'Mới hiện một phần danh sách. Bấm “Tải thêm khách” để xem tiếp; tìm kiếm chỉ lọc phần đã tải.',
    timelineTruncated: 'Dòng thời gian chưa đầy đủ: chỉ hiện các tin gần nhất của những cuộc trò chuyện mới nhất.', notesTruncated: 'Còn ghi chú cũ hơn chưa hiển thị.',
    loadFailed: 'Không tải được danh sách khách. Bấm Tải lại để thử lần nữa.', back: 'Danh sách',
    waitingSetup: 'Danh sách khách hiện ở đây khi mục còn thiếu đã được điền.',
    errors: /** @type {Record<string, string>} */ ({
      not_configured: 'Chưa nối bảng khách hàng. Điền “Kết nối bảng khách hàng” ở Cài đặt › Thiết lập, rồi bấm Tải lại.', not_found: 'Không còn thấy người hoặc cuộc trò chuyện này trong quyền của Soot.',
      too_large: 'Có quá nhiều dữ liệu để đọc một lần. Thu hẹp quyền của khoá hoặc gỡ bớt liên kết.',
      conflict: 'Cuộc trò chuyện vừa đổi. Tải lại rồi thử lại.', invalid_proof: 'Bằng chứng không hợp lệ.', proof_expired: 'Bằng chứng đã hết hạn — xin sản phẩm cấp lại.',
      proof_replayed: 'Bằng chứng này đã được dùng.', link_conflict: 'Người gửi này đã liên kết với người khác.', invalid_request: 'Dữ liệu chưa hợp lệ.', host_unavailable: 'Không kết nối được Soot.',
    }),
  };
  const en = {
    ...vi, title: 'Customers', purpose: 'One timeline per person across the team’s channels, within this Soot’s grants only.', loading: 'Loading…', none: 'No verified people in the team’s conversations yet.',
    search: 'Search', reload: 'Reload', status: { need: 'Needs a person', human: 'A person is replying', soot: 'Soot is replying', done: 'Done' }, verified: 'Verified', paired: 'Paired',
    takeover: 'Take over', resume: 'Hand back to Soot', sootHolds: 'Soot holds it', youHold: 'A person holds it', facts: 'Product facts', factsNote: 'Read live from the product — not stored here.',
    factsOff: 'No product facts source is configured.', factsDown: 'Product facts are unavailable right now.', memory: 'What Soot remembers', noMemory: 'Nothing yet.', timeline: 'Timeline',
    internal: 'Private', tags: 'Tags', addTag: 'Add tag', notes: 'Team notes', addNote: 'Save note', delete: 'Delete', links: 'Linked identities',
    linkHelp: 'Paste a product-signed link proof. Never link by name or email.', link: 'Link', unlink: 'Unlink', noLinkKeys: 'No product key is configured for links.',
    unknown: 'Outcome unknown. Retry — the same request never runs twice.', retry: 'Retry', busy: 'The host is busy; try again shortly.', done: 'Saved.', replayed: 'This request already ran.',
    loadMore: 'Load more people', listTruncated: 'Only part of the list is shown. Press “Load more people” to continue; search only filters what is loaded.',
    timelineTruncated: 'The timeline is incomplete: only the latest messages of the newest conversations are shown.', notesTruncated: 'Older notes are not shown.',
    loadFailed: 'Could not load the customers. Press Reload to try again.', back: 'List', waitingSetup: 'The customers show here once the missing setting is filled in.',
    errors: { ...vi.errors, not_configured: 'The customer console is not connected. Fill in “Kết nối bảng khách hàng” in Settings › Setup, then press Reload.' },
  };
  return locale === 'en' ? en : vi;
}

/** Nest says a missing key itself, with the way to Thiết lập (bridge `credential_missing`): the page adds no second message. */
export const SAID_BY_NEST = 'credential_missing';

export const errorText = (/** @type {ReturnType<typeof strings>} */ t, /** @type {string | undefined} */ code, /** @type {string | undefined} */ message) =>
  (code && t.errors[code]) || message || t.loadFailed;

/** "HH:MM" or "DD/MM HH:MM" for an ISO time. */
export function when(/** @type {string} */ iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}
