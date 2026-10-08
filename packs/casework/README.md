# Casework example

Case là hồ sơ tùy chọn. Luồng luôn là **event → Soot → case tool nếu cần**.
Executable này không có worker, không tự nhận event, không gọi model hoặc agent
khác khi bàn giao. Binary Soot không liên kết code casework.

Build từ thư mục Soot Forge:

```sh
(cd packs/casework/runner && go build -o ../bin/soot-case .)
```

Copy pack kèm binary vào packs_dir, gắn `casework` vào Soot. Agent được cấp các
operation `casework_read`, `casework_upsert`, `casework_handoff` qua run_operation.
Đọc skill để biết input JSON. Model demo không thực thi chúng tự động.

Record scope là conversation ID opaque do host cấp, không lấy từ `input` model.
Store JSON nằm ở `data/` cạnh pack, tối đa 256 hồ sơ trong ví dụ; đổi implementation
hoặc tích hợp hệ thống ticket riêng nếu cần quy mô khác. Không có file case mới
khi Soot trả lời hoặc chạy tool khác. `read` không tạo record; `upsert` mới tạo nó.

Handoff chỉ cho target human trong ví dụ và chỉ ghi trách nhiệm, không gửi tin hay
khởi động agent. Record thuộc human bị chặn sửa bởi agent cho đến khi operator xử
lý qua công cụ quản trị riêng. Generic Stop kiểm soát agent run; case ownership
không điều khiển agent runtime.

`runner/storage` giữ format snapshot để đọc dữ liệu cũ; pending events
trong snapshot không được tự thực thi. Optional HTTP/notification code bên cạnh
chỉ là adapter tham khảo cho ứng dụng riêng, không được Soot mount hay chạy.

Runner không phụ thuộc repo Soot private. Từ pack đã cài: `(cd runner && go build -o ../bin/soot-case .)`; cài pack không build/chạy runner hoặc cấp quyền. Fixture trong checkout Forge dùng binary do operator tự build/copy, không có binary hay dữ liệu cục bộ trong release.
