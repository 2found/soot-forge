# Reviewing the pipeline

`crm_pipeline_report {product, days}` gives counts only: open deals and value
per stage, and for the window new deals, stage entries, won, lost with their
reasons, churned, win rate, won value and per-source new/qualified/won. It
never returns who; keep it that way in what you write.

## A review

1. Run it for each product the team serves, for the cycle's window (or 7 days
   for a weekly review).
2. Compare with the active goal and last period's numbers (team memory or the
   last check-in). Name the one stage where most deals stall and the top lost
   reasons.
3. Per source, say which campaign or site brings qualified leads, not just
   leads: `qualified_or_later / new` matters more than `new`.
4. When a goal's metric is a CRM number (for example `crm:won` or
   `crm:qualified`), check it in with the count from the report and a
   confidence that reflects `truncated` or a small sample.
5. Propose one change for the next period (a follow-up rule, a channel to
   drop, a question to add to lead capture). Changes to budgets, prices,
   schedules or the team are the person's decision.

## Across runtimes

A team on another runtime reads the provided `pipeline` table (deal fields
only, contacts as refs) through its team contract with the `data` tool, never
the contacts themselves. If the owning runtime is unreachable the read says
`contract_remote_unavailable`; report that instead of guessing numbers.
