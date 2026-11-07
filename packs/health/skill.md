# Inspect readiness

Call `run_operation` with operation `health_probe`. It checks every endpoint the
operator configured and returns one line per endpoint: its name, the HTTP
status and the latency, or `unreachable`. You cannot choose the address; the
operator sets it.

- A 2xx status means that endpoint answers. It does not prove every subsystem
  works: a 200 from a health route does not prove database writes succeed.
- A non-2xx status, a slow answer or `unreachable` is an observation to
  report, not proof of its cause.
- One call per event is journaled; calling again in the same event replays
  that result. Fresh evidence needs a new event or the next scheduled check.
- Report evidence and an actionable next step. Do not invent a repair or retry
  on your own.
