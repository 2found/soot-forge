# Review toàn bộ Soot Forge — 2026-10-10

Đã review 25 entry theo thứ tự catalog: 24 pack trong Forge và pack `2build`
ở commit đã pin. Đợt này sửa lỗi về tính đúng, race giữa process, giới hạn tài
nguyên và chất lượng output; giữ thư viện/client nhẹ, không thêm model weights,
browser, môi trường Python hay binary vào archive.

Hash/size của từng archive, phạm vi test và benchmark nằm trong
[pack-review-verification.json](pack-review-verification.json). Đây là evidence
cho đợt review này; các báo cáo media cũ giữ nguyên provenance của lần chạy cũ.

## Kết quả từng pack

| # | Pack | Kết quả review / thay đổi | Kiểm chứng và giới hạn |
| --- | --- | --- | --- |
| 1 | `health` | Giữ HTTP probe một URL do host cấp, timeout 3s, không follow redirect hoặc đọc body. | Go race: status, timeout, destination và không lộ body. Readiness không chứng minh toàn bộ hệ thống khỏe. |
| 2 | `server-care` | Giữ skill ngắn, quan sát trước; chỉ sửa bằng operation đã cấp. Recipe tham chiếu `health/probe` rõ ràng. | Catalog/installer và đọc skill. Cần pack health có sẵn; không có automatic repair hay worker mới. |
| 3 | `vibe_cf` | Sửa thành công giả khi shortlink hết lượt collision, D1/Worker ack sai hoặc thiếu identity; không tạo DB sau lỗi lookup. Phân trang D1/DNS/R2. Chặn redirect credentialed, giới hạn response/metadata/object, kiểm tra TTL trước upload và báo unknown ở lỗi 5xx/408/partial setup. | Go race với HTTP/S3 fixtures: không replay redirect, không POST sau lookup 503, 4 collision không trả link, phân trang giữ cursor và partial deploy không báo succeeded. Chưa ghi Cloudflare thật. |
| 4 | `toolbox` | Giữ manifest dùng công cụ runtime, quyền theo từng selector; không thêm wrapper hay dependency. | Manifest/official installer và review phạm vi file/shell/web. Không mặc định coi shell là sandbox. |
| 5 | `soot` | Thay vòng lặp Python tạo tuple từng pixel bằng native Pillow; tái sử dụng alpha projection. Byte ảnh giữ nguyên. | 5 test pet: alpha 0–255, gutter/frame order, brief repeat/conflict, traversal/symlink, Codex-status projection. Benchmark bên dưới. Chưa tạo pet mới bằng imagegen trong đợt này. |
| 6 | `browser-use` | Validate input trước lock/dependency/browser launch. Navigate trực tiếp chỉ HTTP(S)/about:blank, không credentials; bounds cho action, viewport, coordinate và text. | 7 Node test, gồm executable invalid-input không tạo state hoặc mở browser. Chưa chạy native Chromium/Nest flow trong đợt này; browser/eval được cấp vẫn là công cụ mạnh. |
| 7 | `soot-nest` | Giữ skill về tool area/session/view đúng quyền và vòng đời; không tạo session thứ hai hay iframe URL từ model. | Manifest/installer và review skill. Không thay UI hoặc claim đã kiểm thử Nest UI. |
| 8 | `2build` | Kiểm tra bản external pin `403543cce394020e1f0b9e38c2419f504a188db3`, 26 capability skill-only và prerequisite `bbs`. Giữ pin hiện tại. | Remote validation + official installer. Không thực thi `bbs` workflows; recipe chọn đủ 26 skill có chi phí context lớn, nên dùng selector cụ thể. |
| 9 | `artifacts` | Preflight ref trước compound delete; kiểm tra cache hash/length, bounded metadata/read, scan directory theo batch và chỉ dọn `exp_<32hex>`. Thêm khoá cross-process dùng chung với writing để create/GC không race. | Go race; busy create/remove không sửa dữ liệu, giết process giữ khoá rồi tạo lại được, xoá ref đầu vẫn giữ object có ref mới. Soot thật + filesystem verification. |
| 10 | `casework` | Manifest có schema typed/strict và timeout 15s. Runner kiểm tra toàn bộ bounded envelope, operation và unknown input trước khi mở store. | Go race của runner/storage; wrong operation, trailing JSON và owner field không tạo store. Soot thật upsert/read. Human fence và record/event bounds giữ nguyên. |
| 11 | `data-pool` | Giữ client/manager hiện tại: grant/revoke theo owner, bounded indexed search, source guard và receipt reconciliation. Không embed search engine vào pack. | Go race của permissions, restart/revocation, duplicate/deletion, pending/failed effects, pagination và SSRF/redirect pinning. Hai live lane Meilisearch/public-web không chạy khi chưa opt-in. |
| 12 | `email` | Durable journal có fingerprint nội dung/tài khoản; chặn reuse ID sai intent, journal hỏng và completed receipt cũ không fingerprint. Claim ngăn concurrent send. Base64 đúng line length, attachment 8 MiB/file, 16 MiB tổng, mailbox ASCII hợp lệ. | Go race + SMTP fixture; 16 concurrent invocation chỉ giao 1 mail, corrupted/mismatched/stale claims không gửi; MIME giải mã đúng bytes. SMTP acceptance không phải inbox delivery. |
| 13 | `live-chat` | Review privacy/audience/handoff guidance và asset/source boundary; giữ các thay đổi widget đang có của workspace. | Catalog/installer và root widget asset checks. Không chạy gateway/ingress hay thay UI. |
| 14 | `live-chat-sheets` | Shared owner gateway bounded/typed, write unknown exits 2. Google response 1 MiB, bounded scalar RAW matrix, finite numbers và response identity. Pin auth SDK đúng version trong lock hiện có. | Contract/client Node tests và public owner executable với HTTP redirect fixture. Giữ compatibility `sheets.status` ở action entry point. Chưa credentialed Google export/revocation thật. |
| 15 | `nest-no-code` | Owner view không dispatch mutation; endpoint cố định, deadline tổng 12s, reply 60 KiB, không redirect/retry/vendor-body leak. Unknown write dùng exit 2. | Node contract + gateway tests: wrong operation/origin, invalid UTF-8/JSON/oversize, stalled headers/body, HTTP 408/503 và actual executable. Backend vẫn do host cung cấp. |
| 16 | `research` | Giữ primary-source workflow, opened-source citations, fetch budget và báo gaps. Không thêm shell/network wrapper. | Manifest/installer + skill review; không coi research skill là bằng chứng một nguồn cụ thể đã được fetch. |
| 17 | `website` | Giữ atomic SQLite publication/receipt, locale-specific pointers, safe typed blocks/CTA, fixed CMS endpoint và request reconciliation. Không sửa code/UI đang đúng. | Node publication/CMS, cold migration/concurrent writer, process-kill/recovery và EN/VI provenance tests. UID DAC case chỉ dành Linux, skip trên máy macOS này. Không chứng minh deployment/public UI. |
| 18 | `writing` | Reject corrupt cached object, bounded wire/object reads và exact operation. Writer tham gia cùng process lock với artifacts. | Go race: Markdown/HTML sanitation, intent bounds, cache tamper và writer không vượt lock. Soot thật export/read/remove giữ đúng content/provenance. |
| 19 | `router-care` | Giữ private fixed status projection; đồng bộ SDK error classifier để handler uncertain được exit 2. | Node tests của unavailable/fenced observation, malformed/oversized/symlink status và model-path rejection. Không thao tác router thật. |
| 20 | `marketing` | Review ledger: plan là dữ liệu thụ động, exact revision approval, receipt theo channel, unknown publication không repost. Giữ thay đổi skill/manifest đang có của workspace. | Node workflow tests: publisher 0/1/nhiều, lost response, stale edit/approval, changed plan/binding và missing credentials. Không đăng bài thật. |
| 21 | `office` | DOCX table reject invalid/non-finite/overlong cell thay vì silently truncate. PPTX đọc/sửa text trong group; bảng có preview 30×20 bounded và dimensions/truncation rõ. | Python với file DOCX/XLSX/PPTX/PDF thật, grouped shape/table lớn, ZIP expansion, PDF forms/render, formula guards. Soot thật compose/inspect bốn format + PDF PNG; đã xem PDF mẫu. Formula engine/LibreOffice layout render không được claim. |
| 22 | `ocr` | Giữ native-text PDF route trước model, bounded page/image/token/output; shared HTTP classifier đánh dấu mutation 408 unknown. Không thêm Torch/model vào client. | Python native PDF + HTTP inference fixtures/invalid responses. Soot thật native extraction, scan route và endpoint-unavailable refusal. Chưa benchmark DeepSeek-OCR thật hay so sánh GPT/Claude. |
| 23 | `tts` | Stream kiểm tra declared WAV frames; report digital silence, reject silent/truncated/>600s synthesis trước publish. Không đọc toàn WAV thêm lần để dựng receipt. | Python PCM/HTTP fixtures, allowlist/output guards. Soot thật inspect PCM và denied voice. Không chạy OmniVoice inference mới hoặc nghe audio trong đợt này. |
| 24 | `google-workspace` | Giữ 17 tool Docs/Sheets/Drive, account-scoped durable mutation receipts, revision/snapshot preflight, RAW/formula/export/version boundaries. Reject non-finite expiry; OAuth refresh transport timeout 15s/request. | Python transport fixtures, real file export/upload bytes và lost-response replay fences. Soot thật ba expired-token calls Docs/Sheets/Drive. Không có OAuth/Google write thật để claim. |
| 25 | `video-editor` | Probe cache chỉ trong một invocation theo path/size/mtime. Bound stdout khi CLI còn chạy; timeout/failure kill process group. Reject non-finite duration/oversized picture. Giữ FFmpeg nhẹ, HyperFrames optional. | Python FFmpeg encode/probe/decode thật, descendant-kill/overflow regression và QA exit-1 finding preservation. Soot thật validate/render/probe/contact-sheet; đã xem frame mẫu. Không chạy HyperFrames/model service mới trong đợt này. |

## Hiệu năng và dependency footprint

RGBA cleanup của atlas 2304×1456, median 3 lần trên macOS ARM/Python 3.12:
**1,581s → 0,01183s (~134×)**. SHA-256 trước/sau giống hệt nhau.
Python allocation peak đo bằng `tracemalloc`: 536.251.736 → 4.736 bytes;
số này không bao gồm buffer native Pillow, source image hoặc toàn bộ process RSS.
Đây là benchmark riêng bước cleanup, không phải tốc độ tạo pet/model.

Timeline fixture có 10 clip ảnh lặp và hai audio track cùng file giảm
**12 → 2 lần probe**; regression kiểm đếm invocation của `probe_file` khi vẫn
chạy FFprobe thật. Không claim tốc độ encode hay inference tăng tương ứng.
Artifact GC/reference scan đọc directory theo batch 128 entry, tránh allocate/sort
toàn danh sách; metadata hỏng giữ object để reconciliation.

Không thêm dependency production. Các sửa Go dùng stdlib; các sửa ảnh dùng Pillow
đã có; Google SDK chỉ pin version lock đang dùng. Python dependencies vẫn được
hash-lock; model service, FFmpeg/Chromium và virtualenv ở host. Cả 25 archive source
được đo bằng đúng materializer/release archiver; size/hash nằm trong JSON evidence.

Chi phí prompt cũng là hiệu năng: `2build` có 149.008 bytes skill text nếu chọn
toàn bộ capability; Google Workspace có khoảng 54 KiB skill text toàn bộ nhưng
recipe mặc định rỗng. Chọn `2build/implement`, `google-workspace/sheets-read` hoặc
selector cần dùng thay vì nạp hết. Số bytes không phải tokenizer/context estimate.

## Kiểm chứng

- Root: **19/19 Node test pass**.
- Pack Node: **73 pass, 1 skip, 0 fail** (74 case; Linux UID DAC case skip trên macOS).
- Go: **7 runner module pass `-race -count=1`**, gồm storage tests của casework.
- Python: **58 media + 5 pet test pass**; thiếu prerequisites sẽ fail, không skip.
- `validate --soot … --remote`: **25/25 entry pass**, gồm pinned external source
  và official installer.
- Soot thật, provider **Devin / swe-2**: **11 media/workspace journey + 1 core
  journey**, bao phủ 8 pack; có public tool-start/completion/failure evidence và
  kiểm tra file độc lập. Negative blocked state chỉ được chấp nhận khi có đúng
  tool failure. Một prompt Sheets negative ban đầu sai sequencing đã được sửa
  rồi chạy lại; không lấy lần harness lỗi làm PASS.

Media archive của lần provider dùng snapshot trước thay đổi HTTP-408 cuối cùng;
Go core archive đã có shared lock. Evidence ghi riêng SHA của archive thực sự
cài trong từng runtime và SHA source cuối review, không gán hai snapshot là một.
Thay đổi HTTP-408 cuối được kiểm bằng real local HTTP regression và toàn suite.

CI trước đây chỉ chạy hai Go runner. Lane trusted-source mới chạy toàn bộ Go,
Node và Python, có Office hash-lock, FFmpeg/fonts, frozen Google SDK lock và JSON
report. Contributor PR path tiếp tục validate/catalog-only; chưa chạy GitHub CI
remote trong phiên này. Live provider/model/account journeys vẫn opt-in.

Lệnh tái lập từ Forge:

```sh
node --test scripts/*.test.mjs
node scripts/validate.mjs --soot /absolute/soot --remote
node scripts/test-packs.mjs --python /absolute/office-runtime/bin/python --report /tmp/pack-tests.json
/absolute/office-runtime/bin/python scripts/benchmark-packs.py --output /tmp/benchmark.json
node scripts/review-inventory.mjs --report /tmp/source-inventory.json
node scripts/live-media.mjs --soot /absolute/soot --output /tmp/NEW-media-run --provider devin --model swe-2
node scripts/live-core-review.mjs --soot /absolute/soot --output /tmp/NEW-core-run --provider devin --model swe-2
```

Chuẩn bị interpreter với `packs/office/requirements.lock` có `--require-hashes`,
FFmpeg/FFprobe, font Arial hoặc DejaVu và dependencies Node của live-chat-sheets
trước full suite. Live scripts cần provider đã được cấu hình, thư mục evidence
mới và không publish private runtime logs. Core script operator-build Go binary
trong pack đã cài của fixture; archive không ship binary.

## Vận hành sau nâng cấp

Nâng `artifacts` và `writing` cùng lúc khi dùng chung store, build lại runner
từ source mới. `.forge-artifacts.lock` là inode tồn tại lâu dài; không unlink.
Protocol phối hợp các writer mới trên Linux/macOS/filesystem có `flock` và rename
phù hợp; writer cũ/bên ngoài hoặc network filesystem cần phối hợp riêng.

Email journal/claim là evidence, không phải cache có thể xoá theo tuổi. Với
receipt legacy thiếu fingerprint hoặc claim còn lại sau crash, đối chiếu
Message-ID/server và chứng minh process đã dừng trước khi operator phục hồi.
Không tự mint action ID mới để vượt một kết quả unknown.

Google credentialed read/write/revoke, DeepSeek-OCR inference accuracy, OmniVoice
listening/transcript QA, native Chromium/Nest, real Cloudflare/router/channel
adapters, Meilisearch opt-in và LibreOffice/HyperFrames render là các lane chưa
chạy mới trong review này. Kết quả fixture và các lần live cũ không thay thế
những bằng chứng đó. Không có release/push/deploy hoặc external publication.

Phân trang Cloudflare được đối chiếu [D1 list](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/),
[DNS list](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)
và contract S3 [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html).
