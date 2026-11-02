// @ts-check
// Live chat settings page (D6.2): the website chat setup Nest used to build
// in, now this pack's own `settings` page. Plain DOM, no framework, no
// network: every read and write goes through the soot-pages bridge to
// website_view / website_action. Text is set with textContent only.
import { createBridge, applyTheme, randomID } from './bridge.js';
import * as M from './model.js';

/** @typedef {import('./model.js').Site} Site */
/** @typedef {import('./model.js').Config} Config */

const S = {
  t: M.strings('vi'), started: false,
  /** @type {import('./model.js').Overview | null} */ overview: null,
  /** @type {Site | null} */ site: null, /** @type {Config | null} */ draft: null,
  remoteRevision: 0, busy: false, loadError: '',
  /** @type {{ action: string, request_id: string, body: object } | null} */ pending: null,
  /** @type {{ kind: 'info' | 'success' | 'wait', text: string } | null} */ notice: null,
};

const bridge = createBridge({
  post: m => window.parent.postMessage(m, '*'),
  listen: h => window.addEventListener('message', e => h(e.data, e.source)),
  parent: window.parent === window ? undefined : window.parent,
  onInit: init => { applyTheme(init); S.t = M.strings(init.locale); document.documentElement.lang = init.locale; start(); },
  onTheme: msg => applyTheme(msg),
});

const view = async (/** @type {object} */ body) => M.viewOutput(await bridge.call('view', body));
const dirty = () => !!(S.site && S.draft && M.changed(S.draft, S.site.draft));
const locked = () => S.busy || !!S.pending;
const failText = (/** @type {any} */ e) => e?.code === 'busy' ? S.t.busy : S.t.loadFailed;

async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } catch (e) { S.notice = { kind: 'info', text: failText(e) }; } finally { S.busy = false; render(); }
}

async function load(keep = S.site?.id) {
  S.loadError = '';
  try {
    S.overview = M.parseOverview(await view(M.listSites()));
    const id = keep && S.overview.sites.some(s => s.id === keep) ? keep : S.overview.sites[0]?.id;
    if (id) await open(id); else { S.site = null; S.draft = null; }
  } catch (e) { S.loadError = failText(e); }
}
async function open(/** @type {string} */ id) {
  const site = M.parseSite(await view(M.getSite(id)));
  if (!site) throw Object.assign(new Error('not a site'), { code: 'request_rejected' });
  S.site = site; S.draft = structuredClone(site.draft); S.remoteRevision = 0;
}

// ---- writes: one request id per intent, kept until a terminal answer ----
async function write(/** @type {'create' | 'save' | 'publish' | 'pause' | 'resume'} */ action) {
  if (locked()) return;
  const config = action === 'create' ? M.defaultConfig(S.overview?.soots[0] ?? '') : S.draft ?? undefined;
  const id = randomID('lc', 12);
  S.pending = { action, request_id: id, body: M.actionBody(action, id, { site: S.site ?? undefined, config }) };
  S.notice = null;
  await send();
}
async function send() {
  const p = S.pending; if (!p) return;
  S.busy = true; render();
  const c = M.classify(await bridge.call('action', p.body, p.request_id));
  S.busy = false;
  if (c.state === 'unknown' || c.state === 'busy') { S.notice = { kind: 'wait', text: c.state === 'busy' ? S.t.busy : S.t.unknown }; render(); return; }
  S.pending = null;
  if (c.state === 'conflict' || c.state === 'rejected') { S.notice = { kind: 'info', text: M.errorText(S.t, c.code) }; render(); return; }
  S.site = c.site; S.draft = structuredClone(c.site.draft); S.remoteRevision = 0;
  S.notice = { kind: 'success', text: c.replayed ? S.t.replayed : /** @type {any} */ (S.t.done)[p.action] };
  await run(() => load(c.site.id));
}

function edit(/** @type {Partial<Config>} */ patch) {
  if (!S.draft || locked()) return;
  S.draft = { ...S.draft, ...patch }; S.notice = null; render();
}

// A newer revision from chat replaces a clean draft and keeps a dirty one.
async function poll() {
  if (!S.site || S.busy || S.pending) return;
  try {
    const fresh = M.parseSite(await view(M.getSite(S.site.id)));
    if (!fresh || fresh.revision === S.site.revision) return;
    if (dirty()) { S.remoteRevision = fresh.revision; } else { S.site = fresh; S.draft = structuredClone(fresh.draft); }
    render();
  } catch { /* the next manual reload shows a connection error */ }
}

async function copy(/** @type {string} */ text) {
  try { await navigator.clipboard.writeText(text); S.notice = { kind: 'success', text: S.t.copied }; } catch { S.notice = { kind: 'info', text: text }; }
  render();
}

// ---- DOM ----
/** @param {string} tag @param {Record<string, any>} [attrs] @param {(Node | string | false | null | undefined)[]} children */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') /** @type {any} */ (el).value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const button = (/** @type {string} */ label, /** @type {() => void} */ onclick, cls = 'btn', disabled = false, title = '') => h('button', { type: 'button', class: cls, disabled, title: title || undefined, onclick }, label);
let uid = 0;
function field(/** @type {string} */ label, /** @type {HTMLElement} */ control) {
  const id = `f${++uid}`; control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control);
}
function select(/** @type {string} */ value, /** @type {[string, string][]} */ options, /** @type {(v: string) => void} */ onchange, disabled = false) {
  return h('select', { class: 'input', disabled, onchange: (/** @type {Event} */ e) => onchange(/** @type {HTMLSelectElement} */ (e.target).value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}
const textInput = (/** @type {string} */ value, /** @type {(v: string) => void} */ oninput, max = 200) => h('input', { class: 'input', maxlength: max, value, disabled: locked(), oninput: (/** @type {Event} */ e) => oninput(/** @type {HTMLInputElement} */ (e.target).value) });
const area = (/** @type {string} */ value, /** @type {(v: string) => void} */ oninput) => h('textarea', { class: 'input', rows: 3, disabled: locked(), oninput: (/** @type {Event} */ e) => oninput(/** @type {HTMLTextAreaElement} */ (e.target).value) }, value);

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const focused = document.activeElement?.id;
  const out = [h('header', { class: 'head' }, h('h1', {}, t.title), h('p', { class: 'muted' }, t.purpose))];
  if (S.loadError) out.push(h('div', { class: 'notice info', role: 'alert' }, h('p', {}, S.loadError), button(t.check, () => void run(load))));
  else if (!S.overview) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else {
    const creating = S.pending?.action === 'create';
    const bar = h('div', { class: 'row' });
    if (S.site && S.overview.sites.length > 1) bar.append(field(t.site, select(S.site.id, S.overview.sites.map(s => [s.id, s.name]), id => void run(() => open(id)), locked() || dirty())));
    bar.append(button(creating ? t.retryCreate : t.create, () => void (creating ? send() : write('create')), 'btn', S.busy || dirty() || (!!S.pending && !creating)));
    if (S.site) bar.append(button(t.reload, () => void run(() => open(/** @type {Site} */ (S.site).id)), 'btn ghost', locked()));
    out.push(bar);
    if (!S.site) out.push(h('p', { class: 'muted' }, t.none));
  }
  if (S.site && S.draft && S.overview) {
    const site = S.site, d = S.draft, isDirty = dirty(), blocked = locked() || isDirty;
    out.push(h('div', { class: 'row' }, h('p', { class: 'muted grow', role: 'status' }, t.status(site)),
      button(t.publish, () => void write('publish'), 'btn primary', blocked, isDirty ? t.saveFirst : ''),
      button(site.paused ? t.resume : t.pause, () => void write(site.paused ? 'resume' : 'pause'), 'btn ghost', blocked, isDirty ? t.saveFirst : '')));
    if (S.remoteRevision > site.revision) out.push(h('p', { class: 'notice info', role: 'status' }, t.remote));
    out.push(h('section', { class: 'stack', 'aria-label': t.title },
      S.overview.soots.length > 1 && field(t.soot, select(d.soot, S.overview.soots.map(s => [s, s]), v => edit({ soot: v }), locked() || !!site.published)),
      field(t.name, textInput(d.name, v => edit({ name: v }), 64)),
      field(t.greeting, area(d.greeting, v => edit({ greeting: v }))),
      field(t.quick, area(d.quick_replies.join('\n'), v => edit({ quick_replies: M.splitLines(v, M.QUICK_REPLIES) }))),
      field(t.domains, area(d.domains.join('\n'), v => edit({ domains: M.splitLines(v) }))),
      h('div', { class: 'row' },
        field(t.theme, select(d.theme, Object.entries(t.themes), v => edit({ theme: /** @type {Config['theme']} */ (v) }), locked())),
        field(t.position, select(d.position, Object.entries(t.positions), v => edit({ position: /** @type {Config['position']} */ (v) }), locked())))));
    if (isDirty || (S.pending && S.pending.action !== 'create')) out.push(h('div', { class: 'row savebar' },
      button(S.pending ? t.retry : t.save, () => void (S.pending ? send() : write('save')), 'btn primary', S.busy),
      button(t.discard, () => { if (S.pending) return; S.draft = structuredClone(site.draft); S.notice = null; render(); }, 'btn ghost', S.busy || !!S.pending)));
    const snippet = M.embedSnippet(S.overview.publicURL, site.id);
    out.push(h('section', { class: 'stack' }, h('h2', {}, t.embed),
      snippet ? h('p', { class: 'muted' }, t.embedHint) : h('p', { class: 'muted' }, t.noEmbed),
      snippet && h('pre', { class: 'mono', tabindex: 0 }, snippet),
      snippet && button(t.copy, () => void copy(snippet))));
  }
  if (S.busy) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: S.notice.kind === 'success' ? 'status' : 'alert' }, S.notice.text));
  root.replaceChildren(...out);
  if (focused) /** @type {HTMLElement | null} */ (document.getElementById(focused))?.focus();
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
  setInterval(() => void poll(), 5000);
}
