1. Call run_operation with operation health_probe to inspect the configured readiness endpoint.
2. Read the result carefully: readiness does not prove every subsystem is healthy.
3. Use other operations only if the operator has granted them.
4. Report evidence and an actionable next step. Do not invent a repair or an automatic retry.
5. A case is optional. If a separate case pack is attached, create a record only when persistent tracking is useful.
