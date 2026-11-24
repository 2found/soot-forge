// An in-memory marketing hub with the semantics the desk relies on (2found.dev
// api, src/modules/hub/use-cases/{cms,social}-tools.ts): revisions move on every
// change, a publish names the reviewed revision and the exact text, X goes
// through a browser poster (social_publish → approved), an unknown outcome is
// `uncertain`. `fetch` is the fetchImpl a tool takes. Failure switches:
//   down    every call fails to connect
//   limited every call is refused with 429 before it runs (the hub's per-client minute budget)
//   lose    a Set of tool names whose call lands at the hub but whose answer is lost
//   calls   every call, in order: [tool, input]
import { createHash } from 'node:crypto';

export const HUB_TOKEN = 't'.repeat(40);
export const hubEnv = (port = 18999) => ({ MARKETING_HUB: JSON.stringify({ service_url: `http://127.0.0.1:${port}/api/hub`, service_token: HUB_TOKEN }) });

export function fakeHub({ clock = () => Date.now(), sites = ['acme', 'beta'], x = { kind: 'browser', handle: 'acmehq', sites: ['acme'] }, facebook = null } = {}) {
  const h = { cms: new Map(), social: new Map(), requests: new Map(), calls: [], down: false, limited: false, lose: new Set(), poster_seen_at: null };
  const iso = () => new Date(clock()).toISOString();
  const refuse = (message) => { const e = new Error(message); e.refused = true; throw e; };
  const key = (site, slug) => `${site}/${slug}`;
  const accounts = (channel) => channel === 'x' && x ? [{ account: `@${x.handle}`, kind: x.kind, sites: x.sites, handle: x.handle }]
    : channel === 'facebook' && facebook ? [{ account: facebook.page_name, kind: facebook.kind ?? 'api', sites: facebook.sites, page_name: facebook.page_name }] : [];
  const view = (p) => ({ id: p.id, channel: p.channel, language: p.language, status: p.status, revision: p.revision, text: p.text, link: p.link, media_note: null, source: p.source, length: `${p.text.length}/280`, updated_at: p.updated_at, published_at: p.published_at, url: p.url, note: p.note, approval_asked_at: null });
  const load = (id, expected) => {
    const p = h.social.get(id);
    if (!p) refuse(`no social post ${id}`);
    if (expected !== undefined && p.revision !== expected) refuse(`${id} is at revision ${p.revision}, not ${expected}`);
    return p;
  };
  const tools = {
    cms_list({ site, limit = 20 }) {
      if (!sites.includes(site)) refuse(`site "${site}" is not open to this Soot`);
      return { site, posts: [...h.cms.values()].filter(p => p.site === site).slice(-limit).reverse().map(p => ({ slug: p.slug, language: p.language, title: p.title, summary: p.summary, status: p.status, live: p.status === 'published', revision: p.revision, author: 'writer', updated_at: p.updated_at, published_at: p.published_at, url: p.status === 'published' ? `https://${site}.example/blog/${p.slug}` : null })) };
    },
    cms_read({ site, slug }) {
      const p = h.cms.get(key(site, slug));
      if (!p) refuse(`no post ${site}/${slug}; save it with expected_revision 0 to create it`);
      return { site, slug, language: p.language, title: p.title, summary: p.summary, body_markdown: p.body_markdown, status: p.status, revision: p.revision, updated_at: p.updated_at, published_at: p.published_at, preview_url: `https://hub.example/preview/${site}/${slug}/${p.revision}` };
    },
    cms_save(input) {
      if (input.status !== 'draft') refuse('cms_save keeps drafts');
      const k = key(input.site, input.slug), cur = h.cms.get(k);
      const prior = h.requests.get(`cms:${input.request_id}`);
      if (prior) return prior;
      if ((cur?.revision ?? 0) !== input.expected_revision) refuse(`revision conflict: ${k} is at revision ${cur?.revision ?? 0}, not ${input.expected_revision}`);
      const p = { site: input.site, slug: input.slug, language: input.language, title: input.title, summary: input.summary, body_markdown: input.body_markdown, status: 'draft', revision: (cur?.revision ?? 0) + 1, updated_at: iso(), published_at: cur?.published_at ?? null };
      h.cms.set(k, p);
      const out = { site: p.site, slug: p.slug, revision: p.revision, status: p.status, preview_url: `https://hub.example/preview/${k}/${p.revision}` };
      h.requests.set(`cms:${input.request_id}`, out);
      return out;
    },
    cms_publish({ site, slug, revision, title, status }) {
      const p = h.cms.get(key(site, slug));
      if (!p) refuse(`no post ${site}/${slug}`);
      if (p.revision !== revision) refuse(`${site}/${slug} is at revision ${p.revision}, not ${revision}`);
      if (p.title !== title) refuse(`title does not match revision ${p.revision}`);
      Object.assign(p, { status, revision: p.revision + 1, published_at: iso(), updated_at: iso() });
      return { site, slug, revision: p.revision, status: p.status, url: `https://${site}.example/blog/${slug}` };
    },
    social_channels() {
      return { sites, channels: ['x', 'facebook', 'tiktok'].map(channel => ({ channel, label: { x: 'X', facebook: 'Facebook', tiktok: 'TikTok' }[channel], max_length: { x: 280, facebook: 5000, tiktok: 2200 }[channel], connected: accounts(channel).length > 0, account: accounts(channel).map(a => a.account).join(', ') || null, accounts: accounts(channel), sites: accounts(channel).length === 1 ? accounts(channel)[0].sites : null, can_queue: true, can_publish: true, can_claim: false, poster_seen_at: channel === 'x' && x?.kind === 'browser' ? h.poster_seen_at : null, how: '' })) };
    },
    social_queue(input) {
      const prior = h.requests.get(`sq:${input.request_id}`);
      if (prior) return { post: view(h.social.get(prior)), duplicate: true };
      const id = 'SP-' + createHash('sha256').update(input.request_id).digest('hex').slice(0, 8).toUpperCase();
      const p = { id, channel: input.channel, language: input.language, text: input.text, link: input.link ?? null, source: input.source ?? null, status: 'draft', revision: 1, updated_at: iso(), published_at: null, url: null, note: null };
      h.social.set(id, p);
      h.requests.set(`sq:${input.request_id}`, id);
      return { post: view(p), duplicate: false };
    },
    social_list({ channel, status, limit = 20 }) {
      return { posts: [...h.social.values()].filter(p => (!channel || p.channel === channel) && (!status || p.status === status)).slice(-limit).reverse().map(view) };
    },
    social_update(input) {
      const p = load(input.id, input.expected_revision);
      const reopening = p.status === 'uncertain' && input.status === 'draft';
      if (!reopening && !['draft', 'approved', 'failed'].includes(p.status)) refuse(`${p.id} is ${p.status}; only draft, approved and failed posts change`);
      Object.assign(p, { text: input.text ?? p.text, link: input.link === undefined ? p.link : input.link, status: input.status ?? 'draft', revision: p.revision + 1, updated_at: iso() });
      return { post: view(p) };
    },
    social_publish(input) {
      const p = load(input.id, input.expected_revision);
      if (input.text.trim() !== p.text.trim() || (input.link ?? null) !== (p.link ?? null) || input.channel !== p.channel) refuse('text, link of the post differ from what you sent');
      if (!['draft', 'failed'].includes(p.status)) refuse(`${p.id} is ${p.status}; only draft and failed posts are published`);
      const acc = accounts(p.channel);
      if (!acc.length) refuse(`${p.channel} is not connected to the hub: nothing was posted`);
      if (acc[0].kind === 'browser') Object.assign(p, { status: 'approved', revision: p.revision + 1, note: 'waiting for the browser poster' });
      else Object.assign(p, { status: 'published', revision: p.revision + 2, url: `https://www.facebook.com/acme/posts/${p.id.slice(3)}`, published_at: iso() });
      return { post: view(p), result: 'ok' };
    },
    social_record({ id, expected_revision, url }) {
      const p = load(id, expected_revision);
      if (['published', 'discarded'].includes(p.status)) refuse(`${p.id} is already ${p.status}`);
      Object.assign(p, { status: 'published', url, revision: p.revision + 1, published_at: iso() });
      return { post: view(p) };
    },
  };
  /** The browser poster: takes the oldest approved X post and posts it (or loses it: uncertain, or signs out: draft). */
  h.poster = (outcome = 'published') => {
    const p = [...h.social.values()].find(q => q.status === 'approved');
    if (!p) return null;
    h.poster_seen_at = iso();
    if (outcome === 'published') Object.assign(p, { status: 'published', revision: p.revision + 2, url: `https://x.com/${x.handle}/status/1${String(h.social.size).padStart(18, '0')}`, published_at: iso() });
    else if (outcome === 'uncertain') Object.assign(p, { status: 'uncertain', revision: p.revision + 1, note: 'the browser closed before X answered' });
    else if (outcome === 'signed_out') Object.assign(p, { status: 'draft', revision: p.revision + 1, note: 'returned to draft: X is signed out on the poster' });
    return p.id;
  };
  h.fetch = async (url, init) => {
    if (h.down) throw new Error('connect ECONNREFUSED');
    if (h.limited) return { status: 429, json: async () => ({ error: 'too_many_requests' }) };
    if (!String(url).endsWith('/v1/tool') || init.headers.Authorization !== `Bearer ${HUB_TOKEN}`) return { status: 401, json: async () => ({}) };
    const env = JSON.parse(init.body);
    const tool = env.operation.replace(/^marketing_/, '');
    h.calls.push([tool, env.input]);
    if (!tools[tool]) return { status: 400, json: async () => ({ error: { code: 'invalid_input', message: `unknown tool ${tool}` } }) };
    let out;
    try { out = structuredClone(tools[tool](env.input)); } catch (e) {
      if (e.refused) return { status: 400, json: async () => ({ error: { code: 'invalid_input', message: e.message } }) };
      throw e;
    }
    if (h.lose.has(tool)) throw new Error('socket hang up');
    return { status: 200, json: async () => out };
  };
  h.count = (tool) => h.calls.filter(c => c[0] === tool).length;
  return h;
}
