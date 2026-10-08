package domain

import (
	"errors"
	"fmt"
	"github.com/2found/soot-forge/packs/casework/runner/contract"
	"regexp"
	"strings"
	"time"
)

var Identifier = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var (
	ErrCapacity = errors.New("capacity reached")
	ErrConflict = errors.New("event id already used with different content")
	ErrNotFound = errors.New("case not found")
	ErrStale    = errors.New("ownership changed")
)

type Input = contract.Event
type Event struct {
	Input
	Agent   string   `json:"agent"`
	Status  string   `json:"status"`
	Task    string   `json:"task,omitempty"`
	Visited []string `json:"visited"`
	Error   string   `json:"error,omitempty"`
}
type Reply struct {
	EventID string `json:"event_id"`
	Author  string `json:"author"`
	Text    string `json:"text"`
}
type Ticket struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Status  string `json:"status"`
	Owner   string `json:"owner"`
}
type Case struct {
	ID           string            `json:"id"`
	Source       string            `json:"source"`
	Subject      string            `json:"subject"`
	Owner        string            `json:"owner"`
	Root         string            `json:"root"`
	Epoch        uint64            `json:"epoch"`
	Revision     uint64            `json:"revision"`
	Updated      time.Time         `json:"updated"`
	Events       []Event           `json:"events"`
	Replies      []Reply           `json:"replies"`
	Ticket       *Ticket           `json:"ticket,omitempty"`
	Actions      map[string]Action `json:"actions,omitempty"`
	Incident     string            `json:"incident,omitempty"`
	Notification *Notification     `json:"notification,omitempty"`
}

type Action struct {
	Resource  string    `json:"resource"`
	Mode      string    `json:"mode"`
	Operation string    `json:"operation"`
	Status    string    `json:"status"`
	Output    string    `json:"output"`
	Started   time.Time `json:"started"`
}
type Outcome struct {
	Reply   string
	Ticket  *Ticket
	Handoff string
	Summary string
}

func ValidateInput(in Input) error {
	if in.Source == "maintenance" {
		if !Identifier.MatchString(in.Subject) || !ReleaseVersion.MatchString(in.VersionFrom) || !ReleaseVersion.MatchString(in.VersionTo) || !MaintenanceState(in.Observation) {
			return fmt.Errorf("invalid maintenance observation")
		}
	} else if in.VersionFrom != "" || in.VersionTo != "" || (in.Observation != "" && ((in.Source != "watch" && in.Source != "alert") || (in.Observation != "firing" && in.Observation != "resolved"))) {
		return fmt.Errorf("invalid observation")
	}
	if len(in.ID) == 0 || len(in.ID) > 128 || !Identifier.MatchString(in.Source) || len(in.Subject) == 0 || len(in.Subject) > 256 || len(strings.TrimSpace(in.Text)) == 0 || len(in.Text) > 4096 || strings.ContainsRune(in.Subject, 0) {
		return fmt.Errorf("id, source, subject and text required within size limits")
	}
	return nil
}

var ReleaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$`)

func MaintenanceState(s string) bool {
	return s == "updating" || s == "updated" || s == "rolled_back" || s == "blocked"
}

// One coalescing outbox entry per case; confirmed updates edit the same message.
type Notification struct {
	Version     uint64    `json:"version"`
	Delivered   uint64    `json:"delivered"`
	State       string    `json:"state"`
	Content     string    `json:"content"`
	MessageID   string    `json:"message_id,omitempty"`
	Attempts    int       `json:"attempts"`
	NextAttempt time.Time `json:"next_attempt,omitempty"`
	Error       string    `json:"error,omitempty"`
}
