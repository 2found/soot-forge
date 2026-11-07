// Bài viết and Hàng đợi page models (page_view) and their actions
// (page_action). Page tools are never approval-gated: pages refuse those.
import { fail, eq, gte } from './store.mjs';
import { briefLint } from './guard.mjs';
import { STATE_LABEL, channel, getSettings, schedule, pause, totals } from './ops.mjs';

const DAY = 86_400_000;
export const TABS = {
  all: null,
  draft: ['draft', 'checking'],
  waiting: ['ready', 'scheduled', 'publishing', 'failed', 'uncertain', 'unpublishing'],
  published: ['published'],
  refused: ['refused'],
  removed: ['pulled', 'removed'],
};
const CHANNEL_LABEL = { 'blog-lohi': 'Blog', x: 'X', facebook: 'Facebook', reddit: 'Reddit', hub: 'Hub' };
const channelLabel = key => CHANNEL_LABEL[key] ?? key;
const title = p => p.brief?.title ?? p.title ?? String(p.body ?? '').slice(0, 80);

async function metricsRows(store, now) {
  return store.query('metrics', [eq('source', 'gsc'), gte('day', new Date(now - 30 * DAY).toISOString().slice(0, 10))], { limit: 500 });
}

export async function page_view(input, { store, now, page }) {
  const id = input.page ?? page;
  if (id === 'bai-viet') return input.id ? postDetail(input.id, { store, now }) : postList(input.filter, { store, now });
  if (id === 'hang-doi') return queueView({ store, now });
  fail('invalid_request', 'page is bai-viet or hang-doi.');
}

async function postList(filter = 'all', { store, now }) {
  if (!(filter in TABS)) fail('invalid_request', 'Unknown filter.');
  const [posts, queue, metrics] = await Promise.all([
    store.query('posts', [], { order: 'updated_at', limit: 200 }),
    store.query('queue', [], { order: 'scheduled_at', limit: 200 }),
    metricsRows(store, now),
  ]);
  const counts = Object.fromEntries(Object.entries(TABS).map(([k, states]) => [k, states ? posts.filter(p => states.includes(p.state)).length : posts.length]));
  const q = Object.fromEntries(queue.map(r => [r.post, r]));
  const shown = TABS[filter] ? posts.filter(p => TABS[filter].includes(p.state)) : posts;
  return {
    page: 'bai-viet', filter, counts,
    items: shown.slice(0, 100).map(p => ({
      id: p.ref, title: title(p), channel: channelLabel(p.channel), state: p.state, label: STATE_LABEL[p.state], reason: p.reason, url: p.url,
      scheduled_at: q[p.ref]?.scheduled_at ?? null, wait_reason: q[p.ref]?.wait_reason ?? null, updated_at: p.updated_at,
      metrics_28: p.state === 'published' ? totals(metrics, p.url, 28, now) : null,
    })),
  };
}

async function postDetail(id, { store, now }) {
  const p = await store.one('posts', [eq('ref', id)]);
  if (!p) fail('not_found', `Không có bài ${id}.`);
  const ch = await channel(store, p.channel);
  const [checks, metrics, settings] = await Promise.all([
    store.query('checks', [eq('post', p.ref)], { order: 'at', limit: 1 }),
    metricsRows(store, now),
    getSettings(store),
  ]);
  const lint = briefLint(p, ch);
  const b = p.brief ?? {};
  const fields = p.kind === 'article' ? [
    { field: 'brief.keyword', label: 'Từ khóa', value: b.keyword ?? '' },
    { field: 'title', label: 'Tiêu đề', value: `${[...String(b.title ?? '')].length} ký tự`, rule: '30–60' },
    { field: 'meta', label: 'Mô tả (meta)', value: `${[...String(b.meta ?? '')].length} ký tự`, rule: '120–160' },
    { field: 'slug', label: 'Đường dẫn', value: b.slug ?? '' },
    { field: 'body', label: 'Liên kết nội bộ', value: '', rule: '≥2' },
  ].map(f => ({ ...f, ok: !lint.some(l => l.field === f.field), message: lint.find(l => l.field === f.field)?.message ?? null })) : [];
  const check = checks[0] ?? null;
  const queries = p.url ? metrics.filter(r => r.url === p.url && r.query).sort((a, b) => b.impressions - a.impressions).slice(0, 5).map(r => ({ query: r.query, position: r.position, impressions: r.impressions })) : [];
  return {
    page: 'bai-viet', id: p.ref, post: { id: p.ref, title: title(p), kind: p.kind, channel: channelLabel(p.channel), state: p.state, label: STATE_LABEL[p.state], reason: p.reason, url: p.url, revision: p.revision, body: p.body },
    brief: fields,
    check: check && { verdict: check.verdict, revision: check.revision, at: check.at, current: check.content_hash === p.content_hash, auto: check.auto ?? [], reasons: check.reasons ?? [] },
    search_console: p.state === 'published' ? { last_7: totals(metrics, p.url, 7, now), last_28: totals(metrics, p.url, 28, now), queries, state: settings.gsc?.state ?? null, read_at: settings.gsc?.at ?? null } : null,
  };
}

async function queueView({ store, now }) {
  const settings = await getSettings(store);
  await channel(store, 'blog-lohi');
  const [channels, queue, log] = await Promise.all([
    store.query('channels', [], { limit: 50 }),
    store.query('queue', [], { order: 'scheduled_at', desc: false, limit: 200 }),
    store.query('publish_log', [gte('at', new Date(now - 7 * DAY).toISOString())], { order: 'at', limit: 20 }),
  ]);
  const refs = [...new Set([...queue.map(q => q.post), ...log.map(r => r.post)])];
  const posts = refs.length ? await store.query('posts', [{ column: 'ref', op: 'in', values: refs.slice(0, 100) }], { limit: 200 }) : [];
  const byRef = Object.fromEntries(posts.map(p => [p.ref, p]));
  return {
    page: 'hang-doi',
    paused_all: settings.paused_all, paused_at: settings.paused_at, quiet_hours: settings.quiet_hours,
    channels: channels.map(c => ({ id: c.key, label: channelLabel(c.key), paused: !!c.paused, paused_reason: c.paused_reason ?? null, cap_per_day: c.cap_per_day, spacing_min: c.spacing_min })),
    items: queue.map(q => {
      const p = byRef[q.post] ?? {};
      return { id: q.post, title: title(p), channel: channelLabel(q.channel), action: q.action, scheduled_at: q.scheduled_at, state: p.state ?? null, label: STATE_LABEL[p.state] ?? '', reason: q.wait_reason ?? p.reason ?? null, in_flight: !!q.intent_id };
    }),
    recent: log.filter(r => r.status !== 'intent').slice(0, 10).map(r => ({ id: r.post, title: title(byRef[r.post] ?? {}), channel: channelLabel(r.channel), action: r.action, status: r.status, url: r.url, reason: r.reason, at: r.at })),
    empty: queue.length === 0,
  };
}

export async function page_action(input, deps) {
  const { store } = deps;
  const op = input.op;
  const get = async () => {
    const p = await store.one('posts', [eq('ref', input.id)]);
    if (!p) fail('not_found', `Không có bài ${input.id}.`);
    return p;
  };
  switch (op) {
    case 'pull': {
      const p = await get();
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (q?.intent_id) fail('conflict', 'Bài đang được đăng; chờ xong rồi gỡ.');
      if (!['ready', 'scheduled', 'failed'].includes(p.state)) fail('conflict', `Bài đang ${STATE_LABEL[p.state]}.`);
      if (q) await store.remove('queue', [eq('post', p.ref)]);
      await store.update('posts', [eq('ref', p.ref)], { state: 'pulled', reason: 'Bạn đã kéo bài ra khỏi hàng đợi.' });
      return { id: p.ref, state: 'pulled' };
    }
    case 'restore': return { ...(await schedule({ id: input.id }, deps)), state: 'scheduled' };
    case 'reschedule': {
      if (typeof input.scheduled_at !== 'string') fail('invalid_request', 'scheduled_at is required.');
      return { ...(await schedule({ id: input.id, scheduled_at: input.scheduled_at }, deps)), state: 'scheduled' };
    }
    case 'unpublish': {
      const p = await get();
      if (p.state !== 'published') fail('conflict', 'Chỉ gỡ được bài đã đăng.');
      const q = await store.one('queue', [eq('post', p.ref)]);
      if (!q) await store.insert('queue', { post: p.ref, channel: p.channel, action: 'unpublish', scheduled_at: new Date(deps.now).toISOString(), intent_id: null, intent_at: null, attempts: 0, wait_reason: null });
      return { id: p.ref, state: 'published', unpublish: 'queued' };
    }
    case 'pause': case 'resume':
      return pause({ channel: input.channel, paused: op === 'pause' }, deps);
  }
  fail('invalid_request', 'op is pull, restore, unpublish, reschedule, pause or resume.');
}
