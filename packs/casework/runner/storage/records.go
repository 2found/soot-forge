package storage

import (
	"fmt"
	"github.com/2found/soot-forge/packs/casework/runner/domain"
	"strings"
)

// Record is a passive, durable document. It never queues agent work.
// scope is an opaque tenant/user/conversation identity supplied by the host.
func (s *Store) Record(scope, owner, title, summary, status, assignee string) (*domain.Case, error) {
	if strings.TrimSpace(title) == "" || len(title) > 256 || strings.TrimSpace(summary) == "" || len(summary) > 4096 || (status != "open" && status != "resolved") {
		return nil, fmt.Errorf("title, summary and status (open/resolved) required within limits")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	id := caseID("conversation", scope)
	c := s.cases[id]
	if c == nil {
		if s.maxCases > 0 && len(s.cases) >= s.maxCases {
			return nil, domain.ErrCapacity
		}
		c = &domain.Case{ID: id, Source: "conversation", Subject: scope, Root: owner, Owner: owner, Epoch: 1}
	} else {
		if c.Owner == "human" {
			return nil, domain.ErrStale
		}
		c = clone(c)
	}
	c.Ticket = &domain.Ticket{ID: "ticket-" + id, Title: title, Summary: summary, Status: status, Owner: owner}
	if assignee != "" {
		c.Owner = assignee
		c.Ticket.Owner = assignee
		c.Epoch++
	}
	if err := s.commit(c); err != nil {
		return nil, err
	}
	return clone(c), nil
}
func (s *Store) RecordFor(scope string) (*domain.Case, error) {
	return s.Get(caseID("conversation", scope))
}
