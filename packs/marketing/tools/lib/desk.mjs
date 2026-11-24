// The Marketing desk's views (spec §5): page_view {view, ...}. Codes and
// arguments only, never prose: the frame owns every word, in the viewer's
// language. A number the desk cannot know is null with a `why` code, never 0.
// Every view says which sources answered (`sources[]`), so the frame draws a
// partial failure without guessing. Approvals come from the frame, which read
// them through the piece's approval query (I2) and passes them as `approvals`.
//
// One item = one source and everything made from it (spec ItemRow/Item):
//   library items       content/<product>/<day>-<slug>/meta.json (item_save, create)
//   hub-only blog posts cms_list posts no item names (U10: "chưa có tệp")
//   hub social posts    attached to their blog item by source site/slug, else on their own
//   videos              mvf campaigns in the library (handoff until a link is in videos.csv)
//   hubless (G1)        the pack's own posts table when MARKETING_HUB is unset
import { join } from 'node:path';
import { fail, eq, gte } from './store.mjs';
import { hubCall, hubBinding, hubSource } from './hub.mjs';
import { libraryRoot, rootKind, readText, exists } from './root.mjs';
import { platformOf } from './guard.mjs';
import { PLATFORM_HOST, signInLink, grantLink, readProfiles, siteState } from './profiles.mjs';
import { loadProducts, tiktokChannelId, libraryTree, libraryDetail, refFor, videoRows, askText, localId, blogMode, targetLabel, subscriberCount, changelogVersion, blogDirOf, TITLE_MAX, TZ, ITEM_REF } from './library.mjs';
import { deskState, rulesFor, pausedFor, markHubOk, releaseKeyOf, DESK_CHANNELS } from './bundle.mjs';
import { localDay, localDayStart } from './time.mjs';
import { readJobs, jobsView } from './video-jobs.mjs';
import { profileChoices } from './accounts.mjs';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const VIEWS = ['summary', 'today', 'content', 'item', 'channels', 'channel', 'library', 'numbers'];
export const STAGES = ['idea', 'making', 'approval', 'scheduled', 'live'];
const PAGE = 30;
/** An X post the hub holds as approved lapses back to draft after this long (hub BROWSER_APPROVAL_MS). */
const X_APPROVAL_MS = 48 * HOUR;
/** A pending approval this old (or this close to expiring) is late: the post will miss its day. */
const APPROVAL_LATE_MS = 6 * HOUR;
const SIGNED_OUT = /sign(ed)?[ -]?(in|out)|log(ged)?[ -]?(in|out)|đăng (nhập|xuất)|session|not logged/i;
const baseSlug = (slug) => String(slug ?? '').replace(/-(vi|en)$/, '');
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const t = (s) => (s ? Date.parse(s) : NaN);

// ---------- what the desk reads ----------

/** The count of open Cần bạn cards the frame passed (its team_waits query); 0 when absent. */
export function cardsIn(n) {
  if (n === undefined || n === null) return 0;
  if (!Number.isInteger(n) || n < 0 || n > 10000) fail('invalid_request', 'cards is the count of open Cần bạn cards, 0 to 10000.');
  return n;
}
/** The approvals the frame passed: compact, newest first, one per id. */
export function approvalsIn(list) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) fail('invalid_request', 'approvals is the list the approvals query returned.');
  const seen = new Set();
  return list.filter(a => a && typeof a.id === 'string' && !seen.has(a.id) && seen.add(a.id)).slice(0, 100).map(a => ({
    id: a.id.slice(0, 64), state: ['pending', 'approved', 'used', 'rejected', 'expired'].includes(a.state) ? a.state : 'pending',
    ref: typeof a.ref === 'string' && ITEM_REF.test(a.ref) ? a.ref : null, created_at: a.created_at ?? null, decided_at: a.decided_at ?? null,
    expires_at: a.expires_at ?? null, reason: typeof a.reason === 'string' ? a.reason.slice(0, 500) : null,
  })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/** Read everything a view needs once: store rows, the library root, and (when asked) the hub. */
export async function gather({ store, env, now, fetch: fetchImpl, soot, teams = null, packs = null }, { hub = true, approvals = null, remember = false, profiles = true } = {}) {
  const lr = await libraryRoot(env);
  const [state, lib, releases, bundles] = await Promise.all([
    deskState(store),
    store.query('library', [], { order: 'path', desc: false, limit: 500 }),
    store.query('releases', [gte('slot_at', iso(now - 30 * DAY))], { order: 'slot_at', desc: true, limit: 500 }),
    store.query('bundles', [], { order: 'approved_at', desc: true, limit: 200 }),
  ]);
  const W = { now, state, root: lr.ok ? lr.root : null, rootError: lr.ok ? null : lr.error, rootKind: rootKind(env), lib, releases, bundles, approvals, hub: { bound: hubBinding(env).ok, ok: false, results: [], channels: null, social: [], cms: new Map() } };
  const campaignProducts = lib.filter(r => r.kind === 'campaign').map(r => r.product);
  if (hub && W.hub.bound) {
    const opts = { fetchImpl, soot };
    const [ch, social] = await Promise.all([hubCall(env, 'social_channels', {}, opts), hubCall(env, 'social_list', { limit: 50 }, opts)]);
    W.hub.results.push(ch, social);
    if (ch.ok) W.hub.channels = ch.data;
    if (social.ok) W.hub.social = social.data.posts ?? [];
    W.products = await loadProducts({ root: W.root, hubSites: ch.ok ? ch.data.sites ?? [] : [], campaignProducts });
    const sites = [...new Set(W.products.map(p => p.hub_site).filter(s => (ch.ok ? (ch.data.sites ?? []).includes(s) : true)))];
    const lists = await Promise.all(sites.map(site => hubCall(env, 'cms_list', { site, limit: 50 }, opts)));
    sites.forEach((site, i) => { W.hub.results.push(lists[i]); if (lists[i].ok) W.hub.cms.set(site, lists[i].data.posts ?? []); });
    W.hub.ok = W.hub.results.every(r => r.ok || r.error === 'refused');
    // page_view is a read tool: only a write tool (an action, release_due) records when the hub last answered.
    if (W.hub.ok && remember) await markHubOk(store, now);
  } else {
    W.products = await loadProducts({ root: W.root, campaignProducts });
  }
  if (!W.hub.bound) W.hubless = (await store.query('posts', [], { order: 'updated_at', desc: true, limit: 200 })).filter(p => p.kind !== 'reply');
  // The pack's own channels (a TikTok account is one) and the videos it posts, so a delivered mvf campaign shows what became of it.
  W.channels = await store.query('channels', [], { limit: 50 });
  // The profiles' sign-in state is Nest's (browser.profiles.read): read once, only when a channel names a profile and
  // the view shows a channel's state (not the content or library tabs).
  W.soot = soot ?? null;
  W.profiles = profiles && W.channels.some(c => typeof c.rules?.profile === 'string') || W.hub.channels?.channels?.some(c => (c.accounts ?? []).some(a => a.profile))
    ? await readProfiles(env, fetchImpl) : null;
  W.videoPosts = W.hubless ? W.hubless.filter(p => p.kind === 'video') : await store.query('posts', [eq('kind', 'video')], { order: 'updated_at', desc: true, limit: 200 });
  W.mode = W.hub.bound ? 'hub' : 'hubless';
  W.teams = Array.isArray(teams) ? teams : null;
  W.abilities = abilitiesOf(packs);
  // Per product: how many people its newsletter reaches (a count only) and whether its blog folder is there.
  W.subscribers = new Map();
  W.dirOk = new Map();
  for (const p of W.products) {
    W.subscribers.set(p.id, W.root ? await subscriberCount(W.root, p.id) : null);
    if (blogMode(p, W.hub.bound) === 'folder') W.dirOk.set(p.id, W.root ? await exists(W.root, blogDirOf(p)).then(ok => ok || 'new', () => false) : null);
  }
  W.sources = sources(W);
  W.items = buildItems(W);
  return W;
}

/** What the team's other packs let the desk do: Micro Fish pre-tests and email sending. Unknown (null) when the
 *  host did not say which packs the team has. */
function abilitiesOf(packs) {
  if (!Array.isArray(packs)) return { micro_fish: null, email: null };
  const ids = new Set(packs.map(p => (typeof p === 'string' ? p : p?.id ?? p?.name ?? null)).filter(Boolean));
  return { micro_fish: ids.has('micro-fish'), email: ids.has('email') };
}

function sources(W) {
  const hub = !W.hub.bound ? { id: 'hub', ok: false, host: null, error: 'not_configured', ms: 0, last_ok_at: W.state.hub_ok_at }
    : W.hub.results.length ? { ...hubSource(W.hub.results, W.state.hub_ok_at), ...(W.hub.ok ? { last_ok_at: iso(W.now) } : {}) }
      : { id: 'hub', ok: true, host: null, ms: 0, last_ok_at: W.state.hub_ok_at, skipped: true };
  // root_kind: 'team' when the library is the team's own (hidden) folder, so a hand-off says where its files are.
  const library = W.root ? { id: 'library', ok: true, files: W.lib.length, scanned_at: W.lib.reduce((m, r) => (r.mtime && r.mtime > m ? r.mtime : m), '') || null, root_kind: W.rootKind } : { id: 'library', ok: false, error: W.rootError, files: W.lib.length };
  return [hub, library, { id: 'store', ok: true }];
}

// ---------- channels: who posts where ----------

const productOf = (W, site) => W.products.find(p => p.hub_site === site)?.id ?? null;
/** The hub accounts of a channel that post for a product's site. */
function accountsFor(W, product, channel) {
  const entry = W.hub.channels?.channels?.find(c => c.channel === channel);
  if (!entry) return [];
  const site = W.products.find(p => p.id === product)?.hub_site ?? product;
  return (entry.accounts ?? []).filter(a => !a.sites || a.sites.includes(site));
}
/** The product a TikTok account row posts for: its rules.product when the desk knows that product, else the product
 *  that lists the account or owns its video channel folder (a folder is never a product of its own). */
function tiktokOwner(W, c) {
  const named = c.rules?.product ?? null;
  if (named && W.products.some(p => p.id === named)) return named;
  const listed = W.products.find(p => (p.tiktok_accounts ?? []).some(a => tiktokChannelId(a.handle) === c.key));
  if (listed) return listed.id;
  const dir = c.rules?.video_channel;
  return (dir && W.products.find(p => (p.video_channels ?? []).includes(dir))?.id) || named;
}
/** A product's live TikTok account rows; the retired legacy `tiktok` row is not one. */
export const tiktokRows = (W, product) => (W.channels ?? []).filter(c => platformOf(c.key) === 'tiktok' && c.key !== 'tiktok' && c.publisher === 'browser' && c.paused_reason !== 'retired' && tiktokOwner(W, c) === product)
  .sort((a, b) => String(a.key).localeCompare(String(b.key)));
/**
 * A profile's sign-in on a platform as the desk shows it, from Nest's own state: {state: signed_in | signed_out | never,
 * at}, or {state: null, why, grant?} when it cannot be read (no_grant carries the link that grants it). Null without a
 * profile. `href` opens the profile's sign-in on that site.
 */
function signInOf(W, profile, platform) {
  if (!profile) return null;
  const host = PLATFORM_HOST[platform] ?? null;
  const s = siteState(W.profiles, profile, host);
  return { ...s, host, href: signInLink(profile, host), ...(s.why === 'no_grant' ? { grant: grantLink(W.soot) } : {}) };
}
/** One account line of a TikTok cell: running, signed out, or paused (by a person, or waiting for its resume after a sign-in). */
const accountLine = (W, c) => {
  const profile = typeof c.rules?.profile === 'string' ? c.rules.profile : null;
  return { channel: c.key, account: c.account ?? null, profile, video_channel: c.rules?.video_channel ?? null,
    paused: !!c.paused, paused_reason: c.paused_reason ?? null, state: !c.paused ? 'ok' : c.paused_reason === 'signed_out' ? 'signed_out' : 'paused',
    sign_in: signInOf(W, profile, 'tiktok') };
};

/** Product × channel state (spec Cell). */
export function cellFor(W, product, channel) {
  const key = `${product}:${channel}`;
  const prod = W.products.find(p => p.id === product);
  const paused = pausedFor(W.state, key);
  const waiting = W.releases.filter(r => r.product === product && r.channel === channel && ['scheduled', 'approved', 'held'].includes(r.state)).length;
  const posted7 = (since) => (channel === 'blog'
    ? (W.hub.cms.get(prod?.hub_site) ?? []).filter(p => p.status === 'published' && t(p.published_at) >= since).length
    : W.hub.social.filter(p => p.channel === channel && p.status === 'published' && postProduct(W, p) === product && t(p.published_at) >= since).length);
  const base = { key, product, channel, waiting, ...(paused ? { paused: { scope: paused.scope, since: paused.since } } : {}) };
  if (channel === 'reddit') return { ...base, state: 'off', via: null };
  if (channel === 'community') {
    const targets = (prod?.targets ?? []).map(x => ({ id: x.id, kind: x.kind, label: targetLabel(x) }));
    const hand = W.releases.filter(r => r.product === product && r.channel === 'community' && r.state === 'handoff').length;
    return { ...base, state: targets.length ? 'by_hand' : 'off', via: 'hand', targets, waiting: hand };
  }
  if (channel === 'newsletter') {
    const subscribers = W.subscribers?.get(product) ?? null;
    // The email pack sends one message, so one Nest approval, per address: past a small list the founder exports instead.
    const state = subscribers === null ? (prod?.newsletter ? 'no_list' : 'off') : W.abilities?.email && subscribers <= EMAIL_SEND_MAX ? 'email' : 'export';
    return { ...base, state, via: state === 'email' ? 'send' : state === 'export' ? 'export' : null, subscribers, waiting: W.releases.filter(r => r.product === product && r.channel === 'newsletter' && ['handoff', 'exported'].includes(r.state)).length };
  }
  if (channel === 'blog' && prod) {
    const mode = blogMode(prod, W.hub.bound);
    if (mode === 'none') return { ...base, state: 'off', via: null, why: 'no_blog' };
    if (mode === 'folder') {
      const written = W.releases.filter(r => r.product === product && r.channel === 'blog' && r.state === 'written' && t(r.outcome?.at ?? r.slot_at) >= W.now - 7 * DAY).length;
      return { ...base, state: paused ? 'paused' : 'folder', via: 'folder', dir: blogDirOf(prod), dir_ok: W.dirOk?.get(product) ?? null, account: prod.site ?? null, posted_7d: written };
    }
  }
  if (!W.hub.bound && ['x', 'facebook'].includes(channel)) {
    const declared = prod?.accounts?.[channel] ?? null;
    const hand = W.releases.filter(r => r.product === product && r.channel === channel && r.state === 'handoff').length;
    // A channel the founder did not pick at setup is not used, not missing an account.
    return declared ? { ...base, state: paused ? 'paused' : 'by_hand', via: 'hand', account: declared, waiting: hand } : { ...base, state: 'off', via: null, account: null, why: 'not_chosen' };
  }
  if (channel === 'tiktok') {
    // One line per TikTok account the Publisher drives (channel tiktok-<handle>, publisher browser), each with its own
    // state; the row is what due and claim read, so the desk's pause (settings.desk_pause) has no say here, only pause-all.
    const lines = tiktokRows(W, product).map(c => accountLine(W, c));
    if (lines.length) {
      const state = W.state.pause.all ? 'paused' : lines.some(l => l.state === 'signed_out') ? 'signed_out' : lines.some(l => l.state === 'ok') ? 'ok' : 'paused';
      const first = lines.find(l => l.state === 'signed_out') ?? lines.find(l => l.state === 'ok') ?? lines[0];
      return { ...base, state, via: 'browser', account: lines.map(l => l.account ?? l.channel).join(', '), profile: first.profile, sign_in: first.sign_in, accounts: lines };
    }
    const hand = (W.items ?? []).filter(i => i.product === product && i.format === 'video'); // W.items is still being built while items derive
    // The handle the founder named at setup (accounts.tiktok) is the account; video_channels are only library folders.
    const declared = prod?.accounts?.tiktok ?? null;
    const used = declared || hand.length || (prod?.video_channels ?? []).length;
    return { ...base, state: used ? 'manual' : 'off', via: 'hand', account: declared ?? ((prod?.video_channels ?? []).join(', ') || null), waiting: hand.filter(i => i.state === 'handoff').length, ...(used ? {} : { why: 'not_chosen' }) };
  }
  if (!W.hub.bound) return { ...base, state: channel === 'blog' ? 'manual' : 'unknown', via: channel === 'blog' ? 'hand' : null, why: 'hubless' };
  if (!W.hub.channels) return { ...base, state: 'unknown', via: 'hub', why: 'hub' };
  const since = W.now - 7 * DAY;
  if (channel === 'blog') {
    const ok = (W.hub.channels.sites ?? []).includes(prod?.hub_site);
    return { ...base, state: paused ? 'paused' : ok ? 'ok' : 'not_connected', via: 'hub', account: prod?.site ?? prod?.hub_site ?? null, posted_7d: ok && W.hub.cms.has(prod?.hub_site) ? posted7(since) : null };
  }
  const accounts = accountsFor(W, product, channel);
  const declared = prod?.accounts?.[channel] ?? null;
  if (!accounts.length) return { ...base, state: declared ? 'not_connected' : 'off', ...(declared ? {} : { why: 'not_chosen' }), via: null, account: declared, drafts: W.hub.social.filter(p => p.channel === channel && p.status === 'draft' && postProduct(W, p) === product).length };
  const a = accounts[0];
  const entry = W.hub.channels.channels.find(c => c.channel === channel);
  const via = a.kind === 'browser' ? 'browser' : 'api';
  const out = { ...base, via, account: a.handle ? `@${a.handle}` : a.page_name ?? a.account, profile: a.profile ?? null, ...(via === 'browser' ? { sign_in: signInOf(W, a.profile ?? null, channel) } : {}), max: entry?.max_length ?? null, posted_7d: posted7(since), poster_seen_at: entry?.poster_seen_at ?? null };
  if (via === 'browser') {
    // The Poster says why it did not post (social_release not_posted keeps the note on the approved post).
    const signed = W.hub.social.filter(p => p.channel === channel && p.status === 'approved' && postProduct(W, p) === product && SIGNED_OUT.test(p.note ?? '') && W.now - t(p.updated_at) < X_APPROVAL_MS);
    if (signed.length) return { ...out, state: 'signed_out', since: signed.map(p => p.updated_at).sort()[0] };
  }
  return { ...out, state: paused ? 'paused' : 'ok' };
}
/** The product a hub social post belongs to: its source blog's site, else its account's only site. */
function postProduct(W, p) {
  if (p.source?.site) return productOf(W, p.source.site);
  const entry = W.hub.channels?.channels?.find(c => c.channel === p.channel);
  const sites = entry?.sites ?? (entry?.accounts?.length === 1 ? entry.accounts[0].sites : null);
  return sites?.length === 1 ? productOf(W, sites[0]) : null;
}

// ---------- items ----------

export const EMAIL_SEND_MAX = 10;
const PLAN_OF = { scheduled: 'scheduled', publishing: 'publishing', approved: 'scheduled', posted: 'posted', held: 'held', missed: 'held', stale: 'held', lapsed: 'held', failed: 'held', uncertain: 'uncertain', stopped: 'stopped', handoff: 'handoff', written: 'written', exported: 'exported' };
/** Plan states that count as out: posted at the hub or by the founder, written to the site folder, a newsletter sent. */
const OUT = ['posted', 'written'];
const SKIPPED = ['channel_not_connected', 'no_account'];
const REASON_OF = { missed: 'missed', stale: 'changed', lapsed: 'returned_to_draft', failed: 'failed' };

function buildItems(W) {
  const items = new Map();
  const claimed = new Set(); // hub keys (site/slug, SP- id) an item already holds
  const add = (it) => { items.set(it.ref, it); return it; };
  for (const r of W.lib.filter(x => x.kind === 'item')) {
    const m = r.meta ?? {};
    const it = add({ ref: r.ref, product: r.product ?? m.product ?? null, format: m.format ?? 'blog', title: m.title ?? r.title, by: m.by ?? null, to: m.to ?? null, source: m.source ?? null, dir: m.dir ?? r.path.replace(/\/meta\.json$/, ''), files: !m.planned, hub_only: false, meta: m, langs: [], posts: [], created_at: m.created_at ?? r.created_at ?? null, updated_at: m.updated_at ?? r.updated_at ?? null, topic: m.topic ?? null, channels_wanted: m.want ?? null, series: m.series ?? null });
    for (const l of m.langs ?? []) { it.langs.push({ ...l }); claimed.add(`${l.site}/${l.slug}`); }
    for (const p of m.posts ?? []) { it.posts.push({ ...p }); if (p.id) claimed.add(p.id); }
  }
  // Hub blog posts: refresh what items hold, then group the rest by base slug (one item per pair).
  for (const p of W.products) {
    for (const post of W.hub.cms.get(p.hub_site) ?? []) {
      const k = `${p.hub_site}/${post.slug}`;
      const own = claimed.has(k) ? [...items.values()].find(i => i.langs.some(l => `${l.site}/${l.slug}` === k)) : null;
      const it = own ?? items.get(refFor(`item:${p.id}:${baseSlug(post.slug)}`)) ?? add({ ref: refFor(`item:${p.id}:${baseSlug(post.slug)}`), product: p.id, format: 'blog', title: post.title, by: post.author ?? null, source: null, dir: null, files: false, hub_only: true, meta: {}, langs: [], posts: [], created_at: post.updated_at, updated_at: post.updated_at });
      const l = it.langs.find(x => `${x.site}/${x.slug}` === k) ?? (it.langs.push({ lang: post.language, site: p.hub_site, slug: post.slug }), it.langs.at(-1));
      Object.assign(l, { lang: post.language ?? l.lang, title: post.title, summary: post.summary, hub: { revision: post.revision, status: post.status, live: !!post.live, url: post.url ?? null, published_at: post.published_at ?? null, updated_at: post.updated_at ?? null } });
      claimed.add(k);
      if (t(post.updated_at) > t(it.updated_at) || !it.updated_at) it.updated_at = post.updated_at;
    }
  }
  // Hub social posts: onto their item by id, then by source blog, else an item of their own.
  for (const post of W.hub.social) {
    if (post.status === 'discarded') continue;
    let it = [...items.values()].find(i => i.posts.some(x => x.id === post.id));
    if (!it && post.source?.site) it = [...items.values()].find(i => i.langs.some(l => l.site === post.source.site && l.slug === post.source.slug));
    if (!it) it = items.get(refFor(`social:${post.id}`));
    if (!it) it = add({ ref: refFor(`social:${post.id}`), product: postProduct(W, post), format: 'social', title: firstLine(post.text), by: post.created_by ?? null, source: null, dir: null, files: false, hub_only: true, meta: {}, langs: [], posts: [], created_at: post.updated_at, updated_at: post.updated_at });
    const x = it.posts.find(q => q.id === post.id) ?? (it.posts.push({ channel: post.channel, lang: post.language, id: post.id }), it.posts.at(-1));
    Object.assign(x, { channel: post.channel, lang: post.language, hub: { revision: post.revision, status: post.status, text: post.text, link: post.link ?? null, url: post.url ?? null, note: post.note ?? null, published_at: post.published_at ?? null, updated_at: post.updated_at ?? null, approval_asked_at: post.approval_asked_at ?? null, length: post.length ?? null } });
  }
  // Videos: each mvf campaign is one item; delivered and not yet linked in videos.csv is the founder's hand-off.
  const posted = new Map();
  for (const r of W.lib.filter(x => x.kind === 'metrics')) for (const s of r.meta?.slugs ?? []) if (s.url) for (const k of [s.slug, s.script]) if (k) posted.set(`${r.channel}/${k}`, s);
  for (const r of W.lib.filter(x => x.kind === 'campaign')) {
    const m = r.meta ?? {};
    // videos.csv names a posted video by its campaign (slug) or by its delivered file (script).
    const link = [r.campaign, ...(m.delivery ?? [])].map(k => posted.get(`${r.channel}/${k}`)).find(Boolean) ?? null;
    add({ ref: r.ref, product: r.product ?? null, format: 'video', title: r.title, by: 'builder', source: null, dir: r.path.replace(/\/campaign\.json$/, ''), files: true, hub_only: false, meta: {}, langs: [], posts: [], channel_dir: r.channel, series: r.series, created_at: r.created_at, updated_at: m.delivered_at ?? r.updated_at,
      video: { stages: m.stages ?? [], delivered: (m.delivery ?? []).length > 0, delivery: m.delivery ?? [], owner: m.owner ?? null, ai_label: m.ai_label ?? null, platforms: m.platforms ?? [], url: link?.url ?? null, posted: link?.posted ?? null, tiktok: m.tiktok ?? null } });
  }
  // Hubless (G1): the pack's own posts.
  const campaigns = [...items.values()].filter(i => i.format === 'video' && i.dir);
  for (const p of W.hubless ?? []) { if (p.kind === 'video' && campaigns.some(i => madeFrom(p, i))) continue; add(hublessItem(p)); }
  for (const it of items.values()) derive(W, it);
  return [...items.values()];
}
const firstLine = (s) => String(s ?? '').replace(/https?:\/\/\S+/g, '').split('\n').map(x => x.trim()).find(Boolean)?.slice(0, 120) ?? '';
const HUBLESS = { draft: ['making', 'drafting'], checking: ['making', 'drafting'], refused: ['making', 'revising'], ready: ['scheduled', 'scheduled'], scheduled: ['scheduled', 'scheduled'], publishing: ['scheduled', 'scheduled'], unpublishing: ['scheduled', 'scheduled'], failed: ['scheduled', 'held'], uncertain: ['scheduled', 'uncertain'], published: ['live', 'posted'], pulled: ['making', 'stopped'], removed: ['making', 'stopped'] };
function hublessItem(p) {
  const [stage, state] = HUBLESS[p.state] ?? ['making', 'drafting'];
  return { ref: p.ref, product: null, format: p.kind === 'article' ? 'blog' : p.kind === 'video' ? 'video' : 'social', title: p.brief?.title || p.title || firstLine(p.body) || p.ref, by: p.author_soot ?? null, hubless: true, langs: [], posts: [], meta: {}, files: false, stage, state, channels: [p.channel].filter(Boolean), at: p.state === 'published' ? p.updated_at : null, url: p.url ?? null, created_at: p.created_at, updated_at: p.updated_at };
}

/** Stage, state, plan and approval of one item, from its releases, the approvals and the hub. */
function derive(W, it) {
  if (it.hubless) return;
  if (it.format === 'video' && it.video) return deriveVideo(W, it);
  const bundles = W.bundles.filter(b => b.ref === it.ref);
  const live = bundles.find(b => b.state === 'approved');
  const rel = W.releases.filter(r => r.ref === it.ref && r.state !== 'superseded');
  const relOf = (key) => rel.filter(r => releaseKeyOf(r) === key).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;
  const ap = (W.approvals ?? []).filter(a => a.ref === it.ref);
  const approval = ap[0] ?? null;
  it.approval = approval ? { id: approval.id, state: approval.state, created_at: approval.created_at, decided_at: approval.decided_at, expires_at: approval.expires_at, reason: approval.reason } : null;
  const plan = [];
  const cell = (ch) => (it.product ? cellFor(W, it.product, ch) : null);
  const m = it.meta ?? {};
  const skip = (ch, lang) => (m.skipped ?? []).find(x => x.channel === ch && x.lang === lang)?.reason ?? null;
  for (const l of it.langs) {
    const r = relOf(`blog:${l.site}/${l.slug}`);
    const c = cell('blog');
    plan.push(planRow(W, { channel: 'blog', lang: l.lang, account: c?.account ?? l.site, r, hub: l.hub, cell: c, hash: l.hash, skipped: skip('blog', l.lang), via: c?.via === 'folder' ? 'folder' : null }));
  }
  for (const p of it.posts) {
    const lid = localId(it.ref, p.lang);
    const r = relOf(`${p.channel}:${p.id ?? lid}`);
    const c = cell(p.channel);
    const via = !p.id && p.channel !== 'tiktok' ? 'hand' : null;
    plan.push(planRow(W, { channel: p.channel, lang: p.lang, account: c?.account ?? null, r, hub: p.hub, cell: c, hash: p.hash, skipped: skip(p.channel, p.lang), via }));
  }
  if (m.community) {
    // A launch pack's Show HN went to its own item after Duyệt: its row is followed there, not counted here.
    const key = `community:${m.community.id ?? localId(it.ref, m.community.lang)}`;
    const split = it.format === 'launch' && m.split ? m.split : null;
    const r = split ? W.releases.filter(x => releaseKeyOf(x) === key && x.state !== 'superseded').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null : relOf(key);
    plan.push({ ...planRow(W, { channel: 'community', lang: m.community.lang, account: targetLabel(m.community.target), r, cell: cell('community'), hash: m.community.hash, via: 'hand' }), target: m.community.target ?? null, ...(split ? { split } : {}) });
  }
  if (m.newsletter) {
    const r = relOf(`newsletter:${localId(it.ref, m.newsletter.lang)}`);
    const c = cell('newsletter');
    const row = { ...planRow(W, { channel: 'newsletter', lang: m.newsletter.lang, account: null, r, cell: c, hash: m.newsletter.hash, via: c?.via ?? 'export' }), subscribers: c?.subscribers ?? null };
    // The Editor asked email to send the approved newsletter (item_save newsletter.sending, or an approval newer than the bundle).
    const asked = r?.state === 'handoff' && live && (t(m.newsletter.sending_at) > t(live.approved_at) || ap.some(a => a.state === 'pending' && t(a.created_at) > t(live.approved_at)));
    if (asked && row.state === 'handoff') { row.state = 'sending'; row.via = 'send'; }
    plan.push(row);
  }
  it.plan = plan;
  it.channels = [...new Set(plan.map(p => p.channel))];
  // The rows that make this item's stage: a launch's split Show HN row lives on its own item.
  const own = plan.filter(p => !p.split);
  const has = (s) => own.some(p => p.state === s);
  const decided = (a) => t(a.decided_at ?? a.created_at);
  const sendingAsk = has('sending');
  const pending = approval?.state === 'pending' && (!live || t(approval.created_at) > t(live.approved_at)) && !sendingAsk;
  // Approved on Nest, but the Editor has not run the approved call yet: nothing is scheduled and the founder has nothing to do.
  const granted = approval?.state === 'approved' && (!live || decided(approval) > t(live.approved_at));
  let stage, state, note = null, at = null;
  if (it.meta?.state === 'stopped') [stage, state] = ['making', 'stopped'];
  else if (has('uncertain')) [stage, state] = ['scheduled', 'uncertain'];
  else if (pending) [stage, state] = ['approval', 'approval'];
  else if (granted) [stage, state] = ['approval', 'granted'];
  else if (has('held')) { [stage, state] = ['scheduled', 'held']; note = plan.find(p => p.state === 'held').reason; }
  else if (has('scheduled') || has('publishing')) { [stage, state] = ['scheduled', 'scheduled']; at = own.filter(p => p.at && ['scheduled', 'publishing'].includes(p.state)).map(p => p.at).sort()[0] ?? null; }
  else if (has('sending')) [stage, state] = ['scheduled', 'sending'];
  else if (has('exported')) [stage, state] = ['scheduled', 'exported'];
  else if (has('handoff')) [stage, state] = ['scheduled', 'handoff'];
  else if (own.length && own.every(p => [...OUT, ...SKIPPED].includes(p.state)) && own.some(p => OUT.includes(p.state))) {
    const out = own.filter(p => OUT.includes(p.state));
    [stage, state] = ['live', out.every(p => p.state === 'written') ? 'written' : 'posted'];
    at = out.map(p => p.at).filter(Boolean).sort().at(-1) ?? null;
  }
  // The team asked the founder something it cannot go on without: the item waits on the founder, not on a draft.
  else if (it.meta?.waiting?.question) { [stage, state] = ['making', 'waiting']; note = it.meta.waiting.question; }
  else if (approval?.state === 'rejected' && !(t(it.meta?.revised_at) > decided(approval)) && (!live || decided(approval) > t(live.approved_at))) { [stage, state] = ['making', 'revising']; note = approval.reason; }
  else if (['asked', 'planned'].includes(it.meta?.state) && !it.langs.length && !it.posts.length) [stage, state] = ['making', 'asked'];
  else if (it.meta?.state === 'idea') [stage, state] = ['idea', 'idea'];
  else if (own.length && own.filter(p => p.channel !== 'blog').length && !it.langs.length && own.every(p => SKIPPED.includes(p.state))) [stage, state] = ['making', 'no_channel'];
  else { [stage, state] = ['making', 'drafting']; if (approval?.state === 'expired') note = 'approval_expired'; }
  const handSince = own.filter(p => ['handoff', 'exported', 'sending'].includes(p.state)).map(p => p.at).filter(Boolean).sort()[0] ?? live?.approved_at ?? null;
  Object.assign(it, { stage, state, note, at, waiting_since: state === 'approval' ? approval.created_at : state === 'waiting' ? it.meta.waiting.at ?? null : state === 'asked' ? it.meta?.asked_at ?? it.created_at : ['handoff', 'exported', 'sending'].includes(state) ? handSince : null });
  if (live) it.approved_at = live.approved_at;
  if (state === 'approval' && approval.expires_at) it.expires_at = approval.expires_at;
  // An X post the hub holds as approved while the account is signed out goes back to draft 48 h after approval.
  const back = plan.filter(p => p.channel === 'x' && p.returns_at).map(p => p.returns_at).sort()[0];
  if (back) it.returns_at = back;
}

function planRow(W, { channel, lang, account, r, hub, cell, hash = null, skipped = null, via = null }) {
  const row = { channel, lang, account: account ?? null, at: null, state: 'after_approval', ...(via ? { via } : {}) };
  if (r) {
    row.state = PLAN_OF[r.state] ?? 'held';
    row.at = ['posted', 'written', 'exported'].includes(r.state) ? r.outcome?.at ?? r.outcome?.exported_at ?? r.slot_at : r.slot_at;
    // A hand-off whose words changed after Duyệt is not the approved post any more: it waits for a new approval.
    if (['handoff', 'exported'].includes(r.state) && hash && r.text_hash && hash !== r.text_hash) { row.state = 'held'; row.reason = 'changed'; return row; }
    if (r.state === 'approved') { row.about = true; row.waiting = 'poster'; }
    if (channel === 'x' && r.state === 'scheduled') row.about = true;
    if (REASON_OF[r.state]) row.reason = REASON_OF[r.state];
    if (r.state === 'held' && r.reason) row.reason = r.reason;
    if (r.url) row.url = r.url;
    if (r.state === 'scheduled' && cell?.paused) row.reason = 'paused';
    if (r.state === 'approved' && cell?.state === 'signed_out') { row.state = 'held'; row.reason = 'signed_out'; row.returns_at = iso(t(r.outcome?.at ?? r.slot_at) + X_APPROVAL_MS); }
    return row;
  }
  if (hub?.status === 'published' || hub?.live) return { ...row, state: 'posted', at: hub.published_at ?? null, url: hub.url ?? null };
  if (hub?.status === 'uncertain') return { ...row, state: 'uncertain', at: hub.updated_at ?? null };
  if (hub?.status === 'approved') return { ...row, state: cell?.state === 'signed_out' ? 'held' : 'scheduled', about: true, waiting: 'poster', ...(cell?.state === 'signed_out' ? { reason: 'signed_out', returns_at: iso(t(hub.updated_at) + X_APPROVAL_MS) } : {}) };
  if (skipped) return { ...row, state: skipped };
  if (cell && ['no_account', 'not_connected'].includes(cell.state)) return { ...row, state: cell.state === 'no_account' ? 'no_account' : 'channel_not_connected' };
  if (cell && ['blog', 'x', 'facebook'].includes(channel) && cell.state === 'off') return { ...row, state: 'no_account' };
  return row;
}

/** A video post of the pack was made from this library campaign folder (its `brief.campaign_dir` is workspace-relative, the item's `dir` library-relative). */
const madeFrom = (p, it) => typeof p.brief?.campaign_dir === 'string' && !!it.dir && (p.brief.campaign_dir === it.dir || p.brief.campaign_dir.endsWith(`/${it.dir}`));
/** The one TikTok account a video item posts on: the account row whose video_channel is the item's folder, else the
 *  product's only account; null when none or more than one could. */
function videoAccount(W, it) {
  const rows = tiktokRows(W, it.product);
  const byDir = rows.filter(c => c.rules?.video_channel && c.rules.video_channel === it.channel_dir);
  const one = byDir.length ? (byDir.length === 1 ? byDir[0] : null) : rows.length === 1 ? rows[0] : null;
  if (one) return { channel: one.key, account: one.account ?? null };
  const prod = W.products.find(p => p.id === it.product);
  const accts = (prod?.tiktok_accounts ?? []).filter(a => a.video_channel === it.channel_dir);
  const a = accts.length === 1 ? accts[0] : (prod?.tiktok_accounts ?? []).length === 1 ? prod.tiktok_accounts[0] : null;
  return a ? { channel: tiktokChannelId(a.handle), account: `@${a.handle}` } : null;
}
const VIDEO_PLAN = { published: 'posted', scheduled: 'scheduled', publishing: 'scheduled', failed: 'held', uncertain: 'uncertain' };

function deriveVideo(W, it) {
  const v = it.video;
  // A TikTok account the Publisher posts (channel tiktok-<handle>) takes the video from the founder's hand-off: its post says
  // where it stands. A post still a draft, or on a channel set to hand, changes nothing.
  const own = (W.videoPosts ?? []).filter(p => platformOf(p.channel) === 'tiktok' && madeFrom(p, it) && VIDEO_PLAN[p.state]);
  const out = own.find(p => p.state === 'published' && p.url) ?? own.find(p => p.state !== 'published') ?? null;
  it.plan = [{ channel: 'tiktok', lang: 'vi', account: videoAccount(W, it)?.account ?? it.channel_dir, at: v.posted ?? null, state: v.url ? 'posted' : out ? VIDEO_PLAN[out.state] : v.delivered ? 'handoff' : 'after_approval', ...(v.url ? { url: v.url } : out?.url ? { url: out.url } : {}) }];
  it.channels = ['tiktok'];
  if (!v.url && out) {
    const at = out.state === 'published' ? iso(t(out.updated_at)) : null;
    if (out.state === 'published') Object.assign(it, { stage: 'live', state: 'posted', at, url: out.url });
    else Object.assign(it, { stage: 'scheduled', state: out.state === 'failed' ? 'held' : out.state === 'uncertain' ? 'uncertain' : 'scheduled', at: null });
  } else if (v.url) Object.assign(it, { stage: 'live', state: 'posted', at: v.posted ? iso(Date.parse(v.posted)) : null });
  else if (v.delivered) Object.assign(it, { stage: 'scheduled', state: 'handoff', at: null, waiting_since: it.updated_at });
  else Object.assign(it, { stage: 'making', state: 'drafting', at: null });
}

/** The list form of an item (spec ItemRow). */
export function itemRow(it) {
  const row = { ref: it.ref, product: it.product, format: it.format, stage: it.stage, state: it.state, title: String(it.title ?? '').slice(0, 200), by: it.by ?? null, channels: it.channels ?? [] };
  for (const k of ['at', 'waiting_since', 'note', 'returns_at', 'expires_at', 'url']) if (it[k]) row[k] = it[k];
  if (it.hub_only) row.files = false;
  if (it.hubless) row.hubless = true;
  if (it.approval?.id && it.state === 'approval') row.approval = { id: it.approval.id, created_at: it.approval.created_at, expires_at: it.approval.expires_at };
  if (it.format === 'video') { row.series = it.series ?? null; row.channel_dir = it.channel_dir ?? null; }
  if (it.plan?.length) row.plan = it.plan.map(p => ({ channel: p.channel, lang: p.lang, state: p.state, ...(p.at ? { at: p.at } : {}), ...(p.reason ? { reason: p.reason } : {}), ...(p.about ? { about: true } : {}), ...(p.via ? { via: p.via, account: p.account ?? null } : {}), ...(p.subscribers !== undefined ? { subscribers: p.subscribers } : {}), ...(p.split ? { split: p.split } : {}) }));
  return row;
}
const forProduct = (product) => (x) => !product || x.product === product;

// ---------- blockers ----------

/** Why posts are not out (spec Blocker): what blocks and the one step that fixes it. */
export function blockers(W, product) {
  const out = [];
  const items = W.items.filter(forProduct(product));
  // A signed-out browser channel: one line per product and channel, with what goes back to draft and when.
  for (const p of W.products.filter(forProduct(product))) for (const ch of ['x', 'facebook', 'tiktok']) {
    const c = cellFor(W, p.id, ch);
    if (c.state !== 'signed_out') continue;
    // A TikTok cell names the accounts that are signed out, not every account it has.
    const account = c.accounts ? c.accounts.filter(a => a.state === 'signed_out').map(a => a.account ?? a.channel).join(', ') : c.account;
    const held = items.filter(i => i.product === p.id).flatMap(i => (i.plan ?? []).filter(x => x.channel === ch && x.reason === 'signed_out').map(x => ({ ...x, ref: i.ref })));
    const at = held.map(x => x.returns_at).filter(Boolean).sort()[0] ?? null;
    out.push({ id: `signed_out:${p.id}:${ch}`, kind: held.length ? 'returns_to_draft' : 'signed_out', tone: 'err', product: p.id, channel: ch, count: held.length, at, title_code: held.length ? 'returns' : 'signed_out', title_args: { n: held.length, product: p.id, account, time: at, channel: ch }, meta_code: 'signed_out_since', meta_args: { since: c.since }, do: { label_code: 'fix_channel', sheet: { kind: 'channel', key: `${p.id}:${ch}` } } });
  }
  if (W.state.pause.all) out.push({ id: 'paused:all', kind: 'paused', tone: 'idle', product: null, at: W.state.pause.all.since, title_code: 'paused_all', title_args: {}, meta_code: 'paused_since', meta_args: { since: W.state.pause.all.since }, do: { label_code: 'resume', action: { name: 'resume', input: { op: 'resume', scope: 'all' } } } });
  for (const it of items) {
    const base = { product: it.product, ref: it.ref, title_args: { title: it.title, format: it.format } };
    if (it.state === 'approval') {
      const waited = W.now - t(it.approval.created_at);
      const late = waited >= APPROVAL_LATE_MS || (it.approval.expires_at && t(it.approval.expires_at) - W.now < 2 * HOUR);
      out.push({ ...base, id: `approval:${it.ref}`, kind: late ? 'approval_late' : 'approval', tone: 'wait', at: it.approval.created_at, title_code: 'approve', meta_code: 'waiting', meta_args: { hours: Math.max(0, Math.floor(waited / HOUR)), expires_at: it.approval.expires_at ?? null, first_at: (it.plan ?? []).map(p => p.at).filter(Boolean).sort()[0] ?? null }, do: { label_code: 'read_approve', sheet: { kind: 'item', key: it.ref } } });
    }
    if (it.state === 'waiting') out.push({ ...base, id: `ask:${it.ref}`, kind: 'ask', tone: 'wait', at: it.waiting_since, title_code: 'ask', title_args: { ...base.title_args, question: it.note }, meta_code: 'asked', meta_args: { at: it.waiting_since }, do: { label_code: 'answer', sheet: { kind: 'item', key: it.ref } } });
    for (const p of it.plan ?? []) {
      if (p.state === 'uncertain') out.push({ ...base, id: `uncertain:${it.ref}:${p.channel}:${p.lang}`, kind: 'uncertain', tone: 'err', at: p.at, title_code: 'uncertain', title_args: { ...base.title_args, channel: p.channel, lang: p.lang }, meta_code: 'uncertain_since', meta_args: { at: p.at }, do: { label_code: 'check_channel', sheet: { kind: 'uncertain', key: `${it.ref}:${p.channel}:${p.lang}` } } });
      if (p.state === 'held' && ['changed', 'missed', 'failed', 'returned_to_draft', 'no_bundle', 'blog_not_live'].includes(p.reason)) {
        const kind = p.reason === 'missed' ? 'missed' : p.reason === 'returned_to_draft' ? 'returns_to_draft' : 'changed';
        out.push({ ...base, id: `${kind}:${it.ref}:${p.channel}:${p.lang}`, kind, tone: p.reason === 'failed' ? 'err' : 'wait', at: p.at, title_code: `held_${p.reason}`, title_args: { ...base.title_args, channel: p.channel, lang: p.lang }, meta_code: 'slot', meta_args: { at: p.at }, do: { label_code: 'open_item', sheet: { kind: 'item', key: it.ref } } });
      }
    }
  }
  // Hand-offs: one line per product, how many videos wait for the founder on TikTok.
  const videos = items.filter(i => i.state === 'handoff' && i.format === 'video');
  for (const p of [...new Set(videos.map(i => i.product ?? 'other'))]) {
    const list = videos.filter(i => (i.product ?? 'other') === p).sort((a, b) => String(a.waiting_since).localeCompare(String(b.waiting_since)));
    out.push({ id: `handoff:${p}`, kind: 'handoff', tone: 'wait', product: p === 'other' ? null : p, ref: list[0].ref, count: list.length, at: list[0].waiting_since, title_code: 'handoff', title_args: { n: list.length, product: p === 'other' ? null : p }, meta_code: 'oldest', meta_args: { at: list[0].waiting_since, title: list[0].title }, do: { label_code: 'post_by_hand', sheet: { kind: 'item', key: list[0].ref } } });
  }
  // Approved posts the founder carries out: one line per product × social channel, one per product for community
  // posts, one per newsletter. A split launch row is counted on its Show HN item, never twice.
  const hand = items.flatMap(i => (i.plan ?? []).filter(x => !x.split && x.channel !== 'tiktok' && (x.state === 'handoff' || (x.state === 'exported' && x.channel === 'newsletter'))).map(x => ({ ...x, ref: i.ref, product: i.product, title: i.title })))
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const group = (list, keyOf) => { const g = new Map(); for (const x of list) g.set(keyOf(x), [...(g.get(keyOf(x)) ?? []), x]); return g; };
  for (const [k, list] of group(hand.filter(x => ['x', 'facebook'].includes(x.channel)), x => `${x.product}:${x.channel}`)) {
    out.push({ id: `handoff_social:${k}`, kind: 'handoff_social', tone: 'wait', product: list[0].product, channel: list[0].channel, ref: list[0].ref, count: list.length, at: list[0].at, title_code: 'handoff_social', title_args: { n: list.length, channel: list[0].channel, product: list[0].product, account: list[0].account ?? null }, meta_code: 'oldest', meta_args: { at: list[0].at, title: list[0].title }, do: { label_code: 'post_by_hand', sheet: { kind: 'item', key: list[0].ref } } });
  }
  for (const [k, list] of group(hand.filter(x => x.channel === 'community'), x => x.product)) {
    out.push({ id: `handoff_community:${k}`, kind: 'handoff_community', tone: 'wait', product: list[0].product, channel: 'community', ref: list[0].ref, count: list.length, at: list[0].at, title_code: 'handoff_community', title_args: { n: list.length, target: list[0].account ?? null, product: list[0].product }, meta_code: 'oldest', meta_args: { at: list[0].at, title: list[0].title }, do: { label_code: 'post_by_hand', sheet: { kind: 'item', key: list[0].ref } } });
  }
  for (const x of hand.filter(y => y.channel === 'newsletter')) {
    out.push({ id: `handoff_newsletter:${x.ref}`, kind: 'handoff_newsletter', tone: 'wait', product: x.product, channel: 'newsletter', ref: x.ref, count: 1, at: x.at, title_code: x.state === 'exported' ? 'handoff_newsletter_exported' : 'handoff_newsletter', title_args: { title: x.title, subscribers: x.subscribers ?? null }, meta_code: 'approved', meta_args: { at: x.at }, do: { label_code: x.state === 'exported' ? 'open_item' : 'send_newsletter', sheet: { kind: 'item', key: x.ref } } });
  }
  const rank = { err: 0, wait: 1, idle: 2 };
  // Within a tone: approvals first (one tap clears them), then hand-offs, then held posts.
  const order = (b) => (['approval', 'approval_late'].includes(b.kind) ? 0 : /^handoff/.test(b.kind) ? 1 : 2);
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || order(a) - order(b) || String(a.at ?? '').localeCompare(String(b.at ?? '')));
}

// ---------- views ----------

/** Live items of the last 7 days and the posts they carry: the Đã lên tile and the content tab's live stage agree. */
function liveWeek(W, items) {
  const since = W.now - 7 * DAY;
  const live = items.filter(i => i.stage === 'live' && !(t(i.at) < since));
  const posts = live.flatMap(i => (i.plan ?? []).filter(p => OUT.includes(p.state) && !(t(p.at) < since)));
  return { live, posts: posts.length, channels: new Set(posts.map(p => p.channel)).size };
}
function tilesOf(W, product, metricsRows, clicksUtm = null) {
  const items = W.items.filter(forProduct(product));
  if (!W.products.length) return ['published', 'approval', 'scheduled', 'channels', 'reads'].map(id => ({ id, value: null, why: 'no_posts_yet', tone: 'idle' }));
  const hubWhy = !W.hub.bound ? 'hubless' : !W.hub.ok ? 'hub' : null;
  // A desk with no hub still knows its own browser channels (TikTok accounts): Kênh cần sửa counts them.
  const ownRows = (W.channels ?? []).some(c => c.publisher === 'browser' && c.key !== 'tiktok' && c.paused_reason !== 'retired');
  const channelsWhy = hubWhy === 'hubless' && ownRows ? null : hubWhy;
  const since = W.now - 7 * DAY;
  const week = liveWeek(W, items);
  const cells = W.products.filter(forProduct(product)).flatMap(p => ['blog', 'x', 'facebook', 'tiktok'].map(ch => cellFor(W, p.id, ch)));
  const fix = cells.filter(c => ['signed_out', 'paused'].includes(c.state));
  const pending = W.approvals === null ? null : items.filter(i => i.state === 'approval');
  // Same count as the content tab's Sắp lên stage: items, hand-off videos included.
  const scheduled = items.filter(i => i.stage === 'scheduled');
  const clicks = metricsRows?.length ? metricsRows.filter(r => r.query === '' && t(r.day) >= since - DAY).reduce((n, r) => n + (r.clicks ?? 0), 0) : null;
  return [
    hubWhy === 'hub' ? { id: 'published', value: null, why: 'hub', tone: 'idle' }
      : !items.some(i => i.stage === 'live') && !week.live.length ? { id: 'published', value: null, why: 'no_posts_yet', tone: 'idle' }
        : { id: 'published', value: week.live.length, sub_code: 'published_posts', sub_args: { posts: week.posts, channels: week.channels }, tone: 'ok' },
    pending === null ? { id: 'approval', value: null, why: 'approvals_unread', tone: 'idle' } : { id: 'approval', value: pending.length, sub_code: pending.length ? 'oldest_wait' : 'none', sub_args: { hours: pending.length ? Math.floor((W.now - Math.min(...pending.map(i => t(i.approval.created_at)))) / HOUR) : 0 }, tone: pending.length ? 'wait' : 'ok' },
    { id: 'scheduled', value: scheduled.length, sub_code: 'next', sub_args: { at: scheduled.map(i => i.at).filter(a => a && t(a) >= W.now).sort()[0] ?? null, handoff: scheduled.filter(i => i.state === 'handoff').length }, tone: 'ok' },
    channelsWhy ? { id: 'channels', value: null, why: channelsWhy, tone: 'idle' } : { id: 'channels', value: fix.length, sub_code: fix.length ? 'first_fix' : 'none', sub_args: fix[0] ? { key: fix[0].key, state: fix[0].state } : {}, tone: fix.some(c => c.state === 'signed_out') ? 'err' : fix.length ? 'wait' : 'ok' },
    clicks !== null ? { id: 'reads', value: clicks, sub_code: 'search_clicks', sub_args: {}, tone: 'ok' }
      : clicksUtm !== null ? { id: 'reads', value: clicksUtm, sub_code: 'link_clicks', sub_args: {}, tone: 'ok' }
        : { id: 'reads', value: null, why: 'search_console_not_connected', also: 'hub_counts_published_only', tone: 'idle' },
  ];
}

function statusOf(W, product, bl, replies = 0) {
  if (!W.products.length) return { tone: 'idle', code: 'setup', args: {} };
  const hub = W.sources[0];
  if (hub.error === 'rate_limited') return { tone: 'wait', code: 'hub_busy', args: { host: hub.host } };
  if (hub.error && hub.error !== 'not_configured') return { tone: 'err', code: 'hub_down', args: { host: hub.host } };
  const ret = bl.find(b => b.kind === 'returns_to_draft' && b.channel);
  if (ret) return { tone: 'err', code: 'x_returns', args: { n: ret.count, product: ret.product, time: ret.at, account: ret.title_args.account } };
  const so = bl.find(b => b.kind === 'signed_out');
  if (so) return { tone: 'err', code: 'signed_out', args: { product: so.product, account: so.title_args.account, channel: so.channel } };
  if (W.state.pause.all) return { tone: 'idle', code: 'paused', args: { since: W.state.pause.all.since } };
  const items = W.items.filter(forProduct(product));
  if (!items.length) return W.cards ? { tone: 'wait', code: 'waits', args: { asks: 0, handoffs: 0, other: 0, replies: 0, cards: W.cards, posted_today: 0, next: null } } : { tone: 'idle', code: 'empty', args: {} };
  const todayKey = localDay(W.now, TZ);
  const today = items.flatMap(i => (i.plan ?? []).filter(p => p.state === 'posted' && p.at && localDay(t(p.at), TZ) === todayKey));
  const next = items.flatMap(i => (i.plan ?? []).filter(p => p.state === 'scheduled' && p.at && t(p.at) >= W.now).map(p => ({ ...p, product: i.product }))).sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
  const nextArg = next ? { at: next.at, channel: next.channel, product: next.product, about: !!next.about } : null;
  const waiting = bl.filter(b => b.kind === 'approval' || b.kind === 'approval_late').length;
  // Everything else the desk knows waits on the founder: a team question, a hand-off, a held or unsure post, a comment.
  // Cần bạn cards the team raised outside the desk arrive as a count from the piece's team_waits query.
  const asks = bl.filter(b => b.kind === 'ask').length;
  const cards = W.cards ?? 0;
  const handoffs = bl.filter(b => /^handoff/.test(b.kind)).reduce((n, b) => n + (b.count ?? 1), 0);
  const other = bl.filter(b => !['approval', 'approval_late', 'ask', 'paused'].includes(b.kind) && !/^handoff/.test(b.kind)).length;
  if (waiting) return { tone: 'wait', code: 'approvals', args: { n: waiting, ...(replies ? { replies } : {}), ...(asks ? { asks } : {}), ...(cards ? { cards } : {}), posted_today: today.length, next: nextArg } };
  if (asks || handoffs || other || cards) return { tone: 'wait', code: 'waits', args: { asks, handoffs, other, replies, cards, posted_today: today.length, next: nextArg } };
  if (replies) return { tone: 'wait', code: 'replies', args: { n: replies, next: nextArg } };
  return { tone: 'ok', code: 'healthy', args: { n: today.length, next: nextArg } };
}

async function productRows(W, bl) {
  const out = [];
  for (const p of W.products) {
    out.push({ id: p.id, name: p.name, mark: p.mark, site: p.site, blockers: bl.filter(b => b.product === p.id).length,
      blog: blogMode(p, W.hub.bound), blog_dir: blogMode(p, W.hub.bound) === 'folder' ? p.blog_dir : null, langs: p.langs,
      targets: p.targets.map(x => ({ ...x, label: targetLabel(x) })), subscribers: W.subscribers.get(p.id) ?? null,
      changelog: p.changelog, changelog_version: p.changelog ? await changelogVersion(W.root, p.changelog) : null });
  }
  return out;
}
/** Search Console as the desk shows it: ok, stale (no read in 3 days), needs_person (sign in / no access) or off. */
async function gscOf(store, now) {
  const v = (await store.one('settings', [eq('key', 'gsc')]).catch(() => null))?.value ?? null;
  if (!v || typeof v !== 'object') return { state: 'off', at: null };
  const at = typeof v.at === 'string' ? v.at : null;
  if (v.state === 'ok') return { state: now - t(at) > 3 * DAY ? 'stale' : 'ok', at };
  if (['needs_person', 'no_access'].includes(v.state)) return { state: 'needs_person', at, reason: v.state };
  return { state: 'off', at };
}
/** Clicks the product api counted on the campaigns' UTM links, or null when no campaign has a report. */
async function utmClicks(store) {
  const rows = await store.query('campaigns', [], { limit: 100 }).catch(() => []);
  const reports = rows.map(r => r.report).filter(r => r?.ok && Array.isArray(r.clicks));
  if (!reports.length) return null;
  return { total: reports.reduce((n, r) => n + r.clicks.reduce((m, c) => m + (Number(c.clicks) || 0), 0), 0), rows };
}

async function summaryView(W, input, store) {
  const bl = blockers(W, input.product);
  const metrics = await store.query('metrics', [eq('source', 'gsc'), gte('day', new Date(W.now - 8 * DAY).toISOString().slice(0, 10))], { limit: 500 }).catch(() => []);
  const blAll = input.product ? blockers(W, null) : bl;
  const other = W.items.some(i => !i.product);
  const utm = await utmClicks(store);
  const team = W.teams?.length ? { id: typeof W.teams[0] === 'string' ? W.teams[0] : W.teams[0]?.id ?? null } : null;
  return { view: 'summary', now: iso(W.now), mode: W.mode, team: team?.id ? team : null, abilities: W.abilities, gsc: await gscOf(store, W.now), status: statusOf(W, input.product, bl, W.products.length ? (await repliesOf(W, store, input.product)).need_total : 0), products: await productRows(W, blAll), other, tiles: tilesOf(W, input.product, metrics, utm?.total ?? null), sources: W.sources };
}

async function todayView(W, input, store) {
  const items = W.items.filter(forProduct(input.product));
  const start = localDayStart(W.now, TZ), end = start + DAY;
  const timeline = [];
  for (const i of items) for (const p of i.plan ?? []) {
    if (!p.at || t(p.at) < start || t(p.at) >= end) continue;
    timeline.push({ at: p.at, kind: 'post', product: i.product, channel: p.channel, lang: p.lang, ref: i.ref, title: i.title, state: p.state, ...(p.reason ? { reason: p.reason } : {}), ...(p.about ? { about: true } : {}) });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  const making = items.filter(i => i.stage === 'making' && i.state !== 'stopped').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const live = items.filter(i => i.stage === 'live').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { view: 'today', now: iso(W.now), day: localDay(W.now, TZ), blockers: blockers(W, input.product), making: making.slice(0, 6).map(itemRow), making_total: making.length, timeline: timeline.slice(0, 40), live: live.slice(0, 6).map(itemRow), live_total: live.length,
    replies: await repliesOf(W, store, input.product), learn: await learnOf(W, store, input.product), sources: W.sources };
}

/** The product a reply belongs to: the community post whose thread it is in, else the channel key's product suffix. */
function replyProduct(W, r) {
  const rel = W.releases.find(x => x.url && x.url === r.thread_url);
  if (rel) return rel.product;
  const m = /^[a-z]+-([a-z0-9-]+)$/.exec(r.channel ?? '');
  if (m && W.products.some(p => p.id === m[1])) return m[1];
  return W.products.length === 1 ? W.products[0].id : null;
}
/** Comments that need the founder, replies drafted and waiting, and how many were answered this week. */
async function repliesOf(W, store, product) {
  const rows = await store.query('replies', [], { order: 'created_at', desc: true, limit: 200 }).catch(() => []);
  const drafts = await store.query('posts', [eq('kind', 'reply')], { order: 'updated_at', desc: true, limit: 100 }).catch(() => []);
  const byRef = new Map(rows.map(r => [r.ref, r]));
  const need = rows.filter(r => r.state === 'needs_person').map(r => ({ ref: r.ref, product: replyProduct(W, r), channel: r.channel, class: r.class, author: r.author_handle ?? null, at: r.created_at ?? null, text: String(r.text ?? '').slice(0, 600), ...(r.reply_url ? { reply_url: r.reply_url } : {}), ...(r.thread_url ? { thread_url: r.thread_url } : {}) }))
    .filter(forProduct(product)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const drafted = drafts.filter(p => !['published', 'removed', 'pulled'].includes(p.state)).map(p => {
    const r = byRef.get(p.parent) ?? {};
    return { ref: p.ref, product: replyProduct(W, r), channel: p.channel, author: r.author_handle ?? null, text: String(p.body ?? '').slice(0, 600), state: p.state };
  }).filter(forProduct(product));
  const since = W.now - 7 * DAY;
  const answered = rows.filter(r => ['answered', 'done'].includes(r.state) && t(r.updated_at) >= since).filter(r => forProduct(product)({ product: replyProduct(W, r) })).length;
  return { need: need.slice(0, 20), need_total: need.length, drafted: drafted.slice(0, 20), answered_week: answered };
}

const words = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').split(/[^a-z0-9]+/).filter(w => w.length > 1);
/** What the numbers say and what to make next: Search Console pages and queries, the UTM clicks of campaigns, the
 *  plan's chosen topic. null while there is nothing to learn from (no product, no item). */
async function learnOf(W, store, product) {
  if (!W.products.length || !W.items.length) return null;
  const gsc = await gscOf(store, W.now);
  const since = new Date(W.now - 28 * DAY).toISOString().slice(0, 10);
  const metrics = await store.query('metrics', [eq('source', 'gsc'), gte('day', since)], { limit: 500 }).catch(() => []);
  const utm = await utmClicks(store);
  const basis = metrics.length ? 'gsc' : utm ? 'utm' : null;
  // Item urls: what the hub or the founder recorded as live.
  const byUrl = new Map();
  for (const i of W.items) for (const p of i.plan ?? []) if (p.url) byUrl.set(p.url, i);
  for (const i of W.items) for (const l of i.langs ?? []) if (l.hub?.url) byUrl.set(l.hub.url, i);
  const hostProduct = (url) => { try { const h = new URL(url).host; return W.products.find(p => p.site && h === String(p.site).replace(/^https?:\/\//, '').replace(/\/.*$/, ''))?.id ?? null; } catch { return null; } };
  const weekFrom = new Date(W.now - 8 * DAY).toISOString().slice(0, 10);
  const pages = new Map();
  for (const r of metrics.filter(x => x.query === '' && x.day >= weekFrom)) {
    const it = byUrl.get(r.url) ?? null;
    const k = it?.ref ?? r.url;
    const cur = pages.get(k) ?? { ...(it ? { ref: it.ref } : {}), product: it?.product ?? hostProduct(r.url), title: it?.title ?? r.url, clicks: 0, impressions: 0 };
    cur.clicks += r.clicks ?? 0; cur.impressions += r.impressions ?? 0;
    pages.set(k, cur);
  }
  let top = [...pages.values()].filter(forProduct(product)).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 3);
  if (!top.length && basis === 'utm') top = utm.rows.filter(c => c.report?.ok).map(c => ({ product: null, title: c.name ?? c.key, clicks: c.report.clicks.reduce((n, x) => n + (Number(x.clicks) || 0), 0) })).sort((a, b) => b.clicks - a.clicks).slice(0, 3);
  const qs = new Map();
  for (const r of metrics.filter(x => x.query)) {
    const cur = qs.get(r.query) ?? { query: r.query, product: hostProduct(r.url), impressions: 0, pos: 0 };
    cur.impressions += r.impressions ?? 0; cur.pos += (r.position ?? 0) * (r.impressions ?? 0);
    qs.set(r.query, cur);
  }
  const titles = W.items.map(i => ({ product: i.product, w: new Set(words(i.title)) }));
  const queries = [...qs.values()].filter(forProduct(product)).sort((a, b) => b.impressions - a.impressions).slice(0, 5).map(q => {
    const qw = words(q.query);
    return { product: q.product, query: q.query, impressions: q.impressions, position: q.impressions ? Math.round((q.pos / q.impressions) * 10) / 10 : null, covered: qw.length > 0 && titles.some(x => (!q.product || x.product === q.product) && qw.every(w => x.w.has(w))) };
  });
  const planned = (await store.one('settings', [eq('key', 'plan_topic')]).catch(() => null))?.value ?? null;
  const firstProduct = product ?? W.products[0].id;
  const gap = queries.find(q => !q.covered);
  const next = planned?.query ? { product: firstProduct, format: 'blog', topic: planned.query, why: 'plan_topic', why_args: { awareness: planned.awareness ?? null } }
    : gap ? { product: gap.product ?? firstProduct, format: 'blog', topic: gap.query, why: 'uncovered_query', why_args: { impressions: gap.impressions, position: gap.position } } : null;
  const inputs = [];
  if (gsc.state === 'off') inputs.push({ code: 'gsc_not_connected' });
  else if (gsc.state === 'needs_person') inputs.push({ code: 'gsc_sign_in', at: gsc.at });
  else if (gsc.state === 'stale') inputs.push({ code: 'gsc_stale', at: gsc.at });
  if (!basis) inputs.push({ code: 'no_signals' });
  const videos = W.items.filter(i => i.format === 'video' && i.state === 'handoff').filter(forProduct(product)).sort((a, b) => String(a.waiting_since).localeCompare(String(b.waiting_since)));
  if (videos.length) inputs.push({ code: 'video_links', n: videos.length, first: videos[0].ref });
  return { read_at: gsc.at, data_to: metrics.map(r => r.day).sort().at(-1) ?? null, basis, top, queries, next, inputs: inputs.slice(0, 2) };
}

const STAGE_ORDER = { approval: 0, scheduled: 1, making: 2, idea: 3, live: 4 };
function contentView(W, input) {
  const items = W.items.filter(forProduct(input.product));
  const stages = Object.fromEntries(STAGES.map(s => {
    const list = items.filter(i => i.stage === s);
    const sub = s === 'making' ? { asked: list.filter(i => i.state === 'asked').length, revising: list.filter(i => i.state === 'revising').length, stopped: list.filter(i => i.state === 'stopped').length }
      : s === 'scheduled' ? { held: list.filter(i => ['held', 'uncertain'].includes(i.state)).length, handoff: list.filter(i => i.state === 'handoff').length }
        : s === 'approval' ? { granted: list.filter(i => i.state === 'granted').length }
        : s === 'live' ? (() => { const w = liveWeek(W, list); return { week: w.live.length, posts: w.posts, channels: w.channels }; })() : {};
    // Đã lên counts this week's items, as the tile does; older ones open with live: "all".
    return [s, { count: s === 'live' ? sub.week : list.length, sub }];
  }));
  if (input.stage && !STAGES.includes(input.stage)) fail('invalid_request', `stage is one of ${STAGES.join(', ')}.`);
  if (input.live !== undefined && input.live !== 'all') fail('invalid_request', 'live is "all" (every live item, not only this week\'s).');
  const older = (i) => i.stage === 'live' && t(i.at) < W.now - 7 * DAY;
  const olderLive = items.filter(older).length;
  const list = items.filter(i => (!input.stage || i.stage === input.stage) && (input.live === 'all' || !older(i))).sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || (a.stage === 'live' ? String(b.at).localeCompare(String(a.at)) : String(a.at ?? a.waiting_since ?? '~').localeCompare(String(b.at ?? b.waiting_since ?? '~')) || String(b.updated_at).localeCompare(String(a.updated_at))));
  const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
  if (!Number.isInteger(offset) || offset < 0) fail('invalid_request', 'cursor is the next_cursor a content view returned.');
  const page = list.slice(offset, offset + PAGE);
  return { view: 'content', stage: input.stage ?? null, live: input.live ?? null, stages, items: page.map(itemRow), total: list.length, older_live: olderLive, next_cursor: offset + PAGE < list.length ? String(offset + PAGE) : null, sources: W.sources };
}

const FRONT = /^---\n[\s\S]*?\n---\n?/;
async function itemView(W, input, { env, fetchImpl, soot }) {
  if (typeof input.ref !== 'string' || !/^(MK-[0-9A-Z]{6}|P-[0-9A-F]{10})$/.test(input.ref)) fail('invalid_request', 'ref is an item ref.');
  const it = W.items.find(i => i.ref === input.ref);
  if (!it) fail('not_found', `No item ${input.ref} on the desk.`);
  const out = { view: 'item', ...itemRow(it), source: it.source ?? null, files: it.dir ?? null, has_files: !!it.files, approval: it.approval ?? null, langs: [], posts: [], sources: W.sources };
  if (it.hubless) return { ...out, body: null };
  for (const l of it.langs) {
    let body = null, from = null;
    if (W.root && it.files && l.file) { try { body = (await readText(W.root, `${it.dir}/${l.file}`)).replace(FRONT, '').trim(); from = 'file'; } catch { body = null; } }
    if (body === null && W.hub.bound && l.site) {
      const r = await hubCall(env, 'cms_read', { site: l.site, slug: l.slug }, { fetchImpl, soot });
      if (r.ok) { body = r.data.body_markdown ?? null; from = 'hub'; l.preview_url = l.preview_url ?? r.data.preview_url ?? null; l.hub = { ...(l.hub ?? {}), revision: r.data.revision, status: r.data.status }; }
    }
    out.langs.push({ lang: l.lang, title: l.title ?? null, summary: l.summary ?? null, body, from, words: body ? body.split(/\s+/).filter(Boolean).length : null, site: l.site, slug: l.slug, revision: l.hub?.revision ?? l.revision ?? null, status: l.hub?.status ?? l.status ?? null, url: l.hub?.url ?? null, preview: l.preview_url ?? null });
  }
  for (const p of it.posts) {
    let text = p.hub?.text ?? null, from = text === null ? null : 'hub';
    if (text === null && W.root && it.files && p.file) { try { text = (await readText(W.root, `${it.dir}/${p.file}`)).trim(); from = 'file'; } catch { text = null; } }
    const max = W.hub.channels?.channels?.find(c => c.channel === p.channel)?.max_length ?? null;
    out.posts.push({ channel: p.channel, lang: p.lang, id: p.id ?? null, text, from, link: p.hub?.link ?? p.link ?? null, len: text === null ? null : [...text].length, max, revision: p.hub?.revision ?? p.revision ?? null, status: p.hub?.status ?? p.status ?? null, url: p.hub?.url ?? null, note: p.hub?.note ?? null });
  }
  out.plan = it.plan ?? [];
  const m = it.meta ?? {};
  out.revision = m.revision ?? null;
  out.approved_at = it.approved_at ?? null;
  if (!W.hub.bound) out.hubless = true;
  // A Micro Fish verdict holds for the revision it read; the team without Micro Fish gets no pre-test at all.
  out.pretest = W.abilities?.micro_fish === false ? { state: 'unavailable' } : m.pretest ? { ...m.pretest, ...(m.pretest.revision !== (m.revision ?? null) ? { stale: true } : {}) } : null;
  const fileBody = async (file) => { if (!W.root || !it.files || !file) return null; try { return (await readText(W.root, `${it.dir}/${file}`)).replace(FRONT, '').trim(); } catch { return null; } };
  if (m.community) {
    const target = m.community.target ?? null;
    out.community = { lang: m.community.lang, target: target ? { ...target, label: targetLabel(target) } : null, title: m.community.title, title_max: TITLE_MAX[target?.kind] ?? null, body: (await fileBody(m.community.file)) ?? m.community.body ?? null, revision: m.community.revision ?? null, ...(m.split ? { split: m.split } : {}), ...(m.parent ? { parent: m.parent } : {}) };
  }
  if (m.newsletter) out.newsletter = { lang: m.newsletter.lang, subject: m.newsletter.subject, preheader: m.newsletter.preheader ?? null, subscribers: W.subscribers.get(it.product) ?? null, body: await fileBody(m.newsletter.file), revision: m.newsletter.revision ?? null, export: m.newsletter.export ? { ...m.newsletter.export, paths: W.root ? (m.newsletter.export.files ?? []).map(f => join(W.root, f)) : [] } : null, sending_at: m.newsletter.sending_at ?? null };
  if (it.format === 'video' && it.state === 'handoff') {
    const line = W.items.filter(i => i.format === 'video' && i.state === 'handoff' && i.product === it.product).sort((a, b) => String(a.waiting_since).localeCompare(String(b.waiting_since)) || a.ref.localeCompare(b.ref));
    const pos = line.findIndex(i => i.ref === it.ref);
    out.queue = { pos: pos + 1, total: line.length, next: line[pos + 1]?.ref ?? null };
  }
  if (it.video) {
    // The TikTok hand-off: the delivered file's full path on this machine (for "Chép đường dẫn"), its caption, and the
    // TikTok account the founder named at setup.
    const prod = W.products.find(p => p.id === it.product);
    const tk = it.video.tiktok;
    const acct = videoAccount(W, it);
    out.video = { ...it.video, dir: it.dir, channel: it.channel_dir, account: acct?.account ?? (acct ? null : prod?.accounts?.tiktok ?? null), ...(acct ? { channel_key: acct.channel } : {}),
      tiktok: tk ? { file: tk.file, path: W.root ? join(W.root, ...tk.file.split('/')) : null, caption: tk.caption ?? null } : null };
  }
  if (it.topic) out.topic = it.topic;
  if (it.to) out.to = it.to;
  // A desk item still waiting on its first save: the page can resend the same ask (same words, same ask-<ref>).
  if (it.state === 'asked' && it.meta?.by === 'desk' && it.topic) {
    const prod = W.products.find(p => p.id === it.product);
    out.ask_text = askText({ ref: it.ref, to: it.to ?? 'writer', format: it.format, product: prod?.name ?? it.product, topic: it.topic, channels: it.channels_wanted ?? [], tiktok: (prod?.tiktok_accounts ?? []).map(a => tiktokChannelId(a.handle)), series: it.series ?? null, target: it.meta?.target ?? null, source: it.meta?.source_kind ?? null, changelog: it.meta?.version ?? null, notes: it.meta?.changelog ?? null });
  }
  return out;
}

function channelsView(W, input) {
  const products = W.products.filter(forProduct(input.product));
  const xEntry = W.hub.channels?.channels?.find(c => c.channel === 'x');
  return {
    view: 'channels',
    publishers: {
      hub: { ok: W.sources[0].ok, host: W.sources[0].host, error: W.sources[0].error ?? null, sites: W.hub.channels?.sites ?? null },
      poster: xEntry?.accounts?.some(a => a.kind === 'browser') ? { seen_at: xEntry.poster_seen_at ?? null, paused: !!W.state.pause.all, budget_stop: null, skipped_7d: null, browser_installed: null, why: 'not_read_yet' } : null,
      paused: W.state.pause.all ? { since: W.state.pause.all.since } : null,
    },
    rows: products.map(p => ({ product: p.id, name: p.name, cadence: Object.fromEntries(['blog', 'x', 'facebook'].map(ch => [ch, rulesFor(W.state, `${p.id}:${ch}`)])), cells: Object.fromEntries(DESK_CHANNELS.map(ch => [ch, cellFor(W, p.id, ch)])) })),
    sources: W.sources,
  };
}

const KEY = /^([a-z0-9][a-z0-9-]{0,31}):(blog|x|facebook|tiktok|reddit|community|newsletter)$/;
function channelView(W, input) {
  const m = KEY.exec(input.key ?? '');
  if (!m) fail('invalid_request', 'key is <product>:<channel>.');
  const [, product, channel] = m;
  if (!W.products.some(p => p.id === product)) fail('not_found', `No product ${product}.`);
  const cell = cellFor(W, product, channel);
  // A TikTok cell's steps act on one account row (tiktok-<handle>): the first signed-out one, else the first paused one.
  const line = (cell.accounts ?? []).find(a => a.state === 'signed_out') ?? (cell.accounts ?? []).find(a => a.state === 'paused') ?? null;
  const row = line ? { channel: line.channel } : {};
  const profile = line?.profile ?? cell.profile ?? null;
  const steps = cell.state === 'signed_out' ? [{ id: 'sign_in', done: false, href: signInLink(profile, PLATFORM_HOST[channel]), args: { account: line?.account ?? cell.account, profile: line?.profile ?? cell.profile, ...row } }, { id: 'budget', done: null }, { id: 'resume', done: false, ...(line ? { args: { ...row, account: line.account } } : {}) }]
    : cell.state === 'paused' ? [{ id: 'resume', done: false, ...(line ? { args: { ...row, account: line.account } } : {}) }]
      : cell.state === 'not_connected' ? [{ id: 'connect', done: false, ask: true }]
        : cell.state === 'no_account' || (cell.state === 'off' && cell.why === 'not_chosen' && W.hub.bound && ['x', 'facebook'].includes(channel)) ? [{ id: 'create_account', done: false }, { id: 'connect', done: false, ask: true }]
          : [];
  const waiting = W.items.filter(i => i.product === product && (i.plan ?? []).some(p => p.channel === channel && ['scheduled', 'held', 'after_approval', 'handoff', 'no_account', 'channel_not_connected'].includes(p.state)));
  // A TikTok cell binds its accounts to Nest's browser profiles on the desk (T3): the profiles it may offer.
  return { view: 'channel', key: input.key, cell, steps, rules: rulesFor(W.state, input.key), waiting: waiting.slice(0, 20).map(itemRow), sources: W.sources,
    ...(channel === 'tiktok' ? { profiles: profileChoices(W, 'tiktok') } : {}) };
}

async function libraryView(W, input) {
  if (!W.root && !W.lib.length) return { view: 'library', tree: [], why: W.rootError === 'not_configured' ? 'library_not_configured' : 'library_unreadable', sources: W.sources };
  const items = W.items.filter(i => i.format !== 'video').map(itemRow);
  if (!input.node) {
    // A product's Bài viết counts what its node lists: items with files and hub-only ones.
    const tree = libraryTree(W.lib, W.products);
    for (const p of tree) for (const n of p.children ?? []) if (n.kind === 'posts') n.count = items.filter(i => i.product === p.product).length;
    return { view: 'library', tree, sources: W.sources };
  }
  return { view: 'library', node: input.node, detail: await libraryDetail(input.node, { rows: W.lib, root: W.root, items }), sources: W.sources };
}

// ---------- numbers ----------

/** ISO week id (local time) of a moment: 2026-W47. */
export function isoWeek(ms, tz = TZ) {
  const day = localDay(ms, tz);
  const d = new Date(`${day}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7; // Monday 0
  d.setUTCDate(d.getUTCDate() - wd + 3); // Thursday of this week
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
/** The local Monday 00:00 → next Monday of an ISO week id, in UTC ms. */
export function weekRange(id, tz = TZ) {
  const m = /^(\d{4})-W(\d{2})$/.exec(id ?? '');
  if (!m) fail('invalid_request', 'week is YYYY-Www.');
  const [y, w] = [Number(m[1]), Number(m[2])];
  if (w < 1 || w > 53) fail('invalid_request', 'week is YYYY-Www.');
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY + (w - 1) * 7 * DAY);
  const day = monday.toISOString().slice(0, 10);
  // Local midnight of that day: the UTC instant whose local day it is, at local 00:00.
  const noon = Date.parse(`${day}T12:00:00Z`);
  const from = localDayStart(noon, tz);
  return { id, from, to: from + 7 * DAY };
}

async function numbersView(W, input, store) {
  const week = weekRange(input.week ?? isoWeek(W.now));
  const prev = { from: week.from - 7 * DAY, to: week.from };
  const hubWhy = !W.hub.bound ? 'hubless' : !W.hub.ok ? 'hub' : null;
  // A desk with no hub still knows its own browser channels (TikTok accounts): Kênh cần sửa counts them.
  const ownRows = (W.channels ?? []).some(c => c.publisher === 'browser' && c.key !== 'tiktok' && c.paused_reason !== 'retired');
  const channelsWhy = hubWhy === 'hubless' && ownRows ? null : hubWhy;
  const gsc = await store.query('metrics', [eq('source', 'gsc'), gte('day', new Date(prev.from).toISOString().slice(0, 10))], { limit: 500 }).catch(() => []);
  const rows = [];
  const metricsFiles = W.lib.filter(r => r.kind === 'metrics');
  for (const p of W.products.filter(forProduct(input.product))) {
    const site = p.hub_site;
    const count = (ch, r) => (ch === 'blog'
      ? (W.hub.cms.get(site) ?? []).filter(x => x.status === 'published' && t(x.published_at) >= r.from && t(x.published_at) < r.to).length
      : W.hub.social.filter(x => x.channel === ch && x.status === 'published' && postProduct(W, x) === p.id && t(x.published_at) >= r.from && t(x.published_at) < r.to).length);
    for (const ch of ['blog', 'x', 'facebook']) {
      const cell = cellFor(W, p.id, ch);
      if (ch !== 'blog' && ['no_account', 'off'].includes(cell.state)) continue;
      const row = { product: p.id, channel: ch, published: hubWhy ? null : count(ch, week), prev: hubWhy ? null : count(ch, prev), views: null, clicks: null, why: hubWhy };
      if (!hubWhy && ch === 'blog') {
        const urls = new Set((W.hub.cms.get(site) ?? []).map(x => x.url).filter(Boolean));
        const mine = gsc.filter(r => r.query === '' && urls.has(r.url) && t(r.day) >= week.from - DAY && t(r.day) < week.to);
        if (mine.length) { row.views = mine.reduce((n, r) => n + (r.impressions ?? 0), 0); row.clicks = mine.reduce((n, r) => n + (r.clicks ?? 0), 0); row.views_kind = 'impressions'; }
        else row.why = 'search_console_not_connected';
      } else if (!hubWhy) row.why = cell.state === 'signed_out' ? 'signed_out' : 'not_read_yet';
      rows.push(row);
    }
    // TikTok: videos.csv of the product's channels, the one place the founder records a posted video.
    const files = metricsFiles.filter(r => r.product === p.id);
    if (files.length || W.items.some(i => i.product === p.id && i.format === 'video')) {
      const posted = files.flatMap(r => r.meta?.slugs ?? []);
      const inWeek = (r) => posted.filter(s => s.posted && t(`${s.posted}T12:00:00Z`) >= r.from && t(`${s.posted}T12:00:00Z`) < r.to);
      const wk = inWeek(week);
      const views = wk.map(s => s.views_7d).filter(v => v !== null && v !== undefined);
      const delivered = W.items.filter(i => i.product === p.id && i.state === 'handoff').length;
      rows.push({ product: p.id, channel: 'tiktok', published: files.length ? wk.length : null, prev: files.length ? inWeek(prev).length : null, views: views.length ? views.reduce((a, b) => a + b, 0) : null, clicks: null, why: !files.length ? 'no_metrics_file' : delivered ? 'no_posted_links' : views.length ? null : 'not_read_yet', why_args: delivered ? { n: delivered } : undefined });
    }
  }
  return { view: 'numbers', week: { id: week.id, from: iso(week.from), to: iso(week.to - 1), prev: isoWeek(week.from - DAY) }, rows, sources: W.sources };
}

// ---------- page_view entry ----------

export async function deskView(input, deps) {
  const view = input.view;
  if (!VIEWS.includes(view)) fail('invalid_request', `view is one of ${VIEWS.join(', ')}.`);
  if (input.product !== undefined && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.product)) fail('invalid_request', 'product is a product id.');
  const approvals = approvalsIn(input.approvals);
  // with_summary: the tab and the header from one read, so a refresh costs the hub's rate budget once, not twice.
  const withSummary = input.with_summary === true && view !== 'summary';
  const W = await gather(deps, { hub: withSummary || view !== 'library' || !input.node || /^posts:/.test(input.node), approvals, profiles: withSummary || !['content', 'library'].includes(view) });
  W.cards = cardsIn(input.cards);
  // A TikTok cell's account picker lists every profile, even before any row names one.
  if (view === 'channel' && !W.profiles && /:tiktok$/.test(input.key ?? '')) W.profiles = await readProfiles(deps.env, deps.fetch);
  const out = await viewOf(view, W, input, deps);
  if (withSummary) out.summary = await summaryView(W, { ...input, view: 'summary' }, deps.store);
  return out;
}
function viewOf(view, W, input, deps) {
  switch (view) {
    case 'summary': return summaryView(W, input, deps.store);
    case 'today': return todayView(W, input, deps.store);
    // The Claude Code jobs that make videos (the ledger video_job and video_import keep), with the first page only.
    case 'content': return readJobs(deps.store).then(jobs => ({ ...contentView(W, input), claude_code: input.cursor === undefined ? jobsView(jobs, { now: W.now, product: input.product ?? null }) : null }));
    case 'item': return itemView(W, input, { env: deps.env, fetchImpl: deps.fetch, soot: deps.soot });
    case 'channels': return channelsView(W, input);
    case 'channel': return channelView(W, input);
    case 'library': return libraryView(W, input);
    case 'numbers': return numbersView(W, input, deps.store);
  }
}
