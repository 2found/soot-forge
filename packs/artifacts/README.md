# Artifacts pack (BP-02)

Pack quản lý kho lưu trữ artifact content-addressed trên filesystem cục bộ, dùng làm nền tảng lưu trữ file/media cho các pack khác (`writing/export`, `email` attachments, `live-chat` media refs).

Binary runner `soot-artifacts` được viết bằng Go stdlib cùng public wire contract `soot/v1` được đóng gói trong module runner, biên dịch độc lập và giao tiếp qua stdin JSON `soot/v1`. Đường dẫn thư mục lưu trữ được cấp hoàn toàn từ host binding qua `secret_env`; model input không bao giờ được chạm vào argv, env hay đường dẫn tùy ý trên host.

## Build và kiểm tra

Từ thư mục Soot Forge:

```sh
# Biên dịch runner
(cd packs/artifacts/runner && go build -o ../bin/soot-artifacts .)

# Chạy test suite của runner
cd packs/artifacts/runner && go test -race ./... && cd -

# Kiểm tra pack với deployment fixture
soot check --config packs/artifacts/fixtures/deployment.json
soot check --show --config packs/artifacts/fixtures/deployment.json

# Kiểm tra credential readiness (với biến môi trường fixture)
SOOT_TEST_ARTIFACT_STORE=/tmp/test-artifact-store soot check --secrets --config packs/artifacts/fixtures/deployment.json
```

## Khai báo Capability và Binding
Pack cung cấp 4 capabilities:

1. `read` (mặc định trong recipe `use: ["read"]`): Đọc metadata và nội dung artifact qua immutable reference (`art_<32hex>`).
2. `create`: Lưu nội dung mới vào kho content-addressed, trả về reference.
3. `export`: Sao chép artifact ra thư mục export công khai kèm sidecar thời hạn (`expiry.json`).
4. `remove`: Xóa artifact theo `ref` và/hoặc gỡ shared export theo `exportId`. Xóa `ref` cũng xóa export đã ghi `ref` vào sidecar. R2 unshare thuộc `vibe_cf`.
### Gắn Credential trong Deployment

Pack không hardcode bất kỳ đường dẫn nào. Operator gắn credential qua `secret_env`:

- `ARTIFACT_STORE`: Thư mục gốc tuyệt đối cho kho artifact (bắt buộc cho `read` và `create`).
- `ARTIFACT_EXPORT`: Thư mục tuyệt đối cho file export (bắt buộc khi chọn capability `export`).

Ví dụ cấu hình trong `deployment.json`:

```json
{
  "credentials": {
    "helper": {
      "ARTIFACT_STORE": {
        "env": "ARTIFACT_STORE",
        "operations": ["artifacts_read", "artifacts_create"]
      },
      "ARTIFACT_EXPORT": {
        "env": "ARTIFACT_EXPORT",
        "operations": ["artifacts_export"]
      }
    }
  }
}
```

Phạm vi truy cập (authorization scope) được xác định trực tiếp bởi thư mục được bind. Envelope `ToolCall` không có khái niệm tenant/user; mọi trường `scope`, `owner` hoặc `root` do model gửi lên đều bị từ chối bởi schema nghiêm ngặt (`additionalProperties: false`).

## Đặc tả cấu trúc đĩa (On-Disk Layout v1)

```
<ARTIFACT_STORE>/
  .forge-artifacts.lock                     # Persistent process-lock inode; never unlink
  objects/<sha256[:2]>/<sha256>            # Dữ liệu content-addressed, quyền 0600
  meta/<id>.json                           # Metadata JSON, quyền 0600

<ARTIFACT_EXPORT>/
  exports/<exportId>/<file>                # File export kèm tên đã chuẩn hóa
  exports/<exportId>/expiry.json           # {"expiresAt": RFC3339}
```

### Định danh và ghi dữ liệu

`create`, `export`, `remove` và `writing/export` phối hợp qua cùng khoá filesystem
trên Linux/macOS. Chờ tối đa một giây; kho bận thì từ chối trước khi thay đổi
artifact. Hệ điều hành tự nhả khoá khi process dừng/chết; không xoá lockfile.
Nâng cả hai pack writer cùng lúc khi chúng dùng chung store; writer cũ hoặc
chương trình bên ngoài không tham gia protocol này. Chỉ dùng filesystem có
semantics `flock`/atomic rename phù hợp; không mặc định coi network mount là an toàn.

Metadata tối đa 64 KiB, object tối đa 16 MiB. Object đã tồn tại được đối chiếu
hash/độ dài trước khi tạo reference mới. Dọn export chỉ chạm thư mục `exp_<32hex>`;
metadata hỏng giữ lại object để đối chiếu thay vì xoá theo phỏng đoán.

- `<id>`: `art_` + 32 ký tự hex chữ thường từ CSPRNG (`crypto/rand`).
- Luồng ghi file an toàn: Ghi ra file tạm `.tmp-*` cùng thư mục → `fsync` → `chmod 0600` → `os.Rename` nguyên tử.
- File `meta/<id>.json`:
  ```json
  {
    "id": "art_0123456789abcdef0123456789abcdef",
    "mimeType": "image/png",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "bytes": 12345,
    "createdAt": "2026-10-06T15:04:05Z",
    "provenance": {
      "operation": "artifacts_create",
      "soot": "helper"
    },
    "name": "example.png"
  }
  ```
- DTO tham chiếu trả về cho consumer:
  ```json
  {
    "ref": "art_0123456789abcdef0123456789abcdef",
    "mimeType": "image/png",
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "bytes": 12345,
    "name": "example.png"
  }
  ```

Mọi consumer khi resolve `ref` → đọc metadata → nạp object BẮT BUỘC phải tính lại SHA-256 đối chiếu với metadata trước khi sử dụng.

## Giới hạn và Quy tắc an toàn (Limits & Rules)

- **Dung lượng tối đa:** Mặc định 16 MiB mỗi artifact. Cờ runner `--max-bytes` có thể siết chặt hơn, không được nới lỏng.
- **Ngưỡng inline nội dung:** Cờ `--inline-max` (mặc định 256 KiB). Khi đọc artifact có kích thước ≤ ngưỡng này, runner trả về trường `data_b64`. Khi vượt quá, runner trả về trường `path` trên host filesystem.
- **Chống path traversal:** `ref` bắt buộc khớp regex `^art_[0-9a-f]{32}$`. Tất cả đường dẫn đều qua `filepath.Clean` và kiểm tra tiền tố thư mục.
- **Allowlist MIME type:** Sniff trực tiếp từ magic bytes của nội dung, không tin cậy phần mở rộng hay khai báo từ model:
  - `text/*`
  - `application/json` (kiểm tra cú pháp JSON hợp lệ)
  - `application/pdf`
  - `application/octet-stream`
  - `image/png`, `image/jpeg`, `image/webp`, `image/gif`
  - `audio/mpeg`, `audio/wav`, `audio/mp4`
  - `video/mp4`, `video/webm`
- **File input qua Staging:** Lựa chọn `file` trong `create` CHỈ được phép khi operator chủ động cấu hình cờ `--stage <dir>` trong argv của manifest `run.args`. Model input chỉ được truyền đường dẫn tương đối bên trong thư mục staging này. Mọi nỗ lực thoát thư mục staging đều bị chặn đứng.
- **Export TTL & Dọn dẹp:** `ttlSec` từ 1 đến 86400 giây (mặc định 3600s). Mỗi lần gọi export sẽ kích hoạt quét dọn dẹp cơ hội (opportunistic sweep) tối đa 128 thư mục export đã hết hạn.

Runner không phụ thuộc repo Soot private. Từ pack đã cài: `(cd runner && go build -o ../bin/soot-artifacts .)`; cài pack không build/chạy runner hoặc cấp quyền. Fixture trong checkout Forge dùng binary do operator tự build/copy, không có binary hay dữ liệu cục bộ trong release.
