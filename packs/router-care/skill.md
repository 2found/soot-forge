# Interpret 9router maintenance observations

Use this skill when a maintenance event reports a changed release observation,
a failed rollout or a durable fence. Required context is the operator’s release
policy and an observation from the selected worker. An event is evidence to
inspect, not authorization to deploy.

## Obtain evidence

If `router-care_status` is granted, call it with `{}`. It reads only the host-bound
sanitized status file; never supply a path, URL, command or credential. If only
this guide is granted, use the observation already provided and state what is
missing. Do not request shell/file access merely to bypass an unavailable tool.

Successful output is `{status: {release_source, npm_package, phase, category,
current, latest, checked, digest}}`. `checked` is the time of the worker’s last
check, not a live health probe. Quote that timestamp with your conclusion. An
empty version, `0.0.0`, or a zero timestamp means the observation is unavailable;
do not report it as a deployed version. A digest identifies an image observation,
not proof that traffic reaches that image.

Tool errors are `{error: {code}}`:

- `binding_unavailable`: the host has not configured an absolute status-file path.
- `status_unavailable`: the selected file cannot be read. Ask the operator to check
  worker output and daemon read permissions; do not guess its contents.
- `invalid_status`: malformed, oversized or unsupported status. Retain the last
  verified observation and report that fresh evidence is unavailable.

An invocation failure means the tool did not complete; do not claim an observation.
Never infer success from an event admission receipt or a previously cached status.

## Interpret the worker’s result

The host chooses the release source, soak period, image provenance and retention
policy. Read `release_source`; do not substitute GitHub Releases, Docker `latest`
or the application banner. For the npm policy, `npm_package` and
`dist-tags.latest` select the version and `time[version]` supplies its publication
time. Stable numeric versions must pass the configured soak period and exceed
the observed current version. Eligibility is not a completed rollout.

| Category | Interpretation and next action |
| --- | --- |
| `current`, `release_soaking` | No eligible update yet; retain the observation and wait for the next configured check. |
| `release_source_behind` | Source version is older; do not suggest a downgrade. |
| `ineligible_release`, `unsupported_release_version` | Publication/version metadata cannot satisfy policy; investigate the selected source. |
| `release_image_unavailable`, `image_provenance_mismatch` | A verified versioned image is unavailable; do not use a different image authority. |
| `baseline_health_failed` | Existing health/version/authenticated-model evidence failed; do not describe a safe rollout. |
| `backup_capacity_reached` | Retention cap reached; an operator must review retained generations. |
| `interrupted_*`, `*_uncertain`, `post_promotion_*` | Durable human fence; reconcile recorded effects and actual serving state before any further action. |
| Other categories | Report the exact category and observed phase; consult the worker’s operator policy instead of inventing recovery. |

The consuming worker owns Docker inspection, image verification, stopped-data
copies, candidate gates, promotion and bounded rollback. Candidate checks do not
prove every upstream AI provider works. Once traffic may have written new data,
a timeout, crash or uncertain effect must not cause automatic old-data restoration
or replay. `blocked` and `rolled_back` phases require operator inspection; do not
clear a fence because a later health response looks good.

## Report and hand off

State the observation time, source, known current/latest versions, phase/category,
verified outcome and one concrete next action. Separate proposed actions from
completed effects. Never claim a deployment, ticket or notification without its
own receipt. A guide/status grant gives no Docker, shell, repair, timer or journal
mutation authority. Do not retry a rollout, restart the worker, delete retained
data or edit a journal in response to an event.

Keep credentials, environment dumps, database contents and raw command output out
of replies. Host deployment and reconciliation procedures belong to the
[historical consuming integration’s operator policy](https://github.com/2found/2agent/blob/5e5d79ceec019a3d1e68dd9eabe2a63024300c73/contrib/9router/docs/router-caretaker.md).

The example worker and installer have been removed from current Soot source. The linked policy is historical; the current host must provide its own worker and explicitly authorize its deployment policy.
