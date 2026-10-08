package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/2found/soot-forge/packs/casework/runner/domain"
	"golang.org/x/sys/unix"
)

// Store is deliberately single-process. A flock prevents two daemons from
// acknowledging writes against divergent in-memory indexes. Each bounded case
// is one atomic fsync+rename snapshot, indexed in memory by its hash.
type Store struct {
	writeMu sync.Mutex // serializes durable mutations, never held by readers

	quiesced            bool
	mu                  sync.Mutex
	dir                 string
	lock                *os.File
	cases               map[string]*domain.Case
	maxCases, maxEvents int

	changed            chan struct{}
	renderNotification func(*domain.Case) string
}

func caseID(source, subject string) string {
	sum := sha256.Sum256([]byte(source + "\x00" + subject))
	return hex.EncodeToString(sum[:16])
}
func OpenStore(dir string, maxCases, maxEvents int) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("data directory already in use: %w", err)
	}
	s := &Store{dir: dir, lock: f, cases: map[string]*domain.Case{}, maxCases: maxCases, maxEvents: maxEvents, changed: make(chan struct{})}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		s.Close()
		return nil, err
	}
	if maxCases > 0 && len(files) > maxCases {
		s.Close()
		return nil, domain.ErrCapacity
	}
	for _, path := range files {
		b, e := os.ReadFile(path)
		if e != nil {
			s.Close()
			return nil, e
		}
		var c domain.Case
		if e = json.Unmarshal(b, &c); e != nil || c.ID != caseID(c.Source, c.Subject) || filepath.Base(path) != c.ID+".json" || (maxEvents > 0 && len(c.Events) > maxEvents) {
			s.Close()
			return nil, fmt.Errorf("invalid case snapshot %s", filepath.Base(path))
		}
		// All effects are local and committed with the terminal event state.
		// Uncommitted model work can safely rerun after a crash.
		changed := false
		for i := range c.Events {
			if c.Events[i].Status == "running" {
				c.Events[i].Status = "pending"
				changed = true
			}
		}
		if c.Notification != nil && c.Notification.State == "sending" {
			if c.Notification.MessageID == "" {
				c.Notification.State = "unknown"
				c.Notification.Error = "interrupted_create"
			} else {
				c.Notification.State = "pending"
			}
			changed = true
		}
		if changed {
			if e = s.save(&c); e != nil {
				s.Close()
				return nil, e
			}
		}
		s.install(&c)
	}

	return s, nil
}

func (s *Store) Close() error {

	return s.lock.Close()
}
func clone(c *domain.Case) *domain.Case {
	// Strings are immutable: share their backing bytes, copy only mutable
	// containers. JSON remains the disk format, not an in-memory copy mechanism.
	copy := *c
	copy.Events = slices.Clone(c.Events)
	for i := range copy.Events {
		copy.Events[i].Visited = slices.Clone(c.Events[i].Visited)
	}
	copy.Replies = slices.Clone(c.Replies)
	copy.Actions = maps.Clone(c.Actions)
	if c.Ticket != nil {
		ticket := *c.Ticket
		copy.Ticket = &ticket
	}
	if c.Notification != nil {
		n := *c.Notification
		copy.Notification = &n
	}
	return &copy
}

func (s *Store) save(c *domain.Case) error {
	if (c.Incident == "resolved" || c.Incident == "updated") && c.Ticket != nil {
		c.Ticket.Status = "resolved"
	}
	if s.renderNotification != nil {
		content := s.renderNotification(c)
		if content != "" && (c.Notification == nil || content != c.Notification.Content) {
			if c.Notification == nil {
				c.Notification = &domain.Notification{}
			}
			n := c.Notification
			n.Content = content
			n.Version++
			if n.State == "" || n.State == "sent" {
				n.State = "pending"
				n.Attempts = 0
			}
		}
	}
	c.Revision++
	c.Updated = time.Now().UTC()
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.dir, ".case-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(s.dir, c.ID+".json")); err != nil {
		return err
	}
	d, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return err
	}
	return nil
}

// commit is called with writeMu and mu held. Readers see the previous durable
// snapshot during serialization/fsync; no other writer can change the base.
func (s *Store) commit(c *domain.Case) error {
	err := func() error {
		s.mu.Unlock()
		defer s.mu.Lock()
		return s.save(c)
	}()
	if err != nil {
		return err
	}
	s.install(c)
	return nil
}

// install publishes a persisted snapshot and its ready index atomically with
// the next-change notification. Also used during single-threaded recovery.
func (s *Store) install(c *domain.Case) {
	s.cases[c.ID] = c
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *Store) Submit(in domain.Input, root string) (*domain.Case, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	id := caseID(in.Source, in.Subject)
	c := s.cases[id]
	if c == nil {
		if s.maxCases > 0 && len(s.cases) >= s.maxCases {
			return nil, false, domain.ErrCapacity
		}
		c = &domain.Case{ID: id, Source: in.Source, Subject: in.Subject, Owner: root, Root: root, Epoch: 1}
	} else {
		for _, e := range c.Events {
			if e.ID == in.ID {
				if e.Input != in {
					return nil, false, domain.ErrConflict
				}
				return clone(c), true, nil
			}
		}
		c = clone(c)
	}
	if s.maxEvents > 0 && len(c.Events) >= s.maxEvents {
		return nil, false, domain.ErrCapacity
	}
	status := "pending"
	if c.Owner == "human" {
		status = "human"
	}
	c.Events = append(c.Events, domain.Event{Input: in, Agent: c.Owner, Status: status, Visited: []string{c.Owner}})
	if in.Observation != "" {
		c.Incident = in.Observation
		if c.Ticket == nil {
			c.Ticket = &domain.Ticket{ID: "ticket-" + c.ID, Title: "Health incident: " + in.Subject, Owner: c.Owner}
			if in.Source == "maintenance" {
				c.Ticket.Title = "Release maintenance: " + in.Subject
			}
		}
		c.Ticket.Status = "open"
		c.Ticket.Summary = in.Text
	}
	if err := s.commit(c); err != nil {
		return nil, false, err
	}
	return clone(c), false, nil
}
func (s *Store) Get(id string) (*domain.Case, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cases[id]
	if c == nil {
		return nil, domain.ErrNotFound
	}
	return clone(c), nil
}

// Observe atomically pairs a revision check with its next change notification.
// A commit between returning and receiving closes this same channel, so streams
// cannot miss a wake. Unchanged cases allocate and copy nothing.
func (s *Store) Observe(id string, after uint64) (*domain.Case, <-chan struct{}, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cases[id]
	if c == nil {
		return nil, nil, domain.ErrNotFound
	}
	if c.Revision == after {
		return nil, s.changed, nil
	}
	return clone(c), s.changed, nil
}
func (s *Store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.cases)
}

func (s *Store) List(after string, limit int) []*domain.Case {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.cases))
	for id := range s.cases {
		if id > after {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	if len(ids) > limit {
		ids = ids[:limit]
	}
	out := make([]*domain.Case, 0, len(ids))
	for _, id := range ids {
		c := *s.cases[id]
		c.Events = nil
		c.Replies = nil
		c.Actions = maps.Clone(c.Actions)
		if c.Notification != nil {
			n := *c.Notification
			c.Notification = &n
		}
		if c.Ticket != nil {
			t := *c.Ticket
			c.Ticket = &t
		}
		out = append(out, &c)
	}
	return out
}
func (s *Store) Update(id string, fn func(*domain.Case) error) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.cases[id]
	if old == nil {
		return domain.ErrNotFound
	}
	c := clone(old)
	if err := fn(c); err != nil {
		return err
	}
	if err := s.commit(c); err != nil {
		return err
	}
	return nil
}

func (s *Store) Takeover(id string) error {
	return s.Update(id, func(c *domain.Case) error {
		c.Owner = "human"
		c.Epoch++
		for i := range c.Events {
			if c.Events[i].Status == "pending" || c.Events[i].Status == "running" {
				c.Events[i].Status = "human"
			}
		}
		if c.Ticket == nil {
			c.Ticket = &domain.Ticket{ID: "ticket-" + c.ID, Title: "Human assistance requested", Summary: "Operator took ownership", Status: "open"}
		}
		c.Ticket.Owner = "human"
		return nil
	})
}
func (s *Store) HumanReply(id, eventID, text string) error {
	return s.Update(id, func(c *domain.Case) error {
		if c.Owner != "human" {
			return domain.ErrStale
		}
		for _, r := range c.Replies {
			if r.EventID == eventID && r.Author == "human" {
				if r.Text != text {
					return domain.ErrConflict
				}
				return nil
			}
		}
		if s.maxEvents > 0 && len(c.Replies)/4 >= s.maxEvents {
			return domain.ErrCapacity
		}
		c.Replies = append(c.Replies, domain.Reply{EventID: eventID, Author: "human", Text: text})
		return nil
	})
}

// Release returns the conversation to its configured ingress owner. Completed
// or failed work is not rerun; only messages held for the human are queued.
func (s *Store) Release(id string) error {
	return s.Update(id, func(c *domain.Case) error {
		if c.Owner != "human" {
			return domain.ErrStale
		}
		c.Owner = c.Root
		c.Epoch++
		for i := range c.Events {
			if c.Events[i].Status == "human" {
				c.Events[i].Status = "pending"
				c.Events[i].Agent = c.Root
				c.Events[i].Visited = []string{c.Root}
			}
		}
		if c.Ticket != nil {
			c.Ticket.Owner = c.Root
		}
		return nil
	})
}

// GetAction reads an existing result without claiming a new effect. The same
// ownership fence applies to both replay and a fresh claim.
func (s *Store) GetAction(id, key string, epoch uint64) (*domain.Action, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cases[id]
	if c == nil {
		return nil, domain.ErrNotFound
	}
	if c.Epoch != epoch || c.Owner == "human" {
		return nil, domain.ErrStale
	}
	if a, ok := c.Actions[key]; ok {
		return &a, nil
	}
	return nil, nil
}

// ClaimAction commits intent before spawning a subprocess. Configuration changes
// cannot relabel an old claim: resource and mode are facts in the action record.
func (s *Store) ClaimAction(id, key, name, resource, mode string, epoch uint64) (*domain.Action, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cases[id]
	if c == nil {
		return nil, domain.ErrNotFound
	}
	if c.Epoch != epoch || c.Owner == "human" {
		return nil, domain.ErrStale
	}
	if a, ok := c.Actions[key]; ok {
		return &a, nil
	}
	for _, other := range s.cases {
		for _, a := range other.Actions {
			if a.Resource == resource && (a.Status == "running" || ((mode != "read" && a.Status == "unknown") || (mode == "repair" && a.Mode == "repair" && time.Since(a.Started) < time.Minute))) {
				return nil, fmt.Errorf("resource busy, uncertain, or cooling down")
			}
		}
	}
	copy := clone(c)
	if copy.Actions == nil {
		copy.Actions = map[string]domain.Action{}
	}
	if s.maxEvents > 0 && len(copy.Actions)/4 >= s.maxEvents {
		return nil, domain.ErrCapacity
	}
	copy.Actions[key] = domain.Action{Operation: name, Resource: resource, Mode: mode, Status: "running", Started: time.Now().UTC()}
	if err := s.commit(copy); err != nil {
		return nil, err
	}
	return nil, nil
}

func (s *Store) ActiveCounts() map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]int{}
	for _, c := range s.cases {
		for _, e := range c.Events {
			if e.Status == "pending" || e.Status == "running" {
				out[e.Agent]++
			}
		}
	}
	return out
}

// Changes lets host adapters observe durable case transitions without polling.
// Subscribe before reading snapshots to avoid missing a commit between the two.
func (s *Store) Changes() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}
