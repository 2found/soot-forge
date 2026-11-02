# Feature guide — tính năng, nền tảng và gói thành viên

Đọc skill này khi khách hỏi "app có … không", "tính năng … ở đâu", "gói nào
được …", "giá/hạn mức bao nhiêu", "sao iPhone không có …", "sao nút … bị khóa".
Trả lời theo ngôn ngữ của khách (thường là tiếng Việt).

## Quy tắc cứng

1. **Luôn tra trước**: `lohi_lookup {"kind":"features","q":"<từ khóa khách dùng>"}`.
   Không có `q` thì nhận cả bảng. Không nêu giá, hạn mức, số chương offline,
   số lượt nghe hay tên gói từ trí nhớ — chỉ lấy từ kết quả (`plans`, `free`,
   `costsLt`, `features`). Số liệu thay đổi theo catalog của hệ thống.
2. **Tách ba nền tảng**: mỗi tính năng có `platforms.web|ios|android` =
   `yes|partial|no` và `platformNote`. Hỏi khách đang dùng nền tảng nào nếu
   chưa rõ; không suy từ nền tảng này sang nền tảng khác. iOS cố ý không có
   một số luồng tiêu LT (quy định App Store) — nói đúng như `platformNote`,
   đừng hứa "sắp có".
3. **Giải thích khóa theo gói**: `access.gate`
   - `free` — ai cũng dùng được.
   - `login` — cần đăng nhập, không mất phí.
   - `permission` — cần một gói trong `access.includedIn`; nêu các gói đó và
     giá lấy từ `plans`.
   - `lt` — trả theo lượt bằng LT (`access.priceLt`); gói trong `includedIn`
     (nếu có) được miễn/giảm.
4. **Không tự mua, không hứa khuyến mãi**: gợi ý gói phù hợp một lần, nêu rõ
   khác biệt, để khách tự quyết. Không so sánh với đối thủ, không hứa tính
   năng chưa có trong kết quả.

## Khi `q` không khớp

Kết quả có `featureIndex` (danh sách tên). Chọn mục gần nhất để hỏi lại, hoặc
nói thẳng là chưa thấy tính năng đó và chuyển nhân viên. Không bịa.

## Quan hệ với skill khác

- Khách hỏi về hạn mức ĐÃ DÙNG của chính họ (còn bao nhiêu lượt audio Pro) →
  `audio-pro` (`subscription`), vì đó là dữ liệu tài khoản, không phải bảng
  tính năng.
- Khách muốn nâng gói/nạp tiền gặp lỗi → `topup-triage`.
- Khách hỏi nên đọc truyện gì → `novel-recommend`.
