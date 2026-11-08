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
    tabs: { all: 'Tất cả', draft: 'Nháp', waiting: 'Đang chờ đăng', published: 'Đã đăng', refused: 'Bị từ chối', removed: 'Đã gỡ / kéo ra' },
    noPosts: 'Chưa có bài nào. Writer lưu bản nháp vào đây.', open: 'Mở', unpublish: 'Gỡ bài', pull: 'Kéo ra', restore: 'Xếp lại', reschedule: 'Đổi giờ', why: 'Xem lý do',
    noData: 'Chưa có số liệu', noDataHelp: 'Google thường cần 2–3 ngày sau khi đăng. Không phải 0: chưa đọc được.',
    relogin: 'Cần đăng nhập Google lại', reloginHelp: 'Quyền đọc Search Console đã bị thu hồi. Một mục đã ở Cần bạn.',
    impressions: 'Hiển thị', clicks: 'Lượt bấm', position: 'Vị trí', days28: '28 ngày', days7: '7 ngày', topQueries: 'Truy vấn đứng đầu',
    brief: 'Bản tóm tắt SEO', editorCheck: 'Kiểm tra của Editor', noCheck: 'Editor chưa kiểm tra bản này.', stale: 'Kiểm tra cho bản cũ',
    refused: 'Không đăng', pausedAll: 'Đang tạm dừng đăng mọi kênh', pausedHelp: 'Soot vẫn viết và kiểm tra; không gì được đăng cho tới khi bạn bật lại.',
    pauseAll: 'Tạm dừng mọi kênh', resumeAll: 'Bật lại', pauseOne: 'Dừng', resumeOne: 'Bật',
    today: 'Hôm nay', replies: 'trả lời', pausedAs: (/** @type {string} */ why) => `đang dừng: ${why}`, posted: 'Đã lên', postedUrl: 'Liên kết bài đã lên', notPosted: 'Chưa lên — đăng lại', drop: 'Bỏ', postNow: 'Đăng ngay',
    emptyQueue: 'Không có gì chờ đăng', emptyHelp: 'Editor xếp bài vào đây sau khi kiểm tra.', recent: 'Vừa đăng', inFlight: 'Đang đăng', waitSignIn: 'Chờ đăng nhập', keep: 'Giữ lại', unpublishAsk: (/** @type {string} */ ch) => `Gỡ bài trên ${ch}?`,
    unpublishHelp: 'Bài và lượt thích, trả lời của nó sẽ mất trên nền tảng. Bài vẫn còn trong Bài viết để đăng lại.',
    perDay: (/** @type {number} */ n, /** @type {number} */ h) => `${n} bài/ngày, cách nhau ít nhất ${h} giờ`, quiet: (/** @type {string} */ f, /** @type {string} */ t) => `giờ yên ${f}–${t}`,
    unknown: 'Chưa rõ kết quả — tải lại để xem bài đã đổi chưa.', done: 'Đã lưu.', failed: 'Không làm được: ',
  };
  if (locale !== 'en') return vi;
  return { ...vi, posts: 'Posts', queue: 'Queue', reload: 'Reload', loading: 'Loading…', back: 'All posts',
    tabs: { all: 'All', draft: 'Drafts', waiting: 'Waiting', published: 'Published', refused: 'Refused', removed: 'Removed / pulled' },
    noData: 'No data yet', noDataHelp: 'Google usually needs 2–3 days after publishing. Not 0: not read yet.',
    impressions: 'Impressions', clicks: 'Clicks', position: 'Position', emptyQueue: 'Nothing waiting to publish', unpublish: 'Unpublish', pull: 'Pull', open: 'Open' };
}

const nf = new Intl.NumberFormat('vi-VN');
/** A count; null is "no data", never 0. @param {number | null | undefined} n */
const num = n => (n == null ? null : nf.format(n));
/** @param {number | null | undefined} p */
const pos = p => (p == null ? null : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(p));

/** @param {string | null | undefined} at @param {number} [now] */
function when(at, now = Date.now()) {
  if (!at) return '';
  const d = new Date(at), today = new Date(now);
  const hm = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const day = (/** @type {Date} */ x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  if (day(d) === day(today)) return `Hôm nay ${hm}`;
  if (day(d) === day(new Date(now + 86_400_000))) return `Mai ${hm}`;
  if (day(d) === day(new Date(now - 86_400_000))) return `Hôm qua ${hm}`;
  return `${d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })} ${hm}`;
}

/** The metric line under a published post, or the no-data text. @param {any} m @param {ReturnType<typeof strings>} t */
function metricLine(m, t) {
  if (!m) return t.noData;
  return `${num(m.impressions)} lượt hiển thị · ${num(m.clicks)} lượt bấm${m.position != null ? ` · vị trí ${pos(m.position)}` : ''} (28 ngày)`;
}

/** Badge tone by state. @param {string} state */
const tone = state => ({ published: 'ok', refused: 'err', failed: 'err', uncertain: 'warn', publishing: 'warn', unpublishing: 'warn' })[state] ?? '';

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
return { strings, num, pos, when, metricLine, tone, viewBody, actionBody, errorText, output };
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
  /** @type {{ title: string, run: () => void } | null} */ confirm: null,
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

function postList(d) {
  const t = S.t;
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...Object.entries(t.tabs).map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; void run(load); } }, `${label} ${d.counts[k] ?? 0}`)));
  if (!d.items.length) return [tabs, h('div', { class: 'empty' }, h('p', {}, t.noPosts))];
  return [tabs, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ p) => {
    const sub = p.state === 'published' ? `${p.channel} · ${M.metricLine(p.metrics_28, t)}`
      : p.state === 'scheduled' ? `${p.channel} · đăng ${M.when(p.scheduled_at)}${p.wait_reason ? ` · ${p.wait_reason}` : ''}`
      : `${p.channel}${p.reason ? '' : ` · ${p.label}`}`;
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => { S.id = p.id; void run(load); } }, p.title),
        h('small', { class: p.reason && ['refused', 'failed'].includes(p.state) ? 'errline' : 'muted' }, p.reason && ['refused', 'failed'].includes(p.state) ? `${t.refused}: ${p.reason}` : sub)),
      badge(p.label, p.state),
      p.url && button(t.open, () => bridge.open(p.url)),
      p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger'),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })),
      p.state === 'pulled' && button(t.restore, () => void act('restore', { id: p.id })));
  }))];
}

function metrics(sc) {
  const t = S.t;
  const card = h('div', { class: 'card pad stack' }, h('h3', {}, 'Search Console ', h('small', { class: 'muted' }, `${t.days28}${sc?.read_at ? ` · đọc ${M.when(sc.read_at)}` : ''}`)));
  if (!sc) return card;
  if (sc.state === 'needs_person') card.append(h('p', { class: 'warnline' }, t.relogin), h('p', { class: 'muted' }, t.reloginHelp));
  if (!sc.last_28) { card.append(h('p', { class: 'strong' }, t.noData), h('p', { class: 'muted' }, t.noDataHelp)); return card; }
  card.append(h('div', { class: 'kpis' }, ...[[t.impressions, M.num(sc.last_28.impressions)], [t.clicks, M.num(sc.last_28.clicks)], [t.position, M.pos(sc.last_28.position) ?? '—']]
    .map(([k, v]) => h('div', {}, h('small', { class: 'muted' }, k), h('div', { class: 'kpi' }, v)))));
  if (sc.last_7) card.append(h('p', { class: 'muted' }, `${t.days7}: ${M.num(sc.last_7.impressions)} lượt hiển thị · ${M.num(sc.last_7.clicks)} lượt bấm`));
  if (sc.queries.length) card.append(h('p', { class: 'muted' }, `${t.topQueries}: ${sc.queries.map((/** @type {any} */ q) => `"${q.query}" (vị trí ${M.pos(q.position)})`).join(', ')}`));
  return card;
}

function postDetail(d) {
  const t = S.t, p = d.post;
  const head = h('div', { class: 'line wrap' }, h('div', { class: 'line' }, badge(p.label, p.state), h('h2', {}, p.title)),
    h('div', { class: 'line' }, p.url && button(t.open, () => bridge.open(p.url)), p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger')));
  const left = h('div', { class: 'card pad stack' });
  if (p.reason && ['refused', 'failed', 'uncertain'].includes(p.state)) left.append(h('div', { class: 'notice err', role: 'alert' }, h('b', {}, `${t.refused}:`), ' ', p.reason));
  if (d.brief.length) left.append(h('h3', {}, t.brief), h('table', { class: 'table' }, h('tbody', {}, ...d.brief.map((/** @type {any} */ f) =>
    h('tr', {}, h('td', {}, f.label), h('td', {}, f.value), h('td', {}, f.ok ? badge(f.rule ?? 'hợp lệ', 'published') : badge(f.message, 'refused')))))));
  left.append(h('h3', {}, t.editorCheck));
  if (!d.check) left.append(h('p', { class: 'muted' }, t.noCheck));
  else {
    left.append(h('div', { class: 'flow' }, ...d.check.auto.map((/** @type {any} */ a) => h('span', { class: a.ok ? 'chip' : 'chip err' }, a.detail))));
    left.append(h('p', { class: 'muted' }, `Editor · ${M.when(d.check.at)} · bản ${d.check.revision}${d.check.current ? '' : ` · ${t.stale}`}`));
  }
  return [h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { S.id = ''; void run(load); } }, `← ${t.back}`), head, h('div', { class: 'split' }, left, p.state === 'published' ? metrics(d.search_console) : null)];
}

function queue(d) {
  const t = S.t, blog = d.channels.find((/** @type {any} */ c) => c.id === 'blog-lohi') ?? d.channels[0];
  const out = [];
  if (d.paused_all) out.push(h('div', { class: 'notice', role: 'status' }, h('b', {}, t.pausedAll), h('span', {}, `${d.paused_at ? `Bạn dừng lúc ${M.when(d.paused_at)}. ` : ''}${t.pausedHelp}`)));
  out.push(h('div', { class: 'line wrap card pad' },
    h('div', { class: 'line' }, ...d.channels.map((/** @type {any} */ c) => h('span', { class: 'line' }, badge(c.label, c.paused ? 'uncertain' : 'published'),
      button(c.paused ? t.resumeOne : t.pauseOne, () => void act(c.paused ? 'resume' : 'pause', { channel: c.id }))))),
    d.paused_all ? button(t.resumeAll, () => void act('resume'), 'btn sm primary') : button(t.pauseAll, () => void act('pause'), 'btn sm')));
  if (blog) out.push(h('p', { class: 'muted' }, `${blog.label}: ${t.perDay(blog.cap_per_day, Math.round(blog.spacing_min / 60))} · ${t.quiet(d.quiet_hours.from, d.quiet_hours.to)}`));
  // Today's use of each cap: "X 2/4 · Facebook 0/2 (đang dừng: chưa đăng nhập) · trả lời X 3/10".
  const social = d.channels.filter((/** @type {any} */ c) => c.id !== 'blog-lohi' && c.posts_today !== undefined);
  if (social.length) out.push(h('p', { class: 'muted' }, `${t.today}: ${[
    ...social.map((/** @type {any} */ c) => `${c.label} ${c.posts_today}/${c.cap_per_day}${c.paused_label ? ` (${t.pausedAs(c.paused_label)})` : ''}`),
    ...social.filter((/** @type {any} */ c) => c.reply_cap_per_day).map((/** @type {any} */ c) => `${t.replies} ${c.label} ${c.replies_today}/${c.reply_cap_per_day}`),
  ].join(' · ')}`));
  if (d.empty) out.push(h('div', { class: 'empty card pad' }, h('b', {}, t.emptyQueue), h('span', { class: 'muted' }, t.emptyHelp)));
  else out.push(h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ q) => {
    const err = ['failed', 'uncertain'].includes(q.state);
    // A channel the person or a sign-in paused holds its items: say so instead of "Chờ đăng".
    const ch = d.channels.find((/** @type {any} */ c) => c.label === q.channel);
    const held = !q.in_flight && (d.paused_all || ch?.paused);
    const state = held ? (!d.paused_all && ch?.paused_reason === 'signed_out' ? t.waitSignIn : 'Đang dừng') : q.in_flight ? t.inFlight : q.action === 'unpublish' ? 'Chờ gỡ' : q.label;
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('b', {}, `${M.when(q.scheduled_at)} · ${q.channel} · ${q.title}`), q.reason && h('small', { class: err ? 'errline' : 'muted' }, q.reason)),
      badge(state, held ? 'uncertain' : q.state),
      // The person's answers: a late item and an uncertain one are never sent on their own.
      ...(q.state === 'uncertain' ? uncertainActions(t, q)
        : q.late ? [button(t.postNow, () => void act('post_now', { id: q.id })), button(t.restore, () => void act('restore', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))]
        : [!q.in_flight && q.action === 'publish' && button(t.pull, () => void act('pull', { id: q.id }))]));
  })));
  if (d.recent.length) out.push(h('h3', {}, t.recent), h('ul', { class: 'list card' }, ...d.recent.map((/** @type {any} */ r) =>
    h('li', { class: 'row' }, h('div', { class: 'who' }, h('b', {}, `${M.when(r.at)} · ${r.channel} · ${r.url ?? r.title}`), r.reason && h('small', { class: 'errline' }, r.reason)),
      badge(r.status === 'published' ? 'Đã đăng' : r.status === 'removed' ? 'Đã gỡ' : r.status === 'needs_person' ? 'Cần bạn' : 'Lỗi',
        r.status === 'published' ? 'published' : r.status === 'removed' ? '' : r.status === 'needs_person' ? 'uncertain' : 'failed'),
      r.status === 'published' && r.url && button(t.open, () => bridge.open(r.url)),
      r.status === 'published' && r.action === 'publish' && button(t.unpublish, () => askUnpublish(r), 'btn sm danger')))));
  return out;
}

/** "Không chắc đã đăng chưa": the person looked. Live → paste its link; not live → it may go out again. */
function uncertainActions(/** @type {any} */ t, /** @type {any} */ q) {
  const url = h('input', { type: 'url', class: 'input sm', placeholder: 'https://…', 'aria-label': t.postedUrl, disabled: S.busy });
  return [url, button(t.posted, () => void act('confirm_posted', { id: q.id, url: /** @type {HTMLInputElement} */ (url).value.trim() })),
    button(t.notPosted, () => void act('confirm_not_posted', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))];
}

/** "Gỡ bài trên X?": removing a live post loses its likes and replies, so it asks first; Giữ lại is focused. */
function askUnpublish(/** @type {any} */ p) {
  S.confirm = { title: S.t.unpublishAsk(p.channel), run: () => void act('unpublish', { id: p.id }) };
  render();
  /** @type {HTMLElement | null} */ (document.querySelector('[data-keep]'))?.focus();
}

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const d = S.data;
  const title = d?.page === 'hang-doi' ? t.queue : t.posts;
  const out = [h('header', { class: 'line wrap' }, h('h2', { class: 'page-title' }, title), button(t.reload, () => void run(load), 'btn sm'))];
  if (S.loadError) out.push(h('div', { class: 'notice err', role: 'alert' }, h('p', {}, S.loadError)));
  else if (!d) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (d.page === 'hang-doi') out.push(...queue(d));
  else out.push(...(d.post ? postDetail(d) : postList(d)));
  const c = S.confirm;
  if (c) out.push(h('div', { class: 'notice confirm', role: 'alertdialog', 'aria-label': c.title }, h('b', {}, c.title), h('span', { class: 'muted' }, S.t.unpublishHelp),
    h('span', { class: 'line' }, button(S.t.keep, () => { S.confirm = null; render(); }, 'btn sm', { 'data-keep': '' }),
      button(c.title.replace(/\?$/, ''), () => { S.confirm = null; c.run(); }, 'btn sm danger'))));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: 'status' }, S.notice.text));
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
