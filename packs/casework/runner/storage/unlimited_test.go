package storage

import (
	"fmt"
	"testing"

	"github.com/2found/soot-forge/packs/casework/runner/domain"
)

func TestUnlimitedAdmissionAndRecovery(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.Close() }()
	for i := range 66 {
		in := domain.Input{ID: fmt.Sprint(i), Source: "work", Subject: "shared", Text: "inspect"}
		c, _, err := s.Submit(in, "helper")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.ClaimAction(c.ID, in.ID, "inspect", in.ID, "read", c.Epoch); err != nil {
			t.Fatal(err)
		}
		in.Subject = in.ID
		if _, _, err := s.Submit(in, "helper"); err != nil {
			t.Fatal(err)
		}
	}
	if s.Count() != 67 {
		t.Fatalf("case count=%d", s.Count())
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.Count() != 67 {
		t.Fatal("unlimited store did not recover")
	}
}
