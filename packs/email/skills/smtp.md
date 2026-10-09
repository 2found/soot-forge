Send email through the account the operator bound to this Soot. The tool
owns the server, credentials, sender identity and delivery journal — your
job is the content and reading the receipt honestly.

1. Compose the message: `to` (1-20 recipients, no cc/bcc — this capability
   is direct sends only), `subject`, and `text` and/or `html`. Write in the
   recipient's language. Never place secrets, internal URLs or another
   person's data in the body unless the mission requires it.
2. Attachments are artifact refs only (`attachments: [{"ref":"art_…"}]`) —
   never raw bytes. Create or fetch them through the artifact store first
   when granted; you cannot attach arbitrary host paths.
3. Give a stable `action_id` when the same logical email could be invoked
   twice (e.g. "report-daily-2026-10-06"). Without one the tool derives a
   payload hash — identical content dedups, changed content is a new send.
   Keep an explicit ID bound to the same payload/account. A changed intent or
   legacy/corrupt journal needs reconciliation, never a blind replacement.
4. READ THE RECEIPT — exit 0 does not prove the mail left:
   - `succeeded`: server accepted it (250). Not proof of inbox delivery.
   - `failed`: refused before any data was sent (auth, recipient, TLS).
     Safe to fix the cause and retry.
   - `unknown`: a send is active/interrupted, or connection was lost after the message bytes went out. The
     server may have it. DO NOT resend — report `unknown` to the operator
     and let them reconcile against the mail server or the durable
     journal. A second call with the same `action_id` returns `unknown`
     again, it does not resend.
   - `deduplicated: true`: this action already succeeded — no new mail
     was sent, that is correct behavior.
5. Headers are guarded: address, subject and names cannot inject headers;
   a rejected send is your input problem, not a server failure — fix it.
6. You do not choose the sender, server or credentials; they come from the
   operator's EMAIL_BINDING. If the mission needs a different sender, that
   is an operator change, not an input.
