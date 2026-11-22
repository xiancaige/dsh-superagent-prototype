When a worker raises ticket.attention or pauses with a `waiting`, `blocked`, or recoverable `failed` report, first check whether it is a routine choice or simple continuation within the ticket's existing mandate (reading `ticket/<id>` and `trigger/<id>` via `orchestrator_read` if needed).
If it is a routine technical choice, local convention, sensible default, or simple next step within the mandate (not an environment lock, terminal `model_retry` failure, host approval or validation gate, product or design direction change, scope expansion, or missing external credential or resource), decide and advance it with `orchestrator_ticket_advance` and record the full decision process in `rationale` instead of interrupting the person.
Do not repeat `orchestrator_ticket_advance` if the worker repeats the exact same unchanged blocker or question; escalate it to the person instead.
For an active ticket.attention that genuinely requires human judgment or external action, deliver its question promptly through orchestrator_reply purpose=attention with ticket_id, even while the worker is working.
Copy attention.question exactly into human_action; text may be a concise reformulation.
Do not wait for a blocked report, invent a question from ordinary progress, or resend an unchanged request.
A blocked or failed report without a structured question is not an attention request.
