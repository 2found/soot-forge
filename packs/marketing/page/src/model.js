// @ts-check
// The desk's words and the bodies it sends. Pure: no DOM, no kit, so the page
// tests run it in node. page_view answers with codes and arguments only
// (tools/lib/desk.mjs); every sentence the founder reads is made here, in
// Vietnamese. A number the desk could not read is null and reads "—" (or
// "Chưa đo được" on a tile), never 0.

export const TZ = 'Asia/Ho_Chi_Minh';
// Reddit is no longer a column of its own: it is one target of Cộng đồng (with Hacker News, dev.to).
export const CHANNELS = ['blog', 'x', 'facebook', 'tiktok', 'community', 'newsletter'];
export const CH = { blog: 'Blog', x: 'X', facebook: 'Facebook', tiktok: 'TikTok', community: 'Cộng đồng', newsletter: 'Bản tin', reddit: 'Reddit' };
export const CHM = { blog: 'B', x: 'X', facebook: 'f', tiktok: 'T', community: 'C', newsletter: '@', reddit: 'R' };
/** Where a community post goes. */
export function targetText(t) {
  if (!t) return 'Cộng đồng';
  if (t.kind === 'reddit') return t.sub ? `r/${t.sub}` : 'Reddit';
  if (t.kind === 'hn') return 'Hacker News';
  if (t.kind === 'devto') return 'dev.to';
  return t.name || 'Nơi khác';
}
/** The page where the founder submits a community post (https only), or null. */
export function submitUrl(t) {
  if (t?.kind === 'reddit' && /^[A-Za-z0-9_]{2,21}$/.test(t.sub ?? '')) return `https://www.reddit.com/r/${t.sub}/submit`;
  if (t?.kind === 'hn') return 'https://news.ycombinator.com/submit';
  if (t?.kind === 'devto') return 'https://dev.to/new';
  return null;
}
export const STAGES = [
  { id: 'idea', label: 'Ý tưởng', icon: 'bulb' },
  { id: 'making', label: 'Đang làm', icon: 'pen' },
  { id: 'approval', label: 'Chờ duyệt', icon: 'hourglass' },
  { id: 'scheduled', label: 'Sắp lên', icon: 'cal' },
  { id: 'live', label: 'Đã lên', icon: 'check_circle' },
];
export const TABS = [
  { id: 'today', label: 'Hôm nay', icon: 'activity' },
  { id: 'content', label: 'Nội dung', icon: 'layers' },
  { id: 'channels', label: 'Kênh đăng', icon: 'radio' },
  { id: 'library', label: 'Thư viện', icon: 'folder' },
  { id: 'numbers', label: 'Số liệu', icon: 'chart' },
];
export const FORMAT = { blog: 'Bài blog', social: 'Bài mạng xã hội', video: 'Tập video', community: 'Bài cộng đồng', newsletter: 'Bản tin', launch: 'Gói ra mắt' };
// Plain words (glossary, spec §G): the founder reads roles, never internal names.
export const WHO = { writer: 'Người viết', editor: 'Biên tập', poster: 'Máy đăng', builder: 'Người dựng video', desk: 'Bàn Marketing', founder: 'Bạn' };
/** Who a new item goes to, as the button says it. */
export const MAKER = { blog: 'Người viết', social: 'Người viết', community: 'Người viết', newsletter: 'Người viết', launch: 'Người viết', video: 'Người dựng video' };
export const LANG = { vi: 'Tiếng Việt', en: 'English' };
export const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const ITEM_REF = /^MK-[0-9A-Z]{6}$/;
const HOUR = 3_600_000;

// ---------- time and numbers ----------

const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** The local (Việt Nam) parts of a moment, or null. @param {string | number | null | undefined} v */
export function local(v) {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) return null;
  /** @type {Record<string, string>} */
  const p = {};
  for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`, dm: `${p.day}/${p.month}`, ms };
}
const dayNo = (/** @type {{y:number,m:number,d:number}} */ p) => Date.UTC(p.y, p.m - 1, p.d) / 86_400_000;
/** Whole local days from `v` to now: 0 today, 1 yesterday, -1 tomorrow. */
export function dayDiff(v, now) {
  const a = local(v), b = local(now);
  return a && b ? dayNo(b) - dayNo(a) : null;
}
/** "09:00 hôm nay", "21:30 hôm qua", "07:00 mai", "09:00 24/11"; "" without a time. */
export function when(v, now) {
  const p = local(v);
  if (!p) return '';
  const d = dayDiff(v, now);
  return d === 0 ? `${p.hm} hôm nay` : d === 1 ? `${p.hm} hôm qua` : d === -1 ? `${p.hm} mai` : `${p.hm} ${p.dm}`;
}
/** "hôm nay", "hôm qua", "mai" or "24/11". */
export function day(v, now) {
  const p = local(v);
  if (!p) return '';
  const d = dayDiff(v, now);
  return d === 0 ? 'hôm nay' : d === 1 ? 'hôm qua' : d === -1 ? 'mai' : p.dm;
}
export const hm = (v) => local(v)?.hm ?? '';
export const hoursSince = (v, now) => (local(v) ? Math.max(0, Math.floor((now - Date.parse(v)) / HOUR)) : null);
/** vi-VN thousands with a dot; null (not read) is "—", a read zero stays "0". */
export function num(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
/** "23/11 – 29/11" of a numbers view's week. */
export function weekLabel(week) {
  const a = local(week?.from), b = local(week?.to);
  return a && b ? `${a.dm} – ${b.dm}` : '';
}

// ---------- requests ----------

/** A request id from getRandomValues (an opaque-origin frame may lack randomUUID). */
export function requestId(prefix = 'mk', random = globalThis.crypto) {
  const b = random.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`;
}
const APPROVAL_KEYS = ['id', 'state', 'ref', 'created_at', 'decided_at', 'expires_at', 'reason'];
/** The team_waits query's answer as the count page_view takes: its total, clamped; null when it could not be read. */
export function cardCount(out) {
  const n = out?.total;
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 10000) : null;
}
/** The approvals query's answer, cut to what page_view takes back: rows that name an item, at most 100. */
export function compactApprovals(out) {
  const list = Array.isArray(out?.approvals) ? out.approvals : [];
  return list.filter(a => a && typeof a.id === 'string' && typeof a.ref === 'string' && a.ref).slice(0, 100).map(a => {
    /** @type {Record<string, any>} */
    const row = {};
    for (const k of APPROVAL_KEYS) if (a[k] !== undefined) row[k] = k === 'reason' && typeof a[k] === 'string' ? a[k].slice(0, 500) : a[k];
    return row;
  });
}
const VIEW_KEYS = ['product', 'stage', 'cursor', 'ref', 'key', 'node', 'week', 'live', 'with_summary', 'cards'];
/** A page_view body: the view, its own keys when set, and the approvals when they were read. */
export function viewBody(view, opts = {}, approvals = null) {
  /** @type {Record<string, any>} */
  const body = { view };
  for (const k of VIEW_KEYS) if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') body[k] = opts[k];
  if (Array.isArray(approvals)) body.approvals = approvals;
  return body;
}
/** A page_action body: the op, its fields (undefined dropped) and the request id the receipt is kept under. */
export function actionBody(op, fields, rid) {
  /** @type {Record<string, any>} */
  const body = { op };
  for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined) body[k] = v;
  body.request_id = rid;
  return body;
}
/** One stable key per intent: a retry after an unknown outcome sends the same request id. */
export const intentKey = (op, fields) => JSON.stringify([op, fields ?? {}]);

/** A tool answer: its error is thrown with its code. */
export function output(out) {
  if (out && typeof out === 'object' && out.error && typeof out.error === 'object') {
    const e = /** @type {Error & {code?: string}} */ (new Error(String(out.error.message ?? '')));
    e.code = String(out.error.code ?? 'failed');
    throw e;
  }
  return out;
}
/** An outcome the page cannot know: the same request id is sent again, never a new one. */
export const unknownOutcome = (e) => ['timeout', 'result_unknown', 'request_in_flight', 'no_response'].includes(e?.code);
const ERRORS = {
  invalid_request: 'Yêu cầu chưa đúng. Tải lại màn hình rồi thử lại.',
  not_found: 'Không còn thấy mục này. Có thể nó vừa đổi; tải lại để xem bản mới.',
  conflict: 'Mục này vừa đổi ở nơi khác. Tải lại để xem bản mới.',
  bad_url: 'Link chưa đúng dạng.',
  needs_credential: 'Bàn Marketing còn thiếu một khoá. Mở Kho khóa để nhập.',
  credential_missing: 'Bàn Marketing còn thiếu một khoá. Mở Kho khóa để nhập.',
  hub_refused: 'Máy chủ đăng bài không nhận thay đổi này.',
  hub_unreachable: 'Máy chủ đăng bài không trả lời. Thử lại sau ít phút.',
  hub_timeout: 'Máy chủ đăng bài không trả lời kịp. Thử lại sau ít phút.',
  hub_rate_limited: 'Máy chủ đăng bài đang hết lượt đọc trong phút này. Chờ một phút rồi thử lại.',
  hub_unauthorized: 'Máy chủ đăng bài từ chối khoá của bàn Marketing.',
  folder_refused: 'Không ghi được vào thư mục site. Kiểm lại thư mục ở Bắt đầu marketing.',
  no_root: 'Chưa chọn thư mục marketing. Chọn ở Kho khóa rồi thử lại.',
  product_exists: 'Đã có sản phẩm tên này. Đặt tên khác hoặc sửa sản phẩm đang có.',
  path_refused: 'Thư mục marketing không cho ghi vào đường dẫn này.',
  approval_required: 'Việc này cần bạn duyệt trong Cần bạn.',
  rate_limited: 'Bấm hơi nhanh. Chờ vài giây rồi thử lại.',
  busy: 'Bàn đang bận. Thử lại sau vài giây.',
  owner_unavailable: 'Biên tập đang không nhận việc. Thử lại sau.',
  not_authorized: 'Bạn không có quyền làm việc này.',
  unsupported: 'Bản Nest này chưa hỗ trợ việc này. Cập nhật Nest rồi thử lại.',
  no_host: 'Màn hình này chỉ chạy trong Nest.',
  timeout: 'Nest chưa trả lời. Bấm lại để hỏi kết quả; việc không làm hai lần.',
  result_unknown: 'Chưa biết việc đã xong chưa. Bấm lại để hỏi; việc không làm hai lần.',
  request_in_flight: 'Việc này đang chạy. Chờ một chút rồi bấm lại.',
  input_too_large: 'Nội dung quá dài.',
  gesture_required: 'Màn hình chỉ gửi được khi bạn bấm nút trên đó. Bấm lại nút.',
  tool_refused: 'Bàn chưa nhận việc này. Thử lại sau ít phút.',
  ask_failed: 'Biên tập chưa nhận được tin. Thử lại sau ít phút.',
  profile_in_use: 'Hồ sơ này đang dùng cho một tài khoản TikTok khác. Mỗi tài khoản một hồ sơ.',
  browser_profile_unknown: 'Nest không còn hồ sơ trình duyệt này. Tải lại rồi chọn hồ sơ khác.',
  profiles_unread: 'Marketing chưa được cấp quyền đọc hồ sơ trình duyệt.',
  handle_invalid: 'Tên tài khoản chỉ gồm chữ, số, dấu chấm và gạch dưới, 2–24 ký tự.',
  account_exists: 'Bàn đã có tài khoản TikTok này.',
};
/** What a failed call says to the founder. */
export const errorText = (e) => ERRORS[e?.code] ?? 'Chưa làm được. Thử lại sau ít phút.';

// ---------- links the page checks before it sends ----------

const URLS = {
  x: /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}(\?.*)?$/,
  facebook: /^https:\/\/(www\.|m\.)?facebook\.com\/\S+$/,
  tiktok: /^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]{1,30}\/video\/\d{5,25}(\?.*)?$/,
  reddit: /^https:\/\/(www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]{2,21}\/comments\/[a-z0-9]{4,12}(\/\S*)?$/,
  hn: /^https:\/\/news\.ycombinator\.com\/item\?id=\d{4,12}$/,
  devto: /^https:\/\/dev\.to\/[A-Za-z0-9_-]{1,40}\/[a-z0-9-]{3,200}$/,
  other: /^https:\/\/[^\s/]+\.[^\s]{2,}$/,
  blog: /^https:\/\/[^\s/]+\.[^\s]{2,}$/,
};
export const validUrl = (channel, url) => !!URLS[channel]?.test(String(url ?? '').trim());
export const URL_HINT = {
  x: 'Link có dạng https://x.com/<tài khoản>/status/<số>.',
  facebook: 'Link là địa chỉ bài trên facebook.com.',
  tiktok: 'Link có dạng https://www.tiktok.com/@<kênh>/video/<số>.',
  reddit: 'Link bài trên Reddit, có dạng https://www.reddit.com/r/<nhóm>/comments/….',
  hn: 'Link có dạng https://news.ycombinator.com/item?id=<số>.',
  devto: 'Link bài trên dev.to.',
  other: 'Link bài đã đăng, bắt đầu bằng https://.',
  blog: 'Link bài trên trang của bạn, khi trang đã lên.',
};
/** The link rule of a community post: its target's kind. */
export const communityKind = (t) => (['reddit', 'hn', 'devto'].includes(t?.kind) ? t.kind : 'other');
/** A profile page to look for a post on, from an account like "@acme". */
export function profileUrl(channel, account) {
  const handle = /^@?([A-Za-z0-9_]{1,15})$/.exec(String(account ?? ''))?.[1];
  if (channel === 'x' && handle) return `https://x.com/${handle}`;
  return null;
}
/** Only https links reach soot.open from data. */
export const safeLink = (v) => (typeof v === 'string' && /^https:\/\/[^\s/]+\.[^\s]*$/.test(v) && v.length <= 2048 ? v : null);

// ---------- products ----------

/** {id → {name, mark}} from a summary's products. */
export function productMap(products) {
  /** @type {Record<string, {id: string, name: string, mark: string, site: string | null}>} */
  const m = {};
  for (const p of products ?? []) m[p.id] = { id: p.id, name: p.name ?? p.id, mark: p.mark ?? String(p.name ?? p.id).slice(0, 2), site: p.site ?? null };
  return m;
}
const pname = (ctx, id) => (id ? ctx.products?.[id]?.name ?? id : 'Kênh khác');

// ---------- headline ----------

/** The one line under the title: what matters now. */
export function statusText(status, ctx) {
  const a = status?.args ?? {};
  const now = ctx.now;
  const next = (n) => (n?.at ? ` Bài kế tiếp ${n.about ? 'khoảng ' : ''}${when(n.at, now)} trên ${CH[n.channel] ?? n.channel}${n.product && !ctx.product ? `, ${pname(ctx, n.product)}` : ''}.` : '');
  switch (status?.code) {
    case 'hub_busy': return { tone: 'wait', icon: 'clock', text: 'Máy chủ đăng bài đang hết lượt đọc trong phút này. Chờ một phút rồi tải lại; bài trên máy vẫn đủ.' };
    case 'hub_down': return { tone: 'err', icon: 'x_circle', text: 'Không đọc được máy chủ đăng bài. Bài trên đó chưa hiện; bài trên máy vẫn đủ.' };
    case 'x_returns': return { tone: 'err', icon: 'x_circle', text: `${a.account ?? 'Tài khoản'} đã đăng xuất: ${a.n} bài của ${pname(ctx, a.product)} về nháp ${when(a.time, now) || 'sớm'} nếu chưa đăng nhập lại.` };
    case 'signed_out': return { tone: 'err', icon: 'x_circle', text: `${a.account ?? CH[a.channel] ?? 'Một kênh'} của ${pname(ctx, a.product)} đã đăng xuất. Bài lên kênh này đang đứng.` };
    case 'paused': return { tone: 'warn', icon: 'pause', text: `Bạn đang tạm dừng mọi lượt đăng${a.since ? ` từ ${when(a.since, now)}` : ''}. Bài đã duyệt nằm chờ.` };
    case 'setup': return { tone: '', icon: 'activity', text: 'Chưa có sản phẩm nào.' };
    case 'empty': return { tone: '', icon: 'activity', text: 'Chưa có bài nào. Tạo bài đầu tiên, xong thì nó nằm ở đây chờ bạn duyệt.' };
    case 'approvals': return { tone: 'warn', icon: 'hourglass', text: `${a.n} bài chờ bạn duyệt${a.asks ? `, ${a.asks} câu hỏi chờ bạn trả lời` : ''}${a.cards ? `, ${a.cards} việc của đội chờ bạn trong Cần bạn` : ''}${a.replies ? `, ${a.replies} bình luận cần bạn trả lời` : ''}.${a.posted_today ? ` Hôm nay đã lên ${a.posted_today} bài.` : ''}${next(a.next)}` };
    case 'waits': {
      const bits = [a.asks ? `${a.asks} câu hỏi chờ bạn trả lời` : null, a.handoffs ? `${a.handoffs} bài chờ bạn đăng hoặc gửi` : null, a.other ? `${a.other} bài đang đứng cần bạn xem` : null, a.replies ? `${a.replies} bình luận cần bạn trả lời` : null, a.cards ? `${a.cards} việc của đội chờ bạn trong Cần bạn` : null].filter(Boolean);
      return { tone: 'warn', icon: 'hourglass', text: `Đang chờ bạn: ${bits.join(', ')}.${a.posted_today ? ` Hôm nay đã lên ${a.posted_today} bài.` : ''}${next(a.next)}` };
    }
    case 'replies': return { tone: 'warn', icon: 'message', text: `${a.n} bình luận cần bạn trả lời.${next(a.next)}` };
    case 'healthy': return { tone: 'ok', icon: 'check_circle', text: `${a.n ? `Hôm nay đã lên ${a.n} bài.` : 'Không có gì giữ bài lại.'}${next(a.next)}` };
  }
  return { tone: '', icon: 'activity', text: '' };
}

// ---------- tiles ----------

const TILE = {
  published: { label: 'Đã lên, 7 ngày', icon: 'check_circle', tab: 'content', stage: 'live' },
  approval: { label: 'Chờ duyệt', icon: 'hourglass', tab: 'content', stage: 'approval' },
  scheduled: { label: 'Sắp lên', icon: 'cal', tab: 'content', stage: 'scheduled' },
  channels: { label: 'Kênh cần sửa', icon: 'radio', tab: 'channels', stage: null },
  reads: { label: 'Lượt đọc, 7 ngày', icon: 'chart', tab: 'numbers', stage: null },
};
const BLIND = {
  hub: ['Không lấy được', 'Chưa đọc được máy chủ đăng bài'],
  approvals_unread: ['Chưa đọc được', 'Nest chưa cho đọc thẻ duyệt'],
  search_console_not_connected: ['Chưa đo được', 'Chưa nối Search Console'],
  no_posts_yet: ['Chưa có', 'Chưa có bài nào lên'],
  // Hubless is a way of working: no máy đăng posts by itself, so no channel can stall.
  hubless: ['Không có', 'Chưa có máy đăng'],
};
/** A tile's words. A null value is blind: it says why, never 0. */
export function tileText(tile, ctx) {
  const base = TILE[tile.id] ?? { label: tile.id, icon: 'info', tab: 'today', stage: null };
  if (tile.value === null || tile.value === undefined) {
    const [value, sub] = BLIND[tile.why] ?? ['Chưa đo được', 'Chưa có nguồn số'];
    return { ...base, value, sub, tone: 'blind' };
  }
  const a = tile.sub_args ?? {};
  const tone = tile.tone === 'err' ? 'err' : tile.tone === 'wait' ? 'warn' : '';
  let sub = '';
  switch (tile.sub_code) {
    // The tile counts bài (items), as the Đã lên stage does; the line under it says how many lượt đăng they made.
    case 'published_posts': sub = a.posts ? `${num(a.posts)} lượt đăng trên ${a.channels} kênh` : 'Chưa có lượt đăng nào'; break;
    case 'oldest_wait': sub = `Lâu nhất ${a.hours} giờ`; break;
    case 'next': sub = ctx.hubless && a.handoff ? `${a.handoff} bài chờ bạn đăng` : a.at ? `Kế tiếp lúc ${when(a.at, ctx.now).replace(/ hôm nay$/, '')}` : a.handoff ? `${a.handoff} bài chờ bạn đăng` : tile.value ? 'Chờ máy đăng hoặc chờ bạn' : 'Chưa có lịch'; break;
    case 'first_fix': {
      const [p, ch] = String(a.key ?? ':').split(':');
      sub = `${pname(ctx, p)}: ${CH[ch] ?? ch} ${a.state === 'signed_out' ? 'đăng xuất' : 'tạm dừng'}`;
      break;
    }
    case 'search_clicks': sub = 'Lượt bấm từ Google'; break;
    // P2: before Search Console, the desk's own UTM links still count clicks; say which number it is.
    case 'link_clicks': sub = 'Bấm qua link của bàn; chưa có số Google'; break;
    case 'none': sub = { approval: 'Không có bài chờ', channels: 'Kênh đã nối đều chạy' }[tile.id] ?? ''; break;
  }
  return { ...base, value: num(tile.value), sub, tone };
}

// ---------- blockers ----------

const BK_ICON = { returns_to_draft: 'x_circle', signed_out: 'login', paused: 'pause', approval: 'hourglass', approval_late: 'alert', uncertain: 'help', changed: 'pen', missed: 'clock', handoff: 'video', handoff_community: 'users', handoff_newsletter: 'mail', handoff_newsletter_exported: 'mail', handoff_social: 'send', ask: 'message' };
const DO = { fix_channel: 'Sửa kênh', resume: 'Bật lại', read_approve: 'Đọc và duyệt', check_channel: 'Kiểm tra', open_item: 'Xem bài', post_by_hand: 'Đăng tay', send_newsletter: 'Gửi bản tin', answer: 'Xem câu hỏi' };
/** One "Vì sao bài chưa lên" line: what holds and the one button that fixes it. */
export function blockerText(b, ctx) {
  const a = b.title_args ?? {}, m = b.meta_args ?? {}, now = ctx.now;
  const ch = CH[a.channel] ?? a.channel ?? '';
  const t = a.title ? `: ${a.title}` : '';
  const titles = {
    returns: `${a.n} bài ${ch} về nháp ${when(a.time, now) || 'sớm'} nếu chưa đăng nhập lại`,
    signed_out: `${a.account ?? ch} trên ${ch} đã đăng xuất`,
    paused_all: 'Bạn đang tạm dừng mọi lượt đăng',
    approve: `${b.kind === 'approval_late' ? 'Duyệt gấp' : 'Chờ bạn duyệt'}${t}`,
    uncertain: `Chưa rõ bài ${ch} đã lên chưa${t}`,
    held_changed: `Bài đổi sau khi duyệt, chưa lên ${ch}${t}`,
    held_missed: `Lỡ giờ đăng ${ch}${t}`,
    held_failed: `Đăng ${ch} không được${t}`,
    held_returned_to_draft: `Bài ${ch} về nháp, cần duyệt lại${t}`,
    held_no_bundle: `Bài ${ch} chưa có bản duyệt${t}`,
    held_blog_not_live: `Bài ${ch} chờ blog lên trước${t}`,
    handoff: `${a.n} video chờ bạn đăng TikTok`,
    handoff_community: `${a.n} bài cộng đồng chờ bạn đăng${a.target ? ` lên ${a.target}` : ''}`,
    handoff_newsletter: `Bản tin chờ bạn gửi${t}`,
    handoff_newsletter_exported: `Bản tin đã xuất ra file, chờ bạn gửi${t}`,
    handoff_social: `${a.n} bài ${ch} chờ bạn đăng tay`,
    ask: `Chờ bạn trả lời${t}`,
  };
  const waited = () => {
    const bits = [m.hours ? `Chờ ${m.hours} giờ` : 'Vừa gửi duyệt'];
    if (m.first_at) bits.push(`lên sớm nhất ${when(m.first_at, now)}`);
    if (m.expires_at) bits.push(`thẻ duyệt hết hạn ${when(m.expires_at, now)}`);
    return bits.join(', ');
  };
  const metas = {
    signed_out_since: `${a.account ?? 'Tài khoản'} đăng xuất${m.since ? ` từ ${when(m.since, now)}` : ''}. Máy đăng không tự đăng nhập.`,
    paused_since: `Từ ${when(m.since, now) || 'trước đó'}. Bài đã duyệt nằm chờ.`,
    waiting: waited(),
    uncertain_since: `Máy đăng dừng giữa chừng ${when(m.at, now)}. Soot không tự đăng lại.`,
    slot: b.kind === 'missed' ? `Lẽ ra lên ${when(m.at, now)}. Không đăng trễ.` : m.at ? `Giờ đăng ${when(m.at, now)}` : '',
    asked: [a.question, m.at ? `Hỏi ${when(m.at, now)}` : null].filter(Boolean).join(' · '),
    oldest: `Lâu nhất từ ${when(m.at, now)}${m.title ? `: ${m.title}` : ''}`,
    approved: m.at ? `Duyệt ${when(m.at, now)}` : 'Đã duyệt',
  };
  const tone = b.tone === 'err' || b.kind === 'approval_late' ? 'err' : b.tone === 'wait' ? 'wait' : '';
  return { title: titles[b.title_code] ?? (a.title || b.kind), meta: metas[b.meta_code] ?? '', label: DO[b.do?.label_code] ?? 'Xem', icon: BK_ICON[b.kind] ?? 'info', tone };
}

// ---------- items ----------

/** The small tag at the end of an item row, and the square icon at its start. */
export function itemState(row, now) {
  const about = (row.plan ?? []).some(p => p.about && p.state === 'scheduled');
  switch (row.state) {
    case 'approval': {
      const h = hoursSince(row.waiting_since, now) ?? 0;
      return { tag: h < 1 ? 'Chờ duyệt' : `Chờ ${h} giờ`, tone: h >= 24 ? 'err' : 'wait', icon: 'hourglass' };
    }
    case 'granted': return { tag: 'Đã duyệt, Biên tập đang xếp lịch', tone: 'run', icon: 'check_circle' };
    case 'held': return { tag: HELD[row.note] ?? 'Đang đứng', tone: 'wait', icon: 'hourglass' };
    case 'uncertain': return { tag: 'Chưa rõ đã lên chưa', tone: 'wait', icon: 'help' };
    case 'handoff': return row.format === 'newsletter' ? { tag: 'Chờ bạn gửi', tone: 'idle', icon: 'mail' } : { tag: 'Bạn đăng tay', tone: 'idle', icon: row.format === 'video' ? 'video' : row.format === 'community' ? 'users' : 'send' };
    case 'exported': return { tag: 'Đã xuất, chờ bạn gửi', tone: 'idle', icon: 'mail' };
    case 'sending': return { tag: 'Biên tập đang gửi', tone: 'run', icon: 'send' };
    case 'written': return { tag: row.at ? `Đã ghi vào site ${day(row.at, now)}` : 'Đã ghi vào site', tone: 'ok', icon: 'check_circle' };
    case 'scheduled': return { tag: row.at ? `${about ? 'Khoảng ' : ''}${when(row.at, now)}` : 'Chờ máy đăng nhận', tone: 'idle', icon: 'cal' };
    case 'asked': return { tag: 'Đã giao', tone: 'run', icon: 'activity' };
    case 'waiting': return { tag: 'Chờ bạn trả lời', tone: 'wait', icon: 'message' };
    case 'no_channel': return { tag: 'Chưa có kênh', tone: 'wait', icon: 'alert' };
    case 'revising': return { tag: 'Người viết đang sửa', tone: 'run', icon: 'pen' };
    case 'stopped': return { tag: 'Bạn đã dừng', tone: 'idle', icon: 'stop' };
    case 'posted': return { tag: row.format === 'newsletter' ? (row.at ? `Đã gửi ${day(row.at, now)}` : 'Đã gửi') : row.at ? `Đã lên ${day(row.at, now)}` : 'Đã lên', tone: 'ok', icon: 'check_circle' };
    case 'idea': return { tag: '', tone: 'idle', icon: 'bulb' };
    case 'drafting': return row.note === 'approval_expired' ? { tag: 'Thẻ duyệt hết hạn', tone: 'wait', icon: 'pen' } : { tag: 'Nháp', tone: 'idle', icon: 'pen' };
  }
  return { tag: '', tone: 'idle', icon: 'file' };
}
const HELD = { missed: 'Lỡ giờ', changed: 'Đổi sau khi duyệt', returned_to_draft: 'Về nháp', failed: 'Đăng không được', signed_out: 'Đứng: đăng xuất', paused: 'Bạn tạm dừng', no_bundle: 'Chưa có bản duyệt', blog_not_live: 'Chờ blog lên' };
/** The second line of an item row. */
export function itemSub(row, ctx) {
  if (row.format === 'video') return [row.series ? `Series ${row.series}` : 'Video', row.channel_dir].filter(Boolean).join(' · ');
  if (row.state === 'revising' && row.note) return `Ghi chú của bạn: ${row.note}`;
  if (row.state === 'waiting' && row.note) return `Đội hỏi: ${row.note}`;
  if (row.state === 'asked') return `Đã giao${row.waiting_since ? ` ${when(row.waiting_since, ctx.now)}` : ''}${row.by && WHO[row.by] ? ` · ${WHO[row.by]}` : ''}`;
  if (row.state === 'no_channel') return 'Chưa có kênh nào để đăng bài này';
  const bits = [FORMAT[row.format] ?? row.format];
  if (row.format === 'community' && row.target) bits[0] = `${bits[0]} · ${targetText(row.target)}`;
  if (row.format === 'newsletter' && row.subscribers !== undefined) bits.push(row.subscribers === null ? 'chưa có danh sách người nhận' : `${num(row.subscribers)} người nhận`);
  if (row.files === false) bits.push('chưa có tệp');
  if (row.by) bits.push(WHO[row.by] ?? row.by);
  return bits.join(' · ');
}

/** A plan row ("Lên ở đâu, lúc nào"): where, when and its tag. */
export function planText(p, ctx, itemStateCode) {
  const now = ctx.now, ch = CH[p.channel] ?? p.channel;
  const at = (s) => (p.at ? `${s} ${p.about ? 'khoảng ' : ''}${when(p.at, now)}` : '');
  switch (p.state) {
    case 'after_approval':
      if (itemStateCode === 'granted') return { line: 'Bạn đã duyệt; Biên tập đang xếp giờ lên', tag: 'Đã duyệt', tone: 'run' };
      if (itemStateCode !== 'approval') return { line: 'Chưa gửi duyệt', tag: 'Nháp', tone: 'idle' };
      // With no hub nothing posts itself: the founder posts by hand and pastes the link.
      if (p.via === 'hand') return { line: 'Duyệt xong thì bạn đăng tay rồi dán link', tag: 'Chờ duyệt', tone: 'wait' };
      if (p.via === 'folder') return { line: 'Duyệt xong thì bàn ghi bài vào thư mục site', tag: 'Chờ duyệt', tone: 'wait' };
      if (p.via === 'send') return { line: 'Duyệt xong thì bạn bấm gửi', tag: 'Chờ duyệt', tone: 'wait' };
      if (p.via === 'export') return { line: 'Duyệt xong thì bạn xuất ra file rồi gửi bằng công cụ của bạn', tag: 'Chờ duyệt', tone: 'wait' };
      return { line: 'Lên theo nhịp sau khi bạn duyệt', tag: 'Chờ duyệt', tone: 'wait' };
    case 'scheduled': return p.reason === 'paused' ? { line: 'Bạn đang tạm dừng kênh này', tag: 'Tạm dừng', tone: 'wait' } : { line: p.waiting === 'poster' ? 'Chờ máy đăng nhận bài' : at('Lên') || 'Đã duyệt, chờ giờ đăng', tag: 'Đã lên lịch', tone: 'idle' };
    case 'publishing': return { line: 'Đang đăng', tag: 'Đang đăng', tone: 'run' };
    case 'posted': return { line: at('Đã lên') || 'Đã lên', tag: 'Đã lên', tone: 'ok' };
    case 'uncertain': return { line: `Máy đăng dừng giữa chừng${p.at ? ` ${when(p.at, now)}` : ''}`, tag: 'Chưa rõ', tone: 'wait' };
    case 'stopped': return { line: 'Bạn đã dừng, bài không lên', tag: 'Đã dừng', tone: 'idle' };
    case 'sending': return { line: 'Biên tập gửi khi bạn duyệt lần gửi trong Cần bạn', tag: 'Chờ duyệt lần gửi', tone: 'wait' };
    case 'exported': return { line: 'Đã xuất ra file; bạn gửi bằng công cụ của bạn', tag: 'Đã xuất', tone: 'idle' };
    case 'handoff': return { line: p.channel === 'tiktok' ? 'TikTok do bạn đăng tay' : p.channel === 'newsletter' ? 'Bạn bấm gửi hoặc xuất ra file' : p.channel === 'community' ? 'Bạn đăng rồi dán link' : 'Bạn đăng tay rồi dán link', tag: p.channel === 'newsletter' ? 'Chờ bạn gửi' : p.channel === 'community' ? 'Bạn đăng' : 'Bạn đăng tay', tone: 'idle' };
    case 'written': return { line: at('Đã ghi vào thư mục site') || 'Đã ghi vào thư mục site', tag: 'Đã ghi', tone: 'ok' };
    case 'no_account': return { line: p.channel === 'blog' ? 'Sản phẩm chưa có blog, bài này không lên' : `Chưa có tài khoản ${ch}, bài này không lên`, tag: 'Bỏ qua', tone: 'wait' };
    case 'channel_not_connected': return { line: `Có tài khoản ${p.account ?? ''} nhưng chưa nối, bài này không lên`, tag: 'Bỏ qua', tone: 'wait' };
    case 'held': {
      const why = {
        missed: `Lỡ giờ ${when(p.at, now)}; không đăng trễ`,
        changed: 'Bài đổi sau khi duyệt; duyệt lại bản mới thì lên',
        returned_to_draft: 'Về nháp; cần duyệt lại',
        failed: 'Đăng không được',
        signed_out: `Tài khoản đăng xuất${p.returns_at ? `; về nháp ${when(p.returns_at, now)}` : ''}`,
        paused: 'Bạn đang tạm dừng kênh này',
        no_bundle: 'Chưa có bản duyệt',
        blog_not_live: 'Chờ bài blog lên trước',
      }[p.reason];
      return { line: why ?? 'Đang đứng', tag: 'Đang đứng', tone: 'wait' };
    }
  }
  return { line: '', tag: '', tone: 'idle' };
}

// ---------- channels ----------

/** A product × channel cell: tone, state line and detail line. */
export function cellText(c) {
  const acc = c.account ?? '';
  switch (c.state) {
    case 'ok': return { tone: 'ok', l1: 'Đang chạy', l2: [acc, c.posted_7d === null || c.posted_7d === undefined ? null : `${c.posted_7d} lượt đăng, 7 ngày`].filter(Boolean).join(' · ') };
    case 'folder': return { tone: c.dir_ok === false ? 'err' : 'ok', l1: c.dir_ok === false ? 'Không ghi được' : 'Ghi vào thư mục', l2: c.dir_ok === false ? 'Thư mục site nằm ngoài thư mục marketing' : [c.dir, c.dir_ok === 'new' ? 'tạo khi ghi bài đầu' : null, c.posted_7d ? `${c.posted_7d} bài, 7 ngày` : null].filter(Boolean).join(' · ') };
    case 'by_hand': return { tone: '', l1: 'Bạn đăng', l2: c.channel === 'community' ? (c.targets ?? []).map(t => t.label ?? targetText(t)).join(', ') : [acc, c.waiting ? `${c.waiting} bài chờ` : null].filter(Boolean).join(' · ') };
    case 'email': return { tone: 'ok', l1: 'Gửi qua email', l2: c.subscribers === null || c.subscribers === undefined ? 'Chưa có danh sách' : `${num(c.subscribers)} người nhận` };
    case 'export': return { tone: '', l1: 'Xuất ra file', l2: c.subscribers === null || c.subscribers === undefined ? 'Chưa có danh sách' : `${num(c.subscribers)} người nhận` };
    case 'no_list': return { tone: 'wait', l1: 'Chưa có danh sách', l2: 'Dán danh sách người nhận' };
    case 'paused': return { tone: 'wait', l1: 'Bạn tạm dừng', l2: [acc, c.waiting ? `${c.waiting} bài chờ` : null].filter(Boolean).join(' · ') };
    case 'signed_out': return { tone: 'err', l1: 'Đã đăng xuất', l2: [acc, `${c.waiting ?? 0} bài đứng`].filter(Boolean).join(' · ') };
    case 'not_connected': return { tone: 'none', l1: 'Có tài khoản, chưa nối', l2: acc };
    case 'no_account': return { tone: c.drafts ? 'wait' : 'none', l1: 'Chưa có tài khoản', l2: c.drafts ? `${c.drafts} nháp chờ` : '' };
    case 'manual': return { tone: '', l1: 'Bạn đăng tay', l2: c.channel === 'tiktok' ? (c.waiting ? `${c.waiting} video chờ đăng` : acc) : [acc, c.waiting ? `${c.waiting} bài chờ` : null].filter(Boolean).join(' · ') };
    case 'unknown': return c.why === 'hubless' ? { tone: '', l1: 'Bạn đăng tay', l2: '' } : { tone: 'none', l1: 'Không lấy được', l2: 'Chưa đọc được máy chủ đăng bài' };
    case 'off': return { tone: 'none', l1: c.why === 'no_blog' ? 'Chưa có blog' : 'Không dùng', l2: '' };
  }
  return { tone: 'none', l1: '—', l2: '' };
}
/**
 * A profile's sign-in, from Nest's own state (`sign_in` of a cell or an account line): "Đã đăng nhập · 09:00 hôm nay",
 * "Đã đăng xuất · …", "Chưa đăng nhập", or "—" with why it cannot be told (the pack is not granted to read it: `grant`
 * is the link that grants it). Null without a profile.
 */
export function signInText(si, now) {
  if (!si) return null;
  const at = si.at ? when(si.at, now) : '';
  if (si.state === 'signed_in') return { text: at ? `Đã đăng nhập · ${at}` : 'Đã đăng nhập', tone: 'ok' };
  if (si.state === 'signed_out') return { text: at ? `Đã đăng xuất · ${at}` : 'Đã đăng xuất', tone: 'err' };
  if (si.state === 'never') return { text: 'Chưa đăng nhập', tone: 'wait' };
  const why = si.why === 'no_grant' ? 'Marketing chưa được cấp quyền đọc hồ sơ trình duyệt.'
    : si.why === 'browser_profile_unknown' ? 'Máy này không có hồ sơ trình duyệt này.' : 'Chưa đọc được trạng thái từ Nest.';
  return { text: '—', tone: 'idle', why, grant: si.why === 'no_grant' ? si.grant ?? null : null };
}
/**
 * T3: one browser profile in an account's picker, from the channel view's `profiles.list`. `label` is the option's
 * words (its name, then who may open it, or the account it already posts for); `taken` is that other account (the
 * option is disabled: one profile signs in one account).
 */
export function profileChoice(p, channel) {
  const taken = p.bound && p.bound.channel !== channel ? p.bound.account ?? 'một tài khoản khác' : null;
  const grant = p.granted === 'team' ? 'đã cấp cho đội' : p.granted === 'soot' ? `đã cấp cho ${num(p.allowed ?? 1)} Soot` : 'chưa cấp cho Soot nào';
  return { label: `${p.name}${p.project ? ` (${p.project})` : ''} · ${taken ? `đang dùng cho ${taken}` : grant}`, taken };
}
/** What choosing profile `p` means, under the picker: its TikTok sign-in, then whether a Soot can open it at all. */
export function profileHint(p, now) {
  if (!p) return 'Mỗi tài khoản một hồ sơ. Máy đăng mở hồ sơ này để đăng video.';
  const si = signInText({ state: p.sign_in?.state ?? null, at: p.sign_in?.at ?? null }, now);
  const signIn = p.sign_in?.state === 'signed_in' ? `TikTok: ${si.text.toLowerCase()}.` : 'TikTok chưa đăng nhập trên hồ sơ này: tài khoản tạm dừng tới khi bạn đăng nhập.';
  return p.granted === 'none' ? `${signIn} Chưa Soot nào mở được hồ sơ này: cấp trong Kho khóa.` : signIn;
}
/** A TikTok handle as the person types it (with or without @), or null when it is not one. */
export function tiktokHandle(v) {
  const h = String(v ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{2,24}$/.test(h) ? h : null;
}
/** The toast after a binding (set_limits {browser_profile}) or an added account (add_account). */
export function bindToast(out, name) {
  if (!out) return '';
  const b = out.binding ?? out;
  const use = out.usage?.set && !out.usage.set.ok ? ' Kho khóa chưa ghi được dòng Dùng cho.' : '';
  if (out.op === 'add_account') {
    if (out.signed_in_as) return `Đã thêm ${out.account}. Hồ sơ đang đăng nhập TikTok bằng ${out.signed_in_as}: đăng nhập ${out.account} trên hồ sơ này để tài khoản chạy.${use}`;
    return `Đã thêm ${out.account}. ${out.paused ? `Đăng nhập TikTok trên hồ sơ${name ? ` ${name}` : ''} để tài khoản chạy.` : 'Hồ sơ đã đăng nhập TikTok, tài khoản chạy ngay.'}${use}`;
  }
  if (out.profile === null) return 'Đã bỏ hồ sơ khỏi tài khoản. Máy đăng không đăng cho tài khoản này tới khi bạn chọn hồ sơ.';
  if (b.unchanged) return `Tài khoản vẫn dùng hồ sơ ${name ?? 'này'}.${use}`;
  if (b.signed_in_as) return `Đã đổi hồ sơ. Hồ sơ đang đăng nhập TikTok bằng ${b.signed_in_as}: đăng nhập đúng tài khoản rồi bật lại.${use}`;
  return `Đã đổi sang hồ sơ ${name ?? 'mới'}. ${b.resumed ? 'Hồ sơ đã đăng nhập TikTok, tài khoản chạy lại.' : b.paused && b.paused_reason === 'signed_out' ? 'Đăng nhập TikTok trên hồ sơ này để tài khoản chạy.' : 'Lượt đăng tới dùng hồ sơ này.'}${use}`;
}
/** One account line of a TikTok cell: its state and the one thing to do about it. */
export function accountText(a) {
  if (a.state === 'ok') return { label: 'Đang chạy', tone: 'ok', action: { id: 'pause', label: 'Tạm dừng' } };
  if (a.state === 'signed_out') return { label: 'Đã đăng xuất', tone: 'err', action: { id: 'sign_in', label: 'Đăng nhập' } };
  return { label: a.paused_reason === 'signed_in' ? 'Đã đăng nhập, chờ bật lại' : 'Bạn tạm dừng', tone: 'wait', action: { id: 'resume', label: 'Bật lại' } };
}
/** A Claude Code job of the desk's Nội dung (marketing video ledger) in a person's words. A running job's log is the
 *  session's own; its last words are only readable once it ends. */
export function jobText(j, now) {
  const clip = (/** @type {any} */ s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : '');
  switch (j.state) {
    case 'running': return { tone: 'wait', icon: 'hourglass', tag: 'Đang chạy',
      sub: `${j.minutes === null || j.minutes === undefined ? 'Đang làm video' : `Đã chạy ${num(j.minutes)} phút`}. Xem được nhật ký khi phiên kết thúc.` };
    case 'waiting': return { tone: 'idle', icon: 'clock', tag: 'Chờ máy rảnh',
      sub: `Máy đang bận${j.running?.length ? ` với ${j.running.map((/** @type {any} */ r) => r.title || r.key).filter(Boolean).slice(0, 2).join(', ')}` : ''}, nên chưa bắt đầu. Lượt sau tự làm lại.` };
    case 'done': return { tone: 'ok', icon: 'check_circle', tag: 'Xong',
      sub: `${j.ended_at ? `Xong ${when(j.ended_at, now)}. ` : ''}${j.posts?.length ? 'Video đã thành nháp, chờ bạn duyệt.' : 'Không có nháp mới.'}` };
    case 'failed': return { tone: 'err', icon: 'x_circle', tag: 'Lỗi',
      sub: `${j.ended_at ? `Dừng ${when(j.ended_at, now)}: ` : 'Dừng: '}${clip(j.error, 160) || 'phiên báo lỗi'}.${j.log_tail ? ` Lời cuối: “${clip(j.log_tail, 200)}”` : ''}` };
  }
  return { tone: 'idle', icon: 'info', tag: '', sub: '' };
}
/** What a channel sheet says first about its state. */
export function cellWhat(c, productName) {
  const ch = CH[c.channel] ?? c.channel;
  switch (c.state) {
    case 'ok': return c.via === 'browser' ? 'Máy đăng bài trên Mac này đăng qua trình duyệt, theo nhịp bên dưới.' : c.channel === 'blog' ? 'Máy chủ đăng bài đưa bài blog đã duyệt lên theo nhịp bên dưới.' : 'Máy chủ đăng bài đăng thẳng bài đã duyệt theo nhịp bên dưới.';
    case 'folder': return c.dir_ok === false ? `Thư mục site của ${productName} không ghi được. Sửa ở Bắt đầu marketing rồi bài duyệt xong mới ghi vào được.` : `Duyệt xong, bàn ghi bài blog thành file Markdown vào thư mục site của ${productName}. Bạn đưa trang lên như mọi khi; dán link bài khi trang đã lên để có số Google.`;
    case 'by_hand': return c.channel === 'community' ? 'Người viết soạn bài, bạn duyệt rồi tự đăng. Soot không đăng lên Reddit, Hacker News hay dev.to. Dán link bài Reddit thì Soot theo dõi bình luận.' : `Chưa có máy đăng cho ${ch}: duyệt xong bạn đăng tay rồi dán link.`;
    case 'email': return 'Duyệt xong, bạn bấm Gửi bản tin; Biên tập gửi qua email và Nest hỏi bạn duyệt lần gửi đó một lần nữa. Bàn chỉ đếm người nhận, không hiện địa chỉ.';
    case 'export': return 'Đội chưa có cách gửi email, nên duyệt xong bàn xuất bản tin ra file để bạn gửi bằng công cụ của bạn. Bàn chỉ đếm người nhận, không hiện địa chỉ.';
    case 'no_list': return 'Chưa có danh sách người nhận. Dán danh sách vào bàn (mỗi dòng một địa chỉ); bàn chỉ đếm số người, không hiện địa chỉ ra đây.';
    case 'paused': return 'Bạn đang tạm dừng kênh này. Bài đã duyệt nằm chờ, không có gì tự lên.';
    case 'signed_out': return `Máy đăng mở ${ch} thì gặp trang đăng nhập. Máy đăng không tự đăng nhập, không gõ mật khẩu. Bài đã duyệt đang đứng; quá 48 giờ thì về nháp và cần duyệt lại.`;
    case 'not_connected': return `Tài khoản ${c.account ?? ''} có rồi nhưng chưa nối vào máy chủ đăng bài, nên chưa có bài nào lên kênh này.`;
    case 'no_account': return `${productName} chưa có tài khoản ${ch} riêng.${c.drafts ? ` ${c.drafts} nháp đang chờ.` : ''}`;
    case 'manual': return c.channel === 'tiktok' ? `Máy đăng chưa có tài khoản TikTok nào của ${productName}. Video xong thì bạn đăng rồi dán link vào đây.` : `Chưa có máy đăng cho ${ch}: duyệt xong bạn đăng tay rồi dán link.`;
    case 'unknown': return c.why === 'hubless' ? `Chưa có máy đăng cho ${ch}: duyệt xong bạn đăng tay rồi dán link.` : 'Chưa đọc được máy chủ đăng bài, nên chưa biết kênh này ra sao.';
    case 'off': return c.why === 'no_blog' ? `${productName} chưa có blog: Người viết chỉ soạn bài mạng xã hội, cộng đồng và bản tin.` : c.channel === 'community' ? 'Sản phẩm này chưa đăng lên cộng đồng nào. Thêm nơi đăng khi thiết lập sản phẩm.' : c.channel === 'newsletter' ? 'Sản phẩm này chưa có bản tin.' : c.why === 'not_chosen' ? `Lúc thiết lập bạn không chọn ${ch} cho ${productName}, nên Người viết không soạn bài cho kênh này.` : 'Sản phẩm này chưa dùng kênh này.';
  }
  return '';
}
/** The steps a channel sheet lists to fix it. */
export function stepText(s, c) {
  const ch = CH[c.channel] ?? c.channel;
  switch (s.id) {
    case 'sign_in': return { title: `Đăng nhập ${s.args?.account ?? ch}`, hint: s.args?.profile
      ? `Trên hồ sơ trình duyệt ${s.args.profile}: đăng nhập trên trang vừa mở rồi bấm Tôi đã đăng nhập. Máy đăng tự chạy lại sau đó.`
      : 'Ở Kho khóa › Đăng nhập trình duyệt, chọn hồ sơ của tài khoản này rồi đăng nhập.', button: 'Đăng nhập' };
    case 'budget': return { title: 'Cho máy đăng đủ ngân sách', hint: 'Bàn chưa đọc được ngân sách của máy đăng. Xem ở Cần bạn nếu nó báo hết.', button: 'Mở Cần bạn' };
    case 'resume': return { title: s.args?.account ? `Bật lại ${s.args.account}` : 'Bật lại kênh', hint: 'Máy đăng nhận bài ở lượt kế tiếp.', button: s.args?.channel ? 'Bật lại' : null };
    case 'connect': return { title: `Nối ${ch} vào máy chủ đăng bài`, hint: 'Biên tập soạn sẵn các bước cho bạn.', button: 'Nhờ Biên tập' };
    case 'create_account': return { title: `Tạo tài khoản ${ch} riêng`, hint: 'Tài khoản đang có chỉ đăng cho sản phẩm khác.', button: null };
  }
  return { title: s.id, hint: '', button: null };
}
/** The cell states in which the desk itself puts posts out, so a daily cap means something. */
const POSTS = ['ok', 'paused', 'signed_out', 'folder'];
/** "1 bài, 3 X, 3 Facebook mỗi ngày, nghỉ 23:00–07:00" from a channels row's cadence; with the row's cells, only the
 *  channels that can actually post (a cap on a channel nobody posts to is noise). */
export function cadenceText(cadence, cells) {
  if (!cadence) return '';
  const can = (ch) => cadence[ch] && (!cells || POSTS.includes(cells[ch]?.state));
  const parts = [];
  if (can('blog')) parts.push(`${cadence.blog.cap_per_day} blog`);
  if (can('x')) parts.push(`${cadence.x.cap_per_day} X`);
  if (can('facebook')) parts.push(`${cadence.facebook.cap_per_day} Facebook`);
  if (!parts.length) return '';
  const q = (can('x') ? cadence.x : can('facebook') ? cadence.facebook : cadence.blog)?.quiet;
  return `${parts.join(', ')} mỗi ngày${q ? `, nghỉ ${q.from}–${q.to}` : ''}`;
}
/** The publishing-server row of Kênh đăng. Unbound is a way of working (hubless), not a fault. */
export function hubLine(hub, source, ctx) {
  if (!hub || hub.error === 'not_configured') return { tone: 'idle', text: 'Chưa nối · bài blog ghi vào thư mục site của từng sản phẩm', fix: 'connect' };
  if (hub.ok) return { tone: 'ok', text: [`Đăng blog cho ${hub.sites?.length ?? 0} trang`, source?.ms ? `trả lời sau ${num(source.ms)} ms` : null].filter(Boolean).join(' · '), fix: null };
  const last = source?.last_ok_at ? ` · lần cuối đọc được ${when(source.last_ok_at, ctx.now)}` : '';
  if (hub.error === 'unauthorized') return { tone: 'err', text: `Từ chối khoá của bàn Marketing${last}`, fix: 'connect' };
  const why = hub.error === 'timeout' ? 'Không trả lời kịp' : hub.error === 'rate_limited' ? 'Hết lượt đọc trong phút này' : 'Không trả lời';
  return { tone: hub.error === 'rate_limited' ? 'wait' : 'err', text: `${why}${last}`, fix: 'retry' };
}
/** The máy đăng row of Kênh đăng; its budget and skips are not read yet (null + why). */
export function posterLine(poster, ctx) {
  if (!poster) return { tone: 'idle', text: 'Chưa có · bài X, Facebook do bạn đăng tay rồi dán link' };
  const seen = poster.seen_at ? `Hỏi bài lần cuối ${when(poster.seen_at, ctx.now)}` : 'Chưa thấy máy đăng hỏi bài';
  return { tone: poster.paused ? 'wait' : poster.seen_at ? 'ok' : 'wait', text: `${seen} · ngân sách và lượt bỏ qua: chưa đọc được` };
}

// ---------- numbers ----------

const WHY = {
  hub: 'Chưa đọc được máy chủ đăng bài',
  by_hand: 'Bạn đăng tay: chưa có nguồn số',
  search_console_not_connected: 'Chưa nối Search Console',
  signed_out: 'Kênh đã đăng xuất',
  not_read_yet: 'Chưa đọc số từ kênh này',
  no_metrics_file: 'Chưa ghi video nào',
  hubless: 'Chưa có máy chủ đăng bài: chưa có nguồn số',
};
export function whyText(code, args) {
  if (code === 'no_posted_links') return `${args?.n ?? 0} video chưa ghi link đăng`;
  return WHY[code] ?? '';
}

// ---------- library ----------

export function nodeLabel(n, ctx) {
  switch (n.kind) {
    case 'product': return n.label ?? pname(ctx, n.product);
    case 'other': return 'Kênh khác';
    case 'posts': return 'Bài viết';
    case 'campaigns': return 'Chiến dịch';
    case 'metrics': return 'Số liệu video';
    case 'radar': { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(n.label ?? ''); return m ? `Radar ${m[3]}/${m[2]}` : `Radar ${n.label}`; }
  }
  return n.label ?? n.id;
}
export const NODE_ICON = { posts: 'file', channel: 'clapper', series: 'layers', campaigns: 'folder', radar: 'radar', metrics: 'table', product: 'folder', other: 'folder' };
/** The first node worth opening in a tree: the first product's posts. */
export function firstNode(tree) {
  for (const g of tree ?? []) for (const n of g.children ?? []) return n.id;
  return null;
}
/** Video stages from the campaign folders ("01-brief" …): label, done. */
export function stageLabel(dir) {
  const m = /^(\d\d)-([a-z0-9-]+)$/.exec(dir ?? '');
  const words = { material: 'Tư liệu', product: 'Sản phẩm', audience: 'Người xem', research: 'Tìm hiểu', trends: 'Xu hướng', strategy: 'Hướng làm', scripts: 'Kịch bản', pretest: 'Thử trước', video: 'Dựng video', delivery: 'Bàn giao' };
  return m ? words[m[2]] ?? m[2].replace(/-/g, ' ') : String(dir ?? '');
}
const DAY_MS = 86_400_000;
/** The id of the ISO week before or after one ("2026-W47"), moving by whole weeks. */
export function shiftWeek(id, by) {
  const m = /^(\d{4})-W(\d{2})$/.exec(id ?? '');
  if (!m) return null;
  const jan4 = Date.UTC(+m[1], 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (+m[2] - 1 + by) * 7 * DAY_MS;
  const thu = new Date(monday + 3 * DAY_MS), y = thu.getUTCFullYear();
  const j4 = Date.UTC(y, 0, 4), mon1 = j4 - ((new Date(j4).getUTCDay() + 6) % 7) * DAY_MS;
  return `${y}-W${String(Math.floor((monday - mon1) / (7 * DAY_MS)) + 1).padStart(2, '0')}`;
}

// ---------- markdown, as text ----------

/** A blog body as blocks, for text nodes only: [{kind: 'h'|'p'|'li', text}]. Markup is dropped, never parsed into HTML. */
export function blocks(md, max = 80) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ kind: 'p', text: para.join(' ') }); para = []; };
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trim();
    const plain = (s) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]{1,3}/g, '').trim();
    if (!line) { flush(); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const li = /^([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ kind: 'h', text: plain(h[1]) }); } else if (li) { flush(); out.push({ kind: 'li', text: plain(li[2]) }); } else para.push(plain(line));
    if (out.length >= max) break;
  }
  flush();
  return out.filter(b => b.text).slice(0, max);
}

// ---------- phase 2: learning, replies, pretest, setup (spec §3–§9) ----------

/** Where a top post's number came from: Google (Search Console) or the site's own UTM links. */
export function topLine(p) {
  if (p.basis === 'gsc') return [p.clicks === null || p.clicks === undefined ? null : `${num(p.clicks)} lượt bấm`, p.impressions ? `${num(p.impressions)} lượt hiện trên Google` : null].filter(Boolean).join(' · ');
  if (p.basis === 'utm') return `${num(p.clicks)} lượt bấm qua link của bàn`;
  return 'Chưa đo được';
}
/** A search query worth a post: what people typed, how often Google showed the site, where it ranked. */
export function queryLine(q) {
  return [`${num(q.impressions)} lượt hiện`, q.position ? `hạng ${Math.round(q.position)}` : null, q.covered ? 'đã có bài' : 'chưa có bài nào'].filter(Boolean).join(' · ');
}
/** The one missing input of the learning block, as its title, hint and fix. */
export function inputText(code, ctx = {}) {
  switch (code) {
    case 'gsc_not_connected': return { title: 'Chưa có số Google', hint: 'Nối Search Console thì bàn biết bài nào được tìm, người ta gõ gì.', fix: 'ask_gsc', button: 'Nhờ Biên tập nối' };
    case 'gsc_sign_in': return { title: 'Search Console chờ bạn đăng nhập Google', hint: ctx.at ? `Biên tập hỏi ${when(ctx.at, ctx.now)}. Đăng nhập xong thì số về sau lượt đọc tới.` : 'Đăng nhập xong thì số về sau lượt đọc tới.', fix: 'needs', button: 'Mở Cần bạn' };
    case 'gsc_stale': return { title: 'Số Google đã cũ', hint: ctx.at ? `Đọc lần cuối ${when(ctx.at, ctx.now)}.` : 'Chưa đọc lại được.', fix: 'ask_gsc', button: 'Nhờ Biên tập đọc lại' };
    case 'no_signals': return { title: 'Radar tuần này trống', hint: 'Không có tín hiệu mới để gợi ý đề tài.', fix: null, button: null };
    case 'video_links': return { title: `${ctx.n ?? 0} video chưa có link`, hint: 'Dán link thì có lượt xem 48 giờ và 7 ngày.', fix: 'video_links', button: 'Dán link' };
  }
  return { title: code, hint: '', fix: null, button: null };
}
const AWARE = { unaware: 'người chưa biết mình có vấn đề này', problem: 'người đã thấy vấn đề, chưa biết cách giải', choosing: 'người đang chọn giữa các lựa chọn' };
/** Why the plan suggests this topic next: the server sends a code and its numbers; the words are made here. */
export function nextWhy(n) {
  const a = n?.why_args ?? {};
  switch (n?.why) {
    case 'plan_topic': return `Đề tài kế hoạch tuần này đã chọn${AWARE[a.awareness] ? `, viết cho ${AWARE[a.awareness]}` : ''}.`;
    case 'uncovered_query': return `${num(a.impressions)} lượt hiện trên Google${a.position ? `, hạng ${Math.round(a.position)}` : ''}, chưa có bài nào.`;
  }
  // An older server sent the sentence itself.
  return typeof n?.why === 'string' && n.why.includes(' ') ? n.why : '';
}
export const NEED_LABEL = { complaint: 'Phàn nàn', money: 'Tiền', account: 'Chuyển Hỗ trợ', flagged: 'Cần xem' };
const NEED_HINT = {
  // complaint and money: the tag says it; the card header says Soot does not answer them.
  account: 'Hỏi về tài khoản. Chuyển cho Hỗ trợ hoặc trả lời riêng.',
  flagged: 'Biên tập thấy lạ nên để bạn xem.',
};
/** One "Cần trả lời" row: the comment, where it is, why it waits for the founder. */
export function replyText(r, ctx) {
  return {
    tag: NEED_LABEL[r.class] ?? 'Cần xem',
    tone: r.class === 'complaint' || r.class === 'money' ? 'wait' : 'idle',
    where: [CH[r.channel] ?? r.channel, r.thread_title ? `dưới “${r.thread_title}”` : null, r.at ? when(r.at, ctx.now) : null].filter(Boolean).join(' · '),
    hint: r.class in NEED_LABEL ? (NEED_HINT[r.class] ?? null) : NEED_HINT.flagged,
  };
}
/** What a pre-test needs before its first run: Micro Fish runs its readers in a simulation workspace of their own. */
export const PRETEST_NEEDS = 'Lần đầu cần lập một chỗ chạy người đọc giả lập (một nhóm riêng từ mẫu Simulated society); Lead lập giúp trong một lần.';
/** The one message that sets a pre-test up: Micro Fish for the Editor plus the simulation workspace. */
export const PRETEST_SETUP_ASK = 'Lập chỗ chạy người đọc giả lập cho đội Marketing: tạo một nhóm từ mẫu Simulated society (society-sim) của Soot Forge và thêm Micro Fish cho Biên tập, để Biên tập thử bài với người đọc giả lập trước khi tôi duyệt. Cho tôi xem trước khi tạo.';
/** The Micro Fish verdict on an item, in plain words. */
export function pretestText(p, ctx) {
  if (!p) return { state: 'none' };
  switch (p.state) {
    case 'asked': return { state: 'running', title: 'Đang cho người đọc giả lập đọc', hint: `Biên tập nhận việc ${when(p.at, ctx.now)}. Thường mất 5–10 phút; bạn duyệt lúc nào cũng được.` };
    case 'failed': return p.reason === 'no_workspace'
      ? { state: 'unavailable', title: 'Chưa có chỗ chạy người đọc giả lập', hint: PRETEST_NEEDS }
      : { state: 'failed', title: 'Chưa thử được', hint: p.reason === 'budget' ? 'Đội hết ngân sách AI cho hôm nay.' : 'Biên tập báo lỗi khi chạy. Thử lại, hoặc duyệt mà không thử.' };
    case 'unavailable': return { state: 'unavailable', title: 'Đội chưa có Micro Fish', hint: `Micro Fish cho một nhóm người đọc giả lập đọc bài và nói thật trước khi bạn duyệt. ${PRETEST_NEEDS}` };
    case 'done': {
      const v = { go: ['Nên đăng', 'ok'], fix: ['Nên sửa trước', 'wait'], stop: ['Chưa nên đăng', 'err'] }[p.verdict] ?? ['Đã thử', 'idle'];
      return { state: 'done', title: v[0], tone: v[1], line: [p.n ? `${num(p.n)} người đọc giả lập` : null, p.score !== undefined && p.score !== null ? `${Math.round(p.score)}/10 muốn đọc tiếp` : null, p.at ? when(p.at, ctx.now) : null].filter(Boolean).join(' · '), reasons: (p.reasons ?? []).slice(0, 3), stale: !!p.stale };
    }
  }
  return { state: 'none' };
}
/** The setup wizard's steps. */
export const SETUP_STEPS = [
  { id: 'product', label: 'Sản phẩm' },
  { id: 'blog', label: 'Blog' },
  { id: 'channels', label: 'Nơi đăng' },
  { id: 'done', label: 'Xem lại' },
];
/** A product id from its name: lower-case ASCII, digits and dashes (the folder name too). */
export function productId(name) {
  return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}
/** The two-letter mark of a product from its name. */
export function productMark(name) {
  const w = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '··';
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).replace(/^./, c => c.toUpperCase());
}

// ---------- phase 2: what a sheet refuses before it sends (spec §6, §8.2) ----------

/** The kinds grid of Tạo nội dung: six kinds, one choice. */
export const KINDS = [
  { id: 'blog', icon: 'file', label: 'Blog', sub: 'Bài trên trang, kèm bài X, Facebook' },
  { id: 'social', icon: 'send', label: 'Bài ngắn', sub: 'X, Facebook' },
  { id: 'video', icon: 'video', label: 'Video', sub: 'TikTok, kịch bản trước' },
  { id: 'community', icon: 'users', label: 'Bài cộng đồng', sub: 'Reddit, HN, dev.to; bạn đăng' },
  { id: 'newsletter', icon: 'mail', label: 'Bản tin', sub: 'Thư gửi người đăng ký' },
  { id: 'launch', icon: 'rocket', label: 'Gói ra mắt', sub: 'Blog, X, Show HN cho bản mới' },
];
/** Giao việc refuses an empty field here, before anything is written: the field to focus and the toast. */
export function createProblem(f) {
  const has = (v) => !!String(v ?? '').trim();
  if (f.format === 'community' && f.target === 'other' && !has(f.where)) return { field: 'f-where', text: 'Ghi tên nơi đăng trước đã.' };
  if (f.format === 'launch' && f.source === 'paste' && !has(f.changelog)) return { field: 'f-cl', text: 'Dán nội dung bản thay đổi trước đã.' };
  const needTopic = ['blog', 'social', 'video', 'community'].includes(f.format) || (f.format === 'newsletter' && f.source === 'topic');
  if (needTopic && !has(f.topic)) return { field: 'f-topic', text: 'Ghi đề tài trước đã.' };
  return null;
}
/** The create action's fields from the form (spec §12.2): target for community, source for newsletter and launch. */
export function createFields(f) {
  const topic = String(f.topic ?? '').trim();
  const out = { product: f.product, format: f.format, ...(topic ? { topic } : {}) };
  if (!['community', 'newsletter'].includes(f.format) && Array.isArray(f.channels) && f.channels.length) out.channels = [...f.channels];
  if (f.format === 'video' && f.series) out.series = f.series;
  if (f.format === 'community') out.target = f.target === 'other' ? { kind: 'other', name: String(f.where ?? '').trim().slice(0, 80) } : f.target;
  if (f.format === 'newsletter') out.source = f.source === 'topic' ? 'topic' : 'week';
  if (f.format === 'launch') {
    out.source = f.source === 'changelog' ? 'changelog' : 'paste';
    if (out.source === 'paste') out.changelog = String(f.changelog ?? '').trim();
  }
  return out;
}
/** A site as the founder typed it: a bare domain gets https://; anything that is not an address is null. */
export function siteUrl(v) {
  let x = String(v ?? '').trim().replace(/\/+$/, '');
  if (!x) return '';
  if (!/^https?:\/\//i.test(x)) x = `https://${x}`;
  // A host of ASCII labels with a letter TLD; a path may follow. No URL object: the bundle runs where one may be missing.
  const m = /^https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(x);
  return m && !m[1].split('.').some(l => !l || l.startsWith('-') || l.endsWith('-')) ? x : null;
}
/**
 * The setup step's first problem, or null. key names the field (its hint turns
 * red); products are the summary's, so a name already on the desk is caught here
 * before the server's 409.
 */
export function setupProblem(step, f, products = []) {
  if (step === 'product') {
    const name = String(f.name ?? '').trim();
    const id = productId(name);
    if (!name || !id) return { key: 'name', text: 'Ghi tên sản phẩm.' };
    if (products.some(p => p.id === id || String(p.name ?? '').trim().toLowerCase() === name.toLowerCase())) return { key: 'name', text: 'Đã có sản phẩm tên này.' };
    if (siteUrl(f.site) === null) return { key: 'site', text: 'Chưa phải địa chỉ trang. Ví dụ: quabietnoi.vn' };
  }
  if (step === 'blog' && f.blog === 'folder') {
    const dir = String(f.dir ?? '').trim();
    if (!dir || dir.length > 200 || /(^|\/)\.\.(\/|$)/.test(dir)) return { key: 'dir', text: 'Thư mục này nằm ngoài thư mục marketing.' };
  }
  if (step === 'channels') {
    for (const c of ['x', 'facebook', 'tiktok', 'community']) {
      const st = f.ch?.[c];
      if (st?.on && !String(st.value ?? '').trim()) return { key: `ch-${c}`, text: c === 'community' ? 'Ghi nơi đăng, hoặc bỏ chọn Cộng đồng.' : `Ghi tài khoản ${CH[c]}, hoặc bỏ chọn kênh này.` };
    }
  }
  return null;
}
/** The setup action's product from the form (spec §12.2). */
export function setupProduct(f) {
  const name = String(f.name ?? '').trim();
  const id = productId(name);
  const site = siteUrl(f.site);
  const about = String(f.about ?? '').trim();
  const channels = {};
  for (const c of ['x', 'facebook', 'tiktok', 'community']) if (f.ch?.[c]?.on && String(f.ch[c].value ?? '').trim()) channels[c] = String(f.ch[c].value).trim();
  if (f.ch?.newsletter?.on) channels.newsletter = true;
  return {
    id, name, ...(site ? { site } : {}), langs: String(f.langs ?? 'vi').split(','), ...(about ? { about } : {}),
    blog: f.blog === 'folder' ? { dir: String(f.dir ?? '').trim() || `${id}/site/posts` } : f.blog === 'hub' ? 'hub' : 'none',
    channels,
  };
}

