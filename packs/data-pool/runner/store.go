package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

type pool struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	CreatedAt      string `json:"created_at"`
	Generation     string `json:"generation"`
	PolicyRevision uint64 `json:"policy_revision"`
	Parent         string `json:"parent,omitempty"`
	Inherit        bool   `json:"inherit"`
	// Scope declares the intended audience at creation: workspace (every bound
	// Soot), group (members of Subject), or own (the creating Soot). Realized
	// through grants, so later grant/revoke adjusts it like any other pool.
	Scope   string `json:"scope,omitempty"`
	Subject string `json:"subject,omitempty"`
}

type document struct {
	ID        string     `json:"id"`
	Title     string     `json:"title"`
	Source    string     `json:"source"`
	Tags      []string   `json:"tags"`
	SHA256    string     `json:"sha256"`
	Revision  int        `json:"revision"`
	UpdatedAt string     `json:"updated_at"`
	Writer    *actorRef  `json:"writer,omitempty"`
	Origin    *originRef `json:"origin,omitempty"`
}

type storedDocument struct {
	document
	Content     string `json:"content"`
	TitleNorm   string `json:"title_norm"`
	ContentNorm string `json:"content_norm"`
	Receipt     string `json:"receipt"`
}

type receipt struct {
	ID             string     `json:"request_id"`
	Owner          string     `json:"owner"`
	Pool           string     `json:"pool"`
	PoolGeneration string     `json:"pool_generation"`
	Action         string     `json:"action"`
	Fingerprint    string     `json:"fingerprint"`
	Status         string     `json:"status"`
	Task           *int64     `json:"task,omitempty"`
	Document       *document  `json:"document,omitempty"`
	Reason         string     `json:"reason,omitempty"`
	NewDocument    bool       `json:"new_document,omitempty"`
	Actor          *actorRef  `json:"actor,omitempty"`
	Replay         bool       `json:"replay,omitempty"`
	Origin         *originRef `json:"origin,omitempty"`
}

type service struct {
	b          binding
	actor      string
	db         *bolt.DB
	backend    *backend
	fetch      func(string) (string, error)
	human      bool
	origin     *originRef
	membership []string
	groupsFor  string
	perms      map[string]string
}

func hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func openService(b binding, actor string) (*service, error) {
	if err := os.MkdirAll(b.StateDir, 0700); err != nil {
		return nil, errors.New("cannot open plugin state")
	}
	file := filepath.Join(b.StateDir, "policy.db")
	db, err := bolt.Open(file, 0600, &bolt.Options{Timeout: 3 * time.Second})
	if err != nil {
		return nil, errors.New("plugin state unavailable or busy; inspect the original request before retrying a mutation")
	}
	s := &service{b: b, actor: actor, db: db, backend: newBackend(b), membership: actorGroups(b, actor), groupsFor: actor, perms: map[string]string{}}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range []string{"config", "pools", "grants", "by-soot", "documents", "receipts", "fences", "activity", "children", "effective", "by-group", "references"} {
			if _, e := tx.CreateBucketIfNotExists([]byte(name)); e != nil {
				return e
			}
		}
		c := tx.Bucket([]byte("config"))
		identity := b.Namespace + "\n" + b.Endpoint
		if old := c.Get([]byte("identity")); old != nil && string(old) != identity {
			return errors.New("state is already bound to another namespace or backend")
		}
		if err := c.Put([]byte("identity"), []byte(identity)); err != nil {
			return err
		}
		return s.initializeCollections(tx)
	})
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *service) close()                 { s.db.Close(); s.backend.client.CloseIdleConnections() }
func (s *service) manager() bool          { return slices.Contains(s.b.Managers, s.actor) }
func (s *service) index(id string) string { return "soot_" + hash(s.b.Namespace + "/" + id)[:32] }
func rank(level string) int {
	switch level {
	case "read":
		return 1
	case "write":
		return 2
	case "manage":
		return 3
	}
	return 0
}
func getJSON(b *bolt.Bucket, key string, out any) error {
	v := b.Get([]byte(key))
	if v == nil {
		return errors.New("not found")
	}
	return json.Unmarshal(v, out)
}
func putJSON(b *bolt.Bucket, key string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return b.Put([]byte(key), data)
}
func (s *service) allowed(tx *bolt.Tx, id, level string) bool {
	return rank(s.permission(tx, id)) >= rank(level) && rank(level) > 0
}
func (s *service) authorize(id, level string) error {
	return s.db.View(func(tx *bolt.Tx) error {
		if !s.allowed(tx, id, level) {
			// One answer for missing and forbidden, so it is no existence oracle,
			// but actionable: a model that guessed an ID must list or create one.
			return inputError{"collection " + safeID(id) + " is not available to this Soot at " + level + " level (missing or not granted); list accessible collections with data-pool_pools without a pool argument, or create one with data-pool_manage pool_create if you manage pools"}
		}
		return nil
	})
}

func (s *service) poolGeneration(id string) (string, error) {
	var p pool
	err := s.db.View(func(tx *bolt.Tx) error { return getJSON(tx.Bucket([]byte("pools")), id, &p) })
	if err != nil || p.Generation == "" {
		return "", errors.New("pool identity unavailable")
	}
	return p.Generation, nil
}

// Host managers own the namespace's retained history. Delegated permissions
// apply only to the specific pool generation they currently manage/read.
func (s *service) authorizeReceipt(r receipt, level string) error {
	if s.manager() {
		return nil
	}
	return s.db.View(func(tx *bolt.Tx) error {
		var p pool
		if getJSON(tx.Bucket([]byte("pools")), r.Pool, &p) != nil || r.PoolGeneration == "" || p.Generation != r.PoolGeneration || !s.allowed(tx, r.Pool, level) {
			return errors.New("request unavailable")
		}
		return nil
	})
}
func docsBucket(tx *bolt.Tx, id string) *bolt.Bucket {
	return tx.Bucket([]byte("documents")).Bucket([]byte(id))
}
func (s *service) doc(id, docID string) (document, error) {
	var d document
	err := s.db.View(func(tx *bolt.Tx) error {
		b := docsBucket(tx, id)
		if b == nil {
			return errors.New("document unavailable")
		}
		if getJSON(b, docID, &d) != nil {
			return errors.New("document unavailable")
		}
		return nil
	})
	return d, err
}
func (s *service) requestKey(id string) string { return s.actor + "/" + id }
func (s *service) loadReceipt(id string) (receipt, error) {
	var r receipt
	err := s.db.View(func(tx *bolt.Tx) error { return getJSON(tx.Bucket([]byte("receipts")), s.requestKey(id), &r) })
	return r, err
}
func (s *service) saveReceipt(r receipt) error {
	return s.db.Update(func(tx *bolt.Tx) error { return putJSON(tx.Bucket([]byte("receipts")), s.requestKey(r.ID), r) })
}
func fenceKey(r receipt) string {
	if r.Document != nil {
		return r.Pool + "/" + r.Document.ID
	}
	return r.Pool + "/*"
}
func ensureUnfenced(tx *bolt.Tx, id, docID string) error {
	b := tx.Bucket([]byte("fences"))
	if b.Get([]byte(id+"/*")) != nil {
		return errors.New("pool has a pending or uncertain effect; inspect its request status")
	}
	if docID == "" {
		k, _ := b.Cursor().Seek([]byte(id + "/"))
		if len(k) >= len(id)+1 && string(k[:len(id)+1]) == id+"/" {
			return errors.New("pool has a pending or uncertain effect; inspect its request status")
		}
	} else if b.Get([]byte(id+"/"+docID)) != nil {
		return errors.New("document has a pending or uncertain effect; inspect its request status")
	}
	return nil
}
func (s *service) begin(r receipt) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		id := ""
		if r.Document != nil {
			id = r.Document.ID
		}
		if err := ensureUnfenced(tx, r.Pool, id); err != nil {
			return err
		}
		if r.NewDocument {
			pending := pendingCount(tx, r.Pool)
			if docsBucket(tx, r.Pool).Sequence()+pending >= maxDocuments {
				return errors.New("document limit reached")
			}
			if err := putJSON(tx.Bucket([]byte("config")), "pending/"+r.Pool, pending+1); err != nil {
				return err
			}
		}
		if err := putJSON(tx.Bucket([]byte("receipts")), s.requestKey(r.ID), r); err != nil {
			return err
		}
		if err := appendActivity(tx, activityForReceipt(r)); err != nil {
			return err
		}
		return tx.Bucket([]byte("fences")).Put([]byte(fenceKey(r)), []byte(s.requestKey(r.ID)))
	})
}

func pendingCount(tx *bolt.Tx, pool string) uint64 {
	var count uint64
	_ = getJSON(tx.Bucket([]byte("config")), "pending/"+pool, &count)
	return count
}

func (s *service) finish(r receipt, status string) (receipt, error) {
	r.Status = status
	err := s.db.Update(func(tx *bolt.Tx) error {
		if r.NewDocument {
			pending := pendingCount(tx, r.Pool)
			if pending == 0 {
				return errors.New("pending document state mismatch")
			}
			if err := putJSON(tx.Bucket([]byte("config")), "pending/"+r.Pool, pending-1); err != nil {
				return err
			}
		}
		if status == "succeeded" {
			if err := appendReference(tx, r.Origin, r.Pool, r.PoolGeneration, r.Action, r.Document); err != nil {
				return err
			}
			switch r.Action {
			case "upsert", "append":
				b := docsBucket(tx, r.Pool)
				if b == nil {
					return errors.New("pool state unavailable")
				}
				if b.Get([]byte(r.Document.ID)) == nil {
					if err := b.SetSequence(b.Sequence() + 1); err != nil {
						return err
					}
				}
				if err := putJSON(b, r.Document.ID, r.Document); err != nil {
					return err
				}
			case "remove":
				b := docsBucket(tx, r.Pool)
				if b.Get([]byte(r.Document.ID)) != nil {
					if err := b.SetSequence(b.Sequence() - 1); err != nil {
						return err
					}
				}
				if err := b.Delete([]byte(r.Document.ID)); err != nil {
					return err
				}
			case "pool_remove":
				if err := s.removeCollectionIndexes(tx, r.Pool); err != nil {
					return err
				}
				if tx.Bucket([]byte("activity")).Bucket([]byte(r.Pool)) != nil {
					if err := tx.Bucket([]byte("activity")).DeleteBucket([]byte(r.Pool)); err != nil {
						return err
					}
				}
				if err := tx.Bucket([]byte("config")).Delete([]byte("pending/" + r.Pool)); err != nil {
					return err
				}
				if err := tx.Bucket([]byte("documents")).DeleteBucket([]byte(r.Pool)); err != nil {
					return err
				}
				if err := tx.Bucket([]byte("pools")).Delete([]byte(r.Pool)); err != nil {
					return err
				}
				b := tx.Bucket([]byte("pools"))
				if err := b.SetSequence(b.Sequence() - 1); err != nil {
					return err
				}
				// Clear stored pool membership, including identities the operator
				// has since removed from the binding. Pool-ID reuse must start private.
				prefix := r.Pool + "/"
				c := tx.Bucket([]byte("grants")).Cursor()
				for k, _ := c.Seek([]byte(prefix)); k != nil && strings.HasPrefix(string(k), prefix); k, _ = c.Next() {
					soot := strings.TrimPrefix(string(k), prefix)
					if err := tx.Bucket([]byte("by-soot")).Delete([]byte(soot + "/" + r.Pool)); err != nil {
						return err
					}
					if err := c.Delete(); err != nil {
						return err
					}
				}
			}
		}
		if err := tx.Bucket([]byte("fences")).Delete([]byte(fenceKey(r))); err != nil {
			return err
		}
		// Removing a pool removes its activity with its data. The durable removal
		// receipt remains available to host managers; ID reuse starts a fresh pool.
		if r.Action != "pool_remove" {
			if err := appendActivity(tx, activityForReceipt(r)); err != nil {
				return err
			}
		}
		return putJSON(tx.Bucket([]byte("receipts")), s.requestKey(r.ID), r)
	})
	return r, err
}

func (s *service) replay(id, fingerprint string) (receipt, bool, error) {
	r, err := s.loadReceipt(id)
	if err != nil && err.Error() == "not found" {
		return r, false, nil
	}
	if err != nil {
		return r, true, errors.New("request state unavailable")
	}
	if r.Fingerprint != fingerprint {
		return r, true, errors.New("request_id already used with different input")
	}
	if r.Action == "pool_create" || r.Action == "pool_remove" {
		if s.authorizeReceipt(r, "manage") != nil {
			return r, true, errors.New("access denied")
		}
	} else if err := s.authorizeReceipt(r, map[string]string{"upsert": "write", "append": "write", "remove": "write", "grant": "manage", "revoke": "manage", "pool_update": "manage"}[r.Action]); err != nil {
		return r, true, err
	}
	r.Replay = true
	return r, true, nil
}

func receiptToken(s *service, r receipt) string {
	return hash(fmt.Sprintf("%s/%s/%s/%s/%s", s.b.Namespace, r.PoolGeneration, r.Owner, r.ID, r.Fingerprint))
}

func safeID(id string) string {
	if identifier.MatchString(id) {
		return id
	}
	return "(invalid ID)"
}
