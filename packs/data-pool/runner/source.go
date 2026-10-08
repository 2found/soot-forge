package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/text/unicode/norm"
)

func normalize(text string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ToLower(text)) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if r == 'đ' {
			r = 'd'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/32", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48"} {
		if netip.MustParsePrefix(cidr).Contains(ip) {
			return false
		}
	}
	return true
}

func publicURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Hostname() == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("source must be a public HTTP(S) URL without credentials or fragment")
	}
	h := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if h == "localhost" || !strings.Contains(h, ".") && !strings.Contains(h, ":") || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return nil, errors.New("source host is not public")
	}
	if p := u.Port(); p != "" && p != "80" && p != "443" {
		return nil, errors.New("source port is not allowed")
	}
	if ip, err := netip.ParseAddr(h); err == nil && !publicAddress(ip) {
		return nil, errors.New("source address is not public")
	}
	return u, nil
}

func sourceDial(ctx context.Context, network, address string, lookup func(context.Context, string, string) ([]netip.Addr, error), dial func(context.Context, string, string) (net.Conn, error)) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid source address")
	}
	ips, err := lookup(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("source resolution failed")
	}
	for _, ip := range ips {
		if !publicAddress(ip) {
			return nil, errors.New("source resolved to a non-public address")
		}
	}
	return dial(ctx, network, net.JoinHostPort(ips[0].String(), port))
}

func sourceRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > 3 {
		return errors.New("too many source redirects")
	}
	_, err := publicURL(req.URL.String())
	return err
}

// Each dial resolves and validates every answer, then connects to a validated
// IP rather than resolving the hostname a second time. No proxy is inherited.
func fetchPage(ctx context.Context, raw string) (string, error) {
	u, err := publicURL(raw)
	if err != nil {
		return "", err
	}
	tr := &http.Transport{Proxy: nil, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second}
	defer tr.CloseIdleConnections()
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return sourceDial(ctx, network, address, net.DefaultResolver.LookupNetIP, (&net.Dialer{Timeout: 3 * time.Second}).DialContext)
	}
	c := &http.Client{Transport: tr, Timeout: 6 * time.Second, CheckRedirect: sourceRedirect}
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return "", errors.New("invalid source request")
	}
	req.Header.Set("User-Agent", "Soot-data-pool/1.0")
	resp, err := c.Do(req)
	if err != nil {
		return "", errors.New("source unavailable or rejected by public-address guard")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errors.New("source did not return HTTP 200")
	}
	if resp.ContentLength > 2<<20 {
		return "", errors.New("source page is too large")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20+1))
	if err != nil || len(data) > 2<<20 {
		return "", errors.New("source page is too large or incomplete")
	}
	kind := strings.ToLower(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	if kind == "text/plain" || kind == "text/markdown" {
		if !validText(string(data), maxContent) || strings.TrimSpace(string(data)) == "" {
			return "", errors.New("source text is empty or too large")
		}
		return string(data), nil
	}
	if kind != "text/html" {
		return "", errors.New("source must be HTML, Markdown or plain text")
	}
	return htmlText(string(data))
}

func htmlText(data string) (string, error) {
	root, err := html.Parse(strings.NewReader(data))
	if err != nil {
		return "", errors.New("invalid source HTML")
	}
	var b strings.Builder
	var visit func(*html.Node)
	visit = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "script", "style", "head", "nav", "footer", "form", "noscript", "svg":
				return
			}
			for _, a := range n.Attr {
				if a.Key == "hidden" || a.Key == "aria-hidden" && a.Val == "true" {
					return
				}
			}
		}
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			b.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			visit(c)
		}
	}
	visit(root)
	text := strings.Join(strings.Fields(b.String()), " ")
	if text == "" || !validText(text, maxContent) {
		return "", errors.New("source has no usable text or is too large")
	}
	return text, nil
}
