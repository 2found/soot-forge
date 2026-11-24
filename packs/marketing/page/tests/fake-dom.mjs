// The smallest DOM and kit the desk's app.js touches, so the page suite can
// render every tab and sheet from real page_view answers in node: elements,
// text, attributes, listeners, focus, a few selectors, and a `soot` whose el()
// builds like the kit's and whose calls go to a handler the test gives.
// tests/ is not shipped in the pack archive.
import vm from 'node:vm';

class Node0 {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; }
  get isConnected() { let n = this; while (n) { if (n === this.ownerDocument.documentElement) return true; n = n.parentNode; } return false; }
}
class Text extends Node0 {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class Element extends Node0 {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.attrs = new Map();
    this.listeners = {};
    this._value = undefined;
    this._checked = undefined;
  }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v) { this.attrs.set('class', String(v)); }
  get id() { return this.attrs.get('id') ?? ''; }
  get classList() { const el = this; return { contains: (c) => el.className.split(/\s+/).includes(c) }; }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '') this.appendChild(new Text(this.ownerDocument, v)); }
  get value() { return this._value ?? this.attrs.get('value') ?? ''; }
  set value(v) { this._value = String(v); }
  get checked() { return this._checked ?? this.attrs.has('checked'); }
  set checked(v) { this._checked = !!v; }
  get disabled() { return this.attrs.has('disabled'); }
  set disabled(v) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { this.childNodes = this.childNodes.filter(n => n !== c); c.parentNode = null; return c; }
  append(...kids) { for (const k of kids) this.appendChild(typeof k === 'object' && k ? k : new Text(this.ownerDocument, k)); }
  replaceChildren(...kids) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    let stopped = false;
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...extra };
    for (let n = this; n && !stopped; n = n.parentNode) for (const fn of n.listeners?.[type] ?? []) fn.call(n, { ...ev, currentTarget: n });
    if (!stopped) for (const fn of this.ownerDocument.listeners[type] ?? []) fn(ev);
    return ev;
  }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(sel) { return sel.split(',').some(s => matchOne(this, s.trim())); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
function matchOne(el, s) {
  // A compound selector: tag, classes and attribute tests, all of which must hold.
  const parts = s.match(/^[a-z0-9]+|#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/gi) ?? [];
  if (parts.join('') !== s || !parts.length) throw new Error(`fake-dom: selector ${s} not handled`);
  return parts.every(p => matchPart(el, p));
}
function matchPart(el, s) {
  let m;
  if ((m = /^\.([\w-]+)$/.exec(s))) return el.classList.contains(m[1]);
  if ((m = /^#([\w-]+)$/.exec(s))) return el.id === m[1];
  if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s))) return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
  if ((m = /^([a-z0-9]+)?(?:\.([\w-]+))?$/i.exec(s)) && (m[1] || m[2])) return (!m[1] || el.tagName === m[1].toUpperCase()) && (!m[2] || el.classList.contains(m[2]));
  throw new Error(`fake-dom: selector ${s} not handled`);
}

/** Text of a subtree, one space between elements, for assertions. */
export const text = (n) => (n.nodeType === 3 ? n.data : n.childNodes.map(text).join(' ')).replace(/\s+/g, ' ').trim();

/**
 * Runs app.js (the built classic script) against a fake document and kit.
 * handler(call) answers {mode: 'view'|'action'|'ask', input, opts} like the
 * kit's promises: view → output, action → {output}, ask → done state.
 */
export function mount(script, handler) {
  const doc = { listeners: {}, activeElement: null };
  doc.documentElement = new Element(doc, 'html');
  doc.body = new Element(doc, 'body');
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  const app = new Element(doc, 'div');
  app.setAttribute('id', 'app');
  doc.body.appendChild(app);
  doc.createElement = (t) => new Element(doc, t);
  doc.createElementNS = (_ns, t) => new Element(doc, t);
  doc.createTextNode = (t) => new Text(doc, t);
  doc.getElementById = (id) => doc.documentElement.querySelector(`#${id}`);
  doc.addEventListener = (t, fn) => { (doc.listeners[t] ||= []).push(fn); };
  const calls = [], opened = [], timers = [];
  const pending = new Set();
  const track = (p) => { pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p; };
  let live = null;
  const append = (node, kids) => kids.forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(c && c.nodeType ? c : new Text(doc, String(c)));
  });
  const soot = {
    el(tag, props, ...kids) {
      const node = new Element(doc, tag);
      if (props !== null && props !== undefined && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) { kids.unshift(props); props = null; }
      for (const [k, v] of Object.entries(props ?? {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = String(v);
        else if (/^on[a-z]+$/.test(k)) { if (typeof v === 'function') node.addEventListener(k.slice(2), v); }
        else if (/^[a-z][a-z0-9-]*$/i.test(k)) node.setAttribute(k, v === true ? '' : String(v));
      }
      append(node, kids);
      return node;
    },
    view: (input) => { calls.push({ mode: 'view', input }); return track(Promise.resolve().then(() => handler({ mode: 'view', input }))); },
    action: (input, opts) => { calls.push({ mode: 'action', input, opts }); return track(Promise.resolve().then(() => handler({ mode: 'action', input, opts }))); },
    ask: (input, opts) => {
      calls.push({ mode: 'ask', input, opts });
      return track(Promise.resolve().then(() => handler({ mode: 'ask', input, opts }))).then((r) => { opts?.onState?.({ state: 'done', reply: r }); return r; });
    },
    open: (link) => opened.push(link),
    live: (fn) => { live = fn; Promise.resolve().then(() => fn({ lists: [] })); return () => {}; },
  };
  const ctx = { document: doc, soot, crypto: globalThis.crypto, CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return {
    doc, app, calls, opened, timers,
    /** Let every pending promise settle. */
    flush: async () => {
      for (let i = 0; i < 200; i++) {
        for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
        if (!pending.size) return;
        await Promise.allSettled([...pending]);
      }
      throw new Error('fake-dom: calls never settled');
    },
    refresh: () => live?.({ lists: [] }),
    /** The first element whose data-k is key, or whose text matches. */
    find: (sel, re) => doc.documentElement.querySelectorAll(sel).find(e => (re ? re.test(text(e)) : true)) ?? null,
    all: (sel) => doc.documentElement.querySelectorAll(sel),
  };
}
