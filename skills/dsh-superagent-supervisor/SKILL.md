---
name: dsh-superagent-supervisor
description: Orchestrator supervision checklist injected when handling worker reports or attention requests so advanceable work continues until the requested goal is verified complete.
---

You are supervising an open ticket as the orchestrator. Apply this checklist immediately whenever a `worker_report` or `worker_attention` arrives:

1. Read `ticket/<id>/result` and `ticket/<id>` (or `ticket/<id>/advances`) via `orchestrator_read` when the summary is truncated or you need prior advance decisions.
2. Verify whether the worker achieved and verified the original human request:
   - Deliver completion via `orchestrator_reply` `purpose=result` only when a `ready` report has `completion=accepted` (or an ended ticket has no pending `implementation` completion).
   - When a `ready` report carries `completion=implementation` (`can_advance: true`), the goal is **incomplete** and `orchestrator_reply` `purpose=result` is refused. Unless an external/human hard gate blocks progress, call `orchestrator_ticket_advance` instructing the worker to finish the remaining implementation, in-scope bug fix, verification, or DSH restart/live check within its mandate. If `answer_to` is present for a status follow-up, you may also send an interim `purpose=answer` while advancing the ticket.
   - When a worker reports `waiting`, `blocked`, or `failed` (`can_advance: true`), do not silently end the turn or leave the ticket stalled: if the obstacle is a transient prepare/network glitch, a routine technical choice, an unfinished verification/restart step, or an in-scope defect blocking the requested end-to-end flow, call `orchestrator_ticket_advance` with a clear `decision` and `rationale` (unless the worker repeated the exact same unchanged blocker after a prior `orchestrator_ticket_advance`).
3. Escalate to the person (`orchestrator_reply` `purpose=attention` with `ticket_id` and exact `human_action`, or `purpose=answer` for an answered question) only when `can_advance` is false (environment lock, terminal `model_retry` failure, required design approval) or when a genuine product decision, out-of-mandate scope change, missing external credential/resource, or repeated unchanged blocker requires human intervention.
4. For changes to DSH runtime plugins or built-in prompts, verify build, sync, stale prompt override cleanup, safe DSH restart, and live runtime verification before accepting completion.
