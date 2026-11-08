// The sign-in probe (friction r2). A paused social channel waits for a person to sign in; this
// tool finds out, with no model turn, whether the Editor's own browser profile really is.
// It runs as the first and last step of a schedule tool chain around the browser:
//
//   marketing_channels_probe {}                      -> {action:"navigate", url}   (or {done:true})
//   browser-use_control (input from previous)        -> the page opens in the Editor's profile
//   browser-use_control {action:"command", args:["snapshot","-i","-c"]}
//   marketing_channels_probe (input from previous)   -> reads the page, decides, acts
//
// The decision is a heuristic over the page text; anything it cannot tell is `unknown` and
// changes nothing. It unpauses only a channel the founder confirmed ("Đã đăng nhập", reason
// `signed_in`) and that is really signed in. A confirmed channel that is not signed in goes back to
// `signed_out`, so the sign-in card is raised again. It never types, clicks or posts.
import { eq } from './store.mjs';
import { platformOf, fold } from './guard.mjs';
import { setSetting, pause, clearAttention } from './ops.mjs';

const MIN = 60_000, HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();

/** A page only a signed-in account can open (the same pages the Editor's dispatch skill checks). */
export const CHECK_URL = { x: 'https://x.com/home', facebook: 'https://www.facebook.com/settings', reddit: 'https://www.reddit.com/settings' };

const LOGIN_PATH = /\/(login|signin|sign-in|i\/flow\/login|checkpoint|recover|accounts\/login)(\/|\?|$)/;
const PASSWORD = /(password|mat khau|type="password")/;
const LOGIN_CTA = /(\blog in\b|\bsign in\b|\bdang nhap\b|\bcreate new account\b|\bsign up\b)/;
const SIGNED_IN = {
  x: /(account menu|menu tai khoan|\bprofile\b|\bho so\b)/,
  facebook: /(settings & privacy|cai dat va quyen rieng tu|account settings|cai dat tai khoan|your profile|trang ca nhan cua ban|general account settings)/,
  reddit: /(open inbox|expand user menu|user menu|create post|tao bai dang|tao bai viet)/,
};

/** 'signed_in' | 'signed_out' | 'unknown' for one platform from the opened page. */
export function classify(platform, { text = '', url = '' } = {}) {
  const t = fold(text), u = String(url).toLowerCase();
  if (LOGIN_PATH.test(u)) return 'signed_out';
  const signedIn = SIGNED_IN[platform]?.test(t);
  if (PASSWORD.test(t) && !signedIn) return 'signed_out';
  if (signedIn) return 'signed_in';
  if (LOGIN_CTA.test(t)) return 'signed_out';
  return 'unknown';
}

const pageOf = result => {
  const r = result && typeof result === 'object' ? result : {};
  const text = typeof r.snapshot === 'string' ? r.snapshot : typeof r.text === 'string' ? r.text : typeof result === 'string' ? result : '';
  return { text, url: typeof r.url === 'string' ? r.url : '' };
};

async function state(store) {
  return (await store.one('settings', [eq('key', 'probe')]))?.value ?? {};
}

/** The paused social channels worth a look now: the founder's confirmed ones first, then the oldest checked. */
function due(channels, st, now) {
  const rank = [];
  for (const c of channels) {
    if (c.kind !== 'social' || !c.paused || !CHECK_URL[c.platform ?? platformOf(c.key)]) continue;
    const confirmed = c.paused_reason === 'signed_in';
    if (!confirmed && c.paused_reason !== 'signed_out') continue;
    const mine = st.channels?.[c.key] ?? {};
    // The browser failing twice in a row backs the probe off for half a day instead of waking the Editor every time.
    const gap = (mine.tries ?? 0) >= 2 ? 12 * HOUR : confirmed ? 2 * MIN : 2 * HOUR;
    if (mine.at && now - Date.parse(mine.at) < gap) continue;
    rank.push({ c, confirmed, at: mine.at ? Date.parse(mine.at) : 0 });
  }
  rank.sort((a, b) => (b.confirmed - a.confirmed) || (a.at - b.at));
  return rank[0]?.c ?? null;
}

export async function channels_probe(input, deps) {
  const { store, now } = deps;
  const st = await state(store);
  if (input && typeof input === 'object' && 'result' in input) return decide(input.result, st, deps);

  const channels = await store.query('channels', [], { limit: 50 });
  const c = due(channels, st, now);
  if (!c) return { done: true, reason: 'nothing_to_probe' };
  const platform = c.platform ?? platformOf(c.key);
  const mine = st.channels?.[c.key] ?? {};
  await setSetting(store, 'probe', { ...st, current: { channel: c.key, platform, at: iso(now) }, channels: { ...(st.channels ?? {}), [c.key]: { ...mine, at: iso(now), tries: (mine.tries ?? 0) + 1 } } });
  return { action: 'navigate', url: CHECK_URL[platform] };
}

async function decide(result, st, deps) {
  const { store, now } = deps;
  const cur = st.current;
  if (!cur || now - Date.parse(cur.at) > 15 * MIN) return { done: true, reason: 'no_probe_pending' };
  const ch = await store.one('channels', [eq('key', cur.channel)]);
  const next = { ...st, current: null };
  if (!ch) { await setSetting(store, 'probe', next); return { done: true, reason: 'channel_gone' }; }
  const seen = classify(cur.platform, pageOf(result));
  const out = { ok: true, channel: ch.key, platform: cur.platform, state: seen, unpaused: false };
  next.channels = { ...(st.channels ?? {}), [ch.key]: { at: iso(now), state: seen, tries: seen === 'unknown' ? (st.channels?.[ch.key]?.tries ?? 0) : 0 } };
  await setSetting(store, 'probe', next);
  if (seen === 'signed_in') {
    out.resolves_need = true;
    if (ch.paused && ch.paused_reason === 'signed_in') { await pause({ channel: ch.key, paused: false }, deps); out.unpaused = true; }
    else if (ch.paused) out.awaiting = 'confirm';
  } else if (seen === 'signed_out' && ch.paused && ch.paused_reason === 'signed_in') {
    // The founder said done, the browser says no: back to a sign-in need, raised again.
    await store.update('channels', [eq('key', ch.key)], { paused: true, paused_reason: 'signed_out' });
    await clearAttention(store, 'channel', ch.key);
    out.reraised = true;
  }
  return out;
}
