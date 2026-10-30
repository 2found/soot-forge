# research — tìm kiếm và đối chiếu nguồn

Pack `research` gói nghiên cứu web thành một pack riêng, tách khỏi `toolbox`
để operator có thể cấp `web_search`/`web_fetch` mà không cấp `http_request`,
`run_shell` hay quyền ghi file.

| Skill | Tools |
| --- | --- |
| `research_web` | native tools `web_search`, `web_fetch` |

Không có executable riêng: cả hai tools là native host tools
(`builtin/toolbox`), được Soot cung cấp sẵn khi pack được chọn. Pack
không chạy dependency script, không cần credential.

## Dùng

Sau khi cài pack (xem `soot add` trong [CLI reference](../../CONTRIBUTING.md)
hoặc copy folder vào `packs/`), chọn pack trong Soot definition:

```json
{
  "id": "helper",
  "packs": ["research"]
}
```

Pack luôn được chọn nguyên; `"research:read"` cũng gồm cả hai tools vì chúng đều chỉ đọc.

## Skill

`skills/web.md` hướng dẫn agent: truy vấn → mở nguồn → đối chiếu → trả lời
theo khung **Sources / Claims / Gaps** (DTO `Evidence` trong
[blueprint](../../CONTRIBUTING.md)). Claim không có nguồn không
xuất hiện trong câu trả lời; mâu thuẫn được ghi nhận thay vì phán đoán.

## Kiểm tra

Fixture độc lập ở `fixtures/` (deployment + soot + copy của pack trong
`packs` — `packs_dir` phải nằm trong workspace nên pack luôn được copy vào,
không symlink):

```sh
cd fixtures && soot check --config deployment.json
cd fixtures && soot check --show --config deployment.json
```

`check` chỉ xác nhận pack load được, pack `research` hợp lệ và hai
native tools được cấp cho soot `helper`. Hai tools cần provider web của host;
một deployment thiếu provider web sẽ báo riêng ở runtime, không phải lỗi pack.
