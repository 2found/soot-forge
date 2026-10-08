Cases are optional records, never the agent execution queue. Complete ordinary work directly.
When durable tracking is useful, call run_operation with operation casework_upsert and input as a JSON string containing title, summary and status (open or resolved).
Use casework_read to inspect the current conversation's record. A missing record is normal.
Use casework_handoff with input {"to":"human","summary":"evidence and next action"} to record human responsibility. It does not message anyone or invoke another agent.
Do not describe a case update as completion of the real-world work. A human-owned record requires operator intervention before an agent may update it again.
