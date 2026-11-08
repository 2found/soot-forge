// @ts-check
// Bài viết and Hàng đợi (marketing pack, flow-marketing). One bundle serves
// both pages: the view tool answers for the page in its context. Plain DOM,
// no network: every read and write goes through the soot-pages bridge.
// Text is set with textContent only.
import { createBridge, applyTheme, randomID } from './bridge.js';
import * as M from './model.js';

const S = {
  t: M.strings('vi'), started: false, busy: false, filter: 'all', id: '',
  /** @type {any} */ data: null, loadError: '',
  /** @type {{ request_id: string, op: string, rest: object } | null} */ pending: null,
  /** @type {{ kind: 'info' | 'success', text: string } | null} */ notice: null,
  /** @type {{ title: string, run: () => void } | null} */ confirm: null,
};

const bridge = createBridge({
  post: m => window.parent.postMessage(m, '*'),
  listen: h => window.addEventListener('message', e => h(e.data, e.source)),
  parent: window.parent === window ? undefined : window.parent,
  onInit: init => { applyTheme(init); S.t = M.strings(init.locale); document.documentElement.lang = init.locale; start(); },
  onTheme: msg => applyTheme(msg),
});

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...any} kids */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return el;
}
const button = (/** @type {string} */ text, /** @type {() => void} */ fn, cls = 'btn sm ghost', more = {}) => h('button', { class: cls, type: 'button', disabled: S.busy, onclick: fn, ...more }, text);
const badge = (/** @type {string} */ text, /** @type {string} */ state) => h('span', { class: `badge ${M.tone(state)}` }, text);

async function load() {
  S.loadError = '';
  try { S.data = M.output(await bridge.call('view', M.viewBody(S.filter, S.id))); } catch (e) { S.loadError = M.errorText(S.t, e); }
}
async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } finally { S.busy = false; render(); }
}
/** A write keeps its request id until an answer comes, so a retry never acts twice. */
async function act(/** @type {string} */ op, rest = {}) {
  S.pending = S.pending?.op === op ? S.pending : { request_id: randomID('mk', 12), op, rest };
  const p = S.pending;
  await run(async () => {
    const r = await bridge.call('action', M.actionBody(p.request_id, p.op, p.rest), p.request_id);
    if (!r.ok && r.error.code === 'no_response') { S.notice = { kind: 'info', text: S.t.unknown }; return; }
    S.pending = null;
    try { M.output(r); S.notice = { kind: 'success', text: S.t.done }; } catch (e) { S.notice = { kind: 'info', text: M.errorText(S.t, e) }; }
    await load();
  });
}

function postList(d) {
  const t = S.t;
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...Object.entries(t.tabs).map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; void run(load); } }, `${label} ${d.counts[k] ?? 0}`)));
  if (!d.items.length) return [tabs, h('div', { class: 'empty' }, h('p', {}, t.noPosts))];
  return [tabs, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ p) => {
    const sub = p.state === 'published' ? `${p.channel} · ${M.metricLine(p.metrics_28, t)}`
      : p.state === 'scheduled' ? `${p.channel} · đăng ${M.when(p.scheduled_at)}${p.wait_reason ? ` · ${p.wait_reason}` : ''}`
      : `${p.channel}${p.reason ? '' : ` · ${p.label}`}`;
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => { S.id = p.id; void run(load); } }, p.title),
        h('small', { class: p.reason && ['refused', 'failed'].includes(p.state) ? 'errline' : 'muted' }, p.reason && ['refused', 'failed'].includes(p.state) ? `${t.refused}: ${p.reason}` : sub)),
      badge(p.label, p.state),
      p.url && button(t.open, () => bridge.open(p.url)),
      p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger'),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })),
      p.state === 'pulled' && button(t.restore, () => void act('restore', { id: p.id })));
  }))];
}

function metrics(sc) {
  const t = S.t;
  const card = h('div', { class: 'card pad stack' }, h('h3', {}, 'Search Console ', h('small', { class: 'muted' }, `${t.days28}${sc?.read_at ? ` · đọc ${M.when(sc.read_at)}` : ''}`)));
  if (!sc) return card;
  if (sc.state === 'needs_person') card.append(h('p', { class: 'warnline' }, t.relogin), h('p', { class: 'muted' }, t.reloginHelp));
  if (!sc.last_28) { card.append(h('p', { class: 'strong' }, t.noData), h('p', { class: 'muted' }, t.noDataHelp)); return card; }
  card.append(h('div', { class: 'kpis' }, ...[[t.impressions, M.num(sc.last_28.impressions)], [t.clicks, M.num(sc.last_28.clicks)], [t.position, M.pos(sc.last_28.position) ?? '—']]
    .map(([k, v]) => h('div', {}, h('small', { class: 'muted' }, k), h('div', { class: 'kpi' }, v)))));
  if (sc.last_7) card.append(h('p', { class: 'muted' }, `${t.days7}: ${M.num(sc.last_7.impressions)} lượt hiển thị · ${M.num(sc.last_7.clicks)} lượt bấm`));
  if (sc.queries.length) card.append(h('p', { class: 'muted' }, `${t.topQueries}: ${sc.queries.map((/** @type {any} */ q) => `"${q.query}" (vị trí ${M.pos(q.position)})`).join(', ')}`));
  return card;
}

function postDetail(d) {
  const t = S.t, p = d.post;
  const head = h('div', { class: 'line wrap' }, h('div', { class: 'line' }, badge(p.label, p.state), h('h2', {}, p.title)),
    h('div', { class: 'line' }, p.url && button(t.open, () => bridge.open(p.url)), p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger')));
  const left = h('div', { class: 'card pad stack' });
  if (p.reason && ['refused', 'failed', 'uncertain'].includes(p.state)) left.append(h('div', { class: 'notice err', role: 'alert' }, h('b', {}, `${t.refused}:`), ' ', p.reason));
  if (d.brief.length) left.append(h('h3', {}, t.brief), h('table', { class: 'table' }, h('tbody', {}, ...d.brief.map((/** @type {any} */ f) =>
    h('tr', {}, h('td', {}, f.label), h('td', {}, f.value), h('td', {}, f.ok ? badge(f.rule ?? 'hợp lệ', 'published') : badge(f.message, 'refused')))))));
  left.append(h('h3', {}, t.editorCheck));
  if (!d.check) left.append(h('p', { class: 'muted' }, t.noCheck));
  else {
    left.append(h('div', { class: 'flow' }, ...d.check.auto.map((/** @type {any} */ a) => h('span', { class: a.ok ? 'chip' : 'chip err' }, a.detail))));
    left.append(h('p', { class: 'muted' }, `Editor · ${M.when(d.check.at)} · bản ${d.check.revision}${d.check.current ? '' : ` · ${t.stale}`}`));
  }
  return [h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { S.id = ''; void run(load); } }, `← ${t.back}`), head, h('div', { class: 'split' }, left, p.state === 'published' ? metrics(d.search_console) : null)];
}

function queue(d) {
  const t = S.t, blog = d.channels.find((/** @type {any} */ c) => c.id === 'blog-lohi') ?? d.channels[0];
  const out = [];
  if (d.paused_all) out.push(h('div', { class: 'notice', role: 'status' }, h('b', {}, t.pausedAll), h('span', {}, `${d.paused_at ? `Bạn dừng lúc ${M.when(d.paused_at)}. ` : ''}${t.pausedHelp}`)));
  out.push(h('div', { class: 'line wrap card pad' },
    h('div', { class: 'line' }, ...d.channels.map((/** @type {any} */ c) => h('span', { class: 'line' }, badge(c.label, c.paused ? 'uncertain' : 'published'),
      button(c.paused ? t.resumeOne : t.pauseOne, () => void act(c.paused ? 'resume' : 'pause', { channel: c.id }))))),
    d.paused_all ? button(t.resumeAll, () => void act('resume'), 'btn sm primary') : button(t.pauseAll, () => void act('pause'), 'btn sm')));
  if (blog) out.push(h('p', { class: 'muted' }, `${blog.label}: ${t.perDay(blog.cap_per_day, Math.round(blog.spacing_min / 60))} · ${t.quiet(d.quiet_hours.from, d.quiet_hours.to)}`));
  // Today's use of each cap: "X 2/4 · Facebook 0/2 (đang dừng: chưa đăng nhập) · trả lời X 3/10".
  const social = d.channels.filter((/** @type {any} */ c) => c.id !== 'blog-lohi' && c.posts_today !== undefined);
  if (social.length) out.push(h('p', { class: 'muted' }, `${t.today}: ${[
    ...social.map((/** @type {any} */ c) => `${c.label} ${c.posts_today}/${c.cap_per_day}${c.paused_label ? ` (${t.pausedAs(c.paused_label)})` : ''}`),
    ...social.filter((/** @type {any} */ c) => c.reply_cap_per_day).map((/** @type {any} */ c) => `${t.replies} ${c.label} ${c.replies_today}/${c.reply_cap_per_day}`),
  ].join(' · ')}`));
  if (d.empty) out.push(h('div', { class: 'empty card pad' }, h('b', {}, t.emptyQueue), h('span', { class: 'muted' }, t.emptyHelp)));
  else out.push(h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ q) => {
    const err = ['failed', 'uncertain'].includes(q.state);
    // A channel the person or a sign-in paused holds its items: say so instead of "Chờ đăng".
    const ch = d.channels.find((/** @type {any} */ c) => c.label === q.channel);
    const held = !q.in_flight && (d.paused_all || ch?.paused);
    const state = held ? (!d.paused_all && ch?.paused_reason === 'signed_out' ? t.waitSignIn : 'Đang dừng') : q.in_flight ? t.inFlight : q.action === 'unpublish' ? 'Chờ gỡ' : q.label;
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('b', {}, `${M.when(q.scheduled_at)} · ${q.channel} · ${q.title}`), q.reason && h('small', { class: err ? 'errline' : 'muted' }, q.reason)),
      badge(state, held ? 'uncertain' : q.state),
      // The person's answers: a late item and an uncertain one are never sent on their own.
      ...(q.state === 'uncertain' ? uncertainActions(t, q)
        : q.late ? [button(t.postNow, () => void act('post_now', { id: q.id })), button(t.restore, () => void act('restore', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))]
        : [!q.in_flight && q.action === 'publish' && button(t.pull, () => void act('pull', { id: q.id }))]));
  })));
  if (d.recent.length) out.push(h('h3', {}, t.recent), h('ul', { class: 'list card' }, ...d.recent.map((/** @type {any} */ r) =>
    h('li', { class: 'row' }, h('div', { class: 'who' }, h('b', {}, `${M.when(r.at)} · ${r.channel} · ${r.url ?? r.title}`), r.reason && h('small', { class: 'errline' }, r.reason)),
      badge(r.status === 'published' ? 'Đã đăng' : r.status === 'removed' ? 'Đã gỡ' : r.status === 'needs_person' ? 'Cần bạn' : 'Lỗi',
        r.status === 'published' ? 'published' : r.status === 'removed' ? '' : r.status === 'needs_person' ? 'uncertain' : 'failed'),
      r.status === 'published' && r.url && button(t.open, () => bridge.open(r.url)),
      r.live && r.action === 'publish' && button(t.unpublish, () => askUnpublish(r), 'btn sm danger')))));
  return out;
}

/** "Không chắc đã đăng chưa": the person looked. Live → paste its link; not live → it may go out again. */
function uncertainActions(/** @type {any} */ t, /** @type {any} */ q) {
  const url = h('input', { type: 'url', class: 'input sm', placeholder: 'https://…', 'aria-label': t.postedUrl, disabled: S.busy });
  return [url, button(t.posted, () => void act('confirm_posted', { id: q.id, url: /** @type {HTMLInputElement} */ (url).value.trim() })),
    button(t.notPosted, () => void act('confirm_not_posted', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))];
}

/** "Gỡ bài trên X?": removing a live post loses its likes and replies, so it asks first; Giữ lại is focused. */
function askUnpublish(/** @type {any} */ p) {
  S.confirm = { title: S.t.unpublishAsk(p.channel), run: () => void act('unpublish', { id: p.id }) };
  render();
  /** @type {HTMLElement | null} */ (document.querySelector('[data-keep]'))?.focus();
}

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const d = S.data;
  const title = d?.page === 'hang-doi' ? t.queue : t.posts;
  const out = [h('header', { class: 'line wrap' }, h('h2', { class: 'page-title' }, title), button(t.reload, () => void run(load), 'btn sm'))];
  if (S.loadError) out.push(h('div', { class: 'notice err', role: 'alert' }, h('p', {}, S.loadError)));
  else if (!d) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (d.page === 'hang-doi') out.push(...queue(d));
  else out.push(...(d.post ? postDetail(d) : postList(d)));
  const c = S.confirm;
  if (c) out.push(h('div', { class: 'notice confirm', role: 'alertdialog', 'aria-label': c.title }, h('b', {}, c.title), h('span', { class: 'muted' }, S.t.unpublishHelp),
    h('span', { class: 'line' }, button(S.t.keep, () => { S.confirm = null; render(); }, 'btn sm', { 'data-keep': '' }),
      button(c.title.replace(/\?$/, ''), () => { S.confirm = null; c.run(); }, 'btn sm danger'))));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: 'status' }, S.notice.text));
  root.replaceChildren(...out);
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
}

// The standalone shell may not send init; start anyway after a short wait.
bridge.ready();
setTimeout(start, 1500);
