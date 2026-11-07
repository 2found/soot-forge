// The publish guard (design §4.1): deterministic checks run by `check` and
// again by `claim`. Pure functions; the tools load the rows they need.
// A refusal reason is plain Vietnamese and shown on the post.
import { inQuiet, localDayStart, DEFAULT_QUIET } from './time.mjs';

const HOUR = 3_600_000, DAY = 24 * HOUR;

// Channel defaults (§3.3, human pace). p2 creates only the blog channel.
export const CHANNEL_DEFAULTS = {
  'blog-lohi': { kind: 'blog', publisher: 'lohi-blog', cap_per_day: 1, spacing_min: 20 * 60, reply_cap_per_day: 0, rules: { internal_hosts: ['blog.lohi2.com', 'lohi2.com'], series: 'truyen-hay' } },
  x: { kind: 'social', publisher: 'browser', cap_per_day: 4, spacing_min: 180, reply_cap_per_day: 10, rules: { max_chars: 280, link_chars: 23, reply_links: false } },
  facebook: { kind: 'social', publisher: 'browser', cap_per_day: 2, spacing_min: 360, reply_cap_per_day: 10, rules: { page_only: true } },
  reddit: { kind: 'social', publisher: 'browser', cap_per_day: 1, spacing_min: 24 * 60, reply_cap_per_day: 5, rules: { per_sub_per_week: 1, promo_ratio: 0.1 } },
};

export const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const digits = s => String(s).replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');

// ---------- article brief lint (draft_save) ----------

export function briefLint(post, channel) {
  if (post.kind !== 'article') return [];
  const b = post.brief ?? {}, out = [];
  const len = s => [...String(s ?? '')].length;
  if (len(b.title) < 30 || len(b.title) > 60) out.push({ field: 'title', code: 'title_length', message: `Tiêu đề ${len(b.title)} ký tự; cần 30–60.` });
  if (len(b.meta) < 120 || len(b.meta) > 160) out.push({ field: 'meta', code: 'meta_length', message: `Mô tả ${len(b.meta)} ký tự; cần 120–160.` });
  if (!/^[a-z0-9-]{3,80}$/.test(b.slug ?? '')) out.push({ field: 'slug', code: 'slug_invalid', message: 'Đường dẫn chỉ gồm a-z, 0-9 và dấu gạch, 3–80 ký tự.' });
  const hosts = channel?.rules?.internal_hosts ?? [];
  const links = internalLinks(post.body, hosts);
  if (hosts.length && links.length < 2) out.push({ field: 'body', code: 'internal_links', message: `Có ${links.length} liên kết nội bộ; cần ít nhất 2.` });
  if (b.keyword && !fold(b.title).includes(fold(b.keyword)) && !fold(b.meta).includes(fold(b.keyword))) out.push({ field: 'brief.keyword', code: 'keyword_missing', message: 'Từ khóa chưa có trong tiêu đề hay mô tả.' });
  return out;
}

export function internalLinks(body, hosts) {
  const urls = String(body ?? '').match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
  return urls.filter(u => { try { const h = new URL(u).hostname; return hosts.some(x => h === x || h.endsWith('.' + x)); } catch { return false; } });
}

// ---------- rule 1: facts and prices only from served sources ----------

const MONEY = /(\d{1,3}(?:[.,\s]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|nghìn|ngàn|triệu|tr|đ|₫|vnđ|vnd|đồng)(?![\p{L}])/giu;
const PERCENT = /(\d+(?:[.,]\d+)?)\s*%/g;
const FREE = /miễn\s*phí|mien\s*phi|\bfree\b/i;

/** Every money amount, percentage and "miễn phí" claim in the text. */
export function factClaims(text) {
  const s = String(text ?? ''), out = [];
  for (const m of s.matchAll(MONEY)) {
    let n = Number(m[1].replace(/[.,\s](?=\d{3}\b)/g, '').replace(',', '.'));
    const unit = m[2].toLowerCase();
    if (unit === 'k' || unit === 'nghìn' || unit === 'ngàn') n *= 1000;
    if (unit === 'triệu' || unit === 'tr') n *= 1_000_000;
    out.push({ kind: 'money', text: m[0].trim(), value: Math.round(n) });
  }
  for (const m of s.matchAll(PERCENT)) out.push({ kind: 'percent', text: m[0], value: Number(m[1].replace(',', '.')) });
  if (FREE.test(s)) out.push({ kind: 'free', text: 'miễn phí' });
  return out;
}

function factNumbers(fact) {
  const nums = [];
  const walk = v => {
    if (typeof v === 'number') nums.push(v);
    else if (typeof v === 'string' && /^\s*[\d.,]+\s*$/.test(v)) nums.push(Number(digits(v)));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(fact.value);
  return nums;
}
const isFreeFact = f => /free|trial|mien_phi|mienphi/i.test(f.key) && f.value !== false && f.value !== 0 && f.value !== null;

export function checkFacts(text, facts, now) {
  const fresh = facts.filter(f => now - Date.parse(f.fetched_at ?? '') <= DAY);
  const bad = [];
  for (const c of factClaims(text)) {
    if (c.kind === 'free') { if (!fresh.some(isFreeFact)) bad.push(c); continue; }
    if (!fresh.some(f => factNumbers(f).includes(c.value))) bad.push(c);
  }
  return bad.length === 0
    ? { rule: 'facts', ok: true, detail: 'Giá và số liệu: khớp nguồn' }
    : { rule: 'facts', ok: false, code: 'fact_unsourced', detail: bad.map(c => `"${c.text}" không có trong giá và số liệu đang bán (nguồn đọc trong 24 giờ)`).join('; ') };
}

// ---------- rule 2: no reader personal data ----------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?<![\d])(?:\+84|84|0)(?:[\s.-]?\d){9}(?![\d])/;
const NATIONAL_ID = /(?<![\d.,])(?:\d{9}|\d{12})(?![\d.,])/;
const HANDLE = /(?:^|[\s(])@([A-Za-z0-9_.]{2,30})/;

export function checkPersonal(text, { replyTarget } = {}) {
  const s = String(text ?? '');
  const hits = [];
  if (EMAIL.test(s)) hits.push('địa chỉ email');
  if (PHONE.test(s)) hits.push('số điện thoại');
  if (NATIONAL_ID.test(s.replace(PHONE, ''))) hits.push('số giống số giấy tờ');
  const h = s.match(HANDLE);
  if (h && h[1] !== replyTarget) hits.push(`tên tài khoản @${h[1]}`);
  return hits.length === 0
    ? { rule: 'personal_data', ok: true, detail: 'Không dữ liệu cá nhân' }
    : { rule: 'personal_data', ok: false, code: 'personal_data', detail: `Có dữ liệu cá nhân: ${hits.join(', ')}` };
}

// ---------- rule 3: platform rules ----------

const BAIT = /(like nếu|share nếu|tag (?:một )?người|bình luận "?\d|comment "?\d|like if|share if|tag a friend)/i;

export function checkPlatform(post, channel) {
  const rules = channel?.rules ?? {};
  const text = String(post.body ?? '');
  if (rules.max_chars) {
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    const len = [...text.replace(/https?:\/\/\S+/g, '')].length + urls.length * (rules.link_chars ?? 23) + (post.link ? (rules.link_chars ?? 23) + 1 : 0);
    if (len > rules.max_chars) return { rule: 'platform', ok: false, code: 'too_long', detail: `Dài ${len} ký tự; kênh cho tối đa ${rules.max_chars}.` };
  }
  if (post.kind === 'reply' && rules.reply_links === false && (/https?:\/\//.test(text) || post.link)) return { rule: 'platform', ok: false, code: 'reply_link', detail: 'Trả lời trên kênh này không được kèm liên kết.' };
  if (channel?.key === 'facebook' && BAIT.test(text)) return { rule: 'platform', ok: false, code: 'engagement_bait', detail: 'Có câu kêu gọi tương tác kiểu câu like/share bị Facebook phạt.' };
  if (channel?.kind === 'blog' && post.kind === 'article') {
    const lint = briefLint(post, channel);
    if (lint.length) return { rule: 'platform', ok: false, code: 'brief_lint', detail: lint.map(l => l.message).join(' ') };
  }
  return { rule: 'platform', ok: true, detail: 'Đúng quy định kênh' };
}

// ---------- rule 5: no duplicate ----------

function trigrams(s) {
  const t = fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/** `log` is publish_log rows with `body`/`link`/`channel`/`at`/`status`, own post excluded. */
export function checkDuplicate(post, log, now) {
  for (const row of log) {
    if (row.status !== 'published' || row.action !== 'publish') continue;
    const age = now - Date.parse(row.at ?? '');
    if (age <= 90 * DAY && row.body) {
      const sim = similarity(post.body, row.body);
      if (sim >= 0.8) return { rule: 'duplicate', ok: false, code: 'duplicate', detail: `Giống ${Math.round(sim * 100)}% bài đã đăng ${String(row.at).slice(0, 10)}; bài trùng trong 90 ngày không được đăng.` };
    }
    if (age <= 14 * DAY && post.link && row.link === post.link && row.channel === post.channel) return { rule: 'duplicate', ok: false, code: 'duplicate', detail: 'Cùng liên kết đã đăng trên kênh này trong 14 ngày.' };
  }
  return { rule: 'duplicate', ok: true, detail: 'Không trùng bài cũ' };
}

/** The automatic rules 1, 2, 3 and 5. */
export function autoChecks(post, { channel, facts, log, now }) {
  const text = [post.brief?.title, post.brief?.meta, post.body].filter(Boolean).join('\n');
  return [checkFacts(text, facts, now), checkPersonal(text), checkPlatform(post, channel), checkDuplicate(post, log, now)];
}

// ---------- rule 6: at claim time ----------

/**
 * Pause, quiet hours, cap and spacing for one publish now. `log` is the
 * channel's publish_log rows (intents count, so two claims cannot share a slot).
 * null = clear; otherwise {code, reason} and the item keeps waiting.
 */
export function claimWindow({ settings, channel, log, now }) {
  if (settings.paused_all) return { code: 'paused', reason: 'Đang tạm dừng đăng mọi kênh.' };
  if (channel.paused) return { code: 'paused', reason: `Kênh đang tạm dừng${channel.paused_reason ? ` (${channel.paused_reason})` : ''}.` };
  const quiet = settings.quiet_hours ?? DEFAULT_QUIET;
  if (inQuiet(now, quiet)) return { code: 'quiet_hours', reason: `Đang giờ yên ${quiet.from}–${quiet.to}; sẽ đăng sau.` };
  const live = log.filter(r => r.action === 'publish' && (r.status === 'published' || r.status === 'intent'));
  const start = localDayStart(now, quiet.tz || DEFAULT_QUIET.tz);
  const today = live.filter(r => Date.parse(r.at) >= start).length;
  if (today >= (channel.cap_per_day ?? 1)) return { code: 'over_cap', reason: `Đã đủ ${channel.cap_per_day} bài hôm nay trên kênh này.` };
  const last = Math.max(0, ...live.map(r => Date.parse(r.at)));
  if (channel.spacing_min && now - last < channel.spacing_min * 60_000) return { code: 'spacing', reason: `Cần cách bài trước ít nhất ${Math.round(channel.spacing_min / 60)} giờ.` };
  return null;
}
