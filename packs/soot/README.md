# Soot domain pack

> **Deprecated.** This pack now ships with the Soot runtime ≥ 0.22.0 (`builtin/corepacks/soot/` in 2found/2agent; its `soot-domain` skill is now a runtime skill every Soot has); kept for older runtimes. A runtime from 0.22.0 on ignores an installed `packs/soot/` folder and uses its own copy, and `soot check` notes the leftover. Change the runtime's copy; this one is frozen and removed in a later Forge release.

Pack `soot` chứa kiến thức về chính sản phẩm Soot và công cụ cấu hình chính Soot đang chạy.

| Thành phần | Nội dung |
| --- | --- |
| skill `soot-domain` | Mọi thứ về Soot: vocabulary, Lead, nhóm và Đầu mối, mẫu nhóm, pack, lịch, duyệt, hạng model, không gian làm việc, nơi tìm pack/mẫu nhóm, trạng thái avatar. Thao tác trong Nest nằm ở pack `soot-nest`. |
| skill `configure_soot` + tool `configure` (write) | Soot tự hoàn tất cấu hình của mình qua hội thoại: tên, mô tả, mascot, avatar, hạng model, soul, mission, danh sách `packs`. Chỉ được bớt pack; thêm quyền là việc của operator. |

Chọn pack này bằng `"packs": ["soot"]`. Avatar được app render bằng code; không
còn pack tạo ảnh pet riêng.

Tool `configure` chạy `soot configure` và đòi operation id `soot_configure`,
nên nó nằm trong pack `soot`.
