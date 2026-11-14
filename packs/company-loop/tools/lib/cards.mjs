// The founder's cards for a build, one per thing owed: a question the session asks, a build left for them to commit and
// ship, a session that stopped. The runtime files them (no model); the id is the dedup, so nothing is remembered here and
// a card that could not be filed is filed on the next tick. They are raised where the Công ty page is: by team_watch for a
// handoff this runtime builds itself, by handoff_events_apply for one the workshop builds. `h` is {key, repo, ticket, command,
// detail, asked, updated_at, created_at}: `key` is the opportunity ref.

const base = { options: [{ id: 'seen', label: 'Đã xem', recommended: true }], link: 'nest://piece/company', link_label: 'Mở Công ty' };
const where = h => (h.repo ? h.repo : 'kho mã trên máy dựng');
const ticketOf = h => (h.ticket ? ` (ticket ${h.ticket})` : '');

export const askGroup = h => `company:ask:${h.key}`;
export const handoverId = h => `company:handover:${h.key}`;
export const blockedId = h => `company:blocked:${h.key}`;
export const unstartedId = h => `company:unstarted:${h.key}`;

export const CARD = {
  asking: (h, title) => ({ ...base, id: `${askGroup(h)}:${h.asked ?? ''}`, group: askGroup(h), title: `Phiên dựng hỏi bạn về "${title}"`,
    why: `${h.detail ?? 'Phiên dựng có một câu hỏi.'}\nTrả lời ở trang Công ty: Đồng ý, Góp ý (phiên dựng sửa rồi hỏi lại) hoặc Dừng. Phiên dựng chờ câu trả lời của bạn, không tự quyết.`, reraise_after_hours: 24 }),
  delivered: (h, title) => ({ ...base, id: handoverId(h), title: `"${title}" đã dựng xong, chờ bạn commit và phát hành`,
    why: `Thay đổi đã qua review và QA, nằm chưa commit trong ${where(h)}${ticketOf(h)}. Xem diff, commit rồi phát hành như mọi lần (/bbs:release). Phát hành xong bấm "Đã phát hành" ở trang Công ty để Soot đo kết quả từ ngày đó.`, reraise_after_hours: 72 }),
  blocked: (h, title) => ({ ...base, id: blockedId(h), title: `Phiên dựng "${title}" đã dừng giữa chừng`,
    why: `Phiên dựng${ticketOf(h)} dừng và chưa xong. Mở terminal "loop-${h.key.toLowerCase()}" trong Orca (bbs team list) để xem lý do, hoặc bấm Chạy lại ở trang Công ty: phiên mới tiếp tục từ chỗ đã lưu.` }),
};
/** The card a state leaves behind when it moves on; `spawned` and `answered` are set after the card was raised. */
export const CARD_OF = { asking: askGroup, answered: askGroup, delivered: handoverId, blocked: blockedId, draft_ready: unstartedId, spawned: unstartedId };

/** A build that never started this long gets one reminder (the id is the dedup and a closed id is never raised again). */
export const NUDGE_AFTER_MS = 2 * 3_600_000;
export function unstartedCard(h, title, now) {
  if (now - Date.parse(h.updated_at ?? h.created_at ?? 0) < NUDGE_AFTER_MS) return null;
  return { ...base, id: unstartedId(h), title: `Phiên dựng "${title}" chưa bắt đầu`,
    why: `Bạn đã Go nhưng phiên dựng chưa mở (máy chưa có bbs, hoặc Orca chưa chạy). ${h.command ? `Chạy lệnh này trong một terminal: ${h.command}` : 'Mở trang Công ty và bấm Chạy lại.'}\nSau đó Soot tự theo dõi tiếp.` };
}
