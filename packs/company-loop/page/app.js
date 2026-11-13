// Công ty (company-loop). Plain DOM, no network: every read and write is a `call` posted to Nest
// (soot-pages bridge v2), which runs this pack's page_view / page_action tool. Text is set with
// textContent only; sizes are set through CSSOM (no style attributes). The view model carries codes and
// numbers; the words are here. Nest's chosen project ({id, name, teams} or null for every project) and the
// projects the viewer can see arrive in `init` and again in a `context` message on every change; the
// standalone shell sends `project: null` and no list.
'use strict';
(() => {
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PRODUCT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const rid = (prefix, bytes = 12) => prefix + '-' + Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const isTokens = t => !!t && typeof t === 'object' && !Array.isArray(t) && Object.entries(t).every(([k, v]) => /^--[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 512);

const waiting = new Map();
// project: Nest's chosen project (undefined before init; null = every project).
// projects: the projects Nest lists ([] when the host sends none: no switch, the page follows project).
// local: the page's own switch (undefined = follow Nest; null = every product; an id).
const S = { edit: null, draft: null, data: null, error: '', busy: false, notice: '', pending: null, locale: 'vi', project: undefined, projects: [], local: undefined, started: false, seq: 0 };
const embedded = window.parent !== window;

const str = (v, max) => typeof v === 'string' && v.length <= max;
const only = (m, keys, optional = []) => Object.keys(m).every(k => keys.includes(k) || optional.includes(k)) && keys.every(k => k in m);
const isProject = p => p === null || (!!p && typeof p === 'object' && only(p, ['id', 'name', 'teams']) && str(p.id, 64) && p.id !== '' && str(p.name, 128) &&
  Array.isArray(p.teams) && p.teams.length <= 64 && p.teams.every(t => str(t, 64)));
// `projects` is optional: an older host and the standalone shell send none.
const isProjects = l => l === undefined || (Array.isArray(l) && l.length <= 64 && l.every(p => p !== null && isProject(p)));
function parse(m) {
  if (!m || typeof m !== 'object' || m.v !== 2) return null;
  if (m.type === 'init') return only(m, ['v', 'type', 'theme', 'locale', 'tokens', 'viewer', 'project'], ['projects']) && ['light', 'dark'].includes(m.theme) && isTokens(m.tokens) && isProject(m.project) && isProjects(m.projects) ? m : null;
  if (m.type === 'theme') return only(m, ['v', 'type', 'theme', 'tokens']) && ['light', 'dark'].includes(m.theme) && isTokens(m.tokens) ? m : null;
  if (m.type === 'context') return only(m, ['v', 'type', 'project'], ['projects']) && isProject(m.project) && isProjects(m.projects) ? m : null;
  if (m.type === 'result' && typeof m.id === 'string' && BRIDGE_ID.test(m.id)) return m;
  return null;
}
function applyTheme(m) { for (const [k, v] of Object.entries(m.tokens)) document.documentElement.style.setProperty(k, v); document.documentElement.dataset.theme = m.theme; }
// projects: the list as sent; undefined keeps the last one (init starts from none).
function follow(project, projects) {
  const before = JSON.stringify([S.project, S.projects]), was = S.project;
  S.project = project;
  // Only projects that are product ids can narrow the page; the rest are not listed in its switch.
  if (projects !== undefined) S.projects = projects.filter(p => PRODUCT.test(p.id));
  // A project change in Nest wins over the page's own switch; a new name, teams or list only reloads.
  if ((project?.id ?? null) !== (was?.id ?? null)) S.local = undefined;
  if (JSON.stringify([S.project, S.projects]) !== before && S.started) reload();
}
window.addEventListener('message', e => {
  if (embedded && e.source !== window.parent) return;
  const m = parse(e.data);
  if (!m) return;
  if (m.type === 'init') { applyTheme(m); S.locale = m.locale; follow(m.project, m.projects ?? []); start(); }
  else if (m.type === 'theme') applyTheme(m);
  else if (m.type === 'context') follow(m.project, m.projects);
  else { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); clearTimeout(w.timer); w.resolve(m.ok ? { ok: true, output: m.output } : { ok: false, error: m.error }); } }
});
function call(mode, input, requestID) {
  const id = rid('c', 8);
  return new Promise(resolve => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: { code: 'no_response', message: 'no result from the host' } }); }, 90000);
    waiting.set(id, { resolve, timer });
    window.parent.postMessage({ v: 2, type: 'call', id, mode, input, ...(requestID ? { request_id: requestID } : {}) }, '*');
  });
}
const open = link => { if (/^(https|nest):\/\//.test(link) && link.length <= 2048) window.parent.postMessage({ v: 2, type: 'open', link }, '*'); };
function output(r) {
  if (!r.ok) throw r.error;
  if (r.output?.error) throw r.output.error;
  return r.output;
}

// ---------- scope ----------
// Nest's project is the product of the same id: its name and teams narrow the page.
const nestProduct = () => (S.project && PRODUCT.test(S.project.id) ? S.project.id : null);
const chosen = () => (S.local !== undefined ? S.local : nestProduct());
const asProduct = p => ({ id: p.id, name: p.name, teams: p.teams.slice(0, 64) });
function viewInput() {
  const product = chosen();
  // Nest's projects as products (0.14.5's context.products); a host with no list gives only the chosen one.
  const list = S.projects.length ? S.projects : nestProduct() ? [S.project] : [];
  const products = list.map(asProduct);
  if (nestProduct() && !products.some(p => p.id === S.project.id) && products.length < 64) products.push(asProduct(S.project));
  return { page: 'company', ...(product ? { product } : {}), ...(products.length ? { products } : {}) };
}
const choose = id => { S.local = id === nestProduct() ? undefined : id; S.notice = ''; reload(); };

// ---------- words ----------
const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const MONEY = { vnd: '₫', usd: 'US$', eur: '€' };
function fmt(v, unit) {
  if (v === null || v === undefined) return 'Chưa có';
  const u = String(unit || '').toLowerCase();
  if (u === 'vnd') return Math.abs(v) >= 1e6 ? `${nf.format(v / 1e6)} tr ₫` : `${nf.format(v)} ₫`;
  if (MONEY[u]) return `${nf.format(v)} ${MONEY[u]}`;
  if (u === 'percent' || u === '%') return `${nf.format(v)}%`;
  if (!u || u === 'count') return nf.format(v);
  return `${nf.format(v)} ${u.slice(0, 12)}`;
}
const two = n => String(n).padStart(2, '0');
const at = iso => { const d = iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso) : null; return d && !isNaN(d) ? d : null; };
/** "10/11": a calendar day (a period's YYYY-MM-DD is that day, not UTC midnight). */
const dm = iso => { const d = at(iso); return d ? `${two(d.getDate())}/${two(d.getMonth() + 1)}` : ''; };
/** "06:30 10/11": a snapshot says when it was taken, so a morning figure is not read as now. */
const when = iso => { const d = at(iso); return d ? `${two(d.getHours())}:${two(d.getMinutes())} ${dm(iso)}` : ''; };
const signed = v => `${v > 0 ? '+' : ''}${nf.format(v)}`;
const KIND = { content: 'Nội dung', product: 'Sản phẩm' };
const EFFORT = { S: 'nhỏ', M: 'vừa', L: 'lớn', XL: 'rất lớn' };
const VALUE = { low: 'thấp', medium: 'vừa', high: 'cao' };
const REF = { metric: 'Số', source: 'Nguồn', reason: 'Lý do', gap: 'Thiếu bài', feedback: 'Phản hồi' };
const DECISION = { go: 'Go', later: 'Để sau', drop: 'Bỏ' };
const metric = k => S.data?.metric_labels?.[k] ?? k;
const evidenceRef = r => { const at = r.indexOf(':'), kind = at > 0 ? r.slice(0, at) : ''; return REF[kind] ? `${REF[kind]}: ${kind === 'metric' ? metric(r.slice(at + 1)) : r.slice(at + 1)}` : r; };
const productName = id => S.data?.scope?.products?.find(p => p.id === id)?.name ?? id;
const scopeName = d => d.scope.product?.name ?? 'Mọi sản phẩm';
const many = d => !d.scope.product && (d.scope.products?.length ?? 0) >= 2;
const SETTINGS = key => `nest://settings/setup?key=${encodeURIComponent(key)}`;
const draft = text => `nest://new?text=${encodeURIComponent(text.slice(0, 1500))}`;
const RHYTHM = [
  ['company-scoreboard', 'Đọc bảng số', 'Mỗi sáng 06:15'],
  ['company-digest', 'Bản tin cơ hội', 'Thứ Hai 08:30'],
  ['company-review', 'Chấm kết quả quyết định', 'Thứ Hai 08:00'],
  ['company-watch', 'Theo dõi đội dựng', '30 phút một lần'],
];
const HAND = {
  spawned: ['Đội đã mở', 1, 'Đội bbs:team đang làm rõ yêu cầu. Soot kiểm tra mỗi 30 phút, bạn chưa phải làm gì.'],
  starting: ['Đội đang đọc yêu cầu', 1, 'Đội đang đọc yêu cầu: chưa có việc cần bạn.'],
  building: ['Đang dựng', 1, 'Soot kiểm tra mỗi 30 phút, bạn chưa phải làm gì.'],
  blocked: ['Vướng khi phát hành', 1, 'Đội đang xử lý; mở terminal của đội trong Orca nếu cần xem.'],
  delivered: ['Chờ bạn duyệt', 2, 'Duyệt bản giao rồi cho phép phát hành trong bbs:team. Soot không phát hành thay bạn.'],
  released: ['Đã phát hành', 3, 'Soot đo kết quả từ ngày phát hành.'],
  draft_ready: ['Bản nháp sẵn', 0, 'Soot đã viết yêu cầu nhưng chưa mở được đội dựng.'],
  no_repo: ['Chưa có kho mã', 0, 'Soot chưa tìm được kho mã của sản phẩm này trên máy. Sửa PRODUCT_REPOS rồi bấm Chạy lại, hoặc giao việc cho người.'],
  task: ['Chờ người làm', 0, 'Đã ghi quyết định và một việc. Chưa nối đội dựng nên Soot không tự làm.'],
};
// The 5 parts of a product business, the 3 reader awareness levels and the 7 moats, in the founder's words.
const PART = { value: 'Tạo giá trị', marketing: 'Marketing', sales: 'Bán hàng', delivery: 'Giao giá trị', finance: 'Tài chính' };
const AWARE = { unaware: 'Nấc 1 · chưa biết vấn đề', problem: 'Nấc 2 · biết vấn đề, chưa biết cách giải', choosing: 'Nấc 3 · đang chọn mua' };
const AWARE_SHORT = { unaware: 'Nấc 1', problem: 'Nấc 2', choosing: 'Nấc 3' };
const MOAT = { scale: 'Quy mô', network: 'Mạng lưới', counter: 'Định vị ngược', switching: 'Chi phí chuyển đổi', brand: 'Thương hiệu', cornered: 'Nguồn lực độc quyền', process: 'Quy trình' };
const STATUS = { ok: ['Ổn', 'ok', 'ok'], hong: ['Hỏng', 'bad', 'bad'], chua_do: ['Chưa đo', '', 'idle'] };
/** Small tags of an opportunity or a decision: part, awareness (content), moat. A row from before these tags has none: nothing is shown, never guessed. */
const tags = x => [x.part && PART[x.part] ? `Bộ phận: ${PART[x.part]}` : null, x.awareness && AWARE_SHORT[x.awareness] ? AWARE_SHORT[x.awareness] : null, MOAT[x.moat] ? `Hào: ${MOAT[x.moat]}` : null].filter(Boolean);
const tagRow = x => (tags(x).length ? h('div', { class: 'chips' }, tags(x).map(t => h('span', { class: 'chip' }, t))) : null);
const TOPIC = { queued: ['Chờ Writer', ''], handed: ['Đã giao Writer', 'warn'], written: ['Đã viết', 'ok'] };

// ---------- dom ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false && kid !== '') el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return el;
}
const btn = (text, fn, cls = '') => h('button', { class: `btn ${cls}`.trim(), type: 'button', disabled: S.busy, onclick: fn }, text);
const linkBtn = (text, link, cls = 'link') => btn(text, () => open(link), cls);
const badge = (text, tone = '') => h('span', { class: `badge ${tone}`.trim() }, text);
const lamp = tone => h('span', { class: `lamp ${tone}`.trim(), 'aria-hidden': 'true' });
const small = (text, cls = 'small muted') => h('p', { class: cls }, text);
const jump = id => () => { const el = document.getElementById(id); if (el) { el.scrollIntoView({ block: 'start' }); el.querySelector('button, summary')?.focus({ preventScroll: true }); } };
const sizeTo = (el, prop, pct) => { el.style[prop] = `${Math.max(0, Math.min(100, pct))}%`; return el; };
const sec = (id, title, aside, ...body) => h('section', { id, 'aria-label': title }, h('div', { class: 'sec-h' }, h('h2', {}, title), aside ? h('span', { class: 'small muted' }, aside) : null), ...body);
const empty = (...lines) => h('div', { class: 'empty' }, ...lines);

async function load() {
  // Only the newest view counts: a slow answer for a scope the founder has left is dropped.
  const seq = ++S.seq;
  let data = null, error = '';
  try { data = output(await call('view', viewInput())); }
  catch (e) {
    // The host's transport failures (server off, a gateway error, no answer) read as one plain line.
    const down = ['no_response', 'unavailable', 'busy'].includes(e?.code) || /^http_5\d\d$/.test(e?.code ?? '');
    error = down ? (e.code === 'busy' ? 'Máy chủ đang bận. Đợi một lát rồi bấm Tải lại.' : 'Chưa nhận được trả lời từ máy chủ. Trang giữ nguyên; bấm Tải lại khi máy chủ chạy lại.') : `Máy chủ báo: ${e?.message || e?.code || 'lỗi không rõ'}`;
  }
  if (seq !== S.seq) return false;
  S.error = error;
  if (data) S.data = data;
  return true;
}
async function reload() { if (await load()) render(); }
async function act(op, rest = {}) {
  if (S.busy) return;
  const key = JSON.stringify([op, rest]);
  S.pending = S.pending?.key === key ? S.pending : { key, id: rid('cl', 12) };
  S.busy = true; render();
  try {
    const r = await call('action', { op, request_id: S.pending.id, ...rest }, S.pending.id);
    if (!r.ok && r.error.code === 'no_response') S.notice = 'Chưa chắc việc đã xong: bấm Tải lại để xem.';
    else {
      S.pending = null;
      if (op === 'part_set') { S.edit = null; S.draft = null; }
      try { const o = output(r); S.notice = op === 'sync' ? (o.ok === false ? 'Chưa đọc được số mới.' : 'Đã đọc số mới.') : o.handoff?.note || 'Xong.'; } catch (e) { S.notice = e?.message || 'Không làm được.'; }
      await load();
    }
  } finally { S.busy = false; render(); }
}

// ---------- the one next step ----------
function nextOf(d) {
  const n = d.next, name = scopeName(d), sb = d.scoreboard;
  const task = d.handoffs.find(x => x.opportunity === n.ref) ?? d.handoffs.find(x => x.state === 'task');
  switch (n.code) {
    case 'setup': return n.missing === 'key'
      ? ['warn', 'Chưa có khoá đọc bảng số', 'Đã có địa chỉ bảng số nhưng chưa có khoá PRODUCT_ADMIN_KEY. Nhập khoá rồi bấm Đọc số ngay.', ['Nhập khoá trong Thiết lập', () => open(SETTINGS('PRODUCT_ADMIN_KEY')), 'primary']]
      : ['warn', `Chưa có bảng số cho ${name}`, 'Nối địa chỉ bảng số của sản phẩm, hoặc để một Soot ghi số mỗi tuần vào bảng của trang này (công cụ Ghi số liệu).', ['Mở Thiết lập', () => open(SETTINGS('SCOREBOARD_URL')), 'primary']];
    case 'key_refused': return ['bad', `Chưa đọc được số mới${d.sync?.since ? ` từ ${dm(d.sync.since)}` : ''}`, `Máy chủ sản phẩm từ chối khoá quản trị. Nhập khoá mới có quyền đọc bảng số; ${sb ? `số bên dưới là của ${dm(sb.from)}–${dm(sb.to)}` : 'chưa có số cũ để hiện'}.`, ['Đổi khoá trong Thiết lập', () => open(SETTINGS('PRODUCT_ADMIN_KEY')), 'primary']];
    case 'no_data': return ['idle', `${name} chưa có số liệu hay cơ hội nào`, 'Nối bảng số cho sản phẩm này (SCOREBOARD_URLS) hoặc để Soot ghi số, rồi bản tin thứ Hai sẽ đưa cơ hội vào đây. Các mục của sản phẩm khác đang được ẩn.', ['Xem mọi sản phẩm', () => choose(null), 'strong']];
    case 'choose': return ['warn', `${n.n} cơ hội chờ bạn chọn`, 'Chọn Go, Để sau hoặc Bỏ ở từng cơ hội. Soot chỉ bắt đầu dựng sau khi bạn bấm Go.', [`Xem ${n.n} cơ hội`, jump('needs'), 'primary']];
    case 'draft_ready': return ['warn', 'Yêu cầu đã viết, đội dựng chưa mở', 'Soot chưa mở được đội bbs:team. Mở Orca rồi bấm Chạy lại, hoặc chạy lệnh trong mục Cần bạn.', ['Chạy lại', () => act('retry_handoff', { id: n.ref }), 'primary']];
    case 'no_repo': return ['bad', 'Chưa có kho mã để ghi yêu cầu', 'Soot chưa tìm được kho mã của sản phẩm này trên máy. Sửa PRODUCT_REPOS rồi bấm Chạy lại, hoặc giao việc cho người ở mục Cần bạn.', ['Mở Thiết lập', () => open(SETTINGS('PRODUCT_REPOS')), 'primary']];
    case 'task': return ['warn', `${n.n} việc đã ghi chờ người làm`, 'Máy này không có kho mã, nên sau Go Soot ghi quyết định và yêu cầu. Máy dựng của sản phẩm sẽ tự nhận; chưa có máy dựng thì giao việc cho người trong nhóm, xong thì đánh dấu để Soot đo kết quả từ ngày đó.', ['Giao việc', () => open(taskDraft(task)), 'primary']];
    case 'release_go': return ['warn', 'Bản giao chờ bạn duyệt phát hành', 'Đọc bản bàn giao trong terminal của đội ở Orca; hài lòng thì cho phép phát hành. Đó là lượt bấm cuối của bạn.', ['Xem bản giao', jump('needs'), 'primary']];
    case 'building': return ['ok', 'Đội đang dựng, bạn chưa phải làm gì', 'Soot kiểm tra tiến độ mỗi 30 phút và báo khi có bản giao cần bạn duyệt.', ['Xem tiến độ', jump('pipeline'), 'strong']];
    case 'sync_failed': return ['bad', 'Chưa đọc được số mới', 'Bảng số không trả lời ở lần đọc gần nhất. Soot thử lại mỗi sáng; bấm Đọc số ngay để thử lại bây giờ.', ['Đọc số ngay', () => act('sync'), 'primary']];
    case 'part_hong': {
      const x = d.parts?.items.find(i => i.part === n.part);
      const move = x && x.pct !== null && x.pct !== undefined ? `${x.label} ${x.pct > 0 ? 'tăng' : 'giảm'} ${nf.format(Math.abs(x.pct))}%` : x ? `${x.label} chưa đạt mục tiêu` : '';
      return ['warn', `Bộ phận ${PART[n.part] ?? n.part} đang hỏng${move ? `: ${move}` : ''}`, 'Không có việc nào khác cần bạn. Xem “Khám 5 bộ phận”: giao người phụ trách, rồi chọn việc sửa đúng bộ phận này.', ['Xem 5 bộ phận', jump('parts'), 'primary']];
    }
    case 'topic_handed': return ['ok', `${n.n} chủ đề đã giao Writer, chưa viết`, 'Bài lên ở lượt viết kế tiếp; bạn không phải làm gì.', ['Xem chủ đề', jump('pipeline'), 'strong']];
    case 'topics': return ['ok', `${n.n} chủ đề đang chờ Writer`, 'Bài sẽ tự lên lịch; bạn không phải làm gì.', ['Xem chủ đề', jump('pipeline'), 'strong']];
    default: return ['ok', 'Không có việc nào cần bạn', 'Soot đang tự chạy. Bản tin cơ hội kế tiếp: thứ Hai 08:30.', ['Xem lịch chạy', () => open(`nest://schedules/${encodeURIComponent(d.soot || 'company-digest')}`), 'strong']];
  }
}
function taskDraft(x) {
  if (!x) return 'nest://new';
  return draft(`Việc cần làm (đã Go trên trang Công ty): ${x.title}.${x.summary ? ` ${x.summary}` : ''} Làm xong thì báo để mình đánh dấu đã xong.`);
}
function nextBar(d) {
  const [tone, title, why, a] = nextOf(d);
  return h('div', { class: `next ${tone === 'warn' || tone === 'bad' ? tone : ''}`.trim(), role: 'status' },
    lamp(tone), h('div', { class: 'body' }, h('span', { class: 'title' }, title), h('span', { class: 'muted' }, why)),
    a ? h('span', { class: 'act' }, btn(a[0], a[1], a[2])) : null);
}

// ---------- header and scope ----------
// The switch lists Nest's projects (never products only the data names); no list, no switch.
function header(d) {
  const waitingOf = id => (d.scope.products ?? []).find(p => p.id === id)?.waiting ?? 0;
  const ps = S.projects.map(p => ({ id: p.id, name: p.name || p.id, waiting: waitingOf(p.id) }));
  const cur = d.scope.product?.id ?? null, follows = S.local === undefined && nestProduct();
  const sub = [`Số lúc ${when(d.at)}`, follows ? 'theo sản phẩm đang chọn ở Nest' : null].filter(Boolean).join(' · ');
  return h('div', { class: 'head' },
    h('div', {}, h('h1', {}, 'Công ty'), h('p', { class: 'sub muted small' }, sub)),
    h('div', { class: 'row' },
      ps.length >= 2 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Sản phẩm đang xem' },
        [{ id: null, name: 'Mọi sản phẩm' }, ...ps].map(p => h('button', { type: 'button', 'aria-pressed': String(p.id === cur), disabled: S.busy, onclick: () => choose(p.id) }, p.name, p.waiting ? h('span', { class: 'count', 'aria-label': `${p.waiting} việc chờ bạn` }, String(p.waiting)) : null))) : null,
      btn('Đọc số ngay', () => act('sync'), 'text'), btn('Tải lại', reload, 'text')));
}
function scopeLine(d) {
  const out = [];
  if (S.local !== undefined && nestProduct() !== chosen()) {
    out.push(h('div', { class: 'notice' }, h('span', {}, `Bạn đang xem ${scopeName(d)} trên trang này; Nest đang chọn ${S.project?.name ?? 'mọi sản phẩm'}.`), btn('Theo Nest', () => { S.local = undefined; reload(); }, 'link')));
  }
  const lo = d.scope.left_out ?? {};
  const parts = [['cơ hội', lo.opportunities], ['bàn giao', lo.handoffs], ['quyết định', lo.decisions], ['chủ đề', lo.topics]].filter(([, n]) => n).map(([w, n]) => `${n} ${w}`);
  if (d.scope.product && (parts.length || d.scope.unlabeled)) {
    const old = d.scope.unlabeled ? ` ${d.scope.unlabeled} mục cũ chưa gắn sản phẩm chỉ hiện ở Mọi sản phẩm.` : '';
    out.push(h('div', { class: 'notice' }, h('span', {}, `Đang xem ${scopeName(d)}.${parts.length ? ` Không tính ${parts.join(', ')} của sản phẩm khác.` : ''}${old}`), btn('Xem mọi sản phẩm', () => choose(null), 'link')));
  }
  return out;
}

// ---------- Cần bạn ----------
function oppItem(o, d) {
  const measure = `Đo bằng ${metric(o.target_outcome)}: kỳ vọng ${signed(o.expected_delta)} so với tuần trước, xem lại sau ${o.check_after_days} ngày`;
  const facts = [measure, o.est_effort && `công ${EFFORT[o.est_effort] ?? o.est_effort}`, o.est_value && `giá trị ${VALUE[o.est_value] ?? o.est_value}`, Number.isFinite(o.signal_count) && `${o.signal_count} tín hiệu`].filter(Boolean).join(' · ');
  const later = o.state === 'later';
  return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp(later ? 'idle' : 'warn'), h('span', { class: 't' }, o.title), many(d) && o.product ? badge(productName(o.product)) : null, badge(KIND[o.kind] ?? o.kind), badge(later ? 'Để sau' : 'Chờ bạn chọn', later ? '' : 'warn')),
    tagRow(o),
    o.pain ? small(`Ai khổ vì gì: ${o.pain}`) : null,
    o.summary ? h('p', {}, o.summary) : null,
    o.kind === 'content' && o.query ? small(`Chủ đề tìm kiếm: ${o.query}`) : null,
    small(facts),
    h('div', { class: 'row' },
      ...goButtons(o, d),
      later ? null : btn('Để sau', () => act('later', { id: o.ref })), btn('Bỏ', () => act('drop', { id: o.ref }), 'text'),
      (o.evidence_refs ?? []).length ? h('details', {}, h('summary', {}, 'Bằng chứng'), h('div', { class: 'chips' }, o.evidence_refs.map(r => h('span', { class: 'chip' }, evidenceRef(r))))) : null));
}
// A product with a project gets both ways to Go; a large one (L, XL) leads with the person, since one unattended team rarely lands it.
function goButtons(o, d) {
  if (o.kind !== 'product') return [btn('Go', () => act('go', { id: o.ref }), 'strong')];
  if (!o.build) return [btn(d.setup.build ? 'Go: bắt đầu dựng' : 'Go: ghi thành việc', () => act('go', { id: o.ref }), 'strong')];
  const person = strong => btn('Go: giao người làm', () => act('go', { id: o.ref, build: 'person' }), strong ? 'strong' : undefined);
  const big = ['L', 'XL'].includes(String(o.est_effort ?? '').trim().toUpperCase());
  const soot = btn('Go: Soot dựng', () => act('go', { id: o.ref }), big ? undefined : 'strong');
  return big ? [person(true), soot] : [soot, person(false)];
}
function handoffNeed(x, d) {
  const prod = many(d) && x.product ? badge(productName(x.product)) : null;
  if (x.state === 'delivered') return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp('warn'), h('span', { class: 't' }, `Bản giao “${x.title}” chờ bạn duyệt phát hành`), prod, badge('Lượt bấm cuối', 'warn')),
    small(x.detail || HAND.delivered[2], 'muted'),
    x.command ? h('details', {}, h('summary', {}, 'Lệnh cho phép phát hành'), h('code', { class: 'cmd' }, x.command)) : null);
  if (x.state === 'task') return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp('warn'), h('span', { class: 't' }, x.title), prod, badge('Việc đã ghi', 'warn')),
    x.summary ? h('p', {}, x.summary) : null,
    small('Đã Go: quyết định đã vào nhật ký. Yêu cầu chờ máy dựng nhận (hoặc người làm); xong thì Soot đo kết quả từ ngày đó.'),
    x.person && x.note ? small(x.note, 'muted') : null,
    h('div', { class: 'row' }, btn('Giao việc', () => open(taskDraft(x)), 'strong'), btn('Đánh dấu đã xong', () => act('task_done', { id: x.opportunity })),
      x.person ? btn('Để Soot dựng', () => act('retry_handoff', { id: x.opportunity }), 'text') : null));
  // draft_ready, no_repo
  return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp(x.state === 'no_repo' ? 'bad' : 'warn'), h('span', { class: 't' }, x.title), prod, badge(HAND[x.state][0], x.state === 'no_repo' ? 'bad' : 'warn')),
    small(x.detail || HAND[x.state][2], 'muted'),
    x.command ? h('code', { class: 'cmd' }, x.command) : null,
    h('div', { class: 'row' }, btn('Chạy lại', () => act('retry_handoff', { id: x.opportunity }), 'strong'), btn('Giao người làm', () => act('to_person', { id: x.opportunity })),
      x.state === 'no_repo' ? linkBtn('Đặt PRODUCT_REPOS', SETTINGS('PRODUCT_REPOS')) : null));
}
function setupNeed(d) {
  const n = d.next, name = scopeName(d);
  if (n.code === 'setup') return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp('warn'), h('span', { class: 't' }, 'Nối bảng số')),
    small('Hai cách: (1) địa chỉ bảng số của sản phẩm (SCOREBOARD_URL, khoá PRODUCT_ADMIN_KEY; nhiều sản phẩm thì SCOREBOARD_URLS) hoặc (2) một Soot ghi số mỗi tuần bằng công cụ “Ghi số liệu”. Hướng dẫn nằm trong README của gói.', 'muted'),
    h('div', { class: 'row' }, btn('Mở Thiết lập', () => open(SETTINGS(n.missing === 'key' ? 'PRODUCT_ADMIN_KEY' : 'SCOREBOARD_URL')), 'strong'),
      linkBtn('Nhờ Đầu mối ghi số', draft(`Mỗi thứ Hai, đọc số tuần trước của ${name} (doanh thu, đăng ký mới, khách trả tiền lần đầu…) rồi ghi vào trang Công ty bằng công cụ company-loop_metrics_record.`), 'text')));
  if (n.code === 'key_refused') return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp('bad'), h('span', { class: 't' }, `Khoá bảng số bị từ chối${d.sync?.since ? ` từ ${dm(d.sync.since)}` : ''}`)),
    small('Soot thử lại mỗi sáng. Đổi khoá xong bấm Đọc số ngay.', 'muted'),
    h('div', { class: 'row' }, btn('Đổi khoá trong Thiết lập', () => open(SETTINGS('PRODUCT_ADMIN_KEY')), 'strong'), btn('Đọc số ngay', () => act('sync'))),
    d.sync?.code ? h('details', {}, h('summary', {}, 'Chi tiết kỹ thuật'), h('p', {}, `${d.sync.code}: ${d.sync.message ?? ''}`)) : null);
  return null;
}
function needsSection(d) {
  const proposed = d.opportunities.filter(o => o.state === 'proposed');
  const later = d.opportunities.filter(o => o.state === 'later');
  const hand = d.handoffs.filter(x => ['delivered', 'task', 'draft_ready', 'no_repo'].includes(x.state));
  const items = [setupNeed(d), ...hand.filter(x => x.state !== 'delivered').map(x => handoffNeed(x, d)), ...proposed.map(o => oppItem(o, d)), ...hand.filter(x => x.state === 'delivered').map(x => handoffNeed(x, d))].filter(Boolean);
  return sec('needs', `Cần bạn${items.length ? ` · ${items.length}` : ''}`, 'Mỗi mục nói việc gì và làm ở đâu',
    h('div', { class: 'list' }, items.length ? items : empty(h('span', {}, 'Không có việc nào cần bạn lúc này.'), h('span', { class: 'small' }, 'Bản tin thứ Hai 08:30 sẽ đưa cơ hội mới vào đây.'))),
    later.length ? h('details', { class: 'later' }, h('summary', {}, `Để sau · ${later.length}`), h('div', { class: 'list' }, later.map(o => oppItem(o, d)))) : null);
}

// ---------- scorecard ----------
function delta(t) {
  if (t.pct === null || t.pct === undefined) return h('span', { class: 'was' }, t.previous === null || t.previous === undefined ? 'Chưa có kỳ trước' : `Kỳ trước ${fmt(t.previous, t.unit)}`);
  const up = t.pct > 0 ? 1 : t.pct < 0 ? -1 : 0;
  const tone = !up ? 'flat' : (up > 0) === (t.good !== 'down') ? 'ok' : 'bad';
  return h('span', { class: 'stack tight' }, h('span', { class: `delta ${tone}` }, `${up > 0 ? '▲ tăng' : up < 0 ? '▼ giảm' : '= bằng'} ${nf.format(Math.abs(t.pct))}%${tone === 'bad' ? ' · chưa tốt' : ''}`), h('span', { class: 'was' }, `Kỳ trước ${fmt(t.previous, t.unit)}`));
}
function targetBar(t) {
  if (!Number.isFinite(t.target) || !Number.isFinite(t.value) || t.target === 0) return null;
  const met = t.good === 'down' ? t.value <= t.target : t.value >= t.target;
  const fill = sizeTo(h('span'), 'width', t.good === 'down' ? (t.value > 0 ? (t.target / t.value) * 100 : 100) : (t.value / t.target) * 100);
  return h('div', { class: 'stack tight' }, h('div', { class: `target ${met ? 'met' : ''}`.trim(), role: 'img', 'aria-label': `Mục tiêu ${fmt(t.target, t.unit)}` }, fill),
    h('span', { class: 'small muted' }, `Mục tiêu ${fmt(t.target, t.unit)} · ${met ? 'đã đạt' : `còn ${fmt(Math.abs(t.target - t.value), t.unit)}`}`));
}
function spark(vals) {
  const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
  return h('div', { class: 'spark', role: 'img', 'aria-label': `Xu hướng ${vals.length} tuần, gần nhất ${nf.format(vals[vals.length - 1])}` },
    vals.map((v, i) => sizeTo(h('span', { class: i === vals.length - 1 ? 'now' : '' }), 'height', 12 + ((v - mn) / r) * 88)));
}
const SOURCE = b => (b.source === 'table' ? `do Soot ghi${b.recorded_source ? ` · ${b.recorded_source}` : ''}` : b.source === 'both' ? 'bảng số sản phẩm và số Soot ghi' : 'bảng số sản phẩm');
const period = b => `${dm(b.from)}–${dm(b.to)}`;
function scorecard(d) {
  if (d.boards) return sec('scoreboard', 'Bảng số theo sản phẩm', '7 ngày, so với 7 ngày trước',
    h('div', { class: 'list boards' }, d.boards.map(x => h('div', { class: 'board' },
      h('div', { class: 'stack tight' }, h('span', { class: 'strong' }, x.name), h('span', { class: 'small muted' }, x.none ? 'Chưa có số' : `${period(x)} · ${SOURCE(x)}`)),
      x.none ? small('Chưa có bảng số cho sản phẩm này.') : h('div', { class: 'mini' }, [x.north, ...x.tiles].filter(Boolean).map((t, i) => h('div', {}, h('span', { class: 'small muted' }, t.label), h('span', { class: i ? 'strong' : 'strong big' }, fmt(t.value, t.unit)), delta(t)))),
      btn('Xem', () => choose(x.product), 'text')))));
  const b = d.scoreboard;
  const head = (aside, ...body) => sec('scoreboard', 'Bảng số', aside, ...body);
  if (!b) {
    if (d.next.code === 'setup') return head(null, h('div', { class: 'card empty' }, h('strong', {}, 'Chưa có bảng số'), h('span', {}, 'Số sẽ hiện ở đây khi Soot đọc được kỳ đầu tiên. Nhãn và đơn vị lấy từ chính dữ liệu.'), btn('Mở Thiết lập', () => open(SETTINGS(d.next.missing === 'key' ? 'PRODUCT_ADMIN_KEY' : 'SCOREBOARD_URL')))));
    return head(null, h('div', { class: 'card empty' }, h('strong', {}, `${scopeName(d)} chưa có bảng số`),
      h('span', {}, d.scope.product ? `Thêm một dòng “${d.scope.product.id}=<địa chỉ bảng số>” vào SCOREBOARD_URLS, hoặc để Soot của sản phẩm này ghi số bằng “Ghi số liệu”.` : 'Soot đọc bảng số mỗi sáng 06:15. Bấm Đọc số ngay để đọc bây giờ.'),
      d.scope.product ? linkBtn('Mở Thiết lập', SETTINGS('SCOREBOARD_URLS'), 'strong') : btn('Đọc số ngay', () => act('sync'), 'strong')));
  }
  const stale = d.sync && d.sync.ok === false;
  const n = b.north;
  const rest = b.tiles.filter(t => t.key !== n?.key);
  return head(`${period(b)}, so với 7 ngày trước · ${SOURCE(b)}`,
    stale ? h('div', { class: 'notice' }, lamp('bad'), h('div', { class: 'stack tight' }, h('span', {}, `Chưa cập nhật từ ${dm(d.sync.since || d.sync.at)}. Số dưới đây là của ${period(b)}.`),
      d.sync.code ? h('details', {}, h('summary', {}, 'Chi tiết kỹ thuật'), h('p', {}, `${d.sync.code}: ${d.sync.message ?? ''}`)) : null)) : null,
    n ? h('div', { class: 'card north' }, h('div', { class: 'stack tight' }, h('span', { class: 'small muted' }, `Chỉ số chính · ${n.label}`), h('span', { class: 'v' }, fmt(n.value, n.unit)), delta(n), targetBar(n)), n.trend ? spark(n.trend) : null) : null,
    rest.length ? h('div', { class: 'tiles' }, rest.map(t => h('div', { class: 'card tile' }, h('span', { class: 'small muted' }, t.label), h('span', { class: 'v' }, fmt(t.value, t.unit)), delta(t), targetBar(t)))) : null,
    b.source !== 'table' && (!b.cohorts || !b.plans) ? h('details', {}, h('summary', {}, `${!b.cohorts && !b.plans ? 'Nhóm người dùng và gói' : !b.cohorts ? 'Nhóm người dùng' : 'Gói'}: chưa có`), h('p', {}, 'Bảng số chưa trả số theo tuần đăng ký (cohorts) hoặc theo gói (plans); bản tin dùng những gì đang có.')) : null);
}

// ---------- 5 parts ----------
function partRow(x, d) {
  const [word, tone, lampTone] = STATUS[x.status] ?? STATUS.chua_do;
  const editing = S.edit === x.part;
  const owner = x.team_name || x.team;
  const view = h('div', { class: 'item' },
    h('div', { class: 'item-h' }, lamp(lampTone), h('span', { class: 't' }, x.name), badge(word, tone), x.chua_giao ? badge('Chưa giao', 'warn') : null),
    small(`Phụ trách: ${owner || 'chưa giao'}`),
    x.metric ? h('div', { class: 'row part-metric' }, h('span', { class: 'small muted' }, x.label), h('span', { class: 'strong' }, fmt(x.value, x.unit)), x.value === null ? null : delta(x)) : small('Chưa chọn số liệu để đo bộ phận này.'),
    x.promise ? small(`Lời hứa: ${x.promise}`, 'small') : null,
    editing ? null : h('div', { class: 'row' }, btn('Đổi', () => { S.edit = x.part; S.draft = null; render(); }, 'text')));
  if (editing) view.append(partForm(x, d));
  return view;
}
function partForm(x, d) {
  const p = d.parts, dr = S.draft ?? {};
  const id = k => `p-${x.part}-${k}`;
  const opt = (value, label, on) => h('option', { value, selected: on }, label);
  const teams = p.teams ?? [];
  const owner = teams.length
    ? h('select', { class: 'input', id: id('team'), 'aria-label': 'Đội phụ trách' }, opt('', 'Chưa giao', !(dr.team ?? x.team)), teams.map(t => opt(t.id, t.name, (dr.team ?? x.team) === t.id)))
    : h('input', { class: 'input', id: id('team'), maxlength: '60', placeholder: 'Tên người hoặc đội phụ trách', 'aria-label': 'Người hoặc đội phụ trách', value: dr.team_name ?? x.team_name ?? '' });
  const metrics = h('select', { class: 'input', id: id('metric'), 'aria-label': 'Số liệu đo' }, opt('', 'Mặc định', !(dr.metric ?? (x.custom ? x.metric : ''))), p.metrics.map(m => opt(m.key, m.label, (dr.metric ?? (x.custom ? x.metric : '')) === m.key)));
  const promise = h('input', { class: 'input', id: id('promise'), maxlength: '120', placeholder: 'Lời hứa ngắn, giữ mỗi ngày (ví dụ: chương mới trước 8 giờ)', 'aria-label': 'Lời hứa', value: dr.promise ?? x.promise ?? '' });
  const save = () => {
    const v = k => document.getElementById(id(k))?.value ?? '';
    const team = v('team'), metric = v('metric');
    // team_name is capped at 60 characters by the tool; a long stage label is cut, not refused.
    const name = (teams.length ? (teams.find(t => t.id === team)?.name ?? '') : team.trim()).slice(0, 60);
    S.draft = { team: teams.length ? team : undefined, team_name: teams.length ? undefined : name, metric, promise: v('promise') };
    const good = p.metrics.find(m => m.key === metric)?.good;
    // The id is the team, the name is what the page shows; an empty string clears the field.
    act('part_set', { product: p.product, part: x.part, ...(teams.length ? { team, team_name: name } : { team: '', team_name: name }), metric, ...(good ? { good } : { good: '' }), promise: v('promise').trim() });
  };
  return h('div', { class: 'part-form stack' },
    h('label', { class: 'small muted' }, 'Ai phụ trách'), owner,
    h('label', { class: 'small muted' }, 'Đo bằng số liệu nào'), metrics,
    h('label', { class: 'small muted' }, 'Lời hứa (tuỳ chọn)'), promise,
    h('div', { class: 'row' }, btn('Lưu', save, 'strong'), btn('Huỷ', () => { S.edit = null; S.draft = null; render(); }, 'text')));
}
function partsSection(d) {
  const p = d.parts;
  if (!p) return null;
  const bad = p.items.filter(x => x.status === 'hong').length, loose = p.items.filter(x => x.chua_giao).length;
  const aside = [bad ? `${bad} bộ phận hỏng` : null, loose ? `${loose} chưa giao` : null].filter(Boolean).join(' · ') || 'Mỗi bộ phận có người phụ trách và một số liệu';
  return sec('parts', 'Khám 5 bộ phận', aside, h('div', { class: 'list' }, p.items.map(x => partRow(x, d))));
}

// ---------- after Go ----------
function steps(x) {
  if (x.state === 'task') return h('div', { class: 'steps' }, h('span', { class: 'done' }, 'Đã Go'), h('span', { class: 'now' }, 'Chờ người làm'), h('span', {}, 'Xong'));
  const at = HAND[x.state]?.[1] ?? 0;
  return h('div', { class: 'steps' }, ['Đã Go', 'Đang dựng', 'Chờ bạn duyệt', 'Đã phát hành'].map((s, i) => h('span', { class: i < at ? 'done' : i === at ? 'now' : '' }, s)));
}
function pipeItem(x, d) {
  const tech = [x.team_id && `Đội ${x.team_id}`, x.ticket && `Ticket cha ${x.ticket}`, x.requirement_path && `Yêu cầu ${x.requirement_path}`].filter(Boolean);
  const live = ['spawned', 'starting', 'building'].includes(x.state);
  return h('div', { class: 'item' },
    h('div', { class: 'item-h' }, h('span', { class: 't' }, x.title), many(d) && x.product ? badge(productName(x.product)) : null, x.state === 'blocked' ? badge(HAND.blocked[0], 'bad') : null),
    steps(x),
    small(x.state === 'released' && x.released_at ? `Xong ngày ${dm(x.released_at)}. Soot đo kết quả từ ngày đó.` : x.detail || HAND[x.state]?.[2] || ''),
    x.state === 'blocked' ? h('div', { class: 'row' }, btn('Giao người làm', () => act('to_person', { id: x.opportunity }))) : null,
    tech.length || live ? h('details', {}, h('summary', {}, 'Chi tiết kỹ thuật'), tech.map(t => h('p', {}, t)),
      live ? h('div', { class: 'row' }, h('input', { class: 'input', id: `t-${x.opportunity}`, placeholder: x.ticket ? `Ticket cha: ${x.ticket}` : 'Mã ticket cha (nếu Soot chưa đọc được)', 'aria-label': 'Mã ticket cha' }),
        btn('Gắn', () => { const v = document.getElementById(`t-${x.opportunity}`)?.value.trim(); if (v) act('link_ticket', { id: x.opportunity, ticket: v }); }, 'text')) : null) : null);
}
function pipeline(d) {
  const build = d.setup.build;
  const rows = d.handoffs.filter(x => !['delivered', 'task', 'draft_ready', 'no_repo'].includes(x.state) || !build);
  const topics = (d.topics ?? []).filter(t => t.state !== 'written').slice(0, 8);
  return sec('pipeline', build ? 'Đang dựng' : 'Việc sau Go', build ? null : 'Chưa nối đội dựng · Go ghi quyết định và một việc',
    h('div', { class: 'list' }, rows.length ? rows.map(x => pipeItem(x, d)) : empty(h('span', {}, build ? 'Chưa có cơ hội sản phẩm nào đang dựng.' : 'Chưa có việc nào sau Go.'))),
    topics.length ? h('div', { class: 'list' }, topics.map(t => h('div', { class: 'item' }, h('div', { class: 'item-h' }, h('span', { class: 't' }, `Chủ đề: ${t.query}`), badge(TOPIC[t.state]?.[0] ?? t.state, TOPIC[t.state]?.[1] ?? '')),
      t.state === 'handed' && t.until ? small(`Chưa có bài; quá ${dm(t.until)} vẫn chưa viết thì chủ đề quay lại hàng chờ.`) : null))) : null);
}

// ---------- decisions ----------
function verdict(x, d) {
  if (x.verdict === 'hit' || x.verdict === 'miss') return badge(`${x.verdict === 'hit' ? 'Trúng' : 'Trượt'} · ${signed(x.actual_delta)}`, x.verdict === 'hit' ? 'ok' : 'bad');
  if (x.verdict === 'unmeasured') return badge('Không đo được');
  const task = d.handoffs.some(y => y.opportunity === x.ref && y.state === 'task');
  if (x.verdict === 'waiting') return badge(x.check_at ? `Chờ đo đến ${dm(x.check_at)}` : task ? 'Chờ làm xong' : x.from === 'release' ? 'Chờ phát hành' : 'Chờ đăng bài');
  return '';
}
function decisions(d) {
  const r = d.hit_rate ?? {};
  const moats = Object.entries(d.moats ?? {}).filter(([k]) => MOAT[k]).map(([k, n]) => `${MOAT[k]} ${n}`);
  return sec('decisions', 'Quyết định và kết quả', r.measured ? `Trúng ${r.hits}/${r.measured} (${Math.round(r.rate * 100)}%) · trúng là đạt ít nhất nửa mức kỳ vọng` : 'Chưa đo được quyết định nào',
    moats.length ? small(`Hào đang xây: ${moats.join(' · ')}`) : null,
    d.decisions.length ? h('div', { class: 'list scroll' }, h('table', { class: 'rows' },
      h('thead', {}, h('tr', {}, ['Ngày', 'Quyết định', 'Cơ hội', ...(many(d) ? ['Sản phẩm'] : []), 'Kỳ vọng', 'Kết quả'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, d.decisions.map(x => h('tr', {}, h('td', {}, dm(x.at)), h('td', {}, `${DECISION[x.decision] ?? x.decision} · ${x.by === 'soot' ? 'Soot' : 'bạn'}`), h('td', {}, x.title, tagRow(x)),
        ...(many(d) ? [h('td', {}, x.product ? productName(x.product) : 'Chưa gắn')] : []),
        h('td', {}, x.target_outcome ? `${metric(x.target_outcome)} ${signed(x.expected_delta ?? 0)}` : ''), h('td', {}, verdict(x, d)))))))
      : h('div', { class: 'list' }, empty(h('span', {}, 'Chưa có quyết định nào. Bản tin đầu tiên chạy thứ Hai 08:30.'))));
}

// ---------- side ----------
function side(d) {
  const hl = d.health;
  const teams = hl?.runtime?.via === 'teams';
  const stage = st => {
    const state = st.unused ? 'idle' : st.external ? 'idle' : st.starving?.length ? 'warn' : st.last_run?.status === 'failed' ? 'bad' : 'ok';
    const word = st.unused ? 'chưa dùng' : st.external ? 'máy chủ riêng' : st.starving?.length ? `${st.starving.length} nguồn thiếu` : st.last_run?.status === 'failed' ? 'lần chạy lỗi' : 'đủ nguồn';
    const last = st.external ? 'Chạy trên máy chủ riêng của nhóm; lần chạy và mức dùng AI nằm ở đó.' : st.unused ? 'Chưa nối kho mã (PRODUCT_REPOS) nên bước này không chạy.' : st.last_run ? `${st.last_run.name} · ${when(st.last_run.at)}` : 'Chưa có lần chạy nào.';
    const ai = !st.external && !st.unused && Number.isFinite(st.tokens_7d) ? ` · Mức dùng AI 7 ngày: ${nf.format(st.tokens_7d)} token` : '';
    return h('div', { class: 'item' },
      h('div', { class: 'item-h' }, lamp(state), h('span', { class: 't' }, st.label), badge(word, state === 'warn' || state === 'bad' ? state : '')),
      small(last + ai), (st.starving ?? []).map(i => h('p', { class: 'small' }, `${i.label}: ${i.detail || 'chưa có'}`)),
      !st.external && !st.unused && (teams || st.last_run?.schedule) ? h('div', { class: 'row' }, teams ? linkBtn('Xem đội', `nest://team/${encodeURIComponent(st.key)}`) : null, st.last_run?.schedule ? linkBtn('Lịch chạy', `nest://schedules/${encodeURIComponent(st.last_run.schedule)}`) : null) : null);
  };
  const e = hl?.effort ?? {};
  return h('div', { class: 'stack gap' },
    sec('rhythm', 'Nhịp tuần', null, h('div', { class: 'card' }, h('ul', { class: 'rhythm' }, RHYTHM.map(([id, what, at]) => h('li', {}, h('span', { class: 'stack tight' }, h('span', { class: 'strong' }, what), h('span', { class: 'small muted' }, at)), linkBtn('Lịch chạy', `nest://schedules/${id}`)))))),
    sec('loop', 'Vòng lặp', hl ? `Số lúc ${when(hl.at)}${hl.age_h > 30 ? ' · đã cũ' : ''}` : null,
      !hl ? h('div', { class: 'list' }, empty(h('span', {}, 'Chưa có số về vòng lặp.'), h('span', { class: 'small' }, 'Soot cập nhật mỗi sáng; chưa có nghĩa là các bước chưa chạy lần nào.'))) : [
        d.scope.product && hl.split === 'shared' ? small('Vòng lặp chung cho mọi sản phẩm của máy chủ: chưa tách được theo sản phẩm.') : null,
        hl.split === 'product' && hl.left_out ? small(`Không tính ${hl.left_out} đội của sản phẩm khác.`) : null,
        h('div', { class: 'list' }, hl.stages.length ? hl.stages.map(stage) : empty(h('span', {}, 'Không có đội nào của sản phẩm này.')))]),
    hl ? sec('effort', 'Công sức của bạn · 7 ngày', null, h('div', { class: 'card stack' },
      h('p', {}, [`${e.decisions_tapped_7d ?? 0} quyết định`, e.chat_instructions_7d != null ? `${e.chat_instructions_7d} lần nhắn Soot` : null, e.cards_open != null ? `${e.cards_open} thẻ Cần bạn đang mở` : null].filter(Boolean).join(' · ')),
      e.median_answer_s != null ? small(`Chờ trả lời trung vị ${Math.round(e.median_answer_s)} giây.`) : null, e.note ? small(e.note) : null,
      linkBtn('Mở Hộp thư', 'nest://inbox'))) : null);
}

// ---------- page ----------
function render() {
  const root = document.getElementById('app');
  root.replaceChildren();
  if (S.error) {
    root.append(h('div', { class: 'head' }, h('h1', {}, 'Công ty')),
      h('div', { class: 'next bad', role: 'alert' }, lamp('bad'), h('div', { class: 'body' }, h('span', { class: 'title' }, 'Chưa tải được trang Công ty'), h('span', { class: 'muted' }, S.error)), h('span', { class: 'act' }, btn('Tải lại', reload, 'primary'))),
      S.data ? small(`Số cũ lúc ${when(S.data.at)} vẫn còn: bấm Tải lại để xem tiếp.`) : '');
    return;
  }
  const d = S.data;
  if (!d) { root.append(h('p', { class: 'muted' }, 'Đang tải…')); return; }
  root.append(header(d), ...scopeLine(d), nextBar(d),
    S.notice ? h('p', { class: 'small muted', role: 'status' }, S.notice) : '',
    h('div', { class: 'grid' }, h('div', { class: 'stack gap' }, needsSection(d), scorecard(d), partsSection(d), pipeline(d), decisions(d)), side(d)));
}

async function start() {
  if (S.started) return;
  S.started = true;
  await reload();
}
window.parent.postMessage({ v: 2, type: 'ready' }, '*');
render();
})();
