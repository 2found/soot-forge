// The Marketing desk's actions (spec §6): page_action {op, request_id, ...}.
// The runtime keeps each request_id's receipt for 7 days and replays it without
// running the tool (pieces §3), so these keep no receipt table of their own;
// each op is also keyed on its effect, so the same intent sent with a new id
// changes nothing twice. None of them publishes: stop and pause only prevent
// output, and nothing here calls cms_publish or social_publish.
import { fail, eq } from './store.mjs';
import { hubCall, hubBinding, WRITE_TIMEOUT_MS } from './hub.mjs';
import { libraryRoot, readText, writeText, exists, segments } from './root.mjs';
import { itemRow, putItem, refFor, itemDir, slugify, markRadar, appendVideo, refreshIndex, loadProducts, askText, normalProduct, targetOf, targetLabel, changelogSection, TZ, FORMATS, ITEM_REF, CHANNEL_KEY, PRODUCT_ID } from './library.mjs';
import { fold as foldAccents } from './guard.mjs';
import { setPause, setRules, deskState, rulesFor, stopReleases, holdApproved, LOCAL_ID } from './bundle.mjs';
import { gather, cellFor, isoWeek } from './desk.mjs';
import { localDay } from './time.mjs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep, dirname, basename, join } from 'node:path';

export const DESK_OPS = ['stop', 'pause', 'resume', 'rules', 'confirm', 'mark', 'create', 'scan', 'setup', 'reply_done', 'export', 'subscribers'];
const REPLY_REF = /^R-[0-9A-F]{10}$/;
/** The link of a community post, per place: a Reddit thread in that subreddit, a Hacker News item, a dev.to article. */
const COMMUNITY_URLS = {
  reddit: (t) => new RegExp(`^https://(www\\.|old\\.|new\\.)?reddit\\.com/r/${t.sub}/comments/[a-z0-9]{3,12}(/[^\\s?#]*)?$`, 'i'),
  hn: () => /^https:\/\/news\.ycombinator\.com\/item\?id=\d{1,12}$/,
  devto: () => /^https:\/\/dev\.to\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]{1,200}$/,
  other: () => /^https:\/\/[^\s/]+\.[^\s]+$/,
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const fold = (s) => foldAccents(s).replace(/\s+/g, ' ').trim();
const URLS = {
  x: /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{5,25}(\?.*)?$/,
  facebook: /^https:\/\/(www\.|m\.)?facebook\.com\/\S+$/,
  tiktok: /^https:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9._]{1,30}\/video\/\d{5,25}(\?.*)?$/,
};

/** A desk op is one of DESK_OPS; pause/resume are desk ops only with a scope (the old Hàng đợi ops have none). */
export const isDeskOp = (input) => DESK_OPS.includes(input?.op) && (!['pause', 'resume'].includes(input.op) || input.scope !== undefined);

export async function deskAction(input, deps) {
  const { store, now } = deps;
  switch (input.op) {
    case 'stop': return stop(input, deps);
    case 'pause': case 'resume': {
      const scope = input.scope;
      if (!['all', 'channel'].includes(scope)) fail('invalid_request', 'scope is all or channel.');
      if (scope === 'channel' && !CHANNEL_KEY.test(input.channel ?? '')) fail('invalid_request', 'channel is <product>:<channel>.');
      const paused = input.op === 'pause';
      const at = await setPause(store, { scope, channel: input.channel }, paused, now);
      if (paused) {
        // What the hub already queued for the Poster is taken back too; a post it could not reach stays named.
        const { held, kept } = await holdApproved(store, { scope, channel: input.channel }, { env: deps.env, fetchImpl: deps.fetch, soot: deps.soot });
        return { ok: true, op: input.op, scope, ...(scope === 'channel' ? { channel: input.channel } : {}), paused: true, since: at?.since ?? new Date(now).toISOString(), ...(held ? { withdrawn: held } : {}), ...(kept ? { still_queued: kept } : {}) };
      }
      // Resuming a browser channel does not sign it in: say so when the Poster still reports it signed out.
      let still = false;
      if (scope === 'channel' && hubBinding(deps.env).ok) {
        const W = await gather(deps, { hub: true, remember: true });
        const [product, channel] = input.channel.split(':');
        still = cellFor(W, product, channel).state === 'signed_out';
      }
      return { ok: true, op: input.op, scope, ...(scope === 'channel' ? { channel: input.channel } : {}), paused: false, ...(still ? { still_signed_out: true } : {}) };
    }
    case 'rules': return rules(input, deps);
    case 'confirm': return confirm(input, deps);
    case 'mark': return mark(input, deps);
    case 'create': return create(input, deps);
    case 'setup': return setup(input, deps);
    case 'reply_done': return replyDone(input, deps);
    case 'export': return exportNewsletter(input, deps);
    case 'subscribers': return subscribers(input, deps);
    case 'scan': {
      // The founder's "Quét lại" in Thư viện: the same index refresh library_scan runs, without the hub read.
      const lr = await libraryRoot(deps.env);
      if (!lr.ok) fail('needs_credential', 'Scanning reads the marketing library: set MARKETING_ROOT first.');
      const { fresh, added, changed, removed } = await refreshIndex(store, lr.root, now);
      return { ok: true, op: 'scan', files: fresh.length, added, changed, removed };
    }
  }
  fail('invalid_request', `op is one of ${DESK_OPS.join(', ')}.`);
}

// ---------- stop ----------

async function stop(input, deps) {
  const { store, env, now, fetch: fetchImpl, soot } = deps;
  if (!ITEM_REF.test(input.ref ?? '')) fail('invalid_request', 'ref is an item ref, MK-XXXXXX.');
  const row = await itemRow(store, input.ref);
  const rel = await stopReleases(store, input.ref, { env, fetchImpl, soot, now });
  const stamp = new Date(now).toISOString();
  if (row) {
    if (row.meta?.state !== 'stopped') {
      const lr = await libraryRoot(env);
      const meta = { ...row.meta, state: 'stopped', stopped_at: stamp };
      // The file keeps the state too, so a later scan or another desk sees it stopped.
      if (lr.ok && !row.meta?.planned) await putItem(store, lr.root, meta, { now });
      else await store.update('library', [eq('path', row.path)], { meta: { ...meta, planned: !!row.meta?.planned } });
    }
  } else {
    // A hub-only item has no folder: the desk keeps its stop as a store row (planned) that a scan never drops.
    const W = await gather(deps, { hub: true, remember: true });
    const it = W.items.find(i => i.ref === input.ref);
    if (!it) fail('not_found', `No item ${input.ref} on the desk.`);
    try {
      await store.insert('library', { path: `planned/${input.ref}`, kind: 'item', product: it.product, channel: null, series: null, campaign: null, title: String(it.title ?? '').slice(0, 300), mtime: stamp, sha: null, ref: input.ref,
        meta: { ref: input.ref, product: it.product, format: it.format, title: it.title, state: 'stopped', stopped_at: stamp, planned: true, hub_only: true, langs: it.langs.map(({ hub, ...l }) => l), posts: it.posts.map(({ hub, ...p }) => p) } });
    } catch (e) { if (e.code !== 'conflict') throw e; }
  }
  return { ok: true, op: 'stop', ref: input.ref, stage: 'making', state: 'stopped', stopped: rel.stopped, withdrawn: rel.withdrawn, ...(rel.kept ? { kept: rel.kept } : {}) };
}

// ---------- rules ----------

async function rules(input, { store }) {
  const key = input.channel;
  if (!CHANNEL_KEY.test(key ?? '')) fail('invalid_request', 'channel is <product>:<channel>.');
  const int = (v, lo, hi, name) => { if (!Number.isInteger(v) || v < lo || v > hi) fail('invalid_request', `${name} is a whole number from ${lo} to ${hi}.`); return v; };
  const s = await deskState(store);
  const cur = rulesFor(s, key);
  const next = {
    cap_per_day: input.cap_per_day === undefined ? cur.cap_per_day : int(input.cap_per_day, 0, 50, 'cap_per_day'),
    spacing_min: input.spacing_min === undefined ? cur.spacing_min : int(input.spacing_min, 0, 1440, 'spacing_min'),
    quiet: input.quiet === undefined ? cur.quiet : input.quiet === null ? null : (HHMM.test(input.quiet?.from ?? '') && HHMM.test(input.quiet?.to ?? '') ? { from: input.quiet.from, to: input.quiet.to } : fail('invalid_request', 'quiet is {from: "HH:MM", to: "HH:MM"} or null.')),
  };
  if (input.max_len !== undefined) next.max_len = int(input.max_len, 1, 5000, 'max_len');
  else if (cur.max_len) next.max_len = cur.max_len;
  const saved = await setRules(store, key, next);
  return { ok: true, op: 'rules', channel: key, rules: saved };
}

// ---------- confirm (uncertain post, video hand-off) ----------

async function confirm(input, deps) {
  const { store, env, now, fetch: fetchImpl, soot } = deps;
  if (!ITEM_REF.test(input.ref ?? '')) fail('invalid_request', 'ref is an item ref, MK-XXXXXX.');
  if (!['posted', 'not_posted', 'sent'].includes(input.outcome)) fail('invalid_request', 'outcome is posted, not_posted or sent (a newsletter).');
  let video = await store.one('library', [eq('ref', input.ref), eq('kind', 'campaign')]);
  // A campaign the Builder made since the last scan: index the library once, then look again.
  if (!video && !(await itemRow(store, input.ref))) {
    const lr = await libraryRoot(env);
    if (lr.ok) { await refreshIndex(store, lr.root, now); video = await store.one('library', [eq('ref', input.ref), eq('kind', 'campaign')]); }
  }
  if (video) {
    if (input.outcome !== 'posted') fail('invalid_request', 'A video hand-off is confirmed with its posted link.');
    if (!URLS.tiktok.test(input.url ?? '')) fail('bad_url', 'The link is https://www.tiktok.com/@<account>/video/<digits>.');
    const lr = await libraryRoot(env);
    if (!lr.ok) fail('needs_credential', 'Recording a posted video writes videos.csv: set MARKETING_ROOT first.');
    const delivered = video.meta?.delivery?.[0] ?? null;
    const res = await appendVideo(lr.root, video.channel, { slug: video.campaign, script: delivered, series: video.series ?? '', url: input.url.replace(/\?.*$/, ''), posted: localDay(now, TZ) });
    await refreshIndex(store, lr.root, now);
    // The next video waiting for its link, so the sheet can go straight on to it.
    const W = await gather(deps, { hub: false });
    const line = W.items.filter(i => i.format === 'video' && i.state === 'handoff' && i.product === video.product).sort((a, b) => String(a.waiting_since).localeCompare(String(b.waiting_since)) || a.ref.localeCompare(b.ref));
    return { ok: true, op: 'confirm', ref: input.ref, state: 'posted', file: res.file, changed: res.changed, row: res.row, queue: { left: line.length, next: line[0]?.ref ?? null } };
  }
  const local = await confirmLocal(input, deps);
  if (local) return local;
  if (!hubBinding(env).ok) fail('needs_credential', 'Confirming a post reads the marketing hub: set MARKETING_HUB first.');
  const W = await gather(deps, { hub: true, remember: true });
  const it = W.items.find(i => i.ref === input.ref);
  if (!it) fail('not_found', `No item ${input.ref} on the desk.`);
  const posts = it.posts.filter(p => (!input.channel || p.channel === input.channel) && (!input.lang || p.lang === input.lang) && p.hub);
  const target = posts.find(p => ['uncertain', 'publishing'].includes(p.hub.status)) ?? posts.find(p => p.hub.status === 'published') ?? posts.find(p => p.hub.status === 'approved');
  if (!target) fail('not_found', `${input.ref} has no post the desk is unsure about.`);
  const rel = await store.one('releases', [eq('ref', input.ref), eq('hub_id', target.id)]);
  if (input.outcome === 'posted') {
    const url = String(input.url ?? '').replace(/[?#].*$/, '');
    if (!URLS[target.channel]?.test(url)) fail('bad_url', target.channel === 'x' ? 'The link is https://x.com/<account>/status/<digits>.' : 'The link is the address of the post on Facebook.');
    if (target.hub.status === 'published') { if (rel) await store.update('releases', [eq('key', rel.key)], { state: 'posted', url: target.hub.url ?? url }); return { ok: true, op: 'confirm', ref: input.ref, state: 'posted', url: target.hub.url ?? url, already: true }; }
    const res = await hubCall(env, 'social_record', { id: target.id, expected_revision: target.hub.revision, url }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot });
    if (!res.ok) fail(res.error === 'refused' ? 'hub_refused' : `hub_${res.error}`, res.message ?? 'The hub did not take the link.');
    if (rel) await store.update('releases', [eq('key', rel.key)], { state: 'posted', url, outcome: { status: 'published', at: new Date(now).toISOString(), by: 'founder' } });
    return { ok: true, op: 'confirm', ref: input.ref, state: 'posted', url };
  }
  // Not there: back to draft at the hub, so nothing goes out again until the founder approves it again.
  if (target.hub.status === 'published') fail('conflict', 'The hub already has this post as published.');
  if (target.hub.status !== 'draft') {
    const res = await hubCall(env, 'social_update', { id: target.id, expected_revision: target.hub.revision, status: 'draft' }, { fetchImpl, timeoutMs: WRITE_TIMEOUT_MS, soot });
    if (!res.ok) fail(res.error === 'refused' ? 'hub_refused' : `hub_${res.error}`, res.message ?? 'The hub did not take the post back.');
  }
  if (rel) await store.update('releases', [eq('key', rel.key)], { state: 'superseded', reason: 'not_posted' });
  return { ok: true, op: 'confirm', ref: input.ref, state: 'draft' };
}

/** A pasted post link as it is kept: no query or fragment, except a Hacker News item keeps only its id. */
function canonicalUrl(url) {
  const hn = /^https:\/\/news\.ycombinator\.com\/item\?(?:[^#]*&)?id=(\d+)/.exec(url);
  return hn ? `https://news.ycombinator.com/item?id=${hn[1]}` : url.replace(/[?#].*$/, '');
}

/** A part the founder carries out by hand (community post, newsletter, a hand-off social post, a blog written to the
 *  site folder): the release row here is the record, no hub. null when the item has no such row. */
async function confirmLocal(input, { store, now }) {
  const rows = (await store.query('releases', [eq('ref', input.ref)], { limit: 50 }))
    .filter(r => ['handoff', 'exported', 'written', 'posted'].includes(r.state) && (r.channel === 'blog' ? r.outcome?.via === 'folder' : LOCAL_ID.test(r.hub_id ?? '')))
    .filter(r => (!input.channel || r.channel === input.channel) && (!input.lang || r.lang === input.lang));
  const stamp = new Date(now).toISOString();
  if (input.outcome === 'sent') {
    const r = rows.find(x => x.channel === 'newsletter');
    if (!r) fail('not_found', `${input.ref} has no approved newsletter waiting to be sent.`);
    if (r.state === 'posted') return { ok: true, op: 'confirm', ref: input.ref, channel: 'newsletter', state: 'posted', already: true };
    await store.update('releases', [eq('key', r.key), eq('state', r.state)], { state: 'posted', outcome: { ...(r.outcome ?? {}), status: 'sent', at: stamp, by: 'founder' } });
    return { ok: true, op: 'confirm', ref: input.ref, channel: 'newsletter', state: 'posted' };
  }
  const url = canonicalUrl(String(input.url ?? '').trim().replace(/#.*$/, ''));
  // A replay of a link already recorded answers as before, whichever row is still open.
  const done = input.outcome === 'posted' && url ? rows.find(x => x.channel !== 'newsletter' && ['posted', 'written'].includes(x.state) && x.url === url) : null;
  if (done) return { ok: true, op: 'confirm', ref: input.ref, channel: done.channel, lang: done.lang, state: done.state, url, already: true };
  const open = rows.filter(x => x.channel !== 'newsletter').sort((a, b) => (a.state === 'posted') - (b.state === 'posted') || String(a.slot_at).localeCompare(String(b.slot_at)));
  const r = open[0];
  if (!r) {
    if (input.outcome !== 'not_posted') return null;
    // A replay of not_posted: the row it took back is superseded, the answer is the same.
    const back = (await store.query('releases', [eq('ref', input.ref), eq('state', 'superseded')], { limit: 50 }))
      .find(x => x.reason === 'not_posted' && LOCAL_ID.test(x.hub_id ?? '') && (!input.channel || x.channel === input.channel) && (!input.lang || x.lang === input.lang));
    return back ? { ok: true, op: 'confirm', ref: input.ref, channel: back.channel, lang: back.lang, state: 'draft', already: true } : null;
  }
  if (input.outcome === 'not_posted') {
    if (r.state === 'posted') fail('conflict', 'This post is already recorded as posted.');
    // Not out after all: the approval is spent, the item goes back to the Writer and needs a new one.
    await store.update('releases', [eq('key', r.key), eq('state', r.state)], { state: 'superseded', reason: 'not_posted' });
    return { ok: true, op: 'confirm', ref: input.ref, channel: r.channel, lang: r.lang, state: 'draft' };
  }
  let check;
  if (r.channel === 'community') {
    const item = await itemRow(store, input.ref);
    const target = item?.meta?.community?.target ?? { kind: 'other' };
    check = COMMUNITY_URLS[target.kind]?.(target) ?? COMMUNITY_URLS.other();
    if (!check.test(url)) fail('bad_url', target.kind === 'reddit' ? `The link is a thread in r/${target.sub}: https://www.reddit.com/r/${target.sub}/comments/…` : target.kind === 'hn' ? 'The link is https://news.ycombinator.com/item?id=<digits>.' : target.kind === 'devto' ? 'The link is https://dev.to/<account>/<article>.' : 'The link is an https:// address.');
  } else if (r.channel === 'blog') {
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url)) fail('bad_url', 'The link is the https:// address of the post on the site.');
  } else if (!URLS[r.channel]?.test(url.replace(/\?.*$/, ''))) fail('bad_url', r.channel === 'x' ? 'The link is https://x.com/<account>/status/<digits>.' : 'The link is the address of the post on Facebook.');
  const clean = url;
  if (r.state === 'posted' && r.url === clean) return { ok: true, op: 'confirm', ref: input.ref, channel: r.channel, lang: r.lang, state: 'posted', url: clean, already: true };
  // A blog written to the site folder stays written; the founder only tells the desk where it is live.
  const next = r.channel === 'blog' ? r.state : 'posted';
  await store.update('releases', [eq('key', r.key), eq('state', r.state)], { state: next, url: clean, outcome: { ...(r.outcome ?? {}), status: 'published', at: r.outcome?.at ?? stamp, by: 'founder' } });
  let watch = false;
  if (r.channel === 'community' && /reddit\.com/.test(clean)) {
    // A Reddit thread the founder posted joins the replies watch (replies_sync reads its comments).
    const key = `reddit_thread:${input.ref}`;
    const had = await store.one('sources', [eq('key', key)]);
    if (had) await store.update('sources', [eq('key', key)], { url: clean });
    else { try { await store.insert('sources', { key, kind: 'reddit_thread', url: clean }); } catch (e) { if (e.code !== 'conflict') throw e; } }
    watch = true;
  }
  return { ok: true, op: 'confirm', ref: input.ref, channel: r.channel, lang: r.lang, state: next, url: clean, ...(watch ? { watching: true } : {}) };
}

// ---------- reply_done (a comment the founder answered or let go) ----------

async function replyDone(input, { store }) {
  if (!REPLY_REF.test(input.ref ?? '')) fail('invalid_request', 'ref is a reply ref, R-XXXXXXXXXX.');
  const r = await store.one('replies', [eq('ref', input.ref)]);
  if (!r) fail('not_found', `No reply ${input.ref}.`);
  if (['done', 'answered'].includes(r.state)) return { ok: true, op: 'reply_done', ref: input.ref, state: r.state, replayed: true };
  if (r.state !== 'needs_person') fail('conflict', `${input.ref} is ${r.state}, not waiting for the founder.`);
  // A Cần bạn card the dispatcher raised for this comment (an `inc-reply` mark) is settled on its next run, now that the
  // need is gone; a comment nobody raised has no card, so the desk must not say one closes.
  const card = (await store.query('attention', [eq('kind', 'inc-reply'), eq('ref', input.ref)], { limit: 5 }).catch(() => [])).length > 0;
  await store.update('replies', [eq('ref', input.ref), eq('state', 'needs_person')], { state: 'done' });
  await store.remove('attention', [eq('kind', 'reply'), eq('ref', input.ref)]);
  await store.remove('attention', [eq('kind', 'woke-reply'), eq('ref', input.ref)]);
  return { ok: true, op: 'reply_done', ref: input.ref, state: 'done', card_closes: card };
}

// ---------- export (an approved newsletter as files) ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A small Markdown subset (headings, paragraphs, links, bold) as e-mail HTML; everything else is text. */
function mdHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, a, u) => `<a href="${u}">${a}</a>`);
  // A heading is its own line: text right under it (no blank line) is the paragraph that follows.
  const blocks = md.split(/\n{2,}/).flatMap(b => b.trim().split(/\n(?=#{1,3}\s)|(?<=^#{1,3}\s[^\n]*)\n/)).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => {
    const h = /^(#{1,3})\s+(.*)$/.exec(b);
    return h ? `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>` : `<p>${b.split('\n').map(inline).join('<br>')}</p>`;
  }).join('\n');
}
const mdText = (md) => md.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '$1 ($2)').replace(/^#{1,3}\s+/gm, '');

async function exportNewsletter(input, { store, env, now }) {
  if (!ITEM_REF.test(input.ref ?? '')) fail('invalid_request', 'ref is an item ref, MK-XXXXXX.');
  const lr = await libraryRoot(env);
  if (!lr.ok) fail('needs_credential', 'Exporting writes the newsletter files: set MARKETING_ROOT first.');
  const row = await itemRow(store, input.ref);
  const n = row?.meta?.newsletter;
  if (!n) fail('not_found', `${input.ref} is not a newsletter.`);
  const r = (await store.query('releases', [eq('ref', input.ref), eq('channel', 'newsletter')], { limit: 10 })).find(x => ['handoff', 'exported'].includes(x.state));
  if (!r) fail('conflict', `${input.ref} is not approved yet: the newsletter is exported after Duyệt.`);
  if (r.text_hash && n.hash !== r.text_hash) fail('moved', `${input.ref} changed after it was approved; it needs a new approval before export.`);
  let md;
  try { md = (await readText(lr.root, `${row.meta.dir}/${n.file ?? 'newsletter.md'}`)).replace(/^---\n[\s\S]*?\n---\n?/, '').trim(); } catch { fail('not_found', `${row.meta.dir}/newsletter.md is missing; save the newsletter again.`); }
  const base = `${row.meta.product}/newsletter/out/${row.meta.slug}`;
  const html = `<!doctype html>\n<html lang="${n.lang}">\n<head><meta charset="utf-8"><title>${esc(n.subject)}</title></head>\n<body>\n${n.preheader ? `<span style="display:none">${esc(n.preheader)}</span>\n` : ''}<h1>${esc(n.subject)}</h1>\n${mdHtml(md)}\n</body>\n</html>\n`;
  const txt = `${n.subject}\n\n${n.preheader ? `${n.preheader}\n\n` : ''}${mdText(md)}\n`;
  await writeText(lr.root, `${base}.html`, html);
  await writeText(lr.root, `${base}.txt`, txt);
  const files = [`${base}.html`, `${base}.txt`];
  const at = r.outcome?.exported_at ?? new Date(now).toISOString();
  if (r.state !== 'exported') await store.update('releases', [eq('key', r.key), eq('state', r.state)], { state: 'exported', outcome: { ...(r.outcome ?? {}), exported_at: at, files } });
  await putItem(store, row.meta.planned ? null : lr.root, { ...row.meta, newsletter: { ...n, export: { at, files } } }, { now });
  return { ok: true, op: 'export', ref: input.ref, state: 'exported', files, ...(r.state === 'exported' ? { replayed: true } : {}) };
}

// ---------- subscribers (the newsletter's recipient list, pasted on the desk) ----------

// A local part never starts with = + - (a spreadsheet would read the cell as a formula).
const ADDRESS = /^(?![=+\-])[^\s@,;<>"']{1,64}@[^\s@,;<>"'.][^\s@,;<>"']{0,189}\.[A-Za-z]{2,24}$/;
export const SUBSCRIBERS_MAX_CHARS = 100000;
/** subscribers {product, list}: writes <product>/newsletter/subscribers.csv (one address per line, replacing the old
 *  list) and answers only how many: the desk never shows an address back. */
async function subscribers(input, { env }) {
  if (!PRODUCT_ID.test(input.product ?? '')) fail('invalid_request', 'product is a product id.');
  const lr = await libraryRoot(env);
  if (!lr.ok) fail('needs_credential', 'The recipient list is a file in the marketing library: set MARKETING_ROOT first.');
  const products = await loadProducts({ root: lr.root });
  if (!products.some(p => p.id === input.product)) fail('invalid_request', `product "${input.product}" is not in products.json.`);
  if (typeof input.list !== 'string' || input.list.length > SUBSCRIBERS_MAX_CHARS) fail('invalid_request', `list is the pasted addresses, at most ${SUBSCRIBERS_MAX_CHARS} characters.`);
  const seen = new Set();
  let skipped = 0;
  // One line is one person; a CSV row ("Tên,ten@vidu.vn") or "Tên <ten@vidu.vn>" gives its address, a header gives none.
  for (const line of input.list.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const found = line.split(/[\s,;<>"']+/).filter(t => ADDRESS.test(t));
    if (!found.length) { if (!/e-?mail/i.test(line)) skipped++; continue; }
    for (const a of found) seen.add(a.toLowerCase());
  }
  if (!seen.size) fail('no_addresses', 'No e-mail address in the list.');
  await writeText(lr.root, `${input.product}/newsletter/subscribers.csv`, `email\n${[...seen].join('\n')}\n`);
  return { ok: true, op: 'subscribers', product: input.product, count: seen.size, skipped, file: `${input.product}/newsletter/subscribers.csv` };
}

// ---------- setup (a product from the desk) ----------

/** "r/selfhosted, Hacker News, dev.to" as targets. */
function parseTargets(v) {
  if (v === undefined || v === null || v === false) return [];
  if (v === true) return [{ kind: 'hn' }];
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : fail('invalid_request', 'channels.community is a list like "r/selfhosted, Hacker News, dev.to", or true.');
  return parts.map(x => (typeof x === 'object' && x ? x : String(x).trim())).filter(Boolean).slice(0, 10).map(x => {
    if (typeof x === 'object') return x;
    const sub = /^\/?r\/([A-Za-z0-9_]{2,21})$/.exec(x);
    if (sub) return { kind: 'reddit', sub: sub[1] };
    if (/^(hn|hacker ?news|show hn)$/i.test(x)) return { kind: 'hn' };
    if (/^dev\.to$/i.test(x)) return { kind: 'devto' };
    return { kind: 'other', name: x.slice(0, 80) };
  });
}
/** A blog folder the founder named: relative to the library, or an absolute path inside it. */
async function blogDirOf(root, dir) {
  const raw = String(dir ?? '').trim();
  if (!raw || raw.length > 200) fail('bad_dir', 'blog.dir is a folder inside the marketing library.');
  let rel = raw;
  if (isAbsolute(raw)) {
    // The folder may not exist yet: resolve its nearest existing parent (a /var → /private/var link included).
    let head = raw, tail = [];
    for (;;) {
      try { head = await realpath(head); break; } catch { if (dirname(head) === head) break; tail.unshift(basename(head)); head = dirname(head); }
    }
    const r = relative(await realpath(root), join(head, ...tail));
    rel = r && !r.startsWith('..') && !isAbsolute(r) ? r : null;
    if (rel === null) fail('bad_dir', `${raw} is outside the marketing library; pick a folder inside it.`);
  }
  try { segments(rel); } catch { fail('bad_dir', `${raw} is not a folder inside the marketing library.`); }
  return rel.split(sep).join('/').replace(/\/+$/, '');
}

async function setup(input, { store, env, now }) {
  const lr = await libraryRoot(env);
  if (!lr.ok) fail('needs_credential', 'Adding a product writes products.json: set MARKETING_ROOT first.');
  const p = input.product;
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('invalid_request', 'product is {id, name, site?, langs?, about?, blog?, channels?}.');
  if (!PRODUCT_ID.test(p.id ?? '')) fail('invalid_request', 'product.id is lower-case letters, digits and "-" (up to 32).');
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name || name.length > 40) fail('invalid_request', 'product.name is 1 to 40 characters.');
  let site = typeof p.site === 'string' && p.site.trim() ? p.site.trim().replace(/\/+$/, '') : null;
  if (site && !/^https?:\/\//.test(site)) site = `https://${site}`;
  if (site) { try { const u = new URL(site); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('host'); } catch { fail('invalid_request', 'product.site is a domain (acme.dev) or an https:// address.'); } }
  const langs = Array.isArray(p.langs) && p.langs.length ? [...new Set(p.langs)] : ['vi'];
  if (langs.some(l => !['vi', 'en'].includes(l)) || langs.length > 2) fail('invalid_request', 'product.langs is vi and/or en.');
  const about = typeof p.about === 'string' ? p.about.trim() : '';
  if (about.length > 600) fail('invalid_request', 'product.about is at most 600 characters.');
  const blog = p.blog === undefined || p.blog === null ? null : p.blog === 'hub' || p.blog === 'none' ? p.blog : typeof p.blog === 'object' ? { dir: await blogDirOf(lr.root, p.blog.dir) } : fail('invalid_request', 'product.blog is "hub", "none" or {dir}.');
  const ch = p.channels && typeof p.channels === 'object' ? p.channels : {};
  const account = (v, k) => (v === undefined || v === null || v === '' || v === false ? null : typeof v === 'string' && v.trim().length <= 80 ? v.trim() : fail('invalid_request', `channels.${k} is the account name (up to 80 characters).`));
  const accounts = Object.fromEntries(['x', 'facebook', 'tiktok'].map(k => [k, account(ch[k], k)]).filter(([, v]) => v));
  const targets = parseTargets(ch.community).map(t => normalProduct({ id: p.id, targets: [t] }).targets[0]).filter(Boolean);
  if (ch.community && !targets.length) fail('invalid_request', 'channels.community names no place the desk knows (r/<sub>, Hacker News, dev.to, or a name).');
  const entry = { id: p.id, name, ...(site ? { site } : {}), langs, ...(about ? { about } : {}), ...(blog ? { blog } : {}), ...(Object.keys(accounts).length ? { accounts } : {}), ...(targets.length ? { targets } : {}), ...(ch.newsletter === true ? { newsletter: true } : {}) };
  // products.json keeps its shape (a list, or {products: [...]}) and every other entry as it is.
  let raw = { products: [] };
  if (await exists(lr.root, 'products.json')) {
    try { raw = JSON.parse(await readText(lr.root, 'products.json', 64 * 1024)); } catch { fail('conflict', 'products.json is not valid JSON; fix it by hand first.'); }
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.products) ? raw.products : fail('conflict', 'products.json is not a list of products; fix it by hand first.');
  const files = ['products.json', `${p.id}/brand.md`];
  const have = list.find(x => x?.id === p.id);
  if (have) {
    if (JSON.stringify(have) === JSON.stringify(entry)) return { ok: true, op: 'setup', id: p.id, name, files, replayed: true };
    fail('product_exists', `products.json already has ${p.id}; edit it there, or pick another id.`);
  }
  if (list.length >= 12) fail('invalid_request', 'The desk shows at most 12 products.');
  list.push(entry);
  await writeText(lr.root, 'products.json', JSON.stringify(Array.isArray(raw) ? list : { ...raw, products: list }, null, 2) + '\n');
  if (!(await exists(lr.root, `${p.id}/brand.md`))) {
    await writeText(lr.root, `${p.id}/brand.md`, `# ${name}\n\n${about || 'Sản phẩm này làm gì, cho ai.'}\n\n## Giọng\n\n- \n\n## Không nói\n\n- \n`);
  }
  await refreshIndex(store, lr.root, now);
  return { ok: true, op: 'setup', id: p.id, name, files, site };
}

// ---------- mark (radar Onboard?) ----------

async function mark(input, { store, env, now }) {
  const lr = await libraryRoot(env);
  if (!lr.ok) fail('needs_credential', 'Marking a radar row writes the library: set MARKETING_ROOT first.');
  const onboard = input.onboard === undefined ? null : input.onboard;
  const res = await markRadar(lr.root, input.file, input.row, onboard);
  if (res.changed) await refreshIndex(store, lr.root, now);
  return { ok: true, op: 'mark', file: input.file, row: res.row, onboard: res.onboard, changed: res.changed };
}

// ---------- create ----------

const CREATE_CHANNELS = ['blog', 'x', 'facebook', 'tiktok', 'community', 'newsletter'];
const DEFAULT_CHANNELS = { community: ['community'], newsletter: ['newsletter'], launch: ['blog', 'x', 'community'] };
async function create(input, { store, env, now }) {
  const product = input.product;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(product ?? '')) fail('invalid_request', 'product is a product id.');
  if (!FORMATS.has(input.format)) fail('invalid_request', `format is ${[...FORMATS].join(', ')}.`);
  const format = input.format;
  const lr = await libraryRoot(env);
  const products = await loadProducts({ root: lr.ok ? lr.root : null, hubSites: [product] });
  const prod = products.find(p => p.id === product);
  if (!prod) fail('invalid_request', `product "${product}" is not in products.json.`);
  // Where a community post goes: one of the product's targets, or a place the founder names.
  const target = format === 'community' ? targetOf(input.target, prod) ?? prod.targets[0] ?? fail('invalid_request', `target is one of ${product}'s community places, or {kind: "other", name}; ${product} has none yet.`)
    : format === 'launch' ? { id: 'hn', kind: 'hn' } : input.target !== undefined ? fail('invalid_request', 'target belongs to a community item.') : null;
  const SOURCES = { newsletter: ['week', 'topic'], launch: ['changelog', 'paste'] };
  if (input.source !== undefined && !SOURCES[format]?.includes(input.source)) fail('invalid_request', SOURCES[format] ? `source is ${SOURCES[format].join(' or ')}.` : 'source belongs to a newsletter or a launch item.');
  const source = format === 'newsletter' ? input.source ?? 'week' : format === 'launch' ? input.source ?? (prod.changelog ? 'changelog' : 'paste') : null;
  if (format === 'launch' && source === 'changelog' && !prod.changelog) fail('invalid_request', `${product} names no changelog in products.json; paste the release notes (source: "paste").`);
  const notes = typeof input.changelog === 'string' ? input.changelog.trim() : '';
  if (notes.length > 20000) fail('invalid_request', 'changelog is at most 20000 characters.');
  if (format === 'launch' && source === 'paste' && !notes) fail('invalid_request', 'A launch from pasted notes needs changelog (the release notes).');
  const section = format === 'launch' && source === 'changelog' ? await changelogSection(lr.ok ? lr.root : null, prod.changelog) : null;
  if (format === 'launch' && source === 'changelog' && !section) fail('invalid_request', `${prod.changelog} has no release section to read; paste the release notes (source: "paste").`);
  const version = section?.version ?? null;
  // A launch or the week's newsletter can be asked for without a topic: the desk names it.
  let topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (!topic && format === 'launch') topic = `Ra mắt ${prod.name}${version ? ` ${version}` : ''}`;
  if (!topic && format === 'newsletter' && source === 'week') topic = `Bản tin ${isoWeek(now)}`;
  if (!topic || topic.length > 1000) fail('invalid_request', 'topic is 1 to 1000 characters.');
  const asked = Array.isArray(input.channels) ? [...new Set(input.channels)].filter(c => CREATE_CHANNELS.includes(c)).slice(0, 6) : [];
  const channels = asked.length ? asked : DEFAULT_CHANNELS[format] ?? [];
  const series = typeof input.series === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(input.series) ? input.series : null;
  const day = localDay(now, TZ);
  // Keyed on what was asked: the same product, format and topic on the same day is one item.
  const ref = refFor(`create:${product}:${input.format}:${fold(topic)}:${day}`);
  const to = input.format === 'video' ? 'builder' : 'writer';
  const title = topic.split(/\n|:\s/)[0].trim().slice(0, 120);
  let row = await itemRow(store, ref);
  const replayed = !!row;
  if (!row) {
    const slug = slugify(title.split(/\s+/).slice(0, 8).join(' '));
    const meta = { ref, product, format: input.format, slug, day, dir: itemDir(product, day, slug), title, topic, series, want: channels, state: 'asked', to, asked_at: new Date(now).toISOString(), created_at: new Date(now).toISOString(), by: 'desk', langs: [], posts: [],
      ...(target ? { target } : {}), ...(source ? { source_kind: source } : {}), ...(notes || section ? { changelog: notes || section.text } : {}), ...(version ? { version } : {}) };
    row = await putItem(store, lr.ok ? lr.root : null, meta, { now });
  }
  const m = row.meta ?? {};
  const ask_text = askText({ ref, to, format: input.format, product: prod.name, topic, channels, series, target: m.target ?? target, source: m.source_kind ?? source, changelog: m.version ?? null, notes: m.changelog ?? null });
  return { ok: true, op: 'create', ref, to, stage: 'making', state: 'asked', ask_text, channels, ...(target ? { target: { ...target, label: targetLabel(target) } } : {}), ...(replayed ? { replayed: true } : {}), dir: row.meta?.dir ?? null };
}
