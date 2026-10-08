package storage

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/2found/soot-forge/packs/casework/runner/domain"
)

func fullCase() *domain.Case {
	c := &domain.Case{ID: "benchmark", Owner: "keeper", Root: "keeper", Revision: 1, Ticket: &domain.Ticket{Title: "App health", Summary: strings.Repeat("evidence ", 64)}, Actions: map[string]domain.Action{}}
	for i := range 64 {
		id := fmt.Sprint(i)
		c.Events = append(c.Events, domain.Event{Input: domain.Input{ID: id, Source: "chat", Subject: "reader", Text: strings.Repeat("a", 4096)}, Status: "done", Visited: []string{"listener", "triager"}})
		c.Replies = append(c.Replies, domain.Reply{EventID: id, Author: "listener", Text: strings.Repeat("b", 1024)})
		c.Actions[id] = domain.Action{Operation: "inspect", Status: "succeeded", Output: strings.Repeat("c", 1024)}
	}
	return c
}

func TestSnapshotDoesNotShareMutableState(t *testing.T) {
	original := fullCase()
	snapshot := clone(original)
	if !reflect.DeepEqual(original, snapshot) {
		t.Fatal("snapshot changed data")
	}
	snapshot.Events[0].Text = "changed"
	snapshot.Events[0].Visited[0] = "changed"
	snapshot.Replies[0].Text = "changed"
	snapshot.Ticket.Title = "changed"
	snapshot.Actions["0"] = domain.Action{Status: "changed"}
	if !reflect.DeepEqual(original, fullCase()) {
		t.Fatal("snapshot mutation leaked into stored case")
	}
}

var snapshotSink *domain.Case

func BenchmarkSnapshot64Events(b *testing.B) {
	c := fullCase()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		snapshotSink = clone(c)
	}
}

func TestObserveCannotMissCommit(t *testing.T) {
	s, err := OpenStore(t.TempDir(), 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c, _, err := s.Submit(domain.Input{ID: "1", Source: "chat", Subject: "reader", Text: "hello"}, "listener")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, wake, err := s.Observe(c.ID, c.Revision)
	if err != nil || snapshot != nil {
		t.Fatal("unchanged case copied", err)
	}
	if err = s.Takeover(c.ID); err != nil {
		t.Fatal(err)
	}
	// Deliberately start receiving AFTER the commit, testing the lost-wake race.
	select {
	case <-wake:
	default:
		t.Fatal("missed commit notification")
	}
	snapshot, next, err := s.Observe(c.ID, c.Revision)
	if err != nil || snapshot.Owner != "human" {
		t.Fatal("missing committed state", err)
	}
	select {
	case <-next:
		t.Fatal("new subscription already closed")
	default:
	}
	unchanged, _, err := s.Observe(c.ID, snapshot.Revision)
	if err != nil || unchanged != nil {
		t.Fatal("revision not respected")
	}
}

func BenchmarkObserveUnchanged64Events(b *testing.B) {
	c := fullCase()
	s := &Store{cases: map[string]*domain.Case{c.ID: c}, changed: make(chan struct{})}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		snapshotSink, _, _ = s.Observe(c.ID, c.Revision)
	}
}
