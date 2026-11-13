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
// Live chat settings page (D6.2): the request bodies this pack's tools accept,
// the answers they give, and the words a person reads. Pure, so the tests
// prove the page and the tools agree without a browser. The gateway's own
// limits stay the gateway's: the page only refuses what the tools refuse.

/** @typedef {{ soot: string, domains: string[], name: string, logo?: string, theme: 'light' | 'dark' | 'auto', position: 'left' | 'right', greeting: string, quick_replies: string[], sheets?: unknown }} Config */
/** @typedef {{ id: string, revision: number, published_revision: number, paused: boolean, draft: Config, published: Config | null }} Site */
/** @typedef {{ id: string, name: string }} SiteItem */
/** @typedef {{ sites: SiteItem[], next: number, soots: string[], publicURL: string }} Overview */

const SITE_ID = /^[^\x00-\x1f]{1,100}$/;
const QUICK_REPLIES = 5;
const THEMES = ['light', 'dark', 'auto'], POSITIONS = ['left', 'right'];

// ---- bodies: exactly the tools' parameters (website_view / website_action) ----
const listSites = (after = 0) => ({ action: 'list', limit: 100, ...(after > 0 ? { after } : {}) });
const getSite = (/** @type {string} */ id) => ({ action: 'get', site_id: id });

/** The first configuration of a new site; the gateway checks the rest. @param {string} soot */
const defaultConfig = soot => ({ soot, domains: ['https://example.com'], name: 'Hỗ trợ', logo: '', theme: 'light', position: 'right', greeting: 'Chào bạn! Tôi có thể giúp gì?', quick_replies: ['Tư vấn sản phẩm', 'Gặp nhân viên'] });

/**
 * One write. The request id is the person's intent: the page keeps it until a
 * terminal answer and resends the same body, never a new id.
 * @param {'create' | 'save' | 'publish' | 'pause' | 'resume'} action
 * @param {string} requestID @param {{ site?: Site, config?: Config }} on
 */
function actionBody(action, requestID, on = {}) {
  if (action === 'create') {
    if (!on.config) throw new Error('create needs a config');
    return { action, request_id: requestID, config: on.config };
  }
  if (!on.site) throw new Error(`${action} needs a site`);
  return { action, request_id: requestID, site_id: on.site.id, expected_revision: on.site.revision, ...(action === 'save' ? { config: on.config ?? on.site.draft } : {}) };
}

// ---- answers ----
const str = (/** @type {unknown} */ v) => typeof v === 'string' ? v : '';
const int = (/** @type {unknown} */ v) => Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : 0;
const lines = (/** @type {unknown} */ v) => Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];

/** A list answer, shape-checked. @param {any} out @returns {Overview} */
function parseOverview(out) {
  const sites = (Array.isArray(out?.sites) ? out.sites : []).flatMap((/** @type {any} */ s) => typeof s?.id === 'string' && SITE_ID.test(s.id) ? [{ id: s.id, name: str(s.draft?.name) || s.id }] : []);
  const caps = out?.capabilities ?? {};
  return { sites, next: int(out?.next_after), soots: lines(caps.soots), publicURL: str(caps.public_url) };
}

/** @param {any} c @returns {Config} */
function parseConfig(c) {
  return { soot: str(c?.soot), domains: lines(c?.domains), name: str(c?.name), logo: str(c?.logo), theme: THEMES.includes(c?.theme) ? c.theme : 'light',
    position: POSITIONS.includes(c?.position) ? c.position : 'right', greeting: str(c?.greeting), quick_replies: lines(c?.quick_replies), ...(c?.sheets ? { sheets: c.sheets } : {}) };
}

/** A site answer, or null when it is not one. @param {any} out @returns {Site | null} */
function parseSite(out) {
  if (!out || typeof out.id !== 'string' || !SITE_ID.test(out.id) || !out.draft) return null;
  return { id: out.id, revision: int(out.revision), published_revision: int(out.published_revision), paused: out.paused === true, draft: parseConfig(out.draft), published: out.published ? parseConfig(out.published) : null };
}

/** Bridge codes after which a write may have run: keep the request id. */
const LOST = new Set(['no_response', 'request_in_flight', 'timeout', 'result_unknown', 'unavailable', 'page_call_failed']);

/**
 * What a write's answer means for its pending request id.
 * @param {import('./bridge.js').CallResult} result
 * @returns {{ state: 'done', site: Site, replayed: boolean } | { state: 'unknown' | 'busy' } | { state: 'conflict' | 'rejected', code: string }}
 */
function classify(result) {
  if (!result.ok) {
    const { code } = result.error;
    if (code === 'busy' || code === 'reloading') return { state: 'busy' };
    if (LOST.has(code) || /^http_5\d\d$/.test(code)) return { state: 'unknown' };
    return { state: 'rejected', code };
  }
  const out = /** @type {any} */ (result.output);
  if (out?.error) {
    const code = str(out.error.code) || 'request_rejected';
    return code === 'revision_conflict' ? { state: 'conflict', code } : { state: 'rejected', code };
  }
  const site = parseSite(out);
  return site ? { state: 'done', site, replayed: result.replayed === true || result.receipt?.replayed === true } : { state: 'unknown' };
}

/** A read's output, or an Error carrying its code. @param {import('./bridge.js').CallResult} result */
function viewOutput(result) {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  const out = /** @type {any} */ (result.output);
  if (out?.error) throw Object.assign(new Error('refused'), { code: str(out.error.code) || 'request_rejected' });
  return out;
}

// ---- editing ----
/** Lines of a textarea: trimmed, empty ones dropped. @param {string} text */
const splitLines = (text, max = 100) => text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, max);

/** Whether the draft differs from the saved one. @param {Config} a @param {Config} b */
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

/**
 * The embed snippet, or "" when the host's public address is not one a
 * website may load a script from (https, or http on this machine).
 * @param {string} publicURL @param {string} siteID
 */
function embedSnippet(publicURL, siteID) {
  let url;
  try { url = new URL(publicURL); } catch { return ''; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{1,100}$/.test(siteID)) return '';
  const base = url.href.replace(/\/$/, '');
  return `<script async src="${base}/widget/v1.js" data-site="${siteID}"></script>`;
}

// ---- words ----
const STRINGS = {
  vi: {
    title: 'Live chat trên website', purpose: 'Đặt một khung chat lên website của bạn để khách trò chuyện với Soot ngay tại đó.',
    loading: 'Đang tải…', none: 'Chưa có khung chat nào.', create: 'Tạo khung chat', retryCreate: 'Thử lại tạo khung chat',
    site: 'Khung chat', soot: 'Soot trả lời khách', reload: 'Tải bản mới', publish: 'Phát hành', pause: 'Tạm dừng', resume: 'Mở lại',
    name: 'Tên hiển thị', greeting: 'Lời chào', domains: 'Website được phép (mỗi dòng một địa chỉ https)', quick: `Câu trả lời nhanh (mỗi dòng một câu, tối đa ${QUICK_REPLIES})`,
    theme: 'Giao diện', themes: { light: 'Sáng', dark: 'Tối', auto: 'Theo thiết bị' }, position: 'Vị trí', positions: { left: 'Góc trái', right: 'Góc phải' },
    save: 'Lưu thay đổi', retry: 'Thử lại cùng yêu cầu', discard: 'Bỏ thay đổi', check: 'Kiểm tra lại',
    embed: 'Nhúng vào website', embedHint: 'Phát hành bản nháp rồi dán đoạn mã này lên website.', copy: 'Sao chép đoạn mã', copied: 'Đã sao chép đoạn mã.',
    noEmbed: 'Máy chủ chưa có địa chỉ công khai cho khung chat.',
    status: (/** @type {Site} */ s) => [`Bản nháp v${s.revision}`, s.published_revision ? `Đã phát hành v${s.published_revision}` : 'Chưa phát hành', s.paused ? 'Đang tạm dừng' : '', s.published_revision && s.revision > s.published_revision ? 'Bản đã lưu chưa được phát hành' : ''].filter(Boolean).join(' · '),
    saveFirst: 'Lưu thay đổi trước.', remote: 'Có cấu hình mới từ chat. Bản đang sửa của bạn được giữ lại.',
    done: { create: 'Đã tạo khung chat.', save: 'Đã lưu. Bấm Phát hành để website dùng bản mới.', publish: 'Đã phát hành.', pause: 'Đã tạm dừng khung chat.', resume: 'Đã mở lại khung chat.' },
    replayed: 'Yêu cầu này đã chạy trước đó; đây là kết quả của lần đó.',
    unknown: 'Chưa xác nhận yêu cầu đã hoàn tất. Thử lại sẽ dùng cùng mã yêu cầu.', busy: 'Máy chủ đang bận. Thử lại sau giây lát.',
    loadFailed: 'Chưa tải được Live chat. Kiểm tra kết nối cổng Live chat của Soot rồi thử lại.',
    errors: /** @type {Record<string, string>} */ ({
      revision_conflict: 'Cấu hình đã đổi từ chat hoặc người khác. Bản sửa của bạn vẫn được giữ; tải bản mới trước khi lưu.',
      request_conflict: 'Mã yêu cầu đã dùng với nội dung khác. Tải lại cấu hình để kiểm tra.',
      configuration_denied: 'Kết nối này chưa được cấp quyền cấu hình.',
      site_unavailable: 'Website chưa được phát hành hoặc đang tạm dừng.',
      request_rejected: 'Cổng Live chat từ chối yêu cầu này.',
    }),
    rejected: (/** @type {string} */ code) => `Cổng Live chat chưa nhận thay đổi này (${code}).`,
  },
  en: {
    title: 'Website live chat', purpose: 'Put a chat box on your website so visitors talk to the Soot right there.',
    loading: 'Loading…', none: 'No chat box yet.', create: 'Create a chat box', retryCreate: 'Retry creating the chat box',
    site: 'Chat box', soot: 'Soot that answers', reload: 'Load latest', publish: 'Publish', pause: 'Pause', resume: 'Resume',
    name: 'Display name', greeting: 'Greeting', domains: 'Allowed websites (one https address per line)', quick: `Quick replies (one per line, at most ${QUICK_REPLIES})`,
    theme: 'Theme', themes: { light: 'Light', dark: 'Dark', auto: 'Follow device' }, position: 'Position', positions: { left: 'Bottom left', right: 'Bottom right' },
    save: 'Save changes', retry: 'Retry the same request', discard: 'Discard changes', check: 'Check again',
    embed: 'Embed on your website', embedHint: 'Publish the draft, then paste this snippet into your website.', copy: 'Copy snippet', copied: 'Snippet copied.',
    noEmbed: 'The server has no public address for the chat box yet.',
    status: (/** @type {Site} */ s) => [`Draft v${s.revision}`, s.published_revision ? `Published v${s.published_revision}` : 'Not published', s.paused ? 'Paused' : '', s.published_revision && s.revision > s.published_revision ? 'Saved changes are not published' : ''].filter(Boolean).join(' · '),
    saveFirst: 'Save your changes first.', remote: 'A newer configuration came from chat. Your edits are kept.',
    done: { create: 'Chat box created.', save: 'Saved. Publish so the website uses it.', publish: 'Published.', pause: 'Chat box paused.', resume: 'Chat box resumed.' },
    replayed: 'This request already ran; this is its result.',
    unknown: 'Not confirmed yet. Retrying uses the same request id.', busy: 'The server is busy. Try again in a moment.',
    loadFailed: 'Could not load live chat. Check the Soot\'s live chat gateway connection and try again.',
    errors: /** @type {Record<string, string>} */ ({
      revision_conflict: 'The configuration changed from chat or someone else. Your edits are kept; load the latest before saving.',
      request_conflict: 'That request id was used with different content. Reload to check.',
      configuration_denied: 'This connection may not change the configuration.',
      site_unavailable: 'The website is not published or is paused.',
      request_rejected: 'The live chat gateway refused this request.',
    }),
    rejected: (/** @type {string} */ code) => `The live chat gateway did not take this change (${code}).`,
  },
};

/** @param {string} locale */
const strings = locale => locale === 'en' ? STRINGS.en : STRINGS.vi;
/** The words for a refusal code. @param {ReturnType<typeof strings>} t @param {string} code */
const errorText = (t, code) => Object.hasOwn(t.errors, code) ? t.errors[code] : t.rejected(code);
return { SITE_ID, QUICK_REPLIES, listSites, getSite, defaultConfig, actionBody, parseOverview, parseSite, classify, viewOutput, splitLines, changed, embedSnippet, STRINGS, strings, errorText };
})();

// ---- src/app.js ----
const __app = (() => {
// Live chat settings page (D6.2): the website chat setup Nest used to build
// in, now this pack's own `settings` page. Plain DOM, no framework, no
// network: every read and write goes through the soot-pages bridge to
// website_view / website_action. Text is set with textContent only.
const { createBridge, applyTheme, randomID } = __bridge;
const M = __model;

/** @typedef {import('./model.js').Site} Site */
/** @typedef {import('./model.js').Config} Config */

const S = {
  t: M.strings('vi'), started: false,
  /** @type {import('./model.js').Overview | null} */ overview: null,
  /** @type {Site | null} */ site: null, /** @type {Config | null} */ draft: null,
  remoteRevision: 0, busy: false, loadError: '',
  /** @type {{ action: string, request_id: string, body: object } | null} */ pending: null,
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
const dirty = () => !!(S.site && S.draft && M.changed(S.draft, S.site.draft));
const locked = () => S.busy || !!S.pending;
const failText = (/** @type {any} */ e) => e?.code === 'busy' ? S.t.busy : S.t.loadFailed;

async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } catch (e) { S.notice = { kind: 'info', text: failText(e) }; } finally { S.busy = false; render(); }
}

async function load(keep = S.site?.id) {
  S.loadError = '';
  try {
    S.overview = M.parseOverview(await view(M.listSites()));
    const id = keep && S.overview.sites.some(s => s.id === keep) ? keep : S.overview.sites[0]?.id;
    if (id) await open(id); else { S.site = null; S.draft = null; }
  } catch (e) { S.loadError = failText(e); }
}
async function open(/** @type {string} */ id) {
  const site = M.parseSite(await view(M.getSite(id)));
  if (!site) throw Object.assign(new Error('not a site'), { code: 'request_rejected' });
  S.site = site; S.draft = structuredClone(site.draft); S.remoteRevision = 0;
}

// ---- writes: one request id per intent, kept until a terminal answer ----
async function write(/** @type {'create' | 'save' | 'publish' | 'pause' | 'resume'} */ action) {
  if (locked()) return;
  const config = action === 'create' ? M.defaultConfig(S.overview?.soots[0] ?? '') : S.draft ?? undefined;
  const id = randomID('lc', 12);
  S.pending = { action, request_id: id, body: M.actionBody(action, id, { site: S.site ?? undefined, config }) };
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
  if (c.state === 'conflict' || c.state === 'rejected') { S.notice = { kind: 'info', text: M.errorText(S.t, c.code) }; render(); return; }
  S.site = c.site; S.draft = structuredClone(c.site.draft); S.remoteRevision = 0;
  S.notice = { kind: 'success', text: c.replayed ? S.t.replayed : /** @type {any} */ (S.t.done)[p.action] };
  await run(() => load(c.site.id));
}

function edit(/** @type {Partial<Config>} */ patch) {
  if (!S.draft || locked()) return;
  S.draft = { ...S.draft, ...patch }; S.notice = null; render();
}

// A newer revision from chat replaces a clean draft and keeps a dirty one.
async function poll() {
  if (!S.site || S.busy || S.pending) return;
  try {
    const fresh = M.parseSite(await view(M.getSite(S.site.id)));
    if (!fresh || fresh.revision === S.site.revision) return;
    if (dirty()) { S.remoteRevision = fresh.revision; } else { S.site = fresh; S.draft = structuredClone(fresh.draft); }
    render();
  } catch { /* the next manual reload shows a connection error */ }
}

async function copy(/** @type {string} */ text) {
  try { await navigator.clipboard.writeText(text); S.notice = { kind: 'success', text: S.t.copied }; } catch { S.notice = { kind: 'info', text: text }; }
  render();
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
const button = (/** @type {string} */ label, /** @type {() => void} */ onclick, cls = 'btn', disabled = false, title = '') => h('button', { type: 'button', class: cls, disabled, title: title || undefined, onclick }, label);
let uid = 0;
function field(/** @type {string} */ label, /** @type {HTMLElement} */ control) {
  const id = `f${++uid}`; control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control);
}
function select(/** @type {string} */ value, /** @type {[string, string][]} */ options, /** @type {(v: string) => void} */ onchange, disabled = false) {
  return h('select', { class: 'input', disabled, onchange: (/** @type {Event} */ e) => onchange(/** @type {HTMLSelectElement} */ (e.target).value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}
const textInput = (/** @type {string} */ value, /** @type {(v: string) => void} */ oninput, max = 200) => h('input', { class: 'input', maxlength: max, value, disabled: locked(), oninput: (/** @type {Event} */ e) => oninput(/** @type {HTMLInputElement} */ (e.target).value) });
const area = (/** @type {string} */ value, /** @type {(v: string) => void} */ oninput) => h('textarea', { class: 'input', rows: 3, disabled: locked(), oninput: (/** @type {Event} */ e) => oninput(/** @type {HTMLTextAreaElement} */ (e.target).value) }, value);

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const focused = document.activeElement?.id;
  const out = [h('header', { class: 'head' }, h('h1', {}, t.title), h('p', { class: 'muted' }, t.purpose))];
  if (S.loadError) out.push(h('div', { class: 'notice info', role: 'alert' }, h('p', {}, S.loadError), button(t.check, () => void run(load))));
  else if (!S.overview) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else {
    const creating = S.pending?.action === 'create';
    const bar = h('div', { class: 'row' });
    if (S.site && S.overview.sites.length > 1) bar.append(field(t.site, select(S.site.id, S.overview.sites.map(s => [s.id, s.name]), id => void run(() => open(id)), locked() || dirty())));
    bar.append(button(creating ? t.retryCreate : t.create, () => void (creating ? send() : write('create')), 'btn', S.busy || dirty() || (!!S.pending && !creating)));
    if (S.site) bar.append(button(t.reload, () => void run(() => open(/** @type {Site} */ (S.site).id)), 'btn ghost', locked()));
    out.push(bar);
    if (!S.site) out.push(h('p', { class: 'muted' }, t.none));
  }
  if (S.site && S.draft && S.overview) {
    const site = S.site, d = S.draft, isDirty = dirty(), blocked = locked() || isDirty;
    out.push(h('div', { class: 'row' }, h('p', { class: 'muted grow', role: 'status' }, t.status(site)),
      button(t.publish, () => void write('publish'), 'btn primary', blocked, isDirty ? t.saveFirst : ''),
      button(site.paused ? t.resume : t.pause, () => void write(site.paused ? 'resume' : 'pause'), 'btn ghost', blocked, isDirty ? t.saveFirst : '')));
    if (S.remoteRevision > site.revision) out.push(h('p', { class: 'notice info', role: 'status' }, t.remote));
    out.push(h('section', { class: 'stack', 'aria-label': t.title },
      S.overview.soots.length > 1 && field(t.soot, select(d.soot, S.overview.soots.map(s => [s, s]), v => edit({ soot: v }), locked() || !!site.published)),
      field(t.name, textInput(d.name, v => edit({ name: v }), 64)),
      field(t.greeting, area(d.greeting, v => edit({ greeting: v }))),
      field(t.quick, area(d.quick_replies.join('\n'), v => edit({ quick_replies: M.splitLines(v, M.QUICK_REPLIES) }))),
      field(t.domains, area(d.domains.join('\n'), v => edit({ domains: M.splitLines(v) }))),
      h('div', { class: 'row' },
        field(t.theme, select(d.theme, Object.entries(t.themes), v => edit({ theme: /** @type {Config['theme']} */ (v) }), locked())),
        field(t.position, select(d.position, Object.entries(t.positions), v => edit({ position: /** @type {Config['position']} */ (v) }), locked())))));
    if (isDirty || (S.pending && S.pending.action !== 'create')) out.push(h('div', { class: 'row savebar' },
      button(S.pending ? t.retry : t.save, () => void (S.pending ? send() : write('save')), 'btn primary', S.busy),
      button(t.discard, () => { if (S.pending) return; S.draft = structuredClone(site.draft); S.notice = null; render(); }, 'btn ghost', S.busy || !!S.pending)));
    const snippet = M.embedSnippet(S.overview.publicURL, site.id);
    out.push(h('section', { class: 'stack' }, h('h2', {}, t.embed),
      snippet ? h('p', { class: 'muted' }, t.embedHint) : h('p', { class: 'muted' }, t.noEmbed),
      snippet && h('pre', { class: 'mono', tabindex: 0 }, snippet),
      snippet && button(t.copy, () => void copy(snippet))));
  }
  if (S.busy) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: S.notice.kind === 'success' ? 'status' : 'alert' }, S.notice.text));
  root.replaceChildren(...out);
  if (focused) /** @type {HTMLElement | null} */ (document.getElementById(focused))?.focus();
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
  setInterval(() => void poll(), 5000);
}

})();
})();
