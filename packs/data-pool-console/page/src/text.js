// @ts-check
// The page's words in Vietnamese and English (D2.4: the labels belong to the
// pack, not to Nest). Nothing here prints an id, a byte count or a revision
// number on its own; those stay in the support details.

const vi = {
  title: 'Kho tài liệu', intro: 'Tài liệu Soot được đọc khi trả lời. Sửa ở đây, Soot dùng bản mới từ câu trả lời tới.',
  collection: 'Bộ sưu tập', chooseCollection: 'Chọn bộ sưu tập', moreCollections: 'Xem thêm bộ sưu tập', newCollection: 'Tạo bộ sưu tập',
  collectionName: 'Tên bộ sưu tập', create: 'Tạo', cancel: 'Huỷ', reload: 'Tải lại',
  noCollections: 'Chưa có bộ sưu tập nào', noCollectionsHint: 'Bộ sưu tập là một ngăn chứa tài liệu liên quan, ví dụ “Chính sách hoàn tiền”. Tạo bộ đầu tiên, rồi cấp quyền đọc cho Soot ở Quyền hạn.',
  tabDocuments: 'Tài liệu', tabGrants: 'Quyền đọc', tabActivity: 'Hoạt động',
  search: 'Tìm', searchLabel: 'Tìm tài liệu', searchHint: 'Tìm trong bộ sưu tập (gõ sai vẫn tìm được)', clearSearch: 'Bỏ tìm kiếm',
  resultsFor: (/** @type {number} */ n, /** @type {string} */ q) => `${n} kết quả gần đúng cho “${q}”`,
  notFound: (/** @type {string} */ q) => `Không tìm thấy “${q}”`, emptyCollection: 'Bộ sưu tập chưa có tài liệu', emptyHint: 'Bấm “Thêm tài liệu” để dán nội dung, hoặc “Nhập từ đường dẫn” với một trang công khai.',
  addDocument: 'Thêm tài liệu', importURL: 'Nhập từ đường dẫn', firstPage: 'Về trang đầu', nextPage: 'Trang sau',
  back: 'Danh sách', edit: 'Sửa tài liệu', readMore: 'Đọc tiếp', remove: 'Xoá tài liệu…', removeCollection: 'Xoá bộ sưu tập…',
  removeDocHint: 'Xoá tài liệu khỏi bộ sưu tập. Các cuộc trò chuyện cũ vẫn giữ nguyên.',
  confirmRemoveDoc: (/** @type {string} */ name) => `Xoá tài liệu “${name}”? Không hoàn tác được.`,
  confirmRemovePool: (/** @type {string} */ name, /** @type {number} */ n) => `Xoá bộ sưu tập “${name}” cùng ${n} tài liệu, quyền và lịch sử của nó? Không hoàn tác được. Bộ còn bộ con thì chưa xoá được.`,
  confirmYes: 'Xoá', fieldTitle: 'Tiêu đề', fieldBody: 'Nội dung', fieldURL: 'Địa chỉ trang web công khai', urlHint: 'Chỉ một trang. Địa chỉ nội bộ sẽ bị từ chối.',
  fieldTags: 'Nhãn', tagsHint: 'Phân cách bằng dấu phẩy.', fieldSource: 'Địa chỉ gốc của nội dung (nếu có)',
  editing: (/** @type {number} */ r) => r ? `Bản sửa ${r} · bạn đang sửa` : 'Tài liệu mới', save: 'Lưu', fieldNeeded: 'Cần điền ô này.', urlInvalid: 'Địa chỉ phải là trang web công khai (http hoặc https).', tooLong: 'Nội dung dài hơn mức sửa trực tiếp được. Hãy rút gọn, hoặc nhập từ một đường dẫn công khai.',
  tooLongToEdit: 'Tài liệu dài hơn mức sửa trực tiếp được; có thể thay bằng một đường dẫn công khai.',
  conflict: 'Có người vừa lưu bản mới của tài liệu này nên bản của bạn chưa được lưu. Bản sửa của bạn vẫn được giữ.',
  conflictPool: 'Bộ sưu tập vừa đổi nên thay đổi chưa được lưu. Tải lại rồi thử lại.',
  yourVersion: 'Bản của bạn', viewLatest: 'Xem bản mới nhất', copyMine: 'Sao chép bản của bạn', copied: 'Đã sao chép.', copyFailed: 'Không sao chép được; hãy chọn và sao chép thủ công.',
  overwrite: 'Lưu đè lên bản mới nhất…', latestLoaded: 'Đã tải bản mới nhất. Bản của bạn vẫn ở dưới; bấm Lưu để lưu đè lên bản này.',
  unknown: 'Không biết lần lưu trước đã tới máy chủ chưa (mất kết nối giữa chừng). Gửi lại đúng yêu cầu đó sẽ không tạo bản thứ hai.',
  resend: 'Gửi lại', checkStatus: 'Kiểm tra trạng thái',
  recovered: 'Trang vừa mở lại khi một thay đổi chưa được xác nhận. Kiểm tra trạng thái trước; nội dung bản sửa không được lưu trên thiết bị.',
  recoveredMissing: 'Máy chủ chưa nhận thay đổi đó. Nội dung không được lưu trên thiết bị, hãy nhập lại.',
  replayed: (/** @type {string} */ at) => `Đã lưu một lần${at ? ', lúc ' + at : ''}. Lần gửi lại chỉ nhận lại xác nhận cũ.`,
  saved: { upsert: 'Đã lưu · Soot dùng bản này từ câu trả lời tới', remove: 'Đã xoá tài liệu.', pool_create: 'Đã tạo bộ sưu tập.', pool_remove: 'Đã xoá bộ sưu tập.' },
  failed: 'Kho dữ liệu chưa lưu được. Bản sửa của bạn vẫn được giữ, bạn có thể thử lại.',
  busy: 'Máy chủ đang bận. Thử lại sau ít phút.', retry: 'Thử lại', loading: 'Đang tải…', working: 'Đang xử lý…',
  noStorage: 'Không lưu được thông tin khôi phục trên thiết bị. Đừng tải lại trang trước khi kiểm tra xong yêu cầu.',
  loadFailed: 'Chưa đọc được kho dữ liệu. Kiểm tra dịch vụ kho dữ liệu đang chạy và khoá giao diện đã được cấp.',
  grantsIntro: 'Soot nào được đọc bộ sưu tập này. Trang này chỉ hiển thị; đổi quyền ở Cài đặt › Soot › Quyền hạn của từng Soot.',
  grantSoot: 'Soot', grantLevel: 'Quyền', hostManager: 'Người quản lý máy chủ', changeAt: 'Đổi ở Cài đặt › Soot › Quyền hạn',
  levels: { '': 'Không có quyền', read: 'Đọc', write: 'Đọc và ghi', manage: 'Quản lý' }, readers: (/** @type {string[]} */ n) => n.length ? `Đọc được: ${n.join(', ')}` : 'Chưa Soot nào đọc được',
  documents: (/** @type {number} */ n) => `${n} tài liệu`,
  activityIntro: (/** @type {number} */ n) => `Giữ tối đa ${n} sự kiện. Nhật ký truy cập không xác nhận dữ liệu đã được dùng trong câu trả lời.`,
  noActivity: 'Chưa có hoạt động nào trong bộ sưu tập này.', newest: 'Mới nhất', older: 'Trang trước đó', expired: 'Các hoạt động cũ hơn đã hết thời gian lưu.',
  events: { pool_create: 'Tạo bộ sưu tập', pool_update: 'Sắp xếp bộ sưu tập', pool_remove: 'Xoá bộ sưu tập', append: 'Thêm quan sát', upsert: 'Thêm / cập nhật', remove: 'Xoá tài liệu', grant: 'Cấp quyền', revoke: 'Thu hồi quyền', read: 'Đọc tài liệu', list: 'Xem danh sách', search: 'Tìm dữ liệu' },
  statuses: { succeeded: 'Đã hoàn tất', failed: 'Thất bại', rejected: 'Đã từ chối', pending: 'Đang xử lý', uncertain: 'Chưa xác nhận' },
  human: (/** @type {string} */ via) => `Người dùng · qua ${via}`, unrecorded: 'Chưa ghi nhận', untitled: 'Tài liệu chưa đặt tên',
  source: 'Xuất xứ', noSource: 'Chưa ghi địa chỉ gốc', bySoot: 'Do Soot thêm vào', noTags: 'Chưa có nhãn', changed: 'Tài liệu đã đổi. Tải lại từ đầu để xem cùng một bản.',
  support: 'Thông tin hỗ trợ', requestID: 'Mã yêu cầu',
};

/** @type {typeof vi} */
const en = {
  title: 'Library', intro: 'Documents your Soots read when they answer. Edit here and the next answer uses the new version.',
  collection: 'Collection', chooseCollection: 'Choose a collection', moreCollections: 'More collections', newCollection: 'New collection',
  collectionName: 'Collection name', create: 'Create', cancel: 'Cancel', reload: 'Reload',
  noCollections: 'No collections yet', noCollectionsHint: 'A collection holds related documents, such as “Refund policy”. Create the first one, then let Soots read it under Permissions.',
  tabDocuments: 'Documents', tabGrants: 'Readers', tabActivity: 'Activity',
  search: 'Search', searchLabel: 'Search documents', searchHint: 'Search this collection (typos are fine)', clearSearch: 'Clear search',
  resultsFor: (n, q) => `${n} close matches for “${q}”`,
  notFound: q => `Nothing found for “${q}”`, emptyCollection: 'This collection has no documents', emptyHint: 'Choose “Add document” to paste text, or “Import from a link” for a public page.',
  addDocument: 'Add document', importURL: 'Import from a link', firstPage: 'First page', nextPage: 'Next page',
  back: 'List', edit: 'Edit document', readMore: 'Read more', remove: 'Delete document…', removeCollection: 'Delete collection…',
  removeDocHint: 'Removes the document from the collection. Past conversations stay as they are.',
  confirmRemoveDoc: name => `Delete “${name}”? This cannot be undone.`,
  confirmRemovePool: (name, n) => `Delete “${name}” with its ${n} documents, permissions and history? This cannot be undone. A collection with sub-collections cannot be deleted yet.`,
  confirmYes: 'Delete', fieldTitle: 'Title', fieldBody: 'Content', fieldURL: 'Public web page address', urlHint: 'One page only. Internal addresses are refused.',
  fieldTags: 'Tags', tagsHint: 'Separate with commas.', fieldSource: 'Where this content came from (optional)',
  editing: r => r ? `Version ${r} · you are editing` : 'New document', save: 'Save', fieldNeeded: 'This field is required.', urlInvalid: 'The address must be a public web page (http or https).', tooLong: 'This is longer than can be edited here. Shorten it, or import it from a public link.',
  tooLongToEdit: 'This document is longer than can be edited here; you can replace it with a public link.',
  conflict: 'Someone saved a newer version of this document, so yours was not saved. Your edits are kept.',
  conflictPool: 'The collection changed, so nothing was saved. Reload and try again.',
  yourVersion: 'Your version', viewLatest: 'View the latest version', copyMine: 'Copy your version', copied: 'Copied.', copyFailed: 'Could not copy; select and copy it by hand.',
  overwrite: 'Save over the latest version…', latestLoaded: 'Latest version loaded. Your text is below; Save writes it over this version.',
  unknown: 'We do not know whether the last save reached the server (the connection dropped). Resending that same request never makes a second copy.',
  resend: 'Resend', checkStatus: 'Check status',
  recovered: 'The page reopened while a change was unconfirmed. Check its status first; the edited content was not stored on this device.',
  recoveredMissing: 'The server never received that change. The content was not stored on this device; enter it again.',
  replayed: at => `Saved once${at ? ' at ' + at : ''}. The resend only fetched the earlier confirmation.`,
  saved: { upsert: 'Saved · Soots use this version from the next answer', remove: 'Document deleted.', pool_create: 'Collection created.', pool_remove: 'Collection deleted.' },
  failed: 'The library could not save this. Your edits are kept; you can try again.',
  busy: 'The server is busy. Try again in a few minutes.', retry: 'Try again', loading: 'Loading…', working: 'Working…',
  noStorage: 'Recovery details could not be stored on this device. Do not reload until the request is checked.',
  loadFailed: 'Could not read the library. Check that the data-pool service runs and the interface key is granted.',
  grantsIntro: 'Which Soots may read this collection. This page only shows it; change it under each Soot’s Permissions.',
  grantSoot: 'Soot', grantLevel: 'Access', hostManager: 'Host manager', changeAt: 'Change in Settings › Soot › Permissions',
  levels: { '': 'No access', read: 'Read', write: 'Read and write', manage: 'Manage' }, readers: n => n.length ? `Readable by: ${n.join(', ')}` : 'No Soot can read it yet',
  documents: n => `${n} documents`,
  activityIntro: n => `Keeps at most ${n} events. Access records do not prove a source was used in an answer.`,
  noActivity: 'No activity in this collection yet.', newest: 'Newest', older: 'Older', expired: 'Older activity has expired.',
  events: { pool_create: 'Collection created', pool_update: 'Collection arranged', pool_remove: 'Collection deleted', append: 'Observation added', upsert: 'Added / updated', remove: 'Document deleted', grant: 'Access granted', revoke: 'Access revoked', read: 'Document read', list: 'List viewed', search: 'Searched' },
  statuses: { succeeded: 'Done', failed: 'Failed', rejected: 'Refused', pending: 'In progress', uncertain: 'Unconfirmed' },
  human: via => `A person · via ${via}`, unrecorded: 'Not recorded', untitled: 'Untitled document',
  source: 'Source', noSource: 'No source address', bySoot: 'Added by a Soot', noTags: 'No tags', changed: 'The document changed. Reload it from the start to read one version.',
  support: 'Support details', requestID: 'Request ID',
};

export const STRINGS = { vi, en };
/** @param {string} locale */
export const strings = locale => locale === 'en' ? en : vi;

/** A document title for a person: a `soot://` address or slug reads as words, keeping a date's dashes. */
export function docTitle(/** @type {string | undefined} */ title, id = '', t = vi) {
  const raw = (title || id).trim();
  if (!raw || (/\s/.test(raw) && !/^[a-z][\w+.-]*:\/\//i.test(raw))) return raw || t.untitled;
  const last = raw.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? raw;
  const words = last.replace(/\.(md|txt|markdown)$/i, '').replace(/(?<!\d)[-_]+|[-_]+(?!\d)/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : raw;
}
export const sourceLine = (/** @type {string | undefined} */ source, t = vi) => !source ? t.noSource : /^soot:\/\//i.test(source) ? t.bySoot : source;
/** @param {{ kind: string, soot: string } | undefined} actor @param {(id: string) => string} name */
export const actorLabel = (actor, name, t = vi) => actor ? actor.kind === 'human' ? t.human(name(actor.soot)) : name(actor.soot) : t.unrecorded;
export const utf8Bytes = (/** @type {string} */ text) => new TextEncoder().encode(text).length;
/** With no limit known nothing is editable inline, as before. */
export const overInlineLimit = (/** @type {number} */ bytes, /** @type {number | undefined} */ limit) => bytes > (limit || 0);
/** Readers of a collection: direct or inherited grants, group grants through their members, and host managers. */
export function readerIds(/** @type {any} */ d) {
  const ids = new Set(d.host_managers ?? []);
  for (const soot of d.bound_soots ?? []) if (d.effective_permissions?.[soot] ?? d.grants?.[soot]) ids.add(soot);
  for (const [group, level] of Object.entries(d.effective_group_grants ?? {})) if (level) for (const soot of d.groups?.[group] ?? []) ids.add(soot);
  return [...ids];
}
export const parseTags = (/** @type {string} */ text) => [...new Set(text.split(',').map(s => s.trim()).filter(Boolean))];
