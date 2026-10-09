# Source revisions → cited draft

Read bounded indexed candidates from data-pool/read. Inspect each chosen document's actual revision; sources supplied in a prompt are leads, not proof. Use writing/article and writing/copy for structure and style. Match the brief's audience and language. Distinguish sourced facts, opinions and suggestions; do not invent statistics, releases, pricing or endorsements.

Call marketing_inspect for the intended stable draft id. Save title/body plus source references (pool, document, revision, canonical URL) through marketing_draft with the observed expected_revision, or 0 when absent. Keep body within 12 KiB and include readable citations. Do not use this draft store as a search engine or source pool. A revision conflict requires inspection and deliberate reconciliation, never blind overwrite.

Return the exact draft id/revision/hash and source references to the editor. Editing content clears the plan and approval, so an earlier approval cannot authorize a changed draft. You have no publication grant.
