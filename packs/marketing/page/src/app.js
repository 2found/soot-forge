// @ts-check
// Bài viết, Hàng đợi and Chiến dịch (marketing pack, flow-marketing). One bundle serves
// the three pages: the view tool answers for the page in its context. Plain DOM,
// no network: every read and write goes through the soot-pages bridge.
// Text is set with textContent only.
import { createBridge, applyTheme, randomID } from './bridge.js';
import * as M from './model.js';

const S = {
  t: M.strings('vi'), started: false, busy: false, filter: 'all', id: '',
  /** @type {any} */ data: null, loadError: '',
  /** @type {{ request_id: string, op: string, rest: object } | null} */ pending: null,
  /** @type {{ kind: 'info' | 'success', text: string } | null} */ notice: null,
  /** @type {{ title: string, yes: string, run: () => void } | null} */ confirm: null,
  caps: false, editing: '',
  campaign: '', /** @type {any} */ sheet: null, sheetError: '',
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
  try { S.data = M.output(await bridge.call('view', M.viewBody(S.filter, S.id, S.campaign))); } catch (e) { S.loadError = M.errorText(S.t, e); }
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
    try { S.notice = M.doneNotice(S.t, op, M.output(r)); } catch (e) { S.notice = { kind: 'info', text: M.errorText(S.t, e) }; }
    await load();
  });
}

/** "Nhờ viết bài": Nest opens a new task for the writer Soot (nest://new). */
function askWriter(/** @type {any} */ d) {
  if (!d.writer) return null;
  return button(S.t.askWrite, () => bridge.open(M.writeLink(d.writer, d.product)), 'btn sm out');
}

function postList(d) {
  const t = S.t;
  const tabs = h('div', { class: 'seg', role: 'tablist' }, ...Object.entries(t.tabs).map(([k, label]) =>
    h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; void run(load); } }, `${label} ${d.counts[k] ?? 0}`)));
  const top = h('div', { class: 'line wrap' }, tabs, askWriter(d));
  if (!d.items.length) return [top, h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, t.noPosts), h('span', {}, t.noPostsHelp))];
  return [top, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ p) => {
    const bad = p.reason && ['refused', 'failed'].includes(p.state);
    const state = p.unpublishing ? 'unpublishing' : p.state;
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => { S.id = p.id; void run(load); } }, p.kind === 'video' ? `Video "${p.title}"` : p.title),
        // A held video draft (#p4-video-failed): the reason, and it stays a draft.
        p.hold ? h('small', { class: p.hold === 'render_failed' ? 'errline' : 'muted' }, p.reason ?? t.stillDraft) :
        h('small', { class: bad ? 'errline' : 'muted' }, bad ? `${t.refused}: ${p.reason.split(' · ')[0]}` : M.postLine(p, t))),
      p.hold ? h('span', { class: `badge ${M.holdTone(p.hold)}` }, p.hold_label) : badge(p.unpublishing ? t.unpublishingLabel : p.label, state),
      p.state === 'refused' && button(t.why, () => { S.id = p.id; void run(load); }),
      p.url && !p.unpublishing && p.state === 'published' && button(`↗ ${t.open}`, () => bridge.open(p.url)),
      p.state === 'published' && !p.unpublishing && button(t.unpublish, () => askUnpublish(p), 'btn sm danger'),
      p.state === 'ready' && button(t.schedule, () => void act('restore', { id: p.id }), 'btn sm'),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })),
      ['pulled', 'removed'].includes(p.state) && button(p.state === 'removed' ? t.republish : t.restore, () => void act('restore', { id: p.id })));
  }))];
}

function metrics(sc) {
  const t = S.t;
  const relogin = sc?.state === 'needs_person';
  const card = h('div', { class: 'card pad stack' }, h('h3', {}, 'Search Console ', sc?.last_28 && h('small', { class: 'muted' }, `${t.days28}${sc.read_at && !relogin ? ` · đọc lúc ${M.when(sc.read_at)}` : ''}`)));
  if (!sc) return card;
  if (relogin) card.append(h('p', { class: 'warnline' }, t.relogin), h('p', { class: 'muted' }, t.reloginHelp));
  if (!sc.last_28) { if (!relogin) card.append(h('p', { class: 'muted' }, t.noDataWhy), h('p', { class: 'muted' }, t.notZero)); return card; }
  card.append(h('div', { class: 'kpis' }, ...[[t.impressions, M.num(sc.last_28.impressions)], [t.clicks, M.num(sc.last_28.clicks)], [t.position, M.pos(sc.last_28.position) ?? '—']]
    .map(([k, v]) => h('div', {}, h('small', { class: 'muted' }, k), h('div', { class: 'kpi' }, v)))));
  if (sc.queries.length) card.append(h('p', { class: 'muted' }, `${t.topQueries}: ${sc.queries.map((/** @type {any} */ q) => `"${q.query}" (vị trí ${M.pos(q.position)})`).join(', ')}`));
  card.append(h('p', { class: 'muted' }, t.radarUses));
  return card;
}

/** A refused post: every failed check on its own line, with its kind, and what happens next. */
function refusedCard(d) {
  const t = S.t, p = d.post;
  const failed = (d.check?.auto ?? []).filter((/** @type {any} */ a) => !a.ok);
  const lines = failed.length ? failed.map((/** @type {any} */ a) => [M.ruleLabel(a.rule), a.detail, a.source])
    : [[t.refusedBy, (d.check?.reasons ?? []).join('; ') || p.reason || '']];
  if (failed.length && d.check?.verdict === 'fail' && d.check.reasons?.length) lines.push([t.refusedBy, d.check.reasons.join('; ')]);
  return h('div', { class: 'card pad stack', role: 'alert' },
    h('div', { class: 'line' }, badge(p.label, p.state), h('b', {}, p.title)),
    h('ul', { class: 'list' }, ...lines.map(([k, v, note]) => h('li', { class: 'row tight' }, badge(k, 'refused'), h('div', { class: 'who' }, h('b', {}, v), note && h('small', { class: 'muted' }, note))))),
    h('p', { class: 'muted' }, t.refusedNext));
}

function postDetail(d) {
  const t = S.t, p = d.post;
  const back = h('button', { class: 'btn sm ghost back', type: 'button', onclick: () => { S.id = ''; void run(load); } }, `← ${t.back}`);
  if (p.state === 'refused') return [back, refusedCard(d)];
  const head = h('div', { class: 'line wrap' }, h('div', { class: 'line' }, badge(p.label, p.state), h('h2', {}, p.title)),
    h('div', { class: 'line' }, p.url && button(`↗ ${t.open}`, () => bridge.open(p.url)),
      p.state === 'ready' && button(t.schedule, () => void act('restore', { id: p.id }), 'btn sm'),
      ['scheduled', 'failed', 'ready'].includes(p.state) && button(t.pull, () => void act('pull', { id: p.id })), p.state === 'published' && button(t.unpublish, () => askUnpublish(p), 'btn sm danger')));
  const left = h('div', { class: 'card pad stack' });
  if (p.reason && ['failed', 'uncertain'].includes(p.state)) left.append(h('p', { class: 'errline', role: 'alert' }, p.reason));
  if (p.body) left.append(h('h3', {}, t.bodyHead), h('div', { class: 'postbody' }, p.body.length > 6000 ? `${p.body.slice(0, 6000)}…` : p.body));
  if (d.brief.length) left.append(h('table', { class: 'table' }, h('tbody', {}, ...d.brief.map((/** @type {any} */ f) =>
    h('tr', {}, h('td', {}, f.label), h('td', {}, f.value), h('td', {}, f.ok ? badge(f.rule ?? 'hợp lệ', 'published') : badge(f.message, 'refused')))))));
  left.append(h('h3', {}, t.editorCheck));
  if (!d.check) left.append(h('p', { class: 'muted' }, t.noCheck));
  else {
    left.append(h('div', { class: 'flow' }, ...d.check.auto.map((/** @type {any} */ a) => h('span', { class: a.ok ? 'chip' : 'chip err' }, a.detail))));
    left.append(h('p', { class: 'muted' }, `Editor · ${M.when(d.check.at)} · bản ${d.check.revision}${d.check.current ? '' : ` · ${t.stale}`}`));
  }
  if (p.hold) left.prepend(h('div', { class: 'notice err', role: 'alert' }, h('b', {}, `${p.hold_label}:`), ' ', p.reason ?? t.stillDraft));
  if (d.video) {
    const v = d.video, hooks = M.hookRows(v.pretest);
    left.append(h('h3', {}, t.videoLine(v.duration_s ?? null, !!v.captions?.length)), h('div', { class: 'line top' },
      v.poster ? h('img', { class: 'poster', src: v.poster, alt: '' }) : null,
      h('div', { class: 'stack' }, ...hooks.map(r => h('span', {}, `${r.score} · ${r.text}${r.chosen ? ` (${t.chosen})` : ''}`)),
        v.open_link ? button(t.watch, () => bridge.open(v.open_link), 'btn sm') : null)));
  }
  return [back, head, h('div', { class: 'split' }, left, p.state === 'published' ? metrics(d.search_console) : null)];
}

/** One on/off switch: on means publishing ("Bật là đang đăng"). */
const toggle = (/** @type {string} */ label, /** @type {boolean} */ on, /** @type {() => void} */ fn) =>
  h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), disabled: S.busy, onclick: fn }, h('i', { 'aria-hidden': 'true' }), label);

function queue(d) {
  const t = S.t, blog = d.channels.find((/** @type {any} */ c) => c.id === 'blog-lohi') ?? d.channels[0];
  const out = [];
  if (d.paused_all) out.push(h('div', { class: 'notice plain', role: 'status' }, h('b', {}, `⏸ ${t.pausedAll}`), h('span', {}, `${d.paused_at ? `Bạn dừng lúc ${M.hm(d.paused_at)}. ` : ''}${t.pausedHelp}`)));
  out.push(h('div', { class: 'card pad bar' },
    h('div', { class: 'line gap' }, toggle(t.pauseAll, !d.paused_all, () => void act(d.paused_all ? 'resume' : 'pause')),
      ...d.channels.map((/** @type {any} */ c) => toggle(c.label, !c.paused, () => void act(c.paused ? 'resume' : 'pause', { channel: c.id })))),
    h('span', { class: 'muted' }, t.switchHint)));
  const social = d.channels.filter((/** @type {any} */ c) => c.id !== 'blog-lohi' && c.posts_today !== undefined);
  if (blog && !social.length && !d.paused_all && !d.empty) out.push(h('p', { class: 'muted line' }, `${blog.label}: ${t.perDay(blog.cap_per_day, Math.round(blog.spacing_min / 60))} · ${t.quiet(d.quiet_hours.from, d.quiet_hours.to)} ·`,
    h('button', { class: 'link small', type: 'button', 'aria-expanded': String(S.caps), onclick: () => { S.caps = !S.caps; render(); } }, t.caps)));
  // Today's use of each cap: "X 2/4 · Facebook 0/2 (đang dừng: chưa đăng nhập) · trả lời X 3/10".
  if (social.length && !d.paused_all) out.push(h('p', { class: 'muted line' }, `${t.today}: ${[
    ...social.map((/** @type {any} */ c) => `${c.label} ${c.posts_today}/${c.cap_per_day}${c.paused_label ? ` (${t.pausedAs(c.paused_label)})` : ''}`),
    ...social.filter((/** @type {any} */ c) => c.reply_cap_per_day && c.replies_today).map((/** @type {any} */ c) => `${t.replies} ${c.label} ${c.replies_today}/${c.reply_cap_per_day}`),
  ].join(' · ')} ·`, h('button', { class: 'link small', type: 'button', 'aria-expanded': String(S.caps), onclick: () => { S.caps = !S.caps; render(); } }, t.caps)));
  if (S.caps) out.push(h('table', { class: 'table card' }, h('thead', {}, h('tr', {}, ...t.capsHead.map((/** @type {string} */ x) => h('th', {}, x)))),
    h('tbody', {}, ...d.channels.map((/** @type {any} */ c) => h('tr', {}, h('td', {}, c.label), h('td', {}, String(c.cap_per_day)), h('td', {}, M.spacing(c.spacing_min)), h('td', {}, c.reply_cap_per_day ? String(c.reply_cap_per_day) : '—'))))));
  if (d.empty) out.push(h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, t.emptyQueue), h('span', {}, t.emptyHelp), askWriter(d)));
  else out.push(h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ q) => queueRow(d, q))));
  if (d.items.some((/** @type {any} */ q) => q.kind === 'video')) out.push(h('p', { class: 'muted' }, t.videoNote));
  if (d.recent.length) out.push(h('h3', {}, t.recent), h('ul', { class: 'list' }, ...d.recent.map((/** @type {any} */ r) =>
    h('li', { class: 'row' }, h('div', { class: 'who' }, h('b', {}, `${M.when(r.at)} · ${r.channel} · ${r.url ? M.shortUrl(r.url) : r.title}`),
      h('small', { class: r.status === 'published' || r.status === 'removed' ? 'muted' : 'errline' }, r.status === 'published' ? (r.action === 'unpublish' ? t.removedDone : t.recorded) : r.status === 'removed' ? t.removedDone : r.reason ?? '')),
      badge(r.status === 'published' ? 'Đã đăng' : r.status === 'removed' ? 'Đã gỡ' : r.status === 'needs_person' ? 'Cần bạn' : 'Lỗi',
        r.status === 'published' ? 'published' : r.status === 'removed' ? '' : r.status === 'needs_person' ? 'uncertain' : 'failed'),
      r.status === 'published' && r.url && button(`↗ ${t.open}`, () => bridge.open(r.url)),
      r.live && r.action === 'publish' && button(t.unpublish, () => askUnpublish(r), 'btn sm danger')))));
  return out;
}

/** A queue item's state label and the person's buttons, shared by every row kind (posts, replies, videos). */
function queueStatus(/** @type {any} */ d, /** @type {any} */ q, /** @type {any} */ pullLabel) {
  const t = S.t;
  // A channel the person or a sign-in paused holds its items: say so instead of "Chờ đăng".
  const ch = d.channels.find((/** @type {any} */ c) => c.label === q.channel);
  const held = !q.in_flight && (d.paused_all || ch?.paused);
  const failed = q.state === 'failed';
  const state = held ? (!d.paused_all && ch?.paused_reason === 'signed_out' ? t.waitSignIn : 'Đang dừng')
    : q.in_flight ? t.inFlight : q.action === 'unpublish' ? 'Chờ gỡ' : failed && !q.retry_at ? 'Lỗi' : q.label;
  // The person's answers: a late item and an uncertain one are never sent on their own.
  const actions = q.state === 'uncertain' ? uncertainActions(t, q)
    : q.late ? [button(t.postNow, () => void act('post_now', { id: q.id })), button(t.restore, () => void act('restore', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))]
    : [failed && q.retry_at && button(t.tryNow, () => void act('post_now', { id: q.id })),
      !q.in_flight && !held && q.action === 'publish' && !failed && rescheduleButton(q),
      !q.in_flight && !d.paused_all && q.action === 'publish' && button(pullLabel, () => void act('pull', { id: q.id }))];
  return { held, failed, state, badge: badge(state, held ? 'uncertain' : q.state), actions };
}

function queueRow(d, q) {
  const t = S.t;
  if (q.kind === 'video') return videoRow(t, q, d);
  const { held, failed, badge: stateBadge, actions } = queueStatus(d, q, t.pull);
  const head = q.action === 'reply' ? `${t.replyTo} · ${q.channel}${q.reply_to ? ` · @${q.reply_to}` : ''}` : `${M.when(q.scheduled_at)} · ${q.channel}`;
  const sub = q.action === 'reply' ? `"${q.title}"` : q.text ? `"${q.text}"${q.has_link ? ` · ${t.hasLink}` : ''}` : q.title;
  const line = failed ? `${t.notYet}: ${q.reason ?? ''}${q.retry_at ? ` ${t.retryAt(M.hm(q.retry_at))}` : ''}`
    : q.state === 'uncertain' ? q.reason ?? '' : d.paused_all && held ? `${sub} — ${t.afterResume}` : sub;
  return h('li', { class: 'row' },
    h('div', { class: 'who' }, h('b', {}, failed || q.state === 'uncertain' ? `${head} · ${q.title}` : head), line && h('small', { class: q.state === 'uncertain' || (failed && !q.retry_at) ? 'errline' : 'muted' }, line),
      !failed && q.state !== 'uncertain' && q.reason && !held && h('small', { class: 'muted' }, q.reason)),
    stateBadge, ...actions);
}

/** "Đổi giờ": an inline time field, saved with reschedule. */
function rescheduleButton(/** @type {any} */ q) {
  const t = S.t;
  if (S.editing !== q.id) return button(t.reschedule, () => { S.editing = q.id; render(); });
  const input = h('input', { type: 'datetime-local', class: 'input sm', 'aria-label': t.reschedule, value: M.localInput(q.scheduled_at) });
  return h('span', { class: 'line' }, input, button(t.save, () => { const v = /** @type {HTMLInputElement} */ (input).value; S.editing = ''; if (v) void act('reschedule', { id: q.id, scheduled_at: M.fromLocalInput(v) }); }, 'btn sm'),
    button(t.cancel, () => { S.editing = ''; render(); }));
}

/** A queued video (#p4-video-queue): poster, what it is, the hook scores, Xem video and Kéo khỏi hàng đợi. */
function videoRow(/** @type {any} */ t, /** @type {any} */ q, /** @type {any} */ d) {
  const v = q.video ?? {};
  const { failed, badge: stateBadge, actions } = queueStatus(d, q, t.pullQueue);
  const hooks = M.hookRows(v.pretest);
  return h('li', { class: 'row top' },
    v.poster ? h('img', { class: 'poster', src: v.poster, alt: '' }) : h('div', { class: 'poster' }),
    h('div', { class: 'who stack' },
      h('b', {}, `${M.when(q.scheduled_at)} · ${q.channel} · ${t.videoLine(v.duration_s ?? null, !!v.captions?.length)}`),
      h('small', { class: 'muted' }, q.source_title ? t.fromPost(q.source_title) : q.title),
      q.reason && h('small', { class: q.state === 'uncertain' || (failed && !q.retry_at) ? 'errline' : 'muted' }, failed ? `${t.notYet}: ${q.reason}${q.retry_at ? ` ${t.retryAt(M.hm(q.retry_at))}` : ''}` : q.reason),
      hooks.length ? h('table', { class: 'table hooks' },
        h('thead', {}, h('tr', {}, h('th', {}, `${t.hooks} (${t.panel(v.pretest?.n ?? null)})`), h('th', { class: 'num' }, t.keepWatching))),
        h('tbody', {}, ...hooks.map(r => h('tr', {}, h('td', {}, r.chosen ? h('b', {}, r.text) : r.text, r.chosen ? ' ' : null, r.chosen ? h('span', { class: 'badge ok' }, t.chosen) : null), h('td', { class: 'num' }, r.score))))) : null,
      h('span', { class: 'line' }, v.open_link && button(t.watch, () => bridge.open(v.open_link), 'btn sm'), ...actions)),
    stateBadge);
}

/** "Không chắc đã đăng chưa": the person looked. Live → paste its link; not live → it may go out again. */
function uncertainActions(/** @type {any} */ t, /** @type {any} */ q) {
  const url = h('input', { type: 'url', class: 'input sm', placeholder: 'https://…', 'aria-label': t.postedUrl, disabled: S.busy });
  return [url, button(t.posted, () => void act('confirm_posted', { id: q.id, url: /** @type {HTMLInputElement} */ (url).value.trim() })),
    button(t.notPosted, () => void act('confirm_not_posted', { id: q.id })), button(t.drop, () => void act('drop', { id: q.id }))];
}

/** "Gỡ bài trên X?": removing a live post loses its likes and replies, so it asks first; Giữ lại is focused. */
function askUnpublish(/** @type {any} */ p) {
  S.confirm = { title: S.t.unpublishAsk(p.channel), yes: S.t.unpublishYes(p.channel), run: () => void act('unpublish', { id: p.id }) };
  render();
  /** @type {HTMLElement | null} */ (document.querySelector('[data-keep]'))?.focus();
}
const closeConfirm = () => { S.confirm = null; render(); };

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const d = S.data;
  const out = [];
  if (S.loadError) out.push(h('div', { class: 'notice err', role: 'alert' }, h('p', {}, S.loadError), button(t.reload, () => void run(load), 'btn sm')));
  else if (!d) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (d.page === 'hang-doi') out.push(...queue(d));
  else if (d.page === 'chien-dich') out.push(...(d.campaign ? campaignDetail(d) : campaignList(d)));
  else out.push(...(d.post ? postDetail(d) : postList(d)));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: 'status' }, S.notice.text));
  if (S.sheet && d?.page === 'chien-dich') out.push(...campaignSheet(d));
  const c = S.confirm;
  if (c) out.push(h('div', { class: 'scrim', onclick: closeConfirm }),
    h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': c.title, onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') closeConfirm(); } },
      h('b', { class: 'dialog-title' }, c.title), h('span', { class: 'muted' }, t.unpublishHelp(c.title)),
      h('div', { class: 'line end' }, button(t.keep, closeConfirm, 'btn out', { 'data-keep': '' }), button(c.yes, () => { S.confirm = null; c.run(); }, 'btn danger'))));
  root.replaceChildren(...out);
}

// ---------- Chiến dịch (#p5-campaigns, #p5-campaign-new, #p5-campaign-detail, #p5-campaign-api-error) ----------

/** A bar fill, sized through CSSOM (the frame's CSP refuses style attributes). @param {number} pct */
const fill = pct => { const i = h('i'); i.style.width = `${pct}%`; return i; };
const openCampaign = (/** @type {string} */ id) => { S.campaign = id; S.notice = null; void run(load); };
const openSheet = (/** @type {any} */ d) => { S.sheet = M.newCampaign(d.choices); S.sheetError = ''; S.pending = null; render(); /** @type {HTMLElement | null} */ (document.getElementById('mk-name'))?.focus(); };
const closeSheet = () => { S.sheet = null; S.sheetError = ''; render(); };

function campaignList(/** @type {any} */ d) {
  const top = h('div', { class: 'line end' }, button('+ Tạo chiến dịch', () => openSheet(d), 'btn primary'));
  if (d.empty) return [top, h('div', { class: 'empty' }, h('span', { class: 'face big', 'aria-hidden': 'true' }), h('b', {}, 'Chưa có chiến dịch'),
    h('span', {}, 'Một chiến dịch gom các bài theo một mục tiêu, có liên kết riêng cho từng kênh để đếm lượt bấm và người đăng ký.'))];
  return [top, h('ul', { class: 'list card' }, ...d.items.map((/** @type {any} */ c) => {
    const pct = M.goalPct(c.goal);
    const line = [M.dayRange(c.starts, c.ends), c.channels.join(', '), c.published ? `${c.published} bài đã đăng` : null].filter(Boolean).join(' · ');
    return h('li', { class: 'row' },
      h('div', { class: 'who' }, h('button', { class: 'link', type: 'button', onclick: () => openCampaign(c.id) }, c.name), h('small', { class: 'muted' }, line),
        c.phase === 'running' && h('div', { class: 'bar2', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct == null ? null : String(pct), 'aria-label': M.goalLine(c.goal) }, fill(pct ?? 0)),
        c.phase === 'running' && h('small', { class: 'muted' }, M.goalLine(c.goal))),
      h('span', { class: `badge ${c.phase === 'running' ? 'ok' : ''}` }, c.phase_label));
  }))];
}

const kpi = (/** @type {string} */ k, /** @type {string} */ v, /** @type {string | null} */ sub) => h('div', { class: 'card pad kpi-card' }, h('small', { class: 'muted' }, k), h('strong', {}, v), sub && h('small', { class: 'muted' }, sub));
const n = (/** @type {number | null} */ v) => (v == null ? '—' : /** @type {string} */ (M.num(v)));

function campaignDetail(/** @type {any} */ d) {
  const c = d.campaign, t = d.totals, product = d.product ?? 'sản phẩm';
  const back = h('button', { class: 'btn sm ghost back', type: 'button', onclick: () => { S.campaign = ''; S.notice = null; void run(load); } }, '← Tất cả chiến dịch');
  const failed = d.read && !d.read.ok;
  const when = d.read?.ok ? `đọc số ${product} lúc ${M.hm(d.read.at)}` : d.read ? null : `chưa đọc số ${product}`;
  const head = h('div', { class: 'line' }, h('b', { class: 'title' }, c.name), h('span', { class: 'muted' }, ['', M.dayRange(c.starts, c.ends), when].filter(x => x !== null).join(' · ')));
  const out = [back];
  if (failed) out.push(h('div', { class: 'notice plain', role: 'alert' }, h('b', {}, `Chưa đọc được số đăng ký từ ${product}`), h('span', {}, M.readFailLine(d.read)),
    h('span', {}, button('↻ Thử lại', () => void act('campaign_refresh', { campaign_id: c.id }), 'btn sm out'))));
  out.push(head);
  const goal = c.goal, of = (/** @type {string} */ m) => (goal.metric === m ? ` / ${M.num(goal.target)}` : '');
  out.push(failed
    ? h('div', { class: 'kpis four' }, kpi('Đã đăng', n(t.published), null), kpi('Tiếp cận', n(t.reach), null), kpi('Lượt bấm', '—', 'chưa rõ'), kpi('Đăng ký', '—', 'chưa rõ'))
    : h('div', { class: 'kpis four' }, kpi(goal.metric === 'published' ? 'Đã đăng / mục tiêu' : 'Đã đăng', n(t.published) + of('published'), 'bài + video'), kpi('Tiếp cận', n(t.reach), 'hiển thị + lượt xem'),
      kpi(goal.metric === 'clicks' ? 'Lượt bấm / mục tiêu' : 'Lượt bấm', n(t.clicks) + of('clicks'), 'qua liên kết chiến dịch'),
      kpi(goal.metric === 'signups' ? 'Đăng ký / mục tiêu' : 'Đăng ký', n(t.signups) + of('signups'), t.first_topups == null ? null : `${M.num(t.first_topups)}${of('first_topups')} người nạp lần đầu`)));
  if (!failed) out.push(h('div', { class: 'card scroll' }, h('table', { class: 'table channels' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Kênh'), ...['Đã đăng', 'Tiếp cận', 'Bấm', 'Đăng ký', 'Nạp lần đầu'].map(x => h('th', { class: 'num' }, x)))),
    h('tbody', {}, ...d.rows.map((/** @type {any} */ r) => h('tr', {}, h('td', {}, r.label), ...[r.published, r.reach, r.clicks, r.signups, r.first_topups].map(v => h('td', { class: 'num' }, n(v)))))))));
  if (d.links_missing.length) out.push(h('div', { class: 'notice plain', role: 'status' }, h('b', {}, `Chưa có liên kết cho ${d.links_missing.join(', ')}`),
    h('span', {}, 'Bài trên kênh này chưa đếm được lượt bấm. Tạo lại khi api trả lời.'),
    h('span', {}, button('Tạo lại liên kết', () => void act('campaign_save', { campaign: { id: c.id, name: c.name, goal: { metric: goal.metric, target: goal.target }, channels: c.channel_ids, starts: M.localInput(c.starts).slice(0, 10), ends: M.localInput(c.ends).slice(0, 10), token_budget: c.token_budget } }), 'btn sm out'))));
  out.push(h('p', { class: 'muted' }, `${M.tokenLine(c.tokens_used, c.token_budget)} Đăng ký tính theo nguồn đầu tiên (utm) khi tạo tài khoản.`));
  return out;
}

/** "Tạo chiến dịch": typing never re-renders (focus stays); only the code, hint and button follow it. */
function syncSheet() {
  const f = S.sheet, problem = M.campaignProblem(f);
  const code = document.getElementById('mk-code'), hint = document.getElementById('mk-hint'), go = /** @type {HTMLButtonElement | null} */ (document.getElementById('mk-create'));
  if (code) code.textContent = `Mã trong liên kết: ${M.slugOf(f.name) || '—'}`;
  if (hint) hint.textContent = S.sheetError || problem || '';
  if (go) go.disabled = S.busy || !!problem;
}
function field(/** @type {string} */ label, /** @type {string} */ id, /** @type {any[]} */ kids, /** @type {any} */ note = null) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), ...kids, note);
}
/** 2000000 → 2.000.000 once the field is left (the sheet keeps reading digits). */
function groupDigits(/** @type {Event} */ e) {
  const el = /** @type {HTMLInputElement} */ (e.target), n = M.digits(el.value);
  if (n != null) { el.value = M.num(n) ?? el.value; S.sheet.budget = el.value; }
}
function textInput(/** @type {string} */ id, /** @type {string} */ key, more = {}) {
  return h('input', { id, class: 'input', value: S.sheet[key], disabled: S.busy, oninput: (/** @type {Event} */ e) => { S.sheet[key] = /** @type {HTMLInputElement} */ (e.target).value; S.sheetError = ''; syncSheet(); }, ...more });
}
function campaignSheet(/** @type {any} */ d) {
  const f = S.sheet, problem = M.campaignProblem(f);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Kênh' }, ...d.choices.map((/** @type {any} */ c) => {
    const on = f.channels.includes(c.id);
    return h('button', { class: 'chip toggle', type: 'button', 'aria-pressed': String(on), disabled: S.busy, onclick: (/** @type {Event} */ e) => {
      f.channels = f.channels.includes(c.id) ? f.channels.filter((/** @type {string} */ x) => x !== c.id) : [...f.channels, c.id];
      const el = /** @type {HTMLElement} */ (e.currentTarget), now = f.channels.includes(c.id);
      el.setAttribute('aria-pressed', String(now)); el.textContent = `${now ? '✓ ' : ''}${c.label}`; syncSheet();
    } }, `${on ? '✓ ' : ''}${c.label}`);
  }));
  const metric = h('select', { id: 'mk-metric', class: 'input', 'aria-label': 'Đơn vị mục tiêu', disabled: S.busy, onchange: (/** @type {Event} */ e) => { f.metric = /** @type {HTMLSelectElement} */ (e.target).value; } },
    ...Object.entries(M.GOAL_FORM).map(([k, v]) => h('option', { value: k, selected: f.metric === k }, v)));
  const body = h('div', { class: 'sheet-body' },
    field('Tên', 'mk-name', [textInput('mk-name', 'name', { maxlength: '120', autocomplete: 'off' })], h('span', { id: 'mk-code', class: 'muted' }, `Mã trong liên kết: ${M.slugOf(f.name) || '—'}`)),
    field('Mục tiêu', 'mk-target', [h('div', { class: 'goal' }, textInput('mk-target', 'target', { inputmode: 'numeric', placeholder: '300' }), metric)]),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Kênh'), chips),
    h('div', { class: 'two' }, field('Từ', 'mk-starts', [textInput('mk-starts', 'starts', { type: 'date' })]), field('Đến', 'mk-ends', [textInput('mk-ends', 'ends', { type: 'date' })])),
    field('Ngân sách token', 'mk-budget', [textInput('mk-budget', 'budget', { inputmode: 'numeric', placeholder: '2.000.000', onchange: groupDigits })],
      h('span', { class: 'muted' }, 'Đầu mối báo bạn khi dùng 80%. Chi tiền (quảng cáo, công cụ trả phí) vẫn do bạn quyết.')),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Liên kết'), h('span', { class: 'muted' }, `Mỗi kênh một liên kết ${d.api_host ? `${d.api_host}/r/…` : 'rút gọn'} gắn UTM, tạo khi lưu.`)));
  return [h('div', { class: 'scrim', onclick: closeSheet }),
    h('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mk-sheet-title', onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') closeSheet(); } },
      h('header', {}, h('h2', { id: 'mk-sheet-title' }, 'Tạo chiến dịch'), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': 'Đóng', onclick: closeSheet }, '✕')),
      body,
      h('footer', {}, h('span', { id: 'mk-hint', class: S.sheetError ? 'errline grow' : 'muted grow', role: 'status' }, S.sheetError || problem || ''),
        button('Hủy', closeSheet, 'btn ghost'), h('button', { id: 'mk-create', class: 'btn primary', type: 'button', disabled: S.busy || !!problem, onclick: () => void saveCampaign() }, 'Tạo chiến dịch')))];
}

/** Create: one request id until an answer comes; then open the new campaign, saying what still needs doing. */
async function saveCampaign() {
  const f = S.sheet;
  if (!f || M.campaignProblem(f)) return;
  S.pending = S.pending?.op === 'campaign_save' ? S.pending : { request_id: randomID('mk', 12), op: 'campaign_save', rest: { campaign: M.campaignBody(f) } };
  const p = S.pending;
  await run(async () => {
    const r = await bridge.call('action', M.actionBody(p.request_id, p.op, p.rest), p.request_id);
    if (!r.ok && r.error.code === 'no_response') { S.sheetError = S.t.unknown; return; }
    S.pending = null;
    let out;
    try { out = M.output(r); } catch (e) { S.sheetError = M.errorText(S.t, e); return; }
    S.sheet = null;
    S.campaign = out.id;
    S.notice = out.links_error ? { kind: 'info', text: `Đã tạo chiến dịch. Chưa tạo được liên kết: ${out.links_error.message}` } : { kind: 'success', text: 'Đã tạo chiến dịch và liên kết cho từng kênh.' };
    await load();
  });
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
}

// The standalone shell may not send init; start anyway after a short wait.
bridge.ready();
setTimeout(start, 1500);
