// The Công ty bundle on bridge v2, run as it ships (page/app.js) against a fake Nest: a minimal DOM, the
// host's init/context messages, and view calls answered by the real page_view tool. The page follows
// Nest's project and has no product switch of its own (audit 2026-11-14 N10: Nest's title bar is the one
// switch); the projects Nest sends (init/context `projects`) still go to the tool as `products`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { world, ITEM } from './world.mjs';

const SOURCE = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
const ACME = { id: 'acme', name: 'Acme', teams: ['acme-growth'] };
const BETA = { id: 'beta', name: 'Beta', teams: ['beta-growth'] };

// ---------- a DOM just large enough for the page ----------
function element(tag) {
  const el = {
    tag, attrs: {}, children: [], listeners: {}, style: {}, dataset: {},
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute(k) { return el.attrs[k]; },
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    append(...kids) { el.children.push(...kids); },
    replaceChildren(...kids) { el.children = kids; },
    querySelector() { return null; },
    scrollIntoView() {},
    focus() {},
  };
  el.style.setProperty = (k, v) => { el.style[k] = v; };
  return el;
}
const text = n => (typeof n === 'string' ? n : n.text !== undefined ? n.text : n.children.map(text).join(''));
const all = (n, pred, out = []) => { if (n.tag && pred(n)) out.push(n); for (const k of n.children ?? []) all(k, pred, out); return out; };

/** One frame: the page script in its own context, a parent that records posts, and a world for its tool calls. */
async function frame() {
  const w = world();
  await w.call('digest_save', { opportunities: [{ ...ITEM.content, product: 'acme' }, { ...ITEM.product, product: 'beta' }] });
  const root = element('main');
  const posts = [], views = [];
  let onMessage = null;
  const parent = { postMessage: m => posts.push(m) };
  const document = {
    documentElement: element('html'),
    createElement: element,
    createTextNode: t => ({ text: String(t) }),
    getElementById: id => (id === 'app' ? root : null),
  };
  const window = { parent, addEventListener: (type, fn) => { if (type === 'message') onMessage = fn; } };
  vm.runInNewContext(SOURCE, { window, document, crypto: globalThis.crypto, Intl, setTimeout, clearTimeout, console });
  const host = {
    w, root, posts, views,
    send: data => onMessage({ source: parent, data }),
    /** Answer every pending view call with the real tool, as Nest would; returns the inputs answered. */
    async settle() {
      for (let i = 0; i < 20; i++) {
        const calls = posts.splice(0).filter(m => m.type === 'call');
        if (!calls.length) { await new Promise(r => setTimeout(r, 5)); if (!posts.length) break; continue; }
        for (const c of calls) {
          views.push(JSON.parse(JSON.stringify(c.input))); // out of the page's realm, for deepEqual
          const output = await w.call(c.mode === 'view' ? 'page_view' : 'page_action', c.input, { page: { page: 'company' } });
          host.send({ v: 2, type: 'result', id: c.id, ok: true, output });
        }
        await new Promise(r => setTimeout(r, 5));
      }
    },
    switchButtons: () => all(root, n => n.attrs.class === 'seg').flatMap(seg => seg.children),
    lastView: () => views[views.length - 1],
  };
  return host;
}
const init = extra => ({ v: 2, type: 'init', theme: 'light', locale: 'vi', tokens: { '--surface': 'white' }, viewer: { kind: 'operator' }, ...extra });

test('with projects: no switch on the page; the tool gets Nest\'s project and the list, and a new choice in Nest is followed', async () => {
  const f = await frame();
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts.map(m => [m.v, m.type]))), [[2, 'ready']]);
  f.posts.length = 0;
  f.send(init({ project: ACME, projects: [ACME, BETA] }));
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'acme', products: [ACME, BETA] });
  assert.equal(f.switchButtons().length, 0, 'the page draws no product switch (N10)');
  assert.doesNotMatch(text(f.root), /Theo Nest|Bạn đang xem|Mọi sản phẩm\s*Acme/);
  assert.match(text(f.root), /Số lúc [^·]* · Acme/, 'the subtitle names the product shown');
  assert.match(text(f.root), /Đổi sản phẩm ở ô Sản phẩm trên thanh trên cùng của Nest\./, 'where the product changes');

  f.send({ v: 2, type: 'context', project: BETA, projects: [ACME, BETA] });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'beta', products: [ACME, BETA] });

  // A context without `projects` keeps the list; one with an empty list sends none.
  f.send({ v: 2, type: 'context', project: null });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', products: [ACME, BETA] });
  assert.equal(all(f.root, n => n.tag === 'button' && text(n) === 'Xem').length, 0, 'no per-product switch either');
  f.send({ v: 2, type: 'context', project: null, projects: [] });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company' });
});

test('without projects (an older host): the page follows project', async () => {
  const f = await frame();
  f.send(init({ project: ACME }));
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'acme', products: [ACME] });
  f.send({ v: 2, type: 'context', project: null });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company' });
  assert.equal(f.switchButtons().length, 0);
});

test('the standalone shell (project null, no list) shows every product', async () => {
  const f = await frame();
  f.send(init({ project: null }));
  await f.settle();
  assert.deepEqual(f.views, [{ page: 'company' }]);
  const g = await frame();
  g.send(init({ project: null, projects: [ACME] }));
  await g.settle();
  assert.deepEqual(g.lastView(), { page: 'company', products: [ACME] });
});

test('messages that are not bridge v2 are dropped: v1, an unknown key, a malformed projects list', async () => {
  for (const bad of [
    { ...init({ project: ACME }), v: 1 },
    { ...init({ project: ACME }), products: [ACME] },
    init({ project: ACME, projects: ACME }),
    init({ project: ACME, projects: [null] }),
    init({ project: ACME, projects: [{ ...BETA, extra: 1 }] }),
    init({ project: ACME, projects: Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, teams: [] })) }),
  ]) {
    const f = await frame();
    f.posts.length = 0;
    f.send(bad);
    await f.settle();
    assert.deepEqual(f.views, [], JSON.stringify(bad).slice(0, 80));
  }
  // A project id that is not a product id cannot narrow the page and is not sent as a product.
  const f = await frame();
  f.send(init({ project: null, projects: [ACME, BETA, { id: 'Not A Product', name: 'X', teams: [] }] }));
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', products: [ACME, BETA] });
});

test('N11 (audit 2026-11-14): the page never shows an env name or points to the README', () => {
  const words = [...SOURCE.matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)].map(m => m[1] ?? m[2]).filter(t => /[àáạảãâăèéẹẻẽêìíịỉĩòóọỏõôơùúụủũưỳýỵỷỹđ]/i.test(t));
  for (const t of words.map(w => w.replace(/\$\{[^}]*\}/g, ''))) assert.doesNotMatch(t, /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|README/, t);
  assert.ok(words.length > 50, 'the Vietnamese strings were found');
});
