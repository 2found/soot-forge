package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

var errConflict = errors.New("revision conflict: reload current data while preserving your draft")

// conflictError says which revision went stale; it still matches errConflict.
type conflictError struct{ detail string }

func (e conflictError) Error() string        { return "revision conflict: " + e.detail }
func (e conflictError) Is(target error) bool { return target == errConflict }

// All callers hold the namespace policy lock through execution/publication:
// a gateway holds its policy mutex; a local executable is the only process.
func (s *service) checkPolicyRevision(ctx context.Context, in manageInput) error {
	return s.db.view(ctx, func(tx pgx.Tx) error {
		var p pool
		var err error
		if p, err = s.poolByID(ctx, tx, in.Pool); err != nil {
			return err
		}
		if in.Generation != "" && in.Generation != p.Generation || in.ExpectedPolicyRevision != nil && *in.ExpectedPolicyRevision != p.PolicyRevision {
			return conflictError{fmt.Sprintf("collection %s changed since it was read; read it again and retry with a new request_id", in.Pool)}
		}
		return nil
	})
}

type interfaceInput struct {
	Kind  string          `json:"kind"`
	Input json.RawMessage `json:"input"`
}

func (s *service) view(ctx context.Context, raw json.RawMessage) (any, error) {
	// Empty probes are useful to generic tool-area discovery/availability checks.
	if string(raw) == "{}" {
		return s.overview(ctx), nil
	}
	var in interfaceInput
	if err := decodeStrict(raw, &in); err != nil {
		return nil, err
	}
	switch in.Kind {
	case "overview":
		var empty struct{}
		if err := decodeStrict(in.Input, &empty); err != nil {
			return nil, err
		}
		return s.overview(ctx), nil
	case "pools", "query", "status":
		return s.dispatch(ctx, in.Kind, in.Input)
	case "activity":
		var page activityInput
		if err := decodeStrict(in.Input, &page); err != nil {
			return nil, err
		}
		return s.activities(ctx, page)
	}
	return nil, errors.New("unsupported data-pool view")
}
func (s *service) overview(ctx context.Context) any {
	return map[string]any{"namespace": s.b.Namespace, "service_identity": hash(s.b.Namespace + "\n" + databaseIdentity(s.b.DatabaseURL)), "actor": s.actorReference(), "bound_soots": s.b.Soots, "admitted_soots": s.admittedLevels(ctx), "host_managers": s.b.Managers,
		"groups": s.b.Groups, "default_collection": s.b.Defaults[s.actor], "organization_version": 1,
		"limits": map[string]any{"collections": maxPools, "collection_depth": maxCollectionDepth, "reference_retention": referenceRetention, "page_size": 20, "inline_content_bytes": 12 << 10, "content_bytes": maxContent, "activity_retention": activityRetention}, "available": true}
}
func (s *service) action(ctx context.Context, raw json.RawMessage) (any, error) {
	var in interfaceInput
	if err := decodeStrict(raw, &in); err != nil {
		return nil, err
	}
	var result any
	var err error
	switch in.Kind {
	case "write":
		var input writeInput
		if err = decodeStrict(in.Input, &input); err != nil {
			break
		}
		// Generation proves the operator saw the current pool; append names its
		// own document, so the expected-document-revision check applies only to
		// actions that address an existing one.
		if input.Generation == "" || input.Action != "append" && input.ExpectedRevision == nil {
			err = errors.New("human writes require expected_revision and pool generation")
			break
		}
		result, err = s.write(ctx, input)
	case "manage":
		var input manageInput
		if err = decodeStrict(in.Input, &input); err != nil {
			break
		}
		// Admission is not a collection policy edit: no revision to guard.
		if input.Action != "pool_create" && input.Action != "admit" && input.Action != "dismiss" && (input.ExpectedPolicyRevision == nil || input.Generation == "") {
			err = errors.New("human management requires expected_policy_revision and pool generation")
			break
		}
		result, err = s.manage(ctx, input)
	default:
		err = errors.New("unsupported data-pool action")
	}
	if err != nil {
		if attempted, ok := result.(receipt); ok && attempted.ID != "" {
			// A local persistence failure after the transaction committed must
			// keep the original receipt visible. Never describe it as rejected.
			if saved, e := s.loadReceipt(ctx, attempted.Owner, attempted.ID); e == nil && saved.Fingerprint == attempted.Fingerprint {
				return saved, nil
			}
		}
		code := "rejected"
		if errors.Is(err, errConflict) {
			code = "conflict"
		}
		// These are Pack-owned validation errors, backend errors are sanitized.
		return map[string]any{"status": "error", "code": code, "message": err.Error()}, nil
	}
	return result, nil
}
