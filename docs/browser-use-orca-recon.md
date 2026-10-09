# Browser-use: đối chiếu Orca và hướng tối ưu Soot Desktop

Ngày: 2026-10-10, Asia/Ho_Chi_Minh. Phạm vi: recon mã nguồn và đo chi phí input;
chưa thay renderer, browser engine, grant hoặc protocol production.

**Kết luận:** cách hiện tại phù hợp cho một browser chạy trên Soot host và được xem
từ local/remote, nhưng chưa tối ưu cho tương tác trực tiếp trong desktop.
Ưu tiên refactor đường input và stream, giữ Tauri và Chromium hiện tại. Học cách
Orca tách surface native với surface remote; không nhập cả browser subsystem.
Nếu mục tiêu bắt buộc là cảm giác browser native và Chromium trên mọi OS,
Electron `WebContentsView` là ứng viên mạnh cho một thử nghiệm riêng, với chi phí
đổi desktop shell. Chưa có benchmark để kết luận nó nhẹ hơn hay nặng hơn tổng
Tauri + Chromium + Node đang chạy của Soot.

## Nguồn và snapshot

- Orca: `stablyai/orca`, commit
  [`62878c3b0c8a64519fa219b0282da9b64d83c540`](https://github.com/stablyai/orca/tree/62878c3b0c8a64519fa219b0282da9b64d83c540),
  package version `1.4.214`, Electron `43.7.5`, agent-browser `~0.27.0`.
  Đọc clone GitHub; không cài dependency hoặc chạy script của Orca.
- Soot: local `2agent` HEAD `b135f4f4624fe41eb521166c5c914d6f30ba5942`.
  Các file được xem: `desktop/src/tool-area.tsx`, `desktop/src/client.ts`,
  `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/Cargo.toml`,
  `internal/transport/httpapi/conversations/{interfaces,interface_stream}.go`.
- Forge: HEAD `6924617cf746aee6a424e872812fb1bb1f397705`, **có thay đổi chưa commit**
  từ lần review trước; benchmark dùng file adapter thực tế, SHA-256 nằm trong JSON.
  [Manifest](../packs/browser-use/pack.json) ghim agent-browser `0.38.2`,
  cloakbrowser `0.5.10` trong [adapter/package.json](../packs/browser-use/adapter/package.json).
- Kiểm tra thêm source agent-browser `v0.38.2`, commit
  [`39a74c70d7759d5a6de7a22c04570bb626bbd081`](https://github.com/vercel-labs/agent-browser/tree/39a74c70d7759d5a6de7a22c04570bb626bbd081).

## Soot hiện thực sự nhúng gì?

Đường hình ảnh:

```text
Chromium/CloakBrowser headless → CDP screencast → agent-browser WebSocket
  → Soot Go proxy (SSE, base64 JSON) → Rust/Tauri event → React <img>
```

Đường input của người dùng:

```text
React → hàng đợi tuần tự → Tauri command → Soot interface POST + durable receipt
  → npx → Node soot-browser → WebSocket mới → Chromium input
```

Đây là một browser thật ở host với **surface ảnh điều khiển từ xa**, không phải
web document native nằm trong vùng sidebar. Cùng một đường hiện dùng cho desktop
local và kết nối remote. Pack sở hữu adapter/skill, còn renderer nằm ở Soot Desktop
và proxy/receipt nằm ở Soot host; chỉ sửa pack sẽ không giải quyết hết độ mượt.

Các điểm đã xác nhận trong code:

| Điểm | Hệ quả |
| --- | --- |
| Go ép `maxFps=15` | Khoảng cách frame tối thiểu ~66,7 ms khi có frame liên tục; đây là trần cấu hình, chưa phải FPS đo được |
| Mỗi input gọi executable và mở WebSocket, chờ thêm 50 ms sau khi gửi | Tăng độ trễ và giảm tốc độ xử lý hàng đợi, dù browser daemon đã persistent |
| `act()` tuần tự, tối đa 64; vượt ngưỡng chỉ trả promise đang có | Ký tự có thể tồn đọng; input mới có thể bị bỏ mà không có thông báo riêng |
| Wheel chỉ nhận khi `!busy`, bỏ delta nhỏ, đổi thành ±400 px | Mất trackpad momentum/delta; không có horizontal scroll; không gửi vị trí pointer nên adapter dùng (0,0), sai với nested scroller |
| `<img>` nhận keydown/paste nhưng không có composition bridge, mouse drag/hover surface | Tăng FPS không tự giải quyết IME tiếng Việt, chọn chữ, kéo thả hoặc hover |
| Base64 JSON đi qua Go, Rust parse, Tauri emit và React | Có chi phí copy/parse/decode; base64 dài hơn binary ~33%, nhưng chưa đo CPU/RSS của toàn đường này |
| Stream kết thúc sau 25 giây, reconnect và gọi view probe lại | Có thể tạo khoảng ngắt; mục đích là kiểm tra credential thu hồi, không nên chỉ xoá timeout |

React đã gom frame bằng `requestAnimationFrame`; upstream agent-browser đã có
latest-frame-wins trước socket. Vì vậy không nên mô tả hệ thống là hoàn toàn
không có pacing, hoặc chỉ thêm một RAF nữa và kỳ vọng hết lag.

## Phép đo input

[JSON đầy đủ](browser-use-input-benchmark.json),
[script tái lập](../scripts/benchmark-browser-input.mjs).
Mac arm64, Node 24.21.0, npm/npx 10.9.2. Mỗi chế độ 2 lượt warm-up và 20 lượt đo,
thứ tự xen kẽ. Adapter nguyên trạng, `interaction:true`, gửi đúng một ký tự `x`;
receiver WebSocket loopback kiểm tra nội dung và số lần nhận. npx chạy offline,
resolve executable local; không cài package, không chạy Chromium/provider.

Lần tái lập được lưu trong JSON:

| Chế độ | Median đến receiver | Median kết thúc executable | p95 kết thúc |
| --- | ---: | ---: | ---: |
| `npx --no-install soot-browser control` | 306 ms | 375 ms | 476 ms |
| `node /absolute/browser.mjs control` | 67 ms | 122 ms | 156 ms |

Phần chênh khoảng 250 ms là chi phí launcher trong fixture này, không phải
hiệu năng web engine. Khoảng 50 ms chờ sau send vẫn còn trong cả hai chế độ.
Thời gian thay đổi theo tải máy; đây là mẫu đo để xác định nút thắt, không phải
cam kết latency hoặc ngưỡng test cứng.

Tái lập từ Forge với Node 24+ và npm/npx trên PATH:

```sh
node scripts/benchmark-browser-input.mjs \
  "$PWD/packs/browser-use/adapter/browser.mjs" \
  /tmp/browser-use-input-benchmark.json
```

**Giới hạn:** chưa đo Soot API/journal, Tauri IPC, Chromium xử lý input, decode và
paint, mạng remote, cold browser startup hoặc native FPS. Không được gọi số này
là độ trễ end-to-end, hoặc tốc độ sau khi một tối ưu production đã được triển khai.

## Orca làm khác thế nào?

1. **Surface local native:**
   [`browser-page-webview.ts`](https://github.com/stablyai/orca/blob/62878c3b0c8a64519fa219b0282da9b64d83c540/src/renderer/src/components/browser-pane/host-guest/browser-page-webview.ts)
   tạo Electron `<webview>` và giữ instance trong registry. Người dùng gõ/cuộn
   vào Chromium guest trực tiếp. Agent nhắm đến cùng guest qua page ID/CDP.
   Đây là lý do kiến trúc local tránh đường screenshot round trip cho input;
   chưa phải bằng chứng đo được rằng Orca luôn nhanh hơn Soot ở mọi workload.
2. **Backend có thể thay thế:**
   [`browser-backend.ts`](https://github.com/stablyai/orca/blob/62878c3b0c8a64519fa219b0282da9b64d83c540/src/main/browser/browser-backend.ts)
   tách tạo/đóng page khỏi automation. Offscreen backend đăng ký WebContents vào
   cùng manager. Hữu ích để Soot giữ contract pack trong khi đổi surface.
3. **Định danh và vòng đời rõ:** persistent registry tránh remount làm reload
   page; target được kiểm tra lại khi thực thi. Orca vẫn có CLI process cho một
   số agent command, không phải toàn bộ automation đã bỏ subprocess.
4. **Remote stream có binary + backpressure:**
   [`browser-screencast-frame-pacer.ts`](https://github.com/stablyai/orca/blob/62878c3b0c8a64519fa219b0282da9b64d83c540/src/main/browser/browser-screencast-frame-pacer.ts)
   giữ frame mới nhất và phối hợp ACK, không tích một hàng đợi ảnh cũ;
   [protocol](https://github.com/stablyai/orca/blob/62878c3b0c8a64519fa219b0282da9b64d83c540/src/shared/browser-screencast-protocol.ts)
   mang sequence, metadata và image bytes. Renderer dùng Blob URL, decode trước
   khi thay ảnh, bỏ decode lỗi thời và revoke URL.
5. **Wheel giữ ý định người dùng:**
   [`use-remote-browser-page-wheel.ts`](https://github.com/stablyai/orca/blob/62878c3b0c8a64519fa219b0282da9b64d83c540/src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-wheel.ts)
   chuẩn hoá deltaMode, cộng dx/dy khi đang gửi, giữ pointer, chặn scroll của
   parent qua listener non-passive, ràng buộc generation/page để tránh input muộn.

Không copy nguyên `<webview>`: chính [Electron khuyến nghị cân nhắc
`WebContentsView` thay cho tag này](https://www.electronjs.org/docs/latest/api/webview-tag).
Orca cũng dùng `WebContentsView` ở một số popup, nhưng **main browser pane của
snapshot này vẫn là `<webview>`**, không nên đánh đồng hai API.

Không copy toàn bộ lifecycle: Orca có nhiều lớp profile, relay, SSH và worktree
không thuộc bài toán Soot. Nó tắt background throttling cho browsing guest để
giữ capture; điều đó có trade-off năng lượng. Nên phân biệt page đang được agent
dùng, đang có viewer và page thật sự idle, rồi đo trước khi thay policy.

[License Orca](https://github.com/stablyai/orca/blob/62878c3b0c8a64519fa219b0282da9b64d83c540/LICENSE)
là MIT, copyright Lovecast Inc. 2026. Nếu nhập code phải giữ notice; lần recon
này chỉ dùng ý tưởng và trích nguồn, không vendor code Orca.

## Phương án

| Phương án | Độ mượt tiềm năng | Chi phí và mức phù hợp |
| --- | --- | --- |
| Giữ Tauri, tối ưu stream/input hiện tại | Cải thiện đáng kể có cơ sở; vẫn là surface remote | **Ưu tiên ngay**. Giữ Chromium/CloakBrowser, remote và runtime nền; không cần browser engine mới |
| Tauri child WebView | Native scroll/text/IME | Nhẹ về phần engine phải đóng gói, nhưng macOS/Linux dùng WebKit; phải làm lại bridge automation, profile và kiểm chứng parity |
| Electron + WebContentsView | Native Chromium; automation cùng engine | Ứng viên tốt nếu browser là bề mặt sản phẩm chính; đổi shell, IPC, packaging, updater và QA. Đo tổng footprint trước quyết định |
| Tauri + CEF | Native Chromium, giữ shell | Tích hợp C/C++, view/focus, subprocess, signing và browser updates; không phải lựa chọn “đủ nhẹ” về bảo trì hiện tại |
| Chromium headed ở cửa sổ riêng | Native input với browser hiện có | Lối thoát thực dụng cho tương tác dài; không đạt yêu cầu embed vào sidebar |

[Tauri dùng WebView2 trên Windows, WKWebView trên macOS và WebKitGTK trên Linux](https://v2.tauri.app/reference/webview-versions/).
Không thể đổi `<img>` thành child WebView rồi tiếp tục điều khiển đúng page cũ
bằng Chromium CDP: đó là một engine/session khác. Child multiwebview API còn cần
[feature `unstable`](https://docs.rs/tauri/latest/tauri/window/struct.Window.html#method.add_child)
ở tài liệu hiện tại. CEF là [framework nhúng Chromium thật](https://github.com/chromiumembedded/cef),
không phải plugin nhẹ để gắn Chromium đang chạy vào Tauri bằng một dòng config.

## Thứ tự triển khai đề nghị

**1. Input trước.** Giảm launcher bằng đường executable cố định được host cấu
hình, bảo toàn cách cài/resolve dependency của bản standalone và desktop.
Sau đó thêm kênh human input persistent được host cấp quyền, tận dụng WebSocket
upstream đã tồn tại; không khởi động một broker cạnh tranh với Soot runtime.
Giữ `soot/v1`, operation IDs và agent commands qua executor hiện có.

Kênh mới phải giữ scope connection/conversation/resource; pin tab + generation;
validate events, bound queue; receipt cho batch trước khi gửi, sequence/ACK rõ
nghĩa, không replay action chưa rõ kết quả. Reconnect chỉ nối transport. ACK của
viewer là ACK frame, không phải chứng nhận website đã xử lý giao dịch.
Không expose raw upstream/CDP URL hoặc tin cờ `interaction` do model cung cấp.

Gom wheel trong một frame, giữ dx/dy và pointer, có giới hạn backlog. Key/text
không được bỏ âm thầm: khi queue đầy phải báo rõ và dừng nhận; composition input
cần textarea/input bridge riêng. Coalesce text chỉ trong cùng target và trước
barrier như click, Enter, đổi tab; không đảo thứ tự effect.

**2. Stream có pacing xuyên suốt.** Bản agent-browser đang ghim đã có
[`maxFps`, `pacing=ack`, frame sequence và latest-frame-wins](https://github.com/vercel-labs/agent-browser/blob/39a74c70d7759d5a6de7a22c04570bb626bbd081/cli/src/native/stream/websocket.rs).
Tận dụng trước khi viết encoder hoặc đổi thư viện. Chuyển sang stream duplex
được xác thực để ACK sau khi viewer decode/hiển thị; chỉ thêm `pacing=ack` vào
URL hiện tại sẽ kẹt sau frame đầu vì SSE không có đường ACK ngược.

Thử 30 FPS khi đang thao tác, giảm khi idle; đây là cấu hình thử nghiệm, không
cam kết 30/60 FPS. Binary image transport và canvas/Blob decode là bước tiếp theo
sau profiling. Loại base64 khỏi SSE nhưng lại encode qua Tauri event sẽ không
đạt mục tiêu; cần binary IPC hoặc authenticated media channel thật sự. Giữ
credential revalidation/lease thay vì bỏ kiểm tra thu hồi để tránh reconnect.
Có thể giảm encode size/quality bằng cấu hình upstream host-owned; không giảm
viewport thật chỉ để tiết kiệm byte vì nó thay đổi layout và toạ độ click.

**3. Native spike riêng nếu cần.** So sánh cùng fixture, cùng máy giữa stream
đã tối ưu và Chromium native. Nếu ưu tiên embed Chromium trên mọi OS, thử
WebContentsView trước khi chọn đổi shell; nếu ưu tiên nhỏ gọn trên macOS, thử
WKWebView nhưng tính đủ chi phí automation/compatibility. Không mặc định chuyển
backend theo tab vì login, cookies và các effect đang chạy không tự di chuyển.

Soot hiện cho runtime tiếp tục sau khi đóng app. Một guest do desktop sở hữu
có thể mất khi app thoát; native design phải định nghĩa lifecycle/owner và báo
resource unavailable, hoặc có host giữ sống phù hợp. Không âm thầm mở browser
mới rồi phát lại thao tác. Native input trực tiếp cũng cần quy định rõ phạm vi
audit/receipt của human session, giữ nguyên guarantees cho agent effects.
Web guest không nhận app IPC, credential vault hoặc quyền admin; native view
phải có policy navigation/popup/download và isolation riêng.

## Điều kiện đánh giá sau triển khai

- Đo input→DOM và input→paint p50/p95, frame age, dropped/stale frames, queue depth.
  Mốc thử nghiệm local: input→paint p95 dưới 100 ms; chưa phải kết quả đã đạt.
- Fixture có animation, nested scroller, horizontal trackpad, IME tiếng Việt,
  text selection/drag, contenteditable, popup/login thử nghiệm, upload/download.
- Kiểm tra 1/5/10 conversation, CPU/RSS **cả process tree**, bandwidth, startup,
  hide/show panel, tab switch và app exit. Không chỉ đo RSS Tauri shell.
- Failure cases: queue đầy, revoke credential giữa stream, ngắt mạng sau gửi,
  đổi conversation/tab khi input còn chờ, page crash, Stop trong agent wait.
  Không mất hoặc replay keystroke/click âm thầm; không gửi sang page mới.
- Native app thực mới chứng minh được focus/IME/scroll; browser preview và fixture
  WebSocket không thay thế cho QA này. Recon này chạy adapter tests 7/7 trên
  Node 24; không claim E2E native, Orca benchmark hoặc provider verification mới.

```text
STATUS: DONE_WITH_CONCERNS
VERDICT: STEAL(native-local / streamed-remote separation; page identity; input coalescing; frame pacing)
SUMMARY: Refactor transport trước; reuse agent-browser hiện có. Rebuild surface chỉ khi native spike chứng minh lợi ích và chi phí phù hợp.
NEXT: Thực hiện input + stream changes đồng bộ ở Forge adapter, Soot host và Desktop; benchmark native trước quyết định đổi shell.
```
