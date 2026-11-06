# Server-care example

Skill của pack và mission trong Soot definition giúp một Soot kiểm tra máy chủ bằng các operation operator đã cấp.
Pack chỉ có skill, dùng tool `health_probe` của pack `health` (Soot chọn riêng cả hai); không chứa daemon, case worker, lịch mặc định hay policy
repair trong core. Không tự restart dịch vụ hoặc tạo ticket.

Build/cài [health](../health/README.md), copy hai pack vào packs_dir và gắn
`server-care` cùng `health` vào Soot (`"packs": ["server-care", "health"]`), kèm một mission cạnh Soot definition mô tả việc kiểm tra.
Dùng model thật để agent chọn tool; demo chỉ kiểm tra đường chạy chung.

Nếu cần kiểm tra định kỳ, cấu hình schedule chung gửi yêu cầu tới Soot. Nếu cần
monitoring có debounce/SLA, dùng monitoring bên ngoài rồi gửi event chuẩn. Nếu cần
hồ sơ công việc, gắn thêm casework riêng; việc kiểm tra không bắt buộc có case.

## Cảnh báo đã xử lý và sửa lỗi (outcome, remediation)

Pack khai báo outcome `alert_triaged` (cửa sổ huỷ 24h): Soot ghi một đơn vị khi
đã phân loại xong một cảnh báo. Tool `remediate` (restart hoặc reload một dịch
vụ) có `run.approval: operator`: mỗi lần gọi chờ người vận hành duyệt đúng đầu
vào đó trong Nest rồi mới chạy một lần; không có duyệt thì không có sửa. Nó chỉ
gọi địa chỉ HTTPS bạn cấp trong credential `SERVER_CARE_REMEDIATE`
(`{"url": "...", "key": "..."}`); pack không tự chạy lệnh trên máy.
Mẫu nhóm [server-watch](../../groups/server-watch/README.md) dùng pack này với một lịch hằng ngày tạm dừng.
