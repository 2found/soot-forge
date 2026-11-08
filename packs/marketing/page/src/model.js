// @ts-check
// Pure page logic for Bài viết and Hàng đợi: strings, number and time text,
// and the bodies the page sends. No DOM here, so the tests import it directly.

/** @param {'vi' | 'en'} locale */
export function strings(locale) {
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
  if (err?.link) return err.message || t.failed;
  // The runtime's own refusal of a malformed request is English: say it in words and keep the way out.
  if (/does not match|operation parameters|tool_refused|\(refused\)/i.test(`${err?.message ?? ''} ${err?.code ?? ''}`)) return 'Trang gửi một yêu cầu không hợp lệ nên Soot từ chối. Bấm Thử lại; nếu vẫn vậy, nhờ Editor kiểm tra giúp.';
  return t.failed + (err?.message || err?.code || '');
}

/** Unwrap a bridge result: tool errors come back as {error} in the output. @param {any} r */
export function output(r) {
  if (!r.ok) throw r.error;
  // A missing credential answers with its fix: a Vietnamese cause, the field's Vietnamese name, and the link that opens it.
  const o = r.output;
  if (o?.reason_code === 'needs_credential' || o?.needs_credential) {
    const key = o.key ?? o.needs_credential, why = String(o.error?.message ?? '').split(' Mở Thiết lập')[0];
    throw { code: 'needs_credential', message: `${why || 'Thiếu một khoá để làm việc này.'} Bấm Mở Thiết lập, điền "${KEY_LABEL[key] ?? 'khoá còn thiếu'}" rồi Thử lại.`, link: o.link ?? SETUP_LINK, credential: key };
  }
  if (o?.error) throw o.error;
  return r.output;
}

/** The notice after an action. A campaign re-read that failed shows its own notice on the page, not "Đã lưu.". */
export function doneNotice(/** @type {any} */ t, /** @type {string} */ op, /** @type {any} */ out) {
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

// ---------- the next step (every post and channel says what happens and when, or what the person does) ----------

/** nest:// link that opens the Soot's browser, where the person signs in. @param {string | null | undefined} editor */
export const signInLink = editor => (editor ? `nest://browser/${encodeURIComponent(editor)}` : 'nest://settings/setup');
/** nest://new for the writer: revise this post. @param {string | null | undefined} writer @param {any} p */
export const reviseLink = (writer, p) => (writer ? `nest://new?soot=${encodeURIComponent(writer)}&text=${encodeURIComponent(`Sửa bài "${p.title}" (mã ${p.id}): `)}` : null);
export const SETUP_LINK = 'nest://settings/setup';
/** Vietnamese names for the keys a page action may ask for. */
const KEY_LABEL = { PRODUCT_ADMIN_KEY: 'Khoá quản trị Lohi' };

/**
 * The line a post shows for its next step: {text, tone, button?}. `button` is {do, label}: the one thing
 * the person can do now, or none when Soot is running it ("Không cần làm gì").
 * @param {any} n the server's `next` @param {any} [p] the post row/detail
 */
export function nextLine(n, p = {}) {
  if (!n) return null;
  const ch = n.channel ?? '', at = n.at ? when(n.at) : '';
  const lc = at ? at.charAt(0).toLowerCase() + at.slice(1) : '';
  const quiet = (/** @type {string} */ s) => s;
  const btn = (/** @type {string} */ d, /** @type {string} */ label) => ({ do: d, label });
  switch (n.code) {
    case 'draft': return { text: 'Writer đang soạn. Khi xong, Editor kiểm tra rồi xếp lịch. Không cần làm gì.', tone: 'plain' };
    case 'draft_stale': return { text: 'Bản nháp này nằm hơn 24 giờ mà chưa được kiểm tra. Nhờ Writer hoàn thiện, hoặc bỏ qua: nó không chặn bài mới.', tone: 'warn', button: btn('ask_writer', 'Nhờ Writer hoàn thiện') };
    case 'refused': return { text: 'Soot không đăng bài này vì chưa qua kiểm tra. Nhờ Writer sửa, Editor sẽ kiểm tra lại bản mới.', tone: 'err', button: btn('ask_writer', 'Nhờ Writer sửa') };
    case 'ready': return { text: 'Đã qua kiểm tra nhưng chưa có giờ đăng. Soot tự xếp lịch ở lượt lên bài 08:00; bấm Xếp lịch để xếp ngay.', tone: 'warn', button: btn('schedule', 'Xếp lịch') };
    case 'pulled': return { text: 'Bài đang để ngoài hàng đợi: Soot sẽ không đăng. Xếp lại nếu muốn đăng.', tone: 'plain', button: btn('restore', 'Xếp lại') };
    case 'removed': return { text: 'Bài đã gỡ khỏi kênh. Đăng lại nếu muốn.', tone: 'plain', button: btn('restore', 'Đăng lại') };
    case 'unpublishing': return { text: 'Đang gỡ bài. Editor xóa bài ở lần chạy tới, vài phút nữa. Không cần làm gì.', tone: 'plain' };
    case 'published': return { text: `Đã đăng ${lc}${p.url ? `: ${shortUrl(p.url)}` : '. Chưa có liên kết, Soot sẽ ghi khi nền tảng trả về.'}`, tone: 'ok', button: p.url ? btn('open', 'Mở bài') : undefined };
    case 'uncertain': return { text: `Soot bấm đăng nhưng chưa chắc bài đã lên ${ch}. Mở ${ch} xem: nếu đã lên, dán liên kết; nếu chưa, chọn đăng lại. Soot không tự đăng lại.`, tone: 'err', button: btn('confirm', 'Kiểm tra và chọn') };
    case 'in_flight': return { text: 'Đang đăng. Vài phút nữa sẽ có liên kết. Không cần làm gì.', tone: 'plain' };
    case 'failed_retry': return { text: `Lần đăng vừa rồi lỗi${n.reason ? ` (${n.reason})` : ''}. Soot tự thử lại ${lc}. Bấm Thử ngay nếu muốn sớm hơn.`, tone: 'warn', button: btn('retry', 'Thử ngay') };
    case 'failed': return { text: `Đăng lỗi${n.reason ? `: ${n.reason}` : ''}. Soot không tự thử nữa: bấm Thử ngay, hoặc gỡ bài khỏi hàng đợi.`, tone: 'err', button: btn('retry', 'Thử ngay') };
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
export function queueHeadline(d) {
  const items = d.items ?? [];
  const late = items.filter((/** @type {any} */ q) => q.late), unsure = items.filter((/** @type {any} */ q) => q.state === 'uncertain');
  const out = (/** @type {string} */ tone, /** @type {string} */ text, button) => ({ tone, text, button });
  if (d.paused_all) return out('warn', `Đang dừng đăng mọi kênh. ${items.length ? `${items.length} bài chờ ở đây và sẽ không đi cho tới khi bạn bật lại.` : 'Soot vẫn viết và kiểm tra.'}`, { do: 'resume_all', label: 'Bật lại mọi kênh' });
  if (unsure.length) return out('err', `${unsure.length} bài chưa rõ đã lên chưa. Mở kênh xem rồi chọn Đã lên hoặc Chưa lên: Soot không tự đăng lại.`, null);
  if (late.length) return out('warn', `${late.length} bài lỡ giờ. Soot không tự đăng bài quá hạn: chọn Đăng ngay, Đổi giờ hoặc Bỏ cho từng bài.`, null);
  const out2 = (d.channels ?? []).find((/** @type {any} */ c) => c.paused_reason === 'signed_out' && c.waiting > 0);
  if (out2) return out('warn', `${out2.label} chưa đăng nhập nên ${out2.waiting} bài của kênh này chưa đi được. Đăng nhập ${out2.label} rồi Soot đăng tiếp.`, { do: 'sign_in', label: `Đăng nhập ${out2.label}`, channel: out2.id });
  const live = items.filter((/** @type {any} */ q) => q.action === 'publish' && !['failed'].includes(q.state) && !q.in_flight && q.scheduled_at).sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
  const failed = items.find((/** @type {any} */ q) => q.state === 'failed');
  if (failed) return out('warn', `Một bài đăng lỗi${failed.retry_at ? `, Soot thử lại ${when(failed.retry_at).toLowerCase()}` : '. Bấm Thử ngay hoặc gỡ khỏi hàng đợi'}.`, null);
  if (live.length) return out('plain', `Không cần làm gì, Soot đang tự chạy. Bài kế tiếp: ${live[0].channel} ${when(live[0].scheduled_at).toLowerCase()}.`, null);
  if (items.some((/** @type {any} */ q) => q.in_flight)) return out('plain', 'Đang đăng. Vài phút nữa sẽ có liên kết bên dưới. Không cần làm gì.', null);
  return out('plain', 'Hàng đợi trống. Soot lên bài mới mỗi sáng 08:00; hoặc bạn nhờ Writer viết ngay.', d.writer ? { do: 'ask_writer', label: 'Nhờ viết bài' } : null);
}

/** The state of one channel on Hàng đợi: its words and its button. @param {any} c @param {any} d */
export function channelLine(c, d) {
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
export function mdBlocks(md) {
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
export function limitsBody(c, f) {
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
export function limitsAsk(c, body) {
  const parts = [];
  if (body.cap_per_day !== undefined) parts.push(`bài mỗi ngày ${c.cap_per_day} → ${body.cap_per_day}`);
  if (body.spacing_min !== undefined) parts.push(`khoảng cách ${spacing(c.spacing_min)} → ${spacing(body.spacing_min)}`);
  if (body.reply_cap_per_day !== undefined) parts.push(`trả lời mỗi ngày ${c.reply_cap_per_day ?? 0} → ${body.reply_cap_per_day}`);
  return `${c.label}: ${parts.join(', ')}. Bài đã xếp lịch giữ nguyên giờ; số mới áp dụng cho các bài xếp từ giờ trở đi.`;
}

/** nest://new for the writer: write posts for this campaign, using its links. @param {string} writer @param {any} c @param {{label: string, url: string}[]} links */
export const campaignWriteLink = (writer, c, links) => `nest://new?soot=${encodeURIComponent(writer)}&text=${encodeURIComponent(`Viết bài cho chiến dịch "${c.name}" (mã ${c.id}). Dùng liên kết của từng kênh: ${links.map(l => `${l.label} ${l.url}`).join('; ')}.`)}`;

/** One line for a campaign row: what Soot does next, or what to look at. @param {{phase?: string, starts?: string}} c */
export function campaignNextLine(c) {
  if (c.phase === 'planned') return `Soot bắt đầu theo dõi từ ${day(c.starts)}. Không cần làm gì.`;
  if (c.phase === 'running') return 'Soot đọc lại số mỗi sáng 07:00. Không cần làm gì.';
  if (c.phase === 'ended') return 'Chiến dịch đã kết thúc. Mở để xem kết quả.';
  return 'Mở để xem liên kết và kết quả.';
}
