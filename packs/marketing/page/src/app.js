// @ts-check
// The Marketing desk (the pack's `desk` rail piece). Every read is a
// soot.view of page_view; every write is a soot.action of page_action from a
// press; a new piece of work goes to the Editor (Biên tập) with soot.ask. Approving is
// never drawn here: "Duyệt…" opens Nest's own approval card
// (nest://needs/approve/<id>), and a browser sign-in opens Cài đặt › Trình
// duyệt. The approvals the piece's query returns are passed back to every
// view, so the desk and Cần bạn agree on what waits. DOM is built with
// soot.el (text stays text); the frame CSP allows no inline script or style.
import * as M from './model.js';
import { icon } from './icons.js';

const soot = /** @type {any} */ (window).soot;
const h = soot.el;
const ic = icon;
const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const mainHost = h('div', { class: 'mk-host' });
const sheetHost = h('div', { class: 'mk-sheet-host' });
const toastHost = h('div', { class: 'mk-toast-host', 'aria-live': 'polite' });
root.replaceChildren(mainHost, sheetHost, toastHost);

const S = {
  tab: 'today', product: /** @type {string | null} */ (null), stage: /** @type {string | null} */ (null),
  summary: /** @type {any} */ (null), views: /** @type {Record<string, any>} */ ({}), error: /** @type {any} */ (null), tabError: /** @type {any} */ (null),
  approvals: /** @type {any[] | null} */ (null), cards: /** @type {number | null} */ (null), approvalsWhy: /** @type {string | null} */ (null),
  lib: { node: /** @type {string | null} */ (null), pane: 'list', detail: /** @type {any} */ (null), error: /** @type {any} */ (null), loading: false },
  week: /** @type {string | null} */ (null), more: { blockers: false }, olderLive: false,
  sheet: /** @type {any} */ (null), toast: /** @type {any} */ (null),
  busy: /** @type {Record<string, boolean>} */ ({}), rids: /** @type {Record<string, string>} */ ({}), arm: /** @type {Record<string, number>} */ ({}), seq: 0,
};
const ctx = () => ({ now: Date.now(), products: M.productMap(S.summary?.products), product: S.product, hubless: S.summary?.mode === 'hubless' || hubSource()?.error === 'not_configured' });
/** P2: what the team can do, as the desk last learned it (null = not known yet). */
const ability = (k) => S.summary?.abilities?.[k] ?? null;
const toLead = (text) => soot.open(`nest://new?text=${encodeURIComponent(text)}`);
const NOTE_ASKED = 'Đã nhờ Biên tập. Trả lời nằm trong cuộc trò chuyện của màn hình này.';
const VIEW_OF = { today: 'today', content: 'content', channels: 'channels', library: 'library', numbers: 'numbers' };

// ---------- small parts ----------

/** A button: always type=button (the frame has no forms). */
function btn(label, onclick, o = {}) {
  return h('button', { type: 'button', class: o.cls, onclick, disabled: o.disabled, 'aria-pressed': o.pressed === undefined ? null : String(o.pressed), 'aria-label': o.aria, 'data-k': o.k, title: o.title },
    o.icon ? ic(o.icon, o.iconCls ?? 's14') : null, label);
}
const platforms = (list) => (list ?? []).map(p => ({ ...M.CH, youtube: 'YouTube', instagram: 'Instagram' })[p] ?? p).join(', ') || '—';
const link = (label, href, o = {}) => btn(label, () => soot.open(href), { cls: o.cls ?? 'link', icon: o.icon ?? 'ext', k: o.k });
function pm(id) {
  const p = ctx().products[id];
  return p ? h('span', { class: 'mk-pm', title: p.name }, p.mark) : null;
}
function cm(ch, off) {
  return h('span', { class: off ? 'mk-cm off' : 'mk-cm', title: M.CH[ch] ?? ch }, ch === 'blog' ? ic('file', 's12') : ch === 'community' ? ic('users', 's12') : ch === 'newsletter' ? ic('mail', 's12') : M.CHM[ch] ?? ch.slice(0, 1).toUpperCase());
}
const sq = (tone, name) => h('span', { class: `mk-sq ${tone ?? ''}` }, ic(name, 's14'));
const tag = (text, tone) => (text ? h('span', { class: `mk-tag ${tone ?? 'idle'}` }, text) : null);
/** A list row; with onClick it is a button-like row (Enter and Space press it). */
function row({ lead, title, sub, end, onClick, wrap = false, cls = '' }) {
  return h('div', { class: `mk-row ${onClick ? 'click' : ''} ${cls}`, role: onClick ? 'button' : null, tabindex: onClick ? '0' : null, onclick: onClick },
    lead,
    h('div', { class: 'main' },
      h('div', { class: wrap ? 'ttl wrap' : 'ttl' }, title),
      sub === null || sub === undefined || sub === '' ? null : h('div', { class: wrap ? 'sub wrap' : 'sub' }, ...(Array.isArray(sub) ? sub : [h('span', null, sub)]))),
    end === undefined ? (onClick ? h('div', { class: 'end' }, ic('right', 's14')) : null) : h('div', { class: 'end' }, end, onClick ? ic('right', 's14') : null));
}
const emptyRow = (text) => h('div', { class: 'mk-row' }, h('div', { class: 'main' }, h('div', { class: 'sub wrap' }, h('span', null, text))));
const card = (title, right, ...kids) => h('section', { class: 'mk-card' }, h('div', { class: 'mk-ch' }, h('span', null, title), h('span', { class: 'sp' }), right), ...kids);
function notice(kind, iconName, title, text, action) {
  return h('div', { class: kind === 'partial' ? 'mk-partial' : kind === 'plain' ? 'mk-notice plain' : kind === 'warn' ? 'mk-notice warn' : 'mk-notice', role: kind === 'partial' ? 'alert' : 'status' },
    ic(iconName), h('div', { class: 'grow' }, title ? h('b', null, title) : null, text ? h('span', null, text) : null), action);
}
const support = (pairs) => h('details', { class: 'mk-support' }, h('summary', null, 'Chi tiết kỹ thuật'),
  h('dl', null, ...pairs.filter(p => p[1] !== null && p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])));
const kv = (pairs) => h('dl', { class: 'mk-kv' }, ...pairs.filter(p => p[1] !== null && p[1] !== undefined && p[1] !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
const skRow = () => h('div', { class: 'mk-row' }, h('span', { class: 'mk-sk sq' }), h('div', { class: 'main' }, h('span', { class: 'mk-sk w70 h13' }), h('span', { class: 'mk-sk w45 h10 mt' })));

// ---------- data ----------

async function readApprovals() {
  try {
    const out = await soot.view('approvals');
    S.approvalsWhy = null;
    return M.compactApprovals(out);
  } catch (e) {
    // An older host has no approval query; a member may not read it. The desk then says it could not read them.
    S.approvalsWhy = e?.code ?? 'failed';
    return null;
  }
}
/** The team's open Cần bạn cards, as a count; null on an older host or when it cannot be read (the desk then counts only its own). */
async function readCards() {
  try { return M.cardCount(await soot.view('team_waits')); } catch { return null; }
}
const read = (view, opts = {}) => soot.view(M.viewBody(view, { product: S.product ?? undefined, cards: S.cards ?? undefined, ...opts }, S.approvals)).then(M.output);
function tabOpts(tab) {
  if (tab === 'content') return { stage: S.stage ?? undefined, ...(S.stage === 'live' && S.olderLive ? { live: 'all' } : {}) };
  if (tab === 'numbers') return { week: S.week ?? undefined };
  return {};
}

/** Read the summary and the open tab (and refresh an open sheet); quiet keeps what is drawn while it reads. */
async function load({ quiet = false } = {}) {
  const seq = ++S.seq;
  if (!quiet) { S.error = null; S.tabError = null; renderMain(); }
  [S.approvals, S.cards] = await Promise.all([readApprovals(), readCards()]);
  const tab = S.tab;
  // One read for the header and the open tab: the hub counts every call against the pack's budget.
  let view = null;
  try { view = await read(VIEW_OF[tab], { ...tabOpts(tab), with_summary: true }); } catch (e) { if (seq === S.seq) { S.error = e; S.tabError = e; } }
  if (seq !== S.seq) return;
  if (view) {
    const { summary, ...rest } = view;
    if (summary) { S.summary = summary; S.error = null; } else S.error = { code: 'unsupported' };
    S.views[tab] = rest;
    S.tabError = null;
    if (tab === 'library' && S.lib.node) await loadNode(S.lib.node, { quiet: true });
  }
  renderMain();
  await refreshSheet();
}
/** Switch tab: draw at once from what was read, then read it again. */
async function loadTab() {
  const seq = ++S.seq;
  const tab = S.tab;
  S.tabError = null;
  renderMain();
  try { S.views[tab] = await read(VIEW_OF[tab], tabOpts(tab)); } catch (e) { if (seq === S.seq) S.tabError = e; }
  if (seq !== S.seq) return;
  if (tab === 'library' && S.views.library) {
    // Keep the node the founder had open; the first node of the tree otherwise.
    const node = S.lib.node ?? M.firstNode((S.views.library.tree ?? []).filter(g => !S.product || g.product === S.product));
    if (node) await loadNode(node, { quiet: true });
  }
  renderMain();
}
async function loadNode(node, { quiet = false } = {}) {
  S.lib.node = node;
  if (!quiet) { S.lib.loading = true; S.lib.error = null; renderMain(); }
  try {
    const out = await read('library', { node, product: undefined });
    if (S.lib.node !== node) return;
    S.lib.detail = out.detail ?? null;
    S.lib.error = null;
  } catch (e) { if (S.lib.node === node) S.lib.error = e; }
  S.lib.loading = false;
  if (!quiet) renderMain();
}

// ---------- writes ----------

/**
 * One page_action from a press. The request id is kept per intent until the
 * outcome is known, so a retry after a lost answer sends the same id and the
 * runtime replays its receipt instead of acting twice.
 */
async function act(op, fields, button, o = {}) {
  const key = M.intentKey(op, fields);
  if (S.busy[key]) return null;
  const rid = S.rids[key] ?? (S.rids[key] = M.requestId('mk'));
  S.busy[key] = true;
  if (button) { button.setAttribute('aria-busy', 'true'); button.disabled = true; }
  try {
    const r = await soot.action(M.actionBody(op, fields, rid), { request_id: rid });
    const out = M.output(r?.output);
    delete S.rids[key];
    return out;
  } catch (e) {
    if (!M.unknownOutcome(e)) delete S.rids[key];
    // A refusal the caller shows in place (a wrong link, a name taken) is not also a toast.
    if (!o.onError?.(e)) toast(M.errorText(e), 'err');
    return null;
  } finally {
    delete S.busy[key];
    if (button && button.isConnected) { button.removeAttribute('aria-busy'); button.disabled = false; }
  }
}
/** A press that needs a second press within 4 s (stopping an item cannot be undone from the desk). */
function armed(key, button, firstLabel, run) {
  if (S.arm[key] && Date.now() - S.arm[key] < 4000) { delete S.arm[key]; run(); return; }
  S.arm[key] = Date.now();
  button.lastChild.textContent = 'Bấm lần nữa để dừng';
  setTimeout(() => { if (S.arm[key] && button.isConnected) { delete S.arm[key]; button.lastChild.textContent = firstLabel; } }, 4000);
}
function stopButton(ref, label = 'Dừng bài này') {
  const b = btn(label, () => armed(`stop:${ref}`, b, label, async () => {
    const out = await act('stop', { ref }, b);
    if (!out) return;
    closeSheet();
    toast(out.withdrawn ? 'Đã dừng và rút bài khỏi hàng chờ. Bài không lên kênh nào; nó nằm lại ở Đang làm.' : 'Đã dừng. Bài không lên kênh nào; nó nằm lại ở Đang làm.');
    load({ quiet: true });
  }), { icon: 'stop', k: `stop:${ref}` });
  return b;
}
async function pauseAll(paused, b) {
  const out = await act(paused ? 'pause' : 'resume', { scope: 'all' }, b);
  if (!out) return;
  toast(paused ? 'Đã tạm dừng mọi lượt đăng. Bài đã duyệt nằm chờ.' : 'Đã bật lại. Bài lên theo nhịp từ lượt tới.');
  load({ quiet: true });
}
async function pauseChannel(key, paused, b) {
  const out = await act(paused ? 'pause' : 'resume', { scope: 'channel', channel: key }, b);
  if (!out) return;
  toast(paused ? 'Đã tạm dừng kênh này. Bài đã duyệt nằm chờ.' : out.still_signed_out ? 'Đã bật lại, nhưng tài khoản vẫn đăng xuất. Đăng nhập lại thì bài mới lên.' : 'Đã bật lại kênh. Bài lên theo nhịp từ lượt tới.');
  load({ quiet: true });
}
/**
 * Ask the serving Soot (the Editor) in the viewer's own thread with it.
 * The first state change means the host took it; opts.started runs then.
 */
function ask(text, okText, opts = {}) {
  let told = false;
  return soot.ask(text, {
    request_id: opts.request_id,
    onState: () => {
      if (told) return;
      told = true;
      toast(okText);
      opts.started?.();
    },
  }).catch((e) => {
    // An ask needs Nest: a host without it (an older Nest, a page opened on its own) answers unsupported.
    if (!told) toast(e?.code === 'gesture_required' ? 'Chưa gửi được cho Biên tập. Bấm nút thêm lần nữa.' : e?.code === 'unsupported' ? 'Chỗ này chưa nhắn được Biên tập. Mở bàn Marketing trong Nest bản mới rồi bấm lại.' : M.errorText(e), 'err');
    throw e;
  });
}

// ---------- shell ----------

function head() {
  const st = S.summary ? M.statusText(S.summary.status, ctx()) : null;
  return h('header', { class: 'mk-head' },
    h('div', { class: 'mk-mark' }, ic('megaphone', 's24')),
    h('div', { class: 't' },
      h('div', { class: 'mk-eyebrow' }, h('span', { class: 'badge' }, 'Đội Marketing'), h('span', null, 'Người viết soạn bài, Biên tập xin bạn duyệt, rồi bài lên kênh')),
      h('h1', null, 'Marketing'),
      st?.text ? h('div', { class: `mk-status ${st.tone}`, role: 'status' }, ic(st.icon, st.tone === 'ok' ? 's14 ok' : 's14'), h('span', null, st.text),
        S.summary?.status?.args?.cards ? btn('Mở Cần bạn', () => soot.open('nest://needs'), { cls: 'link', k: 'status:needs' }) : null)
        : S.error ? null : h('div', { class: 'mk-status' }, h('span', { class: 'mk-sk w320 h14' }))),
    // P2: with no product yet the one primary is the setup card's, so the header has none.
    setupMode() ? null : h('div', { class: 'mk-acts' }, btn('Tạo nội dung', () => openSheet('create', null), { cls: 'primary', icon: 'plus', iconCls: '', k: 'create' })));
}
function setupMode() { return S.summary?.status?.code === 'setup';
}
function prods() {
  const list = S.summary?.products ?? [];
  if (list.length < 2) return null;
  return h('div', { class: 'mk-prods', role: 'group', 'aria-label': 'Sản phẩm' },
    btn(`Cả ${list.length} sản phẩm`, () => setProduct(null), { pressed: !S.product, k: 'prod:' }),
    ...list.map(p => h('button', { type: 'button', 'aria-pressed': String(S.product === p.id), 'data-k': `prod:${p.id}`, onclick: () => setProduct(p.id) },
      pm(p.id), p.name, p.blockers ? h('span', { class: 'n', 'aria-label': `${p.blockers} việc` }, String(p.blockers)) : null)));
}
function setProduct(id) {
  if (S.product === id) return;
  S.product = id;
  S.views = {};
  S.lib = { node: null, pane: 'list', detail: null, error: null, loading: false };
  load();
}
function tiles() {
  if (!S.summary) {
    return h('div', { class: 'mk-tiles' }, ...[0, 1, 2, 3, 4].map(() => h('div', { class: 'mk-tile' }, h('span', { class: 'mk-sk w60 h12' }), h('span', { class: 'mk-sk w36 h22' }), h('span', { class: 'mk-sk w80 h10' }))));
  }
  return h('div', { class: 'mk-tiles' }, ...S.summary.tiles.map(t => {
    const x = M.tileText(t, ctx());
    return h('button', { type: 'button', class: `mk-tile ${x.tone}`, 'data-k': `tile:${t.id}`, onclick: () => go(x.tab, x.stage) },
      h('span', { class: 'k' }, ic(x.icon, 's14'), x.label),
      h('span', { class: 'v num' }, x.value),
      h('span', { class: 's' }, x.sub));
  }));
}
function go(tab, stage) {
  S.tab = tab;
  S.stage = stage ?? null;
  loadTab();
}
function tabs() {
  const list = h('div', { class: 'mk-tabs', role: 'tablist', 'aria-label': 'Bàn Marketing' }, ...M.TABS.map(t =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === t.id), tabindex: S.tab === t.id ? '0' : '-1', 'data-k': `tab:${t.id}`, onclick: () => { if (S.tab !== t.id) go(t.id, null); } }, t.label)));
  // Arrow keys move between tabs, as a tablist does.
  list.addEventListener('keydown', (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = M.TABS.findIndex(t => t.id === S.tab);
    const next = M.TABS[(i + (e.key === 'ArrowRight' ? 1 : M.TABS.length - 1)) % M.TABS.length];
    e.preventDefault();
    go(next.id, null);
  });
  return list;
}
function hubSource() { return S.summary?.sources?.find(s => s.id === 'hub') ?? null; }
/** The marketing folder as the last read saw it: {ok} or {ok:false, error: not_configured|invalid|missing}. */
function libSource() { return S.summary?.sources?.find(s => s.id === 'library') ?? null; }
function sourceNotice() {
  const hub = hubSource();
  // P2: no publishing server is a way of working (hubless), not a fault: no notice. Kênh đăng says how bài go out.
  if (hub && !hub.ok && hub.error === 'rate_limited') {
    // The server refused a call for this minute's budget: nothing is broken, so it reads as a wait.
    return notice('info', 'clock', 'Máy chủ đăng bài đang hết lượt đọc trong phút này', 'Bài blog, bài mạng xã hội và kênh trên máy chủ tạm chưa hiện. Chờ một phút rồi bấm Thử lại; video và thư viện trên máy vẫn đủ.',
      btn('Thử lại', () => load(), { icon: 'refresh', k: 'hub:retry' }));
  }
  if (hub && !hub.ok && hub.error !== 'not_configured') {
    const last = hub.last_ok_at ? ` Lần cuối đọc được ${M.when(hub.last_ok_at, Date.now())}.` : '';
    const why = hub.error === 'unauthorized' ? 'Máy chủ từ chối khoá của bàn Marketing.' : hub.error === 'timeout' ? 'Máy chủ không trả lời kịp.' : 'Máy chủ không trả lời.';
    return notice('partial', 'x_circle', 'Không đọc được máy chủ đăng bài', `${why} Bài blog, bài mạng xã hội và kênh trên máy chủ chưa hiện. Video và thư viện trên máy vẫn đủ.${last}`,
      btn('Thử lại', () => load(), { icon: 'refresh', k: 'hub:retry' }));
  }
  if (S.summary?.status?.code === 'paused') {
    const b = btn('Bật lại', () => pauseAll(false, b), { icon: 'play', k: 'resume:all' });
    return notice('info', 'pause', 'Bạn đang tạm dừng mọi lượt đăng', 'Bài đã duyệt vẫn nằm trong lịch. Không có gì tự lên cho tới khi bạn bật lại.', b);
  }
  return null;
}
function emptyState() {
  return h('section', { class: 'mk-card' }, h('div', { class: 'mk-emptystate' },
    h('span', { class: 'mk-soot', 'aria-hidden': 'true' }),
    h('h2', null, 'Chưa có nội dung nào'),
    h('p', null, 'Chọn sản phẩm và đề tài, Người viết soạn bài. Bài xong nằm ở đây chờ bạn duyệt, không có gì tự lên trước đó.'),
    btn('Tạo nội dung đầu tiên', () => openSheet('create', null), { cls: 'primary', icon: 'plus', k: 'create:first' })));
}
/** P2: the desk with no product yet (another founder's first open): one card, one primary. */
function setupState() {
  const hub = hubSource();
  const step = (n, title, sub) => h('li', null, h('span', { class: 'mk-stepn num', 'aria-hidden': 'true' }, String(n)), h('div', null, h('b', null, title), h('span', null, sub)));
  return h('section', { class: 'mk-card' }, h('div', { class: 'mk-emptystate mk-setup' },
    h('span', { class: 'mk-soot', 'aria-hidden': 'true' }),
    h('h2', null, 'Bắt đầu marketing'),
    h('p', null, 'Cho bàn biết bạn làm sản phẩm gì và muốn đăng ở đâu. Mất khoảng 2 phút; sửa lại lúc nào cũng được.'),
    h('ol', { class: 'mk-setupsteps' },
      step(1, 'Sản phẩm', 'Tên, trang web, một câu sản phẩm làm gì'),
      step(2, 'Blog', hub?.ok ? 'Đăng qua máy chủ đăng bài, hoặc ghi vào thư mục site' : 'Ghi bài vào thư mục site của bạn, hoặc bỏ qua'),
      step(3, 'Nơi đăng', 'X, Facebook, TikTok, cộng đồng, bản tin')),
    btn('Bắt đầu marketing', () => openSheet('setup', null), { cls: 'primary', icon: 'right', k: 'setup:start' }),
    h('p', { class: 'mk-fine' }, 'Không có gì được đăng khi bạn chưa duyệt từng bài.'),
    hub && !hub.ok && hub.error === 'not_configured' ? h('p', { class: 'mk-fine' }, 'Đã có máy chủ đăng bài? ', btn('Nối máy chủ', () => soot.open('nest://settings/setup?key=MARKETING_HUB'), { cls: 'link', icon: 'server', k: 'hub:connect' })) : null));
}
function failed(e, what) {
  return h('section', { class: 'mk-card' }, h('div', { class: 'mk-emptystate' },
    h('span', { class: 'mk-soot', 'aria-hidden': 'true' }),
    h('h2', null, what === 'desk' ? 'Không mở được bàn Marketing' : 'Không đọc được phần này'),
    h('p', null, `${M.errorText(e)} Bài và kênh vẫn còn nguyên, chỉ là chưa đọc được.`),
    btn('Thử lại', () => load(), { icon: 'refresh', k: 'retry' })),
  h('div', { class: 'mk-libempty' }, support([['Mảnh', 'pack:marketing:desk'], ['Phần', what === 'desk' ? 'summary' : S.tab], ['Mã lỗi', e?.code ?? 'failed']])));
}
function loadingBody() {
  return h('div', { class: 'mk-grid', 'aria-busy': 'true' },
    h('div', { class: 'mk-card' }, h('div', { class: 'mk-ch' }, 'Vì sao bài chưa lên'), skRow(), skRow(), skRow()),
    h('div', { class: 'mk-card' }, h('div', { class: 'mk-ch' }, 'Lịch hôm nay'), skRow(), skRow()));
}

function renderMain() {
  const focusKey = /** @type {HTMLElement | null} */ (document.activeElement)?.closest?.('[data-k]')?.getAttribute('data-k');
  const inMain = mainHost.contains(document.activeElement);
  let body;
  if (S.error && !S.summary) body = [failed(S.error, 'desk')];
  else if (!S.summary) body = [tiles(), tabs(), loadingBody()];
  else {
    const v = S.views[S.tab];
    const inner = S.tabError && !v ? failed(S.tabError, 'tab') : !v ? loadingBody() : TAB[S.tab](v);
    // P2: before the first product there is nothing to count or list: the setup card stands alone.
    body = setupMode() ? [tiles(), setupState()] : [S.tab === 'library' ? null : tiles(), tabs(), S.tab === 'library' ? null : sourceNotice(), ...(Array.isArray(inner) ? inner : [inner])];
  }
  mainHost.replaceChildren(h('main', { class: 'mk-page' }, head(), prods(), ...body));
  if (inMain && focusKey) /** @type {HTMLElement | null} */ (mainHost.querySelector(`[data-k="${CSS.escape(focusKey)}"]`))?.focus();
}

// ---------- Hôm nay ----------

const WEEKDAY = ['Chủ nhật', 'thứ Hai', 'thứ Ba', 'thứ Tư', 'thứ Năm', 'thứ Sáu', 'thứ Bảy'];
function blockerRow(b) {
  const x = M.blockerText(b, ctx());
  const press = () => {
    if (b.do?.sheet) openSheet(b.do.sheet.kind, b.do.sheet.key);
    else if (b.do?.action?.name === 'resume') pauseAll(false, button);
  };
  const button = btn(x.label, press, { k: `do:${b.id}` });
  return h('div', { class: 'mk-row act' }, sq(x.tone, x.icon),
    h('div', { class: 'main' }, h('div', { class: 'ttl wrap' }, x.title), x.meta ? h('div', { class: 'sub wrap' }, pm(b.product), h('span', null, x.meta)) : null),
    h('div', { class: 'end' }, button));
}
function itemRowEl(it) {
  const st = M.itemState(it, Date.now());
  const chans = (it.channels ?? []).length ? it.channels : it.format === 'blog' ? ['blog'] : [];
  return row({
    lead: sq(st.tone === 'idle' ? '' : st.tone, st.icon),
    title: it.title || it.ref,
    sub: [pm(it.product), ...chans.map(c => cm(c)), h('span', null, M.itemSub(it, ctx()))],
    end: tag(st.tag, st.tone),
    onClick: () => openSheet('item', it.ref),
  });
}
const TL = {
  scheduled: (t) => [t.about ? 'khoảng giờ này' : 'đã lên lịch', 'idle', 'cal', ''],
  publishing: () => ['đang đăng', 'run', 'send', 'run'],
  posted: () => ['đã lên', 'ok', 'check_circle', 'ok'],
  held: (t) => [t.reason === 'missed' ? 'lỡ giờ, không đăng trễ' : t.reason === 'signed_out' ? 'đứng: tài khoản đăng xuất' : t.reason === 'paused' ? 'bạn tạm dừng' : 'đang đứng', 'wait', 'hourglass', 'wait'],
  uncertain: () => ['chưa rõ đã lên chưa', 'wait', 'help', 'wait'],
  after_approval: () => ['chờ bạn duyệt', 'wait', 'hourglass', 'wait'],
  handoff: () => ['bạn đăng tay', 'idle', 'send', ''],
  stopped: () => ['bạn đã dừng', 'idle', 'stop', ''],
};
function timelineRow(t) {
  const [label, tone, iconName, sqTone] = (TL[t.state] ?? (() => ['', 'idle', 'clock', '']))(t);
  return h('div', { class: 'mk-row tl click', role: 'button', tabindex: '0', onclick: () => openSheet('item', t.ref) },
    h('span', { class: 'when' }, M.hm(t.at)), sq(sqTone, iconName),
    h('div', { class: 'main' }, h('div', { class: 'ttl' }, t.title || t.ref), h('div', { class: 'sub' }, pm(t.product), cm(t.channel), tag(label, tone))));
}
/**
 * Hôm nay ranks by how much each block needs the founder now:
 *   1 Vì sao bài chưa lên (always; a fix per row)   2 Cần trả lời (only when a comment waits)
 *   3 Đang làm / Lịch hôm nay (what moves by itself) 4 Tuần này và tuần sau (calm; never in the status line)
 */
function viewToday(v) {
  if (S.summary?.status?.code === 'empty') return emptyState();
  const bl = v.blockers ?? [];
  const shown = S.more.blockers ? bl : bl.slice(0, 5);
  const left = [
    card('Vì sao bài chưa lên', bl.length ? h('span', { class: 'muted' }, 'gấp nhất ở trên') : null,
      ...(bl.length ? shown.map(blockerRow) : [row({ lead: sq('ok', 'check_circle'), title: 'Không có gì chặn bài', sub: ctx().hubless ? 'Bài đã duyệt được ghi vào site hoặc chờ bạn đăng tay.' : 'Bài đã duyệt lên theo nhịp của từng kênh.' })]),
      bl.length > 5 ? h('div', { class: 'mk-more' }, btn(S.more.blockers ? 'Thu gọn' : `Xem thêm ${bl.length - 5} việc`, () => { S.more.blockers = !S.more.blockers; renderMain(); }, { cls: 'link', k: 'more:blockers' })) : null),
    repliesCard(v.replies),
    card('Đang làm', v.making_total > v.making.length ? btn(`Xem tất cả ${v.making_total}`, () => go('content', 'making'), { cls: 'link', icon: 'right', k: 'all:making' }) : null,
      ...(v.making.length ? v.making.map(itemRowEl) : [emptyRow('Không có bài nào đang làm.')])),
  ];
  const d = M.local(Date.now());
  const wd = d ? WEEKDAY[new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()] : '';
  const hub = hubSource();
  const right = [
    // P2: with no publishing server nothing has a posting time, so there is no day plan to show.
    ctx().hubless ? null : card(`Lịch hôm nay, ${wd} ${d?.dm ?? ''}`, null, ...(v.timeline.length ? v.timeline.map(timelineRow) : [emptyRow('Hôm nay không có bài nào lên lịch.')])),
    learnCard(v.learn),
    card('Vừa lên', v.live_total > v.live.length ? btn('Xem tất cả', () => go('content', 'live'), { cls: 'link', icon: 'right', k: 'all:live' }) : null,
      ...(v.live.length ? v.live.map(itemRowEl) : [emptyRow(ctx().hubless ? 'Bài ghi vào site và bài bạn dán link sẽ hiện ở đây.' : hub?.ok === false ? 'Chưa đọc được máy chủ đăng bài nên chưa có bài ở đây.' : 'Chưa có bài nào lên trong 7 ngày.')])),
  ];
  return h('div', { class: 'mk-grid' }, h('div', { class: 'stack g12' }, ...left), h('div', { class: 'stack g12' }, ...right));
}

// P2 ---------- Cần trả lời ----------

/** Only comments that wait for the founder; Soot never answers these. Hidden when none wait and none are drafted. */
function repliesCard(r) {
  if (!r) return null;
  const need = r.need ?? [], drafted = r.drafted ?? [];
  if (!need.length && !drafted.length) return null;
  const c = ctx();
  const rows = need.map(x => {
    const t = M.replyText(x, c);
    const url = M.safeLink(x.reply_url ?? x.thread_url);
    const done = btn('Đã trả lời', async () => {
      const out = await act('reply_done', { ref: x.ref }, done);
      if (!out) return;
      // Only a comment the team raised in Cần bạn has a card there; say it closes only then.
      toast(out.card_closes ? 'Đã ghi là xong. Thẻ trong Cần bạn tự đóng sau ít phút.' : 'Đã ghi là xong.');
      load({ quiet: true });
    }, { k: `reply:done:${x.ref}` });
    return h('div', { class: 'mk-row act mk-reply' }, sq(t.tone === 'wait' ? 'wait' : '', 'message'),
      h('div', { class: 'main' },
        h('div', { class: 'ttl wrap clamp2' }, `“${x.text}”`),
        h('div', { class: 'sub wrap' }, pm(x.product), tag(t.tag, t.tone), h('span', null, [x.author, t.where].filter(Boolean).join(' · '))),
        t.hint ? h('div', { class: 'sub wrap mk-hint' }, h('span', null, t.hint)) : null),
      h('div', { class: 'end' }, url ? btn('Mở', () => soot.open(url), { icon: 'ext', k: `reply:open:${x.ref}`, aria: `Mở bình luận của ${x.author ?? 'người đọc'} trên ${M.CH[x.channel] ?? x.channel}` }) : null, done));
  });
  const more = drafted.length ? h('details', { class: 'mk-fold' },
    h('summary', null, ic('pen', 's14'), `${drafted.length} câu trả lời Biên tập soạn sẵn, chờ bạn duyệt`),
    ...drafted.map(x => row({ lead: sq('wait', 'hourglass'), title: `“${x.text}”`, sub: [pm(x.product), cm(x.channel), h('span', null, x.author ?? '')], end: tag('Chờ duyệt', 'wait'), onClick: () => openSheet('item', x.ref), wrap: true }))) : null;
  return card('Cần trả lời', need.length ? h('span', { class: 'muted' }, 'Soot không trả lời thay bạn') : null, ...rows, more,
    r.answered_week ? h('p', { class: 'mk-fine pad' }, `Tuần này đã trả lời ${M.num(r.answered_week)} bình luận thường sau khi bạn duyệt.`) : null);
}

// P2 ---------- Tuần này và tuần sau ----------

function gscAsk(b) {
  return ask('Nối Search Console cho các trang blog của bàn Marketing (gsc_sync), rồi cho tôi biết cần làm gì.', NOTE_ASKED, { request_id: 'ask-gsc-connect' }).catch(() => {});
}
function inputRow(inp) {
  const x = M.inputText(inp.code, { ...inp, now: Date.now() });
  let action = null;
  if (x.fix === 'ask_gsc') action = btn(x.button, () => gscAsk(), { k: `in:${inp.code}` });
  else if (x.fix === 'needs') action = btn(x.button, () => soot.open('nest://needs'), { icon: 'login', k: `in:${inp.code}` });
  else if (x.fix === 'video_links') action = btn(x.button, () => inp.first ? openSheet('item', inp.first) : go('content', 'scheduled'), { icon: 'link', k: `in:${inp.code}` });
  return h('div', { class: 'mk-row act' }, sq('', inp.code === 'video_links' ? 'link' : 'search'), h('div', { class: 'main' }, h('div', { class: 'ttl wrap' }, x.title), h('div', { class: 'sub wrap' }, h('span', null, x.hint))), action ? h('div', { class: 'end' }, action) : null);
}
function learnCard(L) {
  if (!L) return null;
  const c = ctx();
  const kids = [];
  const top = (L.top ?? []).slice(0, 3);
  if (top.length) {
    kids.push(h('div', { class: 'mk-group' }, ic('trend', 's12'), L.basis === 'gsc' ? 'Được tìm đọc nhiều nhất' : 'Được bấm nhiều nhất'));
    kids.push(...top.map((p, i) => row({ lead: h('span', { class: 'mk-rank num', 'aria-hidden': 'true' }, String(i + 1)), title: p.title, sub: [pm(p.product), h('span', null, M.topLine({ ...p, basis: L.basis }))], onClick: p.ref ? () => openSheet('item', p.ref) : M.safeLink(p.url) ? () => soot.open(p.url) : undefined })));
  }
  const qs = (L.queries ?? []).filter(q => !q.covered).slice(0, 3);
  if (qs.length) {
    kids.push(h('div', { class: 'mk-group' }, ic('search', 's12'), 'Người ta tìm mà chưa có bài'));
    kids.push(...qs.map(q => h('div', { class: 'mk-row act' }, h('span', { class: 'mk-rank q', 'aria-hidden': 'true' }, ic('search', 's12')),
      h('div', { class: 'main' }, h('div', { class: 'ttl wrap' }, `“${q.query}”`), h('div', { class: 'sub' }, pm(q.product), h('span', null, M.queryLine(q)))),
      h('div', { class: 'end' }, btn('Viết bài', () => openSheet('create', null, { product: q.product, format: 'blog', topic: `Bài cho người tìm “${q.query}” trên Google.` }), { cls: 'link', k: `q:${q.query}` })))));
  }
  if (L.next) {
    const n = L.next;
    kids.push(h('div', { class: 'mk-group' }, ic('bulb', 's12'), 'Tuần sau nên làm'));
    kids.push(h('div', { class: 'mk-row act mk-next' }, sq('', 'bulb'),
      h('div', { class: 'main' }, h('div', { class: 'ttl wrap' }, n.topic), h('div', { class: 'sub wrap' }, pm(n.product), h('span', null, M.nextWhy(n)))),
      h('div', { class: 'end' }, btn(`Giao cho ${M.MAKER[n.format] ?? 'Người viết'}`, () => openSheet('create', null, { product: n.product, format: n.format, topic: n.topic }), { k: 'next:give' }))));
  }
  const inputs = L.inputs ?? [];
  if (inputs.length) {
    if (kids.length) kids.push(h('div', { class: 'mk-group' }, ic('info', 's12'), 'Để biết rõ hơn'));
    kids.push(...inputs.slice(0, 2).map(inputRow));
  }
  if (!kids.length) kids.push(emptyRow('Chưa đủ số để học. Đăng vài bài rồi quay lại sau một tuần.'));
  const right = L.read_at ? h('span', { class: 'muted' }, L.basis === 'gsc' ? `số Google tới ${M.day(L.data_to ?? L.read_at, Date.now())}` : `đọc ${M.when(L.read_at, Date.now())}`) : null;
  return card('Tuần này và tuần sau', right, ...kids);
}

// ---------- Nội dung ----------

function stageSub(id, s) {
  const x = s?.sub ?? {};
  const n = s?.count ?? 0;
  switch (id) {
    case 'making': return [x.asked ? `${x.asked} đã giao` : null, x.revising ? `${x.revising} đang sửa` : null, x.stopped ? `${x.stopped} đã dừng` : null].filter(Boolean).join(', ');
    case 'approval': {
      const g = x.granted ?? 0;
      return n - g ? `${n - g} chờ bạn${g ? `, ${g} đã duyệt` : ''}` : g ? `${g} đã duyệt, Biên tập đang xếp lịch` : 'Không có bài chờ';
    }
    case 'scheduled': return [x.held ? `${x.held} đang đứng` : null, x.handoff ? `${x.handoff} chờ bạn đăng` : null].filter(Boolean).join(', ');
    // P2: Đã lên counts bài in the last 7 days, the same number as the tile; lượt đăng is the line under it.
    case 'live': return x.posts ? `${M.num(x.posts)} lượt đăng, 7 ngày` : 'trong 7 ngày';
  }
  return '';
}
function viewContent(v) {
  if (S.summary?.status?.code === 'empty') return emptyState();
  const strip = h('div', { class: 'mk-stages', role: 'group', 'aria-label': 'Giai đoạn' }, ...M.STAGES.map(s => {
    const st = v.stages?.[s.id];
    const warn = (s.id === 'approval' && st?.count) || (s.id === 'scheduled' && st?.sub?.held);
    return h('button', { type: 'button', class: warn ? 'warn' : '', 'aria-pressed': String(S.stage === s.id), 'data-k': `stage:${s.id}`, onclick: () => { S.stage = S.stage === s.id ? null : s.id; loadTab(); } },
      h('span', { class: 'k' }, ic(s.icon, 's12'), s.label), h('span', { class: 'v num' }, M.num(st?.count ?? 0)), h('span', { class: 's' }, stageSub(s.id, st)));
  }));
  const groups = [];
  for (const s of M.STAGES.slice().sort((a, b) => ORDER[a.id] - ORDER[b.id])) {
    const list = v.items.filter(i => i.stage === s.id);
    if (!list.length && (S.stage ? S.stage !== s.id : true)) continue;
    groups.push(h('div', { class: 'mk-group' }, ic(s.icon, 's12'), `${s.label} · ${v.stages?.[s.id]?.count ?? list.length}`));
    groups.push(...(list.length ? list.map(itemRowEl) : [emptyRow(s.id === 'approval' ? 'Không có bài nào chờ bạn duyệt.' : 'Trống.')]));
  }
  if (!groups.length) groups.push(emptyRow('Chưa có bài nào.'));
  // P2: bài lên trước 7 ngày are not counted in Đã lên; they are one press away, never hidden.
  const older = S.stage === 'live' && v.older_live ? btn(S.olderLive ? 'Chỉ 7 ngày qua' : `Xem bài lên trước đó (${M.num(v.older_live)})`, () => { S.olderLive = !S.olderLive; loadTab(); }, { cls: 'link', k: 'live:older' }) : null;
  const foot = h('div', { class: 'mk-more' },
    v.next_cursor ? btn(`Xem thêm (${v.items.length}/${v.total})`, (ev) => more(v, /** @type {any} */ (ev.currentTarget)), { cls: 'link', k: 'content:more' }) : null,
    v.next_cursor && (S.stage || older) ? h('span', { class: 'mk-dot' }, '·') : null,
    older, older && S.stage ? h('span', { class: 'mk-dot' }, '·') : null,
    S.stage ? btn('Mọi giai đoạn', () => { S.stage = null; S.olderLive = false; loadTab(); }, { cls: 'link', icon: 'left', k: 'stage:all' }) : null);
  return [strip, h('section', { class: 'mk-card' }, ...groups, v.next_cursor || S.stage ? foot : null)];
}
const ORDER = { approval: 0, scheduled: 1, making: 2, idea: 3, live: 4 };
async function more(v, b) {
  b.disabled = true;
  try {
    const next = await read('content', { stage: S.stage ?? undefined, cursor: v.next_cursor });
    S.views.content = { ...next, items: [...v.items, ...next.items] };
  } catch (e) { toast(M.errorText(e), 'err'); }
  renderMain();
}

// ---------- Kênh đăng ----------

function viewChannels(v) {
  const pub = v.publishers ?? {};
  const hl = M.hubLine(pub.hub, hubSource(), ctx());
  const pl = M.posterLine(pub.poster, ctx());
  const paused = !!pub.paused;
  const hubless = ctx().hubless;
  // P2: with no server nothing posts by itself, so there is nothing to pause.
  const pb = hubless ? null : btn(paused ? 'Bật lại mọi lượt đăng' : 'Tạm dừng mọi lượt đăng', () => pauseAll(!paused, pb), { icon: paused ? 'play' : 'pause', k: 'pause:all' });
  const top = card('Ai đưa bài lên', pb,
    row({ lead: sq(hl.tone === 'ok' ? 'ok' : hl.tone === 'err' ? 'err' : '', 'server'), title: `Máy chủ đăng bài${pub.hub?.host ? `, ${pub.hub.host}` : ''}`, sub: hl.text, wrap: true,
      end: hl.fix === 'connect' ? btn('Nối máy chủ', () => soot.open('nest://settings/setup?key=MARKETING_HUB'), { k: 'hub:connect2' }) : hl.fix === 'retry' ? btn('Thử lại', () => load(), { k: 'hub:retry2' }) : undefined }),
    hubless ? row({ lead: sq('', 'file'), title: 'Thư mục site của từng sản phẩm', sub: 'Duyệt xong, bàn ghi bài blog thành file Markdown. Bạn đưa trang lên như mọi khi.', wrap: true }) : null,
    row({ lead: sq(pl.tone, 'activity'), title: 'Máy đăng bài trên Mac này', sub: hubless ? 'Cần máy chủ đăng bài. Chưa có thì bài X, Facebook do bạn đăng tay rồi dán link.' : pl.text, wrap: true }),
    row({ lead: sq('', 'users'), title: 'Bạn', sub: 'TikTok, Reddit, Hacker News và gửi bản tin luôn là bạn bấm. Soot soạn sẵn, bạn đăng rồi dán link.', wrap: true }));
  const order = M.CHANNELS;
  const cellBtn = (r, ch) => {
    const c = { ...r.cells[ch], channel: ch };
    const x = M.cellText(c);
    return h('td', null, h('button', { type: 'button', class: `mk-cell ${x.tone}`, 'data-k': `cell:${r.product}:${ch}`, onclick: () => openSheet('channel', `${r.product}:${ch}`) },
      h('span', { class: 'l1' }, x.tone === 'err' ? ic('x_circle', 's12') : x.tone === 'ok' ? ic('check_circle', 's12') : null, x.l1), h('span', { class: 'l2' }, x.l2)));
  };
  const table = h('table', { class: 'mk-matrix' },
    h('thead', null, h('tr', null, h('th', null, 'Sản phẩm'), ...order.map(c => h('th', null, cm(c), M.CH[c])))),
    h('tbody', null, ...v.rows.map(r => h('tr', null, h('td', { class: 'p' }, h('b', null, pm(r.product), r.name), h('span', null, M.cadenceText(r.cadence, r.cells))), ...order.map(c => cellBtn(r, c))))));
  const cards = h('div', { class: 'mk-pcards' }, ...v.rows.map(r => card(r.name, h('span', { class: 'muted' }, M.cadenceText(r.cadence, r.cells)),
    ...order.filter(c => r.cells[c]?.state !== 'off').map(c => {
      const x = M.cellText({ ...r.cells[c], channel: c });
      return row({ lead: cm(c), title: M.CH[c], sub: x.l2, end: tag(x.l1, x.tone === 'none' || x.tone === '' ? 'idle' : x.tone), onClick: () => openSheet('channel', `${r.product}:${c}`) });
    }))));
  const add = h('div', { class: 'mk-more flat start' }, btn('Thêm sản phẩm', () => openSheet('setup', null), { cls: 'link', icon: 'plus', k: 'setup:add' }));
  return [top, v.rows.length ? h('section', { class: 'mk-card mk-wrap' }, table) : emptyRow('Chưa có sản phẩm nào.'), cards, add,
    h('p', { class: 'mk-foot' }, hubless ? 'Chưa có máy chủ đăng bài nên không có giờ đăng: bài duyệt xong được ghi vào site, hoặc chờ bạn đăng tay ở Hôm nay.' : 'Hồ sơ trình duyệt của máy đăng nằm ở Cài đặt › Trình duyệt. Giờ đăng X và Facebook là giờ khoảng chừng: máy đăng nhận bài theo lượt.')];
}

// ---------- Thư viện ----------

function viewLibrary(v) {
  if (v.why) {
    return h('section', { class: 'mk-card' }, h('div', { class: 'mk-emptystate' },
      h('span', { class: 'mk-soot', 'aria-hidden': 'true' }),
      h('h2', null, v.why === 'library_not_configured' ? 'Chưa chọn thư mục marketing' : 'Không đọc được thư mục marketing'),
      h('p', null, v.why === 'library_not_configured' ? 'Thư viện là thư mục marketing trên máy: bài viết, kênh video, radar và số liệu. Chọn thư mục ở Kho khóa (MARKETING_ROOT) thì nó hiện ở đây.' : 'Thư mục đã chọn không còn đọc được. Kiểm tra đường dẫn ở Kho khóa (MARKETING_ROOT).'),
      btn('Mở Kho khóa', () => soot.open('nest://settings/setup?key=MARKETING_ROOT'), { k: 'lib:setup' })));
  }
  const tree = h('nav', { class: 'mk-tree', 'aria-label': 'Thư viện' });
  const nodeBtn = (n, sub) => h('button', { type: 'button', class: sub ? 'sub' : '', 'aria-current': String(S.lib.node === n.id), 'data-k': `node:${n.id}`, onclick: () => { S.lib.pane = 'detail'; loadNode(n.id); } },
    ic(M.NODE_ICON[n.kind] ?? 'folder', 's14'), h('span', { class: 'nm' }, M.nodeLabel(n, ctx())),
    h('span', { class: 'ct' }, n.kind === 'metrics' ? '' : n.count === null || n.count === undefined ? '' : String(n.count)));
  for (const g of v.tree ?? []) {
    if (S.product && g.product && g.product !== S.product) continue;
    if (S.product && !g.product) continue;
    tree.append(h('div', { class: 'tl' }, g.product ? pm(g.product) : ic('folder', 's12'), M.nodeLabel(g, ctx())));
    for (const n of g.children ?? []) {
      tree.append(nodeBtn(n, false));
      for (const c of n.children ?? []) tree.append(nodeBtn(c, true));
    }
  }
  if (!(v.tree ?? []).length) tree.append(h('div', { class: 'note' }, 'Chưa thấy gì trong thư mục. Bấm Quét lại sau khi thêm file.'));
  const scan = btn('Quét lại thư mục', async () => {
    const out = await act('scan', {}, scan);
    if (!out) return;
    toast(out.added || out.changed || out.removed ? `Đã quét: ${out.added} mới, ${out.changed} đổi, ${out.removed} bỏ.` : 'Đã quét. Không có gì mới.');
    S.views.library = null;
    S.lib.detail = null;
    loadTab();
  }, { cls: 'link', icon: 'refresh', k: 'lib:scan' });
  tree.append(h('div', { class: 'tl gap' }, 'Trên máy'), h('div', { class: 'note' }, 'Mọi bài và video đều là file trong thư mục marketing bạn chọn ở Kho khóa.'), h('div', { class: 'note' }, scan));
  const detail = h('div', { class: 'mk-libd' },
    h('button', { type: 'button', class: 'mk-back quiet', onclick: () => { S.lib.pane = 'list'; renderMain(); } }, ic('left'), 'Thư viện'),
    libDetail());
  return h('div', { class: 'mk-lib', 'data-pane': S.lib.pane }, tree, detail);
}
const hd = (iconName, title, sub, action) => h('div', { class: 'hd' }, sq('', iconName), h('div', { class: 't' }, h('h2', null, title), sub ? h('p', null, sub) : null), action);
function libDetail() {
  if (S.lib.error) return h('div', { class: 'bd' }, notice('partial', 'x_circle', 'Không đọc được mục này', M.errorText(S.lib.error), btn('Thử lại', () => loadNode(S.lib.node), { k: 'node:retry' })));
  const d = S.lib.detail;
  if (S.lib.loading || (!d && S.lib.node)) return h('div', { class: 'bd' }, skRow(), skRow(), skRow());
  if (!d) return h('div', { class: 'bd' }, emptyRow('Chọn một mục bên trái.'));
  switch (d.kind) {
    case 'posts': return [hd('file', `Bài viết ${ctx().products[d.product]?.name ?? d.product}`, 'Mỗi bài một thư mục, mỗi ngôn ngữ một file'),
      h('div', { class: 'bd flush' }, ...(d.items.length ? d.items.map(itemRowEl) : [emptyRow('Chưa có bài nào.')]))];
    case 'series': case 'campaigns': return [hd('layers', d.series ? `Series ${d.series.title}` : `Chiến dịch ${d.channel}`, [d.series?.about, `${d.campaigns.length} chiến dịch`, `kênh ${d.channel}`].filter(Boolean).join(' · ')),
      h('div', { class: 'bd flush' }, ...(d.campaigns.length ? d.campaigns.map(c => row({ lead: sq(c.delivered ? 'ok' : '', 'clapper'), title: c.title, sub: [c.series ? `Series ${c.series}` : null, c.delivered ? 'đã xuất file' : `${c.stages.length} bước đã làm`].filter(Boolean).join(' · '), onClick: () => loadNode(`campaign:${d.channel}/${c.id}`) })) : [emptyRow('Chưa có chiến dịch nào.')]))];
    case 'campaign': return libCampaign(d);
    case 'radar': return libRadar(d);
    case 'metrics': return libMetrics(d);
    default: {
      const c = d.counts ?? {};
      return [hd('folder', d.kind === 'other' ? 'Kênh khác' : d.channel ?? ctx().products[d.product]?.name ?? '', d.kind === 'other' ? 'Kênh chưa thuộc sản phẩm nào: không có trong lịch và số liệu' : null),
        h('div', { class: 'bd' }, kv([['Bài viết', M.num(c.item)], ['Series', M.num(c.series)], ['Chiến dịch', M.num(c.campaign)], ['Radar', M.num(c.radar)], ['File số liệu', M.num(c.metrics)]]))];
    }
  }
}
function libCampaign(d) {
  const post = d.delivered && d.ref ? btn('Đăng tay', () => openSheet('item', d.ref), { icon: 'video', k: `post:${d.ref}` }) : null;
  return [hd('clapper', d.title, [d.series ? `Series ${d.series}` : null, d.channel, (d.platforms ?? []).join(', ')].filter(Boolean).join(' · '), post),
    h('div', { class: 'bd' },
      d.stages.length ? h('div', { class: 'mk-steps' }, ...d.stages.map(s => h('div', { class: 'mk-step done' }, h('i'), h('b', null, M.stageLabel(s))))) : null,
      kv([['Thư mục', d.path], ['Nền tảng', platforms(d.platforms)], ['Nhãn AI', d.ai_label === null || d.ai_label === undefined ? '—' : d.ai_label ? 'Bật khi đăng' : 'Không'],
        ['Kịch bản', d.owner ? `${d.owner.approved ? 'Bạn đã duyệt' : 'Chưa duyệt'}${d.owner.note ? `: “${d.owner.note}”` : ''}` : 'Chưa ghi ai duyệt'],
        ['Trạng thái', d.delivered ? 'Đã xuất file, chờ bạn đăng rồi dán link' : 'Người dựng video đang làm']]))];
}
function libRadar(d) {
  if (!d.rows) return [hd('radar', `Radar ${d.channel}, ${d.date}`, d.file), h('div', { class: 'bd' }, notice('plain', 'info', 'Chưa đọc được file radar', 'Cần thư mục marketing (MARKETING_ROOT) để đọc file này.'))];
  const picked = d.rows.filter(r => r.onboard === 'yes').length;
  const pick = (r, value, label) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(r.onboard === value), 'data-k': `mark:${r.n}:${value}`, onclick: async () => {
      const next = r.onboard === value ? null : value;
      const out = await act('mark', { file: d.file, row: r.n, onboard: next }, b);
      if (out) { r.onboard = out.onboard; renderMain(); }
    } }, label);
    return b;
  };
  return [hd('radar', `Radar ${d.channel}, ${M.nodeLabel({ kind: 'radar', label: d.date }, ctx()).replace(/^Radar /, '')}`, `${d.rows.length} bộ · ${picked ? `bạn chọn ${picked} bộ` : 'chưa chọn bộ nào'}`),
    h('div', { class: 'bd' },
      h('p', { class: 'lead' }, 'Chọn bộ nào nên đưa lên. Lựa chọn ghi thẳng vào cột Onboard? của file radar; đội nhập truyện đọc từ đó.'),
      h('div', { class: 'mk-scroll' }, h('table', { class: 'mk-table' },
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Truyện'), h('th', { class: 'hide-n' }, 'Tín hiệu'), h('th', null, 'Độ dài'), h('th', null, 'Đưa lên?'))),
        h('tbody', null, ...d.rows.map(r => h('tr', null,
          h('td', { class: 'n' }, String(r.n)),
          h('td', null, h('div', { class: 'nm' }, r.title || '—'), h('div', { class: 'cn' }, [r.genre, r.kind].filter(Boolean).join(' · '))),
          h('td', { class: 'hide-n small' }, r.signal || '—'),
          h('td', { class: 'small' }, r.length || '—'),
          h('td', null, h('div', { class: 'mk-pick', role: 'group', 'aria-label': `Đưa ${r.title} lên` }, pick(r, 'yes', 'Có'), pick(r, 'no', 'Không')))))))),
      h('div', { class: 'mk-more flat' }, h('span', { class: 'muted' }, `File ${d.file}`)))];
}
function libMetrics(d) {
  const rows = d.rows ?? [];
  return [hd('table', `Số liệu video, ${d.channel}`, rows.length ? `${rows.length} video` : 'Chưa ghi video nào'),
    h('div', { class: 'bd' }, h('div', { class: 'mk-scroll' }, h('table', { class: 'mk-table' },
      h('thead', null, h('tr', null, h('th', null, 'Ngày đăng'), h('th', null, 'Video'), h('th', { class: 'v' }, '48 giờ'), h('th', { class: 'v' }, '7 ngày'), h('th', null, 'Link'))),
      h('tbody', null, ...(rows.length ? rows.map(r => h('tr', null, h('td', { class: 'small' }, r.posted ?? '—'), h('td', null, h('div', { class: 'nm' }, r.slug ?? '—'), h('div', { class: 'cn' }, r.series ?? '')),
        h('td', { class: 'v small' }, M.num(r.views_48h)), h('td', { class: 'v small' }, M.num(r.views_7d)), h('td', null, M.safeLink(r.url) ? link('Mở', r.url, { icon: 'ext' }) : r.ref ? btn('Dán link', () => openSheet('item', r.ref, { batch: true }), { cls: 'link', icon: 'link', k: `ml:${r.ref}` }) : '—')))
        : [h('tr', null, h('td', { colspan: '5', class: 'empty' }, 'Chưa ghi video nào. Đăng video rồi dán link ở thẻ của video; bàn tự ghi dòng ở đây.'))])))),
    h('p', { class: 'mk-fine' }, '“—” là chưa đo được, không phải 0.'))];
}

// ---------- Số liệu ----------

function viewNumbers(v) {
  const c = ctx();
  const byP = new Map();
  for (const r of v.rows) { if (!byP.has(r.product)) byP.set(r.product, []); byP.get(r.product).push(r); }
  const cur = S.week === null;
  const weekNav = h('span', { class: 'row' },
    btn('', () => { S.week = v.week.prev; loadTab(); }, { cls: 'ico', icon: 'left', aria: 'Tuần trước', k: 'week:prev' }),
    cur ? null : btn('', () => { const n = M.shiftWeek(v.week.id, 1); S.week = n; loadTab(); }, { cls: 'ico', icon: 'right', aria: 'Tuần sau', k: 'week:next' }),
    cur ? null : btn('Tuần này', () => { S.week = null; loadTab(); }, { cls: 'link', k: 'week:now' }));
  const body = [];
  for (const [pid, rows] of byP) {
    body.push(h('tr', { class: 'prod' }, h('td', { colspan: '6' }, pm(pid), ' ', c.products[pid]?.name ?? pid)));
    for (const r of rows) {
      const why = M.whyText(r.why, r.why_args);
      body.push(h('tr', null,
        h('td', null, cm(r.channel), ' ', M.CH[r.channel] ?? r.channel, why ? h('div', { class: 'why-n' }, why) : null),
        h('td', { class: r.published === null ? 'v dash' : 'v' }, M.num(r.published)),
        h('td', { class: r.prev === null ? 'v hide-n dash' : 'v hide-n' }, M.num(r.prev)),
        h('td', { class: r.views === null ? 'v dash' : 'v', title: r.views_kind === 'impressions' ? 'Lượt hiện trên Google' : null }, M.num(r.views)),
        h('td', { class: r.clicks === null ? 'v dash' : 'v' }, M.num(r.clicks)),
        h('td', { class: 'hide-n muted small' }, why)));
    }
  }
  const table = h('section', { class: 'mk-card mk-wrap' },
    h('div', { class: 'mk-ch' }, h('span', null, `Tuần ${M.weekLabel(v.week)}`), weekNav, h('span', { class: 'sp' }), h('span', { class: 'muted' }, '“—” là chưa đo được, không phải 0')),
    body.length ? h('table', { class: 'mk-table mk-ntable' },
      h('thead', null, h('tr', null, h('th', null, 'Kênh'), h('th', { class: 'v', title: 'Một bài lên một kênh là một lượt đăng' }, 'Lượt đăng'), h('th', { class: 'v hide-n' }, 'Tuần trước'), h('th', { class: 'v' }, 'Lượt xem'), h('th', { class: 'v' }, 'Bấm vào'), h('th', { class: 'hide-n' }, 'Vì sao chưa có số'))),
      h('tbody', null, ...body)) : emptyRow('Chưa có kênh nào để đếm.'));
  const whys = new Set(v.rows.map(r => r.why));
  const handoffs = v.rows.filter(r => r.why === 'no_posted_links').reduce((n, r) => n + (r.why_args?.n ?? 0), 0);
  const gaps = [];
  if (whys.has('search_console_not_connected')) {
    // P2: the sign-in, once asked, waits in Cần bạn; the row then points there instead of asking again.
    const gsc = S.summary?.gsc;
    const b = gsc?.state === 'needs_person' ? btn('Mở Cần bạn', () => soot.open('nest://needs'), { icon: 'login', k: 'gap:gsc' }) : btn('Nhờ Biên tập nối', () => gscAsk(), { k: 'gap:gsc' });
    gaps.push(row({ lead: sq('', 'chart'), title: gsc?.state === 'needs_person' ? 'Search Console chờ bạn đăng nhập Google' : 'Nối Search Console', sub: 'Thấy lượt hiện và lượt bấm của từng bài blog trên Google', wrap: true, end: b }));
  }
  const firstVideo = v.rows.find(r => r.why === 'no_posted_links')?.why_args?.first ?? null;
  if (handoffs) gaps.push(row({ lead: sq('', 'link'), title: `Dán link ${handoffs} video TikTok đã đăng`, sub: 'Có link thì Soot đọc lượt xem 48 giờ và 7 ngày', wrap: true, end: btn('Dán link', () => firstVideo ? openSheet('item', firstVideo, { batch: true }) : go('content', 'scheduled'), { icon: 'link', k: 'gap:videos' }) }));
  if (whys.has('not_read_yet')) gaps.push(row({ lead: sq('', 'info'), title: 'Chưa đếm người đọc mạng xã hội', sub: 'Máy chủ đăng bài ghi bài nào đã lên, chưa ghi ai đọc. Lượt xem X và Facebook là “—” cho tới khi có nguồn số.', wrap: true }));
  if (whys.has('by_hand')) gaps.push(row({ lead: sq('', 'info'), title: 'Bài bạn đăng tay chưa có số', sub: 'Bàn đếm lượt đăng từ link bạn dán; lượt xem trên X, Facebook và cộng đồng là “—”.', wrap: true }));
  return [table, gaps.length ? card('Để có số người đọc', null, ...gaps) : null];
}

const TAB = { today: viewToday, content: viewContent, channels: viewChannels, library: viewLibrary, numbers: viewNumbers };

// ---------- sheets ----------

function openSheet(kind, key, form = {}) {
  // A sheet opened from another sheet keeps the first opener, so Esc returns focus to the page.
  const opener = S.sheet?.opener ?? document.activeElement;
  S.sheet = { kind, key, data: null, error: null, form: { ...form }, opener, extra: null };
  renderSheet(true);
  fetchSheet();
}
/**
 * Close from the sheet's own close, the scrim or Esc. A setup with typed input
 * asks once ("Bỏ phần đã nhập?") before it drops what was typed.
 */
function requestClose() {
  const s = S.sheet;
  if (s?.kind === 'setup' && s.form.dirty && !s.form.saved && !s.form.askClose) {
    s.form.askClose = true;
    renderSheet();
    /** @type {HTMLElement | null} */ (sheetHost.querySelector('[data-k="su:drop"]'))?.focus();
    return;
  }
  closeSheet();
}
function closeSheet() {
  const opener = S.sheet?.opener;
  S.sheet = null;
  renderSheet();
  if (opener && opener.isConnected) opener.focus();
}
async function fetchSheet() {
  const s = S.sheet;
  if (!s) return;
  try {
    if (s.kind === 'setup') s.data = { hub: hubSource() };
    else if (s.kind === 'item' || s.kind === 'uncertain') s.data = await read('item', { ref: String(s.key).split(':')[0], product: undefined });
    else if (s.kind === 'channel') s.data = await read('channel', { key: s.key, product: undefined });
    else if (s.kind === 'create') {
      const [ch, lib] = await Promise.allSettled([S.views.channels ? Promise.resolve(S.views.channels) : read('channels', { product: undefined }), S.views.library ? Promise.resolve(S.views.library) : read('library', { product: undefined })]);
      s.data = { channels: ch.status === 'fulfilled' ? ch.value : null, library: lib.status === 'fulfilled' ? lib.value : null };
    }
    s.error = null;
  } catch (e) { s.error = e; }
  if (S.sheet === s) renderSheet(true);
}
/** A live refresh redraws an open sheet only while nothing in it is being typed. */
async function refreshSheet() {
  const s = S.sheet;
  if (!s || s.kind === 'create' || s.kind === 'setup' || s.form.dirty || s.form.editing) return;
  if (sheetHost.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) return;
  await fetchSheet();
}
function renderSheet(focus = false) {
  const s = S.sheet;
  if (!s) { sheetHost.replaceChildren(); return; }
  const parts = s.error ? sheetFailed(s) : !s.data ? sheetLoading(s) : SHEET[s.kind](s);
  const aside = h('aside', { class: `mk-sheet ${parts.w ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
    h('div', { class: 'sh' }, h('div', { class: 't' }, h('h2', { id: 'sheet-title', tabindex: '-1' }, parts.title), parts.sub ? h('p', null, ...parts.sub) : null),
      btn('', requestClose, { cls: 'ico', icon: 'x', iconCls: '', aria: 'Đóng' })),
    h('div', { class: 'sb' }, ...parts.body),
    parts.foot ? h('div', { class: 'sf' }, ...parts.foot) : null);
  sheetHost.replaceChildren(h('div', { class: 'mk-scrim', onclick: requestClose }), aside);
  if (focus) /** @type {HTMLElement} */ (aside.querySelector('#sheet-title'))?.focus();
}
const sheetLoading = (s) => ({ title: s.kind === 'create' ? 'Tạo nội dung' : s.kind === 'setup' ? (S.summary?.products?.length ? 'Thêm sản phẩm' : 'Bắt đầu marketing') : 'Đang mở…', sub: null, body: [skRow(), skRow(), skRow()], foot: null, w: s.kind === 'setup' ? 'w480' : s.kind === 'create' ? 'w520' : '' });
const sheetFailed = (s) => ({ title: 'Không mở được', sub: null, body: [notice('partial', 'x_circle', 'Chưa đọc được mục này', M.errorText(s.error), btn('Thử lại', () => { s.error = null; renderSheet(); fetchSheet(); }))], foot: null });
const productSub = (pid, ...rest) => [pm(pid), [ctx().products[pid]?.name ?? (pid || 'Kênh khác'), ...rest].filter(Boolean).join(' · ')];

function planBlock(d) {
  const plan = d.plan ?? [];
  if (!plan.length) return null;
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('send', 's12'), 'Lên ở đâu, lúc nào'),
    h('div', { class: 'mk-plan' }, ...plan.map(p => {
      const x = M.planText(p, ctx(), d.state);
      const url = M.safeLink(p.url);
      return h('div', { class: 'mk-row' }, cm(p.channel, ['no_account', 'channel_not_connected'].includes(p.state)),
        h('div', { class: 'main' }, h('div', { class: 'ttl' }, [M.CH[p.channel] ?? p.channel, p.account].filter(Boolean).join(' · '), p.lang && d.plan.filter(q => q.channel === p.channel).length > 1 ? h('span', { class: 'muted' }, ` ${M.LANG[p.lang] ?? p.lang}`) : null),
          h('div', { class: 'sub' }, h('span', null, x.line))),
        h('div', { class: 'end' }, url ? link('Mở', url) : null, tag(x.tag, x.tone)));
    })),
    plan.some(p => p.about) ? h('p', { class: 'mk-fine' }, 'X và Facebook lên khoảng giờ ghi: máy đăng nhận bài theo lượt.') : null);
}
function langBlock(l) {
  const where = [M.LANG[l.lang] ?? l.lang, l.site && l.slug ? `${l.site}/${l.slug}` : null].filter(Boolean).join(' · ');
  const bl = M.blocks(l.body, 60);
  const art = h('article', { class: 'mk-art' }, l.summary ? h('p', { class: 'lead' }, l.summary) : null,
    ...(bl.length ? groupList(bl) : [h('p', { class: 'muted' }, l.body === null ? 'Chưa đọc được nội dung bài này.' : 'Bài trống.')]));
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('file', 's12'), where), l.title ? h('h4', null, l.title) : null, art,
    h('div', { class: 'row' }, M.safeLink(l.preview) ? link('Xem như trên blog', l.preview) : null, M.safeLink(l.url) ? link('Mở bài đã lên', l.url) : null));
}
function groupList(bl) {
  const out = [];
  let ul = null;
  for (const b of bl) {
    if (b.kind === 'li') { if (!ul) { ul = h('ul'); out.push(ul); } ul.append(h('li', null, b.text)); continue; }
    ul = null;
    out.push(b.kind === 'h' ? h('h4', null, b.text) : h('p', null, b.text));
  }
  return out;
}
function postsBlock(d) {
  if (!d.posts.length) return null;
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('file', 's12'), d.posts.length > 1 ? 'Nguyên văn từng kênh' : 'Nguyên văn'),
    h('div', { class: d.posts.length > 1 ? 'mk-langs' : 'mk-langs one' }, ...d.posts.map(p => h('div', { class: 'mk-lang' },
      h('div', { class: 'lh' }, cm(p.channel), h('b', null, String(p.lang ?? '').toUpperCase()), M.CH[p.channel] ?? p.channel),
      h('div', { class: 'body' }, p.text ?? 'Chưa đọc được nội dung.'),
      p.note ? h('div', { class: 'cnt' }, p.note) : null,
      p.len !== null ? h('div', { class: 'cnt' }, `${M.num(p.len)}${p.max ? `/${M.num(p.max)}` : ''} ký tự`) : null))));
}
function urlField(s, channel, account, extra) {
  const input = h('input', { id: 'f-url', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: channel === 'tiktok' ? 'https://www.tiktok.com/@…/video/…' : channel === 'x' ? 'https://x.com/…/status/…' : 'https://…', 'aria-describedby': 'f-url-hint', value: s.form.url ?? '' });
  if (s.form.bad) input.setAttribute('aria-invalid', 'true');
  input.addEventListener('input', () => { s.form.url = /** @type {HTMLInputElement} */ (input).value; s.form.dirty = true; input.removeAttribute('aria-invalid'); });
  return h('div', { class: 'mk-field' }, h('label', { for: 'f-url' }, channel === 'tiktok' ? 'Link video đã đăng' : channel === 'blog' ? 'Link bài trên trang' : 'Link bài đã đăng'), input,
    h('span', { class: s.form.bad ? 'err-hint' : 'hint', id: 'f-url-hint' }, `${M.URL_HINT[channel] ?? ''}${account ? ` Tài khoản ${account}.` : ''}${extra ? ` ${extra}` : ''}`));
}
async function confirmPost(s, d, outcome, channel, lang, b) {
  const url = String(s.form.url ?? '').trim();
  if (outcome === 'posted' && !M.validUrl(channel, url)) { s.form.bad = true; renderSheet(); /** @type {HTMLElement} */ (sheetHost.querySelector('#f-url'))?.focus(); return; }
  // P2: a community link is stored on the community channel; its kind only picks the link rule.
  const ch = ['reddit', 'hn', 'devto', 'other'].includes(channel) ? 'community' : channel;
  // The server checks the link too (422 bad_url): the same hint turns red in place, nothing is saved.
  const inPlace = (e) => { if (e?.code !== 'bad_url' || outcome !== 'posted') return false; s.form.bad = true; renderSheet(); /** @type {HTMLElement} */ (sheetHost.querySelector('#f-url'))?.focus(); return true; };
  const out = await act('confirm', { ref: d.ref, outcome, ...(outcome === 'posted' ? { url } : {}), ...(ch !== 'tiktok' ? { channel: ch, ...(lang ? { lang } : {}) } : {}) }, b, { onError: inPlace });
  if (!out) return;
  // P2: pasting TikTok links runs as a batch: the next video opens in place of the one just saved.
  if (channel === 'tiktok' && d.queue?.next) { openSheet('item', d.queue.next); toast(`Đã ghi link ${d.queue.pos}/${d.queue.total}. Video kế tiếp.`); load({ quiet: true }); return; }
  closeSheet();
  toast(channel === 'tiktok' ? 'Đã ghi link. Lượt xem có sau 48 giờ.' : channel === 'reddit' ? 'Đã ghi link. Soot theo dõi bình luận; bình luận cần bạn hiện ở Hôm nay.' : outcome === 'posted' ? 'Đã ghi link. Bài nằm ở Đã lên.' : 'Đã đưa về nháp. Không có gì đăng lại khi bạn chưa duyệt.');
  load({ quiet: true });
}

// P2 ---------- copy, pretest, kinds ----------

/** Copy text for the founder. The frame may refuse the clipboard; the text is then selected for ⌘C. */
function copyBtn(text, label, k, cls) {
  const b = btn(label, async () => {
    try { await navigator.clipboard.writeText(text); toast('Đã chép.'); return; } catch { /* sandboxed frame: fall back */ }
    const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'mk-copybuf', readonly: true, 'aria-label': label }));
    ta.value = text;
    b.after(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    if (ok) { ta.remove(); toast('Đã chép.'); } else toast('Chưa chép được. Chữ đã được chọn sẵn: bấm ⌘C.', 'err');
  }, { icon: 'copy', k, cls });
  return b;
}
function pretestBlock(s, d, where) {
  const c = ctx();
  let x = M.pretestText(d.pretest, c);
  if (x.state === 'none' && ability('micro_fish') === false) x = M.pretestText({ state: 'unavailable' }, c);
  // Top of the sheet: a result (or a run) is read before the article. Bottom: the offer to run one.
  const top = ['done', 'running', 'failed'].includes(x.state);
  if ((where === 'top') !== top) return null;
  const run = (label, cls) => btn(label, () => ask(`Thử bài ${d.ref} (${d.title}) với người đọc giả lập bằng Micro Fish, rồi lưu kết luận vào bài (item_save meta pretest).`, 'Đã nhờ Biên tập thử. Kết luận hiện ở đây khi xong.', { request_id: `pretest-${d.ref}-${d.revision ?? 1}${x.state === 'none' ? '' : `-${Date.now() % 1e6}`}` }).then(() => load({ quiet: true })).catch(() => {}), { cls, icon: 'flask', k: 'pretest:run' });
  const h3 = h('h3', null, ic('flask', 's12'), 'Thử với người đọc giả lập');
  switch (x.state) {
    case 'none': return h('div', { class: 'mk-sec' }, h3,
      h('div', { class: 'mk-row act flat' }, h('div', { class: 'main' }, h('div', { class: 'sub wrap' }, h('span', null, 'Một nhóm người đọc giả lập gặp bài này giữa các bài khác trên bảng tin, rồi nói họ có đọc tiếp không và vì sao. Mất 5–10 phút, tính vào ngân sách AI của đội. Cần một chỗ chạy người đọc giả lập đã lập sẵn; chưa có thì Biên tập báo lại và bàn chỉ cách lập.'))),
        h('div', { class: 'end' }, run('Thử với người đọc giả lập'))));
    case 'unavailable': return h('div', { class: 'mk-sec' }, h3,
      h('div', { class: 'mk-row act flat' }, h('div', { class: 'main' }, h('div', { class: 'ttl wrap' }, x.title), h('div', { class: 'sub wrap' }, h('span', null, `${x.hint} Duyệt không cần bước này.`))),
        h('div', { class: 'end' }, btn('Nhờ Lead lập', () => toLead(M.PRETEST_SETUP_ASK), { icon: 'send', k: 'pretest:add' }))));
    case 'running': return h('div', { class: 'mk-verdict run', role: 'status' }, sq('run', 'flask'), h('div', { class: 'main' }, h('b', null, x.title), h('span', null, x.hint)));
    case 'failed': return h('div', { class: 'mk-verdict', role: 'status' }, sq('wait', 'flask'), h('div', { class: 'main' }, h('b', null, x.title), h('span', null, x.hint)), h('div', { class: 'end' }, run('Thử lại')));
    case 'done': {
      const report = d.pretest.conversation_id ? btn('Xem cả báo cáo', () => soot.open(`nest://conversation/${encodeURIComponent(d.pretest.conversation_id)}`), { cls: 'link', icon: 'ext', k: 'pretest:report' }) : null;
      return h('div', { class: `mk-verdict ${x.tone}` },
        sq(x.tone === 'ok' ? 'ok' : x.tone === 'err' ? 'err' : 'wait', x.tone === 'ok' ? 'check_circle' : x.tone === 'err' ? 'x_circle' : 'pen'),
        h('div', { class: 'main' },
          h('span', { class: 'k' }, 'Người đọc giả lập nói'),
          h('b', null, x.title),
          h('span', null, x.line),
          x.reasons.length ? h('ul', null, ...x.reasons.map(r => h('li', null, r))) : null,
          x.stale ? h('span', { class: 'mk-fine' }, 'Bài đã sửa sau lần thử này.') : null,
          // P2: the desk cannot reject; say where a fix starts when the verdict asks for one.
          x.tone !== 'ok' && d.state === 'approval' ? h('span', { class: 'mk-fine' }, 'Muốn sửa: bấm Duyệt… rồi Từ chối trên thẻ duyệt, dán lý do làm ghi chú. Người viết sửa rồi bài về đây.') : null,
          h('div', { class: 'row' }, report, x.reasons.length && d.state === 'approval' ? copyBtn(x.reasons.join('\n'), 'Chép lý do', 'pretest:copy', 'link') : null, run('Thử lại', 'link'))));
    }
  }
  return null;
}
/** P2: the channels this item will not reach, said before the founder approves. */
function skipWarning(d, skipped) {
  const names = [...new Set(skipped.map(p => M.CH[p.channel] ?? p.channel))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} và ${names[names.length - 1]}` : names[0];
  const noAcc = skipped.every(p => p.state === 'no_account');
  const reach = (d.plan ?? []).filter(p => !skipped.includes(p)).map(p => M.CH[p.channel] ?? p.channel);
  const first = skipped[0];
  return notice('warn', 'alert', `${list} chưa ${noAcc ? 'có tài khoản' : 'nối'}: duyệt thì ${skipped.length > 1 ? `${skipped.length} bài này` : `bài ${list}`} không lên`,
    `${reach.length ? `${[...new Set(reach)].join(', ')} vẫn lên sau khi bạn duyệt. ` : ''}Phần cho ${list} nằm lại làm nháp; ${noAcc ? 'có tài khoản' : 'nối kênh'} xong thì Biên tập xin bạn duyệt riêng phần đó.`,
    d.product ? btn('Sửa kênh', () => openSheet('channel', `${d.product}:${first.channel}`), { k: 'skip:fix' }) : null);
}
function communityBlock(d, s) {
  const c = d.community;
  if (!c) return null;
  const where = c.target?.label ?? M.targetText(c.target);
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('users', 's12'), `Bài cho ${where}`),
    h('div', { class: 'mk-langs one' },
      h('div', { class: 'mk-lang' }, h('div', { class: 'lh' }, h('b', null, 'Tiêu đề')), h('div', { class: 'body' }, c.title ?? '—'),
        c.title_max ? h('div', { class: 'cnt' }, `${M.num((c.title ?? '').length)}/${M.num(c.title_max)} ký tự`) : null),
      h('div', { class: 'mk-lang' }, h('div', { class: 'lh' }, h('b', null, c.target?.kind === 'hn' ? 'Link hoặc nội dung' : 'Nội dung')), h('div', { class: 'body' }, c.body ?? '—'))),
    c.target?.rules ? h('p', { class: 'mk-fine' }, `Luật của ${where}: ${c.target.rules}`) : null);
}
function newsBlock(d) {
  const n = d.newsletter;
  if (!n) return null;
  const bl = M.blocks(n.body, 40);
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('mail', 's12'), 'Thư'),
    kv([['Tiêu đề thư', n.subject], ['Dòng xem trước', n.preheader], ['Người nhận', n.subscribers === null || n.subscribers === undefined ? 'Chưa có danh sách người nhận' : `${M.num(n.subscribers)} người đăng ký`]]),
    h('article', { class: 'mk-art' }, ...(bl.length ? groupList(bl) : [h('p', { class: 'muted' }, 'Chưa đọc được nội dung thư.')])));
}
/** P2: the newsletter after approval: send through the team's email, or export for the founder's own tool. */
function sendBlock(s, d) {
  const n = d.newsletter ?? {};
  const email = ability('email');
  const out = [];
  if (d.state === 'sending') out.push(notice('plain', 'send', 'Chờ bạn duyệt lần gửi', `Biên tập đã soạn lần gửi tới ${M.num(n.subscribers ?? 0)} người. Nest hỏi bạn trong Cần bạn; thư đi khi bạn bấm duyệt ở đó.`));
  else if (email === false) out.push(notice('plain', 'info', 'Đội chưa gửi được email', 'Xuất thư ra file rồi gửi bằng công cụ bạn đang dùng.', btn('Nhờ Lead thêm email', () => toLead('Thêm pack email cho Biên tập của đội Marketing để gửi bản tin sau khi tôi duyệt.'), { cls: 'link', icon: 'send', k: 'nl:add' })));
  else if (email !== false && d.state === 'handoff' && n.subscribers) {
    // The link needs the team's id; a host that does not name the team gets the words without the link.
    const team = S.summary?.team?.id ?? null;
    out.push(h('p', { class: 'mk-fine' }, 'Bấm Gửi thì Nest hỏi bạn duyệt lần gửi một lần nữa, vì gửi email là việc ra ngoài. Không muốn hỏi lại: đặt Gửi email là Tự làm trong ',
      team ? btn('Quyền của đội', () => soot.open(`nest://team/${encodeURIComponent(team)}/perms`), { cls: 'link', k: 'nl:perms' }) : 'Quyền của đội', '.'));
  }
  if (n.subscribers === null || n.subscribers === undefined) out.push(subscribersBlock(s, d.product, null));
  if (n.export) {
    // The files are on this machine: copy a path and open it in the founder's own mail tool. Đã gửi xong is the footer's.
    const paths = n.export.paths ?? [];
    const kind = (p) => (/\.html$/.test(p) ? 'HTML' : /\.txt$/.test(p) ? 'chữ' : '');
    const team = teamFolder(d);
    out.push(h('div', { class: 'mk-sec' }, h('h3', null, ic('download', 's12'), 'Đã xuất ra file'),
      kv([['Lúc', M.when(n.export.at, Date.now())], ['File', (n.export.files ?? []).join(', ')], ['Ở đâu', team ? `Trong ${TEAM_FOLDER_WHERE}` : 'Thư mục bản tin của sản phẩm, trong thư mục marketing']]),
      paths.length && team ? h('p', { class: 'mk-fine' }, TEAM_FOLDER_HOW) : null,
      paths.length ? h('div', { class: 'row' }, ...paths.map((p, i) => copyBtn(p, paths.length > 1 && kind(p) ? `Chép đường dẫn bản ${kind(p)}` : 'Chép đường dẫn', `nl:path:${i}`)), team ? pickFolderBtn('nl:root') : null) : null));
  }
  return out;
}
/** The newsletter's recipients, pasted on the desk: one address a line. The desk writes the list to the product's
 *  newsletter folder and only ever shows how many people it holds. */
function subscribersBlock(s, product, count) {
  const f = s.form;
  const has = count !== null && count !== undefined;
  const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'f-subs', rows: '4', maxlength: '100000', placeholder: 'ten@vidu.vn\nban@vidu.vn', 'aria-describedby': 'f-subs-hint', 'aria-invalid': f.subsBad ? 'true' : null, autocomplete: 'off', spellcheck: 'false' }));
  ta.value = f.subs ?? '';
  ta.addEventListener('input', () => { f.subs = ta.value; f.dirty = true; if (f.subsBad) { f.subsBad = false; ta.removeAttribute('aria-invalid'); } });
  const save = btn(has ? 'Thay danh sách' : 'Lưu danh sách', async () => {
    const list = String(f.subs ?? '').trim();
    if (!list) { f.subsBad = true; renderSheet(); /** @type {HTMLElement} */ (sheetHost.querySelector('#f-subs'))?.focus(); return; }
    const out = await act('subscribers', { product, list }, save, { onError: (e) => { if (e?.code !== 'no_addresses') return false; f.subsBad = true; renderSheet(); return true; } });
    if (!out) return;
    f.subs = ''; f.subsBad = false; f.dirty = false;
    toast(`Đã lưu ${M.num(out.count)} người nhận${out.skipped ? `, bỏ ${M.num(out.skipped)} dòng không phải địa chỉ` : ''}.`);
    if (S.sheet) S.sheet.data = null;
    fetchSheet();
    load({ quiet: true });
  }, { cls: has ? '' : 'primary', icon: 'mail', k: 'subs:save' });
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('mail', 's12'), has ? `${M.num(count)} người nhận` : 'Chưa có danh sách người nhận'),
    h('div', { class: 'mk-field' }, h('label', { for: 'f-subs' }, has ? 'Thay bằng danh sách mới' : 'Dán địa chỉ email, mỗi dòng một người'), ta,
      h('span', { class: f.subsBad ? 'err-hint' : 'hint', id: 'f-subs-hint' }, f.subsBad ? 'Chưa thấy địa chỉ email nào. Mỗi dòng một địa chỉ, ví dụ ten@vidu.vn.' : `${has ? 'Lưu thì thay cả danh sách cũ. ' : ''}Bàn ghi vào thư mục bản tin của sản phẩm và chỉ hiện số người, không hiện địa chỉ.`)),
    h('div', { class: 'row' }, save));
}
function exportBtn(d, cls) {
  const b = btn(d.newsletter?.export ? 'Xuất lại' : 'Xuất ra file', async () => {
    const out = await act('export', { ref: d.ref }, b);
    if (!out) return;
    toast(`Đã xuất ${(out.files ?? []).length} file vào thư mục bản tin.`);
    S.sheet && (S.sheet.data = null);
    fetchSheet();
  }, { cls, icon: 'download', k: 'nl:export' });
  return b;
}
/** P2: a social post the founder posts by hand (no máy đăng for this channel). */
function handSocialBlock(s, d, p) {
  const post = d.posts.find(x => x.channel === p.channel && (!p.lang || x.lang === p.lang)) ?? d.posts[0];
  const open = p.channel === 'x' ? 'https://x.com/compose/post' : p.channel === 'facebook' ? 'https://www.facebook.com/' : null;
  const left = (d.plan ?? []).filter(q => q.state === 'handoff').length;
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('send', 's12'), `Đăng tay lên ${M.CH[p.channel] ?? p.channel}${left > 1 ? ` (còn ${left} bài)` : ''}`),
    h('ol', { class: 'mk-steplist' },
      h('li', null, h('div', { class: 'grow' }, h('b', null, 'Chép bài'), h('span', null, `${M.num(post?.len ?? (post?.text ?? '').length)} ký tự${p.account ? `, cho ${p.account}` : ''}.`), h('div', null, copyBtn(post?.text ?? '', 'Chép bài', 'cp:post')))),
      open ? h('li', null, h('div', { class: 'grow' }, h('b', null, `Mở ${M.CH[p.channel]}`), h('span', null, 'Dán bài rồi bấm Đăng.'), h('div', null, link(`Mở ${M.CH[p.channel]}`, open, { cls: '' })))) : null,
      h('li', null, h('div', { class: 'grow' }, h('b', null, 'Dán link bài đã đăng'), urlField(s, p.channel, p.account)))));
}

/** The library is the team's own folder (the default): a hidden folder of Soot that Finder and the file picker do
 *  not show. A hand-off then says where its file is in words and offers a folder the founder can open. */
function teamFolder(d) { return ((d?.sources ?? S.summary?.sources ?? []).find(x => x.id === 'library')?.root_kind) === 'team'; }
const TEAM_FOLDER_WHERE = 'thư mục riêng của đội, một thư mục ẩn trên máy chạy Soot mà Finder không hiện sẵn';
const TEAM_FOLDER_HOW = 'Chép đường dẫn, rồi ở ô chọn file bấm ⌘⇧G và dán vào.';
const pickFolderBtn = (k) => btn('Chọn thư mục dễ mở hơn', () => soot.open('nest://settings/setup?key=MARKETING_ROOT'), { cls: 'link', icon: 'folder', k });

/** The TikTok hand-off, in the same steps as X and Facebook: copy the caption, copy the video's path, paste the link. */
function handTiktokBlock(s, d) {
  const v = d.video ?? {};
  const tk = v.tiktok ?? null;
  const account = v.account ?? null;
  const team = teamFolder(d);
  return h('div', { class: 'mk-sec' }, h('h3', null, ic('video', 's12'), `Đăng tay lên TikTok${account ? `, ${account}` : ''}`),
    h('ol', { class: 'mk-steplist' },
      tk?.caption ? h('li', null, h('div', { class: 'grow' }, h('b', null, 'Chép chú thích'), h('span', null, `${M.num([...tk.caption].length)} ký tự.`), h('div', null, copyBtn(tk.caption, 'Chép chú thích', 'cp:caption')))) : null,
      h('li', null, h('div', { class: 'grow' }, h('b', null, 'Chọn file video'),
        h('span', null, tk?.path && team ? `Video nằm trong ${TEAM_FOLDER_WHERE}. ${TEAM_FOLDER_HOW}` : tk?.path ?? (tk?.file ? `${tk.file}, trong thư mục marketing` : 'Trong thư mục 08-delivery của chiến dịch.')),
        tk?.path ? h('div', { class: 'row' }, copyBtn(tk.path, 'Chép đường dẫn', 'cp:video'), team ? pickFolderBtn('cp:root') : null) : null)),
      h('li', null, h('div', { class: 'grow' }, h('b', null, 'Mở TikTok'), h('span', null, `Tải video lên${account ? ` bằng ${account}` : ''}, dán chú thích rồi bấm Đăng.`), h('div', null, link('Mở TikTok', 'https://www.tiktok.com/upload', { cls: '', k: 'tk:open' })))),
      h('li', null, h('div', { class: 'grow' }, h('b', null, 'Dán link video đã đăng'), urlField(s, 'tiktok', account)))));
}

function sheetItem(s) {
  const d = s.data;
  const by = d.by ? M.WHO[d.by] ?? d.by : null;
  const body = [];
  const foot = [];
  const canStop = M.ITEM_REF.test(d.ref);
  // Spec §5.1: verdict, state notice, content, hand-off, pre-test offer, plan, technical details.
  const pt = pretestBlock(s, d, 'top');
  if (pt) body.push(pt);
  const skipped = d.state === 'approval' ? (d.plan ?? []).filter(p => ['no_account', 'channel_not_connected'].includes(p.state)) : [];
  if (skipped.length) body.push(skipWarning(d, skipped));
  else if (d.state === 'approval') body.push(notice('plain', 'info', null, 'Đây là nguyên văn sẽ lên. Bấm Duyệt… để mở thẻ duyệt của Nest; ở đó bạn duyệt, hoặc từ chối kèm ghi chú để Người viết viết lại.'));
  if (d.state === 'granted') body.push(notice('plain', 'check_circle', 'Bạn đã duyệt', 'Biên tập đang xếp lịch cho từng bài. Xong thì bài hiện ở Sắp lên.'));
  if (d.state === 'revising') body.push(notice('plain', 'pen', 'Đã gửi lại cho Người viết', `${d.note ? `Ghi chú của bạn: “${d.note}”${/[.!?…]$/.test(d.note.trim()) ? '' : '.'} ` : ''}Bản mới về đây và chờ bạn duyệt lại.`));
  if (d.state === 'stopped') body.push(notice('plain', 'stop', 'Bạn đã dừng bài này', 'Bài không lên kênh nào. Muốn làm tiếp thì nhờ Biên tập mở lại.'));
  if (d.state === 'waiting') body.push(notice('warn', 'message', 'Đội đang chờ bạn trả lời', `${d.note ? `“${d.note}”${/[.!?…]$/.test(d.note.trim()) ? '' : '.'} ` : ''}Câu hỏi nằm trong Cần bạn; bạn trả lời ở đó thì Người viết làm tiếp.`, btn('Mở Cần bạn', () => soot.open('nest://needs'), { icon: 'right', k: 'wait:needs' })));
  if (d.state === 'asked') body.push(notice('plain', 'activity', `Đã giao cho ${d.to === 'builder' ? 'Người dựng video' : 'Người viết'}`, 'Bài về đây khi xong, rồi Biên tập xin bạn duyệt một lần.'));
  if (d.state === 'drafting' && d.note === 'approval_expired') body.push(notice('plain', 'hourglass', 'Thẻ duyệt cũ đã hết hạn', 'Biên tập gửi lại khi bài sẵn sàng.'));
  if (d.state === 'no_channel') body.push(notice('plain', 'alert', 'Chưa có kênh để đăng', 'Tạo hoặc nối tài khoản cho sản phẩm này thì Biên tập gửi bài đi duyệt. Hoặc dừng bài.'));
  if (d.state === 'written') body.push(notice('plain', 'check_circle', 'Đã ghi vào thư mục site', `Bài nằm trong thư mục blog của ${ctx().products[d.product]?.name ?? 'sản phẩm'}. Trang lên khi bạn đưa site lên; dán link bài lúc đó để bàn đọc số Google.`));
  if (d.has_files === false && !d.hubless && d.format !== 'video') body.push(notice('plain', 'info', 'Chưa có tệp', 'Bài này chỉ có trên máy chủ đăng bài, chưa có thư mục trong thư mục marketing.'));
  const signed = (d.plan ?? []).find(p => p.reason === 'signed_out');
  if (signed) body.push(notice('partial', 'x_circle', `Đứng vì ${signed.account ?? M.CH[signed.channel]} đã đăng xuất`, `Bài đã duyệt mà 48 giờ chưa lên thì về nháp.${signed.returns_at ? ` Bài này về nháp ${M.when(signed.returns_at, Date.now())} và cần duyệt lại.` : ''}`));
  if (d.topic && !d.langs.length && !d.posts.length && !d.community && !d.newsletter) body.push(h('div', { class: 'mk-sec' }, h('h3', null, 'Đề tài'), h('div', { class: 'mk-quote' }, d.topic)));
  // A social post the founder posts by hand: its plan row says handoff, whatever the item's own state (its blog may
  // still wait for its slot), so the blocker's Đăng tay always lands on the steps and Lưu link.
  const hand = !d.video && d.format !== 'community' && d.format !== 'newsletter' ? (d.plan ?? []).find(p => p.state === 'handoff' && ['x', 'facebook'].includes(p.channel)) : null;
  const t = d.community?.target;
  // Content.
  if (d.format === 'community') body.push(communityBlock(d, s));
  for (const l of d.langs) body.push(langBlock(l));
  if (d.newsletter) body.push(newsBlock(d));
  const posts = d.format === 'community' || hand ? null : postsBlock(d);
  if (posts) body.push(posts);
  // A launch pack carries its community post (Show HN …) for the same one approval; after approval it becomes its own community handoff.
  if (d.format === 'launch' && d.community) body.push(communityBlock(d, s));
  if (d.video) {
    body.push(notice('plain', 'info', null, 'TikTok luôn do bạn đăng. Đăng xong dán link vào đây, Soot đọc lượt xem 48 giờ và 7 ngày.'));
    body.push(h('div', { class: 'mk-sec' }, h('h3', null, ic('video', 's12'), 'File đã xuất'),
      // The desk takes a TikTok link only, so that is the one platform it names.
      kv([['Kênh', d.video.account ?? d.video.channel], ['File', (d.video.delivery ?? []).join(', ') || 'Chưa xuất'], ['Nền tảng', platforms((d.video.platforms ?? []).includes('tiktok') || !(d.video.platforms ?? []).length ? ['tiktok'] : [])], ['Nhãn AI', d.video.ai_label === null || d.video.ai_label === undefined ? '—' : d.video.ai_label ? 'Bật nhãn nội dung AI khi đăng' : 'Không'],
        ['Đã đăng', M.safeLink(d.video.url) ? link('Mở video', d.video.url) : 'Chưa ghi link']])));
  }
  // Hand-off: what the founder does next, after the words it is about.
  if (['handoff', 'exported', 'sending'].includes(d.state) && d.format === 'newsletter') body.push(...sendBlock(s, d));
  if (hand) body.push(handSocialBlock(s, d, hand));
  if (d.format === 'community' && d.state === 'handoff') {
    const submit = M.submitUrl(t);
    const c = d.community ?? {};
    const where = t?.label ?? M.targetText(t);
    // Soot never posts to these sites: four steps, the founder's own hands and account.
    body.push(h('div', { class: 'mk-sec' }, h('h3', null, ic('link', 's12'), 'Bạn đăng'),
      h('ol', { class: 'mk-steplist' },
        h('li', null, h('div', { class: 'grow' }, h('b', null, 'Chép tiêu đề'), h('span', null, `${M.num((c.title ?? '').length)} ký tự.`), h('div', null, copyBtn(c.title ?? '', 'Chép tiêu đề', 'cp:title')))),
        h('li', null, h('div', { class: 'grow' }, h('b', null, 'Chép nội dung'), h('span', null, t?.kind === 'hn' ? 'Link hoặc nội dung, dán vào ô dưới tiêu đề.' : 'Dán vào ô nội dung.'), h('div', null, copyBtn(c.body ?? '', 'Chép nội dung', 'cp:body')))),
        h('li', null, h('div', { class: 'grow' }, h('b', null, 'Mở trang đăng'), h('span', null, submit ? `Trang đăng bài của ${where}, bằng tài khoản của bạn.` : `Mở ${where} và đăng bằng tài khoản của bạn.`), submit ? h('div', null, link('Mở trang đăng', submit, { cls: '', k: 'cm:open' })) : null)),
        h('li', null, h('div', { class: 'grow' }, h('b', null, 'Dán link bài đã đăng'), urlField(s, M.communityKind(t), null, t?.kind === 'reddit' ? 'Có link thì Soot theo dõi bình luận.' : null))))));
  }
  if (d.video && d.state === 'handoff') body.push(handTiktokBlock(s, d));
  if (d.state === 'written') body.push(h('div', { class: 'mk-sec' }, h('h3', null, ic('link', 's12'), 'Trang đã lên?'), urlField(s, 'blog', null)));
  const ptb = pretestBlock(s, d, 'bottom');
  if (ptb && (d.state === 'approval' || (d.stage === 'making' && (d.langs.length || d.posts.length || d.community || d.newsletter)))) body.push(ptb);
  const plan = planBlock(d);
  if (plan) body.push(plan);
  body.push(support([['Mã', d.ref], ['Thư mục', d.files], ['Thẻ duyệt', d.approval?.id], ['Bài trên máy chủ', [...d.langs.map(l => l.site && `${l.site}/${l.slug} bản ${l.revision ?? '—'}`), ...d.posts.map(p => p.id && `${p.id} bản ${p.revision ?? '—'}`)].filter(Boolean).join(', ')], ['File video', d.video?.dir]]));

  if (d.state === 'approval') {
    foot.push(h('span', { class: 'note' }, skipped.length ? `Duyệt thì ${[...new Set(skipped.map(p => M.CH[p.channel]))].join(', ')} không lên.` : 'Mở thẻ duyệt của Nest.'));
    if (canStop) foot.push(stopButton(d.ref));
    foot.push(btn('Duyệt…', () => soot.open(`nest://needs/approve/${d.approval.id}`), { cls: 'primary', disabled: !d.approval?.id, k: 'approve' }));
  } else if (d.state === 'uncertain') {
    foot.push(h('span', { class: 'note' }, 'Kiểm trên kênh rồi báo, để không đăng hai lần.'), btn('Kiểm tra', () => { S.sheet = { ...s, kind: 'uncertain', form: {} }; renderSheet(true); }, { cls: 'primary', k: 'check' }));
  } else if (d.state === 'handoff' && d.video) {
    const q = d.queue;
    const b = btn(q?.next ? `Lưu link · video kế tiếp (${q.pos + 1}/${q.total})` : 'Lưu link', () => confirmPost(s, d, 'posted', 'tiktok', null, b), { cls: 'primary', k: 'save-video' });
    foot.push(h('span', { class: 'note' }, q?.total > 1 ? `Video ${q.pos}/${q.total} chờ link.` : 'File nằm trong thư mục chiến dịch trên máy.'),
      q?.next ? btn('Bỏ qua', () => openSheet('item', q.next), { cls: 'quiet', k: 'skip-video' }) : null, b);
  } else if (d.state === 'handoff' && d.format === 'community') {
    const t = d.community?.target;
    const b = btn('Lưu link', () => confirmPost(s, d, 'posted', M.communityKind(t), d.community?.lang ?? null, b), { cls: 'primary', k: 'save-community' });
    foot.push(h('span', { class: 'note' }, 'Soot không đăng lên cộng đồng thay bạn.'), canStop ? stopButton(d.ref, 'Không đăng nữa') : null, b);
  } else if ((d.state === 'handoff' || d.state === 'exported') && d.format === 'newsletter') {
    const email = ability('email');
    const n = d.newsletter ?? {};
    const none = n.subscribers === null || n.subscribers === undefined;
    const send = (cls) => btn('Gửi bản tin…', () => ask(`Gửi bản tin ${d.ref} (${d.title}) tới ${n.subscribers} người đăng ký qua email send. Bản này tôi đã duyệt.`, 'Đã nhờ Biên tập gửi. Nest hỏi bạn duyệt lần gửi trong Cần bạn.', { request_id: `send-${d.ref}` }).then(() => load({ quiet: true })).catch(() => {}), { cls, icon: 'send', disabled: none, k: 'nl:send' });
    if (n.export) {
      // Exported: the founder sends it with their own tool, so "I sent it" is the one thing left.
      const sent = btn('Đã gửi xong', async () => {
        const r = await act('confirm', { ref: d.ref, outcome: 'sent' }, sent);
        if (!r) return;
        closeSheet();
        toast('Đã ghi là đã gửi. Bản tin nằm ở Đã lên.');
        load({ quiet: true });
      }, { cls: 'primary', icon: 'check_circle', k: 'nl:sent' });
      foot.push(h('span', { class: 'note' }, 'Gửi bằng công cụ của bạn rồi bấm Đã gửi xong.'), exportBtn(d, 'quiet'), sent);
    } else foot.push(h('span', { class: 'note' }, none ? 'Dán danh sách người nhận thì gửi được.' : `Gửi tới ${M.num(n.subscribers)} người.`), email === false ? exportBtn(d, 'primary') : [exportBtn(d), send('primary')]);
  } else if (d.state === 'sending') {
    foot.push(h('span', { class: 'note' }, 'Chờ bạn duyệt lần gửi trong Cần bạn.'), btn('Mở Cần bạn', () => soot.open('nest://needs'), { cls: 'primary', k: 'nl:needs-foot' }));
  } else if (hand) {
    const b = btn('Lưu link', () => confirmPost(s, d, 'posted', hand.channel, hand.lang, b), { cls: 'primary', k: 'save-hand' });
    foot.push(h('span', { class: 'note' }, 'Chưa có máy đăng cho kênh này.'), b);
  } else if (d.state === 'written') {
    const b = btn('Lưu link', () => confirmPost(s, d, 'posted', 'blog', d.langs[0]?.lang ?? null, b), { cls: 'primary', k: 'save-blog' });
    foot.push(h('span', { class: 'note' }, 'Không bắt buộc. Có link thì có số Google.'), b);
  } else if (d.state === 'scheduled' || d.state === 'held') {
    foot.push(h('span', { class: 'note' }, d.state === 'held' ? 'Bài đang đứng; sửa chỗ giữ bài thì nó lên ở lượt tới.' : 'Đã duyệt. Bài lên theo nhịp.'));
    if (canStop) foot.push(stopButton(d.ref, 'Dừng, không đăng'));
    if (signed && d.product) foot.push(btn('Sửa kênh', () => openSheet('channel', `${d.product}:${signed.channel}`), { k: 'fix' }));
  } else if (d.state === 'stopped') {
    const b = btn('Nhờ Biên tập mở lại', () => ask(`Mở lại bài ${d.ref} (${d.title}) để làm tiếp.`, NOTE_ASKED).catch(() => {}), { k: 'reopen' });
    foot.push(h('span', { class: 'note' }), b);
  } else if (d.stage === 'making' && canStop) {
    // Same words under the same ask-<ref>: Nest keeps one request, so a resend never doubles the job.
    const again = d.ask_text ? btn('Nhắn lại Biên tập', () => ask(d.ask_text, 'Đã nhắn Biên tập. Trả lời nằm trong cuộc trò chuyện của màn hình này.', { request_id: `ask-${d.ref}` }).catch(() => {}), { cls: 'quiet', icon: 'send', k: 'reask' }) : null;
    foot.push(h('span', { class: 'note' }, d.state === 'revising' ? 'Người viết đang sửa theo ghi chú của bạn.' : d.ask_text ? 'Biên tập chưa nhận được việc thì nhắn lại.' : ''), again, stopButton(d.ref));
  } else if (d.state === 'posted') foot.push(h('span', { class: 'note' }, d.format === 'newsletter' ? 'Đã gửi.' : 'Đã lên.'));
  const wide = d.posts.length > 1 && !hand && d.format !== 'community';
  return { title: d.title || d.ref, sub: productSub(d.product, d.format === 'community' ? `${M.FORMAT.community} · ${M.targetText(d.community?.target)}` : M.FORMAT[d.format] ?? d.format, by), body, foot: foot.length ? foot.flat() : null, w: wide ? 'w640' : '' };
}

function sheetUncertain(s) {
  const d = s.data;
  const [, chWant, langWant] = String(s.key).split(':');
  const post = d.posts.find(p => p.status === 'uncertain' && (!chWant || p.channel === chWant) && (!langWant || p.lang === langWant)) ?? d.posts.find(p => p.status === 'uncertain') ?? d.posts[0];
  if (!post) return { title: 'Bài này đã lên chưa?', sub: productSub(d.product), body: [emptyRow('Không còn bài nào cần kiểm tra.')], foot: null };
  const plan = (d.plan ?? []).find(p => p.channel === post.channel && p.lang === post.lang);
  const account = plan?.account ?? null;
  const profile = M.profileUrl(post.channel, account);
  const yes = btn('Lưu link', () => confirmPost(s, d, 'posted', post.channel, post.lang, yes), { cls: 'primary', k: 'u:yes' });
  const no = btn('Không thấy, đưa về nháp', () => confirmPost(s, d, 'not_posted', post.channel, post.lang, no), { k: 'u:no' });
  return {
    title: `Bài này đã lên ${M.CH[post.channel] ?? post.channel} chưa?`, sub: productSub(d.product, M.CH[post.channel], account), w: 'w480',
    body: [
      notice('plain', 'info', null, `Máy đăng nhận bài${plan?.at ? ` lúc ${M.when(plan.at, Date.now())}` : ''} rồi dừng giữa chừng: có thể đã bấm Đăng, có thể chưa. Soot không tự đăng lại để tránh đăng hai lần.`),
      h('div', { class: 'mk-sec' }, h('h3', null, 'Bài cần tìm'), h('div', { class: 'mk-lang' }, h('div', { class: 'lh' }, h('b', null, String(post.lang ?? '').toUpperCase()), [M.CH[post.channel], account].filter(Boolean).join(' · ')), h('div', { class: 'body' }, post.text ?? '—'))),
      h('div', { class: 'mk-sec' }, h('h3', null, `1. Tìm trên ${M.CH[post.channel] ?? post.channel}`), profile ? link(`Mở ${profile.replace('https://', '')}`, profile, { cls: '' }) : h('p', { class: 'mk-fine' }, 'Mở trang của tài khoản trên kênh và tìm bài này.')),
      h('div', { class: 'mk-sec' }, h('h3', null, '2. Báo kết quả'), urlField(s, post.channel, account), h('div', { class: 'row mt8' }, yes, h('span', { class: 'muted' }, 'hoặc'), no)),
      support([['Mã', d.ref], ['Bài trên máy chủ', post.id], ['Bản', post.revision]]),
    ],
    foot: null,
  };
}

function rulesBlock(s, d) {
  const r = d.rules;
  const ch = d.cell.channel ?? String(d.key).split(':')[1];
  if (!r || !['blog', 'x', 'facebook'].includes(ch)) return null;
  const f = s.form;
  if (!f.editing) {
    return h('div', { class: 'mk-sec' }, h('h3', null, 'Nhịp đăng', h('span', { class: 'sp' }), btn('Sửa', () => { f.editing = true; f.rules = { cap: r.cap_per_day, gap: r.spacing_min, quiet: r.quiet ? { ...r.quiet } : null, max: r.max_len ?? null }; renderSheet(); }, { cls: 'link', k: 'rules:edit' })),
      kv([['Tối đa mỗi ngày', `${r.cap_per_day} bài`], ['Cách nhau', r.spacing_min ? `Ít nhất ${r.spacing_min} phút` : 'Không giới hạn'], ['Giờ nghỉ', r.quiet ? `${r.quiet.from}–${r.quiet.to}` : 'Không nghỉ'], ['Độ dài', r.max_len ? `Tối đa ${M.num(r.max_len)} ký tự` : null], ['Nguồn', r.default ? 'Mặc định của pack' : 'Bạn đặt']]));
  }
  const x = f.rules;
  const numIn = (id, label, value, min, max, set) => {
    const i = h('input', { id, type: 'number', class: 'short', min: String(min), max: String(max), step: '1', value: value === null ? '' : String(value) });
    i.addEventListener('input', () => { set(/** @type {HTMLInputElement} */ (i).value); f.dirty = true; });
    return h('div', { class: 'mk-field' }, h('label', { for: id }, label), i);
  };
  const quietOn = h('input', { id: 'r-quiet', type: 'checkbox', checked: !!x.quiet });
  quietOn.addEventListener('change', () => { x.quiet = /** @type {HTMLInputElement} */ (quietOn).checked ? x.quiet ?? { from: '23:00', to: '07:00' } : null; f.dirty = true; renderSheet(); });
  const time = (key) => {
    const i = h('input', { type: 'time', value: x.quiet?.[key] ?? '', 'aria-label': key === 'from' ? 'Nghỉ từ' : 'Nghỉ tới' });
    i.addEventListener('input', () => { if (x.quiet) x.quiet[key] = /** @type {HTMLInputElement} */ (i).value; f.dirty = true; });
    return i;
  };
  const save = btn('Lưu nhịp', async () => {
    const cap = Number.parseInt(String(x.cap), 10), gap = Number.parseInt(String(x.gap), 10), max = x.max === null || x.max === '' ? undefined : Number.parseInt(String(x.max), 10);
    const okQuiet = !x.quiet || (/^\d\d:\d\d$/.test(x.quiet.from) && /^\d\d:\d\d$/.test(x.quiet.to));
    if (!(cap >= 0 && cap <= 50) || !(gap >= 0 && gap <= 1440) || (max !== undefined && !(max >= 1 && max <= 5000)) || !okQuiet) { toast('Kiểm lại: tối đa 0–50 bài, cách nhau 0–1440 phút, độ dài 1–5000 ký tự.', 'err'); return; }
    const out = await act('rules', { channel: d.key, cap_per_day: cap, spacing_min: gap, quiet: x.quiet ? { from: x.quiet.from, to: x.quiet.to } : null, ...(max !== undefined ? { max_len: max } : {}) }, save);
    if (!out) return;
    d.rules = out.rules;
    s.form = {};
    renderSheet();
    toast('Đã lưu nhịp đăng. Lượt đăng tới theo nhịp mới.');
    load({ quiet: true });
  }, { cls: 'primary', k: 'rules:save' });
  return h('div', { class: 'mk-sec' }, h('h3', null, 'Nhịp đăng'),
    h('div', { class: 'mk-card mk-rules' },
      numIn('r-cap', 'Tối đa mỗi ngày (bài)', x.cap, 0, 50, (v) => { x.cap = v; }),
      numIn('r-gap', 'Cách nhau ít nhất (phút)', x.gap, 0, 1440, (v) => { x.gap = v; }),
      h('div', { class: 'mk-field' }, h('span', { class: 'lb' }, 'Giờ nghỉ'), h('label', { class: 'mk-quiet-q' }, quietOn, 'Không đăng trong giờ nghỉ'), x.quiet ? h('div', { class: 'mk-quiet-q' }, time('from'), h('span', null, 'tới'), time('to')) : null),
      ch !== 'blog' ? numIn('r-max', 'Độ dài tối đa (ký tự)', x.max, 1, 5000, (v) => { x.max = v; }) : null,
      h('div', { class: 'row' }, btn('Huỷ', () => { s.form = {}; renderSheet(); }, { cls: 'quiet', k: 'rules:cancel' }), save)));
}
function sheetChannel(s) {
  const d = s.data;
  const [pid, ch] = String(d.key).split(':');
  const c = { ...d.cell, channel: ch };
  const x = M.cellText(c);
  const pname = ctx().products[pid]?.name ?? pid;
  const via = c.via === 'browser' ? 'Máy đăng đăng qua trình duyệt trên Mac này' : c.via === 'api' ? 'Máy chủ đăng bài đăng thẳng' : ch === 'blog' && c.via === 'hub' ? 'Máy chủ đăng bài đưa lên blog' : c.state === 'folder' ? 'Ghi vào thư mục site' : ['by_hand', 'manual'].includes(c.state) ? 'Bạn đăng tay' : null;
  const body = [notice(x.tone === 'err' ? 'partial' : 'plain', x.tone === 'err' ? 'x_circle' : x.tone === 'ok' ? 'check_circle' : 'info', x.l1, M.cellWhat(c, pname))];
  if (d.steps?.length) {
    body.push(h('div', { class: 'mk-sec' }, h('h3', null, c.state === 'signed_out' ? 'Làm lại từ đầu tới cuối' : 'Các bước'), h('ol', { class: 'mk-steplist' }, ...d.steps.map(st => {
      const t = M.stepText(st, c);
      let action = null;
      if (st.id === 'sign_in') action = btn(t.button, () => soot.open(st.href ?? 'nest://settings/browser'), { icon: 'login', k: 'step:signin' });
      else if (st.id === 'budget') action = btn(t.button, () => soot.open('nest://needs'), { icon: 'wallet', k: 'step:budget' });
      else if (st.id === 'connect') action = btn(t.button, () => ask(`Nối kênh ${M.CH[ch]} của ${pname} vào máy chủ đăng bài${c.account ? ` (tài khoản ${c.account})` : ''} và cho tôi biết cần làm gì.`, NOTE_ASKED).catch(() => {}), { k: 'step:connect' });
      return h('li', { class: st.done ? 'done' : '' }, h('div', { class: 'grow' }, h('b', null, t.title), h('span', null, t.hint), action ? h('div', null, action) : null));
    }))));
  }
  const rules = ['ok', 'paused', 'signed_out'].includes(c.state) ? rulesBlock(s, d) : null;
  if (rules) body.push(rules);
  if (d.waiting?.length) body.push(h('div', { class: 'mk-sec' }, h('h3', null, 'Bài đang chờ trên kênh này'), h('div', { class: 'mk-plan' }, ...d.waiting.map(itemRowEl))));
  if (c.state === 'folder') body.push(h('div', { class: 'mk-sec' }, h('h3', null, 'Thư mục'), kv([['Ghi vào', c.dir_label ?? 'Thư mục blog của sản phẩm'], ['Mỗi bài', 'Một file Markdown có front matter (title, date, slug, lang)'], ['Đã ghi, 7 ngày', `${M.num(c.posted_7d ?? 0)} bài`]])));
  // The newsletter's recipients are pasted here; the desk shows how many, never who.
  if (ch === 'newsletter') body.push(subscribersBlock(s, pid, c.subscribers ?? null));
  if (ch === 'community' && (c.targets ?? []).length) body.push(h('div', { class: 'mk-sec' }, h('h3', null, 'Nơi đăng'), h('div', { class: 'mk-plan' }, ...c.targets.map(t => row({ lead: cm('community'), title: M.targetText(t), sub: t.rules ?? '', wrap: true, end: M.submitUrl(t) ? link('Mở', M.submitUrl(t)) : undefined })))));
  body.push(support([['Kênh', d.key], ['Tài khoản', c.account], ['Hồ sơ trình duyệt', c.profile], ['Thư mục', c.dir], ['Máy đăng hỏi bài lần cuối', c.poster_seen_at ? M.when(c.poster_seen_at, Date.now()) : null], ['Độ dài tối đa', c.max ? M.num(c.max) : null]]));
  const foot = [];
  const canPause = ['ok', 'signed_out'].includes(c.state) && !c.paused && !['tiktok', 'community', 'newsletter'].includes(ch);
  if (canPause) { const b = btn('Tạm dừng kênh', () => pauseChannel(d.key, true, b), { icon: 'pause', k: 'ch:pause' }); foot.push(b); }
  if (c.paused?.scope === 'channel') { const b = btn('Bật lại kênh', () => pauseChannel(d.key, false, b), { cls: 'primary', icon: 'play', k: 'ch:resume' }); foot.push(h('span', { class: 'note' }), b); }
  else if (c.paused?.scope === 'all') foot.push(h('span', { class: 'note' }, 'Bạn đang tạm dừng mọi lượt đăng; bật lại ở Kênh đăng.'));
  return { title: `${M.CH[ch] ?? ch}${c.account ? ` · ${c.account}` : ''}`, sub: productSub(pid, via), body, foot: foot.length ? foot : null, w: 'w520' };
}

const CREATE_CH = { blog: ['blog', 'x', 'facebook'], social: ['x', 'facebook'], video: ['tiktok'], community: ['community'], newsletter: ['newsletter'], launch: ['blog', 'x', 'community'] };
const USABLE = ['ok', 'paused', 'signed_out', 'manual', 'unknown', 'folder', 'by_hand', 'email', 'export'];
const FORMAT_HINT = {
  blog: 'Người viết soạn bài blog (cặp VI/EN nếu trang có hai thứ tiếng), rồi tách bài cho từng kênh.',
  social: 'Người viết soạn bài ngắn cho từng kênh.',
  video: 'Người dựng video làm theo cách của kênh video: kịch bản đưa bạn duyệt trước khi lồng tiếng.',
  community: 'Người viết soạn theo luật của nơi đăng: không giọng quảng cáo, nói thẳng bạn là người làm. Duyệt xong bạn tự đăng rồi dán link.',
  newsletter: 'Người viết gom bài đã lên tuần này thành một thư. Duyệt xong bạn bấm gửi, hoặc xuất ra file.',
  launch: 'Người viết đọc bản thay đổi rồi soạn một gói: bài blog, bài X và bài Show HN. Bạn duyệt cả gói một lần; Show HN do bạn tự đăng.',
};
/** P2: six kinds as one radio group; arrow keys move the choice, as a radio group does. */
function kindsGrid(f) {
  const pick = (id) => {
    if (f.format === id) return;
    // What the old kind asked for (its channels, its source) does not carry over.
    f.format = id; f.channels = null; f.source = undefined;
    renderSheet();
    /** @type {HTMLElement | null} */ (sheetHost.querySelector(`[data-k="cf:kind:${id}"]`))?.focus();
  };
  const grid = h('div', { class: 'mk-kinds', role: 'radiogroup', 'aria-labelledby': 'cf-kind' },
    ...M.KINDS.map(k => h('button', { type: 'button', role: 'radio', 'aria-checked': String(f.format === k.id), tabindex: f.format === k.id ? '0' : '-1', 'data-k': `cf:kind:${k.id}`, onclick: () => pick(k.id) },
      ic(k.icon, 's16'), h('b', null, k.label), h('span', null, k.sub))));
  grid.addEventListener('keydown', (ev) => {
    const e = /** @type {KeyboardEvent} */ (ev);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = M.KINDS.findIndex(k => k.id === f.format);
    pick(M.KINDS[(i + step + M.KINDS.length) % M.KINDS.length].id);
  });
  return h('div', { class: 'mk-field' }, h('span', { class: 'lb', id: 'cf-kind' }, 'Làm gì'), grid);
}
function sheetCreate(s) {
  const products = S.summary?.products ?? [];
  const f = s.form;
  if (!f.product) f.product = S.product ?? products[0]?.id ?? null;
  if (!f.format) f.format = 'blog';
  if (f.topic === undefined) f.topic = '';
  if (!products.length) return { title: 'Tạo nội dung', sub: null, body: [notice('plain', 'info', 'Chưa có sản phẩm nào', 'Bắt đầu marketing để thêm sản phẩm đầu tiên, rồi tạo bài.', btn('Bắt đầu marketing', () => openSheet('setup', null), { k: 'cf:setup' }))], foot: null, w: 'w520' };
  const prod = products.find(p => p.id === f.product);
  const cells = s.data?.channels?.rows?.find(r => r.product === f.product)?.cells ?? {};
  const avail = CREATE_CH[f.format];
  const usable = (c) => !cells[c] || USABLE.includes(cells[c].state);
  if (!f.channels) f.channels = avail.filter(usable);
  const series = (s.data?.library?.tree ?? []).filter(g => g.product === f.product).flatMap(g => g.children ?? []).flatMap(n => n.children ?? []).filter(n => n.kind === 'series').map(n => ({ slug: n.id.split('/').pop(), title: n.label }));
  const seg = (label, items, cur, set) => h('div', { class: 'mk-field' }, h('span', { class: 'lb' }, label), h('div', { class: 'mk-seg', role: 'group', 'aria-label': label },
    ...items.map(([v, l]) => btn(l, () => { set(v); renderSheet(); }, { pressed: cur === v, k: `cf:${label}:${v}` }))));
  const area = (id, label, key, ph, rows = '3') => {
    const t = h('textarea', { id, rows, maxlength: key === 'changelog' ? '20000' : '1000', placeholder: ph });
    t.value = f[key] ?? '';
    t.addEventListener('input', () => { f[key] = /** @type {HTMLTextAreaElement} */ (t).value; f.dirty = true; });
    return h('div', { class: 'mk-field' }, h('label', { for: id }, label), t);
  };
  const targets = prod?.targets ?? [];
  if (f.format === 'community' && (f.target === undefined || (f.target !== 'other' && !targets.some(t => t.id === f.target)))) f.target = targets[0] ? targets[0].id : 'other';
  const body = [
    products.length > 1 ? seg('Sản phẩm', products.map(p => [p.id, p.name]), f.product, (v) => { f.product = v; f.channels = null; f.series = undefined; f.target = undefined; f.source = undefined; }) : null,
    kindsGrid(f),
    h('span', { class: 'mk-fine' }, FORMAT_HINT[f.format]),
  ];
  if (f.format === 'community') {
    // Nơi đăng: the product's places, then a place the founder names.
    const sel = h('select', { id: 'f-target', 'data-k': 'cf:target' },
      ...targets.map(t => h('option', { value: t.id, selected: f.target === t.id }, t.label ?? M.targetText(t))),
      h('option', { value: 'other', selected: f.target === 'other' }, 'Nơi khác…'));
    /** @type {HTMLSelectElement} */ (sel).value = f.target;
    sel.addEventListener('change', () => { f.target = /** @type {HTMLSelectElement} */ (sel).value; f.dirty = true; renderSheet(); });
    body.push(h('div', { class: 'mk-field' }, h('label', { for: 'f-target' }, 'Nơi đăng'), sel));
    if (f.target === 'other') {
      const i = h('input', { id: 'f-where', type: 'text', maxlength: '80', placeholder: 'Ví dụ: Indie Hackers', value: f.where ?? '', 'aria-required': 'true' });
      i.addEventListener('input', () => { f.where = /** @type {HTMLInputElement} */ (i).value; f.dirty = true; });
      body.push(h('div', { class: 'mk-field' }, h('label', { for: 'f-where' }, 'Tên nơi đăng'), i));
    }
    const rules = targets.find(t => t.id === f.target)?.rules;
    if (rules) body.push(h('p', { class: 'mk-fine' }, `Luật của ${targets.find(t => t.id === f.target)?.label ?? 'nơi này'}: ${rules}`));
    body.push(area('f-topic', 'Đề tài', 'topic', 'Ví dụ: chúng tôi tự host Meilisearch trên một VM 2 GB, đây là những gì hỏng'));
  } else if (f.format === 'newsletter') {
    if (!f.source) f.source = 'week';
    body.push(seg('Thư gồm', [['week', 'Bài đã lên tuần này'], ['topic', 'Một đề tài']], f.source, (v) => { f.source = v; }));
    if (f.source === 'topic') body.push(area('f-topic', 'Đề tài', 'topic', 'Ví dụ: ba thay đổi trong bản tháng này'));
    body.push(h('p', { class: 'mk-fine' }, prod?.subscribers === null || prod?.subscribers === undefined ? 'Chưa có danh sách người nhận. Thư vẫn soạn được; dán danh sách người nhận (Kênh đăng › Bản tin) trước khi gửi.' : `Gửi tới ${M.num(prod.subscribers)} người đăng ký của ${prod.name}.`));
  } else if (f.format === 'launch') {
    if (!f.source || (f.source === 'changelog' && !prod?.changelog)) f.source = prod?.changelog ? 'changelog' : 'paste';
    body.push(seg('Bản thay đổi', [...(prod?.changelog ? [['changelog', 'Bản mới nhất trong CHANGELOG']] : []), ['paste', 'Dán nội dung']], f.source, (v) => { f.source = v; }));
    if (f.source === 'paste') body.push(area('f-cl', 'Nội dung bản thay đổi', 'changelog', 'Dán phần CHANGELOG hoặc ghi chú phát hành của bản mới', '6'));
    else body.push(h('p', { class: 'mk-fine' }, `Người viết đọc phần trên cùng của CHANGELOG ${prod?.name ?? ''}${prod?.changelog_version ? ` (bản ${prod.changelog_version})` : ''}.`));
    body.push(area('f-topic', 'Muốn nhấn vào điều gì (không bắt buộc)', 'topic', 'Ví dụ: người dùng cũ nâng cấp không mất dữ liệu', '2'));
  } else {
    body.push(area('f-topic', 'Đề tài', 'topic', 'Ví dụ: vì sao bộ truyện này đang được đọc nhiều, kể ngắn gọn cho người mới'));
    if (f.format === 'video' && series.length) body.push(seg('Series', [['', 'Không chọn'], ...series.map(x => [x.slug, x.title])], f.series ?? '', (v) => { f.series = v || undefined; }));
  }
  if (!['community', 'newsletter'].includes(f.format)) {
    body.push(h('div', { class: 'mk-field' }, h('span', { class: 'lb' }, f.format === 'launch' ? 'Gói gồm' : 'Lên kênh nào'), h('div', { class: 'mk-checks' }, ...avail.map(c => {
      const st = cells[c]?.state;
      const off = !usable(c);
      const label = c === 'community' && f.format === 'launch' ? 'Show HN' : M.CH[c];
      const note = off ? ` · ${st === 'not_connected' ? 'chưa nối' : st === 'off' ? 'không dùng' : 'chưa có tài khoản'}` : st === 'signed_out' ? ' · đang đăng xuất' : st === 'paused' ? ' · đang tạm dừng' : st === 'by_hand' || c === 'community' ? ' · bạn đăng' : st === 'folder' ? ' · ghi vào site' : '';
      return btn(`${label}${note}`, () => { const i = f.channels.indexOf(c); if (i >= 0) f.channels.splice(i, 1); else f.channels.push(c); renderSheet(); }, { pressed: f.channels.includes(c), disabled: off, k: `cf:ch:${c}` });
    }))));
  }
  body.push(notice('plain', 'info', null, 'Bài xong nằm ở Chờ duyệt. Không có gì lên trước khi bạn duyệt.'));
  const who = M.MAKER[f.format] ?? 'Người viết';
  if (f.sent) {
    const again = btn('Nhắn Biên tập', () => sendAsk(f), { cls: 'primary', icon: 'send', k: 'cf:ask' });
    return { title: 'Tạo nội dung', sub: [`Đã ghi ${M.FORMAT[f.format]?.toLowerCase() ?? 'bài'}`], body: [notice('info', 'info', 'Bài đã ghi, Biên tập chưa nhận tin', 'Bấm Nhắn Biên tập để gửi việc.')], foot: [h('span', { class: 'note' }), again], w: 'w520' };
  }
  const send = btn('Giao việc', async () => {
    const bad = M.createProblem(f);
    if (bad) { toast(bad.text, 'err'); /** @type {HTMLElement} */ (sheetHost.querySelector(`#${bad.field}`))?.focus(); return; }
    const out = await act('create', M.createFields(f), send);
    if (!out) return;
    f.sent = out;
    f.dirty = false;
    load({ quiet: true }); // the item exists now, asked or not: the desk stops saying it is empty
    sendAsk(f);
  }, { cls: 'primary', icon: 'send', k: 'cf:send' });
  return { title: 'Tạo nội dung', sub: [`Giao cho ${who}, qua Biên tập của đội Marketing`], body, foot: [h('span', { class: 'note' }, 'Biên tập nhận việc và trả lời trong cuộc trò chuyện của màn hình này.'), send], w: 'w520' };
}
/**
 * Hand the new item to the Editor. The ask follows the create in the same
 * press; a host that counts the press as spent by then answers
 * gesture_required, and the sheet offers "Nhắn Biên tập" for a fresh press.
 * One request id per item, so a second press never sends it twice.
 */
function sendAsk(f) {
  const out = f.sent;
  const who = out.to === 'builder' ? 'Người dựng video' : 'Người viết';
  ask(out.ask_text, `Đã giao cho ${who}. Bài nằm ở Đang làm.`, {
    request_id: `ask-${out.ref}`,
    started: () => { if (S.sheet?.form === f) { closeSheet(); S.tab = 'content'; S.stage = 'making'; load({ quiet: true }); } },
  }).catch(() => { if (S.sheet?.form === f) renderSheet(); });
}

// P2 ---------- Bắt đầu marketing ----------

const SETUP_CH = [
  { id: 'x', label: 'X', field: 'Tài khoản X', ph: '@ten' },
  { id: 'facebook', label: 'Facebook', field: 'Trang Facebook', ph: 'Tên trang' },
  { id: 'tiktok', label: 'TikTok', field: 'Kênh TikTok', ph: '@kenh' },
  { id: 'community', label: 'Cộng đồng', field: 'Nơi đăng', ph: 'r/selfhosted, Hacker News, dev.to' },
  { id: 'newsletter', label: 'Bản tin', field: null, ph: '' },
];
const SETUP_ERR = {
  product_exists: { step: 'product', key: 'name', text: 'Đã có sản phẩm tên này. Đặt tên khác hoặc sửa sản phẩm đang có.' },
  bad_dir: { step: 'blog', key: 'dir', text: 'Thư mục này nằm ngoài thư mục marketing.' },
  // MARKETING_ROOT is not set: the product cannot be written anywhere yet. Said in place on step 1, with the fix.
  needs_credential: { step: 'product', key: 'root', text: 'Chưa chọn thư mục marketing nên bàn chưa ghi được sản phẩm. Chọn thư mục trong Kho khóa rồi bấm Lưu lại; phần đã nhập vẫn còn.' },
};
/** Step 1's notice when the marketing folder is missing (before Lưu, or after a needs_credential refusal). */
function rootNotice(f) {
  const lib = libSource();
  const missing = f.bad === 'root' || (lib && !lib.ok && lib.error === 'not_configured');
  if (!missing) return null;
  return notice('warn', 'folder', 'Chưa chọn thư mục marketing', f.bad === 'root' ? f.badText : 'Bàn ghi sản phẩm và bài vào một thư mục trên máy (MARKETING_ROOT). Chọn thư mục trong Kho khóa trước khi lưu; nhập tiếp ở đây cũng được.',
    btn('Chọn thư mục', () => soot.open('nest://settings/setup?key=MARKETING_ROOT'), { icon: 'folder', k: 'su:root' }));
}
function sheetSetup(s) {
  const f = s.form;
  const hub = s.data?.hub;
  const hubOk = !!hub?.ok;
  if (!f.step) f.step = 'product';
  if (!f.langs) f.langs = 'vi';
  if (!f.blog) f.blog = hubOk ? 'hub' : 'folder';
  if (!f.ch) f.ch = {};
  const i = M.SETUP_STEPS.findIndex(x => x.id === f.step);
  const products = S.summary?.products ?? [];
  const input = (id, label, key, o = {}) => {
    const el = h(o.area ? 'textarea' : 'input', { id, type: o.area ? null : o.type ?? 'text', rows: o.area ? '3' : null, maxlength: String(o.max ?? 200), placeholder: o.ph ?? '', 'aria-invalid': f.bad === key ? 'true' : null, 'aria-describedby': `${id}-hint`, autocomplete: 'off' });
    /** @type {any} */ (el).value = f[key] ?? '';
    el.addEventListener('input', () => { f[key] = /** @type {any} */ (el).value; f.dirty = true; if (f.bad === key) { f.bad = null; el.removeAttribute('aria-invalid'); } });
    const hint = f.bad === key ? f.badText : typeof o.hint === 'function' ? o.hint() : o.hint;
    return h('div', { class: 'mk-field' }, h('label', { for: id }, label), el, hint ? h('span', { class: f.bad === key ? 'err-hint' : 'hint', id: `${id}-hint` }, hint) : null);
  };
  const steps = h('ol', { class: 'mk-wiz', 'aria-label': 'Các bước' }, ...M.SETUP_STEPS.map((x, n) => h('li', { class: n < i ? 'done' : n === i ? 'on' : '', 'aria-current': n === i ? 'step' : null }, h('span', { class: 'num' }, n < i ? ic('check_circle', 's12') : String(n + 1)), x.label)));
  const name = String(f.name ?? '').trim();
  const pid = M.productId(name);
  const body = [steps];
  if (f.askClose && !f.saved) {
    body.push(notice('warn', 'alert', 'Bỏ phần đã nhập?', 'Sản phẩm chưa được lưu. Đóng thì phần bạn vừa nhập mất.',
      h('div', { class: 'row' }, btn('Nhập tiếp', () => { f.askClose = false; renderSheet(); }, { cls: 'quiet', k: 'su:keep' }), btn('Bỏ', closeSheet, { k: 'su:drop' }))));
  }
  const foot = [];
  const note = h('span', { class: 'note' }, `Bước ${i + 1}/${M.SETUP_STEPS.length}`);
  const back = i > 0 ? btn('Quay lại', () => { f.step = M.SETUP_STEPS[i - 1].id; f.bad = null; renderSheet(); }, { cls: 'quiet', icon: 'left', k: 'su:back' }) : null;
  const refuse = (bad) => { f.bad = bad.key; f.badText = bad.text; renderSheet(); /** @type {HTMLElement} */ (sheetHost.querySelector('[aria-invalid="true"]'))?.focus(); };
  const next = () => btn('Tiếp', () => {
    const bad = M.setupProblem(f.step, f, products);
    if (bad) { refuse(bad); return; }
    if (f.step === 'product') { const site = M.siteUrl(f.site); f.site = site || ''; }
    f.bad = null;
    f.step = M.SETUP_STEPS[i + 1].id;
    renderSheet();
  }, { cls: 'primary', icon: 'right', k: 'su:next' });
  if (f.saved) {
    const shown = f.saved.name ?? name;
    return { title: `Đã thêm ${shown}`, sub: [pm(f.saved.id) ?? h('span', { class: 'mk-pm' }, M.productMark(shown)), 'Bắt đầu marketing'], w: 'w480',
      body: [
        h('div', { class: 'mk-done', role: 'status' }, sq('ok', 'check_circle'), h('div', null, h('b', null, `${shown} đã có trên bàn Marketing`), h('span', null, 'Bàn đã ghi sản phẩm và một trang giọng văn ngắn (brand.md) cho Người viết và Biên tập đọc.'))),
        h('div', { class: 'mk-sec' }, h('h3', null, 'Tiếp theo'), h('ol', { class: 'mk-steplist' },
          h('li', null, h('div', { class: 'grow' }, h('b', null, 'Đọc lại giọng văn'), h('span', null, 'Một trang: sản phẩm làm gì, cho ai, nói thế nào, tránh nói gì. Sửa vài câu là bài đầu đã đúng giọng hơn.'), h('div', null, btn('Mở trong Thư viện', () => { closeSheet(); S.tab = 'library'; S.lib.node = `product:${f.saved.id}`; loadTab(); }, { icon: 'folder', k: 'su:brand' })))),
          h('li', null, h('div', { class: 'grow' }, h('b', null, 'Tạo bài đầu tiên'), h('span', null, 'Chọn đề tài, Người viết soạn. Bài nằm ở Chờ duyệt tới khi bạn duyệt.'))))) ],
      foot: [h('span', { class: 'note' }), btn('Đóng', closeSheet, { cls: 'quiet', k: 'su:close' }), btn('Tạo bài đầu tiên', () => openSheet('create', null, { product: f.saved.id }), { cls: 'primary', icon: 'plus', k: 'su:first' })] };
  }
  if (f.step === 'product') {
    const rn = rootNotice(f);
    if (rn) body.push(rn);
    body.push(
      input('su-name', 'Tên sản phẩm', 'name', { max: 40, ph: 'Ví dụ: Quà biết nói', hint: () => (pid ? `Thư mục và mã: ${pid}` : 'Tên người đọc thấy.') }),
      input('su-site', 'Trang web', 'site', { ph: 'quabietnoi.vn', hint: 'Người viết dẫn link về đây.' }),
      input('su-about', 'Sản phẩm làm gì, cho ai', 'about', { area: true, max: 600, ph: 'Ví dụ: tặng quà kèm một lời nhắn bằng giọng nói; cho người ở xa nhà', hint: 'Hai ba câu là đủ. Bàn ghi vào brand.md để Người viết đọc.' }),
      h('div', { class: 'mk-field' }, h('span', { class: 'lb' }, 'Viết bằng'), h('div', { class: 'mk-seg', role: 'group', 'aria-label': 'Viết bằng' },
        ...[['vi', 'Tiếng Việt'], ['en', 'English'], ['vi,en', 'Cả hai']].map(([v, l]) => btn(l, () => { f.langs = v; f.dirty = true; renderSheet(); }, { pressed: f.langs === v, k: `su:lang:${v}` })))));
    foot.push(note, next());
  } else if (f.step === 'blog') {
    const opt = (v, icon, title, sub, disabled) => h('button', { type: 'button', class: 'mk-opt', role: 'radio', 'aria-checked': String(f.blog === v), disabled, 'data-k': `su:blog:${v}`, onclick: () => { f.blog = v; f.dirty = true; renderSheet(); } },
      ic(icon, 's16'), h('span', null, h('b', null, title), h('span', null, sub)));
    if (f.dir === undefined) f.dir = `${pid || 'san-pham'}/site/posts`;
    body.push(h('div', { class: 'mk-field' }, h('span', { class: 'lb', id: 'su-blog' }, 'Bài blog lên đâu'), h('div', { class: 'mk-opts', role: 'radiogroup', 'aria-labelledby': 'su-blog' },
      opt('folder', 'folder', 'Thư mục site', 'Bài duyệt xong được ghi thành Markdown vào thư mục này; bạn tự đưa site lên.'),
      opt('hub', 'server', 'Máy chủ đăng bài', hubOk ? 'Duyệt xong, máy chủ đưa bài lên blog theo nhịp.' : 'Chưa nối máy chủ đăng bài.', !hubOk),
      opt('none', 'x_circle', 'Chưa có blog', 'Người viết chỉ soạn bài mạng xã hội, cộng đồng và bản tin.'))));
    if (f.blog === 'folder') body.push(input('su-dir', 'Thư mục site', 'dir', { max: 200, ph: `${pid || 'san-pham'}/site/posts`, hint: 'Nằm trong thư mục marketing.' }));
    foot.push(note, back, next());
  } else if (f.step === 'channels') {
    const rows = SETUP_CH.map(c => {
      const st = f.ch[c.id] ?? (f.ch[c.id] = { on: false, value: '' });
      const how = c.id === 'tiktok' || c.id === 'community' ? 'Bạn đăng, Soot soạn sẵn' : c.id === 'newsletter' ? 'Bạn bấm gửi; dán danh sách người nhận vào bàn sau' : hubOk ? 'Nối vào máy chủ đăng bài sau' : 'Bạn đăng tay rồi dán link';
      const toggle = h('button', { type: 'button', role: 'checkbox', 'aria-checked': String(st.on), 'data-k': `su:ch:${c.id}`, onclick: () => { st.on = !st.on; f.dirty = true; if (f.bad === `ch-${c.id}`) f.bad = null; renderSheet(); } }, c.label);
      const key = `ch-${c.id}`;
      const field = st.on && c.field ? (() => {
        const el = h('input', { id: `su-ch-${c.id}`, type: 'text', maxlength: c.id === 'community' ? '300' : '80', placeholder: c.ph, 'aria-label': c.field, 'aria-invalid': f.bad === key ? 'true' : null, 'aria-describedby': `su-ch-${c.id}-hint`, autocomplete: 'off' });
        /** @type {any} */ (el).value = st.value;
        el.addEventListener('input', () => { st.value = /** @type {any} */ (el).value; f.dirty = true; if (f.bad === key) { f.bad = null; el.removeAttribute('aria-invalid'); } });
        return el;
      })() : null;
      return h('div', { class: st.on ? 'mk-chrow on' : 'mk-chrow' }, toggle, h('div', { class: 'grow' }, field, h('span', { class: f.bad === key ? 'err-hint' : 'hint', id: `su-ch-${c.id}-hint` }, f.bad === key ? f.badText : how)));
    });
    body.push(h('div', { class: 'mk-field' }, h('span', { class: 'lb' }, 'Đăng ở đâu'), h('div', { class: 'mk-chrows' }, ...rows)),
      h('p', { class: 'mk-fine' }, 'Chọn sau cũng được. Kênh chưa chọn thì Người viết không soạn bài cho kênh đó.'));
    foot.push(note, back, next());
  } else {
    const chs = SETUP_CH.filter(c => f.ch[c.id]?.on).map(c => `${c.label}${f.ch[c.id].value ? ` (${String(f.ch[c.id].value).trim()})` : ''}`);
    body.push(kv([['Sản phẩm', `${name}${f.site ? ` · ${f.site}` : ''}`], ['Viết bằng', { vi: 'Tiếng Việt', en: 'English', 'vi,en': 'Tiếng Việt và English' }[f.langs]], ['Blog', f.blog === 'hub' ? 'Máy chủ đăng bài' : f.blog === 'none' ? 'Chưa có blog' : `Ghi vào ${String(f.dir ?? '').trim() || `${pid}/site/posts`}`], ['Nơi đăng', chs.join(', ') || 'Chưa chọn']]),
      notice('plain', 'info', null, `Bàn ghi ${name} vào products.json và tạo brand.md trong thư mục marketing. Không có gì được đăng.`));
    const save = btn('Lưu sản phẩm', async () => {
      const out = await act('setup', { product: M.setupProduct(f) }, save, {
        // A refusal about one field goes back to that field; a write failure stays a toast and keeps the input.
        onError: (e) => { const x = SETUP_ERR[e?.code]; if (!x) return false; f.step = x.step; refuse(x); return true; },
      });
      if (!out) return;
      f.saved = out;
      f.dirty = false;
      renderSheet(true);
      load({ quiet: true });
    }, { cls: 'primary', k: 'su:save' });
    foot.push(note, back, save);
  }
  // Once a product exists the same sheet adds another one: its title says so.
  return { title: products.length ? 'Thêm sản phẩm' : 'Bắt đầu marketing', sub: [f.step === 'product' ? 'Cho bàn biết bạn làm gì' : name], body, foot, w: 'w480' };
}

const SHEET = { item: sheetItem, uncertain: sheetUncertain, channel: sheetChannel, create: sheetCreate, setup: sheetSetup };


// ---------- toast, keys, start ----------

function toast(text, tone) {
  S.toast = { text, err: tone === 'err', at: Date.now() };
  toastHost.replaceChildren(h('div', { class: tone === 'err' ? 'mk-toast err' : 'mk-toast', role: tone === 'err' ? 'alert' : 'status' }, ic(tone === 'err' ? 'alert' : 'check_circle', 's14'), text));
  const at = S.toast.at;
  setTimeout(() => { if (S.toast?.at === at) { S.toast = null; toastHost.replaceChildren(); } }, tone === 'err' ? 6000 : 3600);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) { e.preventDefault(); requestClose(); return; }
  const t = /** @type {HTMLElement} */ (e.target);
  if ((e.key === 'Enter' || e.key === ' ') && t?.classList?.contains('click')) { e.preventDefault(); t.click(); }
  // Keep Tab inside an open sheet.
  if (e.key === 'Tab' && S.sheet) {
    const f = [...sheetHost.querySelectorAll('button, input, textarea, summary, [tabindex="0"]')].filter(x => !(/** @type {any} */ (x).disabled));
    if (!f.length) return;
    const first = /** @type {HTMLElement} */ (f[0]), last = /** @type {HTMLElement} */ (f[f.length - 1]);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

renderMain();
// live: once ready, again whenever Nest says data moved (an approval decided in Cần bạn), when shown again, and every minute.
soot.live(() => load({ quiet: !!S.summary }), { every: 60000 });
