// @ts-check
// Khách hàng rail page (cs-console). Plain DOM, no framework, no network:
// every read and write goes through the soot-pages bridge to console_view /
// console_action. Text is set with textContent only.
import { createBridge, applyTheme, randomID } from './bridge.js';
import * as M from './model.js';

const S = {
  t: M.strings('vi'), started: false, busy: false, loadError: '', missing: false, q: '', tagDraft: '', noteDraft: '', proofDraft: '',
  /** @type {M.Row[] | null} */ rows: null, linkProofs: false, next: '', truncated: false,
  /** @type {string} */ selected: '',
  /** @type {M.Detail | null} */ detail: null,
  /** @type {{ request_id: string, body: object } | null} */ pending: null,
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

async function run(/** @type {() => Promise<void>} */ work) {
  if (S.busy) return;
  S.busy = true; render();
  try { await work(); } catch (e) { S.notice = { kind: 'info', text: M.errorText(S.t, /** @type {any} */ (e)?.code, /** @type {any} */ (e)?.message) }; } finally { S.busy = false; render(); }
}

async function load() {
  S.loadError = ''; S.missing = false;
  try {
    const out = await view(M.listBody(S.q));
    S.rows = out.customers ?? []; S.linkProofs = !!out.link_proofs; S.next = out.next ?? ''; S.truncated = !!out.truncated;
    const keep = S.rows?.find(r => r.key === S.selected)?.key ?? S.rows?.[0]?.key ?? '';
    if (keep) await open(keep); else { S.selected = ''; S.detail = null; }
  } catch (e) {
    const code = /** @type {any} */ (e)?.code;
    // N11: one message and one retry per fault. A key Nest reports is Nest's notice (with Mở Thiết lập); the page keeps only its Tải lại.
    S.loadError = code === M.SAID_BY_NEST ? '' : M.errorText(S.t, code); S.rows = code === M.SAID_BY_NEST ? [] : S.rows; S.missing = code === M.SAID_BY_NEST;
  }
}
async function more() {
  const out = await view(M.listBody(S.q, S.next));
  S.rows = M.mergeRows(S.rows ?? [], out.customers ?? []); S.next = out.next ?? ''; S.truncated = !!out.truncated;
}
async function open(/** @type {string} */ key) {
  S.selected = key;
  S.detail = await view(M.detailBody(key));
}

// ---- writes: one request id per intent, kept until a terminal answer ----
async function write(/** @type {object} */ body) {
  if (S.busy || S.pending) return;
  const id = randomID('cs', 12);
  S.pending = { request_id: id, body: M.actionBody(id, /** @type {any} */ (body)) };
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
  if (c.state === 'rejected') { S.notice = { kind: 'info', text: M.errorText(S.t, c.code, c.message) }; render(); return; }
  S.notice = { kind: 'success', text: c.replayed ? S.t.replayed : S.t.done };
  S.tagDraft = ''; S.noteDraft = ''; S.proofDraft = '';
  await run(load);
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
const locked = () => S.busy || !!S.pending;
const button = (/** @type {string} */ label, /** @type {() => void} */ onclick, cls = 'btn', disabled = false) => h('button', { type: 'button', class: cls, disabled, onclick }, label);
const pill = (/** @type {M.Status} */ st) => h('span', { class: `pill ${st}` }, S.t.status[st]);
const input = (/** @type {string} */ id, /** @type {string} */ value, /** @type {(v: string) => void} */ oninput, /** @type {string} */ label, max = 200) =>
  h('input', { id, class: 'input', maxlength: max, value, 'aria-label': label, placeholder: label, disabled: locked(), oninput: (/** @type {Event} */ e) => oninput(/** @type {HTMLInputElement} */ (e.target).value) });

function list() {
  const t = S.t;
  const rows = /** @type {M.Row[]} */ (S.rows);
  const listbox = h('div', { class: 'card list', role: 'listbox', 'aria-label': t.title },
    ...rows.map(r => h('button', { type: 'button', class: 'item', role: 'option', 'aria-selected': String(r.key === S.selected), onclick: () => void run(() => open(r.key)) },
      h('span', { class: 'line' }, h('b', {}, r.name), h('span', { class: 'muted' }, M.when(r.latest))),
      h('span', { class: 'line' }, pill(r.status), h('span', { class: 'muted' }, r.channels.join(' · ')), ...r.tags.map(tag => h('span', { class: 'tag' }, tag))))));
  return h('div', { class: 'stack' }, listbox,
    S.truncated && h('div', { class: 'stack' }, h('p', { class: 'muted', role: 'status' }, t.listTruncated), button(t.loadMore, () => void run(more), 'btn', locked())));
}

function detail() {
  const t = S.t, d = /** @type {M.Detail} */ (S.detail), c = d.customer;
  const human = d.control.owner === 'human' || d.control.state === 'waiting_human' || d.control.state === 'blocked';
  const head = h('div', { class: 'line wrap' },
    h('div', {}, h('b', { class: 'name' }, c.name), ' ', h('span', { class: 'pill done' }, c.levels.includes('asserted') ? t.verified : t.paired),
      h('p', { class: 'muted' }, `${c.principals.join(' · ')} · ${c.channels.join(' · ')}`)),
    h('div', { class: 'line' }, h('span', { class: `pill ${human ? 'need' : 'soot'}` }, human ? t.youHold : t.sootHolds),
      d.control.can_control && button(human ? t.resume : t.takeover, () => void write(M.controlBody(d.control)), human ? 'btn sm' : 'btn primary sm', locked())));
  const facts = h('section', { class: 'stack' }, h('h2', {}, t.facts),
    d.facts.length ? h('dl', { class: 'facts' }, ...d.facts.map(f => h('div', { class: 'fact' }, h('dt', {}, f.label), h('dd', {}, f.value)))) : h('p', { class: 'muted' }, d.facts_state === 'not_configured' ? t.factsOff : t.factsDown),
    d.facts.length > 0 && h('p', { class: 'muted' }, t.factsNote));
  const memory = h('section', { class: 'stack' }, h('h2', {}, t.memory),
    d.memory.length ? h('ul', { class: 'plain' }, ...d.memory.map(m => h('li', {}, m.content))) : h('p', { class: 'muted' }, t.noMemory));
  const tags = h('section', { class: 'stack' }, h('h2', {}, t.tags),
    h('div', { class: 'line wrap' }, ...d.tags.map(x => h('span', { class: 'tag' }, x.tag, ' ', button('×', () => void write(M.tagBody(c.key, x.tag, true)), 'btn ghost xs', locked())))),
    h('div', { class: 'line' }, input('tag', S.tagDraft, v => { S.tagDraft = v; }, t.addTag, 32), button(t.addTag, () => void write(M.tagBody(c.key, S.tagDraft)), 'btn', locked())));
  const notes = h('section', { class: 'stack' }, h('h2', {}, t.notes),
    d.notes_truncated && h('p', { class: 'muted', role: 'status' }, t.notesTruncated),
    ...d.notes.map(n => h('div', { class: 'note' }, h('p', {}, n.body), h('p', { class: 'muted' }, `${n.author} · ${M.when(n.at)}`, ' ', button(t.delete, () => void write({ kind: 'note_delete', key: d.customer.key, id: n.id }), 'btn ghost xs', locked())))),
    h('textarea', { id: 'note', class: 'input', rows: 2, maxlength: 2000, 'aria-label': t.addNote, disabled: locked(), oninput: (/** @type {Event} */ e) => { S.noteDraft = /** @type {HTMLTextAreaElement} */ (e.target).value; } }, S.noteDraft),
    button(t.addNote, () => void write(M.noteBody(c.key, S.noteDraft)), 'btn', locked()));
  const links = h('section', { class: 'stack' }, h('h2', {}, t.links),
    ...d.links.map(l => h('div', { class: 'line' }, h('span', {}, l.alias), h('span', { class: 'muted' }, l.proof), button(t.unlink, () => void write({ kind: 'unlink', key: d.customer.key, id: l.id }), 'btn ghost xs', locked()))),
    S.linkProofs ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, t.linkHelp),
      h('div', { class: 'line' }, input('proof', S.proofDraft, v => { S.proofDraft = v; }, t.link, 4096), button(t.link, () => void write(M.linkBody(S.proofDraft)), 'btn', locked())))
      : h('p', { class: 'muted' }, t.noLinkKeys));
  const timeline = h('section', { class: 'stack' }, h('h2', {}, t.timeline),
    d.timeline_truncated && h('p', { class: 'muted', role: 'status' }, t.timelineTruncated),
    ...d.timeline.map(m => h('div', { class: `msg ${m.role}${m.internal ? ' internal' : ''}` },
      h('p', { class: 'muted' }, `${m.author || m.channel} · ${m.channel} · ${M.when(m.at)}${m.internal ? ` · ${t.internal}` : ''}`), h('p', {}, m.text))));
  return h('div', { class: 'card detail' }, head, facts, memory, timeline, tags, notes, links);
}

function render() {
  const t = S.t, root = /** @type {HTMLElement} */ (document.getElementById('app'));
  const focused = document.activeElement?.id;
  const out = [h('header', { class: 'head' }, h('h2', { class: 'page-title' }, t.title), h('p', { class: 'muted' }, t.purpose)),
    // The search row's Tải lại is the page's one retry; a failed read says why beside it, never with a second button.
    h('div', { class: 'line' }, input('q', S.q, v => { S.q = v; }, t.search, 100), button(t.reload, () => void run(load), 'btn', locked()))];
  if (S.loadError) out.push(h('div', { class: 'notice', role: 'alert' }, h('p', {}, S.loadError)));
  else if (S.missing) out.push(h('p', { class: 'muted', role: 'status' }, t.waitingSetup));
  else if (!S.rows) out.push(h('p', { class: 'muted', role: 'status' }, t.loading));
  else if (S.rows.length === 0) out.push(h('p', { class: 'muted' }, t.none));
  else out.push(h('div', { class: 'cols' }, list(), S.detail ? detail() : h('p', { class: 'muted' }, t.loading)));
  if (S.pending && !S.busy) out.push(h('div', { class: 'line' }, button(t.retry, () => void send(), 'btn primary')));
  if (S.notice) out.push(h('p', { class: `notice ${S.notice.kind}`, role: S.notice.kind === 'success' ? 'status' : 'alert' }, S.notice.text));
  root.replaceChildren(...out);
  if (focused) /** @type {HTMLElement | null} */ (document.getElementById(focused))?.focus();
}

function start() {
  if (S.started) return;
  S.started = true; render();
  void run(load);
}

// Nest sends init only after the frame says ready (soot-pages §5); the
// standalone shell may not send init, so start anyway after a short wait.
bridge.ready();
setTimeout(start, 1500);
