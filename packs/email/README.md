# email — gửi email qua SMTP

Pack `email` gói năng lực gửi email chủ động. `use: []` — không có recipe
mặc định: gửi mail là external effect nên luôn phải chọn `email/smtp`
tường minh trong Soot definition.

| Capability | Gồm | Effect |
| --- | --- | --- |
| `smtp` | skill `email_smtp` + tool `email_send` | gửi 1 email qua tài khoản bound |

Nhận mail (IMAP/inbox + ingress) theo blueprint BP-04/BP-06b — chưa có
trong pack này.

## Binding (operator, không phải model)

Deployment bind credential `EMAIL_BINDING` — một JSON string (qua `env` hoặc
`file` trong `credentials`) chứa toàn bộ cấu hình tài khoản:

```json
{
  "server": "smtp.example.com",
  "port": 587,
  "tls": "starttls",
  "username": "agent@example.com",
  "password": "app-password",
  "ca_file": "/etc/ssl/internal-ca.pem",
  "from": "agent@example.com",
  "from_name": "Soot Assistant",
  "journal": "/var/lib/soot/email-journal"
}
```

| Field | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `server`,`port` | ✓ | Server do operator kiểm soát |
| `tls` | ✓ | `starttls` \| `implicit` \| `none` — `none` chỉ cho loopback test |
| `username`,`password` | cùng nhau | AUTH PLAIN |
| `ca_file` | | CA bundle riêng; thiếu → system roots. Không có `InsecureSkipVerify` |
| `from` | ✓ | Địa chỉ gửi; model không chọn sender |
| `from_name` | | Display name |
| `journal` | ✓ | Thư mục tuyệt đối cho durable intent/receipt |

Credential reference trong deployment:

```json
{
  "credentials": {
    "helper": {
      "EMAIL_BINDING": {"env": "EMAIL_BINDING", "operations": ["email_send"]},
      "ARTIFACT_STORE": {"env": "ARTIFACT_STORE", "operations": ["email_send"]}
    }
  }
}
```

`ARTIFACT_STORE` chỉ cần khi gửi attachments (ref `art_…` cùng layout với
pack `artifacts`); vẫn bắt buộc khai báo vì `secret_env` resolve khi
operation chạy — nhưng chỉ `send` đọc nó.

## Tool `email_send`

Input: `to[]` (1–20), `subject`, `text` và/hoặc `html`, `attachments[]`
(refs, ≤8), `action_id?` (idempotency key; thiếu → payload hash).

Output (stdout, exit 0): `{"kind":"receipt","receipt":{actionId,state,…}}`
với `state` = `succeeded` \| `failed` \| `unknown`. **`unknown` có thể đã
tới server** — durable journal (`<journal>/send-<actionId>.json`) ghi
`await_ack` và không resend; reconcile với mail server trước khi thử lại.
Message-ID được tạo và ghi journal trước khi DATA kết thúc nên server-side
lookup luôn có chìa khóa.

MIME: `text/plain`, `text/html`, `multipart/alternative` (khi cả hai) và
`multipart/mixed` + base64 attachments (≤8). Header injection bị chặn ở
validate (CR/LF trong address/subject/name → lỗi, không gửi). TLS bắt
buộc verify cert (`starttls`/`implicit`); `tls:none` chỉ chạy khi server
là loopback — dành cho test server nội bộ.

## Runtime

```sh
(cd packs/email/runner && go build -o ../bin/soot-email .)
```

## Kiểm tra

```sh
(cd packs/email/runner && go test -race ./...)   # fake SMTP server: happy,
# dedup, disconnect-after-DATA→unknown, RCPT refuse→retry, STARTTLS verified
# + unverified reject, AUTH, header injection, attachment tamper, restart

printf '%s\n' '{"api_version":"soot/v1","hook":"tool.call","soot":"helper","operation":"email_send","input":{"to":["a@x.com"],"subject":"s","text":"b"}}' \
  | EMAIL_BINDING='{"server":"127.0.0.1","port":2525,"tls":"none","from":"a@x.com","journal":"/tmp/j"}' \
  packs/email/bin/soot-email send
```

Fixture ở `fixtures/`: chạy `fixtures/serve.mjs` (SMTP test server Node
stdlib trên `127.0.0.1:2525`) rồi:

```sh
cd packs/email/fixtures
SOOT_TEST_EMAIL_BINDING="$(cat binding.example.json)" SOOT_TEST_ARTIFACT_STORE=/tmp/artifact-store soot check --secrets --config deployment.json
```

Runner không phụ thuộc repo Soot private. Từ pack đã cài: `(cd runner && go build -o ../bin/soot-email .)`; cài pack không build/chạy runner hoặc cấp quyền. Fixture trong checkout Forge dùng binary do operator tự build/copy, không có binary hay dữ liệu cục bộ trong release.
