# Inspect readiness

Use `run_operation({"operation":"health_probe"})` for the configured endpoint.
A 2xx response means this endpoint is ready; a non-2xx or unreachable result is
an observation to record, not proof of the underlying cause. A 200 does not prove
database writes work. The tool returns HTTP status and latency only.
An operation is journaled once per event. Calling it again replays that result,
not a fresh probe. After repair use the executor's readiness postcondition;
otherwise wait for a new watch/event to obtain fresh evidence.
