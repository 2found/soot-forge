// @ts-check
// Khách hàng page: the bodies console_view / console_action accept, the
// answers they give, and the words a person reads. Pure, so the tests prove
// the page and the tools agree without a browser.

/** @typedef {'need' | 'human' | 'soot' | 'done'} Status */
/** @typedef {{ key: string, name: string, status: Status, channels: string[], levels: string[], latest: string, conversations: number, tags: string[] }} Row */
/** @typedef {{ at: string, conversation: string, channel: string, role: 'c' | 's' | 'm', author: string, text: string, internal: boolean }} Entry */
/** @typedef {{ customer: { key: string, name: string, status: Status, channels: string[], levels: string[], principals: string[] },
 *   control: { conversation: string, owner: string, state: string, revision: number, can_control: boolean },
 *   timeline: Entry[], memory: { id: string, content: string }[], facts: { label: string, value: string }[], facts_state: string,
 *   notes: { id: string, body: string, author: string, at: string }[], tags: { id: string, tag: string }[], links: { id: string, alias: string, proof: string }[] }} Detail */

// ---- bodies: exactly the tools' parameters ----
export const listBody = (q = '') => ({ kind: 'customers', ...(q.trim() ? { q: q.trim().slice(0, 100) } : {}) });
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
    loadFailed: 'Không tải được. Kiểm tra kết nối bảng khách hàng.', back: 'Danh sách',
    errors: /** @type {Record<string, string>} */ ({
      not_configured: 'Gói chưa được cấu hình (CS_CONSOLE). Xem README của gói.', not_found: 'Không còn thấy người hoặc cuộc trò chuyện này trong quyền của Soot.',
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
    loadFailed: 'Could not load. Check the console connection.', back: 'List',
  };
  return locale === 'en' ? en : vi;
}

export const errorText = (/** @type {ReturnType<typeof strings>} */ t, /** @type {string | undefined} */ code, /** @type {string | undefined} */ message) =>
  (code && t.errors[code]) || message || t.loadFailed;

/** "HH:MM" or "DD/MM HH:MM" for an ISO time. */
export function when(/** @type {string} */ iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}
