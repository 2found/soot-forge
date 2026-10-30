# Soot domain pack

Pack `soot` chứa kiến thức về chính sản phẩm Soot và công cụ cấu hình chính Soot đang chạy.

| Thành phần | Nội dung |
| --- | --- |
| skill `soot-domain` | Mọi thứ về Soot: vocabulary, Kamaji, nhóm và mẫu nhóm, pack, lịch, duyệt, hạng model, không gian làm việc, nơi tìm pack/mẫu nhóm, trạng thái avatar. Thao tác trong Nest nằm ở pack `soot-nest`. |
| skill `configure_soot` + tool `configure` (write) | Soot tự hoàn tất cấu hình của mình qua hội thoại: tên, mô tả, mascot, avatar, hạng model, soul, mission, danh sách `packs`. Chỉ được bớt pack; thêm quyền là việc của operator. |

Chọn pack này bằng `"packs": ["soot"]`. Avatar được app render bằng code; không
còn pack tạo ảnh pet riêng.

Tool `configure` chạy `soot configure` và đòi operation id `soot_configure`,
nên nó nằm trong pack `soot`.
