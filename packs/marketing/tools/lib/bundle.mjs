// The publish bundle (spec §7, plan S2): one approval per source covers its blog
// in every language and the social posts made from it. publish_bundle is
// approval-gated by the host (`run.approval: operator`, `preflight: true`):
//   preflight  describes every post (language, channel, words, about when) from
//              the input and what this pack recorded; refuses a revision or a
//              text that moved since the Writer saved it. It gets no hub
//              binding and read-only storage, so it never acts.
//   executed   after Duyệt: re-reads the hub drafts, then only WRITES rows
//              (`bundles`, `releases`) with a slot per post. Nothing goes public.
// release_due (a tool-only schedule on the Editor) later publishes each due row
// through the hub with the revision the founder approved: it re-checks revision
// and words first, writes an intent before each hub call, looks an unknown
// outcome up instead of sending again, and holds a slot it missed by more than
// late_grace_min. stop and pause only prevent output.
import { fail, eq, gte, inList, skippedFor, MarketingError } from './store.mjs';
import { hubCall, hubBinding, WRITE_TIMEOUT_MS } from './hub.mjs';
import { nextSlot, localDay } from './time.mjs';
import { sha, postHash, blogHash, communityHash, newsletterHash, localId, itemRow, putItem, refFor, normalProduct, loadProducts, blogMode, blogDirOf, targetLabel, ITEM_REF, PRODUCT_ID, TZ } from './library.mjs';
import { libraryRoot, readText, writeText } from './root.mjs';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const DESK_CHANNELS = ['blog', 'x', 'facebook', 'tiktok', 'reddit', 'community', 'newsletter'];
const BUNDLE_CHANNELS = new Set(['blog', 'x', 'facebook', 'tiktok', 'community', 'newsletter']);
const SITE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOCIAL_ID = /^SP-[0-9A-F]{8}$/;
/** A part with no hub id: a hand-off post, a community post, a newsletter (`MK-XXXXXX.<lang>`). */
export const LOCAL_ID = /^MK-[0-9A-Z]{6}\.(vi|en)$/;
/** Parts the founder carries out by hand (or by email): they wait in `handoff` after the approval, never at the hub. */
const HAND = new Set(['community', 'newsletter', 'tiktok']);
export const LATE_GRACE_MIN = 360;
/** Social posts follow their blog by at least this long, so the link they carry is live. */
const AFTER_BLOG_MIN = 15;
/** Pending release states: the slot is still ahead (or due) and nothing went out yet. */
export const PENDING = ['scheduled'];
/** States that hold a slot on the channel's day (cap and spacing count them). */
const TAKES_SLOT = ['scheduled', 'publishing', 'approved', 'posted'];
/** States after which a release will not go out unless a new approval of its bundle re-arms it. */
const DEAD = ['stopped', 'missed', 'stale', 'failed', 'lapsed', 'held', 'superseded'];
/** The host cuts a preflight preview at 4000 bytes; stay under it so the card shows every post. */
const PREVIEW_MAX = 3900;

// ---------- rules and pause (settings rows, not the channels table) ----------

/** The default cadence, product-neutral: a blog and three social posts a day per channel, 90 min apart, quiet 23:00–07:00.
 *  A brand's own cadence is a rule the founder sets on the desk (Kênh đăng > Quy tắc), kept in settings. */
const CADENCE = { '*': { blog: 1, x: 3, facebook: 3 } };
const MAX_LEN = { x: 280, facebook: 5000 };
export const DEFAULT_QUIET_RULE = { from: '23:00', to: '07:00' };

export function defaultRules(product, channel) {
  const cap = (CADENCE[product] ?? CADENCE['*'])[channel] ?? null;
  return { cap_per_day: cap ?? 1, spacing_min: channel === 'blog' ? 0 : 90, quiet: { ...DEFAULT_QUIET_RULE }, ...(MAX_LEN[channel] ? { max_len: MAX_LEN[channel] } : {}), default: true };
}
const settingRow = (store, key) => store.one('settings', [eq('key', key)]);
async function putSetting(store, key, value) {
  const prev = await settingRow(store, key);
  if (prev) await store.update('settings', [eq('key', key)], { value });
  else { try { await store.insert('settings', { key, value }); } catch (e) { if (e.code !== 'conflict') throw e; await store.update('settings', [eq('key', key)], { value }); } }
}
export async function deskState(store) {
  const rows = await store.query('settings', [inList('key', ['desk_rules', 'desk_pause', 'desk_hub_ok_at', 'desk_late_grace_min', 'paused_all', 'paused_at'])], { limit: 10 });
  const v = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const pause = v.desk_pause && typeof v.desk_pause === 'object' ? v.desk_pause : {};
  // One pause: the pack's older "pause everything" (settings.paused_all, the hubless chain's) holds the desk too.
  const legacy = v.paused_all === true ? { since: typeof v.paused_at === 'string' ? v.paused_at : null, legacy: true } : null;
  return {
    rules: v.desk_rules && typeof v.desk_rules === 'object' ? v.desk_rules : {},
    pause: { all: pause.all ?? legacy, channels: pause.channels && typeof pause.channels === 'object' ? pause.channels : {} },
    hub_ok_at: typeof v.desk_hub_ok_at === 'string' ? v.desk_hub_ok_at : null,
    late_grace_min: Number.isInteger(v.desk_late_grace_min) ? v.desk_late_grace_min : LATE_GRACE_MIN,
  };
}
export const rulesFor = (state, key) => {
  const [product, channel] = key.split(':');
  return { ...defaultRules(product, channel), ...(state.rules[key] ?? {}), ...(state.rules[key] ? { default: false } : {}) };
};
export const pausedFor = (state, key) => state.pause.all ? { scope: 'all', since: state.pause.all.since } : state.pause.channels[key] ? { scope: 'channel', since: state.pause.channels[key].since } : null;

export async function setRules(store, key, rules) {
  const s = await deskState(store);
  await putSetting(store, 'desk_rules', { ...s.rules, [key]: rules });
  return rulesFor({ ...s, rules: { ...s.rules, [key]: rules } }, key);
}
/** pause/resume, all or one `<product>:<channel>`. Converges: pausing a paused scope keeps its first `since`.
 *  Pausing also takes back the X posts the hub already holds for the Poster (see holdApproved). */
export async function setPause(store, { scope, channel }, paused, now) {
  const s = await deskState(store);
  const since = new Date(now).toISOString();
  const next = { all: s.pause.all, channels: { ...s.pause.channels } };
  if (scope === 'all') next.all = paused ? (s.pause.all ?? { since }) : null;
  else if (paused) next.channels[channel] = s.pause.channels[channel] ?? { since };
  else delete next.channels[channel];
  await putSetting(store, 'desk_pause', next);
  // Resuming everything also lifts the older pause, which the hubless chain reads; the two never disagree.
  if (scope === 'all' && !paused) await putSetting(store, 'paused_all', false);
  return scope === 'all' ? next.all : next.channels[channel] ?? null;
}
export const markHubOk = (store, now) => putSetting(store, 'desk_hub_ok_at', new Date(now).toISOString()).catch(() => {});

// ---------- the bundle input ----------

const keyOf = (p) => (p.channel === 'blog' ? `blog:${p.site}/${p.slug}` : `${p.channel}:${p.id}`);
/** The same post key from a release row (its hub id is `hub_id`). */
export const releaseKeyOf = (r) => keyOf({ channel: r.channel, site: r.site, slug: r.slug, id: r.hub_id });
/** Validate and canonicalise publish_bundle's input. */
export function bundleInput(input) {
  if (!ITEM_REF.test(input?.ref ?? '')) fail('invalid_request', 'ref is the item ref, MK-XXXXXX.');
  if (!PRODUCT_ID.test(input?.product ?? '')) fail('invalid_request', 'product is a product id.');
  const posts = Array.isArray(input.posts) ? input.posts : [];
  if (!posts.length || posts.length > 8) fail('invalid_request', 'posts lists 1 to 8 posts: the blog in each language and the social posts made from it.');
  const seen = new Set();
  const out = posts.map((p, i) => {
    if (!BUNDLE_CHANNELS.has(p?.channel)) fail('invalid_request', `posts[${i}].channel is blog, x, facebook or tiktok.`);
    if (!['vi', 'en'].includes(p.lang)) fail('invalid_request', `posts[${i}].lang is vi or en.`);
    if (!Number.isInteger(p.revision) || p.revision < 1) fail('invalid_request', `posts[${i}].revision is the revision you reviewed (the hub's, or item_save's for a part saved only as files).`);
    const notBefore = p.not_before === undefined || p.not_before === null ? null : Date.parse(p.not_before);
    if (notBefore !== null && !Number.isFinite(notBefore)) fail('invalid_request', `posts[${i}].not_before is an ISO time.`);
    let c;
    if (p.channel === 'blog') {
      if (!SITE.test(p.site ?? '') || !SITE.test(p.slug ?? '')) fail('invalid_request', `posts[${i}] (blog) needs site and slug.`);
      const title = typeof p.title === 'string' ? p.title.trim() : '';
      if (!title || title.length > 200) fail('invalid_request', `posts[${i}].title is the revision's title, as cms_read returned it.`);
      c = { channel: 'blog', site: p.site, slug: p.slug, lang: p.lang, revision: p.revision, title };
    } else if (p.channel === 'community') {
      const title = typeof p.title === 'string' ? p.title.trim() : '', body = typeof p.body === 'string' ? p.body.trim() : '';
      if (!title || title.length > 300 || !body || body.length > 20000) fail('invalid_request', `posts[${i}] (community) needs title and body, exactly as item_save saved them.`);
      c = { channel: 'community', id: localId(input.ref, p.lang), lang: p.lang, revision: p.revision, title, body };
    } else if (p.channel === 'newsletter') {
      const subject = typeof p.subject === 'string' ? p.subject.trim() : '', body = typeof p.body === 'string' ? p.body.trim() : '';
      const preheader = typeof p.preheader === 'string' && p.preheader.trim() ? p.preheader.trim() : null;
      if (!subject || subject.length > 200 || !body || body.length > 40000) fail('invalid_request', `posts[${i}] (newsletter) needs subject and body, exactly as item_save saved them.`);
      c = { channel: 'newsletter', id: localId(input.ref, p.lang), lang: p.lang, revision: p.revision, subject, preheader, body };
    } else {
      // A post saved with no hub has no SP- id: it goes by its item and language and becomes the founder's hand-off.
      const id = p.id === undefined || p.id === null ? localId(input.ref, p.lang) : p.id;
      if (!SOCIAL_ID.test(id) && id !== localId(input.ref, p.lang)) fail('invalid_request', `posts[${i}].id is the hub's SP- id of the ${p.channel} post (leave it out for a post saved with no hub).`);
      p = { ...p, id };
      const text = typeof p.text === 'string' ? p.text : '';
      if (!text.trim() || text.length > 10000) fail('invalid_request', `posts[${i}].text is the queued text, exactly as social_list returned it.`);
      const link = p.link === undefined || p.link === null || p.link === '' ? null : String(p.link);
      if (link && (!/^https:\/\//.test(link) || link.length > 500)) fail('invalid_request', `posts[${i}].link is an https:// link or null.`);
      c = { channel: p.channel, id: p.id, lang: p.lang, revision: p.revision, text, link };
    }
    if (notBefore !== null) c.not_before = new Date(notBefore).toISOString();
    const k = keyOf(c);
    if (seen.has(k)) fail('invalid_request', `posts[${i}] repeats ${k}.`);
    seen.add(k);
    return c;
  });
  // Blog first, then social by channel and language: the order the founder reads and the order they go out.
  const order = ['blog', 'x', 'facebook', 'tiktok', 'community', 'newsletter'];
  out.sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel) || a.lang.localeCompare(b.lang));
  return { ref: input.ref, product: input.product, posts: out };
}
export const bundleKey = (b) => sha(JSON.stringify([b.ref, b.product, b.posts]));
const releaseKey = (bkey, p) => sha(`${bkey}|${keyOf(p)}`).slice(0, 40);

/** What this pack recorded for an item's post (the Writer's item_save), to see whether it moved. */
function recorded(meta, p) {
  if (!meta) return null;
  if (p.channel === 'blog') return (meta.langs ?? []).find(l => l.site === p.site && l.slug === p.slug) ?? null;
  if (p.channel === 'community') return meta.community && meta.community.lang === p.lang ? meta.community : null;
  if (p.channel === 'newsletter') return meta.newsletter && meta.newsletter.lang === p.lang ? meta.newsletter : null;
  return (meta.posts ?? []).find(x => x.id === p.id) ?? (LOCAL_ID.test(p.id) ? (meta.posts ?? []).find(x => !x.id && x.channel === p.channel && x.lang === p.lang) ?? null : null);
}
/** The hash a part's words have, as item_save recorded it. */
function partHash(p) {
  if (p.channel === 'community') return communityHash(p.title, p.body);
  if (p.channel === 'newsletter') return newsletterHash(p.subject, p.preheader, p.body);
  if (p.channel === 'blog') return null;
  return postHash(p.text, p.link);
}
/** Whether a part goes through the hub: a hub social post (SP- id), or a blog the hub holds. */
const atHub = (p, rec, prod) => (p.channel === 'blog' ? !rec?.local && !['folder', 'none'].includes(prod?.blog) : SOCIAL_ID.test(p.id ?? ''));
/** The product as library_scan indexed it (preflight has no library root), else from products.json, else a bare one. */
async function productFor(store, env, id) {
  const row = await store.one('library', [eq('path', 'products.json')]).catch(() => null);
  const indexed = (row?.meta?.products ?? []).find(p => p.id === id);
  // The index holds normalized products: normalizing again would read the default blog_dir as a chosen folder.
  if (indexed) return 'blog' in indexed ? { ...normalProduct(indexed), blog: indexed.blog, blog_dir: indexed.blog_dir ?? null } : normalProduct(indexed);
  const lr = await libraryRoot(env).catch(() => ({ ok: false }));
  if (lr.ok) { const p = (await loadProducts({ root: lr.root }).catch(() => [])).find(x => x.id === id); if (p) return p; }
  return normalProduct({ id });
}

// ---------- slots ----------

const jitter = (seed) => Number.parseInt(sha(seed).slice(0, 2), 16) % 10;
/** The slot of each post: blog langs share one slot, social follow the blog, each channel on its cadence. */
export function planSlots(bundle, { state, taken, now }) {
  const out = new Map();
  const extra = new Map();
  const takenFor = (key) => [...(taken.get(key) ?? []), ...(extra.get(key) ?? [])];
  let blogAt = null;
  for (const p of bundle.posts) {
    const key = `${bundle.product}:${p.channel}`;
    const r = rulesFor(state, key);
    const quiet = r.quiet ? { ...r.quiet, tz: TZ } : null;
    const from = Math.max(now, p.not_before ? Date.parse(p.not_before) : 0, p.channel !== 'blog' && blogAt ? blogAt + AFTER_BLOG_MIN * MIN : 0);
    let at;
    if (p.channel === 'blog' && blogAt) at = blogAt;
    else if (HAND.has(p.channel) || LOCAL_ID.test(p.id ?? '')) at = from;
    else at = nextSlot({ from, taken: takenFor(key), cap: Math.max(1, r.cap_per_day ?? 1), spacingMin: r.spacing_min ?? 0, quiet, jitterMin: p.channel === 'blog' ? 0 : jitter(keyOf(p)), horizonDays: 21 });
    if (at === null) fail('no_slot', `No slot in the next 3 weeks for ${key}; raise its cap or spacing on the desk (Kênh đăng).`);
    if (p.channel === 'blog') blogAt = at;
    if (!(p.channel === 'blog' && extra.get(key)?.includes(at))) extra.set(key, [...(extra.get(key) ?? []), at]);
    out.set(keyOf(p), at);
  }
  return out;
}
/** Slots already held per `<product>:<channel>` (a blog pair counts once per bundle). */
export async function takenSlots(store, product, now, except = new Set()) {
  const rows = await store.query('releases', [eq('product', product), inList('state', TAKES_SLOT), gte('slot_at', new Date(now - 2 * DAY).toISOString())], { order: 'slot_at', limit: 500 });
  const map = new Map(), seen = new Set();
  for (const r of rows) {
    if (except.has(r.key)) continue; // a row this approval replaces does not hold its slot
    const key = `${r.product}:${r.channel}`;
    const once = `${key}|${r.bundle}|${r.slot_at}`;
    if (r.channel === 'blog' && seen.has(once)) continue;
    seen.add(once);
    map.set(key, [...(map.get(key) ?? []), Date.parse(r.slot_at)]);
  }
  return map;
}

// ---------- preflight preview ----------

const CH_NAME = { blog: 'Blog', x: 'X', facebook: 'Facebook', tiktok: 'TikTok', community: 'Cộng đồng', newsletter: 'Bản tin' };
const BODY_PREVIEW = 700;
const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}… (đủ bài trong mục trên bàn)` : t);
const LANG_NAME = { vi: 'tiếng Việt', en: 'tiếng Anh' };
const fmt = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.day}/${p.month}`;
};
export function previewText(bundle, { meta, slots, accounts = {}, prod = null }) {
  const title = meta?.title ?? bundle.posts.find(p => p.channel === 'blog')?.title ?? bundle.ref;
  const lines = [`Gói đăng ${bundle.ref} (${bundle.product}): ${title}`, `${bundle.posts.length} bài. Duyệt một lần cho cả gói; sửa bài nào thì gói đó phải duyệt lại.`];
  for (const p of bundle.posts) {
    const at = slots.get(keyOf(p));
    const rec = recorded(meta, p);
    const hand = HAND.has(p.channel) || LOCAL_ID.test(p.id ?? '');
    const when = p.channel === 'newsletter' ? 'bạn gửi' : hand ? 'bạn đăng tay' : p.channel === 'blog' && !atHub(p, rec, prod) ? `ghi vào thư mục site ${fmt(at)}` : p.channel === 'x' ? `khoảng ${fmt(at)}` : fmt(at);
    lines.push('');
    if (p.channel === 'blog') {
      lines.push(`• Blog ${LANG_NAME[p.lang]} · ${p.site}/${p.slug} · bản ${p.revision} · ${when}`);
      lines.push(`  ${p.title}`);
      if (rec?.preview_url) lines.push(`  Đọc bản xem trước: ${rec.preview_url}`);
    } else if (p.channel === 'community') {
      const target = targetLabel(rec?.target ?? meta?.community?.target);
      lines.push(`• ${CH_NAME.community} ${LANG_NAME[p.lang]}${target ? ` · ${target}` : ''} · ${when}`);
      lines.push(`  ${p.title}`);
      for (const l of clip(p.body, BODY_PREVIEW).split('\n')) lines.push(`  ${l}`);
    } else if (p.channel === 'newsletter') {
      lines.push(`• ${CH_NAME.newsletter} ${LANG_NAME[p.lang]} · ${when}`);
      lines.push(`  ${p.subject}${p.preheader ? ` · ${p.preheader}` : ''}`);
      for (const l of clip(p.body, BODY_PREVIEW).split('\n')) lines.push(`  ${l}`);
    } else {
      const acc = accounts[p.channel] ? ` · ${accounts[p.channel]}` : '';
      lines.push(`• ${CH_NAME[p.channel]} ${LANG_NAME[p.lang]}${acc} · ${p.text.length} ký tự · ${when}`);
      for (const l of p.text.split('\n')) lines.push(`  ${l}`);
      if (p.link) lines.push(`  ${p.link}`);
    }
  }
  lines.push('', 'Bấm Duyệt chỉ ghi lịch. Bài lên đúng lượt của kênh; X lên trong khoảng 30 phút sau giờ đó.');
  return lines.join('\n');
}

// ---------- publish_bundle ----------

/**
 * publish_bundle. Preflight (hook tool.preflight) returns {preview} or throws a refusal; the executed call writes the
 * bundle and its releases. Idempotent on the bundle key: the same approved set again returns the rows it wrote.
 */
export async function publish_bundle(input, { store, env, now, fetch: fetchImpl, soot, hook }) {
  const bundle = bundleInput(input);
  const row = await itemRow(store, bundle.ref);
  const meta = row?.meta ?? null;
  if (meta && meta.product && meta.product !== bundle.product) fail('invalid_request', `${bundle.ref} belongs to ${meta.product}, not ${bundle.product}.`);
  if (meta?.state === 'stopped') fail('stopped', `${bundle.ref} was stopped on the desk; the founder asks the Editor to reopen it first.`);
  // What the Writer saved is what the founder approves: a revision or text that moved since is refused here.
  for (const p of bundle.posts) {
    const rec = recorded(meta, p);
    if (!rec) { if (['community', 'newsletter'].includes(p.channel) || LOCAL_ID.test(p.id ?? '')) fail('not_found', `${keyOf(p)}: item_save has not saved this part; save it first.`); continue; }
    if (Number.isInteger(rec.revision) && rec.revision !== p.revision) fail('moved', `${keyOf(p)} is at revision ${rec.revision} in the library, not ${p.revision}; read it again and send the bundle again.`);
    if (p.channel !== 'blog' && rec.hash && rec.hash !== partHash(p)) fail('moved', `${keyOf(p)}: the text differs from what the Writer saved; send exactly the saved text.`);
  }
  const prod = await productFor(store, env, bundle.product);
  const key = bundleKey(bundle);
  const state = await deskState(store);
  const prior = await store.one('bundles', [eq('key', key)]);
  const live = prior ? await bundleLive(store, prior) : false;
  if (hook === 'tool.preflight') {
    // The same set already approved and on schedule: refuse here, so the host files no second card.
    if (live) fail('already_scheduled', `${bundle.ref}: this exact set is already approved and scheduled; there is nothing to ask. The desk shows it under Sắp lên.`);
    const doomed = await replaced(store, bundle, key);
    const slots = planSlots(bundle, { state, taken: await takenSlots(store, bundle.product, now, doomed.keys), now });
    const preview = previewText(bundle, { meta, slots, prod });
    const size = Buffer.byteLength(preview, 'utf8');
    if (size > PREVIEW_MAX) fail('too_long', `The preview of this bundle is ${size} bytes, over ${PREVIEW_MAX}; send the blog and the social posts as two bundles.`);
    return { preview };
  }
  if (live) return bundleAnswer(store, prior, { replayed: true });
  const hub = hubBinding(env).ok;
  const viaHub = bundle.posts.filter(p => atHub(p, recorded(meta, p), prod));
  if (viaHub.length && !hub) fail('needs_credential', `publish_bundle releases ${viaHub.map(keyOf).join(', ')} through the marketing hub: set MARKETING_HUB first.`);
  // A post for a channel the product has no account on (or one not connected) is left out and stays a draft (P2-7).
  const skipped = await skipsFor(bundle, { prod, hub, env, fetchImpl, soot, meta });
  const kept = { ...bundle, posts: bundle.posts.filter(p => !skipped.some(s => s.key === keyOf(p))) };
  if (!kept.posts.length) fail('no_channel', `${bundle.ref}: no post of this bundle has a channel to go to (${skipped.map(s => `${s.channel} ${s.reason}`).join(', ')}). Nothing was scheduled.`);
  // The hub is re-read after approval: a draft changed while the card waited is refused, nothing written.
  const check = await verifyAtHub(env, kept.posts.filter(p => atHub(p, recorded(meta, p), prod)), { fetchImpl, soot });
  if (check.moved.length) fail('moved', `Changed at the hub since the founder saw it: ${check.moved.map(m => `${m.key} (${m.why})`).join(', ')}. Nothing was scheduled; ask for approval of the new text.`);
  // A newer approved set replaces what was still waiting for the same posts; those rows do not hold slots.
  const doomed = await replaced(store, kept, key);
  const slots = planSlots(kept, { state, taken: await takenSlots(store, bundle.product, now, doomed.keys), now });
  const stamp = new Date(now).toISOString();
  const head = { state: 'approved', approved_at: stamp, verified: hub && viaHub.length ? check.reachable : true, by: typeof soot === 'string' ? soot : null };
  // A set approved again after it was stopped, missed or replaced is re-armed under the same key.
  if (prior) await store.update('bundles', [eq('key', key)], head);
  else {
    try { await store.insert('bundles', { key, ref: bundle.ref, product: bundle.product, posts: kept.posts, ...head }); } catch (e) {
      if (e.code !== 'conflict') throw e;
      return bundleAnswer(store, await store.one('bundles', [eq('key', key)]), { replayed: true });
    }
  }
  // A launch pack: after Duyệt its Show HN part is its own community item, a hand-off of its own (handoff_community).
  const split = meta?.format === 'launch' ? await splitLaunch(store, env, meta, kept, now) : null;
  await ensureReleases(store, kept, key, slots, { meta, prod, split });
  const superseded = await retire(store, doomed);
  if (meta) await store.update('library', [eq('ref', bundle.ref), eq('kind', 'item')], { meta: { ...meta, state: 'scheduled', bundle: key, skipped: skipped.map(({ key: k, ...s }) => s), ...(split ? { split: split.ref } : {}) } });
  if (hub && viaHub.length && check.reachable) await markHubOk(store, now);
  return bundleAnswer(store, await store.one('bundles', [eq('key', key)]), { superseded, ...(prior ? { rearmed: true } : {}), ...(skipped.length ? { skipped: skipped.map(({ key: k, ...s }) => s) } : {}), ...(split ? { split: split.ref } : {}) });
}

/** The posts this approval leaves out, [{key, channel, lang, reason}]: reason no_account (the product has none on that
 *  channel, or its blog is "none") or channel_not_connected (it has one the hub cannot post to yet). */
async function skipsFor(bundle, { prod, hub, env, fetchImpl, soot, meta }) {
  const out = [];
  let channels = null;
  for (const p of bundle.posts) {
    let reason = null;
    if (p.channel === 'blog') reason = prod.blog === 'none' ? 'no_account' : null;
    else if (['x', 'facebook'].includes(p.channel)) {
      if (SOCIAL_ID.test(p.id ?? '') && hub) {
        channels ??= await hubCall(env, 'social_channels', {}, { fetchImpl, soot });
        // An unreachable hub leaves the post in: release_due checks it again before anything goes out.
        if (channels.ok) {
          const c = (channels.data.channels ?? []).find(x => x.channel === p.channel);
          const accounts = (c?.accounts ?? []).filter(a => !Array.isArray(a.sites) || a.sites.includes(prod.hub_site));
          if (!c?.connected || !accounts.length) reason = prod.accounts[p.channel] ? 'channel_not_connected' : 'no_account';
        }
      } else if (!SOCIAL_ID.test(p.id ?? '') && !prod.accounts[p.channel]) reason = 'no_account';
    }
    if (reason) out.push({ key: keyOf(p), channel: p.channel, lang: p.lang, reason });
  }
  void meta;
  return out;
}

/** The Show HN (community) part of an approved launch pack as its own item: {ref, meta}. Converges on its ref. */
async function splitLaunch(store, env, meta, bundle, now) {
  const part = bundle.posts.find(p => p.channel === 'community');
  if (!part) return null;
  const ref = refFor(`launch-split:${meta.ref}`);
  const have = await itemRow(store, ref);
  // Re-approved with new Show HN words: the child item takes them, so its row is not held as changed.
  if (have && have.meta?.community?.hash === partHash(part)) return { ref, meta: have.meta };
  const child = {
    ref, product: meta.product, format: 'community', parent: meta.ref, slug: `${meta.slug}-show-hn`.slice(0, 80), day: meta.day, dir: `${meta.dir}-show-hn`,
    title: part.title ?? meta.community?.title, series: meta.series ?? null, campaign: meta.campaign ?? null, source: meta.source ?? null,
    state: 'scheduled', created_at: new Date(now).toISOString(), by: meta.by ?? null, langs: [], posts: [], channels: ['community'],
    community: { ...meta.community, title: part.title ?? meta.community?.title, body: part.body, hash: partHash(part) }, revision: part.revision,
    ...(have ? { created_at: have.meta.created_at, state: have.meta.state } : {}),
  };
  const lr = await libraryRoot(env).catch(() => ({ ok: false }));
  if (lr.ok) await writeText(lr.root, `${child.dir}/community.md`, `---\ntitle: ${JSON.stringify(child.title)}\ntarget: ${JSON.stringify(targetLabel(child.community.target))}\n---\n\n${part.body}\n`);
  await putItem(store, lr.ok ? lr.root : null, child, { now });
  return { ref, meta: child };
}

/** A bundle is live when it is approved, every post has its row and none of them ended without going out. */
async function bundleLive(store, b) {
  if (b.state !== 'approved') return false;
  const rows = await store.query('releases', [eq('bundle', b.key)], { limit: 20 });
  return rows.length >= (b.posts?.length ?? 0) && !rows.some(r => DEAD.includes(r.state));
}

/** One row per post, converging: missing rows are written, rows that ended are re-armed at their new slot, the rest stay. */
async function ensureReleases(store, bundle, key, slots, { meta = null, prod = null, split = null } = {}) {
  for (const p of bundle.posts) {
    const rk = releaseKey(key, p);
    const slot_at = new Date(slots.get(keyOf(p))).toISOString();
    const rec = recorded(meta, p);
    // A blog the hub does not hold is written to the site folder by release_due; the rest by hand is the founder's.
    const folder = p.channel === 'blog' && !atHub(p, rec, prod);
    const hand = HAND.has(p.channel) || LOCAL_ID.test(p.id ?? '');
    const via = folder ? 'folder' : p.channel === 'newsletter' ? 'newsletter' : hand ? 'hand' : null;
    const fresh = { state: hand ? 'handoff' : 'scheduled', slot_at, intent_at: null, outcome: via ? { via } : null, url: null, reason: null };
    const was = await store.one('releases', [eq('key', rk)]);
    if (was) { if (DEAD.includes(was.state)) await set(store, was, was.state, fresh); continue; }
    const title = p.channel === 'blog' || p.channel === 'community' ? p.title : p.channel === 'newsletter' ? p.subject : p.text.slice(0, 120);
    try {
      await store.insert('releases', {
        key: rk, bundle: key, ref: p.channel === 'community' && split ? split.ref : bundle.ref, product: bundle.product, channel: p.channel, lang: p.lang,
        site: p.site ?? null, slug: p.slug ?? null, hub_id: p.id ?? null, revision: p.revision, title: String(title).slice(0, 300),
        // A folder blog is checked against the words the Writer saved (the hub has no revision of it to check).
        text_hash: folder ? rec?.hash ?? null : partHash(p), not_before: p.not_before ?? null, ...fresh,
      });
    } catch (e) { if (e.code !== 'conflict') throw e; }
  }
}

/** Rows of other bundles still waiting to publish one of these posts: {rows, keys}. */
async function replaced(store, bundle, key) {
  const mine = new Set(bundle.posts.map(keyOf));
  // Hand-offs too: once a newer set is approved, the founder carries out the new words, never the old ones.
  const rows = (await store.query('releases', [eq('product', bundle.product), inList('state', [...PENDING, 'handoff', 'exported'])], { order: 'slot_at', limit: 500 }))
    .filter(r => r.bundle !== key && mine.has(releaseKeyOf(r)));
  return { rows, keys: new Set(rows.map(r => r.key)) };
}

/** Retire the replaced rows; an old bundle is superseded only once none of its rows still waits. */
async function retire(store, { rows }) {
  let n = 0;
  const touched = new Set();
  for (const r of rows) {
    n += await store.update('releases', [eq('key', r.key), eq('state', r.state)], { state: 'superseded', reason: 'newer_bundle' });
    touched.add(r.bundle);
  }
  for (const b of touched) {
    if ((await store.query('releases', [eq('bundle', b), inList('state', [...PENDING, 'handoff', 'exported'])], { limit: 1 })).length) continue;
    await store.update('bundles', [eq('key', b), eq('state', 'approved')], { state: 'superseded' });
  }
  return n;
}

async function bundleAnswer(store, b, extra = {}) {
  const rows = await store.query('releases', [eq('bundle', b.key)], { order: 'slot_at', desc: false, limit: 20 });
  return {
    ok: true, ref: b.ref, product: b.product, bundle: b.key.slice(0, 12), state: b.state, verified: !!b.verified, ...extra,
    releases: rows.map(r => ({ channel: r.channel, lang: r.lang, slot_at: r.slot_at, state: r.state, ...(r.channel === 'x' ? { about: true } : {}) })),
    next: nextText(rows),
  };
}

function nextText(rows) {
  const ended = rows.filter(r => DEAD.includes(r.state));
  if (!rows.length) return 'Nothing is scheduled for this bundle.';
  if (ended.length === rows.length) return `Nothing will go out: every post ended (${[...new Set(ended.map(r => r.state))].join(', ')}). Send the bundle again for a new approval.`;
  const waiting = rows.filter(r => PENDING.includes(r.state) || r.state === 'publishing').length;
  const parts = [waiting ? `${waiting} post(s) scheduled; release_due publishes each at its slot, nothing else to call.` : 'Nothing left to schedule.'];
  if (ended.length) parts.push(`${ended.length} ended (${[...new Set(ended.map(r => r.state))].join(', ')}).`);
  return `${parts.join(' ')} The desk shows it under Sắp lên.`;
}

/** Re-read each post at the hub: {reachable, moved:[{key, why}], seen: Map(key → hub record)}. */
async function verifyAtHub(env, posts, { fetchImpl, soot }) {
  const moved = [], seen = new Map();
  let reachable = true;
  const lists = new Map();
  for (const p of posts) {
    if (p.channel === 'blog') {
      const r = await hubCall(env, 'cms_read', { site: p.site, slug: p.slug }, { fetchImpl, soot });
      if (!r.ok) { if (r.error === 'refused') moved.push({ key: keyOf(p), why: 'gone' }); else reachable = false; continue; }
      seen.set(keyOf(p), r.data);
      if (r.data.revision !== p.revision) moved.push({ key: keyOf(p), why: `revision ${r.data.revision}` });
      else if (String(r.data.title ?? '').trim() !== p.title) moved.push({ key: keyOf(p), why: 'title' });
    } else {
      if (!lists.has(p.channel)) lists.set(p.channel, await hubCall(env, 'social_list', { channel: p.channel, limit: 50 }, { fetchImpl, soot }));
      const r = lists.get(p.channel);
      if (!r.ok) { reachable = false; continue; }
      const post = (r.data.posts ?? []).find(x => x.id === p.id);
      if (!post) { reachable = false; continue; } // past the newest 50: release_due checks it again by id
      seen.set(keyOf(p), post);
      if (post.revision !== p.revision) moved.push({ key: keyOf(p), why: `revision ${post.revision}` });
      else if (postHash(post.text, post.link) !== postHash(p.text, p.link)) moved.push({ key: keyOf(p), why: 'text' });
      else if (!['draft', 'failed'].includes(post.status)) moved.push({ key: keyOf(p), why: post.status });
    }
  }
  return { reachable, moved, seen };
}

// ---------- release_due ----------

const NEED_KINDS = new Set(['changed', 'missed', 'uncertain', 'failed', 'returns_to_draft', 'blog_not_live']);
async function raiseNeed(store, need, now) {
  const key = `desk:${need.kind}:${need.release}`;
  if (await store.one('attention', [eq('key', key)])) return false;
  try { await store.insert('attention', { key, kind: `desk_${need.kind}`, ref: need.ref, reason: need.reason ?? need.kind, raised_at: new Date(now).toISOString() }); return true; } catch (e) { if (e.code === 'conflict') return false; throw e; }
}
const set = (store, r, from, patch) => store.update('releases', [eq('key', r.key), eq('state', from)], patch);

/** Look one release up at the hub: what happened to it, never sending anything. */
async function lookUp(env, r, { fetchImpl, soot, lists }) {
  if (r.channel === 'blog') {
    const res = await hubCall(env, 'cms_read', { site: r.site, slug: r.slug }, { fetchImpl, soot });
    if (!res.ok) return res.error === 'refused' ? { gone: true } : { unknown: true, error: res.error };
    return { post: res.data };
  }
  // The hub has no read by id: list the channel's newest 50, then the status this row expects, so a post
  // pushed past the newest 50 by later drafts is still found.
  const read = async (status) => {
    const k = `${r.channel}|${status ?? ''}`;
    if (!lists.has(k)) lists.set(k, await hubCall(env, 'social_list', { channel: r.channel, ...(status ? { status } : {}), limit: 50 }, { fetchImpl, soot }));
    return lists.get(k);
  };
  const res = await read(null);
  if (!res.ok) return { unknown: true, error: res.error };
  let post = (res.data.posts ?? []).find(x => x.id === r.hub_id);
  for (const status of EXPECT[r.state] ?? []) {
    if (post) break;
    const more = await read(status);
    if (!more.ok) return { unknown: true, error: more.error };
    post = (more.data.posts ?? []).find(x => x.id === r.hub_id);
  }
  return post ? { post } : { unknown: true, error: 'not_listed' };
}
/** The hub statuses a row in this state is most likely in, checked in order when the newest 50 miss it. */
const EXPECT = { scheduled: ['draft', 'failed', 'published'], publishing: ['published', 'approved', 'uncertain', 'draft'], approved: ['approved', 'published', 'uncertain'] };

/**
 * release_due: publish what is due from approved bundles, at most `limit` hub writes a run. Output
 * {ok, released, held, waiting, needs, notify, wake:false}; notify is true only when a new Cần bạn line appeared.
 */
export async function release_due(input, { store, env, now, fetch: fetchImpl, soot }) {
  const hub = hubBinding(env).ok;
  // Blogs a product keeps in its own site folder are written here, with or without a hub.
  const folderRows = (await store.query('releases', [eq('channel', 'blog'), inList('state', ['scheduled', 'publishing'])], { order: 'slot_at', desc: false, limit: 300 }))
    .filter(r => r.outcome?.via === 'folder');
  if (!hub && !folderRows.length) return skippedFor('MARKETING_HUB');
  const state = await deskState(store);
  const limit = Number.isInteger(input?.limit) ? Math.min(Math.max(input.limit, 1), 20) : 6;
  const out = { ok: true, released: [], held: [], waiting: 0, looked_up: 0, needs: [], notify: false, wake: false };
  const need = async (r, kind, reason) => {
    if (!NEED_KINDS.has(kind)) return;
    const fresh = await raiseNeed(store, { kind, release: r.key, ref: r.ref, reason }, now);
    out.needs.push({ kind, ref: r.ref, product: r.product, channel: r.channel, lang: r.lang, title: r.title, reason: reason ?? null, new: fresh });
    if (fresh) out.notify = true;
  };
  const hold = (r, reason) => out.held.push({ ref: r.ref, channel: r.channel, lang: r.lang, reason });
  const released = (r, state) => out.released.push({ ref: r.ref, channel: r.channel, lang: r.lang, state });
  // The hub answered but does not list the post under any status it could be in: say so once, never wait silently.
  const lost = async (r, l) => { out.waiting++; if (l.error === 'not_listed') { reachable = true; await need(r, 'uncertain', 'not_listed'); } };
  let writes = 0;
  await releaseFolder(folderRows, { store, env, now, state, out, need, hold, released, limit, count: () => writes++ });
  if (!hub) return finish(store, out);
  const rows = (await store.query('releases', [inList('state', ['scheduled', 'publishing', 'approved'])], { order: 'slot_at', desc: false, limit: 300 }))
    .filter(r => r.outcome?.via !== 'folder');
  const bundles = new Map((await store.query('bundles', [inList('key', [...new Set(rows.map(r => r.bundle))].slice(0, 200))], { limit: 200 })).map(b => [b.key, b]));
  const lists = new Map();
  const stamp = new Date(now).toISOString();
  let reachable = false;

  // 1. Unknown outcomes first: a write whose answer was lost is looked up, never sent again.
  for (const r of rows.filter(x => x.state === 'publishing')) {
    out.looked_up++;
    const l = await lookUp(env, r, { fetchImpl, soot, lists });
    if (l.unknown) { await lost(r, l); continue; }
    reachable = true;
    if (l.gone) { await set(store, r, 'publishing', { state: 'failed', reason: 'gone' }); await need(r, 'failed', 'gone'); continue; }
    const p = l.post;
    if (p.status === 'published') { await set(store, r, 'publishing', { state: 'posted', url: p.url ?? null, outcome: { status: 'published', at: p.published_at ?? stamp, looked_up: true } }); released(r, 'posted'); continue; }
    if (r.channel !== 'blog' && p.status === 'approved') { await set(store, r, 'publishing', { state: 'approved', revision: p.revision, outcome: { status: 'approved', looked_up: true } }); continue; }
    if (['publishing', 'uncertain'].includes(p.status)) { await set(store, r, 'publishing', { state: 'uncertain', outcome: { status: p.status, looked_up: true } }); await need(r, 'uncertain'); continue; }
    if (p.status === 'failed') { await set(store, r, 'publishing', { state: 'failed', reason: String(p.note ?? 'failed').slice(0, 300) }); await need(r, 'failed', p.note); continue; }
    // The call never landed: the hub still holds the approved revision as a draft, so it may go at its slot.
    if (p.status === 'draft' && p.revision === r.revision) { await set(store, r, 'publishing', { state: 'scheduled', intent_at: null, outcome: { status: 'not_sent', looked_up: true } }); r.state = 'scheduled'; continue; }
    await set(store, r, 'publishing', { state: 'stale', reason: `revision ${p.revision}` }); await need(r, 'changed', `revision ${p.revision}`);
  }

  // 2. X posts the hub holds as approved: the Poster takes them; the desk follows what happened.
  for (const r of rows.filter(x => x.state === 'approved')) {
    const l = await lookUp(env, r, { fetchImpl, soot, lists });
    if (l.unknown) { await lost(r, l); continue; }
    reachable = true;
    const p = l.post;
    if (!p) continue;
    if (p.status === 'published') { await set(store, r, 'approved', { state: 'posted', url: p.url ?? null, outcome: { status: 'published', at: p.published_at ?? stamp } }); released(r, 'posted'); }
    else if (p.status === 'uncertain' || p.status === 'publishing') { if (p.status === 'uncertain') { await set(store, r, 'approved', { state: 'uncertain', outcome: { status: 'uncertain' } }); await need(r, 'uncertain'); } else out.waiting++; }
    else if (p.status === 'failed') { await set(store, r, 'approved', { state: 'failed', reason: String(p.note ?? 'failed').slice(0, 300) }); await need(r, 'failed', p.note); }
    else if (p.status === 'draft') { await set(store, r, 'approved', { state: 'lapsed', reason: String(p.note ?? 'returned to draft').slice(0, 300) }); await need(r, 'returns_to_draft', p.note); }
    else if (p.status === 'discarded') { await set(store, r, 'approved', { state: 'stopped', reason: 'discarded' }); }
    else { out.waiting++; if (p.note) await store.update('releases', [eq('key', r.key)], { outcome: { status: 'approved', note: String(p.note).slice(0, 300) } }); }
  }

  // 3. Due posts, in slot order.
  const due = rows.filter(x => x.state === 'scheduled' && Date.parse(x.slot_at) <= now);
  out.waiting += rows.filter(x => x.state === 'scheduled' && Date.parse(x.slot_at) > now).length;
  if (state.pause.all) { out.paused = true; for (const r of due) hold(r, 'paused'); }
  else for (const r of due) {
    const key = `${r.product}:${r.channel}`;
    const b = bundles.get(r.bundle);
    // Only a row written by an executed (approved) publish_bundle is ever published.
    if (!b || b.state !== 'approved' || b.ref !== r.ref) { await set(store, r, 'scheduled', { state: 'held', reason: 'no_bundle' }); hold(r, 'no_bundle'); continue; }
    if (pausedFor(state, key)) { hold(r, 'paused'); continue; }
    const late = now - Date.parse(r.slot_at);
    if (late > state.late_grace_min * MIN) { await set(store, r, 'scheduled', { state: 'missed', reason: `late ${Math.round(late / MIN)} min` }); await need(r, 'missed', `late ${Math.round(late / MIN)} min`); hold(r, 'missed'); continue; }
    if (r.channel !== 'blog') {
      const blogs = await store.query('releases', [eq('bundle', r.bundle), eq('channel', 'blog')], { limit: 4 });
      if (blogs.some(x => ['missed', 'stale', 'failed', 'stopped', 'superseded', 'held'].includes(x.state))) { await set(store, r, 'scheduled', { state: 'held', reason: 'blog_not_live' }); await need(r, 'blog_not_live'); hold(r, 'blog_not_live'); continue; }
      // A blog written to the site folder is out as much as one the hub posted.
      if (blogs.some(x => !['posted', 'written'].includes(x.state))) { out.waiting++; continue; }
    }
    // Cap and spacing on the day it goes: a slot that a later approval crowded moves to the next free one.
    if (r.channel !== 'blog') {
      const r2 = rulesFor(state, key);
      const today = (await store.query('releases', [eq('product', r.product), eq('channel', r.channel), inList('state', ['publishing', 'approved', 'posted'])], { order: 'slot_at', limit: 100 }))
        .map(x => Date.parse(x.outcome?.at ?? x.intent_at ?? x.slot_at)).filter(t => localDay(t, TZ) === localDay(now, TZ));
      if (today.length >= (r2.cap_per_day ?? 1) || today.some(t => Math.abs(now - t) < (r2.spacing_min ?? 0) * MIN)) {
        const at = nextSlot({ from: now + MIN, taken: today, cap: r2.cap_per_day ?? 1, spacingMin: r2.spacing_min ?? 0, quiet: r2.quiet ? { ...r2.quiet, tz: TZ } : null, jitterMin: jitter(r.key), horizonDays: 21 });
        if (at) await set(store, r, 'scheduled', { slot_at: new Date(at).toISOString(), reason: 'reslotted' });
        out.waiting++;
        continue;
      }
    }
    if (writes >= limit) { out.waiting++; continue; }
    // Re-check what the founder approved against the hub, right before it goes out.
    const l = await lookUp(env, r, { fetchImpl, soot, lists });
    if (l.unknown) { await lost(r, l); continue; }
    reachable = true;
    if (l.gone) { await set(store, r, 'scheduled', { state: 'stale', reason: 'gone' }); await need(r, 'changed', 'gone'); continue; }
    const p = l.post;
    if (p.status === 'published') { await set(store, r, 'scheduled', { state: 'posted', url: p.url ?? null, outcome: { status: 'published', at: p.published_at ?? stamp, already: true } }); continue; }
    const same = p.revision === r.revision && (r.channel === 'blog' ? String(p.title ?? '').trim() === r.title : postHash(p.text, p.link) === r.text_hash);
    if (!same || !['draft', 'failed'].includes(p.status)) {
      const why = p.revision !== r.revision ? `revision ${p.revision}` : !same ? 'text' : p.status;
      await set(store, r, 'scheduled', { state: 'stale', reason: why });
      await need(r, 'changed', why);
      hold(r, 'changed');
      continue;
    }
    // Intent before the call: if this run dies after the hub answered, the next run looks it up.
    if (!(await set(store, r, 'scheduled', { state: 'publishing', intent_at: stamp, reason: null }))) continue;
    writes++;
    const res = r.channel === 'blog'
      ? await hubCall(env, 'cms_publish', { site: r.site, slug: r.slug, revision: r.revision, title: r.title, status: 'published' }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot })
      : await hubCall(env, 'social_publish', { id: r.hub_id, expected_revision: r.revision, channel: r.channel, text: p.text, link: p.link ?? null }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot });
    if (!res.ok && res.error !== 'refused') { out.waiting++; continue; } // unknown: stays publishing, looked up next run
    if (!res.ok) { await set(store, r, 'publishing', { state: 'failed', reason: String(res.message ?? 'refused').slice(0, 300) }); await need(r, 'failed', res.message); continue; }
    const post = res.data.post ?? res.data;
    const status = post.status;
    if (status === 'published') { await set(store, r, 'publishing', { state: 'posted', url: post.url ?? null, outcome: { status, at: stamp } }); released(r, 'posted'); }
    else if (status === 'approved') { await set(store, r, 'publishing', { state: 'approved', revision: post.revision ?? r.revision, outcome: { status, at: stamp } }); released(r, 'approved'); }
    else if (status === 'uncertain' || status === 'publishing') { await set(store, r, 'publishing', { state: 'uncertain', outcome: { status } }); await need(r, 'uncertain'); }
    else if (status === 'failed') { await set(store, r, 'publishing', { state: 'failed', reason: String(post.note ?? 'failed').slice(0, 300) }); await need(r, 'failed', post.note); }
    else out.waiting++;
  }
  if (reachable) await markHubOk(store, now);
  return finish(store, out);
}

async function finish(store, out) {
  // Bundles whose every release ended: the item is live (or needs the founder).
  for (const ref of new Set(out.released.map(x => x.ref))) {
    const item = await itemRow(store, ref);
    if (item?.meta && item.meta.state !== 'stopped') await store.update('library', [eq('ref', ref), eq('kind', 'item')], { meta: { ...item.meta, state: 'live' } });
  }
  out.summary = out.needs.filter(n => n.new).length
    ? `${out.needs.filter(n => n.new).length} post(s) need the founder: ${out.needs.filter(n => n.new).map(n => `${n.ref} ${n.channel}/${n.lang} ${n.kind}`).join('; ')}. Raise ONE report_blocker listing them; never publish them yourself.`
    : `${out.released.length} released, ${out.waiting} waiting.`;
  return out;
}

const FRONT = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/;
const frontValue = (head, k) => {
  const m = new RegExp(`^${k}: (.*)$`, 'm').exec(head);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return m[1].trim(); }
};
const yaml = (v) => JSON.stringify(String(v ?? ''));

/** Approved blogs of a product without a hub blog: at their slot, re-check the words the founder approved against the
 *  item's file, write an intent, then write <blog_dir>/<slug>.md with front matter. The write is the same bytes on a
 *  replay, so a run that died after it simply writes it again. State `written` counts as live. */
async function releaseFolder(rows, { store, env, now, state, out, need, hold, released, limit, count }) {
  const due = rows.filter(r => Date.parse(r.slot_at) <= now);
  out.waiting += rows.length - due.length;
  if (!due.length) return;
  const lr = await libraryRoot(env);
  if (!lr.ok) { out.waiting += due.length; out.folder = 'needs_root'; return; }
  const bundles = new Map((await store.query('bundles', [inList('key', [...new Set(due.map(r => r.bundle))].slice(0, 200))], { limit: 200 })).map(b => [b.key, b]));
  const products = await loadProducts({ root: lr.root });
  const stamp = new Date(now).toISOString();
  let n = 0;
  for (const r of due) {
    const b = bundles.get(r.bundle);
    if (!b || b.state !== 'approved' || b.ref !== r.ref) { await set(store, r, r.state, { state: 'held', reason: 'no_bundle' }); hold(r, 'no_bundle'); continue; }
    if (state.pause.all || pausedFor(state, `${r.product}:blog`)) { if (state.pause.all) out.paused = true; hold(r, 'paused'); continue; }
    const late = now - Date.parse(r.slot_at);
    if (r.state === 'scheduled' && late > state.late_grace_min * MIN) { await set(store, r, 'scheduled', { state: 'missed', reason: `late ${Math.round(late / MIN)} min` }); await need(r, 'missed', `late ${Math.round(late / MIN)} min`); hold(r, 'missed'); continue; }
    if (n >= limit) { out.waiting++; continue; }
    const item = await itemRow(store, r.ref);
    const entry = (item?.meta?.langs ?? []).find(l => l.lang === r.lang && l.slug === r.slug);
    let text = null;
    try { text = entry ? await readText(lr.root, `${item.meta.dir}/${entry.file ?? `${r.lang}.md`}`) : null; } catch { text = null; }
    const m = text ? FRONT.exec(text) : null;
    const title = m ? frontValue(m[1], 'title') : null, summary = m ? frontValue(m[1], 'summary') ?? '' : '';
    const body = m ? m[2].trim() : '';
    if (!m || blogHash(title, summary, body) !== r.text_hash) {
      await set(store, r, r.state, { state: 'stale', reason: m ? 'text' : 'gone' });
      await need(r, 'changed', m ? 'text' : 'gone');
      hold(r, 'changed');
      continue;
    }
    const prod = products.find(p => p.id === r.product) ?? normalProduct({ id: r.product });
    const file = `${blogDirOf(prod)}/${r.slug}.md`;
    if (r.state === 'scheduled' && !(await set(store, r, 'scheduled', { state: 'publishing', intent_at: stamp, reason: null }))) continue;
    n++; count();
    const at = r.intent_at ?? stamp;
    try {
      await writeText(lr.root, file, `---\ntitle: ${yaml(title)}\ndescription: ${yaml(summary)}\nslug: ${r.slug}\nlang: ${r.lang}\ndate: ${at.slice(0, 10)}\nref: ${r.ref}\n---\n\n${body}\n`);
    } catch (e) {
      await set(store, r, 'publishing', { state: 'failed', reason: e.code ?? 'write' });
      await need(r, 'failed', e.code ?? 'write');
      continue;
    }
    await set(store, r, 'publishing', { state: 'written', outcome: { via: 'folder', at, file } });
    released(r, 'written');
  }
}

// ---------- stop ----------

/** Stop an item's pending releases (not-yet-posted only). Converges; an X post the hub holds as approved goes back to draft. */
/** Take an X post the hub holds as approved (waiting for the Poster) back to a draft there; false when the hub refused or is unreachable. */
async function withdraw(env, r, { fetchImpl, soot }) {
  if (!hubBinding(env).ok) return null;
  const res = await hubCall(env, 'social_update', { id: r.hub_id, expected_revision: r.revision, status: 'draft' }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot });
  return res.ok ? (res.data.post?.revision ?? r.revision + 1) : null;
}

/** Pausing holds what the hub already queued for the Poster too: each approved X row in scope goes back to a
 *  hub draft and a scheduled row here, so resume releases it again through the usual checks. {held, kept}. */
export async function holdApproved(store, { scope, channel }, { env, fetchImpl, soot }) {
  const rows = (await store.query('releases', [eq('state', 'approved')], { limit: 100 }))
    .filter(r => scope === 'all' || `${r.product}:${r.channel}` === channel);
  let held = 0, kept = 0;
  for (const r of rows) {
    const revision = await withdraw(env, r, { fetchImpl, soot });
    if (revision === null) { kept++; continue; }
    held += await set(store, r, 'approved', { state: 'scheduled', revision, intent_at: null, reason: 'paused' });
  }
  return { held, kept };
}

export async function stopReleases(store, ref, { env, fetchImpl, soot, now }) {
  const rows = await store.query('releases', [eq('ref', ref), inList('state', ['scheduled', 'approved', 'held', 'missed', 'stale', 'handoff', 'lapsed', 'exported'])], { limit: 50 });
  let stopped = 0, withdrawn = 0, kept = 0;
  for (const r of rows) {
    if (r.state === 'approved') {
      // The hub holds it for the Poster; withdrawing it there is the only hub call stop makes.
      const revision = await withdraw(env, r, { fetchImpl, soot });
      if (revision === null) { kept++; continue; }
      withdrawn++;
      stopped += await set(store, r, 'approved', { state: 'stopped', reason: 'stopped', revision });
      continue;
    }
    stopped += await set(store, r, r.state, { state: 'stopped', reason: 'stopped' });
  }
  const bundles = new Set(rows.map(r => r.bundle));
  for (const b of bundles) await store.update('bundles', [eq('key', b), eq('state', 'approved')], { state: 'stopped' });
  return { stopped, withdrawn, kept, at: new Date(now).toISOString() };
}

export { keyOf, recorded, partHash, MarketingError };
