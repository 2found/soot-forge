// Built from src/ by tests/build.mjs; do not edit.
'use strict';
(() => {
// ---- src/bridge.js ----
const __bridge = (() => {
// soot-pages bridge v2, frame side. The page never fetches: every read and
// write is a `call` posted to Nest (or the runtime's standalone shell), which
// runs this pack's view/action tool and posts back one `result`. Messages that
// are not exactly bridge v2 are ignored, as Nest does on its side. Nest's
// chosen project ({id, name, teams} or null) arrives in `init` and again in
// `context` when it changes; the standalone shell has none (null). A host may
// also send `projects` (the projects the viewer can see); this page does not
// use the list, but a message that carries it is still the same message.

/** @typedef {{ request_id: string, status: string, at: string, replayed?: true }} Receipt */
/** @typedef {{ ok: true, output: any, receipt?: Receipt, replayed?: true } | { ok: false, error: { code: string, message: string } }} CallResult */
/** @typedef {{ id: string, name: string, teams: string[] }} Project */
/** @typedef {{ theme: 'light' | 'dark', locale: 'vi' | 'en', tokens: Record<string, string>, viewer: { kind: 'operator' | 'member' }, project: Project | null, projects?: Project[] }} Init */

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
  Object.entries(t).every(([k, v]) => /^--[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 512);
/** A project as bridge v2 carries it, or null (every project, or the standalone shell). @param {any} p */
const isProject = p => p === null || (exactKeys(p, ['id', 'name', 'teams']) && typeof p.id === 'string' && p.id.length >= 1 && p.id.length <= 64 &&
  typeof p.name === 'string' && p.name.length <= 128 && Array.isArray(p.teams) && p.teams.length <= 64 && p.teams.every((/** @type {unknown} */ t) => typeof t === 'string' && t.length <= 64));
/** The optional `projects` list: absent, or at most 64 projects (never null entries). @param {any} l */
const isProjects = l => l === undefined || (Array.isArray(l) && l.length <= 64 && l.every(p => p !== null && isProject(p)));

/** Parse a Nest → frame message; anything else is null and dropped. @param {unknown} m */
function parseNestMessage(m) {
  if (!m || typeof m !== 'object' || /** @type {any} */ (m).v !== 2) return null;
  const msg = /** @type {any} */ (m);
  switch (msg.type) {
    case 'init':
      if (!exactKeys(msg, ['v', 'type', 'theme', 'locale', 'tokens', 'viewer', 'project', 'projects'], ['v', 'type', 'theme', 'locale', 'tokens', 'viewer', 'project']) || !['light', 'dark'].includes(msg.theme) || !['vi', 'en'].includes(msg.locale) || !isTokens(msg.tokens) ||
        !exactKeys(msg.viewer, ['kind']) || !['operator', 'member'].includes(msg.viewer.kind) || !isProject(msg.project) || !isProjects(msg.projects)) return null;
      return msg;
    case 'context':
      if (!exactKeys(msg, ['v', 'type', 'project', 'projects'], ['v', 'type', 'project']) || !isProject(msg.project) || !isProjects(msg.projects)) return null;
      return msg;
    case 'theme':
      if (!exactKeys(msg, ['v', 'type', 'theme', 'tokens']) || !['light', 'dark'].includes(msg.theme) || !isTokens(msg.tokens)) return null;
      return msg;
    case 'result':
      if (typeof msg.id !== 'string' || !BRIDGE_ID.test(msg.id)) return null;
      if (msg.ok === true && exactKeys(msg, ['v', 'type', 'id', 'ok', 'output', 'receipt', 'replayed'], ['v', 'type', 'id', 'ok', 'output']) && (msg.replayed === undefined || msg.replayed === true)) return msg;
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
 *   parent?: unknown, timeoutMs?: number, onInit?: (init: Init) => void, onTheme?: (msg: any) => void, onContext?: (project: Project | null) => void }} io
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
    else if (msg.type === 'context') io.onContext?.(msg.project);
    else {
      const entry = waiting.get(msg.id);
      if (!entry) return;
      waiting.delete(msg.id); clearTimeout(entry.timer);
      entry.resolve(msg.ok ? { ok: true, output: msg.output, ...(msg.receipt ? { receipt: msg.receipt } : {}), ...(msg.replayed === true ? { replayed: true } : {}) } : { ok: false, error: msg.error });
    }
  });
  return {
    ready() { io.post({ v: 2, type: 'ready' }); },
    /** Ask Nest to open an https:// or nest:// link; the frame never navigates itself. @param {string} link */
    open(link) { if (/^(https|nest):\/\//.test(link) && link.length <= 2048) io.post({ v: 2, type: 'open', link }); },
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
        io.post({ v: 2, type: 'call', id, mode, input, ...(requestID ? { request_id: requestID } : {}) });
      });
    },
    pending() { return waiting.size; },
  };
}
return { REQUEST_ID, randomID, parseNestMessage, applyTheme, createBridge };
})();

// ---- src/model.js ----
const __model = (() => {
// Pure page logic for Bài viết and Hàng đợi: strings, number and time text,
// and the bodies the page sends. No DOM here, so the tests import it directly.

/** @param {'vi' | 'en'} locale */
function strings(locale) {
  const vi = {
    posts: 'Bài viết', queue: 'Hàng đợi', reload: 'Tải lại', loading: 'Đang tải…', back: 'Tất cả bài',
    tabs: { all: 'Tất cả', need: 'Cần bạn', draft: 'Nháp', ready: 'Đã kiểm tra', waiting: 'Sắp đăng', published: 'Đã đăng', refused: 'Bị từ chối' },
    noPosts: 'Chưa có bài nào', noPostsHelp: 'Writer lưu bản nháp vào đây.', askWrite: 'Nhờ viết bài',
    open: 'Mở', unpublish: 'Gỡ bài', pull: 'Gỡ khỏi hàng đợi', schedule: 'Xếp lịch', bodyHead: 'Nội dung bài', restore: 'Xếp lại', republish: 'Đăng lại', reschedule: 'Đổi giờ', why: 'Xem lý do', save: 'Lưu', cancel: 'Hủy',
    noData: 'Chưa có số liệu', noDataWhy: 'Chưa có số liệu — Google thường cần 2–3 ngày sau khi đăng.', notZero: 'Không phải 0: chưa đọc được.',
    relogin: 'Cần đăng nhập Google lại', reloginHelp: 'Quyền đọc Search Console đã bị thu hồi. Một mục đã ở Cần bạn.',
    impressions: 'Hiển thị', clicks: 'Lượt bấm', position: 'Vị trí', days28: '28 ngày', topQueries: 'Truy vấn đứng đầu',
    radarUses: 'Writer dùng các truy vấn vị trí 8–20 để chọn chủ đề kế tiếp.',
    editorCheck: 'Kiểm tra của Editor', noCheck: 'Editor chưa kiểm tra bản này.', stale: 'Kiểm tra cho bản cũ',
    refused: 'Không đăng', refusedBy: 'Editor', refusedNext: 'Writer đã được báo để sửa. Bài không vào hàng đợi cho tới khi Editor kiểm tra lại bản mới.',
    pausedAll: 'Đang dừng đăng mọi kênh', pausedHelp: 'Soot vẫn viết và kiểm tra; không gì được đăng hay trả lời cho tới khi bạn bật lại.',
    pauseAll: 'Đăng mọi kênh', switchHint: 'Bật là đang đăng · tắt là dừng', afterResume: 'sẽ đăng ở khung giờ trống đầu tiên sau khi bật lại',
    caps: 'Giới hạn kênh', capsHead: ['Kênh', 'Bài/ngày', 'Cách nhau', 'Trả lời/ngày'],
    today: 'Hôm nay', replies: 'trả lời', replyTo: 'Trả lời', pausedAs: (/** @type {string} */ why) => `đang dừng: ${why}`,
    posted: 'Đã lên', postedUrl: 'Liên kết bài đã lên', notPosted: 'Chưa lên — đăng lại', drop: 'Bỏ', postNow: 'Đăng ngay', tryNow: 'Thử ngay',
    notYet: 'Chưa đăng', retryAt: (/** @type {string} */ at) => `Sẽ thử lại lúc ${at}.`,
    emptyQueue: 'Không có gì chờ đăng', emptyHelp: 'Editor xếp bài vào đây sau khi kiểm tra.', recent: 'Vừa xong', hasLink: 'có liên kết', recorded: 'Đã đăng sau kiểm tra · ghi kết quả "Bài đã đăng"', removedDone: 'Đã gỡ',
    inFlight: 'Đang đăng', waitSignIn: 'Chờ đăng nhập', unpublishingLabel: 'Đang gỡ', keep: 'Giữ lại',
    unpublishAsk: (/** @type {string} */ ch) => `Gỡ bài trên ${ch}?`, unpublishYes: (/** @type {string} */ ch) => `Gỡ bài trên ${ch}`,
    unpublishHelp: (/** @type {string} */ title) => `Bài và lượt thích, trả lời của nó sẽ mất trên ${title.replace(/^Gỡ bài trên |\?$/g, '')}. Bài vẫn còn trong Bài viết để đăng lại.`,
    perDay: (/** @type {number} */ n, /** @type {number} */ h) => `${n} bài/ngày, cách nhau ít nhất ${h} giờ`, quiet: (/** @type {string} */ f, /** @type {string} */ t) => `giờ yên ${f}–${t}`,
    unknown: 'Chưa rõ kết quả — tải lại để xem bài đã đổi chưa.', done: 'Đã lưu.', reread: 'Đã đọc lại số.', failed: 'Không làm được: ',
    watch: 'Xem video', pullQueue: 'Kéo khỏi hàng đợi', hooks: 'Câu mở đầu', keepWatching: 'Muốn xem tiếp', chosen: 'chọn',
    videoNote: 'Không có gì chờ bạn xem: video tự đăng đúng giờ sau kiểm tra. Bạn có thể xem và kéo ra bất cứ lúc nào.',
    panel: (/** @type {number | null} */ n) => `Micro Fish${n ? `, ${n} người đọc mô phỏng` : ''}`,
    videoLine: (/** @type {number | null} */ s, /** @type {boolean} */ captions) => `Video${s ? ` ${Math.round(s)} giây` : ''}${captions ? ' · phụ đề tiếng Việt' : ''}`,
    fromPost: (/** @type {string} */ t) => `Từ bài "${t}"`, stillDraft: 'Vẫn là nháp',
  };
  if (locale !== 'en') return vi;
  return { ...vi, posts: 'Posts', queue: 'Queue', reload: 'Reload', loading: 'Loading…', back: 'All posts',
    tabs: { all: 'All', need: 'Needs you', draft: 'Drafts', ready: 'Checked', waiting: 'Scheduled', published: 'Published', refused: 'Refused' },
    noData: 'No data yet', noDataWhy: 'No data yet — Google usually needs 2–3 days after publishing.', notZero: 'Not 0: not read yet.',
    impressions: 'Impressions', clicks: 'Clicks', position: 'Position', emptyQueue: 'Nothing waiting to publish', unpublish: 'Unpublish', pull: 'Remove from queue', open: 'Open' };
}

const nf = new Intl.NumberFormat('vi-VN');
/** A count; null is "no data", never 0. @param {number | null | undefined} n */
const num = n => (n == null ? null : nf.format(n));
/** @param {number | null | undefined} p */
const pos = p => (p == null ? null : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(p));

const WEEKDAY = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
/** @param {string | null | undefined} at @param {number} [now] */
function when(at, now = Date.now()) {
  if (!at) return '';
  const d = new Date(at), today = new Date(now);
  const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const day = (/** @type {Date} */ x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  if (day(d) === day(today)) return `Hôm nay ${hm}`;
  if (day(d) === day(new Date(now + 86_400_000))) return `Mai ${hm}`;
  if (day(d) === day(new Date(now - 86_400_000))) return `Hôm qua ${hm}`;
  if (d.getTime() > now && d.getTime() - now < 6 * 86_400_000) return `${WEEKDAY[Number(new Date(day(d) + 'T00:00:00Z').getUTCDay())]} ${hm}`;
  return `${d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })} ${hm}`;
}

const TZ = 'Asia/Ho_Chi_Minh';
/** @param {string} at */
const hm = at => new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
/** @param {string} url */
const shortUrl = url => { const s = url.replace(/^https:\/\/(www\.)?/, ''); return s.length > 48 ? `${s.slice(0, 47)}…` : s; };
/** @param {number} min */
const spacing = min => (min >= 60 ? `${Math.round(min / 60)} giờ` : `${min} phút`);
/** nest://new for the writer Soot, with a draft request. @param {string} soot @param {string | null} product */
const writeLink = (soot, product) => `nest://new?soot=${encodeURIComponent(soot)}&text=${encodeURIComponent(`Viết một bài mới cho ${product ? `blog ${product}` : 'blog'}.`)}`;
/** The guard rule a refused post failed, as its badge. @param {string} rule */
const ruleLabel = rule => ({ facts: 'Giá', personal_data: 'Dữ liệu cá nhân', platform: 'Kênh', duplicate: 'Trùng', tone: 'Giọng văn' })[rule] ?? 'Kiểm tra';
/** A datetime-local value in Asia/Ho_Chi_Minh (UTC+7, no DST) and back. @param {string} at */
const localInput = at => new Date(Date.parse(at) + 7 * 3_600_000).toISOString().slice(0, 16);
/** @param {string} v */
const fromLocalInput = v => new Date(Date.parse(`${v}:00Z`) - 7 * 3_600_000).toISOString();
/** The line under a post in Bài viết. @param {any} p @param {ReturnType<typeof strings>} t */
function postLine(p, t) {
  if (p.unpublishing) return 'Đang gỡ… Editor sẽ xóa bài trong vài phút (lần đăng theo lịch tới).';
  if (p.state === 'published') return `${p.channel} · đăng ${day(p.updated_at)} · ${metricLine(p.metrics_28, t)}`;
  if (p.state === 'removed') return `${p.channel} · đã gỡ lúc ${hm(p.updated_at)}${p.channel === 'Blog' ? ' · trang trả về trang chủ blog' : ''}`;
  if (p.state === 'scheduled') return `${p.channel} · Editor đã duyệt · đăng ${when(p.scheduled_at).toLowerCase()}${p.wait_reason ? ` · ${p.wait_reason}` : ''}`;
  if (p.state === 'checking') return `${p.channel} · Editor đang kiểm tra`;
  if (p.state === 'draft') return `${p.channel} · nháp của Writer`;
  return `${p.channel} · ${p.label}`;
}
/** @param {string} at */
const day = at => new Date(at).toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: TZ });

/** The metric line under a published post, or the no-data text. @param {any} m @param {ReturnType<typeof strings>} t */
function metricLine(m, t) {
  if (!m) return t.noData;
  return `${num(m.impressions)} lượt hiển thị · ${num(m.clicks)} lượt bấm${m.position != null ? ` · vị trí ${pos(m.position)}` : ''} (28 ngày)`;
}

/** Badge tone by state. @param {string} state */
const tone = state => ({ published: 'ok', refused: 'err', failed: 'err', uncertain: 'warn', publishing: 'warn', unpublishing: 'warn' })[state] ?? '';
/** Badge tone of a held video draft. @param {string} hold */
const holdTone = hold => (hold === 'render_failed' ? 'err' : 'warn');
/** The pretest rows, best first, as the page shows them. @param {any} pretest */
const hookRows = pretest => [...(pretest?.hooks ?? [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  .map(h => ({ text: h.text ? `"${h.text}"` : h.id, score: h.score == null ? '—' : `${h.score}%`, chosen: !!h.chosen }));

const viewBody = (/** @type {string} */ filter = 'all', /** @type {string} */ id = '', /** @type {string} */ campaign = '') => (campaign ? { campaign } : id ? { id } : { filter });
/** @param {string} request_id @param {string} op @param {Record<string, unknown>} [rest] */
const actionBody = (request_id, op, rest = {}) => ({ op, request_id, ...rest });

/** A failed bridge call or tool error as plain text. @param {ReturnType<typeof strings>} t @param {any} err */
function errorText(t, err) {
  if (err?.code === 'no_response') return t.unknown;
  if (err?.link) return err.message || t.failed;
  // The runtime's own refusal of a malformed request is English: say it in words and keep the way out.
  if (/does not match|operation parameters|tool_refused|\(refused\)/i.test(`${err?.message ?? ''} ${err?.code ?? ''}`)) return 'Trang gửi một yêu cầu không hợp lệ nên Soot từ chối. Bấm Thử lại; nếu vẫn vậy, nhờ Editor kiểm tra giúp.';
  return t.failed + (err?.message || err?.code || '');
}

/** Unwrap a bridge result: tool errors come back as {error} in the output. @param {any} r */
function output(r) {
  if (!r.ok) throw r.error;
  // A missing credential answers with its fix: a Vietnamese cause, the field's Vietnamese name, and the link that opens it.
  const o = r.output;
  if (o?.reason_code === 'needs_credential' || o?.needs_credential) {
    const key = o.key ?? o.needs_credential, why = String(o.error?.message ?? '').split(' Mở Thiết lập')[0];
    throw { code: 'needs_credential', message: `${why || 'Thiếu một khoá để làm việc này.'} Bấm Mở Thiết lập, điền "${KEY_LABEL[key] ?? 'khoá còn thiếu'}" rồi Thử lại.`, link: o.link ?? `${SETUP_LINK}?key=${encodeURIComponent(key)}`, credential: key };
  }
  if (o?.error) throw o.error;
  return r.output;
}

/** The notice after an action. A campaign re-read that failed shows its own notice on the page, not "Đã lưu.". */
function doneNotice(/** @type {any} */ t, /** @type {string} */ op, /** @type {any} */ out) {
  if (op === 'campaign_refresh') return out?.read?.ok ? { kind: 'success', text: t.reread } : null;
  const text = {
    post_now: 'Đã xếp đăng ngay. Soot đăng ở lần chạy tới (mỗi 10 phút, ngoài giờ yên 23:00–07:00); liên kết sẽ hiện ở đây.',
    restore: out?.scheduled_at ? `Đã xếp lịch: Soot đăng ${when(out.scheduled_at).toLowerCase()}.` : t.done,
    reschedule: out?.scheduled_at ? `Đã đổi giờ: Soot đăng ${when(out.scheduled_at).toLowerCase()}.` : t.done,
    pull: 'Đã gỡ khỏi hàng đợi. Soot sẽ không đăng bài này; bấm Xếp lại khi muốn đăng.',
    drop: 'Đã bỏ bài. Soot sẽ không đăng bài này.',
    unpublish: 'Đã xếp việc gỡ bài. Editor gỡ ở lần chạy tới, vài phút nữa.',
    set_limits: 'Đã lưu giới hạn. Áp dụng cho các bài xếp lịch từ giờ trở đi.',
    resume: 'Đã bật. Soot đăng theo giờ đã xếp.', pause: 'Đã dừng. Bài chờ ở hàng đợi, không đi cho tới khi bạn bật lại.',
    confirm_posted: 'Đã ghi bài đã lên, kèm liên kết.', confirm_not_posted: 'Đã xếp đăng lại: Soot đăng ở lần chạy tới.',
  }[op];
  return { kind: 'success', text: text ?? t.done };
}

// ---------- Chiến dịch ----------

const GOAL_FORM = { signups: 'người đăng ký mới', first_topups: 'người nạp lần đầu', clicks: 'lượt bấm', published: 'bài đã đăng' };
const GOAL_SHORT = { signups: 'người đăng ký', first_topups: 'người nạp lần đầu', clicks: 'lượt bấm', published: 'bài đã đăng' };
/** The campaign code the server makes from a name (also the utm_campaign). @param {string} name */
const slugOf = name => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
/** "2.000.000" or "2000000" → 2000000; empty → null. @param {string} s */
const digits = s => { const d = String(s ?? '').replace(/\D/g, ''); return d ? Number(d) : null; };
/** "1/12 – 31/12" in Asia/Ho_Chi_Minh. @param {string} starts @param {string} ends */
const dayRange = (starts, ends) => `${day(starts)} – ${day(ends)}`;
/** Progress toward the goal, 0–100; null when not read yet. @param {any} goal */
const goalPct = goal => (goal?.value == null || !goal.target ? null : Math.min(100, Math.round((goal.value / goal.target) * 100)));
/** "126 / 300 người đăng ký"; "— / 300 …" before the first read. @param {any} goal */
const goalLine = goal => `${goal?.value == null ? '—' : num(goal.value)} / ${num(goal?.target ?? 0)} ${GOAL_SHORT[goal?.metric] ?? ''}`.trim();

/** @param {any} [choices] */
const newCampaign = (choices = []) => ({ name: '', metric: 'signups', target: '', channels: choices.map((/** @type {any} */ c) => c.id), starts: '', ends: '', budget: '' });
/** What still stops "Tạo chiến dịch", as the footer hint; null when it can be sent. @param {any} f */
function campaignProblem(f) {
  if (!f.name.trim() || !f.starts || !f.ends) return 'Điền tên và ngày để tạo.';
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slugOf(f.name))) return 'Tên cần ít nhất 2 chữ hoặc số.';
  if (f.ends < f.starts) return 'Ngày kết thúc phải từ ngày bắt đầu trở đi.';
  if (!(digits(f.target) >= 1)) return 'Mục tiêu là một số lớn hơn 0.';
  if (!f.channels.length) return 'Chọn ít nhất một kênh.';
  return null;
}
/** The campaign_save body (page_action `campaign`). @param {any} f */
const campaignBody = f => ({ name: f.name.trim(), goal: { metric: f.metric, target: digits(f.target) ?? 0 }, channels: [...f.channels], starts: f.starts, ends: f.ends, token_budget: digits(f.budget) ?? 0 });
/** The api failure line: "api.lohi2.com không trả lời lúc 07:00. Số bài, …". @param {any} read */
const readFailLine = read => `${String(read?.error?.message ?? 'Không đọc được').replace(/\.$/, '')} lúc ${read?.at ? hm(read.at) : '—'}. Số bài, tiếp cận dưới đây là của Soot; đăng ký và lượt bấm sẽ cập nhật ở lần đọc tới.`;
/** "Token đã dùng: 820.000 / 2.000.000 (41%)." @param {number} used @param {number} budget */
const tokenLine = (used, budget) => (budget > 0 ? `Token đã dùng: ${num(used)} / ${num(budget)} (${Math.round((used / budget) * 100)}%).` : `Token đã dùng: ${num(used)} (chưa đặt ngân sách).`);

// ---------- the next step (every post and channel says what happens and when, or what the person does) ----------

/** nest:// link that opens the Soot's browser, where the person signs in. @param {string | null | undefined} editor */
const signInLink = (editor, channel) => {
  if (!editor) return 'nest://settings/setup';
  const site = String(channel ?? '').split('-')[0];
  const login = LOGIN_PAGE[site];
  // `label` names the site in the sign-in window's title ("Đăng nhập X cho Lohi").
  return `nest://browser/${encodeURIComponent(editor)}${login ? `?url=${encodeURIComponent(login)}&label=${encodeURIComponent(SITE_LABEL[site] ?? site)}` : ''}`;
};
const SITE_LABEL = { x: 'X', facebook: 'Facebook', reddit: 'Reddit' };
/** The page each platform signs in on, so the pane never opens blank. */
const LOGIN_PAGE = { x: 'https://x.com/i/flow/login', facebook: 'https://www.facebook.com/login', reddit: 'https://www.reddit.com/login' };
/** nest://new for the writer: revise this post. @param {string | null | undefined} writer @param {any} p */
const reviseLink = (writer, p) => (writer ? `nest://new?soot=${encodeURIComponent(writer)}&text=${encodeURIComponent(`Sửa bài "${p.title}" (mã ${p.id}): `)}` : null);
const SETUP_LINK = 'nest://settings/setup';
/** Vietnamese names for the keys a page action may ask for. */
const KEY_LABEL = { PRODUCT_ADMIN_KEY: 'Khoá quản trị Lohi' };

/** A failed publish's reason in words: the publisher's own code never reaches the person. @param {any} reason */
function failWhy(reason) {
  const r = String(reason ?? '').trim();
  if (!r) return '';
  if (/[à-ỹ]/i.test(r)) return r;
  if (/couldn't find remote ref|does not have any commits/i.test(r)) return 'kho git của blog chưa có nhánh main';
  if (/git_failed/.test(r)) return 'Soot chưa lấy được kho git của blog';
  if (/push_rejected/.test(r)) return 'kho blog vừa thay đổi nên chưa đẩy bài lên được';
  if (/build_failed/.test(r)) return 'blog không dựng được với bài này';
  if (/deploy_failed/.test(r)) return 'blog chưa lên bài sau khi đẩy lên kho';
  if (/slug_taken/.test(r)) return 'đã có bài dùng đúng đường dẫn này';
  if (/^claim_/.test(r)) return 'lượt đăng đã hết hạn';
  return 'lỗi kỹ thuật, Soot đã ghi lại';
}

/**
 * The line a post shows for its next step: {text, tone, button?}. `button` is {do, label}: the one thing
 * the person can do now, or none when Soot is running it ("Không cần làm gì").
 * @param {any} n the server's `next` @param {any} [p] the post row/detail
 */
function nextLine(n, p = {}) {
  if (!n) return null;
  const ch = n.channel ?? '', at = n.at ? when(n.at) : '';
  const lc = at ? at.charAt(0).toLowerCase() + at.slice(1) : '';
  const quiet = (/** @type {string} */ s) => s;
  const btn = (/** @type {string} */ d, /** @type {string} */ label) => ({ do: d, label });
  switch (n.code) {
    case 'draft': return { text: 'Writer đang soạn. Khi xong, Editor kiểm tra rồi xếp lịch. Không cần làm gì.', tone: 'plain' };
    case 'draft_stale': return { text: 'Bản nháp này nằm yên hơn 30 phút mà chưa được kiểm tra: Writer đã dừng giữa chừng. Bấm Nhờ Writer hoàn thiện, hoặc bỏ qua: nó không chặn bài mới.', tone: 'warn', button: btn('ask_writer', 'Nhờ Writer hoàn thiện') };
    case 'refused': return { text: 'Soot không đăng bài này vì chưa qua kiểm tra. Nhờ Writer sửa, Editor sẽ kiểm tra lại bản mới.', tone: 'err', button: btn('ask_writer', 'Nhờ Writer sửa') };
    case 'ready': return { text: 'Đã qua kiểm tra nhưng chưa có giờ đăng. Soot tự xếp lịch ở lượt lên bài 08:00; bấm Xếp lịch để xếp ngay.', tone: 'warn', button: btn('schedule', 'Xếp lịch') };
    case 'pulled': return { text: 'Bài đang để ngoài hàng đợi: Soot sẽ không đăng. Xếp lại nếu muốn đăng.', tone: 'plain', button: btn('restore', 'Xếp lại') };
    case 'removed': return { text: 'Bài đã gỡ khỏi kênh. Đăng lại nếu muốn.', tone: 'plain', button: btn('restore', 'Đăng lại') };
    case 'unpublishing': return { text: 'Đang gỡ bài. Editor xóa bài ở lần chạy tới, vài phút nữa. Không cần làm gì.', tone: 'plain' };
    case 'published': return { text: `Đã đăng ${lc}${p.url ? `: ${shortUrl(p.url)}` : '. Chưa có liên kết, Soot sẽ ghi khi nền tảng trả về.'}`, tone: 'ok', button: p.url ? btn('open', 'Mở bài') : undefined };
    case 'uncertain': return { text: `Soot bấm đăng nhưng chưa chắc bài đã lên ${ch}. Mở ${ch} xem: nếu đã lên, dán liên kết; nếu chưa, chọn đăng lại. Soot không tự đăng lại.`, tone: 'err', button: btn('confirm', 'Kiểm tra và chọn') };
    case 'in_flight': return { text: 'Đang đăng. Vài phút nữa sẽ có liên kết. Không cần làm gì.', tone: 'plain' };
    case 'failed_retry': return { text: `Lần đăng vừa rồi lỗi${n.reason ? ` (${failWhy(n.reason)})` : ''}. Soot tự thử lại ${lc}. Bấm Thử ngay nếu muốn sớm hơn.`, tone: 'warn', button: btn('retry', 'Thử ngay') };
    case 'failed': return { text: `Đăng lỗi${n.reason ? `: ${failWhy(n.reason)}` : ''}. Soot không tự thử nữa: bấm Thử ngay, hoặc gỡ bài khỏi hàng đợi.`, tone: 'err', button: btn('retry', 'Thử ngay') };
    case 'late': return { text: `Bài lỡ giờ (hẹn ${lc}). Soot không tự đăng bài đã quá hạn: chọn Đăng ngay, xếp lại giờ khác hoặc bỏ.`, tone: 'warn', button: btn('post_now', 'Đăng ngay') };
    case 'paused_all': return { text: `Bạn đang dừng đăng mọi kênh nên bài chưa đi. Bật lại để bài đăng ${lc || 'ở khung giờ trống đầu tiên'}.`, tone: 'warn', button: btn('resume_all', 'Bật lại mọi kênh') };
    case 'signed_out': return { text: `${ch} chưa đăng nhập nên bài chưa đi được. Đăng nhập ${ch}, rồi bài đăng ${lc}.`, tone: 'warn', button: btn('sign_in', `Đăng nhập ${ch}`) };
    case 'signed_in': return { text: `Đã đăng nhập ${ch} nhưng kênh còn dừng. Bật kênh để bài đăng ${lc}.`, tone: 'warn', button: btn('resume_channel', `Bật ${ch}`) };
    case 'person_paused': return { text: `Bạn đã dừng ${ch}. Bật lại để bài đăng ${lc}.`, tone: 'warn', button: btn('resume_channel', `Bật ${ch}`) };
    case 'channel_held': return { text: `${ch} đang dừng (${n.reason}). Xem thẻ Cần bạn của kênh này để xử lý; bài chờ ở đây.`, tone: 'warn' };
    case 'waiting': return { text: `Soot sẽ đăng ${lc}. Đang chờ: ${n.reason}. Không cần làm gì.`, tone: 'plain' };
    case 'scheduled': return { text: quiet(`Soot sẽ đăng ${lc} lên ${ch}. Không cần làm gì.`), tone: 'plain' };
  }
  return { text: '', tone: 'plain' };
}

/** The headline of Hàng đợi: what goes out next, or the one thing that blocks it. @param {any} d */
function queueHeadline(d) {
  const items = d.items ?? [];
  const late = items.filter((/** @type {any} */ q) => q.late), unsure = items.filter((/** @type {any} */ q) => q.state === 'uncertain');
  const out = (/** @type {string} */ tone, /** @type {string} */ text, button) => ({ tone, text, button });
  if (d.paused_all) return out('warn', `Đang dừng đăng mọi kênh. ${items.length ? `${items.length} bài chờ ở đây và sẽ không đi cho tới khi bạn bật lại.` : 'Soot vẫn viết và kiểm tra.'}`, { do: 'resume_all', label: 'Bật lại mọi kênh' });
  if (unsure.length) return out('err', `${unsure.length} bài chưa rõ đã lên chưa. Mở kênh xem rồi chọn Đã lên hoặc Chưa lên: Soot không tự đăng lại.`, null);
  if (late.length) return out('warn', `${late.length} bài lỡ giờ. Soot không tự đăng bài quá hạn: chọn Đăng ngay, Đổi giờ hoặc Bỏ cho từng bài.`, null);
  const out2 = (d.channels ?? []).find((/** @type {any} */ c) => c.paused_reason === 'signed_out' && c.waiting > 0);
  if (out2) return out('warn', `${out2.label} chưa đăng nhập nên ${out2.waiting} bài của kênh này chưa đi được. Đăng nhập ${out2.label} rồi Soot đăng tiếp.`, { do: 'sign_in', label: `Đăng nhập ${out2.label}`, channel: out2.id });
  // A channel the person paused holds its posts: they are not "next", the switch is.
  const heldCh = (/** @type {any} */ q) => (d.channels ?? []).find((/** @type {any} */ c) => c.id === q.channel_id && c.paused);
  const held = (d.channels ?? []).find((/** @type {any} */ c) => c.paused && c.paused_reason !== 'signed_out' && items.some((/** @type {any} */ q) => q.channel_id === c.id && q.action === 'publish'));
  const live = items.filter((/** @type {any} */ q) => q.action === 'publish' && !['failed'].includes(q.state) && !q.in_flight && q.scheduled_at && !heldCh(q)).sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  const failed = items.find((/** @type {any} */ q) => q.state === 'failed');
  if (failed) return out('warn', `Một bài đăng lỗi${failed.retry_at ? `, Soot thử lại ${when(failed.retry_at).toLowerCase()}` : '. Bấm Thử ngay hoặc gỡ khỏi hàng đợi'}.`, null);
  if (held && !live.length) return out('warn', `${held.label} đang dừng nên ${items.filter((/** @type {any} */ q) => q.channel_id === held.id && q.action === 'publish').length} bài chờ ở đây chưa đi. Bật ${held.label} để Soot đăng tiếp.`, { do: 'resume_channel', label: `Bật ${held.label}`, channel: held.id });
  // A signed-out channel with nothing queued yet still blocks it: "Không cần làm gì" would hide the login it waits for.
  const signedOut = (d.channels ?? []).filter((/** @type {any} */ c) => c.paused && c.paused_reason === 'signed_out');
  if (live.length && signedOut.length) return out('warn', `Bài kế tiếp: ${live[0].channel} ${when(live[0].scheduled_at).toLowerCase()}. ${signedOut.map((/** @type {any} */ c) => c.label).join(', ')} chưa đăng nhập nên Soot chưa đăng được lên ${signedOut.length > 1 ? 'các kênh này' : 'kênh này'}.`, { do: 'sign_in', label: `Đăng nhập ${signedOut[0].label}`, channel: signedOut[0].id });
  if (live.length) return out('plain', `Không cần làm gì, Soot đang tự chạy. Bài kế tiếp: ${live[0].channel} ${when(live[0].scheduled_at).toLowerCase()}.`, null);
  if (items.some((/** @type {any} */ q) => q.in_flight)) return out('plain', 'Đang đăng. Vài phút nữa sẽ có liên kết bên dưới. Không cần làm gì.', null);
  return out('plain', 'Hàng đợi trống. Soot lên bài mới mỗi sáng 08:00; hoặc bạn nhờ Writer viết ngay.', d.writer ? { do: 'ask_writer', label: 'Nhờ viết bài' } : null);
}

/** The state of one channel on Hàng đợi: its words and its button. @param {any} c @param {any} d */
function channelLine(c, d) {
  const used = `Hôm nay ${c.posts_today}/${c.cap_per_day} bài${c.reply_cap_per_day ? ` · trả lời ${c.replies_today}/${c.reply_cap_per_day}` : ''}`;
  if (d.paused_all) return { text: `Đang dừng (bạn dừng mọi kênh). ${used}`, tone: 'warn' };
  if (!c.paused) return { text: `Đang đăng. ${used}${c.waiting ? ` · ${c.waiting} bài chờ` : ''}`, tone: 'ok' };
  switch (c.paused_reason) {
    case 'signed_out': return { text: `Chưa đăng nhập ${c.label}${c.waiting ? `, ${c.waiting} bài đang chờ` : ''}. Đăng nhập xong Soot mới đăng.`, tone: 'warn', button: { do: 'sign_in', label: `Đăng nhập ${c.label}` } };
    case 'signed_in': return { text: `Đã đăng nhập ${c.label}, kênh còn dừng. Bật để Soot đăng.`, tone: 'warn', button: { do: 'resume_channel', label: `Bật ${c.label}` } };
    case 'person': return { text: `Bạn đã dừng ${c.label}. Bật lại khi muốn đăng.`, tone: 'plain', button: { do: 'resume_channel', label: `Bật ${c.label}` } };
    case 'captcha': return { text: `${c.label} đòi xác minh captcha. Mở trình duyệt, xác minh xong rồi bật lại.`, tone: 'warn', button: { do: 'sign_in', label: 'Mở trình duyệt' } };
    case 'layout_changed': return { text: `Giao diện ${c.label} đã đổi nên Soot không bấm đăng được. Soot đã báo ở Cần bạn.`, tone: 'warn' };
  }
  return { text: `${c.label} đang dừng.`, tone: 'plain' };
}

/** A tiny safe markdown reader: blocks of {t:'h'|'p'|'li', parts:[{text, href?, b?}]}. No HTML. @param {string} md */
function mdBlocks(md) {
  const inline = (/** @type {string} */ s) => {
    /** @type {{ text: string, href?: string, b?: boolean }[]} */ const out = [];
    const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
    let i = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > i) out.push({ text: s.slice(i, m.index) });
      out.push(m[1] ? { text: m[1], href: m[2] } : { text: m[3], b: true });
      i = m.index + m[0].length;
    }
    if (i < s.length) out.push({ text: s.slice(i) });
    return out;
  };
  /** @type {{ t: string, level?: number, parts: any[] }[]} */ const blocks = [];
  let para = [];
  const flush = () => { if (para.length) blocks.push({ t: 'p', parts: inline(para.join(' ')) }); para = []; };
  for (const line of String(md ?? '').split('\n')) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line), li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, parts: inline(h[2]) }); }
    else if (li) { flush(); blocks.push({ t: 'li', parts: inline(li[1]) }); }
    else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

/** The set_limits body for a channel row (only what changed), or a Vietnamese problem. @param {any} c @param {{cap: string, gap: string, rep: string}} f */
function limitsBody(c, f) {
  const cap = digits(f.cap), rep = digits(f.rep), gapH = Number(String(f.gap).replace(',', '.'));
  if (cap == null || cap > 50) return `${c.label}: số bài mỗi ngày là số từ 0 đến 50.`;
  if (!Number.isFinite(gapH) || gapH < 0 || gapH * 60 > 10080) return `${c.label}: khoảng cách giữa hai bài là số giờ từ 0 đến 168.`;
  if (rep == null || rep > 50) return `${c.label}: số trả lời mỗi ngày là số từ 0 đến 50.`;
  const gap = Math.round(gapH * 60);
  /** @type {Record<string, number>} */ const out = {};
  if (cap !== c.cap_per_day) out.cap_per_day = cap;
  if (gap !== c.spacing_min) out.spacing_min = gap;
  if (rep !== (c.reply_cap_per_day ?? 0)) out.reply_cap_per_day = rep;
  return out;
}
/** The confirmation line: what changes, from what, to what. @param {any} c @param {Record<string, number>} body */
function limitsAsk(c, body) {
  const parts = [];
  if (body.cap_per_day !== undefined) parts.push(`bài mỗi ngày ${c.cap_per_day} → ${body.cap_per_day}`);
  if (body.spacing_min !== undefined) parts.push(`khoảng cách ${spacing(c.spacing_min)} → ${spacing(body.spacing_min)}`);
  if (body.reply_cap_per_day !== undefined) parts.push(`trả lời mỗi ngày ${c.reply_cap_per_day ?? 0} → ${body.reply_cap_per_day}`);
  return `${c.label}: ${parts.join(', ')}. Bài đã xếp lịch giữ nguyên giờ; số mới áp dụng cho các bài xếp từ giờ trở đi.`;
}

/** nest://new for the writer: write posts for this campaign, using its links. @param {string} writer @param {any} c @param {{label: string, url: string}[]} links */
const campaignWriteLink = (writer, c, links) => `nest://new?soot=${encodeURIComponent(writer)}&text=${encodeURIComponent(`Viết bài cho chiến dịch "${c.name}" (mã ${c.id}). Dùng liên kết của từng kênh: ${links.map(l => `${l.label} ${l.url}`).join('; ')}.`)}`;

/** One line for a campaign row: what Soot does next, or what to look at. @param {{phase?: string, starts?: string}} c */
function campaignNextLine(c) {
  if (c.phase === 'planned') return `Soot bắt đầu theo dõi từ ${day(c.starts)}. Không cần làm gì.`;
  if (c.phase === 'running') return 'Soot đọc lại số mỗi sáng 07:00. Không cần làm gì.';
  if (c.phase === 'ended') return 'Chiến dịch đã kết thúc. Mở để xem kết quả.';
  return 'Mở để xem liên kết và kết quả.';
}
return { strings, num, pos, when, hm, shortUrl, spacing, writeLink, ruleLabel, localInput, fromLocalInput, postLine, metricLine, tone, holdTone, hookRows, viewBody, actionBody, errorText, output, doneNotice, GOAL_FORM, GOAL_SHORT, slugOf, digits, dayRange, goalPct, goalLine, newCampaign, campaignProblem, campaignBody, readFailLine, tokenLine, signInLink, LOGIN_PAGE, reviseLink, SETUP_LINK, failWhy, nextLine, queueHeadline, channelLine, mdBlocks, limitsBody, limitsAsk, campaignWriteLink, campaignNextLine };
})();

// ---- src/app.js ----
const __app = (() => {
// Bài viết, Hàng đợi and Chiến dịch (marketing pack, the project's Marketing tab) and the
// Kênh đăng bài settings piece. One bundle serves the four pieces (posts, queue, campaigns,
// channels): the view tool answers for the piece in its context. Plain DOM, no network:
// every read and write goes through the soot-pages bridge v2.
// Text is set with textContent only.
const { createBridge, applyTheme, randomID } = __bridge;
const M = __model;

const S = {
  t: M.strings('vi'), started: false, busy: false, filter: 'all', id: '',
  /** @type {any} */ data: null, loadError: '',
  /** @type {{ request_id: string, op: string, rest: object } | null} */ pending: null,
  /** @type {{ kind: 'info' | 'success', text: string, fix?: { label: string, link: string } } | null} */ notice: null,
  /** @type {{ label: string, link: string } | null} */ sheetFix: null,
  /** @type {{ title: string, yes: string, run: () => void, help?: string, keep?: string, keepRun?: () => void } | null} */ confirm: null,
  caps: false, editing: '', /** @type {Record<string, any>} */ limits: {},
  campaign: '', /** @type {any} */ sheet: null, sheetError: '',
};

const bridge = createBridge({
  post: m => window.parent.postMessage(m, '*'),
  listen: h => window.addEventListener('message', e => h(e.data, e.source)),
  parent: window.parent === window ? undefined : window.parent,
  onInit: init => { applyTheme(init); S.t = M.strings(init.locale); document.documentElement.lang = init.locale; start(); },
  onTheme: msg => applyTheme(msg),
});

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...any} kids */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return el;
}
const button = (/** @type {string} */ text, /** @type {() => void} */ fn, cls = 'btn sm ghost', more = {}) => h('button', { class: cls, type: 'button', disabled: S.busy, onclick: fn, ...more }, text);
const badge = (/** @type {string} */ text, /** @type {string} */ state) => h('span', { class: `badge ${M.tone(state)}` }, text);

async function load() {
  S.loadError = '';
  try { S.data = M.output(await bridge.call('view', M.viewBody(S.filter, S.id, S.campaign))); } catch (e) { S.loadError = M.errorText(S.t, e); }
}
async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } finally { S.busy = false; render(); }
}
/** A write keeps its request id until an answer comes, so a retry never acts twice. */
async function act(/** @type {string} */ op, rest = {}) {
  // A retry keeps its request id only while it is the same action on the same thing.
  S.pending = S.pending?.op === op && JSON.stringify(S.pending.rest) === JSON.stringify(rest) ? S.pending : { request_id: randomID('mk', 12), op, rest };
  const p = S.pending;
  await run(async () => {
    const r = await bridge.call('action', M.actionBody(p.request_id, p.op, p.rest), p.request_id);
    if (!r.ok && r.error.code === 'no_response') { S.notice = { kind: 'info', text: S.t.unknown }; return; }
    S.pending = null;
    try { S.notice = M.doneNotice(S.t, op, M.output(r)); } catch (e) { S.notice = { kind: 'info', text: M.errorText(S.t, e), ...(e?.link ? { fix: { label: 'Mở Thiết lập', link: e.link } } : {}) }; }
    await load();
  });
}

/** "Nhờ viết bài": Nest opens a new task for the writer Soot (nest://new). */
function askWriter(/** @type {any} */ d) {
  if (!d.writer) return null;
  return button(S.t.askWrite, () => bridge.open(M.writeLink(d.writer, d.product)), 'btn sm out');
}

/** The one button of a next step (do: schedule, post_now, sign_in, …). @param {any} b @param {any} d @param {any} p */
function doNext(b, d, p) {
  switch (b.do) {
    case 'schedule': case 'restore': return void act('restore', { id: p.id });
    case 'post_now': case 'retry': return void act('post_now', { id: p.id });
    case 'sign_in': return signIn(d, b.channel ?? p?.next?.channel_id, p?.next?.channel);
    case 'resume_channel': return void act('resume', { channel: b.channel ?? p.next.channel_id });
    case 'resume_all': return void act('resume');
    case 'ask_writer': { const link = p?.id ? M.reviseLink(d.writer, p) : null; return bridge.open(link ?? M.writeLink(d.writer, d.product)); }
    case 'open': return bridge.open(p.url);
    case 'confirm': S.id = p.id; return void run(load);
  }
}
/** Sign in on a platform: Nest opens the Soot's browser (nest://browser/<soot>); the person signs in there, then turns the channel on. */
function signIn(/** @type {any} */ d, /** @type {string} */ id, /** @type {string} */ _label) { bridge.open(M.signInLink(d.editor, id)); }
/** The next-step line of a post or item, and its one button. */
function nextBlock(/** @type {any} */ d, /** @type {any} */ p, /** @type {any} */ n = p.next, skip = '') {
  const line = M.nextLine(n, p);
  if (!line?.text) return { line: null, button: null };
  const b = line.button && line.button.do !== skip ? line.button : null;
  return { line, button: b ? button(b.label, () => doNext(b, d, p), 'btn sm primary') : null };
}

function postList(d) {
  const t = S.t;
  const tabs = h('div', { class: 'seg', role: 'tablist' }, ...Object.entries(t.tabs).map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; void run(load); } }, `${label} ${d.counts[k] ?? 0}`)));
  const top = h('div', { class: 'line wrap' }, tabs, askWriter(d));
  if (!d.items.length) return [top, h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, t.noPosts), h('span', {}, t.noPostsHelp))];
  return [top, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ p) => {
    const state = p.unpublishing ? 'unpublishing' : p.state;
    const { line, button: primary } = nextBlock(d, p);
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => { S.id = p.id; void run(load); } }, p.kind === 'video' ? `Video "${p.title}"` : p.title),
        h('small', { class: 'muted' }, `${p.channel}${p.kind === 'social' ? ' · bài mạng xã hội' : p.kind === 'reply' ? ' · trả lời' : ''}`),
        // A held video draft (#p4-video-failed): the reason, and it stays a draft.
        p.hold ? h('small', { class: p.hold === 'render_failed' ? 'errline' : 'muted' }, p.reason ?? t.stillDraft) :
        line && h('small', { class: line.tone === 'err' ? 'errline' : line.tone === 'warn' ? 'warnline soft' : 'muted' }, line.text),
        p.state === 'published' && !p.unpublishing && h('small', { class: 'muted' }, M.metricLine(p.metrics_28, t)),
        p.state === 'refused' && p.reason && h('small', { class: 'errline' }, `${t.refused}: ${p.reason.split(' · ')[0]}`)),
      p.hold ? h('span', { class: `badge ${M.holdTone(p.hold)}` }, p.hold_label) : badge(p.late ? 'Bài lỡ giờ' : p.unpublishing ? t.unpublishingLabel : p.label, p.late ? 'uncertain' : state),
      primary,
      p.state === 'refused' && button(t.why, () => { S.id = p.id; void run(load); }),
      p.state === 'published' && !p.unpublishing && button(t.unpublish, () => askUnpublish(p), 'btn sm danger'),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })));
  }))];
}

function metrics(sc) {
  const t = S.t;
  const relogin = sc?.state === 'needs_person';
  const card = h('div', { class: 'card pad stack' }, h('h3', {}, 'Search Console ', sc?.last_28 && h('small', { class: 'muted' }, `${t.days28}${sc.read_at && !relogin ? ` · đọc lúc ${M.when(sc.read_at)}` : ''}`)));
  if (!sc) return card;
  if (relogin) card.append(h('p', { class: 'warnline' }, t.relogin), h('p', { class: 'muted' }, t.reloginHelp));
  if (!sc.last_28) { if (!relogin) card.append(h('p', { class: 'muted' }, t.noDataWhy), h('p', { class: 'muted' }, t.notZero)); return card; }
  card.append(h('div', { class: 'kpis' }, ...[[t.impressions, M.num(sc.last_28.impressions)], [t.clicks, M.num(sc.last_28.clicks)], [t.position, M.pos(sc.last_28.position) ?? '—']]
    .map(([k, v]) => h('div', {}, h('small', { class: 'muted' }, k), h('div', { class: 'kpi' }, v)))));
  if (sc.queries.length) card.append(h('p', { class: 'muted' }, `${t.topQueries}: ${sc.queries.map((/** @type {any} */ q) => `"${q.query}" (vị trí ${M.pos(q.position)})`).join(', ')}`));
  card.append(h('p', { class: 'muted' }, t.radarUses));
  return card;
}

/** A refused post: every failed check on its own line, with its kind, and what happens next. */
function refusedCard(d) {
  const t = S.t, p = d.post;
  const failed = (d.check?.auto ?? []).filter((/** @type {any} */ a) => !a.ok);
  const lines = failed.length ? failed.map((/** @type {any} */ a) => [M.ruleLabel(a.rule), a.detail, a.source])
    : [[t.refusedBy, (d.check?.reasons ?? []).join('; ') || p.reason || '']];
  if (failed.length && d.check?.verdict === 'fail' && d.check.reasons?.length) lines.push([t.refusedBy, d.check.reasons.join('; ')]);
  return h('div', { class: 'card pad stack', role: 'alert' },
    h('div', { class: 'line' }, badge(p.label, p.state), h('b', {}, p.title)),
    h('ul', { class: 'list' }, ...lines.map(([k, v, note]) => h('li', { class: 'row tight' }, badge(k, 'refused'), h('div', { class: 'who' }, h('b', {}, v), note && h('small', { class: 'muted' }, note))))),
    h('p', { class: 'muted' }, t.refusedNext));
}

/** The post's words, read as markdown (headings, lists, bold, links); never HTML. */
function bodyView(/** @type {string} */ text) {
  const inline = (/** @type {any[]} */ parts) => parts.map(x => x.href ? h('button', { class: 'link inline', type: 'button', title: x.href, onclick: () => bridge.open(x.href) }, x.text) : x.b ? h('b', {}, x.text) : x.text);
  const out = [];
  let list = null;
  for (const b of M.mdBlocks(text.length > 6000 ? `${text.slice(0, 6000)}…` : text)) {
    if (b.t === 'li') { if (!list) { list = h('ul', { class: 'md' }); out.push(list); } list.append(h('li', {}, ...inline(b.parts))); continue; }
    list = null;
    out.push(b.t === 'h' ? h('h4', {}, ...inline(b.parts)) : h('p', {}, ...inline(b.parts)));
  }
  return h('div', { class: 'postbody' }, ...out);
}

function postDetail(d) {
  const t = S.t, p = d.post;
  const back = h('button', { class: 'btn sm ghost back', type: 'button', onclick: () => { S.id = ''; void run(load); } }, `← ${t.back}`);
  const { line, button: primary } = nextBlock(d, p, p.next, 'confirm');
  const nextCard = line && h('div', { class: `notice ${line.tone === 'err' ? 'err' : line.tone === 'warn' ? 'plain warn' : line.tone === 'ok' ? 'success' : 'plain'}`, role: 'status' },
    h('b', {}, p.state === 'published' ? 'Đã đăng' : 'Bước tiếp theo'), h('span', {}, line.text), primary);
  if (p.state === 'refused') return [back, nextCard, refusedCard(d)].filter(Boolean);
  const live = p.state === 'published' && p.url;
  const head = h('div', { class: 'line wrap' }, h('div', { class: 'line' }, badge(p.late ? 'Bài lỡ giờ' : p.label, p.late ? 'uncertain' : p.state), h('h2', {}, p.title)),
    h('div', { class: 'line' },
      ['ready', 'scheduled', 'failed'].includes(p.state) && p.next?.code !== 'late' && p.next?.code !== 'in_flight' && button(t.postNow, () => void act('post_now', { id: p.id })),
      d.writer && ['article', 'social'].includes(p.kind) && !['published', 'unpublishing'].includes(p.state) && button('Nhờ Writer sửa', () => bridge.open(/** @type {string} */ (M.reviseLink(d.writer, p)))),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })), p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger')));
  const left = h('div', { class: 'card pad stack' });
  if (p.reason && ['failed', 'uncertain'].includes(p.state)) left.append(h('p', { class: 'errline', role: 'alert' }, p.state === 'failed' ? M.failWhy(p.reason) : p.reason));
  if (p.state === 'uncertain') left.append(h('div', { class: 'line' }, ...uncertainActions(t, { id: p.id })));
  if (p.body) left.append(h('h3', {}, t.bodyHead), bodyView(p.body));
  if (d.brief.length) left.append(h('table', { class: 'table' }, h('tbody', {}, ...d.brief.map((/** @type {any} */ f) =>
    h('tr', {}, h('td', {}, f.label), h('td', {}, f.value), h('td', {}, f.ok ? badge(f.rule ?? 'hợp lệ', 'published') : badge(f.message, 'refused')))))));
  left.append(h('h3', {}, t.editorCheck));
  if (!d.check) left.append(h('p', { class: 'muted' }, t.noCheck));
  else {
    left.append(h('div', { class: 'flow' }, ...d.check.auto.map((/** @type {any} */ a) => h('span', { class: a.ok ? 'chip' : 'chip err' }, a.detail))));
    left.append(h('p', { class: 'muted' }, `Editor · ${M.when(d.check.at)} · bản ${d.check.revision}${d.check.current ? '' : ` · ${t.stale}`}`));
  }
  if (p.hold) left.prepend(h('div', { class: 'notice err', role: 'alert' }, h('b', {}, `${p.hold_label}:`), ' ', p.reason ?? t.stillDraft));
  if (d.video) {
    const v = d.video, hooks = M.hookRows(v.pretest);
    left.append(h('h3', {}, t.videoLine(v.duration_s ?? null, !!v.captions?.length)), h('div', { class: 'line top' },
      v.poster ? h('img', { class: 'poster', src: v.poster, alt: '' }) : null,
      h('div', { class: 'stack' }, ...hooks.map(r => h('span', {}, `${r.score} · ${r.text}${r.chosen ? ` (${t.chosen})` : ''}`)),
        v.open_link ? button(t.watch, () => bridge.open(v.open_link), 'btn sm') : null)));
  }
  // A published post shows its link first: where it lives is the answer the person came for.
  const link = live && h('div', { class: 'card pad stack' }, h('h3', {}, 'Liên kết bài đã đăng'),
    h('button', { class: 'link inline', type: 'button', title: p.url, onclick: () => bridge.open(p.url) }, p.url), h('small', { class: 'muted' }, `${p.channel} · đăng ${M.when(p.updated_at)}`));
  return [back, head, nextCard, link, h('div', { class: 'split' }, left, p.state === 'published' ? metrics(d.search_console) : null)].filter(Boolean);
}

/** One on/off switch: on means publishing ("Bật là đang đăng"). */
const toggle = (/** @type {string} */ label, /** @type {boolean} */ on, /** @type {() => void} */ fn) =>
  h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), disabled: S.busy, onclick: fn }, h('i', { 'aria-hidden': 'true' }), label);

function queue(d) {
  const t = S.t;
  const out = [];
  const head = M.queueHeadline(d);
  out.push(h('div', { class: `notice ${head.tone === 'err' ? 'err' : head.tone === 'warn' ? 'plain warn' : 'plain'}`, role: 'status' }, h('b', {}, head.tone === 'plain' ? 'Soot đang chạy' : 'Cần bạn'), h('span', {}, head.text),
    head.button && button(head.button.label, () => (head.button.do === 'ask_writer' ? bridge.open(M.writeLink(d.writer, d.product)) : doNext(head.button, d, {})), 'btn sm primary')));
  out.push(h('div', { class: 'card pad bar' },
    h('div', { class: 'line gap' }, toggle(t.pauseAll, !d.paused_all, () => void act(d.paused_all ? 'resume' : 'pause')), h('span', { class: 'muted' }, t.switchHint))));
  out.push(h('h3', {}, 'Kênh đăng'), h('ul', { class: 'list card' }, ...d.channels.map((/** @type {any} */ c) => channelRow(d, c))));
  if (S.caps) out.push(...limitsCard(d));
  else out.push(h('p', { class: 'muted line' }, `${t.quiet(d.quiet_hours.from, d.quiet_hours.to)} · `, h('button', { class: 'link small', type: 'button', 'aria-expanded': 'false', onclick: () => { S.caps = true; render(); } }, `${t.caps}: đổi số bài mỗi ngày, khoảng cách`)));
  out.push(h('h3', {}, 'Sắp đăng'));
  if (d.empty) out.push(h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, t.emptyQueue), h('span', {}, t.emptyHelp), askWriter(d)));
  else out.push(h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ q) => queueRow(d, q))));
  if (d.items.some((/** @type {any} */ q) => q.kind === 'video')) out.push(h('p', { class: 'muted' }, t.videoNote));
  if (d.recent.length) out.push(h('h3', {}, t.recent), h('ul', { class: 'list' }, ...d.recent.map((/** @type {any} */ r) =>
    h('li', { class: 'row' }, h('div', { class: 'who' }, h('b', {}, `${M.when(r.at)} · ${r.channel} · ${r.title}`),
      r.url && h('button', { class: 'link inline small', type: 'button', title: r.url, onclick: () => bridge.open(r.url) }, M.shortUrl(r.url)),
      h('small', { class: r.status === 'published' || r.status === 'removed' ? 'muted' : 'errline' }, r.status === 'published' ? (r.action === 'unpublish' ? t.removedDone : t.recorded) : r.status === 'removed' ? t.removedDone : r.reason ?? '')),
      badge(r.status === 'published' ? 'Đã đăng' : r.status === 'removed' ? 'Đã gỡ' : r.status === 'needs_person' ? 'Cần bạn' : 'Lỗi',
        r.status === 'published' ? 'published' : r.status === 'removed' ? '' : r.status === 'needs_person' ? 'uncertain' : 'failed'),
      r.status === 'published' && r.url && button(`↗ ${t.open}`, () => bridge.open(r.url)),
      r.live && r.action === 'publish' && button(t.unpublish, () => askUnpublish(r), 'btn sm danger')))));
  return out;
}

/** Cài đặt › Kênh đăng bài: every channel's connection state and its one fix; the queue lives on Hàng đợi. @param {any} d */
function channelsPage(d) {
  const need = d.channels.filter((/** @type {any} */ c) => c.paused && c.paused_reason !== 'person').length;
  const head = need ? `Cần bạn: ${need} kênh chưa sẵn sàng đăng. Bấm nút ở kênh đó.` : 'Không cần làm gì — mọi kênh bật đang tự đăng. Bài chờ đăng ở trang Hàng đợi.';
  return [h('p', { class: need ? 'warnline' : 'muted', role: 'status' }, head),
    h('ul', { class: 'list card' }, ...d.channels.map((/** @type {any} */ c) => channelRow(d, c)))];
}

/** One channel: its switch, what it is doing now in words, and the one button that fixes it. */
function channelRow(/** @type {any} */ d, /** @type {any} */ c) {
  const line = M.channelLine(c, d);
  const on = !c.paused;
  const flip = () => {
    if (on) return void act('pause', { channel: c.id });
    // Turning on a channel nobody signed in to: it would try, fail and stop again. Say so first.
    if (c.paused_reason === 'signed_out') {
      S.confirm = { title: `${c.label} chưa đăng nhập`, help: `Nếu bật bây giờ, Soot thử đăng rồi dừng lại vì chưa đăng nhập ${c.label}. Đăng nhập trước, rồi quay lại bật.`, yes: `Tôi đã đăng nhập, bật ${c.label}`, keep: `Đăng nhập ${c.label}`, keepRun: () => bridge.open(M.signInLink(d.editor, c.id)), run: () => void act('resume', { channel: c.id }) };
      return render();
    }
    void act('resume', { channel: c.id });
  };
  return h('li', { class: 'row' },
    toggle(c.label, on, flip),
    h('div', { class: 'who' }, h('small', { class: line.tone === 'warn' ? 'warnline soft' : 'muted' }, line.text)),
    line.button && button(line.button.label, () => (line.button.do === 'sign_in' ? bridge.open(M.signInLink(d.editor, c.id)) : void act('resume', { channel: c.id })), 'btn sm primary'));
}

/** Giới hạn kênh, edited in place: posts a day, hours apart, replies a day; saved after a confirmation. */
function limitsCard(/** @type {any} */ d) {
  const t = S.t;
  const draft = S.limits;
  const rows = d.channels.map((/** @type {any} */ c) => {
    const f = draft[c.id] ?? (draft[c.id] = { cap: String(c.cap_per_day), gap: String(Math.round((c.spacing_min / 60) * 10) / 10), rep: String(c.reply_cap_per_day ?? 0) });
    const field = (/** @type {'cap' | 'gap' | 'rep'} */ k, /** @type {string} */ label) => h('input', { class: 'input sm num', type: 'text', inputmode: 'decimal', 'aria-label': `${label} ${c.label}`, value: f[k], disabled: S.busy, oninput: (/** @type {Event} */ e) => { f[k] = /** @type {HTMLInputElement} */ (e.target).value; } });
    const save = () => {
      const body = M.limitsBody(c, f);
      if (typeof body === 'string') { S.notice = { kind: 'info', text: body }; return render(); }
      if (!Object.keys(body).length) { S.notice = { kind: 'info', text: `${c.label}: chưa đổi gì.` }; return render(); }
      S.confirm = { title: `Đổi giới hạn ${c.label}?`, help: M.limitsAsk(c, body), yes: 'Lưu giới hạn', run: () => { delete S.limits[c.id]; void act('set_limits', { channel: c.id, ...body }); } };
      render();
    };
    return h('tr', {}, h('td', {}, c.label), h('td', {}, field('cap', t.capsHead[1])), h('td', {}, field('gap', 'Giờ giữa hai bài')), h('td', {}, c.reply_cap_per_day || c.id !== 'blog-lohi' ? field('rep', t.capsHead[3]) : '—'), h('td', {}, button(t.save, save)));
  });
  return [h('div', { class: 'card scroll' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Kênh'), h('th', {}, 'Bài mỗi ngày'), h('th', {}, 'Cách nhau (giờ)'), h('th', {}, 'Trả lời mỗi ngày'), h('th', {}, ''))), h('tbody', {}, ...rows))),
    h('p', { class: 'muted line' }, 'Mỗi kênh có mức tối đa 50 bài mỗi ngày. Số mới áp dụng cho các bài xếp lịch từ giờ trở đi. ', h('button', { class: 'link small', type: 'button', onclick: () => { S.caps = false; S.limits = {}; render(); } }, 'Xong'))];
}

/** A queue item's state label and the person's buttons, shared by every row kind (posts, replies, videos). */
function queueStatus(/** @type {any} */ d, /** @type {any} */ q, /** @type {any} */ pullLabel) {
  const t = S.t;
  // A channel the person or a sign-in paused holds its items: say so instead of "Chờ đăng".
  const ch = d.channels.find((/** @type {any} */ c) => c.label === q.channel);
  const held = !q.in_flight && (d.paused_all || ch?.paused);
  const failed = q.state === 'failed';
  const state = held ? (!d.paused_all && ch?.paused_reason === 'signed_out' ? t.waitSignIn : 'Đang dừng')
    : q.in_flight ? t.inFlight : q.action === 'unpublish' ? 'Chờ gỡ' : failed && !q.retry_at ? 'Lỗi' : q.label;
  // The person's answers: a late item and an uncertain one are never sent on their own.
  const actions = q.state === 'uncertain' ? uncertainActions(t, q)
    : q.late ? [button(t.postNow, () => void act('post_now', { id: q.id })), button(t.restore, () => void act('restore', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))]
    : [failed && q.retry_at && button(t.tryNow, () => void act('post_now', { id: q.id })),
      !q.in_flight && !held && q.action === 'publish' && !failed && rescheduleButton(q),
      !q.in_flight && !d.paused_all && q.action === 'publish' && button(pullLabel, () => void act('pull', { id: q.id }))];
  return { held, failed, state, badge: badge(state, held ? 'uncertain' : q.state), actions };
}

function queueRow(d, q) {
  const t = S.t;
  if (q.kind === 'video') return videoRow(t, q, d);
  const { held, failed, badge: stateBadge, actions } = queueStatus(d, q, t.pull);
  const head = q.action === 'reply' ? `${t.replyTo} · ${q.channel}${q.reply_to ? ` · @${q.reply_to}` : ''}` : `${M.when(q.scheduled_at)} · ${q.channel}`;
  const sub = q.action === 'reply' ? `"${q.title}"` : q.text ? `"${q.text}"${q.has_link ? ` · ${t.hasLink}` : ''}` : q.title;
  const line = failed ? `${t.notYet}: ${M.failWhy(q.reason)}${q.retry_at ? ` ${t.retryAt(M.hm(q.retry_at))}` : ''}`
    : q.state === 'uncertain' ? q.reason ?? '' : d.paused_all && held ? `${sub} — ${t.afterResume}` : sub;
  return h('li', { class: 'row' },
    h('div', { class: 'who' }, h('b', {}, failed || q.state === 'uncertain' ? `${head} · ${q.title}` : head), line && h('small', { class: q.state === 'uncertain' || (failed && !q.retry_at) ? 'errline' : 'muted' }, line),
      !failed && q.state !== 'uncertain' && q.reason && !held && h('small', { class: 'muted' }, q.reason)),
    stateBadge, ...actions);
}

/** "Đổi giờ": an inline time field, saved with reschedule. */
function rescheduleButton(/** @type {any} */ q) {
  const t = S.t;
  if (S.editing !== q.id) return button(t.reschedule, () => { S.editing = q.id; render(); });
  const input = h('input', { type: 'datetime-local', class: 'input sm', 'aria-label': t.reschedule, value: M.localInput(q.scheduled_at) });
  return h('span', { class: 'line' }, input, button(t.save, () => { const v = /** @type {HTMLInputElement} */ (input).value; S.editing = ''; if (v) void act('reschedule', { id: q.id, scheduled_at: M.fromLocalInput(v) }); }, 'btn sm'),
    button(t.cancel, () => { S.editing = ''; render(); }));
}

/** A queued video (#p4-video-queue): poster, what it is, the hook scores, Xem video and Kéo khỏi hàng đợi. */
function videoRow(/** @type {any} */ t, /** @type {any} */ q, /** @type {any} */ d) {
  const v = q.video ?? {};
  const { failed, badge: stateBadge, actions } = queueStatus(d, q, t.pullQueue);
  const hooks = M.hookRows(v.pretest);
  return h('li', { class: 'row top' },
    v.poster ? h('img', { class: 'poster', src: v.poster, alt: '' }) : h('div', { class: 'poster' }),
    h('div', { class: 'who stack' },
      h('b', {}, `${M.when(q.scheduled_at)} · ${q.channel} · ${t.videoLine(v.duration_s ?? null, !!v.captions?.length)}`),
      h('small', { class: 'muted' }, q.source_title ? t.fromPost(q.source_title) : q.title),
      q.reason && h('small', { class: q.state === 'uncertain' || (failed && !q.retry_at) ? 'errline' : 'muted' }, failed ? `${t.notYet}: ${M.failWhy(q.reason)}${q.retry_at ? ` ${t.retryAt(M.hm(q.retry_at))}` : ''}` : q.reason),
      hooks.length ? h('table', { class: 'table hooks' },
        h('thead', {}, h('tr', {}, h('th', {}, `${t.hooks} (${t.panel(v.pretest?.n ?? null)})`), h('th', { class: 'num' }, t.keepWatching))),
        h('tbody', {}, ...hooks.map(r => h('tr', {}, h('td', {}, r.chosen ? h('b', {}, r.text) : r.text, r.chosen ? ' ' : null, r.chosen ? h('span', { class: 'badge ok' }, t.chosen) : null), h('td', { class: 'num' }, r.score))))) : null,
      h('span', { class: 'line' }, v.open_link && button(t.watch, () => bridge.open(v.open_link), 'btn sm'), ...actions)),
    stateBadge);
}

/** "Không chắc đã đăng chưa": the person looked. Live → paste its link; not live → it may go out again. */
function uncertainActions(/** @type {any} */ t, /** @type {any} */ q) {
  const url = h('input', { type: 'url', class: 'input sm', placeholder: 'https://…', 'aria-label': t.postedUrl, disabled: S.busy });
  return [url, button(t.posted, () => void act('confirm_posted', { id: q.id, url: /** @type {HTMLInputElement} */ (url).value.trim() })),
    button(t.notPosted, () => void act('confirm_not_posted', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))];
}

/** "Gỡ bài trên X?": removing a live post loses its likes and replies, so it asks first; Giữ lại is focused. */
function askUnpublish(/** @type {any} */ p) {
  S.confirm = { title: S.t.unpublishAsk(p.channel), yes: S.t.unpublishYes(p.channel), run: () => void act('unpublish', { id: p.id }) };
  render();
  /** @type {HTMLElement | null} */ (document.querySelector('[data-keep]'))?.focus();
}
const closeConfirm = () => { S.confirm = null; render(); };

let shown = '';
function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const d = S.data;
  // Opening a post or a campaign (or going back) starts at its top, not where the list was scrolled.
  const here = `${d?.page ?? ''}/${d?.post?.id ?? ''}/${d?.campaign?.id ?? d?.campaign ?? ''}`;
  if (here !== shown) { shown = here; window.scrollTo(0, 0); }
  const out = [];
  if (S.loadError) out.push(h('div', { class: 'notice err', role: 'alert' }, h('p', {}, S.loadError), button(t.reload, () => void run(load), 'btn sm')));
  else if (!d) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (d.page === 'queue') out.push(...queue(d));
  else if (d.page === 'channels') out.push(...channelsPage(d));
  else if (d.page === 'campaigns') out.push(...(d.campaign ? campaignDetail(d) : campaignList(d)));
  else out.push(...(d.post ? postDetail(d) : postList(d)));
  if (S.notice) { const n = S.notice; out.push(h('div', { class: `notice ${n.kind}`, role: 'status' }, h('span', {}, n.text), n.fix && button(n.fix.label, () => bridge.open(/** @type {{link: string}} */ (n.fix).link), 'btn sm primary'))); }
  if (S.sheet && d?.page === 'campaigns') out.push(...campaignSheet(d));
  const c = S.confirm;
  if (c) out.push(h('div', { class: 'scrim', onclick: closeConfirm }),
    h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': c.title, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') closeConfirm(); } },
      h('b', { class: 'dialog-title' }, c.title), h('span', { class: 'muted' }, c.help ?? t.unpublishHelp(c.title)),
      h('div', { class: 'line end' }, button(c.keep ?? t.keep, c.keepRun ? () => { S.confirm = null; /** @type {() => void} */ (c.keepRun)(); render(); } : closeConfirm, c.keepRun ? 'btn primary' : 'btn out', { 'data-keep': '' }), button(c.yes, () => { S.confirm = null; c.run(); }, c.keepRun || c.help ? 'btn out' : 'btn danger'))));
  const hadDialog = !!root.querySelector('.dialog');
  root.replaceChildren(...out);
  // A new dialog takes focus, so Tab and Enter act on it and never on the page behind.
  if (c && !hadDialog) /** @type {HTMLElement | null} */ (root.querySelector('[data-keep]'))?.focus();
}

// ---------- Chiến dịch (#p5-campaigns, #p5-campaign-new, #p5-campaign-detail, #p5-campaign-api-error) ----------

/** A bar fill, sized through CSSOM (the frame's CSP refuses style attributes). @param {number} pct */
const fill = pct => { const i = h('i'); i.style.width = `${pct}%`; return i; };
const openCampaign = (/** @type {string} */ id) => { S.campaign = id; S.notice = null; void run(load); };
const openSheet = (/** @type {any} */ d) => { S.sheet = M.newCampaign(d.choices); S.sheetError = ''; S.sheetFix = null; S.pending = null; render(); /** @type {HTMLElement | null} */ (document.getElementById('mk-name'))?.focus(); };
const closeSheet = () => { S.sheet = null; S.sheetError = ''; render(); };

function campaignList(/** @type {any} */ d) {
  const top = h('div', { class: 'line end' }, button('+ Tạo chiến dịch', () => openSheet(d), 'btn primary'));
  if (d.empty) return [top, h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, 'Chưa có chiến dịch'),
    h('span', {}, 'Một chiến dịch gom các bài theo một mục tiêu, có liên kết riêng cho từng kênh để đếm lượt bấm và người đăng ký.'))];
  return [top, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ c) => {
    const pct = M.goalPct(c.goal);
    const line = [M.dayRange(c.starts, c.ends), c.channels.join(', '), c.published ? `${c.published} bài đã đăng` : null].filter(Boolean).join(' · ');
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => openCampaign(c.id) }, c.name), h('small', { class: 'muted' }, line), h('small', { class: 'muted' }, M.campaignNextLine(c)),
        c.phase === 'running' && h('div', { class: 'bar2', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct == null ? null : String(pct), 'aria-label': M.goalLine(c.goal) }, fill(pct ?? 0)),
        c.phase === 'running' && h('small', { class: 'muted' }, M.goalLine(c.goal))),
      h('span', { class: `badge ${c.phase === 'running' ? 'ok' : ''}` }, c.phase_label));
  }))];
}

const kpi = (/** @type {string} */ k, /** @type {string} */ v, /** @type {string | null} */ sub) => h('div', { class: 'card pad kpi-card' }, h('small', { class: 'muted' }, k), h('strong', {}, v), sub && h('small', { class: 'muted' }, sub));
const n = (/** @type {number | null} */ v) => (v == null ? '—' : /** @type {string} */ (M.num(v)));

function campaignDetail(/** @type {any} */ d) {
  const c = d.campaign, t = d.totals, product = d.product ?? 'sản phẩm';
  const back = h('button', { class: 'btn sm ghost back', type: 'button', onclick: () => { S.campaign = ''; S.notice = null; void run(load); } }, '← Tất cả chiến dịch');
  const failed = d.read && !d.read.ok;
  const when = d.read?.ok ? `đọc số ${product} lúc ${M.hm(d.read.at)}` : d.read ? null : `chưa đọc số ${product}`;
  const head = h('div', { class: 'line' }, h('b', { class: 'title' }, c.name), h('span', { class: 'muted' }, ['', M.dayRange(c.starts, c.ends), when].filter(x => x !== null).join(' · ')));
  const out = [back];
  if (failed) out.push(h('div', { class: 'notice plain', role: 'alert' }, h('b', {}, `Chưa đọc được số đăng ký từ ${product}`), h('span', {}, M.readFailLine(d.read)),
    h('span', {}, button('↻ Thử lại', () => void act('campaign_refresh', { campaign_id: c.id }), 'btn sm out'))));
  out.push(head);
  // The next step: links first (nothing can be tracked without them), then the first read of the numbers.
  const noLinks = d.links_missing.length > 0, unread = !d.read;
  out.push(h('div', { class: `notice ${noLinks ? 'plain warn' : 'plain'}`, role: 'status' }, h('b', {}, noLinks ? 'Cần làm' : 'Soot đang theo dõi'),
    h('span', {}, noLinks ? 'Chưa đủ liên kết cho mọi kênh, nên lượt bấm và đăng ký của kênh thiếu chưa đếm được. Tạo lại liên kết.' : unread ? 'Soot đọc số lượt bấm và đăng ký mỗi sáng 07:00. Bấm Đọc số ngay nếu muốn xem liền.' : 'Soot đọc lại số mỗi sáng 07:00 và báo bạn khi dùng 80% token. Không cần làm gì.'),
    button(noLinks ? 'Tạo lại liên kết' : '↻ Đọc số ngay', () => void (noLinks ? act('campaign_save', { campaign: { id: c.id, name: c.name, goal: { metric: c.goal.metric, target: c.goal.target }, channels: c.channel_ids, starts: M.localInput(c.starts).slice(0, 10), ends: M.localInput(c.ends).slice(0, 10), token_budget: c.token_budget } }) : act('campaign_refresh', { campaign_id: c.id })), (noLinks || unread) ? 'btn sm primary' : 'btn sm out')));
  const goal = c.goal, of = (/** @type {string} */ m) => (goal.metric === m ? ` / ${M.num(goal.target)}` : '');
  out.push(failed
    ? h('div', { class: 'kpis four' }, kpi('Đã đăng', n(t.published), null), kpi('Tiếp cận', n(t.reach), null), kpi('Lượt bấm', '—', 'chưa rõ'), kpi('Đăng ký', '—', 'chưa rõ'))
    : h('div', { class: 'kpis four' }, kpi(goal.metric === 'published' ? 'Đã đăng / mục tiêu' : 'Đã đăng', n(t.published) + of('published'), 'bài + video'), kpi('Tiếp cận', n(t.reach), 'hiển thị + lượt xem'),
      kpi(goal.metric === 'clicks' ? 'Lượt bấm / mục tiêu' : 'Lượt bấm', n(t.clicks) + of('clicks'), 'qua liên kết chiến dịch'),
      kpi(goal.metric === 'signups' ? 'Đăng ký / mục tiêu' : 'Đăng ký', n(t.signups) + of('signups'), t.first_topups == null ? null : `${M.num(t.first_topups)}${of('first_topups')} người nạp lần đầu`)));
  if (!failed) out.push(h('div', { class: 'card scroll' }, h('table', { class: 'table channels' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Kênh'), ...['Đã đăng', 'Tiếp cận', 'Bấm', 'Đăng ký', 'Nạp lần đầu'].map(x => h('th', { class: 'num' }, x)))),
    h('tbody', {}, ...d.rows.map((/** @type {any} */ r) => h('tr', {}, h('td', {}, r.label), ...[r.published, r.reach, r.clicks, r.signups, r.first_topups].map(v => h('td', { class: 'num' }, n(v)))))))));
  if (d.links_missing.length) out.push(h('div', { class: 'notice plain', role: 'status' }, h('b', {}, `Chưa có liên kết cho ${d.links_missing.join(', ')}`),
    h('span', {}, 'Bài trên kênh này chưa đếm được lượt bấm. Tạo lại khi api trả lời.'),
    h('span', {}, button('Tạo lại liên kết', () => void act('campaign_save', { campaign: { id: c.id, name: c.name, goal: { metric: goal.metric, target: goal.target }, channels: c.channel_ids, starts: M.localInput(c.starts).slice(0, 10), ends: M.localInput(c.ends).slice(0, 10), token_budget: c.token_budget } }), 'btn sm out'))));
  // The links to use: one per channel, tagged so every click and signup is counted.
  if (d.links.length) out.push(h('div', { class: 'card pad stack' }, h('h3', {}, 'Liên kết của chiến dịch'), h('small', { class: 'muted' }, 'Dán đúng liên kết của kênh vào bài; Writer tự gắn khi viết bài cho chiến dịch.'),
    ...d.links.map((/** @type {any} */ l) => h('div', { class: 'line' }, h('b', {}, l.label), h('button', { class: 'link inline', type: 'button', title: l.url, onclick: () => bridge.open(l.url) }, l.url))),
    d.writer && button('Nhờ Writer viết bài cho chiến dịch', () => bridge.open(M.campaignWriteLink(d.writer, c, d.links)), 'btn sm out')));
  out.push(h('p', { class: 'muted' }, `${M.tokenLine(c.tokens_used, c.token_budget)} Đăng ký tính theo liên kết người đó bấm đầu tiên khi tạo tài khoản.`));
  return out;
}

/** "Tạo chiến dịch": typing never re-renders (focus stays); only the code, hint and button follow it. */
function syncSheet() {
  const f = S.sheet, problem = M.campaignProblem(f);
  const code = document.getElementById('mk-code'), hint = document.getElementById('mk-hint'), go = /** @type {HTMLButtonElement | null} */ (document.getElementById('mk-create'));
  if (code) code.textContent = `Mã trong liên kết: ${M.slugOf(f.name) || '—'}`;
  if (hint) hint.textContent = S.sheetError || problem || '';
  if (go) go.disabled = S.busy || !!problem;
}
function field(/** @type {string} */ label, /** @type {string} */ id, /** @type {any[]} */ kids, /** @type {any} */ note = null) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), ...kids, note);
}
/** 2000000 → 2.000.000 once the field is left (the sheet keeps reading digits). */
function groupDigits(/** @type {Event} */ e) {
  const el = /** @type {HTMLInputElement} */ (e.target), n = M.digits(el.value);
  if (n != null) { el.value = M.num(n) ?? el.value; S.sheet.budget = el.value; }
}
function textInput(/** @type {string} */ id, /** @type {string} */ key, more = {}) {
  return h('input', { id, class: 'input', value: S.sheet[key], disabled: S.busy, oninput: (/** @type {Event} */ e) => { S.sheet[key] = /** @type {HTMLInputElement} */ (e.target).value; S.sheetError = ''; syncSheet(); }, ...more });
}
function campaignSheet(/** @type {any} */ d) {
  const f = S.sheet, problem = M.campaignProblem(f);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Kênh' }, ...d.choices.map((/** @type {any} */ c) => {
    const on = f.channels.includes(c.id);
    return h('button', { class: 'chip toggle', type: 'button', 'aria-pressed': String(on), disabled: S.busy, onclick: (/** @type {Event} */ e) => {
      f.channels = f.channels.includes(c.id) ? f.channels.filter((/** @type {string} */ x) => x !== c.id) : [...f.channels, c.id];
      const el = /** @type {HTMLElement} */ (e.currentTarget), now = f.channels.includes(c.id);
      el.setAttribute('aria-pressed', String(now)); el.textContent = `${now ? '✓ ' : ''}${c.label}`; syncSheet();
    } }, `${on ? '✓ ' : ''}${c.label}`);
  }));
  const metric = h('select', { id: 'mk-metric', class: 'input', 'aria-label': 'Đơn vị mục tiêu', disabled: S.busy, onchange: (/** @type {Event} */ e) => { f.metric = /** @type {HTMLSelectElement} */ (e.target).value; } },
    ...Object.entries(M.GOAL_FORM).map(([k, v]) => h('option', { value: k, selected: f.metric === k }, v)));
  const body = h('div', { class: 'sheet-body' },
    field('Tên', 'mk-name', [textInput('mk-name', 'name', { maxlength: '120', autocomplete: 'off' })], h('span', { id: 'mk-code', class: 'muted' }, `Mã trong liên kết: ${M.slugOf(f.name) || '—'}`)),
    field('Mục tiêu', 'mk-target', [h('div', { class: 'goal' }, textInput('mk-target', 'target', { inputmode: 'numeric', placeholder: '300' }), metric)]),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Kênh'), chips),
    h('div', { class: 'two' }, field('Từ', 'mk-starts', [textInput('mk-starts', 'starts', { type: 'date' })]), field('Đến', 'mk-ends', [textInput('mk-ends', 'ends', { type: 'date' })])),
    field('Ngân sách token', 'mk-budget', [textInput('mk-budget', 'budget', { inputmode: 'numeric', placeholder: '2.000.000', onchange: groupDigits })],
      h('span', { class: 'muted' }, 'Đầu mối báo bạn khi dùng 80%. Chi tiền (quảng cáo, công cụ trả phí) vẫn do bạn quyết.')),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Liên kết'), h('span', { class: 'muted' }, `Mỗi kênh một liên kết ${d.api_host ? `${d.api_host}/r/…` : 'rút gọn'} riêng cho từng kênh, tạo khi lưu để đếm được lượt bấm và đăng ký.`)));
  return [h('div', { class: 'scrim', onclick: closeSheet }),
    h('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mk-sheet-title', onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') closeSheet(); } },
      h('header', {}, h('h2', { id: 'mk-sheet-title' }, 'Tạo chiến dịch'), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Đóng', onclick: closeSheet }, '✕')),
      body,
      h('footer', {}, h('span', { id: 'mk-hint', class: S.sheetError ? 'errline grow' : 'muted grow', role: 'status' }, S.sheetError || problem || ''), S.sheetError && S.sheetFix && button(S.sheetFix.label, () => bridge.open(/** @type {{link: string}} */ (S.sheetFix).link), 'btn primary'),
        button('Hủy', closeSheet, 'btn ghost'), h('button', { id: 'mk-create', class: 'btn primary', type: 'button', disabled: S.busy || !!problem, onclick: () => void saveCampaign() }, 'Tạo chiến dịch')))];
}

/** Create: one request id until an answer comes; then open the new campaign, saying what still needs doing. */
async function saveCampaign() {
  const f = S.sheet;
  if (!f || M.campaignProblem(f)) return;
  S.pending = S.pending?.op === 'campaign_save' ? S.pending : { request_id: randomID('mk', 12), op: 'campaign_save', rest: { campaign: M.campaignBody(f) } };
  const p = S.pending;
  await run(async () => {
    const r = await bridge.call('action', M.actionBody(p.request_id, p.op, p.rest), p.request_id);
    if (!r.ok && r.error.code === 'no_response') { S.sheetError = S.t.unknown; return; }
    S.pending = null;
    let out;
    try { out = M.output(r); } catch (e) { S.sheetError = M.errorText(S.t, e); S.sheetFix = e?.link ? { label: 'Mở Thiết lập', link: e.link } : null; return; }
    S.sheet = null;
    S.campaign = out.id;
    S.notice = out.links_error ? { kind: 'info', text: `Đã tạo chiến dịch. Chưa tạo được liên kết: ${out.links_error.message}` } : { kind: 'success', text: 'Đã tạo chiến dịch và liên kết cho từng kênh.' };
    await load();
  });
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
}

// The standalone shell may not send init; start anyway after a short wait.
bridge.ready();
setTimeout(start, 1500);

})();
})();
