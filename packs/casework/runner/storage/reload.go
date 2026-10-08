package storage

// Quiesce atomically fences new agent/notification claims. Already-admitted
// pending work stays durable for the next process. Never interrupt an effect or
// a webhook request merely because an operator wants to change a pack.
func (s *Store) Quiesce() bool {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.cases {
		if c.Notification != nil && c.Notification.State == "sending" {
			return false
		}
		for _, e := range c.Events {
			if e.Status == "running" {
				return false
			}
		}
		for _, a := range c.Actions {
			if a.Status == "running" {
				return false
			}
		}
	}
	s.quiesced = true
	return true
}

func (s *Store) Resume() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	s.quiesced = false
	s.mu.Unlock()
}
