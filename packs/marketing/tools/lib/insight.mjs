// What worked (friction r2): the performance of the published blog posts, from the numbers the pack
// already keeps, so the plan chooses the next topic from evidence and the daily report can name it.
//   1. Search Console clicks and impressions of the post's page (when the Google sign-in gave them);
//   2. else the campaign numbers (UTM clicks, sign-ups) of the campaign a post is in;
//   3. else nothing: the basis is 'none' and the plan keeps its plain rotation.
// Without Search Console or a campaign nothing is read (`read: false`): then no post is a loser.
import { eq, gte } from './store.mjs';
import { fold } from './guard.mjs';

const DAY = 86_400_000;
const WINDOW_DAYS = 28;
/** A post younger than this has not had time to be indexed: it is neither a winner nor a loser yet. */
export const MATURE_DAYS = 7;

const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

/** The blog posts that went out, newest first, with the numbers behind them. */
export async function performance(store, chKey, now) {
  const posts = (await store.query('posts', [eq('channel', chKey), eq('state', 'published')], { order: 'updated_at', limit: 100 })).filter(p => p.kind === 'article' && p.url);
  const since = new Date(now - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const rows = await store.query('metrics', [eq('source', 'gsc'), gte('day', since), eq('query', '')], { limit: 1000 });
  const byUrl = new Map();
  for (const r of rows) {
    const a = byUrl.get(r.url) ?? { clicks: 0, impressions: 0 };
    a.clicks += r.clicks ?? 0; a.impressions += r.impressions ?? 0;
    byUrl.set(r.url, a);
  }
  const campaigns = await store.query('campaigns', [], { limit: 100 });
  const camp = new Map();
  for (const c of campaigns) {
    if (!c.report?.ok) continue;
    const clicks = c.report.clicks.filter(x => x.channel === 'blog').reduce((s, x) => s + x.clicks, 0);
    const signups = c.report.signups.filter(x => x.source === 'blog').reduce((s, x) => s + x.registrations, 0);
    camp.set(c.key, { clicks, signups, leads: c.leads ?? 0 });
  }
  const inCampaign = new Map();
  for (const p of posts) if (p.campaign && camp.has(p.campaign)) inCampaign.set(p.campaign, (inCampaign.get(p.campaign) ?? 0) + 1);
  const hasGsc = posts.some(p => byUrl.has(p.url));
  const hasUtm = !hasGsc && [...camp.values()].some(c => c.clicks + c.signups > 0);
  const out = posts.map(p => {
    const g = byUrl.get(p.url);
    const c = p.campaign ? camp.get(p.campaign) : null;
    const share = c ? 1 / (inCampaign.get(p.campaign) || 1) : 0;
    const clicks = hasGsc ? (g?.clicks ?? 0) : hasUtm ? (c ? Math.round(c.clicks * share) : null) : null;
    const signups = hasUtm && c ? Math.round(c.signups * share) : null;
    const impressions = hasGsc ? (g?.impressions ?? 0) : null;
    const age_d = Math.floor((now - Date.parse(p.updated_at ?? 0)) / DAY);
    return {
      ref: p.ref, title: short(p.brief?.title ?? p.title, 70), keyword: p.brief?.keyword ?? '', url: p.url, age_d,
      clicks, impressions, signups,
      // Clicks matter most, then sign-ups, then being seen at all.
      score: (clicks ?? 0) + 5 * (signups ?? 0) + (impressions ?? 0) / 50,
      // Search Console lists only pages that were shown: once it answers at all, a page it omits was shown 0 times.
      read: hasGsc ? true : hasUtm ? c != null : false,
    };
  });
  return { basis: hasGsc ? 'gsc' : hasUtm ? 'utm' : 'none', posts: out };
}

const ANGLE = kw => (/\bmới\b/.test(kw) ? 'new' : /\bfull\b/.test(kw) ? 'full' : 'hay');

/** Which genre and angle each post was about (the plan's own keywords carry both). */
export function classify(post, genres) {
  const kw = fold(post.keyword || post.title);
  const genre = genres.find(g => kw.includes(fold(g))) ?? null;
  return { genre, angle: ANGLE(String(post.keyword).toLowerCase()) };
}

/**
 * A value for a (genre, angle) candidate. Winners rank above never-tried, never-tried above
 * known losers. A loser is a genre written at least twice, each post read and mature, with no
 * clicks, impressions or sign-ups: the plan stops repeating it while anything else is left.
 */
export function rank(perf, genres) {
  const tagged = perf.posts.map(p => ({ ...p, ...classify(p, genres) }));
  const mature = tagged.filter(p => p.read && p.age_d >= MATURE_DAYS);
  const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const winnersMean = mean(tagged.filter(p => p.score > 0).map(p => p.score)) ?? 0;
  const losers = new Set();
  if (perf.basis !== 'none') {
    for (const g of genres) {
      const ps = mature.filter(p => p.genre === g);
      if (ps.length >= 2 && ps.every(p => p.score === 0)) losers.add(g);
    }
  }
  const value = (genre, angle) => {
    if (perf.basis === 'none') return 0;
    if (losers.has(genre)) return -1;
    const g = mature.filter(p => p.genre === genre), a = mature.filter(p => p.angle === angle);
    const gv = mean(g.map(p => p.score)), av = mean(a.map(p => p.score));
    if (gv === null && av === null) return winnersMean * 0.5; // never tried: worth a look, below a proven winner
    return (gv ?? winnersMean * 0.5) + 0.5 * (av ?? winnersMean * 0.5);
  };
  return { value, losers: [...losers], tagged };
}

/** The top posts for the daily report: published, read, best first. */
export const topPosts = (perf, n = 3) => perf.posts.filter(p => p.read && p.score > 0).sort((a, b) => b.score - a.score).slice(0, n);
