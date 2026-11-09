// Công ty (company-loop). Plain DOM, no network: every read and write is a `call` posted to Nest
// (soot-pages bridge v1), which runs this pack's page_view / page_action tool. Text is set with
// textContent only. The view model carries codes and numbers; the words are here.
'use strict';
(() => {
const BRIDGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const rid = (prefix, bytes = 12) => prefix + '-' + Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const isTokens = t => !!t && typeof t === 'object' && !Array.isArray(t) && Object.entries(t).every(([k, v]) => /^--[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 512);

const waiting = new Map();
const S = { data: null, error: '', busy: false, notice: '', pending: null, locale: 'vi', ticket: {} };
const embedded = window.parent !== window;

function parse(m) {
  if (!m || typeof m !== 'object' || m.v !== 1) return null;
  if (m.type === 'init') return ['light', 'dark'].includes(m.theme) && isTokens(m.tokens) ? m : null;
  if (m.type === 'theme') return ['light', 'dark'].includes(m.theme) && isTokens(m.tokens) ? m : null;
  if (m.type === 'result' && typeof m.id === 'string' && BRIDGE_ID.test(m.id)) return m;
  return null;
}
function applyTheme(m) { for (const [k, v] of Object.entries(m.tokens)) document.documentElement.style.setProperty(k, v); document.documentElement.dataset.theme = m.theme; }
window.addEventListener('message', e => {
  if (embedded && e.source !== window.parent) return;
  const m = parse(e.data);
  if (!m) return;
  if (m.type === 'init') { applyTheme(m); S.locale = m.locale; start(); }
  else if (m.type === 'theme') applyTheme(m);
  else { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); clearTimeout(w.timer); w.resolve(m.ok ? { ok: true, output: m.output } : { ok: false, error: m.error }); } }
});
function call(mode, input, requestID) {
  const id = rid('c', 8);
  return new Promise(resolve => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: { code: 'no_response', message: 'no result from the host' } }); }, 90000);
    waiting.set(id, { resolve, timer });
    window.parent.postMessage({ v: 1, type: 'call', id, mode, input, ...(requestID ? { request_id: requestID } : {}) }, '*');
  });
}
const open = link => { if (/^(https|nest):\/\//.test(link)) window.parent.postMessage({ v: 1, type: 'open', link }, '*'); };
function output(r) {
  if (!r.ok) throw r.error;
  if (r.output?.error) throw r.output.error;
  return r.output;
}

// ---------- words ----------
const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
const fmt = (v, unit) => (v === null || v === undefined ? 'Chưa có số liệu' : unit === 'vnd' ? `${nf.format(v)} ₫` : nf.format(v));
const day = iso => (iso ? new Date(iso).toLocaleDateString('vi-VN') : '');
const STATE = { proposed: ['Chờ bạn chọn', 'warn'], go: ['Đã Go', 'ok'], later: ['Để sau', ''], drop: ['Đã bỏ', ''] };
const TOPIC = { queued: ['Đang chờ giao Writer', ''], handed: ['Đã giao Writer, chưa viết', 'warn'], written: ['Đã viết', 'ok'] };
const KIND = { content: 'Nội dung', product: 'Sản phẩm' };
const HAND = {
  spawned: ['Đội đã mở', 'ok', 'Đội bbs:team đang làm rõ yêu cầu. Soot kiểm tra mỗi 30 phút, bạn chưa phải làm gì.'],
  starting: ['Đội đang đọc yêu cầu', 'ok', 'Đội đang đọc yêu cầu — chưa có việc cần bạn.'],
  building: ['Đang dựng', 'ok', 'Soot kiểm tra mỗi 30 phút, bạn chưa phải làm gì.'],
  blocked: ['Vướng khi phát hành', 'bad', 'Đội đang xử lý; mở terminal của đội trong Orca nếu cần xem.'],
  delivered: ['Chờ bạn duyệt', 'warn', 'Duyệt bản giao rồi bấm phát hành trong bbs:team. Soot không phát hành thay bạn.'],
  released: ['Đã phát hành', 'ok', 'Soot sẽ xếp một bài giới thiệu cho marketing.'],
  draft_ready: ['Bản nháp sẵn', 'warn', 'Chạy lệnh dưới đây trong terminal để mở đội dựng.'],
  no_repo: ['Chưa có kho mã', 'bad', 'Đặt PRODUCT_REPO cho Soot rồi bấm Chạy lại.'],
};
function nextText(n, d) {
  switch (n.code) {
    case 'setup': return ['Chưa đọc được số của sản phẩm: nhập khoá PRODUCT_ADMIN_KEY và địa chỉ SCOREBOARD_URL ở Thiết lập.', 'warn', ['Mở Thiết lập', 'nest://settings/setup']];
    case 'key_refused': return [d.sync?.message || 'Khoá bị từ chối: cần khoá vai trò agent_mod.', 'bad', ['Mở Thiết lập', 'nest://settings/setup']];
    case 'choose': return [`${n.n} cơ hội chờ bạn: bấm Go, Để sau hoặc Bỏ ở mỗi thẻ. Soot chỉ bắt đầu dựng sau khi bạn bấm Go.`, 'warn'];
    case 'draft_ready': return ['Soot đã viết yêu cầu nhưng chưa mở được đội dựng: chạy lệnh ở mục Bàn giao, hoặc bấm Chạy lại khi đã mở Orca.', 'warn'];
    case 'no_repo': return ['Chưa có kho mã để ghi yêu cầu: đặt PRODUCT_REPO rồi bấm Chạy lại ở mục Bàn giao.', 'bad'];
    case 'release_go': return ['Đội đã dựng xong: duyệt bản giao và bấm phát hành trong bbs:team. Đó là lượt bấm cuối của bạn.', 'warn'];
    case 'building': return ['Đội đang dựng. Soot kiểm tra mỗi 30 phút, bạn chưa phải làm gì.', ''];
    case 'topic_handed': return [`${n.n} chủ đề đã giao Writer nhưng chưa viết: bài lên ở lượt viết kế tiếp, bạn không phải làm gì.`, 'idle'];
    case 'topics': return [`${n.n} chủ đề đang chờ Writer: bài sẽ tự lên lịch, bạn không phải làm gì.`, 'idle'];
    default: return ['Không cần làm gì, Soot đang tự chạy. Bản tin kế tiếp: thứ Hai 08:30.', 'idle'];
  }
}

// ---------- dom ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return el;
}
const btn = (text, fn, cls = 'btn') => h('button', { class: cls, type: 'button', disabled: S.busy, onclick: fn }, text);
const badge = (text, tone = '') => h('span', { class: `badge ${tone}` }, text);

async function load() {
  S.error = '';
  try { S.data = output(await call('view', { page: 'cong-ty' })); } catch (e) { S.error = e?.code === 'no_response' ? 'Chưa nhận được trả lời từ máy chủ. Bấm Tải lại.' : `Không tải được trang: ${e?.message || e?.code || ''}`; }
}
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
      try { const o = output(r); S.notice = o.handoff?.note ? `${o.handoff.note}` : 'Xong.'; } catch (e) { S.notice = e?.message || 'Không làm được.'; }
      await load();
    }
  } finally { S.busy = false; render(); }
}

function nextBar(d) {
  const [text, tone, link] = nextText(d.next, d);
  return h('div', { class: `next ${tone}`, role: 'status' }, h('span', { class: 'strong' }, text), link && btn(link[0], () => open(link[1])));
}
function tiles(sb) {
  if (!sb) return h('div', { class: 'card empty' }, 'Chưa có số liệu. Soot đọc bảng số mỗi ngày lúc 06:15; bấm Đọc ngay khi đã nhập khoá.');
  return h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${sb.product} · ${day(sb.from)} đến ${day(sb.to)}, so với 7 ngày trước đó`),
    h('div', { class: 'tiles' }, sb.tiles.map(t => {
      const up = t.pct === null ? 0 : t.pct > 0 ? 1 : t.pct < 0 ? -1 : 0;
      const tone = up === 0 ? 'flat' : (up > 0) === (t.good === 'up') ? 'ok' : 'bad';
      return h('div', { class: 'card tile' }, h('span', { class: 'muted' }, t.label), h('strong', {}, fmt(t.value, t.unit)),
        h('span', { class: `delta ${tone}` }, t.pct === null ? `trước: ${fmt(t.previous, t.unit)}` : `${up > 0 ? '▲' : up < 0 ? '▼' : '='} ${nf.format(Math.abs(t.pct))}% (trước: ${fmt(t.previous, t.unit)})`));
    })));
}
function topicLine(t) {
  const [st, tone] = TOPIC[t.state] ?? [t.state, ''];
  const note = t.state === 'written' ? (t.post ? `Bài ${t.post}` : '') : t.state === 'handed' ? `Chưa có bài; quá ${day(t.until)} vẫn chưa viết thì chủ đề quay lại hàng chờ.` : '';
  return h('div', { class: 'line between' }, h('span', {}, h('span', { class: 'muted' }, 'Chủ đề: '), t.query), h('span', { class: 'line' }, note && h('span', { class: 'muted' }, note), badge(st, tone)));
}
function oppCard(o, topics = []) {
  const [st, tone] = STATE[o.state] ?? [o.state, ''];
  const open_ = o.state === 'proposed' || o.state === 'later';
  const measure = `Đo bằng ${o.target_outcome}: kỳ vọng ${o.expected_delta > 0 ? '+' : ''}${nf.format(o.expected_delta)} so với tuần trước, xem lại sau ${o.check_after_days} ngày`;
  return h('div', { class: 'card stack' },
    h('div', { class: 'line between' }, h('span', { class: 'strong' }, o.title), h('span', { class: 'line' }, badge(KIND[o.kind] ?? o.kind), badge(st, tone))),
    o.summary && h('p', {}, o.summary),
    o.kind === 'content' && o.query && h('p', {}, h('span', { class: 'muted' }, 'Chủ đề tìm kiếm: '), o.query),
    h('p', { class: 'muted' }, measure),
    topics.filter(t => t.ref === o.ref).map(topicLine),
    h('div', { class: 'chips' }, (o.evidence_refs ?? []).map(r => h('span', { class: 'chip' }, r)), h('span', { class: 'chip' }, `${o.signal_count} tín hiệu`), h('span', { class: 'chip' }, `công ${o.est_effort} · giá trị ${o.est_value}`)),
    open_ ? h('div', { class: 'line' }, btn(o.kind === 'product' ? 'Go: bắt đầu dựng' : 'Go', () => act('go', { id: o.ref }), 'btn primary'), btn('Để sau', () => act('later', { id: o.ref })), btn('Bỏ', () => act('drop', { id: o.ref }), 'btn ghost'))
      : h('p', { class: 'muted' }, o.state === 'go' ? (o.kind === 'content' ? 'Chủ đề đã vào hàng chờ của Writer; không cần làm gì.' : 'Đã bàn giao: xem mục Bàn giao bên dưới.') : o.state === 'drop' ? 'Soot sẽ không đề xuất lại cơ hội này.' : ''));
}
function handoffCard(x) {
  const [st, tone, step] = HAND[x.state] ?? [x.state, '', ''];
  const fix = x.state === 'draft_ready' || x.state === 'no_repo';
  return h('div', { class: 'card stack' },
    h('div', { class: 'line between' }, h('span', { class: 'strong' }, x.title), badge(st, tone)),
    h('p', {}, x.detail || step), x.note && x.note !== x.detail && h('p', { class: 'muted' }, x.note),
    x.requirement_path && h('p', { class: 'muted' }, `Yêu cầu: ${x.requirement_path}`),
    x.command && fix && h('code', { class: 'cmd' }, x.command),
    fix && h('div', { class: 'line' }, btn('Chạy lại', () => act('retry_handoff', { id: x.opportunity }))),
    ['spawned', 'starting', 'building'].includes(x.state) && h('details', { class: 'muted' }, h('summary', {}, 'Gắn tay ticket cha'), h('div', { class: 'line' },
      h('input', { class: 'input', id: `t-${x.opportunity}`, placeholder: x.ticket ? `Ticket cha: ${x.ticket}` : 'Mã ticket cha của dự án (nếu Soot chưa đọc được)', 'aria-label': 'Mã ticket cha' }),
      btn('Gắn', () => { const v = document.getElementById(`t-${x.opportunity}`)?.value.trim(); if (v) act('link_ticket', { id: x.opportunity, ticket: v }); }, 'btn ghost'))));
}
function log(d) {
  const r = d.hit_rate;
  const rows = d.decisions;
  return h('div', { class: 'stack' },
    h('p', { class: r.measured ? 'strong' : 'muted' }, r.measured ? `Tỉ lệ trúng: ${r.hits}/${r.measured} (${Math.round(r.rate * 100)}%). Trúng nghĩa là kết quả thật đạt ít nhất nửa mức kỳ vọng.` : 'Chưa đo được quyết định nào. Soot chấm kết quả vào sáng thứ Hai, sau số ngày đã hẹn.'),
    rows.length ? h('div', { class: 'card scroll' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Ngày', 'Quyết định', 'Ai', 'Cơ hội', 'Kỳ vọng', 'Thực tế'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(x => h('tr', {}, h('td', {}, day(x.at)), h('td', {}, x.decision), h('td', {}, x.by), h('td', {}, x.title),
        h('td', {}, `${x.target_outcome} ${x.expected_delta > 0 ? '+' : ''}${nf.format(x.expected_delta)}`),
        h('td', {}, x.actual_delta === null || x.actual_delta === undefined ? (x.decision === 'go' ? `chấm sau ${x.check_after_days} ngày` : '') : nf.format(x.actual_delta))))))) : h('div', { class: 'card empty' }, 'Chưa có quyết định nào. Bản tin đầu tiên chạy vào thứ Hai 08:30.'));
}

function healthSection(d) {
  const hl = d.health;
  if (!hl) return h('div', { class: 'card empty' }, 'Chưa có số về vòng lặp. Soot cập nhật mỗi sáng; chưa có thì các bước chưa chạy lần nào.');
  const rt = hl.runtime?.tokens_7d;
  return h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Cập nhật ${day(hl.at)}${hl.age_h > 30 ? ' (đã cũ)' : ''}. ${rt === undefined ? 'Chưa đọc được số token từ Soot.' : `Token 7 ngày: ${nf.format(rt)}.`}`),
    h('div', { class: 'stack' }, hl.stages.map(st => h('div', { class: 'card stack' },
      h('div', { class: 'line between' }, h('span', { class: 'strong' }, st.label), badge(st.starving?.length ? `${st.starving.length} nguồn đang đói` : 'đủ nguồn', st.starving?.length ? 'warn' : '')),
      h('p', { class: 'muted' }, st.external ? 'Chạy ở máy chủ Hỗ trợ riêng.' : st.last_run ? `Lần chạy gần nhất: ${st.last_run.name} (${day(st.last_run.at)}, ${st.last_run.status ?? 'chưa rõ'}). Token 7 ngày: ${nf.format(st.tokens_7d ?? 0)}${st.model_wakes_7d != null ? `, gọi model ${st.model_wakes_7d} lần` : ''}${st.budget_daily ? `. Hôm nay ${nf.format(st.tokens_today ?? 0)}/${nf.format(st.budget_daily)} (${Math.round(st.budget_percent ?? 0)}%)` : ''}.` : 'Chưa có lần chạy nào.'),
      (st.starving ?? []).map(i => h('p', {}, h('span', { class: 'strong' }, i.label + ': '), i.detail || 'chưa có'))))),
    h('div', { class: 'card stack' }, h('span', { class: 'strong' }, 'Công sức của bạn (7 ngày)'),
      h('p', {}, `Quyết định cơ hội: ${hl.effort?.decisions_tapped_7d ?? 0}. Lần nhắn Soot: ${hl.effort?.chat_instructions_7d ?? 'chưa rõ'}. Thẻ Cần bạn đang mở: ${hl.effort?.cards_open ?? 'chưa rõ'}${hl.effort?.cards_answered_7d != null ? `, đã trả lời 7 ngày: ${hl.effort.cards_answered_7d}${hl.effort.median_answer_s != null ? ` (chờ trung vị ${Math.round(hl.effort.median_answer_s)} giây)` : ''}` : ''}.`),
      h('p', { class: 'muted' }, hl.effort?.note || '')));
}

function render() {
  const root = document.getElementById('app');
  root.replaceChildren();
  if (S.error) { root.append(h('div', { class: 'next bad' }, h('span', {}, S.error), btn('Tải lại', async () => { await load(); render(); }))); return; }
  const d = S.data;
  if (!d) { root.append(h('p', { class: 'muted' }, 'Đang tải…')); return; }
  const waitingOpps = d.opportunities.filter(o => o.state === 'proposed' || o.state === 'later');
  const rest = d.opportunities.filter(o => !(o.state === 'proposed' || o.state === 'later'));
  root.append(
    h('div', { class: 'line between' }, h('h1', {}, 'Công ty'), h('span', { class: 'line' }, btn('Đọc ngay', () => act('sync'), 'btn ghost'), btn('Tải lại', async () => { await load(); render(); }, 'btn ghost'))),
    nextBar(d),
    S.notice && h('p', { class: 'muted', role: 'status' }, S.notice),
    ...(d.next.code === 'choose' ? [] : [h('h2', {}, 'Số liệu'), tiles(d.scoreboard)]),
    h('h2', {}, 'Cơ hội'),
    d.opportunities.length ? h('div', { class: 'stack' }, [...waitingOpps, ...rest].map(o => oppCard(o, d.topics ?? []))) : h('div', { class: 'card empty' }, 'Chưa có cơ hội nào. Soot lập bản tin vào thứ Hai 08:30; nội dung tự chạy, cơ hội sản phẩm chờ bạn bấm Go.'),
    ...(d.next.code === 'choose' ? [h('h2', {}, 'Số liệu'), tiles(d.scoreboard)] : []),
    h('h2', {}, 'Bàn giao'),
    d.handoffs.length ? h('div', { class: 'stack' }, d.handoffs.map(handoffCard)) : h('div', { class: 'card empty' }, 'Chưa có bàn giao nào. Khi bạn bấm Go cho một cơ hội sản phẩm, yêu cầu được viết và đội bbs:team mở ở đây.'),
    h('h2', {}, 'Vòng lặp'), healthSection(d),
    h('h2', {}, 'Nhật ký quyết định'), log(d));
}

async function start() {
  if (S.started) return;
  S.started = true;
  await load(); render();
}
window.parent.postMessage({ v: 1, type: 'ready' }, '*');
render();
})();
