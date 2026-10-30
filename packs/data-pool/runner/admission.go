package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
)

// Admission is the state-held half of the bound-Soot list. storage.soots is
// fixed when the operator installs the service; a host gives its shared pool to
// Soots created long after that. A host manager admits such a Soot here (Nest
// does it when "Kho dữ liệu" is turned on), with no config edit or restart.
// An admitted Soot is an ordinary bound Soot: it reads what it is granted and
// writes only with a write admission, and it is tied to the one machine
// credential that may act as it, so a shared service never lets one machine
// claim another machine's Soot.

const maxBound = 4096

type admission struct {
	// Host is the @host client name that may act as this Soot; empty only in
	// local executable mode, which has no machine credentials.
	Host  string `json:"host,omitempty"`
	Level string `json:"level"`
	By    string `json:"by"`
	At    string `json:"at"`
}

func readAdmissions(ctx context.Context, tx pgx.Tx) (map[string]admission, error) {
	rows, err := tx.Query(ctx, `SELECT soot, host, level, by, at FROM `+databaseSchema+`.admissions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]admission{}
	for rows.Next() {
		var soot string
		var a admission
		var at time.Time
		if err := rows.Scan(&soot, &a.Host, &a.Level, &a.By, &at); err != nil {
			return nil, err
		}
		a.At = at.UTC().Format(time.RFC3339)
		out[soot] = a
	}
	return out, rows.Err()
}

func (s *service) admissions(ctx context.Context) map[string]admission {
	out := map[string]admission{}
	_ = s.db.view(ctx, func(tx pgx.Tx) error {
		out, _ = readAdmissions(ctx, tx)
		return nil
	})
	return out
}

// withAdmitted widens this session's bound and writer lists by the admitted
// Soots, so every bound-Soot check (grant targets, manage listings) sees them.
// It derives from the static lists and never mutates a shared slice.
func (s *service) withAdmitted(ctx context.Context) {
	soots, writers := slices.Clone(s.static.Soots), slices.Clone(s.static.Writers)
	for id, a := range s.admissions(ctx) {
		if !slices.Contains(soots, id) {
			soots = append(soots, id)
		}
		if a.Level == "write" && !slices.Contains(writers, id) {
			writers = append(writers, id)
		}
	}
	slices.Sort(soots[len(s.static.Soots):])
	s.b.Soots, s.b.Writers = soots, writers
}

// admitted reports whether machine credential host may act as soot through
// an admission (static allowlists are checked by the caller).
func (s *service) admitted(ctx context.Context, soot, host string) (bool, error) {
	var stored string
	err := s.db.view(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT host FROM `+databaseSchema+`.admissions WHERE soot = $1`, soot).Scan(&stored)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return stored == host, err
}

// admittedLevels maps each admitted (not config-bound) Soot to its level, so
// Nest can tell a Soot whose pool is on but not yet admitted.
func (s *service) admittedLevels(ctx context.Context) map[string]string {
	out := map[string]string{}
	for id, a := range s.admissions(ctx) {
		out[id] = a.Level
	}
	return out
}

func (s *service) manageAdmission(ctx context.Context, in manageInput) (any, error) {
	if in.Pool != "" || in.Group != "" || in.Name != "" || in.Parent != nil || in.Inherit != nil || in.Scope != "" || in.Subject != "" || in.Generation != "" || in.ExpectedPolicyRevision != nil {
		return nil, inputError{in.Action + " takes only soot, host, level and request_id"}
	}
	if !identifier.MatchString(in.Soot) || !identifier.MatchString(in.RequestID) {
		return nil, inputError{in.Action + " requires a Soot id and request_id"}
	}
	// A person admits, never a model: a manager Soot's own tool call must not
	// widen who may read the pool (same rule as service configuration).
	if !s.human || !s.manager() {
		return nil, inputError{"only a person, through a host manager of this data service in Nest, admits or dismisses Soots"}
	}
	if slices.Contains(s.static.Soots, in.Soot) {
		if in.Action == "dismiss" {
			return nil, inputError{fmt.Sprintf("%s is bound in the service config; remove it there", in.Soot)}
		}
		return map[string]any{"soot": in.Soot, "admitted": true, "bound": "config"}, nil
	}
	if in.Action == "dismiss" {
		if in.Level != "" || in.Host != "" {
			return nil, inputError{"dismiss takes only soot and request_id"}
		}
		err := s.db.update(ctx, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `DELETE FROM `+databaseSchema+`.admissions WHERE soot = $1`, in.Soot)
			return err
		})
		s.withAdmitted(ctx)
		return map[string]any{"soot": in.Soot, "admitted": false}, err
	}
	level := in.Level
	if level == "" {
		level = "read"
	}
	if level != "read" && level != "write" {
		return nil, inputError{"admit level is read or write"}
	}
	host := in.Host
	switch {
	case len(s.hosts) == 0 && host != "":
		return nil, inputError{"this data service has no machine credentials; omit host"}
	case host == "" && len(s.hosts) == 1:
		host = s.hosts[0]
	case host == "" && len(s.hosts) > 1:
		return nil, inputError{fmt.Sprintf("name the machine that runs %s: host is one of %v", in.Soot, s.hosts)}
	case host != "" && !slices.Contains(s.hosts, host):
		return nil, inputError{fmt.Sprintf("unknown host %s; host is one of %v", host, s.hosts)}
	}
	err := s.db.update(ctx, func(tx pgx.Tx) error {
		var existing bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM `+databaseSchema+`.admissions WHERE soot = $1)`, in.Soot).Scan(&existing); err != nil {
			return err
		}
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+databaseSchema+`.admissions`).Scan(&count); err != nil {
			return err
		}
		if !existing && len(s.static.Soots)+count >= maxBound {
			return inputError{fmt.Sprintf("this data service already binds %d Soots", maxBound)}
		}
		_, err := tx.Exec(ctx, `INSERT INTO `+databaseSchema+`.admissions (soot, host, level, by, at) VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (soot) DO UPDATE SET host = EXCLUDED.host, level = EXCLUDED.level, by = EXCLUDED.by, at = EXCLUDED.at`,
			in.Soot, host, level, s.actor, time.Now().UTC())
		return err
	})
	var invalid inputError
	if errors.As(err, &invalid) {
		return nil, invalid
	}
	s.withAdmitted(ctx)
	return map[string]any{"soot": in.Soot, "admitted": true, "level": level, "host": host}, err
}
