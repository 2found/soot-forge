package main

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
)

func TestSourcesRejectSSRFAndUnusableContent(t *testing.T) {
	for _, raw := range []string{"http://127.0.0.1", "http://[::1]", "http://10.0.0.1", "http://100.64.0.1", "http://169.254.169.254/latest/meta-data", "http://localhost.", "https://x.internal", "https://x.local", "https://user:password@example.com", "https://example.com:8090", "file:///etc/passwd", "http://2130706433", "https://example.com/#secret"} {
		if _, err := publicURL(raw); err == nil {
			t.Fatalf("allowed source %s", raw)
		}
	}
	for _, ip := range []string{"127.1.2.3", "::ffff:127.0.0.1", "192.168.1.1", "100.64.1.1", "0.0.0.0", "224.0.0.1", "2001:db8::1", "64:ff9b::a00:1"} {
		if publicAddress(netip.MustParseAddr(ip)) {
			t.Fatal(ip)
		}
	}
	if !publicAddress(netip.MustParseAddr("93.184.216.34")) {
		t.Fatal("public IPv4 rejected")
	}
	if _, err := fetchPage(context.Background(), "http://127.0.0.1"); err == nil {
		t.Fatal("source safety bypass")
	}
	text, err := htmlText(`<html><head><title>Wrong</title></head><body><nav>ignore</nav><h1>Company</h1><p>Useful policy.</p><script>secret</script><div hidden>hidden</div><footer>ignore</footer></body></html>`)
	if err != nil || text != "Company Useful policy." {
		t.Fatal(text, err)
	}
	for _, data := range []string{"<script>no content</script>", "<p>" + strings.Repeat("x", maxContent+1) + "</p>"} {
		if _, err := htmlText(data); err == nil {
			t.Fatal("unusable content accepted")
		}
	}
}

func TestSourceDNSPinsValidatedAddressAndRedirects(t *testing.T) {
	public := netip.MustParseAddr("93.184.216.34")
	private := netip.MustParseAddr("10.0.0.1")
	dials := 0
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		dials++
		if address != "93.184.216.34:443" {
			t.Fatalf("re-resolved hostname or unvalidated dial: %s", address)
		}
		a, b := net.Pipe()
		b.Close()
		return a, nil
	}
	lookup := func(context.Context, string, string) ([]netip.Addr, error) { return []netip.Addr{public, private}, nil }
	if _, err := sourceDial(context.Background(), "tcp", "company.example:443", lookup, dial); err == nil || dials != 0 {
		t.Fatal("mixed public/private DNS was dialed")
	}
	lookups := 0
	lookup = func(context.Context, string, string) ([]netip.Addr, error) {
		lookups++
		if lookups > 1 {
			return []netip.Addr{private}, nil
		}
		return []netip.Addr{public}, nil
	}
	conn, err := sourceDial(context.Background(), "tcp", "company.example:443", lookup, dial)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if lookups != 1 || dials != 1 {
		t.Fatal("validated address was not pinned")
	}
	if _, err := sourceDial(context.Background(), "tcp", "company.example:443", lookup, dial); err == nil || dials != 1 {
		t.Fatal("subsequent DNS rebind was not denied")
	}
	req, _ := http.NewRequest("GET", "http://127.0.0.1/private", nil)
	if sourceRedirect(req, []*http.Request{{}}) == nil {
		t.Fatal("private redirect accepted")
	}
	req, _ = http.NewRequest("GET", "https://company.example/", nil)
	if sourceRedirect(req, make([]*http.Request, 4)) == nil {
		t.Fatal("redirect bound ignored")
	}
}

func TestSourceRejectsDowngradesAndHiddenText(t *testing.T) {
	https, _ := http.NewRequest("GET", "https://company.example/start", nil)
	plain, _ := http.NewRequest("GET", "http://company.example/next", nil)
	if sourceRedirect(plain, []*http.Request{https}) == nil {
		t.Fatal("https to http redirect accepted")
	}
	if sourceRedirect(https, []*http.Request{plain}) != nil {
		t.Fatal("http to https upgrade rejected")
	}
	text, err := htmlText(`<body><p>Visible.</p>
		<div style="display: none">display-none</div>
		<span style="color:red;VISIBILITY:hidden !important">visibility-hidden</span>
		<p aria-hidden="TRUE">aria-hidden</p><p hidden="">hidden-attr</p>
		<template><p>template-text</p></template><noscript>noscript-text</noscript>
		<p style="display:block">Shown too.</p><p aria-hidden="false">Also shown.</p></body>`)
	if err != nil || text != "Visible. Shown too. Also shown." {
		t.Fatal(text, err)
	}
}
