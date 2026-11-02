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
const listBody = (q = '') => ({ kind: 'customers', ...(q.trim() ? { q: q.trim().slice(0, 100) } : {}) });
const detailBody = (/** @type {string} */ key) => ({ kind: 'customer', key });

/**
 * One write. The request id is the person's intent: kept until a terminal
 * answer, resent with the same body. It also rides in the body because the
 * control route needs it as its own idempotency id.
 * @param {string} requestID @param {Record<string, unknown>} body
 */
const actionBody = (requestID, body) => ({ ...body, request_id: requestID });
const controlBody = (/** @type {Detail['control']} */ c) => ({ kind: 'control', conversation: c.conversation, action: c.owner === 'human' || c.state === 'waiting_human' || c.state === 'blocked' ? 'resume' : 'takeover', expected_revision: c.revision });
const tagBody = (/** @type {string} */ key, /** @type {string} */ tag, remove = false) => ({ kind: 'tag', key, tag: tag.trim(), ...(remove ? { remove: true } : {}) });
const noteBody = (/** @type {string} */ key, /** @type {string} */ body) => ({ kind: 'note', key, body: body.trim() });
const linkBody = (/** @type {string} */ proof) => ({ kind: 'link', proof: proof.trim() });

// ---- answers ----
/** A view answer's output, or a thrown {code}. @param {any} r */
function viewOutput(r) {
  if (!r?.ok) throw Object.assign(new Error('view failed'), { code: r?.error?.code ?? 'failed' });
  if (r.output?.error) throw Object.assign(new Error('refused'), { code: r.output.error.code, message: r.output.error.message });
  return r.output;
}

const UNKNOWN = ['no_response', 'request_in_flight', 'timeout', 'result_unknown', 'unavailable'];
/** @param {any} r @returns {{ state: 'done' | 'unknown' | 'busy' | 'rejected', code?: string, message?: string, output?: any, replayed?: boolean }} */
function classify(r) {
  if (r?.ok) {
    if (r.output?.error) return { state: 'rejected', code: r.output.error.code, message: r.output.error.message };
    return { state: 'done', output: r.output, replayed: r.replayed === true };
  }
  const code = r?.error?.code ?? 'failed';
  if (code === 'busy') return { state: 'busy', code };
  if (UNKNOWN.includes(code) || /^http_5/.test(code)) return { state: 'unknown', code };
  return { state: 'rejected', code, message: r?.error?.message };
}

function strings(/** @type {string} */ locale) {
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

const errorText = (/** @type {ReturnType<typeof strings>} */ t, /** @type {string | undefined} */ code, /** @type {string | undefined} */ message) =>
  (code && t.errors[code]) || message || t.loadFailed;

/** "HH:MM" or "DD/MM HH:MM" for an ISO time. */
function when(/** @type {string} */ iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`;
}
return { listBody, detailBody, actionBody, controlBody, tagBody, noteBody, linkBody, viewOutput, classify, strings, errorText, when };
})();

// ---- src/app.js ----
const __app = (() => {
// Khách hàng rail page (cs-console). Plain DOM, no framework, no network:
// every read and write goes through the soot-pages bridge to console_view /
// console_action. Text is set with textContent only.
const { createBridge, applyTheme, randomID } = __bridge;
const M = __model;

const S = {
  t: M.strings('vi'), started: false, busy: false, loadError: '', q: '', tagDraft: '', noteDraft: '', proofDraft: '',
  /** @type {M.Row[] | null} */ rows: null, linkProofs: false,
  /** @type {string} */ selected: '',
  /** @type {M.Detail | null} */ detail: null,
  /** @type {{ request_id: string, body: object } | null} */ pending: null,
  /** @type {{ kind: 'info' | 'success' | 'wait', text: string } | null} */ notice: null,
};

const bridge = createBridge({
  post: m => window.parent.postMessage(m, '*'),
  listen: h => window.addEventListener('message', e => h(e.data, e.source)),
  parent: window.parent === window ? undefined : window.parent,
  onInit: init => { applyTheme(init); S.t = M.strings(init.locale); document.documentElement.lang = init.locale; start(); },
  onTheme: msg => applyTheme(msg),
});

const view = async (/** @type {object} */ body) => M.viewOutput(await bridge.call('view', body));

async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } catch (e) { S.notice = { kind: 'info', text: M.errorText(S.t, /** @type {any} */ (e)?.code, /** @type {any} */ (e)?.message) }; } finally { S.busy = false; render(); }
}

async function load() {
  S.loadError = '';
  try {
    const out = await view(M.listBody(S.q));
    S.rows = out.customers ?? []; S.linkProofs = !!out.link_proofs;
    const keep = S.rows?.find(r => r.key === S.selected)?.key ?? S.rows?.[0]?.key ?? '';
    if (keep) await open(keep); else { S.selected = ''; S.detail = null; }
  } catch (e) { S.loadError = M.errorText(S.t, /** @type {any} */ (e)?.code); }
}
async function open(/** @type {string} */ key) {
  S.selected = key;
  S.detail = await view(M.detailBody(key));
}

// ---- writes: one request id per intent, kept until a terminal answer ----
async function write(/** @type {object} */ body) {
  if (S.busy || S.pending) return;
  const id = randomID('cs', 12);
  S.pending = { request_id: id, body: M.actionBody(id, /** @type {any} */ (body)) };
  S.notice = null;
  await send();
}
async function send() {
  const p = S.pending; if (!p) return;
  S.busy = true; render();
  const c = M.classify(await bridge.call('action', p.body, p.request_id));
  S.busy = false;
  if (c.state === 'unknown' || c.state === 'busy') { S.notice = { kind: 'wait', text: c.state === 'busy' ? S.t.busy : S.t.unknown }; render(); return; }
  S.pending = null;
  if (c.state === 'rejected') { S.notice = { kind: 'info', text: M.errorText(S.t, c.code, c.message) }; render(); return; }
  S.notice = { kind: 'success', text: c.replayed ? S.t.replayed : S.t.done };
  S.tagDraft = ''; S.noteDraft = ''; S.proofDraft = '';
  await run(load);
}

// ---- DOM ----
/** @param {string} tag @param {Record<string, any>} [attrs] @param {(Node | string | false | null | undefined)[]} children */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') /** @type {any} */ (el).value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const locked = () => S.busy || !!S.pending;
const button = (/** @type {string} */ label, /** @type {() => void} */ onclick, cls = 'btn', disabled = false) => h('button', { type: 'button', class: cls, disabled, onclick }, label);
const pill = (/** @type {M.Status} */ st) => h('span', { class: `pill ${st}` }, S.t.status[st]);
const input = (/** @type {string} */ id, /** @type {string} */ value, /** @type {(v: string) => void} */ oninput, /** @type {string} */ label, max = 200) =>
  h('input', { id, class: 'input', maxlength: max, value, 'aria-label': label, placeholder: label, disabled: locked(), oninput: (/** @type {Event} */ e) => oninput(/** @type {HTMLInputElement} */ (e.target).value) });

function list() {
  const t = S.t;
  const rows = /** @type {M.Row[]} */ (S.rows);
  return h('div', { class: 'card list', role: 'listbox', 'aria-label': t.title },
    ...rows.map(r => h('button', { type: 'button', class: 'item', role: 'option', 'aria-selected': String(r.key === S.selected), onclick: () => void run(() => open(r.key)) },
      h('span', { class: 'line' }, h('b', {}, r.name), h('span', { class: 'muted' }, M.when(r.latest))),
      h('span', { class: 'line' }, pill(r.status), h('span', { class: 'muted' }, r.channels.join(' · ')), ...r.tags.map(tag => h('span', { class: 'tag' }, tag))))));
}

function detail() {
  const t = S.t, d = /** @type {M.Detail} */ (S.detail), c = d.customer;
  const human = d.control.owner === 'human' || d.control.state === 'waiting_human' || d.control.state === 'blocked';
  const head = h('div', { class: 'line wrap' },
    h('div', {}, h('b', { class: 'name' }, c.name), ' ', h('span', { class: 'pill done' }, c.levels.includes('asserted') ? t.verified : t.paired),
      h('p', { class: 'muted' }, `${c.principals.join(' · ')} · ${c.channels.join(' · ')}`)),
    h('div', { class: 'line' }, h('span', { class: `pill ${human ? 'need' : 'soot'}` }, human ? t.youHold : t.sootHolds),
      d.control.can_control && button(human ? t.resume : t.takeover, () => void write(M.controlBody(d.control)), human ? 'btn sm' : 'btn primary sm', locked())));
  const facts = h('section', { class: 'stack' }, h('h2', {}, t.facts),
    d.facts.length ? h('dl', { class: 'facts' }, ...d.facts.map(f => h('div', { class: 'fact' }, h('dt', {}, f.label), h('dd', {}, f.value)))) : h('p', { class: 'muted' }, d.facts_state === 'not_configured' ? t.factsOff : t.factsDown),
    d.facts.length > 0 && h('p', { class: 'muted' }, t.factsNote));
  const memory = h('section', { class: 'stack' }, h('h2', {}, t.memory),
    d.memory.length ? h('ul', { class: 'plain' }, ...d.memory.map(m => h('li', {}, m.content))) : h('p', { class: 'muted' }, t.noMemory));
  const tags = h('section', { class: 'stack' }, h('h2', {}, t.tags),
    h('div', { class: 'line wrap' }, ...d.tags.map(x => h('span', { class: 'tag' }, x.tag, ' ', button('×', () => void write(M.tagBody(c.key, x.tag, true)), 'btn ghost xs', locked())))),
    h('div', { class: 'line' }, input('tag', S.tagDraft, v => { S.tagDraft = v; }, t.addTag, 32), button(t.addTag, () => void write(M.tagBody(c.key, S.tagDraft)), 'btn', locked())));
  const notes = h('section', { class: 'stack' }, h('h2', {}, t.notes),
    ...d.notes.map(n => h('div', { class: 'note' }, h('p', {}, n.body), h('p', { class: 'muted' }, `${n.author} · ${M.when(n.at)}`, ' ', button(t.delete, () => void write({ kind: 'note_delete', key: d.customer.key, id: n.id }), 'btn ghost xs', locked())))),
    h('textarea', { id: 'note', class: 'input', rows: 2, maxlength: 2000, 'aria-label': t.addNote, disabled: locked(), oninput: (/** @type {Event} */ e) => { S.noteDraft = /** @type {HTMLTextAreaElement} */ (e.target).value; } }, S.noteDraft),
    button(t.addNote, () => void write(M.noteBody(c.key, S.noteDraft)), 'btn', locked()));
  const links = h('section', { class: 'stack' }, h('h2', {}, t.links),
    ...d.links.map(l => h('div', { class: 'line' }, h('span', {}, l.alias), h('span', { class: 'muted' }, l.proof), button(t.unlink, () => void write({ kind: 'unlink', key: d.customer.key, id: l.id }), 'btn ghost xs', locked()))),
    S.linkProofs ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, t.linkHelp),
      h('div', { class: 'line' }, input('proof', S.proofDraft, v => { S.proofDraft = v; }, t.link, 4096), button(t.link, () => void write(M.linkBody(S.proofDraft)), 'btn', locked())))
      : h('p', { class: 'muted' }, t.noLinkKeys));
  const timeline = h('section', { class: 'stack' }, h('h2', {}, t.timeline),
    ...d.timeline.map(m => h('div', { class: `msg ${m.role}${m.internal ? ' internal' : ''}` },
      h('p', { class: 'muted' }, `${m.author || m.channel} · ${m.channel} · ${M.when(m.at)}${m.internal ? ` · ${t.internal}` : ''}`), h('p', {}, m.text))));
  return h('div', { class: 'card detail' }, head, facts, memory, timeline, tags, notes, links);
}

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const focused = document.activeElement?.id;
  const out = [h('header', { class: 'head' }, h('h1', {}, t.title), h('p', { class: 'muted' }, t.purpose)),
    h('div', { class: 'line' }, input('q', S.q, v => { S.q = v; }, t.search, 100), button(t.reload, () => void run(load), 'btn', locked()))];
  if (S.loadError) out.push(h('div', { class: 'notice', role: 'alert' }, h('p', {}, S.loadError), button(t.reload, () => void run(load))));
  else if (!S.rows) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (S.rows.length === 0) out.push(h('p', { class: 'muted' }, t.none));
  else out.push(h('div', { class: 'cols' }, list(), S.detail ? detail() : h('p', { class: 'muted' }, t.loading)));
  if (S.pending && !S.busy) out.push(h('div', { class: 'line' }, button(t.retry, () => void send(), 'btn primary')));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: S.notice.kind === 'success' ? 'status' : 'alert' }, S.notice.text));
  root.replaceChildren(...out);
  if (focused) /** @type {HTMLElement | null} */ (document.getElementById(focused))?.focus();
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
}

})();
})();
