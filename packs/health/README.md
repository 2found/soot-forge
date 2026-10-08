# Health extension

HTTP readiness tool viết bằng Go stdlib, là module riêng trong `runner/`.
Không import Soot/AgentRay; không được link vào runtime. Có thể đưa cả thư mục
này sang repo riêng và phát hành binary theo OS/CPU.

Từ thư mục này:

```sh
cd runner
go test -race ./...
go build -trimpath -o ../bin/soot-health .
```

Với VM Linux amd64 dùng `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` trước `go build`.
Copy toàn bộ pack (gồm binary) vào `packs.d/health`; sửa `run.args` trong
`pack.json` thành URL đã được operator kiểm tra, rồi gắn `"health"` vào Soot.
URL mẫu là health endpoint của runtime; thay bằng app bạn muốn theo dõi.
Không cần `stdin: context`, secret hoặc quyền dùng API token runtime.

Model dùng `run_operation({"operation":"health_probe"})`. Tool nhận đúng một
URL qua argv cố định, timeout 3 giây, không follow redirect, không đọc/in body.
2xx, 3xx, 5xx và unreachable đều là quan sát; lỗi cấu hình trả exit 1.
Mỗi event/operation chỉ chạy một lần; lần gọi tiếp theo đọc journal. Sau repair,
dùng readiness postcondition của executor hoặc một event mới để có bằng chứng mới.

## Chọn capability

Trong file Soot definition, dùng `"use": ["health/probe"]` hoặc `"packs": ["health"]`. Loader thêm run_operation và operation health_probe cho Soot này. Với nhiều endpoint, khai báo tool name/args riêng và chỉ chọn capability cần dùng.

Chạy `soot check --show --config <workspace>/deployment.json`, rồi chạy binary trực tiếp để kiểm tra endpoint. Validation không gọi endpoint. Đặt schedules ở deployment để gửi yêu cầu định kỳ; pack không có lịch chạy.

URL argv thuộc config operator, không lấy từ model input. Core không có watch hay
health policy. Dùng schedule chung để gửi yêu cầu kiểm tra, hoặc một hệ thống
monitoring bên ngoài gửi event. Pilot bundle mặc định không cài pack này.
