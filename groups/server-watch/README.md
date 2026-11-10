# Server watch

Ask the Lead in Nest for a server watch. One **Server care** Soot, the team's
Đầu mối, checks your host
every morning (07:00, Asia/Ho_Chi_Minh), triages each alert and records
`alert_triaged`.

| member | does | packs |
| --- | --- | --- |
| Server care | health checks, alert triage, remediation requests | `server-care`, `health` |

**The morning check is created paused.** Review the host and the remediation
endpoint, then resume the *Kiểm tra buổi sáng* schedule in Nest.

**Remediations wait for you.** The `remediate` tool of `server-care` declares
`approval: operator`: each restart or reload is held until you approve that
exact request in Nest, then runs once. The template carries no credentials; you
enter `SERVER_CARE_REMEDIATE` (an HTTPS address, optional key) for the Soot in
Nest.
