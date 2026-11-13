// The Công ty bundle on bridge v2, run as it ships (page/app.js) against a fake Nest: a minimal DOM, the
// host's init/context messages, and view calls answered by the real page_view tool. The page's own switch
// "Mọi sản phẩm | <product>…" lists the projects Nest sends (init/context `projects`); with no list (an
// older host, the standalone shell) it draws no switch and follows `project`.
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

test('with projects: the switch lists Nest\'s projects, follows the chosen one, and the tool gets the chosen one and the list', async () => {
  const f = await frame();
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts.map(m => [m.v, m.type]))), [[2, 'ready']]);
  f.posts.length = 0;
  f.send(init({ project: ACME, projects: [ACME, BETA] }));
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'acme', products: [ACME, BETA] });
  const buttons = f.switchButtons();
  assert.deepEqual(buttons.map(b => [text(b).replace(/\d+$/, ''), b.attrs['aria-pressed']]), [['Mọi sản phẩm', 'false'], ['Acme', 'true'], ['Beta', 'false']]);

  // The founder picks Beta on the page: the tool narrows to it, and the page says Nest still has Acme.
  buttons[2].listeners.click[0]();
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'beta', products: [ACME, BETA] });
  assert.match(text(f.root), /Bạn đang xem Beta trên trang này; Nest đang chọn Acme\./);

  // Every product: no product, the list stays.
  f.switchButtons()[0].listeners.click[0]();
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', products: [ACME, BETA] });

  // A new choice in Nest wins over the page's own switch.
  f.send({ v: 2, type: 'context', project: BETA, projects: [ACME, BETA] });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'beta', products: [ACME, BETA] });
  assert.doesNotMatch(text(f.root), /Bạn đang xem/);
  assert.deepEqual(f.switchButtons().filter(b => b.attrs['aria-pressed'] === 'true').map(b => text(b).replace(/\d+$/, '')), ['Beta']);

  // A context without `projects` keeps the list; one with an empty list removes the switch.
  f.send({ v: 2, type: 'context', project: null });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', products: [ACME, BETA] });
  assert.equal(f.switchButtons().length, 3);
  f.send({ v: 2, type: 'context', project: null, projects: [] });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company' });
  assert.equal(f.switchButtons().length, 0);
});

test('without projects (an older host): no switch, even when the data names two products; the page follows project', async () => {
  const f = await frame();
  f.send(init({ project: ACME }));
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company', product: 'acme', products: [ACME] });
  assert.equal(f.switchButtons().length, 0);
  f.send({ v: 2, type: 'context', project: null });
  await f.settle();
  assert.deepEqual(f.lastView(), { page: 'company' });
  assert.equal(f.switchButtons().length, 0, 'scope.products names acme and beta, but Nest listed no projects');
});

test('the standalone shell (project null, no list) shows every product; one project is no switch', async () => {
  const f = await frame();
  f.send(init({ project: null }));
  await f.settle();
  assert.deepEqual(f.views, [{ page: 'company' }]);
  assert.equal(f.switchButtons().length, 0);
  const g = await frame();
  g.send(init({ project: null, projects: [ACME] }));
  await g.settle();
  assert.deepEqual(g.lastView(), { page: 'company', products: [ACME] });
  assert.equal(g.switchButtons().length, 0, 'a switch needs two projects, as 0.14.5 needed two products');
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
  // A project id that is not a product id is not listed in the switch (it cannot narrow the page).
  const f = await frame();
  f.send(init({ project: null, projects: [ACME, BETA, { id: 'Not A Product', name: 'X', teams: [] }] }));
  await f.settle();
  assert.deepEqual(f.switchButtons().map(b => text(b).replace(/\d+$/, '')), ['Mọi sản phẩm', 'Acme', 'Beta']);
});
