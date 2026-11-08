// Built from src/ by tests/build.mjs; do not edit.
'use strict';
(() => {
// ---- src/bridge.js ----
const __bridge = (() => {
// soot-pages bridge v1, frame side. The page never fetches: every read and
// write is a `call` posted to Nest (or the runtime's standalone shell), which
// runs this pack's view/action tool and posts back one `result`. Messages that
// are not exactly bridge v1 are ignored, as Nest does on its side.

/** @typedef {{ request_id: string, status: string, at: string, replayed?: true }} Receipt */
/** @typedef {{ ok: true, output: any, receipt?: Receipt, replayed?: true } | { ok: false, error: { code: string, message: string } }} CallResult */
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
  Object.entries(t).every(([k, v]) => /^--[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 512);

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
      entry.resolve(msg.ok ? { ok: true, output: msg.output, ...(msg.receipt ? { receipt: msg.receipt } : {}), ...(msg.replayed === true ? { replayed: true } : {}) } : { ok: false, error: msg.error });
    }
  });
  return {
    ready() { io.post({ v: 1, type: 'ready' }); },
    /** Ask Nest to open an https:// or nest:// link; the frame never navigates itself. @param {string} link */
    open(link) { if (/^(https|nest):\/\//.test(link) && link.length <= 2048) io.post({ v: 1, type: 'open', link }); },
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
// Pure page logic for Bài viết and Hàng đợi: strings, number and time text,
// and the bodies the page sends. No DOM here, so the tests import it directly.

/** @param {'vi' | 'en'} locale */
function strings(locale) {
  const vi = {
    posts: 'Bài viết', queue: 'Hàng đợi', reload: 'Tải lại', loading: 'Đang tải…', back: 'Tất cả bài',
    tabs: { all: 'Tất cả', draft: 'Nháp', waiting: 'Đang chờ đăng', published: 'Đã đăng', refused: 'Bị từ chối' },
    noPosts: 'Chưa có bài nào', noPostsHelp: 'Writer lưu bản nháp vào đây.', askWrite: 'Nhờ viết bài',
    open: 'Mở', unpublish: 'Gỡ bài', pull: 'Kéo ra', restore: 'Xếp lại', republish: 'Đăng lại', reschedule: 'Đổi giờ', why: 'Xem lý do', save: 'Lưu', cancel: 'Hủy',
    noData: 'Chưa có số liệu', noDataWhy: 'Chưa có số liệu — Google thường cần 2–3 ngày sau khi đăng.', notZero: 'Không phải 0: chưa đọc được.',
    relogin: 'Cần đăng nhập Google lại', reloginHelp: 'Quyền đọc Search Console đã bị thu hồi. Một mục đã ở Cần bạn.',
    impressions: 'Hiển thị', clicks: 'Lượt bấm', position: 'Vị trí', days28: '28 ngày', topQueries: 'Truy vấn đứng đầu',
    radarUses: 'Radar dùng các truy vấn vị trí 8–20 để chọn chủ đề tuần sau.',
    editorCheck: 'Kiểm tra của Editor', noCheck: 'Editor chưa kiểm tra bản này.', stale: 'Kiểm tra cho bản cũ',
    refused: 'Không đăng', refusedBy: 'Editor', refusedNext: 'Writer đã được báo để sửa. Bài không vào hàng đợi cho tới khi Editor kiểm tra lại bản mới.',
    pausedAll: 'Đang tạm dừng đăng mọi kênh', pausedHelp: 'Soot vẫn viết và kiểm tra; không gì được đăng hay trả lời cho tới khi bạn bật lại.',
    pauseAll: 'Tạm dừng đăng', switchHint: 'Bật là dừng · tắt là chạy', afterResume: 'sẽ đăng ở khung giờ trống đầu tiên sau khi bật lại',
    caps: 'Giới hạn kênh', capsHead: ['Kênh', 'Bài/ngày', 'Cách nhau', 'Trả lời/ngày'],
    today: 'Hôm nay', replies: 'trả lời', replyTo: 'Trả lời', pausedAs: (/** @type {string} */ why) => `đang dừng: ${why}`,
    posted: 'Đã lên', postedUrl: 'Liên kết bài đã lên', notPosted: 'Chưa lên — đăng lại', drop: 'Bỏ', postNow: 'Đăng ngay', tryNow: 'Thử ngay',
    notYet: 'Chưa đăng', retryAt: (/** @type {string} */ at) => `Sẽ thử lại lúc ${at}.`,
    emptyQueue: 'Không có gì chờ đăng', emptyHelp: 'Editor xếp bài vào đây sau khi kiểm tra.', recent: 'Vừa xong', hasLink: 'có liên kết', recorded: 'Đã đăng sau kiểm tra · ghi kết quả "Bài đã đăng"', removedDone: 'Đã gỡ',
    inFlight: 'Đang đăng', waitSignIn: 'Chờ đăng nhập', unpublishingLabel: 'Đang gỡ', keep: 'Giữ lại',
    unpublishAsk: (/** @type {string} */ ch) => `Gỡ bài trên ${ch}?`, unpublishYes: (/** @type {string} */ ch) => `Gỡ bài trên ${ch}`,
    unpublishHelp: (/** @type {string} */ title) => `Bài và lượt thích, trả lời của nó sẽ mất trên ${title.replace(/^Gỡ bài trên |\?$/g, '')}. Bài vẫn còn trong Bài viết để đăng lại.`,
    perDay: (/** @type {number} */ n, /** @type {number} */ h) => `${n} bài/ngày, cách nhau ít nhất ${h} giờ`, quiet: (/** @type {string} */ f, /** @type {string} */ t) => `giờ yên ${f}–${t}`,
    unknown: 'Chưa rõ kết quả — tải lại để xem bài đã đổi chưa.', done: 'Đã lưu.', failed: 'Không làm được: ',
    watch: 'Xem video', pullQueue: 'Kéo khỏi hàng đợi', hooks: 'Câu mở đầu', keepWatching: 'Muốn xem tiếp', chosen: 'chọn',
    videoNote: 'Không có gì chờ bạn xem: video tự đăng đúng giờ sau kiểm tra. Bạn có thể xem và kéo ra bất cứ lúc nào.',
    panel: (/** @type {number | null} */ n) => `Micro Fish${n ? `, ${n} người đọc mô phỏng` : ''}`,
    videoLine: (/** @type {number | null} */ s, /** @type {boolean} */ captions) => `Video${s ? ` ${Math.round(s)} giây` : ''}${captions ? ' · phụ đề tiếng Việt' : ''}`,
    fromPost: (/** @type {string} */ t) => `Từ bài "${t}"`, stillDraft: 'Vẫn là nháp',
  };
  if (locale !== 'en') return vi;
  return { ...vi, posts: 'Posts', queue: 'Queue', reload: 'Reload', loading: 'Loading…', back: 'All posts',
    tabs: { all: 'All', draft: 'Drafts', waiting: 'Waiting', published: 'Published', refused: 'Refused' },
    noData: 'No data yet', noDataWhy: 'No data yet — Google usually needs 2–3 days after publishing.', notZero: 'Not 0: not read yet.',
    impressions: 'Impressions', clicks: 'Clicks', position: 'Position', emptyQueue: 'Nothing waiting to publish', unpublish: 'Unpublish', pull: 'Pull', open: 'Open' };
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

const viewBody = (/** @type {string} */ filter = 'all', /** @type {string} */ id = '') => (id ? { id } : { filter });
/** @param {string} request_id @param {string} op @param {Record<string, unknown>} [rest] */
const actionBody = (request_id, op, rest = {}) => ({ op, request_id, ...rest });

/** A failed bridge call or tool error as plain text. @param {ReturnType<typeof strings>} t @param {any} err */
function errorText(t, err) {
  if (err?.code === 'no_response') return t.unknown;
  return t.failed + (err?.message || err?.code || '');
}

/** Unwrap a bridge result: tool errors come back as {error} in the output. @param {any} r */
function output(r) {
  if (!r.ok) throw r.error;
  if (r.output?.error) throw r.output.error;
  return r.output;
}
return { strings, num, pos, when, hm, shortUrl, spacing, writeLink, ruleLabel, localInput, fromLocalInput, postLine, metricLine, tone, holdTone, hookRows, viewBody, actionBody, errorText, output };
})();

// ---- src/app.js ----
const __app = (() => {
// Bài viết and Hàng đợi (marketing pack, flow-marketing). One bundle serves
// both pages: the view tool answers for the page in its context. Plain DOM,
// no network: every read and write goes through the soot-pages bridge.
// Text is set with textContent only.
const { createBridge, applyTheme, randomID } = __bridge;
const M = __model;

const S = {
  t: M.strings('vi'), started: false, busy: false, filter: 'all', id: '',
  /** @type {any} */ data: null, loadError: '',
  /** @type {{ request_id: string, op: string, rest: object } | null} */ pending: null,
  /** @type {{ kind: 'info' | 'success', text: string } | null} */ notice: null,
  /** @type {{ title: string, yes: string, run: () => void } | null} */ confirm: null,
  caps: false, editing: '',
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
  try { S.data = M.output(await bridge.call('view', M.viewBody(S.filter, S.id))); } catch (e) { S.loadError = M.errorText(S.t, e); }
}
async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } finally { S.busy = false; render(); }
}
/** A write keeps its request id until an answer comes, so a retry never acts twice. */
async function act(/** @type {string} */ op, rest = {}) {
  S.pending = S.pending?.op === op ? S.pending : { request_id: randomID('mk', 12), op, rest };
  const p = S.pending;
  await run(async () => {
    const r = await bridge.call('action', M.actionBody(p.request_id, p.op, p.rest), p.request_id);
    if (!r.ok && r.error.code === 'no_response') { S.notice = { kind: 'info', text: S.t.unknown }; return; }
    S.pending = null;
    try { M.output(r); S.notice = { kind: 'success', text: S.t.done }; } catch (e) { S.notice = { kind: 'info', text: M.errorText(S.t, e) }; }
    await load();
  });
}

/** "Nhờ viết bài": Nest opens a new task for the writer Soot (nest://new). */
function askWriter(/** @type {any} */ d) {
  if (!d.writer) return null;
  return button(S.t.askWrite, () => bridge.open(M.writeLink(d.writer, d.product)), 'btn sm out');
}

function postList(d) {
  const t = S.t;
  const tabs = h('div', { class: 'seg', role: 'tablist' }, ...Object.entries(t.tabs).map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; void run(load); } }, `${label} ${d.counts[k] ?? 0}`)));
  const top = h('div', { class: 'line wrap' }, tabs, askWriter(d));
  if (!d.items.length) return [top, h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, t.noPosts), h('span', {}, t.noPostsHelp))];
  return [top, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ p) => {
    const bad = p.reason && ['refused', 'failed'].includes(p.state);
    const state = p.unpublishing ? 'unpublishing' : p.state;
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => { S.id = p.id; void run(load); } }, p.kind === 'video' ? `Video "${p.title}"` : p.title),
        // A held video draft (#p4-video-failed): the reason, and it stays a draft.
        p.hold ? h('small', { class: p.hold === 'render_failed' ? 'errline' : 'muted' }, p.reason ?? t.stillDraft) :
        h('small', { class: bad ? 'errline' : 'muted' }, bad ? `${t.refused}: ${p.reason.split(' · ')[0]}` : M.postLine(p, t))),
      p.hold ? h('span', { class: `badge ${M.holdTone(p.hold)}` }, p.hold_label) : badge(p.unpublishing ? t.unpublishingLabel : p.label, state),
      p.state === 'refused' && button(t.why, () => { S.id = p.id; void run(load); }),
      p.url && !p.unpublishing && p.state === 'published' && button(`↗ ${t.open}`, () => bridge.open(p.url)),
      p.state === 'published' && !p.unpublishing && button(t.unpublish, () => askUnpublish(p), 'btn sm danger'),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })),
      ['pulled', 'removed'].includes(p.state) && button(p.state === 'removed' ? t.republish : t.restore, () => void act('restore', { id: p.id })));
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

function postDetail(d) {
  const t = S.t, p = d.post;
  const back = h('button', { class: 'btn sm ghost back', type: 'button', onclick: () => { S.id = ''; void run(load); } }, `← ${t.back}`);
  if (p.state === 'refused') return [back, refusedCard(d)];
  const head = h('div', { class: 'line wrap' }, h('div', { class: 'line' }, badge(p.label, p.state), h('h2', {}, p.title)),
    h('div', { class: 'line' }, p.url && button(`↗ ${t.open}`, () => bridge.open(p.url)), p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger')));
  const left = h('div', { class: 'card pad stack' });
  if (p.reason && ['failed', 'uncertain'].includes(p.state)) left.append(h('p', { class: 'errline', role: 'alert' }, p.reason));
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
  return [back, head, h('div', { class: 'split' }, left, p.state === 'published' ? metrics(d.search_console) : null)];
}

/** One on/off switch: on means paused ("Bật là dừng"). */
const toggle = (/** @type {string} */ label, /** @type {boolean} */ on, /** @type {() => void} */ fn) =>
  h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), disabled: S.busy, onclick: fn }, h('i', { 'aria-hidden': 'true' }), label);

function queue(d) {
  const t = S.t, blog = d.channels.find((/** @type {any} */ c) => c.id === 'blog-lohi') ?? d.channels[0];
  const out = [];
  if (d.paused_all) out.push(h('div', { class: 'notice plain', role: 'status' }, h('b', {}, `⏸ ${t.pausedAll}`), h('span', {}, `${d.paused_at ? `Bạn dừng lúc ${M.hm(d.paused_at)}. ` : ''}${t.pausedHelp}`)));
  out.push(h('div', { class: 'card pad bar' },
    h('div', { class: 'line gap' }, toggle(t.pauseAll, d.paused_all, () => void act(d.paused_all ? 'resume' : 'pause')),
      ...d.channels.map((/** @type {any} */ c) => toggle(c.label, c.paused, () => void act(c.paused ? 'resume' : 'pause', { channel: c.id })))),
    h('span', { class: 'muted' }, t.switchHint)));
  const social = d.channels.filter((/** @type {any} */ c) => c.id !== 'blog-lohi' && c.posts_today !== undefined);
  if (blog && !social.length && !d.paused_all && !d.empty) out.push(h('p', { class: 'muted line' }, `${blog.label}: ${t.perDay(blog.cap_per_day, Math.round(blog.spacing_min / 60))} · ${t.quiet(d.quiet_hours.from, d.quiet_hours.to)} ·`,
    h('button', { class: 'link small', type: 'button', 'aria-expanded': String(S.caps), onclick: () => { S.caps = !S.caps; render(); } }, t.caps)));
  // Today's use of each cap: "X 2/4 · Facebook 0/2 (đang dừng: chưa đăng nhập) · trả lời X 3/10".
  if (social.length && !d.paused_all) out.push(h('p', { class: 'muted line' }, `${t.today}: ${[
    ...social.map((/** @type {any} */ c) => `${c.label} ${c.posts_today}/${c.cap_per_day}${c.paused_label ? ` (${t.pausedAs(c.paused_label)})` : ''}`),
    ...social.filter((/** @type {any} */ c) => c.reply_cap_per_day && c.replies_today).map((/** @type {any} */ c) => `${t.replies} ${c.label} ${c.replies_today}/${c.reply_cap_per_day}`),
  ].join(' · ')} ·`, h('button', { class: 'link small', type: 'button', 'aria-expanded': String(S.caps), onclick: () => { S.caps = !S.caps; render(); } }, t.caps)));
  if (S.caps) out.push(h('table', { class: 'table card' }, h('thead', {}, h('tr', {}, ...t.capsHead.map((/** @type {string} */ x) => h('th', {}, x)))),
    h('tbody', {}, ...d.channels.map((/** @type {any} */ c) => h('tr', {}, h('td', {}, c.label), h('td', {}, String(c.cap_per_day)), h('td', {}, M.spacing(c.spacing_min)), h('td', {}, c.reply_cap_per_day ? String(c.reply_cap_per_day) : '—'))))));
  if (d.empty) out.push(h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, t.emptyQueue), h('span', {}, t.emptyHelp), askWriter(d)));
  else out.push(h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ q) => queueRow(d, q))));
  if (d.items.some((/** @type {any} */ q) => q.kind === 'video')) out.push(h('p', { class: 'muted' }, t.videoNote));
  if (d.recent.length) out.push(h('h3', {}, t.recent), h('ul', { class: 'list' }, ...d.recent.map((/** @type {any} */ r) =>
    h('li', { class: 'row' }, h('div', { class: 'who' }, h('b', {}, `${M.when(r.at)} · ${r.channel} · ${r.url ? M.shortUrl(r.url) : r.title}`),
      h('small', { class: r.status === 'published' || r.status === 'removed' ? 'muted' : 'errline' }, r.status === 'published' ? (r.action === 'unpublish' ? t.removedDone : t.recorded) : r.status === 'removed' ? t.removedDone : r.reason ?? '')),
      badge(r.status === 'published' ? 'Đã đăng' : r.status === 'removed' ? 'Đã gỡ' : r.status === 'needs_person' ? 'Cần bạn' : 'Lỗi',
        r.status === 'published' ? 'published' : r.status === 'removed' ? '' : r.status === 'needs_person' ? 'uncertain' : 'failed'),
      r.status === 'published' && r.url && button(`↗ ${t.open}`, () => bridge.open(r.url)),
      r.live && r.action === 'publish' && button(t.unpublish, () => askUnpublish(r), 'btn sm danger')))));
  return out;
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
  const line = failed ? `${t.notYet}: ${q.reason ?? ''}${q.retry_at ? ` ${t.retryAt(M.hm(q.retry_at))}` : ''}`
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
      q.reason && h('small', { class: q.state === 'uncertain' || (failed && !q.retry_at) ? 'errline' : 'muted' }, failed ? `${t.notYet}: ${q.reason}${q.retry_at ? ` ${t.retryAt(M.hm(q.retry_at))}` : ''}` : q.reason),
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

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const d = S.data;
  const out = [];
  if (S.loadError) out.push(h('div', { class: 'notice err', role: 'alert' }, h('p', {}, S.loadError), button(t.reload, () => void run(load), 'btn sm')));
  else if (!d) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (d.page === 'hang-doi') out.push(...queue(d));
  else out.push(...(d.post ? postDetail(d) : postList(d)));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: 'status' }, S.notice.text));
  const c = S.confirm;
  if (c) out.push(h('div', { class: 'scrim', onclick: closeConfirm }),
    h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': c.title, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') closeConfirm(); } },
      h('b', { class: 'dialog-title' }, c.title), h('span', { class: 'muted' }, t.unpublishHelp(c.title)),
      h('div', { class: 'line end' }, button(t.keep, closeConfirm, 'btn out', { 'data-keep': '' }), button(c.yes, () => { S.confirm = null; c.run(); }, 'btn danger'))));
  root.replaceChildren(...out);
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
