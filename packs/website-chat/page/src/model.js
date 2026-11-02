// @ts-check
// Live chat settings page (D6.2): the request bodies this pack's tools accept,
// the answers they give, and the words a person reads. Pure, so the tests
// prove the page and the tools agree without a browser. The gateway's own
// limits stay the gateway's: the page only refuses what the tools refuse.

/** @typedef {{ soot: string, domains: string[], name: string, logo?: string, theme: 'light' | 'dark' | 'auto', position: 'left' | 'right', greeting: string, quick_replies: string[], sheets?: unknown }} Config */
/** @typedef {{ id: string, revision: number, published_revision: number, paused: boolean, draft: Config, published: Config | null }} Site */
/** @typedef {{ id: string, name: string }} SiteItem */
/** @typedef {{ sites: SiteItem[], next: number, soots: string[], publicURL: string }} Overview */

export const SITE_ID = /^[^\x00-\x1f]{1,100}$/;
export const QUICK_REPLIES = 5;
const THEMES = ['light', 'dark', 'auto'], POSITIONS = ['left', 'right'];

// ---- bodies: exactly the tools' parameters (website_view / website_action) ----
export const listSites = (after = 0) => ({ action: 'list', limit: 100, ...(after > 0 ? { after } : {}) });
export const getSite = (/** @type {string} */ id) => ({ action: 'get', site_id: id });

/** The first configuration of a new site; the gateway checks the rest. @param {string} soot */
export const defaultConfig = soot => ({ soot, domains: ['https://example.com'], name: 'Hỗ trợ', logo: '', theme: 'light', position: 'right', greeting: 'Chào bạn! Tôi có thể giúp gì?', quick_replies: ['Tư vấn sản phẩm', 'Gặp nhân viên'] });

/**
 * One write. The request id is the person's intent: the page keeps it until a
 * terminal answer and resends the same body, never a new id.
 * @param {'create' | 'save' | 'publish' | 'pause' | 'resume'} action
 * @param {string} requestID @param {{ site?: Site, config?: Config }} on
 */
export function actionBody(action, requestID, on = {}) {
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
export function parseOverview(out) {
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
export function parseSite(out) {
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
export function classify(result) {
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
export function viewOutput(result) {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  const out = /** @type {any} */ (result.output);
  if (out?.error) throw Object.assign(new Error('refused'), { code: str(out.error.code) || 'request_rejected' });
  return out;
}

// ---- editing ----
/** Lines of a textarea: trimmed, empty ones dropped. @param {string} text */
export const splitLines = (text, max = 100) => text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, max);

/** Whether the draft differs from the saved one. @param {Config} a @param {Config} b */
export const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

/**
 * The embed snippet, or "" when the host's public address is not one a
 * website may load a script from (https, or http on this machine).
 * @param {string} publicURL @param {string} siteID
 */
export function embedSnippet(publicURL, siteID) {
  let url;
  try { url = new URL(publicURL); } catch { return ''; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{1,100}$/.test(siteID)) return '';
  const base = url.href.replace(/\/$/, '');
  return `<script async src="${base}/widget/v1.js" data-site="${siteID}"></script>`;
}

// ---- words ----
export const STRINGS = {
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
export const strings = locale => locale === 'en' ? STRINGS.en : STRINGS.vi;
/** The words for a refusal code. @param {ReturnType<typeof strings>} t @param {string} code */
export const errorText = (t, code) => Object.hasOwn(t.errors, code) ? t.errors[code] : t.rejected(code);
