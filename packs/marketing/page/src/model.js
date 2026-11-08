// @ts-check
// Pure page logic for Bài viết and Hàng đợi: strings, number and time text,
// and the bodies the page sends. No DOM here, so the tests import it directly.

/** @param {'vi' | 'en'} locale */
export function strings(locale) {
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
    unknown: 'Chưa rõ kết quả — tải lại để xem bài đã đổi chưa.', done: 'Đã lưu.', reread: 'Đã đọc lại số.', failed: 'Không làm được: ',
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
export const num = n => (n == null ? null : nf.format(n));
/** @param {number | null | undefined} p */
export const pos = p => (p == null ? null : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(p));

const WEEKDAY = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
/** @param {string | null | undefined} at @param {number} [now] */
export function when(at, now = Date.now()) {
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
export const hm = at => new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
/** @param {string} url */
export const shortUrl = url => { const s = url.replace(/^https:\/\/(www\.)?/, ''); return s.length > 48 ? `${s.slice(0, 47)}…` : s; };
/** @param {number} min */
export const spacing = min => (min >= 60 ? `${Math.round(min / 60)} giờ` : `${min} phút`);
/** nest://new for the writer Soot, with a draft request. @param {string} soot @param {string | null} product */
export const writeLink = (soot, product) => `nest://new?soot=${encodeURIComponent(soot)}&text=${encodeURIComponent(`Viết một bài mới cho ${product ? `blog ${product}` : 'blog'}.`)}`;
/** The guard rule a refused post failed, as its badge. @param {string} rule */
export const ruleLabel = rule => ({ facts: 'Giá', personal_data: 'Dữ liệu cá nhân', platform: 'Kênh', duplicate: 'Trùng', tone: 'Giọng văn' })[rule] ?? 'Kiểm tra';
/** A datetime-local value in Asia/Ho_Chi_Minh (UTC+7, no DST) and back. @param {string} at */
export const localInput = at => new Date(Date.parse(at) + 7 * 3_600_000).toISOString().slice(0, 16);
/** @param {string} v */
export const fromLocalInput = v => new Date(Date.parse(`${v}:00Z`) - 7 * 3_600_000).toISOString();
/** The line under a post in Bài viết. @param {any} p @param {ReturnType<typeof strings>} t */
export function postLine(p, t) {
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
export function metricLine(m, t) {
  if (!m) return t.noData;
  return `${num(m.impressions)} lượt hiển thị · ${num(m.clicks)} lượt bấm${m.position != null ? ` · vị trí ${pos(m.position)}` : ''} (28 ngày)`;
}

/** Badge tone by state. @param {string} state */
export const tone = state => ({ published: 'ok', refused: 'err', failed: 'err', uncertain: 'warn', publishing: 'warn', unpublishing: 'warn' })[state] ?? '';
/** Badge tone of a held video draft. @param {string} hold */
export const holdTone = hold => (hold === 'render_failed' ? 'err' : 'warn');
/** The pretest rows, best first, as the page shows them. @param {any} pretest */
export const hookRows = pretest => [...(pretest?.hooks ?? [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  .map(h => ({ text: h.text ? `"${h.text}"` : h.id, score: h.score == null ? '—' : `${h.score}%`, chosen: !!h.chosen }));

export const viewBody = (/** @type {string} */ filter = 'all', /** @type {string} */ id = '', /** @type {string} */ campaign = '') => (campaign ? { campaign } : id ? { id } : { filter });
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

/** The notice after an action. A campaign re-read that failed shows its own notice on the page, not "Đã lưu.". */
export function doneNotice(/** @type {any} */ t, /** @type {string} */ op, /** @type {any} */ out) {
  if (op !== 'campaign_refresh') return { kind: 'success', text: t.done };
  return out?.read?.ok ? { kind: 'success', text: t.reread } : null;
}

// ---------- Chiến dịch ----------

export const GOAL_FORM = { signups: 'người đăng ký mới', first_topups: 'người nạp lần đầu', clicks: 'lượt bấm', published: 'bài đã đăng' };
export const GOAL_SHORT = { signups: 'người đăng ký', first_topups: 'người nạp lần đầu', clicks: 'lượt bấm', published: 'bài đã đăng' };
/** The campaign code the server makes from a name (also the utm_campaign). @param {string} name */
export const slugOf = name => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
/** "2.000.000" or "2000000" → 2000000; empty → null. @param {string} s */
export const digits = s => { const d = String(s ?? '').replace(/\D/g, ''); return d ? Number(d) : null; };
/** "1/12 – 31/12" in Asia/Ho_Chi_Minh. @param {string} starts @param {string} ends */
export const dayRange = (starts, ends) => `${day(starts)} – ${day(ends)}`;
/** Progress toward the goal, 0–100; null when not read yet. @param {any} goal */
export const goalPct = goal => (goal?.value == null || !goal.target ? null : Math.min(100, Math.round((goal.value / goal.target) * 100)));
/** "126 / 300 người đăng ký"; "— / 300 …" before the first read. @param {any} goal */
export const goalLine = goal => `${goal?.value == null ? '—' : num(goal.value)} / ${num(goal?.target ?? 0)} ${GOAL_SHORT[goal?.metric] ?? ''}`.trim();

/** @param {any} [choices] */
export const newCampaign = (choices = []) => ({ name: '', metric: 'signups', target: '', channels: choices.map((/** @type {any} */ c) => c.id), starts: '', ends: '', budget: '' });
/** What still stops "Tạo chiến dịch", as the footer hint; null when it can be sent. @param {any} f */
export function campaignProblem(f) {
  if (!f.name.trim() || !f.starts || !f.ends) return 'Điền tên và ngày để tạo.';
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slugOf(f.name))) return 'Tên cần ít nhất 2 chữ hoặc số.';
  if (f.ends < f.starts) return 'Ngày kết thúc phải từ ngày bắt đầu trở đi.';
  if (!(digits(f.target) >= 1)) return 'Mục tiêu là một số lớn hơn 0.';
  if (!f.channels.length) return 'Chọn ít nhất một kênh.';
  return null;
}
/** The campaign_save body (page_action `campaign`). @param {any} f */
export const campaignBody = f => ({ name: f.name.trim(), goal: { metric: f.metric, target: digits(f.target) ?? 0 }, channels: [...f.channels], starts: f.starts, ends: f.ends, token_budget: digits(f.budget) ?? 0 });
/** The api failure line: "api.lohi2.com không trả lời lúc 07:00. Số bài, …". @param {any} read */
export const readFailLine = read => `${String(read?.error?.message ?? 'Không đọc được').replace(/\.$/, '')} lúc ${read?.at ? hm(read.at) : '—'}. Số bài, tiếp cận dưới đây là của Soot; đăng ký và lượt bấm sẽ cập nhật ở lần đọc tới.`;
/** "Token đã dùng: 820.000 / 2.000.000 (41%)." @param {number} used @param {number} budget */
export const tokenLine = (used, budget) => (budget > 0 ? `Token đã dùng: ${num(used)} / ${num(budget)} (${Math.round((used / budget) * 100)}%).` : `Token đã dùng: ${num(used)} (chưa đặt ngân sách).`);
