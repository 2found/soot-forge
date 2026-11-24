// `video_brief` (tool only, no model): the next video to make, as exactly the input of the claude-code pack's start tool
// ({key, title, dir, prompt}) so a schedule chains it: video_brief → claude-code_start → (watch) → marketing_video_import.
// It picks the newest published post of a product that has no video yet on the target channels, at most one brief per
// `every_days` for each product and video channel, and remembers what it briefed in settings.video_brief so a rerun the
// same day answers {done: true}. It never reads the post's page, runs nothing and writes only that one setting.
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fail, eq } from './store.mjs';
import { platformOf, fold } from './guard.mjs';
import { setSetting, getSettings } from './ops.mjs';
import { VIDEO_PLATFORMS } from './video.mjs';
import { libraryRoot, readText, exists } from './root.mjs';
import { loadProducts, tiktokChannelId, SLUG } from './library.mjs';
import { runningTiktok, localDay } from './campaign.mjs';

const DAY = 86_400_000;
const KEEP_MS = 14 * DAY;
/** A brief whose video never came back (no draft carries the source) is offered again after this long. */
const RETRY_MS = 3 * DAY;
const PLATFORM_NAME = { tiktok: 'tiktok', facebook: 'facebook', x: 'x' };
const KEY_MAX = 64;

const dayNum = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
const mmdd = (day) => `${day.slice(5, 7)}${day.slice(8, 10)}`;
/** "Địa ngục cấm nói đời" → "dia-nguc-cam-noi-doi", at most `max` characters, no trailing hyphen. */
const slugOf = (s, max) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');

/** The product a post belongs to: its channel's account part (`blog-lohi`, `x-lohi` → lohi), else the project the team names. */
const productOfPost = (p, project) => /^(?:blog|x|facebook|reddit|tiktok)-([a-z0-9-]+)$/.exec(p.channel ?? '')?.[1] ?? (project ? slugOf(project, 32) : null);

async function fileExists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }

/** The mvf skill's absolute path: MVF_SKILL, else <dir>/2build/skills/marketing-video/SKILL.md, or an error sentence. */
async function skillPath(env, dir) {
  const given = typeof env?.MVF_SKILL === 'string' ? env.MVF_SKILL.trim() : '';
  if (given) {
    if (!isAbsolute(given) || given.includes('\0')) return { error: 'MVF_SKILL must be the absolute path of the 2build marketing-video SKILL.md.' };
    return (await fileExists(given)) ? { path: given } : { error: `MVF_SKILL points at ${given}, which is not a file.` };
  }
  const guess = join(dir, '2build', 'skills', 'marketing-video', 'SKILL.md');
  return (await fileExists(guess)) ? { path: guess } : { error: `MVF_SKILL is not set and ${guess} does not exist: set MVF_SKILL to the absolute path of the 2build marketing-video SKILL.md.` };
}

/** What the product is for, in its own words: the products.json entry's goal or about, then the start of its brand page. */
async function aboutOf(root, id) {
  let entry = null;
  try {
    const raw = JSON.parse(await readText(root, 'products.json', 64 * 1024));
    entry = (Array.isArray(raw) ? raw : raw?.products ?? []).find(p => p?.id === id) ?? null;
  } catch { /* the brand page below may still say */ }
  const lines = [];
  for (const k of ['goal', 'about']) if (typeof entry?.[k] === 'string' && entry[k].trim()) lines.push(entry[k].trim().slice(0, 600));
  let brand = '';
  try { if (await exists(root, `${id}/brand.md`)) brand = (await readText(root, `${id}/brand.md`, 64 * 1024)).trim().slice(0, 1200); } catch { /* none */ }
  return { lines, brand };
}

export async function video_brief(input, { store, now, env }) {
  const product = input.product;
  if (typeof product !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(product)) fail('invalid_request', 'product is a product id.');
  const channels = Array.isArray(input.channels) ? [...new Set(input.channels)] : [];
  if (!channels.length || channels.length > 4 || channels.some(c => typeof c !== 'string' || !/^[a-z0-9-]{1,32}$/.test(c))) fail('invalid_request', 'channels lists 1–4 video channels (tiktok-<account>, x-<account>, facebook-<account>).');
  for (const c of channels) if (!VIDEO_PLATFORMS.includes(platformOf(c))) fail('invalid_request', `${c} is not a video channel (X, Facebook and TikTok accounts take video).`);
  const tiktok = channels.filter(c => platformOf(c) === 'tiktok');
  if (tiktok.length > 1) fail('invalid_request', 'One TikTok account per brief: each account has its own video channel folder and its own series.');
  const every = input.every_days ?? 1;
  if (!Number.isInteger(every) || every < 1 || every > 30) fail('invalid_request', 'every_days is a whole number from 1 to 30.');
  const sourceState = input.source_state ?? 'published';
  if (!['published', 'scheduled', 'ready'].includes(sourceState)) fail('invalid_request', 'source_state is published, scheduled or ready.');

  const lr = await libraryRoot(env ?? {});
  if (!lr.ok) return { ok: false, error: `MARKETING_ROOT is ${lr.error === 'not_configured' ? 'not set' : lr.error}: the video is made in the repository that holds the marketing folder.` };
  const root = lr.root, dir = dirname(root), rootName = basename(root);
  const skill = await skillPath(env, dir);
  if (skill.error) return { ok: false, error: skill.error };

  const prod = (await loadProducts({ root })).find(p => p.id === product);
  if (!prod) return { ok: false, error: `${product} is not in products.json.` };
  // The video channel folder: the TikTok account's own, else the product's first.
  const chRow = tiktok.length ? await store.one('channels', [eq('key', tiktok[0])]) : null;
  const acct = tiktok.length ? (prod.tiktok_accounts ?? []).find(a => tiktokChannelId(a.handle) === tiktok[0]) : null;
  const vc = chRow?.rules?.video_channel ?? acct?.video_channel ?? prod.video_channels[0] ?? null;
  if (!vc || !SLUG.test(vc)) return { ok: false, error: `${product} names no video channel folder (products.json video_channels, or the TikTok channel's rules.video_channel).` };
  if (!(await exists(root, `channels/${vc}`))) return { ok: false, error: `The video channel folder ${rootName}/channels/${vc} does not exist.` };

  // One brief per every_days for each product and video channel.
  const memo = (await store.one('settings', [eq('key', 'video_brief')]))?.value ?? {};
  const last = memo.last ?? {};
  const slot = `${product}/${vc}`;
  const today = localDay(now);
  if (last[slot]?.day && dayNum(today) - dayNum(last[slot].day) < every) return { done: true, reason: 'already_briefed', last: { key: last[slot].key, day: last[slot].day } };

  // The newest published article of the product with no video yet on these channels (and not briefed in the last days).
  const settings = await getSettings(store);
  const sources = (await store.query('posts', [eq('state', sourceState)], { order: 'updated_at', limit: 100 }))
    .filter(p => p.kind === 'article' && (sourceState !== 'published' || p.url) && productOfPost(p, settings.project) === product);
  const made = new Set((await store.query('posts', [eq('kind', 'video')], { order: 'updated_at', limit: 500 }))
    .filter(v => v.parent && channels.includes(v.channel) && v.state !== 'removed').map(v => v.parent));
  const briefed = memo.parents ?? {};
  const source = sources.find(p => !made.has(p.ref) && !(now - Date.parse(briefed[`${p.ref}|${vc}`] ?? '') < RETRY_MS));
  if (!source) return { done: true, reason: sources.length ? 'all_sources_have_videos' : 'no_source' };

  const title = String(source.brief?.title ?? source.title ?? source.ref).replace(/\s+/g, ' ').trim();
  const slug = `${slugOf(title, 40) || 'video'}-${mmdd(today)}`;
  const key = `video-${product}-${slug}`.slice(0, KEY_MAX).replace(/[-._]+$/, '');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) return { ok: false, error: `Could not make a valid key from "${title}".` };
  const request_id = `vb-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  const about = await aboutOf(root, product);
  const running = tiktok.length ? await runningTiktok(store, now) : null;
  const where = `${rootName}/channels/${vc}/campaigns/${slug}`;
  const platforms = [...new Set(channels.map(c => PLATFORM_NAME[platformOf(c)]))];
  const excerpt = String(source.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500);

  const prompt = [
    `Make ONE short vertical Vietnamese video (9x16) for ${prod.name} from the source below, with the 2build marketing-video skill. Run unattended: nobody answers questions, so decide from this brief and the channel's own docs. The video itself is in Vietnamese.`,
    '',
    'SOURCE (a published post of the product)',
    `- Title: ${title}`,
    ...(source.url ? [`- URL: ${source.url}`] : []),
    `- Product: ${prod.name} (${product})${prod.site ? `, ${prod.site}` : ''}`,
    ...about.lines.map(l => `- Product goal: ${l}`),
    '- Goal of the video: make people who like stories want to LISTEN to audio stories on the product, so the viewer opens the app or site and starts an audio story.',
    `- Source post ref (parent): ${source.ref}`,
    ...(excerpt ? [`- Start of the post: ${excerpt}`] : []),
    ...(about.brand ? ['', `BRAND PAGE (${product}/brand.md, start):`, about.brand] : []),
    ...(running ? ['', `RUNNING CAMPAIGN: "${running.campaign.name}". The TikTok caption (caption.txt) ends with this link on its own last line, and nowhere else: ${running.link}`] : []),
    '',
    'HOW TO RUN',
    `1. Read the skill first, by this absolute path, and follow its stages: ${skill.path}`,
    `2. You start in ${dir}, the repository that holds the marketing folder "${rootName}/". Read ${rootName}/channels/${vc}/AGENTS.md and its docs/ first: they answer the brief before you decide anything.`,
    `3. Open the episode: mvf init ${slug} --product "${product}" --channel ${vc} (add --series <name> when the channel's AGENTS.md says which series fits). Expected campaign folder: ${where}/. Work only inside it (and mvf's own library).`,
    `4. The brief answers itself from the source: platforms ${platforms.join(', ')}, language vi, canvas 9x16. State no price, quota, discount or "miễn phí" (the publish guard refuses them), and never invent a chapter number or quote: every fact comes from the source or the channel's docs.`,
    '5. After the Micro Fish pretest has written its decision.json, approve the script yourself: mvf approve <sid> --verdict delegated --note "publish guard + Micro Fish pretest; founder previews on the Marketing desk". Never wait for a person.',
    '6. Loop `mvf next` until 08-delivery/ has the files for every platform above. A FAIL you cannot fix in two tries ends the run.',
    '7. NEVER post, upload, log in or message anything, and never commit or push. Do not change files outside the campaign folder, apart from what mvf itself writes.',
    '',
    'RESULT',
    'When it is done write ONE JSON object to the result file (the path comes at the end of this message), with exactly these keys and no others:',
    `{"request_id": "${request_id}", "campaign": "<the folder that holds campaign.json, relative to ${dir}: find it with ls, do not guess; expected ${where}>", "channels": ${JSON.stringify(channels)}, "parent": "${source.ref}"}`,
    'If the video could not be made, write instead {"ok": false, "error": "<mvf\'s FAIL line, or one sentence on what stopped you>"} and stop.',
  ].join('\n');

  // Remember it only now that there is a brief: a rerun the same day (or inside every_days) answers done.
  const cut = now - KEEP_MS;
  const parents = Object.fromEntries(Object.entries({ ...briefed, [`${source.ref}|${vc}`]: new Date(now).toISOString() }).filter(([, at]) => Date.parse(at) >= cut));
  await setSetting(store, 'video_brief', { last: { ...last, [slot]: { day: today, at: new Date(now).toISOString(), parent: source.ref, key } }, parents });
  return { key, title: `Video: ${title}`.slice(0, 120), dir, prompt };
}
