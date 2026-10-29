# Soot domain pack

Pack `soot` chứa kiến thức về chính sản phẩm Soot và quy trình tạo pet mới theo
chuẩn animation v3 đã dùng trong sản phẩm.

| Capability | Nội dung |
| --- | --- |
| `soot/guide` | Mọi thứ về Soot: vocabulary, Kamaji, nhóm và mẫu nhóm, pack, lịch, duyệt, hạng model, không gian làm việc, nơi tìm pack/mẫu nhóm, trạng thái pet. Thao tác trong Nest nằm ở pack `soot-nest`. |
| `soot/create-pet` | Kiểm tra Codex, hướng dẫn cài/đăng nhập; chuẩn bị prompt/reference, xem tiến độ và ghép sprites |

Recipe `packs: ["soot"]` chỉ chọn `guide`. Tạo pet cần chọn rõ
`soot/create-pet` vì ghi file vào kho do operator cấp.

**Sinh ảnh qua Codex imagegen.** Runtime Soot hiện chưa có native imagegen tool.
Pack chuẩn bị bảy job cho Codex và nhận PNG về để ghép; không gọi Image API,
không dùng OAuth/provider credentials của Soot để giả lập quyền sinh ảnh.
Chỉ có model trả lời văn bản thì chưa thể tự chạy toàn bộ bước vẽ.

## Trước khi tạo pet: cài và đăng nhập Codex

**Tính năng tạo pet dùng Codex để sinh ảnh. Bạn cần cài Codex và đăng nhập
tài khoản của mình trước khi bắt đầu.** Nếu chưa có tài khoản, tạo tài khoản
theo hướng dẫn trong luồng đăng nhập.

1. [Cài Codex CLI theo hướng dẫn OpenAI](https://developers.openai.com/codex/cli).
2. Chạy `codex login` và hoàn tất đăng nhập trong trình duyệt.
3. Chạy `codex login status`, rồi quay lại Soot và nhắn “Tạo pet” hoặc
   “Đã đăng nhập Codex, tiếp tục tạo pet”.

Agent gọi **`soot_pet_preflight({})`** trước khi bắt đầu. Tool trả trạng thái
có cấu trúc và thông báo sẵn cho người dùng:

| Code | Agent hướng dẫn |
| --- | --- |
| `codex_not_installed` | Cài Codex, đăng nhập, quay lại tiếp tục |
| `codex_login_required` | Chạy `codex login` rồi quay lại |
| `codex_host_context_missing` | Operator cấp môi trường cho pack |
| `codex_status_unavailable` | Kiểm tra CLI/keychain/config; chưa kết luận là chưa login |
| `codex_authenticated` | Tiếp tục chuẩn bị pet |

Khi chưa sẵn sàng, agent dừng và chờ người dùng. `prepare` cũng kiểm tra lại;
nếu bị chặn sẽ trả `canPrepare: false` và không tạo file pet. `inspect` và
`assemble` vẫn dùng được với ảnh đã có, không cần đăng nhập lại để xử lý offline.

Check chỉ chạy lệnh cố định `codex login status`, timeout 10 giây; không đọc
`auth.json`, không tự cài/login, không trả raw stdout/stderr hoặc thông tin tài
khoản/API key. Exit code thành công chỉ xác nhận có thông tin đăng nhập, chưa
xác nhận quyền sinh ảnh, token còn hiệu lực trên server hay hạn mức. Xem
[OpenAI authentication](https://developers.openai.com/codex/auth) và
[image generation](https://learn.chatgpt.com/docs/image-generation).

Codex phải được kiểm tra dưới cùng tài khoản hệ điều hành/máy chạy Soot. Nếu
Soot chạy trên server, kết quả này là tài khoản trên server, không phải trạng
thái đăng nhập trên máy riêng của người đang chat.

## Cài và chọn

Folder này tự chứa skills, tools, contract animation và ảnh tham chiếu. Copy
nguyên folder vào `<workspace>/packs.d/soot`, hoặc phân phối folder/archive này
qua `soot add`. Không có dependency vào sibling monorepo hoặc đường dẫn home.

`guide` không cần runtime phụ. `create-pet` cần **Python 3.10+ trên macOS/Linux**
và **Pillow** có WebP support. Chuẩn bị môi trường trước khi `soot serve`:

```sh
python3 -m venv .venv-pets
. .venv-pets/bin/activate
python3 -m pip install -r packs.d/soot/requirements.txt
mkdir -p pet-store/inputs
export SOOT_PET_STORE="$PWD/pet-store"
```

CLI không tự cài dependencies. Khởi chạy Soot với PATH chứa Python của môi
trường trên. Trong Soot definition, thêm vào các grants đang có:

```json
{"id":"designer","use":["soot/guide","soot/create-pet"]}
```

Trong deployment, bind đường dẫn kho cho đúng Soot và đúng operations:

```json
{
  "credentials": {
    "designer": {
      "SOOT_PET_STORE": {
        "env": "SOOT_PET_STORE",
        "operations": ["soot_pet_prepare", "soot_pet_inspect", "soot_pet_assemble"]
      }
    }
  }
}
```

Soot không tự kế thừa environment cho executable. Cho phép hai operation kiểm
tra Codex nhận đúng môi trường host (không truyền API key/token):

```json
{
  "operation_env": {
    "soot_pet_preflight": ["PATH", "HOME", "CODEX_HOME"],
    "soot_pet_prepare": ["PATH", "HOME", "CODEX_HOME"]
  }
}
```

`CODEX_HOME` chỉ được truyền nếu host đã đặt; nếu không, Codex dùng HOME của
host. Tool preflight không cần `SOOT_PET_STORE`. `soot spawn` đã thêm sẵn các
grant này cho Soot `general` khi pack `soot` được cài. Cài Codex phải làm cho lệnh `codex` có trên PATH của process Soot.

Binding `SOOT_PET_STORE` dùng cùng cơ chế host-owned path như artifacts pack; giá trị là
đường dẫn tuyệt đối, không phải API key. Chọn kho riêng theo phạm vi truy cập
của agent. Không coi filesystem của process là sandbox. Pack không cấp shell,
quyền publish, network hay credential sinh ảnh.

Ví dụ deployment/mission nằm **ngoài pack**: tạo workspace bằng `soot spawn <dir>`,
gắn pack `soot` vào Soot rồi thêm mission mô tả việc tạo pet. Từ thư mục workspace
đó có thể đọc grants bằng:

```sh
soot check --show
```

Ví dụ dùng demo model cho việc load/check; thay bằng cấu hình provider của host
để agent thực thi. `check` không chạy tool và không chứng minh imagegen khả dụng.

## Tạo một pet

Ví dụ yêu cầu: “Tạo Soot phi hành gia, cầm vệ tinh đồ chơi, giữ nét lông và
cách chớp mắt như bộ hiện tại.” Agent gọi:

```json
{
  "id": "soot-astronaut",
  "name": "Soot · Phi hành gia",
  "accessories": "ONE cream-and-red toy satellite; a small red space cap",
  "action": "the free hand gently adjusts the satellite antenna"
}
```

1. **`soot_pet_preflight({})`** kiểm tra cài đặt/đăng nhập; nếu cần thì hướng dẫn
   người dùng hoàn tất và chờ họ quay lại.
2. **`soot_pet_prepare`** trả `jobDirectory`, `jobsFile`, bảy output còn thiếu.
   Có thể thêm `reference: "inputs/my-soot.png"`; mặc định dùng Soot đóng gói sẵn.
3. **Codex imagegen** đọc `jobs.json`, attach các `inputImages` và sinh **idle
   trước**. Dùng pose đã chọn của idle làm identity reference cho các trạng thái
   tiếp theo; cập nhật reference/prompt thực tế trong `jobs.json`. Sleeping dùng
   guide nhắm mắt. Copy từng PNG được chọn vào `output` đã khai báo. Toàn bộ path
   trong jobs file tương đối với `jobDirectory`.
4. **`soot_pet_inspect({"id":"soot-astronaut"})`** cho biết state còn thiếu.
5. **`soot_pet_assemble({"id":"soot-astronaut"})`** xuất 84 khung hình,
   metadata và preview. Rà hình thực tế rồi ghi kết quả visual review trước khi
   bàn giao; tool luôn trả `visualReviewRequired: true`.

Handoff cho Codex: “Dùng imagegen để hoàn thành các job trong
`<jobDirectory>/jobs.json`, theo skill create-pet đi kèm pack. Sinh và chọn idle
trước, giữ hai tay và mắt tự nhiên; copy PNG được chọn vào output của mỗi job.”
Không chạy `prepare` lại để thay brief/reference; dùng id mới cho brief mới.

## Output

```text
<SOOT_PET_STORE>/jobs/<id>/
  request.json
  jobs.json
  prompts/<state>.txt
  references/
  sources/<id>/<state>.png
  frame-order.json                 # tùy chọn, chỉ sau khi rà thứ tự pose
  builds/<content-version>/
    manifest.json / atlas.js
    <id>/spritesheet.webp          # 2304×1456, 12×7 ô 192×208
    <id>/<state>.webp              # 768×624, 4×3 ô
    previews/                     # contact PNG + animated WebP
    validation.json
    provenance.json
```

Bảy trạng thái: ngủ, rảnh, suy nghĩ, làm việc, chờ, hoàn thành, lỗi. Blink 150 ms;
tay cử động bằng hình riêng. Bộ ghép dùng cùng implementation với
`scripts/build-pet-v3.py` của source repository: tìm gutter trong suốt, căn chân,
căn scale cả state, xuất lossless WebP. Không tạo thêm pose bằng code.

Build cùng nội dung được tái sử dụng. Sửa nguồn sinh build mới; không ghi đè
atlas đang dùng. Tool ghi trong staging và chỉ xuất bản directory sau khi ghép
thành công, khóa theo job để tránh hai lượt ghi đồng thời. Reference phải nằm
trong kho được bind; từ chối path traversal/symlink. PNG đầu vào tối đa 16 MiB,
đúng 1536×1024 và có alpha. Receipt `unknown` cần đối chiếu job/build trước khi
retry; không đổi operation ID để né fence.

Nạp `atlas.js` mới trước renderer `soot-pet`, trỏ `asset-base` đến thư mục build
và đặt `variant` bằng id mới. Manifest này chứa **một pet mới**, không tự ghép
vào catalog sáu pet hiện tại hoặc sửa homepage/desktop của người dùng.

## Nội dung tham chiếu

- `assets/soot-reference.png`: crop pose mắt mở/tay tự do từ Soot gấu bông v3.
- `assets/awake-motion.webp`, `sleeping-motion.webp`: dải v3 đã được duyệt,
  dùng làm guide chuyển động; không phải phụ kiện bắt buộc cho pet mới.
- `assets/animation.json`: geometry, labels, thứ tự state và durations.
- `assets/actions.json`: chỉ dẫn chuyển động từng state.
- Skill và motion reference ghi lại các lỗi đã sửa: đồng tử chạy, kính biến mất,
  tay thứ ba, mắt mở khi ngủ, alpha haze và điểm nối vòng lặp.

Không có ảnh mới nào được sinh khi cài/chọn pack hoặc chạy `prepare`/`assemble`.
