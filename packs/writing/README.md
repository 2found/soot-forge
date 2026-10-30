# writing — viết bài, copy và export draft

Pack `writing` cung cấp kỷ năng viết (skills) và một executable xuất draft
thành artifact. Pack được chọn nguyên (`"packs": ["writing"]`):

| Skill | Gồm |
| --- | --- |
| `writing_article` | dàn ý, viết có nguồn, tự biên tập |
| `writing_copy` | biến thể copy theo angle, tôn trọng giới hạn |
| `writing_export` | hướng dẫn dùng tool `export` (executable, mode write) |

`"writing:read"` chỉ cấp các skill — tool `export` ghi artifact nên cần id đầy đủ `writing`.

## Export tool

`writing_export` nhận **một trong hai** nguồn draft:

- `ref` — `art_…` từ `artifacts_create` hoặc producer khác (draft dài).
- `text` — nội dung inline, ≤ ~64 KiB.

và `format` = `markdown` | `html`. `source_format` (mặc định = `format`)
khai báo định dạng đầu vào: `markdown`/`html`/`text`. Markdown → HTML dùng
renderer tối thiểu (heading, list, quote, code, link, emphasis) — bảng và
footnote không được hỗ trợ. HTML output luôn qua sanitize allowlist: chỉ
http/https/relative link, không script/style/iframe/event handler.

Output: `{"kind":"artifact","artifact":{ref,mimeType,sha256,bytes,name}}` —
artifact nằm trong store của operator, không phải URL public.

## Runtime và credential

Runner là Go binary `bin/soot-writing` trong folder pack; build từ module độc lập:

```sh
(cd packs/writing/runner && go build -o ../bin/soot-writing .)
```

Pack khai báo credential tùy chọn `ARTIFACT_STORE` (`pack.json` `needs`) — đường dẫn
tuyệt đối của artifact store, do operator nhập cho từng Soot trong Nest, hoặc bind trong
deployment qua env hoặc file:

```json
{
  "credentials": {
    "helper": {
      "ARTIFACT_STORE": {"env": "ARTIFACT_STORE", "operations": ["writing_export"]}
    }
  }
}
```

Store root do operator sở hữu — model không chọn scope. Layout store theo
contract của pack `artifacts` (`objects/<sha2>/<sha>`, `meta/<id>.json`).
Không cần pack `artifacts` để `export` chạy, nhưng cả hai dùng chung layout
nên có thể trỏ vào cùng một store khi operator bind cùng đường dẫn.
Writer dùng cùng `.forge-artifacts.lock` với `artifacts` để việc tạo reference
không chạy đồng thời với garbage collection. Kho bận quá một giây thì từ chối
trước khi ghi artifact. Nâng cả hai pack cùng lúc; không xoá lockfile.
Protocol này dùng `flock` trên Linux/macOS; writer bên ngoài/cũ cần phối hợp riêng.

## Kiểm tra

```sh
(cd packs/writing/runner && go test -race ./...)          # unit tests
printf '%s\n' '{"api_version":"soot/v1","hook":"tool.call","soot":"helper","operation":"writing_export","input":{"format":"html","source_format":"markdown","text":"# Xin chào"}}' \
  | ARTIFACT_STORE=/tmp/art-store packs/writing/bin/soot-writing export
```

Fixture độc lập ở `fixtures/` (pack copy trong `packs`):

```sh
export SOOT_TEST_ARTIFACT_STORE=/tmp/art-store
cd packs/writing/fixtures && soot check --config deployment.json && soot check --secrets --config deployment.json
```

Runner không phụ thuộc repo Soot private. Từ pack đã cài: `(cd runner && go build -o ../bin/soot-writing .)`; cài pack không build/chạy runner hoặc cấp quyền. Fixture trong checkout Forge dùng binary do operator tự build/copy, không có binary hay dữ liệu cục bộ trong release.
