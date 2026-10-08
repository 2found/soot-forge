# research — tìm kiếm và đối chiếu nguồn

Pack `research` gói năng lực nghiên cứu web thành một capability chọn riêng,
tách khỏi `toolbox` để operator có thể cấp `web_search`/`web_fetch` mà không
cấp `http_request`, `run_shell` hay quyền ghi file.

| Capability | Gồm | Recipe |
| --- | --- | --- |
| `web` | skill `research_web` + native tools `web_search`, `web_fetch` | `web` |

Không có executable riêng: cả hai tools là native host tools
(`builtin/toolbox`), được Soot cung cấp sẵn khi capability được chọn. Pack
không chạy dependency script, không cần credential.

## Dùng

Sau khi cài pack (xem `soot add` trong [CLI reference](../../CONTRIBUTING.md)
hoặc copy folder vào `packs.d/`), chọn capability trong Soot definition:

```json
{
  "id": "helper",
  "use": ["research/web"]
}
```

`packs: ["research"]` cũng được vì recipe mặc định là `web`.

## Skill

`skills/web.md` hướng dẫn agent: truy vấn → mở nguồn → đối chiếu → trả lời
theo khung **Sources / Claims / Gaps** (DTO `Evidence` trong
[blueprint](../../CONTRIBUTING.md)). Claim không có nguồn không
xuất hiện trong câu trả lời; mâu thuẫn được ghi nhận thay vì phán đoán.

## Kiểm tra

Fixture độc lập ở `fixtures/` (deployment + soot + copy của pack trong
`packs.d` — `packs_dir` phải nằm trong workspace nên pack luôn được copy vào,
không symlink):

```sh
cd fixtures && soot check --config deployment.json
cd fixtures && soot check --show --config deployment.json
```

`check` chỉ xác nhận pack load được, capability `research/web` hợp lệ và hai
native tools được cấp cho soot `helper`. Hai tools cần provider web của host;
một deployment thiếu provider web sẽ báo riêng ở runtime, không phải lỗi pack.
