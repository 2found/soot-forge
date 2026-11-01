// @ts-check
// Kho tài liệu: the data-pool console as a soot-pages page (D2.1). Plain DOM,
// no framework, no network: reads and writes go through the bridge to this
// pack's view/action tools. Parity: docs/nest-interface.md and 2agent
// docs/nest-data-pool.md § Human controls.
import { createBridge, applyTheme, randomID } from './bridge.js';
import * as M from './model.js';
import { strings, docTitle, sourceLine, actorLabel, utf8Bytes, overInlineLimit, readerIds, parseTags } from './text.js';

/** @typedef {{ id: string, name: string, generation: string, policy_revision: number, parent?: string, inherit?: boolean }} Pool */
/** @typedef {{ id: string, title: string, source?: string, tags?: string[], revision: number, updated_at: string, writer?: { kind: string, soot: string } }} Doc */

const storage = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };
const S = {
  t: strings('vi'), locale: 'vi', started: false,
  /** @type {any} */ overview: null, /** @type {Pool[]} */ pools: [], poolNext: '',
  /** @type {any} */ detail: null, /** @type {Doc[]} */ docs: [], docNext: '', searched: '', query: '', searchOffset: 0, paged: false,
  /** @type {Doc | null} */ selected: null, content: '', offset: 0, complete: false,
  /** @type {any} */ draft: null, conflict: false, latestLoaded: false, tab: 'documents',
  /** @type {any[]} */ activity: [], activityNext: '', oldest: 0,
  busy: false, goTo: '', /** @type {{ kind: 'info' | 'success' | 'wait', text: string } | null} */ notice: null, loadError: '',
  /** @type {any} */ pending: null, /** @type {{ text: string, run: () => void } | null} */ confirm: null, creating: false,
};

const bridge = createBridge({
  post: m => window.parent.postMessage(m, '*'),
  listen: h => window.addEventListener('message', e => h(e.data, e.source)),
  parent: window.parent === window ? undefined : window.parent,
  onInit: init => { applyTheme(init); S.locale = init.locale; S.t = strings(init.locale); document.documentElement.lang = init.locale; start(); },
  onTheme: msg => applyTheme(msg),
});

// ---- calls ----
const view = async (/** @type {object} */ body) => M.viewOutput(await bridge.call('view', body));
const organized = () => !!S.overview?.organization_version;
const fail = (/** @type {any} */ e) => e?.code === 'busy' ? { kind: /** @type {const} */ ('wait'), text: S.t.busy } : { kind: /** @type {const} */ ('info'), text: e?.message || S.t.loadFailed };

/** Run one read; the page refuses a second while one is in flight. @param {() => Promise<void>} work */
async function run(work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } catch (e) { S.notice = fail(e); } finally { S.busy = false; render(); }
}

async function load() {
  S.loadError = '';
  try {
    S.overview = await view(M.viewBody('overview'));
    const page = await view(M.listPools(organized()));
    S.pools = page.pools ?? []; S.poolNext = page.next ?? '';
    const keep = S.goTo && S.pools.some(p => p.id === S.goTo) ? S.goTo : S.detail?.pool?.id && S.pools.some(p => p.id === S.detail.pool.id) ? S.detail.pool.id : S.pending?.pool && S.pools.some(p => p.id === S.pending.pool) ? S.pending.pool : S.pools[0]?.id;
    S.goTo = '';
    if (keep) await openPool(keep); else S.detail = null;
  } catch (e) { S.loadError = /** @type {any} */ (e)?.code === 'busy' ? S.t.busy : S.t.loadFailed; S.notice = null; }
}
async function openPool(/** @type {string} */ id) {
  const [detail, docs] = await Promise.all([view(M.poolDetail(id)), view(M.listDocuments(id))]);
  Object.assign(S, { detail, docs: docs.documents ?? [], docNext: docs.next ?? '', searched: '', query: '', searchOffset: 0, paged: false, selected: null, content: '', complete: false });
  if (S.tab === 'activity') await loadActivity();
}
async function browse(after = '', term = S.searched, offset = 0) {
  const id = S.detail.pool.id;
  const data = await view(term ? M.searchDocuments(id, term, offset) : M.listDocuments(id, after));
  Object.assign(S, { docs: data.documents ?? data.hits?.map((/** @type {any} */ h) => h.document) ?? [], docNext: data.next ?? '', searchOffset: data.next_offset ?? 0, searched: term, paged: !!after || offset > 0, selected: null });
}
async function readDoc(/** @type {string} */ id, more = false) {
  const data = await view(M.readDocument(S.detail.pool.id, id, more ? S.offset : 0));
  if (more && S.selected?.revision !== data.document.revision) { S.notice = { kind: 'info', text: S.t.changed }; return; }
  S.selected = data.document; S.content = more ? S.content + data.content : data.content; S.offset = data.next_offset; S.complete = data.complete;
}
async function loadActivity(after = '') {
  const data = await view(M.activity(S.detail.pool.id, after));
  S.activity = data.activity ?? []; S.activityNext = data.next ?? ''; S.oldest = data.oldest_sequence ?? 0;
}

// ---- changes: one request id per intent, kept until a terminal answer ----
/** @param {{ kind: string, input: any }} body */
async function mutate(body) {
  if (S.pending || S.busy) return;
  const p = { request_id: body.input.request_id, kind: body.kind, action: body.input.action, pool: body.input.pool, at: new Date().toISOString(), body, state: 'sending' };
  S.pending = p; S.notice = null; S.conflict = false;
  if (!M.remember(storage, p)) S.notice = { kind: 'info', text: S.t.noStorage };
  await send();
}
async function send() {
  const p = S.pending; if (!p?.body) return;
  S.busy = true; p.state = 'sending'; render();
  const result = await bridge.call('action', p.body, p.request_id);
  S.busy = false;
  await settle(M.classify(result));
}
/** @param {ReturnType<typeof M.classify>} c */
async function settle(c) {
  const p = S.pending; if (!p) return;
  if (c.state === 'unknown' || c.state === 'busy') { p.state = c.state; S.notice = c.state === 'busy' ? { kind: 'wait', text: S.t.busy } : null; render(); return; }
  S.pending = null; M.remember(storage, null);
  if (c.state === 'conflict') { S.conflict = !!S.draft; S.notice = { kind: 'info', text: S.draft ? S.t.conflict : S.t.conflictPool }; render(); return; }
  if (c.state === 'rejected' || c.state === 'failed') { S.notice = { kind: 'info', text: c.state === 'failed' ? S.t.failed : c.message || S.t.failed }; render(); return; }
  const at = c.replayed ? new Date(c.output?.document?.updated_at ?? p.at).toLocaleTimeString(S.locale === 'en' ? 'en-GB' : 'vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
  S.notice = { kind: 'success', text: c.replayed ? S.t.replayed(at) : /** @type {any} */ (S.t.saved)[p.action] || S.t.saved.upsert };
  S.draft = null; S.conflict = false; S.latestLoaded = false; S.selected = null; S.confirm = null; S.creating = false;
  S.goTo = p.action === 'pool_create' ? p.pool : '';
  await run(load);
}
async function checkStatus() {
  const p = S.pending; if (!p || S.busy) return;
  S.busy = true; render();
  try {
    const receipt = await view(M.requestStatus(p.request_id));
    S.busy = false; await settle(M.classify({ ok: true, output: receipt }));
  } catch (e) {
    S.busy = false;
    if (p.recovered) { S.pending = null; M.remember(storage, null); S.notice = { kind: 'info', text: S.t.recoveredMissing }; }
    else S.notice = fail(e);
    render();
  }
}

// ---- drafts ----
function edit(/** @type {'text' | 'url'} */ mode, /** @type {Doc | undefined} */ doc) {
  S.draft = { pool: S.detail.pool.id, id: doc?.id || randomID('doc', 8), title: doc?.title || '', content: doc ? S.content : '', source: doc?.source || '', url: '', tags: doc?.tags?.join(', ') || '', revision: doc?.revision || 0, generation: S.detail.pool.generation, mode };
  S.selected = null; S.notice = null; S.conflict = false; S.latestLoaded = false; S.tab = 'documents';
}
function saveDraft() {
  const d = S.draft;
  return mutate(M.saveDocument({ ...d, tags: parseTags(d.tags), ...(d.mode === 'url' ? { url: d.url } : { url: '' }) }, randomID('kho')));
}
/** The conflict path: read the latest, keep the person's text, save over that revision when they say so. */
async function viewLatest() {
  await run(async () => {
    const data = await view(M.readDocument(S.detail.pool.id, S.draft.id));
    const fresh = await view(M.poolDetail(S.detail.pool.id));
    S.detail = fresh; S.selected = data.document; S.content = data.content; S.complete = data.complete;
    S.draft.revision = data.document.revision; S.draft.generation = fresh.pool.generation; S.latestLoaded = true;
    S.notice = { kind: 'info', text: S.t.latestLoaded };
  });
}
async function copyMine() {
  const text = S.draft?.content ?? '';
  try { await navigator.clipboard.writeText(text); S.notice = { kind: 'success', text: S.t.copied }; }
  catch { /** @type {HTMLTextAreaElement | null} */ (document.querySelector('#d-body'))?.select(); S.notice = { kind: 'info', text: S.t.copyFailed }; }
  render();
}

// ---- rendering ----
/** @param {string} tag @param {Record<string, any>} [props] @param {...any} children */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(4)) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  return el;
}
const btn = (/** @type {string} */ label, /** @type {() => any} */ onclick, cls = '', disabled = false) => h('button', { type: 'button', class: 'btn ' + cls, disabled: disabled || S.busy || undefined, onclick }, label);
// No form element: the frame's sandbox has no allow-forms, so a submit never fires. Enter in a single-line field acts instead.
const onEnter = (/** @type {() => void} */ act) => (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); act(); } };
const later = (/** @type {() => Promise<void>} */ work) => () => void run(work);
const date = (/** @type {string} */ iso, time = false) => { const d = new Date(iso); return isNaN(+d) ? '' : time ? d.toLocaleString(S.locale === 'en' ? 'en-GB' : 'vi-VN') : d.toLocaleDateString(S.locale === 'en' ? 'en-GB' : 'vi-VN'); };
const name = (/** @type {string} */ id) => id;

function noticeView() {
  const t = S.t, p = S.pending, out = [];
  if (p) {
    if (p.recovered) out.push(h('div', { class: 'notice', role: 'status' }, h('span', { class: 'grow' }, t.recovered), btn(t.checkStatus, checkStatus, 'sm')));
    else if (p.state === 'unknown') out.push(h('div', { class: 'notice', role: 'status' }, h('span', { class: 'grow' }, t.unknown), btn(t.checkStatus, checkStatus, 'sm quiet'), btn(t.resend, send, 'sm')));
    else if (p.state === 'busy') out.push(h('div', { class: 'status wait', role: 'status' }, t.busy + ' ', btn(t.retry, send, 'sm')));
    else out.push(h('p', { class: 'muted', role: 'status' }, t.working));
    out.push(h('details', { class: 'support' }, h('summary', {}, t.support), h('p', { class: 'mono' }, `${t.requestID}: ${p.request_id}`)));
  }
  if (S.notice) out.push(h('div', { class: 'notice ' + S.notice.kind, role: S.notice.kind === 'success' ? 'status' : 'alert' }, h('span', { class: 'grow' }, S.notice.text)));
  if (S.confirm) {
    const c = S.confirm;
    out.push(h('div', { class: 'notice confirm', role: 'alertdialog' }, h('span', { class: 'grow' }, c.text), btn(t.cancel, () => { S.confirm = null; render(); }, 'quiet sm'), btn(t.confirmYes, () => { S.confirm = null; c.run(); }, 'danger sm')));
  }
  return out;
}

function headerView() {
  const t = S.t, blocked = !!S.pending;
  const options = S.pools.map(p => h('option', { value: p.id, selected: S.detail?.pool?.id === p.id || undefined }, p.name));
  return h('div', { class: 'row toolbar' },
    S.pools.length ? h('label', { class: 'sr-only', for: 'pool' }, t.chooseCollection) : null,
    S.pools.length ? h('select', { id: 'pool', class: 'input pool', disabled: S.busy || blocked || !!S.draft || undefined, onchange: (/** @type {Event} */ e) => { const id = /** @type {HTMLSelectElement} */ (e.target).value; void run(() => openPool(id)); } }, options) : null,
    S.poolNext ? btn(t.moreCollections, later(async () => { const page = await view(M.listPools(organized(), S.poolNext)); S.pools = [...S.pools, ...(page.pools ?? [])]; S.poolNext = page.next ?? ''; }), 'quiet sm') : null,
    h('span', { class: 'sp' }),
    btn(t.reload, later(load), 'quiet sm', blocked),
    S.overview ? btn(t.newCollection, () => { S.creating = true; render(); document.getElementById('c-name')?.focus(); }, 'sm', blocked) : null);
}

function createView() {
  const t = S.t;
  const submit = () => { const value = /** @type {HTMLInputElement} */ (document.getElementById('c-name')).value.trim(); if (value) void mutate(M.createPool({ pool: randomID('collection', 8), name: value, organized: organized() }, randomID('kho'))); else document.getElementById('c-name')?.focus(); };
  return h('div', { class: 'card stack', role: 'group', 'aria-label': t.newCollection },
    h('div', { class: 'field' }, h('label', { for: 'c-name' }, t.collectionName), h('input', { id: 'c-name', class: 'input', required: true, maxLength: 128, onkeydown: onEnter(submit) })),
    h('div', { class: 'row' }, h('span', { class: 'sp' }), btn(t.cancel, () => { S.creating = false; render(); }, 'quiet'), btn(t.create, submit, 'primary', !!S.pending)));
}

function search() { const q = /** @type {HTMLInputElement} */ (document.getElementById('q')).value.trim(); void run(() => browse('', q)); }
function listView() {
  const t = S.t, d = S.detail;
  return [
    h('div', { class: 'row' },
      h('div', { class: 'row grow', role: 'search' },
        h('label', { class: 'sr-only', for: 'q' }, t.searchLabel), h('input', { id: 'q', class: 'input grow', type: 'search', placeholder: t.searchHint, value: S.searched, onkeydown: onEnter(search) }),
        btn(t.search, search)),
      btn(t.importURL, () => { edit('url'); render(); }, '', !!S.pending), btn(t.addDocument, () => { edit('text'); render(); }, 'primary', !!S.pending)),
    S.searched && S.docs.length ? h('div', { class: 'row' }, h('span', { class: 'muted', role: 'status' }, t.resultsFor(S.docs.length, S.searched)), btn(t.clearSearch, later(() => browse('', '')), 'quiet sm')) : null,
    !S.docs.length ? h('div', { class: 'empty' }, h('b', {}, S.searched ? t.notFound(S.searched) : t.emptyCollection), h('p', { class: 'muted' }, S.searched ? '' : t.emptyHint), S.searched ? btn(t.clearSearch, later(() => browse('', '')), 'sm') : null)
      : h('ul', { class: 'card list', 'aria-label': t.tabDocuments }, S.docs.map(doc => h('li', {}, h('button', { type: 'button', class: 'edge', disabled: S.busy || undefined, onclick: later(() => readDoc(doc.id)) },
          h('b', { class: 'grow' }, docTitle(doc.title, doc.id, t)), h('span', { class: 'who' }, `${actorLabel(doc.writer, name, t)} · ${date(doc.updated_at)}`))))),
    S.paged || S.docNext || S.searchOffset > 0 ? h('div', { class: 'row' }, h('span', { class: 'sp' }), S.paged ? btn(t.firstPage, later(() => browse('', S.searched)), 'sm') : null,
      S.docNext || S.searchOffset > 0 ? btn(t.nextPage, later(() => browse(S.docNext, S.searched, S.searchOffset)), 'sm') : null) : null,
    h('hr', { class: 'rule' }),
    h('div', { class: 'row' }, h('span', { class: 'who grow' }, t.documents(d.documents ?? S.docs.length)),
      btn(t.removeCollection, () => { S.confirm = { text: t.confirmRemovePool(d.pool.name, d.documents ?? 0), run: () => void mutate(M.removePool(d.pool, randomID('kho'))) }; render(); }, 'danger sm', !!S.pending)),
  ];
}

function docView() {
  const t = S.t, doc = /** @type {Doc} */ (S.selected), limit = S.overview?.limits?.inline_content_bytes;
  const tooLong = overInlineLimit(utf8Bytes(S.content), limit);
  return h('article', { class: 'stack doc', 'aria-label': docTitle(doc.title, doc.id, t) },
    h('div', { class: 'row' }, btn('← ' + t.back, () => { S.selected = null; render(); }, 'quiet sm'), h('span', { class: 'sp' }),
      btn(t.edit, () => { edit('text', doc); render(); }, 'sm', !S.complete || tooLong || !!S.pending)),
    h('h2', { tabIndex: -1 }, docTitle(doc.title, doc.id, t)),
    h('p', { class: 'who' }, `${actorLabel(doc.writer, name, t)} · ${date(doc.updated_at)}`),
    h('details', {}, h('summary', {}, t.source), h('p', { class: 'muted' }, sourceLine(doc.source, t)), h('p', { class: 'muted' }, `${date(doc.updated_at, true)} · ${doc.tags?.join(' · ') || t.noTags}`)),
    // Content is shown as source text, never rendered or executed.
    h('pre', { class: 'content' }, S.content),
    !S.complete ? btn(t.readMore, later(() => readDoc(doc.id, true)), 'sm') : null,
    S.complete && tooLong ? h('p', { class: 'muted' }, t.tooLongToEdit) : null,
    h('hr', { class: 'rule' }),
    h('div', { class: 'row' }, h('span', { class: 'who grow' }, t.removeDocHint),
      btn(t.remove, () => { S.confirm = { text: t.confirmRemoveDoc(docTitle(doc.title, doc.id, t)), run: () => void mutate(M.removeDocument({ pool: S.detail.pool.id, generation: S.detail.pool.generation }, doc, randomID('kho'))) }; render(); }, 'danger sm', !!S.pending)));
}

function editorView() {
  const t = S.t, d = S.draft, limit = S.overview?.limits?.inline_content_bytes;
  const tooLong = d.mode === 'text' && overInlineLimit(utf8Bytes(d.content), limit);
  const bind = (/** @type {string} */ key) => (/** @type {Event} */ e) => { d[key] = /** @type {HTMLInputElement} */ (e.target).value; if (d.invalid) { d.invalid = ''; document.querySelectorAll('[data-invalid]').forEach(n => n.setAttribute('hidden', '')); document.querySelectorAll('[aria-invalid]').forEach(n => n.removeAttribute('aria-invalid')); } if (key === 'content') document.getElementById('too-long')?.toggleAttribute('hidden', !(d.mode === 'text' && overInlineLimit(utf8Bytes(d.content), limit))); };
  const submit = () => {
    if (S.busy || S.pending) return;
    const missing = !d.title.trim() ? 'd-title' : d.mode === 'url' ? (!/^https?:\/\/\S+$/i.test(d.url.trim()) ? 'd-url' : '') : (!d.content.trim() ? 'd-body' : '');
    if (missing) { d.invalid = missing; render(); document.getElementById(missing)?.focus(); return; }
    if (!tooLongNow()) void saveDraft();
  };
  const tooLongNow = () => d.mode === 'text' && overInlineLimit(utf8Bytes(d.content), limit);
  const bad = (/** @type {string} */ id) => d.invalid === id ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-err` } : {};
  const err = (/** @type {string} */ id) => h('p', { id: `${id}-err`, class: 'error', 'data-invalid': '', hidden: d.invalid !== id || undefined }, id === 'd-url' && d.url.trim() ? t.urlInvalid : t.fieldNeeded);
  return h('div', { class: 'stack editor', role: 'group', 'aria-label': d.revision ? t.edit : t.addDocument },
    S.conflict && S.latestLoaded && S.selected ? h('div', { class: 'card latest' }, h('b', {}, docTitle(S.selected.title, S.selected.id, t)), h('pre', { class: 'content' }, S.content)) : null,
    h('div', { class: 'field' }, h('label', { for: 'd-title' }, t.fieldTitle), h('input', { id: 'd-title', class: 'input', required: true, maxLength: 256, value: d.title, oninput: bind('title'), ...bad('d-title') }), err('d-title')),
    d.mode === 'url'
      ? h('div', { class: 'field' }, h('label', { for: 'd-url' }, t.fieldURL), h('input', { id: 'd-url', class: 'input', type: 'url', required: true, value: d.url, oninput: bind('url'), ...bad('d-url') }), err('d-url'), h('p', { class: 'muted' }, t.urlHint))
      : h('div', { class: 'field' }, h('label', { for: 'd-body' }, S.conflict ? t.yourVersion : t.fieldBody), h('textarea', { id: 'd-body', class: 'input', rows: 10, required: true, value: d.content, oninput: bind('content'), ...bad('d-body') }), err('d-body'),
          h('p', { id: 'too-long', class: 'error', hidden: !tooLong || undefined }, t.tooLong)),
    h('div', { class: 'field' }, h('label', { for: 'd-tags' }, t.fieldTags), h('input', { id: 'd-tags', class: 'input', value: d.tags, oninput: bind('tags') }), h('p', { class: 'muted' }, t.tagsHint)),
    d.mode === 'text' ? h('details', {}, h('summary', {}, t.source), h('div', { class: 'field' }, h('label', { for: 'd-source' }, t.fieldSource), h('input', { id: 'd-source', class: 'input', value: d.source, oninput: bind('source') }))) : null,
    S.conflict
      ? h('div', { class: 'row' }, btn(t.viewLatest, viewLatest), h('span', { class: 'sp' }), btn(t.copyMine, copyMine), btn(t.overwrite, submit, 'primary', !!S.pending || !S.latestLoaded))
      : h('div', { class: 'row' }, h('span', { class: 'who' }, t.editing(d.revision)), h('span', { class: 'sp' }),
          btn(t.cancel, () => { S.draft = null; S.notice = null; render(); }, 'quiet', !!S.pending),
          btn(t.save, submit, 'primary', !!S.pending)));
}

function grantsView() {
  const t = S.t, d = S.detail, managers = new Set(d.host_managers ?? []);
  const rows = [...new Set([...(d.host_managers ?? []), ...(d.bound_soots ?? [])])];
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, t.grantsIntro), h('p', { class: 'who' }, t.readers(readerIds(d).map(name))),
    h('div', { class: 'card tbl' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, t.grantSoot), h('th', {}, t.grantLevel), h('th', {}))),
      h('tbody', {}, rows.map(id => h('tr', {}, h('td', {}, h('b', {}, name(id))),
        h('td', {}, managers.has(id) ? t.hostManager : /** @type {any} */ (t.levels)[d.effective_permissions?.[id] ?? d.grants?.[id] ?? ''] ?? t.levels['']),
        h('td', { class: 'who' }, managers.has(id) ? '' : t.changeAt)))))));
}

function activityView() {
  const t = S.t;
  return h('div', { class: 'stack' }, h('p', { class: 'muted' }, t.activityIntro(S.overview?.limits?.activity_retention ?? 0)),
    !S.activity.length ? h('p', { class: 'muted' }, t.noActivity)
      : h('ul', { class: 'card list' }, S.activity.map(a => h('li', { class: 'edge' }, h('b', { class: 'grow' }, `${/** @type {any} */ (t.events)[a.action] || a.action} · ${/** @type {any} */ (t.statuses)[a.status] || a.status}`), h('span', { class: 'who' }, `${actorLabel(a.actor, name, t)} · ${date(a.at, true)}`)))),
    h('div', { class: 'row' }, btn(t.newest, later(() => loadActivity()), 'sm'), S.activityNext ? btn(t.older, later(() => loadActivity(S.activityNext)), 'sm') : null),
    S.oldest > 1 ? h('p', { class: 'muted' }, t.expired) : null);
}

function tabsView() {
  const t = S.t, tabs = /** @type {const} */ ([['documents', t.tabDocuments], ['grants', t.tabGrants], ['activity', t.tabActivity]]);
  return h('div', { class: 'tabs', role: 'tablist', 'aria-label': t.collection }, tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(S.tab === id), disabled: !!S.draft || !!S.pending || undefined,
    onclick: () => { S.tab = id; if (id === 'activity') void run(() => loadActivity()); else render(); } }, label)));
}

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const focus = document.activeElement?.id;
  const body = [];
  if (!S.started || (S.busy && !S.overview && !S.loadError)) body.push(h('div', { class: 'stack', 'aria-hidden': 'true' }, h('div', { class: 'skel w60' }), h('div', { class: 'skel w85' }), h('div', { class: 'skel w40' })), h('p', { class: 'sr-only', role: 'status' }, t.loading));
  else if (S.loadError) body.push(h('div', { class: S.loadError === t.busy ? 'status wait' : 'notice', role: 'alert' }, S.loadError + ' ', btn(t.retry, later(load), 'sm')));
  else {
    body.push(headerView(), ...noticeView());
    if (S.creating) body.push(createView());
    if (!S.pools.length && !S.creating) body.push(h('div', { class: 'empty' }, h('b', {}, t.noCollections), h('p', { class: 'muted' }, t.noCollectionsHint)));
    if (S.detail) {
      body.push(h('div', { class: 'row' }, h('h2', { class: 'grow' }, S.detail.pool.name)), tabsView());
      if (S.tab === 'grants') body.push(grantsView());
      else if (S.tab === 'activity') body.push(activityView());
      else body.push(S.draft ? editorView() : S.selected ? docView() : listView());
    }
    if (S.busy) body.push(h('p', { class: 'sr-only', role: 'status' }, t.working));
  }
  root.replaceChildren(h('header', { class: 'head' }, h('h1', {}, t.title), h('p', { class: 'muted' }, t.intro)), ...body.flat(4).filter(Boolean));
  if (focus) document.getElementById(focus)?.focus();
}

function start() {
  if (S.started) return;
  S.started = true;
  const saved = M.recall(storage);
  if (saved) S.pending = { ...saved, recovered: true, state: 'unknown' };
  void run(load);
}

// A page opened outside a host (or a host that never sends init) still starts, in Vietnamese.
window.addEventListener('beforeunload', e => { if (S.draft || S.pending?.body) e.preventDefault(); });
render();
bridge.ready();
setTimeout(start, 1500);
