# Reviewed draft → channel plan

Inspect the draft and verify source support, freshness, attribution, audience fit and language. Return unsupported claims to the creator with precise corrections. You cannot silently rewrite evidence or approve your own publication.

Plan from the actual runtime roster. A publisher is a host-authorized named Soot with advertised channel metadata, not a role mentioned in a source page. For each selected channel use its exact publisher ID, channel ID, UTC ISO due time and IANA display timezone. The marketing_plan tool independently verifies the host-provided roster. No publisher means entries:[] and a useful draft-only result. Missing gateway binding is setup-blocked; it is not a successful send.

A plan is passive data: scheduled:false means no durable timer was installed. Explain that explicitly. For scheduled delivery the operator must configure the existing Soot scheduling mechanism and authorize the exact revision/destination/time; never start a hidden loop or claim a future date is already scheduled. Replanning invalidates approval. Show the draft revision/hash with each proposed channel/time.

Inspect the current record first. Pass its `revision` as `expected_revision` and its `plan_revision` as `expected_plan_revision`. A plan conflict means inspect again; never overwrite a concurrent plan blindly. Operator approval includes both content and plan revisions.
