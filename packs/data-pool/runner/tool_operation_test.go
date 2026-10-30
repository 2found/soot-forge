package main

import "testing"

func TestToolOperationNamesTheServiceOperation(t *testing.T) {
	for operation, want := range map[string]string{
		"data-pool_query":          "query",
		"data-pool_manage":         "manage",
		"data-pool_view":           "view",
		"data-pool-console_view":   "view",
		"data-pool-console_action": "action",
		"data-pool-console_query":  "",
		"data-pool-console_manage": "",
		"data-pool_nope":           "",
		"other_query":              "",
		"":                         "",
	} {
		if got := toolOperation(operation); got != want {
			t.Errorf("toolOperation(%q) = %q, want %q", operation, got, want)
		}
	}
}
