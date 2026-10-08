package storage

import (
	"github.com/2found/soot-forge/packs/casework/runner/domain"
	"time"
)

// Configure once before starting workers. Notification intent shares the case's
// fsync/rename transaction; it cannot be lost between case commit and enqueue.
func (s *Store) SetNotificationRenderer(render func(*domain.Case) string) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.renderNotification = render
}

func (s *Store) ClaimNotification(now time.Time) (*domain.Case, <-chan struct{}, time.Duration, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quiesced {
		return nil, s.changed, 0, nil
	}
	var selected *domain.Case
	var next time.Duration
	for _, c := range s.cases {
		n := c.Notification
		if n == nil || n.State != "pending" {
			continue
		}
		if wait := n.NextAttempt.Sub(now); wait > 0 {
			if next == 0 || wait < next {
				next = wait
			}
			continue
		}
		if selected == nil || c.Updated.Before(selected.Updated) {
			selected = c
		}
	}
	if selected == nil {
		return nil, s.changed, next, nil
	}
	c := clone(selected)
	c.Notification.State = "sending"
	c.Notification.Attempts++
	if err := s.commit(c); err != nil {
		return nil, nil, 0, err
	}
	return clone(c), nil, 0, nil
}

func (s *Store) FinishNotification(id string, version uint64, messageID, state, category string, retry time.Duration) error {
	return s.Update(id, func(c *domain.Case) error {
		n := c.Notification
		if n == nil || n.State != "sending" {
			return domain.ErrStale
		}
		n.State = state
		n.Error = category
		n.NextAttempt = time.Time{}
		if messageID != "" {
			n.MessageID = messageID
		}
		if state == "sent" {
			n.Delivered = version
			n.Attempts = 0
			if n.Version > version {
				n.State = "pending"
			}
		} else if state == "pending" {
			if n.Attempts >= 8 {
				n.State = "blocked"
				n.Error = "retry_exhausted"
			} else {
				n.NextAttempt = time.Now().Add(retry)
			}
		}
		return nil
	})
}

func (s *Store) Ready() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.quiesced || (s.maxCases > 0 && len(s.cases) >= s.maxCases) {
		return false
	}
	for _, c := range s.cases {
		if n := c.Notification; n != nil && (n.State == "unknown" || n.State == "blocked") {
			return false
		}
	}
	return true
}
