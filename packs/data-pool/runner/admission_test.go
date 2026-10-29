package main

import (
	"strings"
	"testing"
)

const admissionUIToken = "synthetic-admission-ui-token-1234567"

func admissionGateway(t *testing.T) *gateway {
	t.Helper()
	_, backend := newFake(t)
	c := hostConfig(t, backend.URL)
	c.Clients = append(c.Clients, serviceClient{Soot: "manager", TokenSHA256: hash(admissionUIToken), Operations: []string{"view", "action"}})
	g, err := newGateway(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { g.base.close() })
	if w := toolRequest(t, g, macHostToken, "manager", "manage", false, manageInput{Action: "pool_create", Pool: "products", Name: "Sản phẩm", RequestID: "create"}); w.Code != 200 {
		t.Fatal("create", w.Code, w.Body.String())
	}
	return g
}

// humanAdmit sends admit/dismiss the way Nest does: a person, through the
// manager's UI credential. A refusal is a {status:"error"} answer.
func humanAdmit(t *testing.T, g *gateway, in manageInput) string {
	t.Helper()
	w := toolRequest(t, g, admissionUIToken, "manager", "action", true, uiInput("manage", in))
	if w.Code != 200 {
		t.Fatal("ui action", w.Code, w.Body.String())
	}
	return w.Body.String()
}

// A Soot created after install is admitted by a host manager, tied to one
// machine, then reads what it is granted, with no config edit or restart.
func TestAdmittedSootJoinsWithoutRestart(t *testing.T) {
	g := admissionGateway(t)
	pools := func(token, actor string) (int, string) {
		w := toolRequest(t, g, token, actor, "pools", false, poolsInput{})
		return w.Code, w.Body.String()
	}
	if code, body := pools(macHostToken, "newbie"); code != 400 || !strings.Contains(body, "grant kind data_pool") {
		t.Fatal("unadmitted Soot", code, body)
	}
	// Two machines: the manager has to say which one runs the Soot.
	if body := humanAdmit(t, g, manageInput{Action: "admit", Soot: "newbie", RequestID: "admit-0"}); !strings.Contains(body, `"status":"error"`) || !strings.Contains(body, "[mac vm]") {
		t.Fatal("admit without host on a shared service", body)
	}
	if w := toolRequest(t, g, macHostToken, "marketing", "manage", false, manageInput{Action: "admit", Soot: "newbie", Host: "mac", RequestID: "admit-1"}); w.Code != 403 {
		t.Fatal("a reader admitted a Soot", w.Code, w.Body.String())
	}
	// A manager Soot's model cannot widen who reads the pool.
	if w := toolRequest(t, g, macHostToken, "manager", "manage", false, manageInput{Action: "admit", Soot: "newbie", Host: "mac", RequestID: "admit-model"}); w.Code != 400 || !strings.Contains(w.Body.String(), "only a person") {
		t.Fatal("a model admitted a Soot", w.Code, w.Body.String())
	}
	if body := humanAdmit(t, g, manageInput{Action: "admit", Soot: "newbie", Host: "mac", RequestID: "admit-2"}); strings.Contains(body, `"status":"error"`) {
		t.Fatal("admit", body)
	}
	if code, body := pools(macHostToken, "newbie"); code != 200 || strings.Contains(body, "products") {
		t.Fatal("admitted Soot sees only what it is granted", code, body)
	}
	if code, _ := pools(vmHostToken, "newbie"); code != 400 {
		t.Fatal("another machine claimed the admitted Soot", code)
	}
	// It is a bound Soot now: grants reach it, and read admission means no writes.
	if w := toolRequest(t, g, macHostToken, "manager", "manage", false, manageInput{Action: "grant", Pool: "products", Soot: "newbie", Level: "write", RequestID: "grant"}); w.Code != 200 {
		t.Fatal("grant to admitted Soot", w.Code, w.Body.String())
	}
	if code, body := pools(macHostToken, "newbie"); code != 200 || !strings.Contains(body, "products") {
		t.Fatal("granted collection not visible", code, body)
	}
	doc := writeInput{Action: "upsert", Pool: "products", ID: "doc-1", RequestID: "write-1", Title: "Truyện", Content: "giới thiệu"}
	if w := toolRequest(t, g, macHostToken, "newbie", "write", false, doc); w.Code != 403 {
		t.Fatal("read admission wrote", w.Code)
	}
	if body := humanAdmit(t, g, manageInput{Action: "admit", Soot: "newbie", Host: "mac", Level: "write", RequestID: "admit-3"}); strings.Contains(body, `"status":"error"`) {
		t.Fatal("re-admit as writer", body)
	}
	if w := toolRequest(t, g, macHostToken, "newbie", "write", false, doc); w.Code != 200 {
		t.Fatal("write admission", w.Code, w.Body.String())
	}
	// Dismissal takes effect on the next request; config-bound Soots stay put.
	if body := humanAdmit(t, g, manageInput{Action: "dismiss", Soot: "marketing", RequestID: "dismiss-1"}); !strings.Contains(body, "service config") {
		t.Fatal("dismissed a config-bound Soot", body)
	}
	if body := humanAdmit(t, g, manageInput{Action: "dismiss", Soot: "newbie", RequestID: "dismiss-2"}); strings.Contains(body, `"status":"error"`) {
		t.Fatal("dismiss", body)
	}
	if code, _ := pools(macHostToken, "newbie"); code != 400 {
		t.Fatal("dismissed Soot still admitted", code)
	}
}

func TestAdmissionInputIsStrict(t *testing.T) {
	g := admissionGateway(t)
	for name, in := range map[string]manageInput{
		"pool":         {Action: "admit", Soot: "newbie", Host: "mac", Pool: "products", RequestID: "a1"},
		"unknown host": {Action: "admit", Soot: "newbie", Host: "laptop", RequestID: "a2"},
		"level":        {Action: "admit", Soot: "newbie", Host: "mac", Level: "manage", RequestID: "a3"},
		"bad id":       {Action: "admit", Soot: "new bie", Host: "mac", RequestID: "a4"},
	} {
		if body := humanAdmit(t, g, in); !strings.Contains(body, `"status":"error"`) {
			t.Fatal(name, body)
		}
	}
}
