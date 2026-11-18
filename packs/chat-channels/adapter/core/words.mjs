// Words for Cần bạn items from the host's codes (channel-adapter v1.6 §14):
// the item's text, its buttons, the toast after a press, the settled edit and
// the DM pointer. An item without codes (an older host) keeps the host's text.
import {languageOf} from './copy.mjs';

const cut = (text, max) => { const s = String(text ?? ''); return [...s].length > max ? [...s].slice(0, max).join('') : s; };

const WORDS = {
  vi: {
    waiting: 'Một việc đang chờ bạn',
    head: {
      approval: (s, a) => `**Cần bạn duyệt:** ${s}\n${a} đang chờ.`,
      unknown_outcome: s => `**Chưa rõ kết quả:** ${s}. Cần kiểm tra trước khi thử lại.`,
      question: s => `**Câu hỏi:** ${s}`,
      grant: s => `**Cần bạn cấp quyền:** ${s}`,
      failure: s => `**Việc bị lỗi:** ${s}`,
      decision: (s, a) => a ? `**Cần quyết định (${a}):** ${s}` : `**Cần bạn chọn:** ${s}`,
      handle: (s, a) => a ? `**Cần xử lý (${a}):** ${s}` : `**Cần bạn xử lý:** ${s}`,
      take_back: (s, a) => a ? `**Cần tiếp nhận (${a}):** ${s}` : `**Cần bạn tiếp nhận:** ${s}`,
    },
    label: {
      approve: 'Duyệt và chạy', reject: 'Từ chối', deny_grant: 'Từ chối', done: 'Đã xử lý',
      open_nest_check: '→ Mở Nest → Cần bạn để kiểm tra', open_nest_choose: '→ Mở Nest → Cần bạn để chọn',
      open_nest_grant: '→ Cấp quyền trong Nest', open_nest_take_back: '→ Mở Nest để nhận lại việc',
      open_nest_handle: '→ Mở Nest để xử lý', open_nest_error: '→ Mở Nest để xem lỗi',
      open_nest_option: v => `→ ${v} trong Nest`, expired: 'Hết hạn',
    },
    toast: {
      approve: (v, a) => `Đã duyệt. ${a} chạy tiếp.`, reject: (v, a) => `Đã từ chối. ${a} sẽ không chạy việc này.`,
      answer: v => `Đã trả lời: ${cut(v, 100)}.`, choose: v => `Đã chọn: ${cut(v, 100)}.`,
      deny_grant: () => 'Đã từ chối cấp quyền.', done: () => 'Đã đánh dấu là đã xử lý.',
      apply: () => 'Đã áp dụng đề xuất.', discard: () => 'Đã bỏ đề xuất.',
      host_option: v => `Đã ${String(v).toLowerCase()}.`, wait: () => 'Được rồi. Soot chạy lại từ 0 giờ UTC.',
    },
    refused: {
      item_gone: 'Mục này không còn. Mở Nest → Cần bạn để xem.',
      moved_on: 'Việc này vừa đổi trạng thái. Mở Nest để xem rồi chọn lại.',
      not_allowed: 'Chỉ chủ sở hữu trả lời được mục này.',
      not_asker: 'Chỉ người hỏi mới trả lời được câu này.',
      not_authorized: 'Bạn không có quyền xử lý việc này.',
    },
    settled: {
      answered: l => `Đã trả lời · ${l}`, handled: l => `Đã xử lý · ${l}`, inNest: ' (trong Nest)',
      nestOnly: 'Đã xử lý trong Nest', plain: 'Đã xử lý',
      already: l => `Mục này đã được xử lý: ${l}.`, alreadyNest: l => l ? `Đã được xử lý trong Nest: ${l}.` : 'Đã được xử lý trong Nest.',
    },
    pointer: {
      owner: 'Việc này cần chủ sở hữu duyệt. Mình đã báo riêng cho chủ sở hữu.',
      approval: 'Mình đã nhắn riêng để xin bạn duyệt.', grant: 'Mình đã nhắn riêng để xin bạn cấp quyền.',
      other: 'Mình đã nhắn riêng cho bạn về việc này.',
    },
  },
  en: {
    waiting: 'A task is waiting for you',
    head: {
      approval: (s, a) => `**Needs your approval:** ${s}\n${a} is waiting.`,
      unknown_outcome: s => `**Outcome unknown:** ${s}. Check it before trying again.`,
      question: s => `**Question:** ${s}`,
      grant: s => `**Needs your permission:** ${s}`,
      failure: s => `**Failed:** ${s}`,
      decision: (s, a) => a ? `**Decision needed (${a}):** ${s}` : `**Your choice:** ${s}`,
      handle: (s, a) => a ? `**Needs handling (${a}):** ${s}` : `**Needs you to handle:** ${s}`,
      take_back: (s, a) => a ? `**Needs a person (${a}):** ${s}` : `**Needs you to take over:** ${s}`,
    },
    label: {
      approve: 'Approve and run', reject: 'Decline', deny_grant: 'Decline', done: 'Handled',
      open_nest_check: '→ Check it in Nest', open_nest_choose: '→ Choose in Nest',
      open_nest_grant: '→ Grant it in Nest', open_nest_take_back: '→ Take it over in Nest',
      open_nest_handle: '→ Handle it in Nest', open_nest_error: '→ See the error in Nest',
      open_nest_option: v => `→ ${v} in Nest`, expired: 'Expired',
    },
    toast: {
      approve: (v, a) => `Approved. ${a} goes on.`, reject: (v, a) => `Declined. ${a} will not run this.`,
      answer: v => `Answered: ${cut(v, 100)}.`, choose: v => `Chose: ${cut(v, 100)}.`,
      deny_grant: () => 'Permission declined.', done: () => 'Marked as handled.',
      apply: () => 'Proposal applied.', discard: () => 'Proposal discarded.',
      host_option: v => `Done: ${v}.`, wait: () => 'All right. The Soot runs again from 00:00 UTC.',
    },
    refused: {
      item_gone: 'This item is gone. Open Nest to see what needs you.',
      moved_on: 'This just changed. Open Nest to look, then choose again.',
      not_allowed: 'Only the owner can answer this.',
      not_asker: 'Only the person who asked can answer this.',
      not_authorized: 'You are not allowed to handle this.',
    },
    settled: {
      answered: l => `Answered · ${l}`, handled: l => `Handled · ${l}`, inNest: ' (in Nest)',
      nestOnly: 'Handled in Nest', plain: 'Handled',
      already: l => `Already handled: ${l}.`, alreadyNest: l => l ? `Handled in Nest: ${l}.` : 'Handled in Nest.',
    },
    pointer: {
      owner: 'This needs the owner\'s approval. I have told the owner privately.',
      approval: 'I have messaged you privately for your approval.', grant: 'I have messaged you privately for your permission.',
      other: 'I have messaged you privately about this.',
    },
  },
};

const words = session => WORDS[languageOf(session)];

function label(w, action, value) {
  const l = w.label[action];
  if (typeof l === 'function') return cut(l(value), 64);
  return l ?? (value ? cut(value, 64) : null);
}

function head(w, a) {
  const subject = a.subject || w.waiting;
  switch (a.kind) {
    case 'approval': return w.head.approval(a.subject, a.actor ?? '') + (a.preview ? `\n\n${a.preview}` : '');
    case 'unknown_outcome': return w.head.unknown_outcome(a.subject);
    case 'question': case 'grant': case 'failure': return w.head[a.kind](subject);
    case 'decision': return w.head.decision(subject, a.actor);
    case 'handoff': return (a.stage === 'waiting_human' ? w.head.take_back : w.head.handle)(subject, a.actor);
  }
  return `**${a.subject}**\n${a.why ?? ''}`;
}

// The item with its text and button labels worded from the codes, or the
// item as the host sent it when it carries none.
export function wordItem(item, session) {
  const w = words(session);
  if (item.kind === 'attention' && item.attention?.subject) {
    const choices = (item.attention.choices ?? []).map(c => {
      const l = c.action ? label(w, c.action, c.value) : null;
      return l ? {...c, label: l} : c;
    });
    return {...item, text: head(w, item.attention), attention: {...item.attention, choices}};
  }
  const r = item.resolved;
  if (item.kind === 'attention_resolved' && r?.kind) {
    const chosen = (r.action && typeof w.label[r.action] === 'string' ? w.label[r.action] : null) ?? r.label ?? '';
    let text = (r.kind === 'question' || r.kind === 'decision' ? w.settled.answered : w.settled.handled)(chosen);
    if (r.by === 'nest' && !chosen) text = w.settled.nestOnly;
    else if (r.by === 'nest') text += w.settled.inNest;
    else if (!chosen) text = w.settled.plain;
    if (r.name && r.by === 'channel') text += ` (${cut(r.name, 64)})`;
    return {...item, text: `${text}\n${r.title ?? ''}`};
  }
  const n = item.notice;
  if (item.kind === 'notice' && n?.reason === 'dm_pointer' && n.to) {
    const text = n.to === 'asker' ? (w.pointer[n.item_kind] ?? w.pointer.other) : w.pointer.owner;
    return {...item, text};
  }
  return item;
}

// The toast after a press: worded from the answer's codes, else the host's.
export function wordToast(status, body, session) {
  const w = words(session);
  if (!body) return null;
  if (status === 200 && body.action && w.toast[body.action]) return w.toast[body.action](body.value ?? '', body.actor ?? '');
  if (body.code === 'already_resolved' && body.resolution) {
    const r = body.resolution;
    const l = (r.action && typeof w.label[r.action] === 'string' ? w.label[r.action] : null) ?? r.label ?? '';
    return r.by === 'nest' ? w.settled.alreadyNest(l) : w.settled.already(l);
  }
  // A refusal code is worded only when the host sent codes elsewhere (it
  // carries action on applied presses): an older host's toast stays.
  const refused = body.reason === 'not_asker' ? w.refused.not_asker : w.refused[body.code];
  if (refused && body.toast) return refused;
  return body.toast ?? null;
}
