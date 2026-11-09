// A local fake of the 2found hub (/api/hub/v1/tool) and the CMS public read API, for the lohi-blog CMS tests.
import { createServer } from 'node:http';

export const TOKEN = 't'.repeat(40);
export const servers = [];

/** A fake hub + CMS. `opts` can break it per test: publisher, sites, failPublish (count), down. */
export async function fakeHub(opts = {}) {
  const st = { posts: new Map(), calls: [], saves: 0, publishes: 0, receipts: new Map(), opts: { publisher: true, sites: ['lohi'], failPublish: 0, ...opts } };
  const server = createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const bad = message => send(400, { error: { code: 'invalid_input', message } });
    const url = new URL(req.url, 'http://x');
    const pub = url.pathname.match(/^\/api\/cms\/v1\/sites\/([a-z0-9-]+)\/posts\/([a-z0-9-]+)$/);
    if (req.method === 'GET' && pub) {
      const p = pub[1] === 'lohi' ? st.posts.get(pub[2]) : null;
      const live = p?.revisions.find(r => r.revision === p.live);
      return live ? send(200, { post: { slug: pub[2], language: live.language, title: live.title, summary: live.summary, bodyMarkdown: live.body_markdown, revision: live.revision, author: 'Lohi' } }) : send(404, { error: 'not_found' });
    }
    if (req.method !== 'POST' || url.pathname !== '/api/hub/v1/tool') return send(404, {});
    let body = '';
    for await (const c of req) body += c;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (req.headers.origin) return send(403, {});
    const call = JSON.parse(body);
    st.calls.push({ hook: call.hook, tool: call.operation.replace(/^marketing_/, ''), soot: call.soot, input: call.input });
    const i = call.input, tool = call.operation.replace(/^marketing_/, '');
    if (!st.opts.sites.includes(i.site)) return bad(`site "${i.site}" is not open to this Soot; its sites are: ${st.opts.sites.join(', ')}`);
    const p = st.posts.get(i.slug);
    const latest = p?.revisions.at(-1);
    if (tool === 'cms_read') {
      if (!latest) return bad(`no post ${i.site}/${i.slug}; save it with expected_revision 0 to create it`);
      return send(200, { site: i.site, slug: i.slug, language: latest.language, title: latest.title, summary: latest.summary, body_markdown: latest.body_markdown, status: p.live === latest.revision ? 'published' : 'draft', revision: latest.revision });
    }
    if (tool === 'cms_save') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(i.request_id)) return bad('request_id must be a UUID');
      const key = i.request_id, prior = st.receipts.get(key);
      if (prior) return JSON.stringify(prior.input) === JSON.stringify(i) ? send(200, { ...prior.out, duplicate: true }) : bad('request_id was already used for a different change');
      if ((latest?.revision ?? 0) !== i.expected_revision) return bad(`revision conflict: ${i.site}/${i.slug} is at revision ${latest?.revision ?? 0}`);
      if (i.status !== 'draft') return bad('cms_save keeps drafts');
      st.saves++;
      const rec = p ?? { revisions: [], live: null };
      rec.revisions.push({ revision: i.expected_revision + 1, title: i.title, summary: i.summary, body_markdown: i.body_markdown, language: i.language });
      st.posts.set(i.slug, rec);
      const out = { site: i.site, slug: i.slug, revision: i.expected_revision + 1, status: 'draft', language: i.language, duplicate: false, url: null };
      st.receipts.set(key, { input: i, out });
      return send(200, out);
    }
    if (tool === 'cms_publish') {
      if (!st.opts.publisher) return bad('only a publisher Soot takes posts live');
      if (!latest) return bad(`no post ${i.site}/${i.slug}`);
      if (call.hook === 'tool.preflight') return send(200, { preview: 'ok' });
      if (latest.revision !== i.revision) return bad(`${i.site}/${i.slug} is at revision ${latest.revision}, not ${i.revision}`);
      if (i.title.trim() !== latest.title.trim()) return bad('title does not match');
      if (st.opts.failPublish > 0) { st.opts.failPublish--; return send(503, {}); }
      st.publishes++;
      p.live = i.status === 'published' ? latest.revision : null;
      return send(200, { site: i.site, slug: i.slug, revision: latest.revision, status: i.status, url: `https://lohi2.com/blog/${i.slug}` });
    }
    return bad('no such tool');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { st, origin, server, hubEnv: JSON.stringify({ service_url: `${origin}/api/hub`, service_token: TOKEN }) };
}

