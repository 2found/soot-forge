1. Call `run_operation` with operation `health_probe`. It checks every endpoint the operator configured and returns one line per endpoint.
2. Read the result carefully: readiness does not prove every subsystem is healthy.
3. Each endpoint that is not 2xx, is unreachable or is much slower than usual is one alert. Triage it from the evidence you have, and record one `alert_triaged` outcome when you finish it.
4. Use other tools only if the operator has granted them. A restart or reload is a `run_operation` call with operation `server-care_remediate`, which waits for an operator to approve it; call it only when the evidence points at that service.
5. Report evidence and an actionable next step. Do not invent a repair or an automatic retry.
6. A case is optional. If a separate case pack is attached, create a record only when persistent tracking is useful.
