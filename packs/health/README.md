# Health

Kiểm tra một hoặc nhiều dịch vụ đã sẵn sàng chưa qua địa chỉ HTTP(S) do
operator cấu hình. Tool `probe` là một script POSIX sh dùng `curl`, nên pack
chạy được ngay sau `soot pack add health`, không cần build hay cài thêm
toolchain.

## Cấu hình địa chỉ

Địa chỉ chỉ đến từ cấu hình của operator, không bao giờ từ model hay nội dung
event.

- **Một địa chỉ:** URL trong `run.args` của `pack.json` (mặc định là health
  endpoint của runtime, `http://127.0.0.1:7788/healthz`).
- **Nhiều địa chỉ:** đặt biến môi trường `HEALTH_TARGETS` cho service của
  runtime và cấp nó cho pack (`soot grant health`, hoặc
  `"pack_grants": {"health": {"env": ["HEALTH_TARGETS"]}}`). Giá trị là các cặp
  `name=url`, cách nhau bằng dấu cách hoặc dấu phẩy, tối đa 16 cặp:

  ```sh
  HEALTH_TARGETS="web=https://example.com/ api=https://api.example.com/healthz"
  ```

  Khi `HEALTH_TARGETS` có giá trị, nó thay cho URL trong `run.args`.

Mỗi địa chỉ được kiểm tra với timeout 3 giây, không follow redirect, không đọc
hay in body. Kết quả mỗi dòng là `<name> status=<code> latency_ms=<n>` hoặc
`<name> unreachable (network, TLS or timeout)`. 2xx, 3xx, 5xx và unreachable
đều là quan sát; chỉ cấu hình sai (URL không phải http/https, có user/password
hay fragment, tên không hợp lệ, quá 16 cặp, thiếu `curl`) mới làm tool lỗi.
Cả danh sách được kiểm tra trước khi gọi địa chỉ nào.

## Chọn pack

Trong Soot definition dùng `"packs": ["health"]`; model gọi `run_operation` với operation `health_probe`. Chạy
`soot check --show` để xem pack đã được cấp `HEALTH_TARGETS` chưa. Validation
không gọi địa chỉ nào.

Pack không có lịch. Muốn kiểm tra định kỳ, khai một schedule `every` hoặc cron
trong deployment để gửi yêu cầu tới Soot; muốn cảnh báo có debounce/SLA, dùng
monitoring bên ngoài rồi gửi event. Pack [server-care](../server-care/README.md)
thêm skill phân loại cảnh báo và yêu cầu sửa lỗi có duyệt.
