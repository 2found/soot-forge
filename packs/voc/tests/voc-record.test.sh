#!/bin/sh
# Offline checks of voc-record: a fake storage endpoint echoes the row.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd); tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'C'
#!/bin/sh
cat > "$CAPTURE"; printf '{"id":"r1"}'
C
chmod +x "$tmp/bin/curl"
run() { CAPTURE="$tmp/row.json" PATH="$tmp/bin:$PATH" SOOT_STORAGE_URL=http://x SOOT_STORAGE_TOKEN=t SOOT_PROJECT="${SP:-}" "$here/bin/voc-record"; }
call() { printf '{"api_version":"soot/v1","hook":"tool.call","input":%s}' "$1"; }
# 1. explicit product, PII scrubbed
call '{"product":"2novel","kind":"bug","summary":"Lỗi xuất bản, mail a@b.com gọi 0912 345 678"}' | run >/dev/null
jq -e '.row.product=="2novel" and (.row.summary|test("@|0912")|not)' "$tmp/row.json" >/dev/null || { echo "FAIL 1"; exit 1; }
# 2. product from SOOT_PROJECT
call '{"kind":"question","summary":"Hỏi giá gói"}' | SP=lohi run >/dev/null
jq -e '.row.product=="lohi"' "$tmp/row.json" >/dev/null || { echo "FAIL 2"; exit 1; }
# 3. no product anywhere -> chung
call '{"kind":"feedback","summary":"Góp ý chung"}' | run >/dev/null
jq -e '.row.product=="chung"' "$tmp/row.json" >/dev/null || { echo "FAIL 3"; exit 1; }
# 4. bad product refused, nothing stored
rm -f "$tmp/row.json"
if call '{"product":"Lohi App!","kind":"bug","summary":"abc def"}' | run 2>/dev/null; then echo "FAIL 4"; exit 1; fi
[ ! -f "$tmp/row.json" ] || { echo "FAIL 4b"; exit 1; }
# 5. bad kind refused
if call '{"kind":"spam","summary":"abc def"}' | run 2>/dev/null; then echo "FAIL 5"; exit 1; fi
echo "voc-record: 5 checks ok"
