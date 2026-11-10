// Hubless radar: the audience's own places (feeds) read by a tool chain with no model, new items kept once per
// url in `signals`; a small model is woken only to triage a batch. Read-only: it never posts, replies or signs in.
import { createHash } from 'node:crypto';
import { fail, eq } from './store.mjs';
import { setSetting } from './ops.mjs';
import { fold } from './guard.mjs';

const HOUR = 3_600_000;
const iso = ms => new Date(ms).toISOString();
const text = s => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const short = (s, n) => { const t = text(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
/** A feed address is https and a public name: a radar source never reaches this machine or a private network. */
export function publicHttps(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:' || x.username || x.password) return null;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return x.href;
  } catch { return null; }
}

/** RSS 2.0 items and Atom entries as {title, url, summary}. */
export function parseFeed(xml) {
  const out = [];
  const body = String(xml ?? '');
  for (const m of body.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const block = m[2];
    const title = text(block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/)?.[1]);
    const atom = block.match(/<link\b[^>]*\bhref="([^"]+)"/)?.[1];
    const url = text(atom ?? block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/)?.[1] ?? block.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/)?.[1]).replace(/&amp;/g, '&');
    const summary = text(block.match(/<(?:description|summary|content)\b[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/)?.[1]);
    if (title && publicHttps(url)) out.push({ title: short(title, 200), url, summary: short(summary, 400) });
  }
  return out;
}

const keyOf = u => createHash('sha1').update(u).digest('hex').slice(0, 8).toUpperCase();
export const SIGNAL_STATES = ['new', 'kept', 'dismissed', 'used'];

const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
/** After this many failed reads in a row a source is switched off (a person can clear `disabled_at` to turn it back on). */
export const MAX_FAILS = 3;
export const MAX_WAKE_ITEMS = 15;
const DAY = 24 * HOUR;
/** A wake not answered within this is taken as refused (a budget, a stopped Soot): the batch may wake again. */
export const PENDING_HOLD = 6 * HOUR;

/**
 * Is an item about this product's readers? `keywords` (accent-folded, any one hit) and `lang: 'vi'` (the text carries
 * Vietnamese letters, so an English subreddit never reaches the model). No keywords and lang any: everything passes.
 * Returns the number of keyword hits (0 = off topic) so the best items rank first.
 */
export function relevance(item, { keywords = [], lang = 'any' } = {}) {
  const raw = `${item.title} ${item.summary}`;
  if (lang === 'vi' && !VI_CHARS.test(raw)) return 0;
  if (!keywords.length) return 1;
  const hay = fold(raw);
  return keywords.reduce((n, k) => n + (hay.includes(fold(k)) ? 1 : 0), 0);
}

/**
 * radar_read {sources?, per_call?, min_hours?, wake_at?, keywords?, lang?, max_items?, wake_gap_hours?, retire?}: seeds the
 * `sources` table (new keys only; an edit made on the table is never overwritten), reads the sources that are due (oldest
 * first, at most `per_call`), keeps each new item once. Items off topic (keywords, language) are kept as dismissed, so they are
 * never read twice and never reach the model. A source that answers 429 rests a day; after MAX_FAILS failures in a row it is
 * switched off and reported as skipped. Wakes the triage Soot at most once per `wake_gap_hours` (default 20), counted from
 * the last wake it answered (a wake the host refused counts nothing and may repeat after PENDING_HOLD), with at most
 * `max_items` (15) of the best new signals; the surplus is dismissed with a note.
 */
export async function radar_read(input, { store, now, fetch }) {
  const seeds = Array.isArray(input.sources) ? input.sources : [];
  if (seeds.length > 40) fail('invalid_request', 'At most 40 sources.');
  const keywords = (Array.isArray(input.keywords) ? input.keywords : []).map(k => String(k).trim()).filter(Boolean).slice(0, 60);
  const lang = input.lang === 'vi' ? 'vi' : 'any';
  const known = new Set((await store.query('sources', [], { limit: 200 })).map(r => r.key));
  for (const s of seeds) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(s?.key)) || !publicHttps(s.url)) fail('invalid_request', 'A source needs a lowercase key and a public https url.');
    if (!known.has(s.key)) await store.insert('sources', { key: s.key, kind: s.kind ?? 'feed', url: s.url });
  }
  // Retired sources (dead, answering 429, or the wrong language) are switched off; their rows and signals stay.
  const retired = [];
  for (const key of Array.isArray(input.retire) ? input.retire.slice(0, 40) : []) {
    const row = await store.one('sources', [eq('key', String(key))]);
    if (row && !row.disabled_at) { await store.update('sources', [eq('key', row.key)], { disabled_at: iso(now), last_error: row.last_error ?? 'retired' }); retired.push(row.key); }
  }
  const perCall = Math.min(Math.max(Number(input.per_call) || 2, 1), 5);
  const minMs = (Number(input.min_hours) || 6) * HOUR;
  const all = await store.query('sources', [], { limit: 200 });
  const skipped = all.filter(r => r.disabled_at).map(r => ({ source: r.key, why: `tắt: ${r.last_error ?? 'không đọc được'}` }))
    .concat(all.filter(r => !r.disabled_at && r.retry_after && now < Date.parse(r.retry_after)).map(r => ({ source: r.key, why: `nghỉ đến ${r.retry_after.slice(0, 16)}: ${r.last_error ?? ''}`.trim() })));
  const sources = all
    .filter(r => !r.disabled_at && !(r.retry_after && now < Date.parse(r.retry_after)))
    .filter(r => !r.last_read_at || now - Date.parse(r.last_read_at) >= minMs)
    .sort((a, b) => Date.parse(a.last_read_at ?? 0) - Date.parse(b.last_read_at ?? 0)).slice(0, perCall);
  const read = [];
  for (const src of sources) {
    let items = [], error = null, status = 0;
    try {
      const res = await fetch(src.url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; soot-radar/1.0)', Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' } });
      if (!res.ok) { status = res.status; error = `HTTP ${res.status}`; }
      else items = parseFeed((await res.text()).slice(0, 1_500_000));
    } catch (e) { error = e?.name === 'TimeoutError' ? 'timeout' : 'unreachable'; }
    let fresh = 0, off = 0;
    for (const it of items.slice(0, 40)) {
      if (await store.one('signals', [eq('url', it.url)])) continue;
      const score = relevance(it, { keywords, lang });
      await store.insert('signals', { ref: 'RS-' + keyOf(it.url), source: src.key, title: it.title, url: it.url, summary: it.summary, state: score ? 'new' : 'dismissed', score, ...(score ? {} : { note: 'tự bỏ: ngoài chủ đề' }), found_at: iso(now) });
      if (score) fresh++; else off++;
    }
    const fails = error ? (src.fails ?? 0) + 1 : 0;
    const off_now = error && fails >= MAX_FAILS;
    await store.update('sources', [eq('key', src.key)], { last_read_at: iso(now), last_error: error, fails, retry_after: status === 429 ? iso(now + DAY) : null, ...(off_now ? { disabled_at: iso(now) } : {}) });
    read.push({ source: src.key, new: fresh, ...(off ? { off_topic: off } : {}), ...(error ? { error } : {}), ...(off_now ? { disabled: true } : {}) });
    if (off_now) skipped.push({ source: src.key, why: `tắt sau ${fails} lần lỗi: ${error}` });
  }
  let waiting = await store.query('signals', [eq('state', 'new')], { limit: 500 });
  // `at` is the last wake the triage Soot answered (it read or marked the batch); `pending_at` a wake not answered yet.
  // A wake the host refused (a token budget, a stopped Soot) is never answered, so it does not start the gap: after
    // PENDING_HOLD (or wake_gap_hours, when shorter; 0 holds nothing) the same batch may wake again.
  const woke = (await store.one('settings', [eq('key', 'radar_woke')]))?.value ?? { at: null };
  const sinceWake = waiting.filter(s => !woke.at || (s.found_at ?? '') > woke.at).length;
  const threshold = Math.min(Math.max(Number(input.wake_at) || 8, 1), 60);
  const gapMs = Math.max(Number(input.wake_gap_hours ?? 20), 0) * HOUR;
  const rested = !woke.at || now - Date.parse(woke.at) >= gapMs;
  const waitingAnswer = woke.pending_at && now - Date.parse(woke.pending_at) < Math.min(PENDING_HOLD, gapMs);
  const wake = input.schedule === true && sinceWake >= threshold && rested && !waitingAnswer;
  const cap = Math.min(Math.max(Number(input.max_items) || MAX_WAKE_ITEMS, 1), MAX_WAKE_ITEMS);
  let dropped = 0;
  if (wake) {
    await setSetting(store, 'radar_woke', { at: woke.at ?? null, pending_at: iso(now) });
    // The triage Soot is shown the best few, never the whole backlog.
    const ranked = [...waiting].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(b.found_at).localeCompare(String(a.found_at)));
    for (const s of ranked.slice(cap)) { await store.update('signals', [eq('ref', s.ref)], { state: 'dismissed', note: 'tự bỏ: vượt giới hạn mỗi lần' }); dropped++; }
    waiting = ranked.slice(0, cap);
  }
  return { read, new_total: read.reduce((n, r) => n + r.new, 0), waiting: waiting.length, ...(retired.length ? { retired } : {}), ...(skipped.length ? { skipped } : {}), ...(dropped ? { dropped } : {}), ...(wake ? { notify: true, wake: true, wake_items: waiting.length } : { notify: false, wake: false }) };
}

/** The triage Soot answered the wake: the gap starts at that wake, not at a refused one. */
async function answeredWake(store) {
  const woke = (await store.one('settings', [eq('key', 'radar_woke')]))?.value;
  if (woke?.pending_at) await setSetting(store, 'radar_woke', { at: woke.pending_at });
}

export async function signals_list(input, { store }) {
  if (!SIGNAL_STATES.includes(input.state) || input.state === 'new') await answeredWake(store);
  const state = SIGNAL_STATES.includes(input.state) ? input.state : 'new';
  const rows = await store.query('signals', [eq('state', state)], { order: 'found_at', desc: true, limit: Math.min(Number(input.limit) || (state === 'new' ? MAX_WAKE_ITEMS : 20), state === 'new' ? MAX_WAKE_ITEMS : 40) });
  return { state, signals: rows.map(r => ({ ref: r.ref, source: r.source, title: r.title, url: r.url, summary: short(r.summary, 220), ...(r.note ? { note: r.note } : {}) })), more: Math.max(0, (await store.query('signals', [eq('state', state)], { limit: 500 })).length - rows.length) };
}

/** signals_mark {items:[{ref, state, note?}]}: all or nothing, so one wrong ref changes none. */
export async function signals_mark(input, { store }) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length || items.length > 40) fail('invalid_request', 'items is 1–40 {ref, state, note}.');
  const seen = new Set();
  const rows = [];
  for (const it of items) {
    if (!['kept', 'dismissed', 'used'].includes(it?.state) || seen.has(it.ref)) fail('invalid_request', 'Each ref once, with state kept, dismissed or used.');
    if (it.state === 'kept' && !String(it.note ?? '').trim()) fail('invalid_request', 'A kept signal needs a one-line note: the angle and why now.');
    seen.add(it.ref);
    const row = await store.one('signals', [eq('ref', it.ref)]);
    if (!row) fail('not_found', `No signal ${it.ref}.`);
    rows.push([row, it]);
  }
  for (const [row, it] of rows) await store.update('signals', [eq('ref', row.ref)], { state: it.state, note: short(it.note, 300) || row.note || null });
  await answeredWake(store);
  return { marked: rows.length };
}

/** The kept signals a writer may use: newest first, unused. */
export async function keptSignals(store, n = 3) {
  const rows = await store.query('signals', [eq('state', 'kept')], { order: 'found_at', desc: true, limit: n });
  return rows.map(r => ({ ref: r.ref, title: short(r.title, 100), angle: short(r.note, 160), url: r.url }));
}
