// @ts-check
// Pure page logic for Bài viết and Hàng đợi: strings, number and time text,
// and the bodies the page sends. No DOM here, so the tests import it directly.

/** @param {'vi' | 'en'} locale */
export function strings(locale) {
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
    today: 'Hôm nay', replies: 'trả lời', pausedAs: (/** @type {string} */ why) => `đang dừng: ${why}`, notPosted: 'Chưa lên — đăng lại', drop: 'Bỏ', postNow: 'Đăng ngay',
    emptyQueue: 'Không có gì chờ đăng', emptyHelp: 'Editor xếp bài vào đây sau khi kiểm tra.', recent: 'Vừa xong', inFlight: 'Đang đăng',
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
export const num = n => (n == null ? null : nf.format(n));
/** @param {number | null | undefined} p */
export const pos = p => (p == null ? null : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(p));

/** @param {string | null | undefined} at @param {number} [now] */
export function when(at, now = Date.now()) {
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
export function metricLine(m, t) {
  if (!m) return t.noData;
  return `${num(m.impressions)} lượt hiển thị · ${num(m.clicks)} lượt bấm${m.position != null ? ` · vị trí ${pos(m.position)}` : ''} (28 ngày)`;
}

/** Badge tone by state. @param {string} state */
export const tone = state => ({ published: 'ok', refused: 'err', failed: 'err', uncertain: 'warn', publishing: 'warn', unpublishing: 'warn' })[state] ?? '';

export const viewBody = (/** @type {string} */ filter = 'all', /** @type {string} */ id = '') => (id ? { id } : { filter });
/** @param {string} request_id @param {string} op @param {Record<string, unknown>} [rest] */
export const actionBody = (request_id, op, rest = {}) => ({ op, request_id, ...rest });

/** A failed bridge call or tool error as plain text. @param {ReturnType<typeof strings>} t @param {any} err */
export function errorText(t, err) {
  if (err?.code === 'no_response') return t.unknown;
  return t.failed + (err?.message || err?.code || '');
}

/** Unwrap a bridge result: tool errors come back as {error} in the output. @param {any} r */
export function output(r) {
  if (!r.ok) throw r.error;
  if (r.output?.error) throw r.output.error;
  return r.output;
}
