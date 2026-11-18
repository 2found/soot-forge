// channel-adapter v1.6 §14: Cần bạn items worded from the host's codes, in the
// binding's language; an item without codes keeps the host's text.
import assert from 'node:assert/strict';
import test from 'node:test';
import {wordItem, wordToast} from '../core/words.mjs';

const vi = {binding: {}};
const en = {binding: {language: 'en'}};
const attention = (a, text = 'host text') => ({kind: 'attention', text, attention: {item: 'att_1', urgent: true, title: 't', ...a}});

test('Vietnamese words equal the v1.5 host text, item by item', () => {
  const cases = [
    [{kind: 'approval', subject: 'Gửi email', actor: 'Soot CSKH', preview: 'to: a@b'}, '**Cần bạn duyệt:** Gửi email\nSoot CSKH đang chờ.\n\nto: a@b'],
    [{kind: 'unknown_outcome', subject: 'Nạp tiền'}, '**Chưa rõ kết quả:** Nạp tiền. Cần kiểm tra trước khi thử lại.'],
    [{kind: 'question', subject: 'Màu nào?'}, '**Câu hỏi:** Màu nào?'],
    [{kind: 'decision', subject: 'Hoàn tiền?', actor: 'Soot CSKH'}, '**Cần quyết định (Soot CSKH):** Hoàn tiền?'],
    [{kind: 'handoff', subject: 'Khách giận', stage: 'waiting_human'}, '**Cần bạn tiếp nhận:** Khách giận'],
    [{kind: 'handoff', subject: 'Khách giận', stage: 'blocked', actor: 'Bot'}, '**Cần xử lý (Bot):** Khách giận'],
    [{kind: 'improve_proposal', subject: 'Đề xuất A', why: 'Vì B'}, '**Đề xuất A**\nVì B'],
  ];
  for (const [a, want] of cases) assert.equal(wordItem(attention(a), vi).text, want, a.kind);
  const choices = [{label: 'x', action: 'approve', token: 'tok00001'}, {label: 'y', action: 'open_nest_option', value: 'Sửa'}, {label: 'Màu đỏ', action: 'answer', value: 'Màu đỏ'}, {label: 'keep', action: 'future_code'}];
  const worded = wordItem(attention({kind: 'question', subject: 's', choices}), vi).attention.choices.map(c => c.label);
  assert.deepEqual(worded, ['Duyệt và chạy', '→ Sửa trong Nest', 'Màu đỏ', 'keep']);
});

test('English words; no subject keeps the host text; resolved and pointer worded', () => {
  assert.equal(wordItem(attention({kind: 'grant', subject: ''}), en).text, 'host text', 'an empty subject is an older item');
  assert.equal(wordItem(attention({kind: 'grant', subject: 'Gmail'}), en).text, '**Needs your permission:** Gmail');
  assert.equal(wordItem(attention({kind: 'approval', subject: 'Send', actor: 'Ops', choices: [{label: 'Duyệt và chạy', action: 'approve'}]}), en).attention.choices[0].label, 'Approve and run');
  const old = {kind: 'attention', text: 'host', attention: {kind: 'question', title: 't', choices: []}};
  assert.equal(wordItem(old, en), old);
  const resolved = {kind: 'attention_resolved', text: 'host', resolved: {item: 'a', label: 'Duyệt và chạy', by: 'channel', action: 'approve', kind: 'approval', title: 'Gửi email', name: 'Lan', edit: []}};
  assert.equal(wordItem(resolved, vi).text, 'Đã xử lý · Duyệt và chạy (Lan)\nGửi email');
  assert.equal(wordItem(resolved, en).text, 'Handled · Approve and run (Lan)\nGửi email');
  const nest = {...resolved, resolved: {...resolved.resolved, by: 'nest', label: '', action: '', name: ''}};
  assert.equal(wordItem(nest, vi).text, 'Đã xử lý trong Nest\nGửi email');
  const pointer = to => ({kind: 'notice', text: 'host', notice: {reason: 'dm_pointer', item: 'a', item_kind: 'grant', to}});
  assert.equal(wordItem(pointer('asker'), vi).text, 'Mình đã nhắn riêng để xin bạn cấp quyền.');
  assert.equal(wordItem(pointer('owner'), en).text, 'This needs the owner\'s approval. I have told the owner privately.');
});

test('toasts: from the press action, refusal codes, already resolved; else the host toast', () => {
  assert.equal(wordToast(200, {result: 'applied', action: 'approve', actor: 'Soot CSKH', toast: 'host'}, vi), 'Đã duyệt. Soot CSKH chạy tiếp.');
  assert.equal(wordToast(200, {result: 'applied', action: 'choose', value: 'Hoàn tiền', toast: 'host'}, en), 'Chose: Hoàn tiền.');
  assert.equal(wordToast(200, {result: 'applied', toast: 'host'}, en), 'host');
  assert.equal(wordToast(403, {code: 'not_allowed', reason: 'not_asker', toast: 'host'}, en), 'Only the person who asked can answer this.');
  assert.equal(wordToast(409, {code: 'already_resolved', toast: 'host', resolution: {label: 'Duyệt và chạy', by: 'nest', action: 'approve'}}, vi), 'Đã được xử lý trong Nest: Duyệt và chạy.');
  assert.equal(wordToast(403, {code: 'blocked'}, vi), null);
});
