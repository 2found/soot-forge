# Server-care example

Skill của pack và mission trong Soot definition giúp một Soot kiểm tra máy chủ bằng các operation operator đã cấp.
Recipe của pack dùng `health/probe`, không chứa daemon, case worker, lịch mặc định hay policy
repair trong core. Không tự restart dịch vụ hoặc tạo ticket.

Build/cài [health](../health/README.md), copy hai pack vào packs_dir và gắn
`server-care` vào Soot, kèm một mission cạnh Soot definition mô tả việc kiểm tra.
Dùng model thật để agent chọn tool; demo chỉ kiểm tra đường chạy chung.

Nếu cần kiểm tra định kỳ, cấu hình schedule chung gửi yêu cầu tới Soot. Nếu cần
monitoring có debounce/SLA, dùng monitoring bên ngoài rồi gửi event chuẩn. Nếu cần
hồ sơ công việc, gắn thêm casework riêng; việc kiểm tra không bắt buộc có case.
