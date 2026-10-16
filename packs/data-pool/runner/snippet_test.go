package main

import (
	"strings"
	"testing"
)

func TestSnippetShowsWhereTheQueryMatches(t *testing.T) {
	filler := strings.Repeat("The VM runs Docker and Caddy and the apps that the operator deploys. ", 30)
	content := "# Sizing the VM\n\n" + filler + "\n- Each extension's `memoryMb`. Defaults: `postgres` 512, `soot` 512, `cliproxy` 256.\n" + filler
	got := snippet(content, "default memoryMb of the soot template")
	if !strings.Contains(got, "`soot` 512") || !strings.HasPrefix(got, "…- Each extension") {
		t.Fatalf("snippet = %q", got)
	}
	if len(got) > snippetBytes+2*len("…") {
		t.Fatalf("snippet is %d bytes", len(got))
	}
}

func TestSnippetKeepsTheOpeningWhenItIsTheBestOrNothingMatches(t *testing.T) {
	content := "# Soot\n\nSoot giá bao nhiêu: chưa công bố. " + strings.Repeat("Nội dung khác về cài đặt và vận hành. ", 60)
	for _, q := range []string{"Soot gia", "kubernetes helm"} {
		if got := snippet(content, q); !strings.HasPrefix(got, "# Soot") || strings.HasPrefix(got, "…") {
			t.Fatalf("%q: snippet = %q", q, got)
		}
	}
	if got := snippet("short page", "page"); got != "short page" {
		t.Fatalf("a short page changed: %q", got)
	}
}

func TestSnippetFoldsAccentsAndCutsOnCharacters(t *testing.T) {
	content := strings.Repeat("Đoạn mở đầu dài dòng về sản phẩm. ", 40) + "\nGiới hạn tốc độ: không có RPM, hàng đợi 1000 chương mỗi lần gọi.\n" + strings.Repeat("Phần cuối. ", 80)
	got := snippet(content, "gioi han toc do")
	if !strings.Contains(got, "Giới hạn tốc độ") || !strings.ContainsRune(got, '…') {
		t.Fatalf("snippet = %q", got)
	}
	if !strings.HasPrefix(got, "…Giới hạn") {
		t.Fatalf("snippet should start at the matching line: %q", got)
	}
}
