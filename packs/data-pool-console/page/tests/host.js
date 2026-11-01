// A fake Nest: answers bridge v1 calls from its own frame with an in-memory
// data-pool service (the shapes of packs/data-pool/runner) and a host receipt
// store keyed by request id (soot-pages §3). window.kho is the test driver.
const frame = document.getElementById('frame');
const now = () => new Date().toISOString();
const pools = new Map([['lohi-support', { id: 'lohi-support', name: 'lohi-support', generation: 'g1', policy_revision: 1 }], ['lohi-content-style', { id: 'lohi-content-style', name: 'lohi-content-style', generation: 'g1', policy_revision: 1 }]]);
const docs = new Map([
  ['lohi-support', new Map([
    ['doc-hoan', { id: 'doc-hoan', title: 'Chính sách hoàn LT khi nạp lỗi', content: 'Nếu tiền đã trừ mà LT chưa vào sau 15 phút, Soot tra giao dịch và đề nghị cộng bù.', tags: ['nạp tiền', 'hoàn LT'], revision: 7, updated_at: now(), writer: { kind: 'human', soot: 'le-tan' } }],
    ['doc-pro', { id: 'doc-pro', title: 'Hoàn tiền gói Pro mua nhầm', content: 'Gói Pro mua nhầm được hoàn trong 24 giờ.', tags: [], revision: 2, updated_at: now(), writer: { kind: 'soot', soot: 'chuyen-tiep' } }],
  ])],
  ['lohi-content-style', new Map()],
]);
const receipts = new Map(), hostReceipts = new Map(), activity = [];
const state = { writes: 0, dropNext: false, busyNext: false, calls: [] };
const meta = d => ({ id: d.id, title: d.title, source: d.source, tags: d.tags, revision: d.revision, updated_at: d.updated_at, writer: d.writer });
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
function view({ kind, input }) {
  switch (kind) {
    case 'overview': return { namespace: 'lohi', service_identity: 'svc-1', bound_soots: ['le-tan', 'chuyen-tiep'], host_managers: ['kamaji'], limits: { page_size: 20, inline_content_bytes: 12288, content_bytes: 1 << 20, activity_retention: 200 }, available: true };
    case 'pools':
      if (input.pool) { const p = pools.get(input.pool); if (!p) throw new Error('unknown collection'); return { pool: p, documents: docs.get(p.id).size, permission: 'manage', grants: { 'le-tan': 'read', 'chuyen-tiep': 'read' }, host_managers: ['kamaji'], bound_soots: ['le-tan', 'chuyen-tiep'] }; }
      return { pools: [...pools.values()], next: '' };
    case 'query': {
      const set = docs.get(input.pool); if (!set) throw new Error('unknown collection');
      if (input.action === 'list') return { documents: [...set.values()].map(meta), next: '' };
      if (input.action === 'search') { const words = fold(input.query).split(/\s+/); return { hits: [...set.values()].filter(d => words.some(w => fold(d.title + ' ' + d.content).includes(w.slice(0, 3)))).map(d => ({ document: meta(d) })), next_offset: 0 }; }
      if (input.action === 'read') { const d = set.get(input.id); if (!d) throw new Error('unknown document'); return { document: meta(d), content: d.content, next_offset: d.content.length, complete: true }; }
      throw new Error('unsupported query');
    }
    case 'activity': return { activity: activity.filter(a => a.pool === input.pool).slice(-20).reverse(), next: '', oldest_sequence: 1 };
    case 'status': { const r = receipts.get(input.request_id); if (!r) throw new Error('no receipt for this request'); return { ...r, replay: true }; }
  }
  throw new Error('unsupported data-pool view');
}
function action({ kind, input }) {
  if (receipts.has(input.request_id)) return { ...receipts.get(input.request_id), replay: true };
  const pool = pools.get(input.pool);
  const refuse = (code, message) => ({ status: 'error', code, message });
  if (kind === 'write') {
    if (!pool) return refuse('rejected', 'unknown collection');
    if (input.generation !== pool.generation) return refuse('conflict', `revision conflict: collection ${pool.id} changed`);
    const set = docs.get(pool.id), cur = set.get(input.id);
    if ((cur?.revision ?? 0) !== input.expected_revision) return refuse('conflict', `revision conflict: document ${input.id} is at revision ${cur?.revision ?? 0}`);
    state.writes++;
    let document;
    if (input.action === 'remove') set.delete(input.id);
    else { document = { id: input.id, title: input.title, content: input.content ?? `(imported from ${input.url})`, source: input.url || input.source, tags: input.tags, revision: (cur?.revision ?? 0) + 1, updated_at: now(), writer: { kind: 'human', soot: 'kamaji' } }; set.set(input.id, document); }
    const r = { request_id: input.request_id, status: 'succeeded', pool: pool.id, action: input.action, ...(document ? { document: meta(document) } : {}) };
    receipts.set(input.request_id, r); activity.push({ sequence: activity.length + 1, at: now(), actor: { kind: 'human', soot: 'kamaji' }, action: input.action, status: 'succeeded', pool: pool.id });
    return r;
  }
  if (kind === 'manage') {
    state.writes++;
    if (input.action === 'pool_create') { pools.set(input.pool, { id: input.pool, name: input.name, generation: 'g1', policy_revision: 1 }); docs.set(input.pool, new Map()); }
    else if (input.action === 'pool_remove') { if (!pool || pool.generation !== input.generation) return refuse('conflict', 'revision conflict'); pools.delete(pool.id); docs.delete(pool.id); }
    else return refuse('rejected', 'unsupported manage action');
    const r = { request_id: input.request_id, status: 'succeeded', pool: input.pool, action: input.action };
    receipts.set(input.request_id, r); return r;
  }
  throw new Error('unsupported data-pool action');
}
const post = m => frame.contentWindow.postMessage(m, '*');
const tokens = { '--background': '#ffffff', '--foreground': '#1f1f1f', '--primary': '#2f5bd3' };
window.addEventListener('message', e => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data, keys = Object.keys(m ?? {});
  if (m?.v !== 1) return;
  if (m.type === 'ready' && keys.length === 2) { post({ v: 1, type: 'init', theme: 'light', locale: 'vi', tokens }); return; }
  if (m.type !== 'call' || keys.some(k => !['v', 'type', 'id', 'mode', 'input', 'request_id'].includes(k))) return;
  state.calls.push({ mode: m.mode, kind: m.input?.kind, request_id: m.request_id });
  const reply = r => setTimeout(() => post({ v: 1, type: 'result', id: m.id, ...r }), 30);
  if (state.busyNext) { state.busyNext = false; reply({ ok: false, error: { code: 'busy', message: 'busy' } }); return; }
  try {
    if (m.mode === 'action') {
      const seen = hostReceipts.get(m.request_id);
      const output = seen ? seen.output : action(m.input);
      const receipt = seen ? seen.receipt : { request_id: m.request_id, status: 'done', at: now() };
      if (!seen && output.status === 'succeeded') hostReceipts.set(m.request_id, { output, receipt });
      if (state.dropNext) { state.dropNext = false; return; } // the answer is lost on the way back
      reply({ ok: true, output, ...(output.status === 'succeeded' ? { receipt } : {}) });
    } else reply({ ok: true, output: view(m.input) });
  } catch (err) { reply({ ok: false, error: { code: 'tool_refused', message: err.message } }); }
});
window.kho = {
  state, docs, receipts,
  dropNext() { state.dropNext = true; }, busyNext() { state.busyNext = true; },
  externalEdit(pool, id, content) { const d = docs.get(pool).get(id); Object.assign(d, { content, revision: d.revision + 1, updated_at: now() }); return d.revision; },
  doc(pool, id) { return docs.get(pool).get(id); },
  reloadFrame() { frame.src = '/page/index.html?' + Date.now(); },
};
