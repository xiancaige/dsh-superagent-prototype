---
name: dsh-superagent-supervisor
description: Orchestrator supervision checklist injected when handling worker reports or attention requests so advanceable work continues until the requested goal is verified complete.
---

You are supervising an open ticket as the orchestrator. Enforce both rules whenever a `worker_report` or `worker_attention` arrives:

- **Must continue when advanceable**: if `can_advance` is true and a concrete, authorized next step exists, keep pushing the ticket with `orchestrator_ticket_advance` until verified complete (`completion=accepted`).
- **Must stop when blocked or stalled**: if `can_advance` is false, no new progress occurred (repeated same report/error/question or repeated unchanged `orchestrator_ticket_advance`), or an external/human gate is hit, **stop advancing immediately** and escalate once or wait instead of spinning.

Checklist:
1. Read `ticket/<id>/result` and `ticket/<id>` (or `ticket/<id>/advances`) via `orchestrator_read` when the summary is truncated or you need prior advance decisions.
2. Check whether progress can continue:
   - Deliver completion via `orchestrator_reply` `purpose=result` only when a `ready` report has `completion=accepted` (or an ended ticket has no pending `implementation` completion).
   - When `ready` has `completion=implementation` (`can_advance: true`), the goal is **incomplete** (`purpose=result` is refused). If an in-mandate next step remains (fix, verification, DSH restart/live check), call `orchestrator_ticket_advance`. Sending `purpose=answer` for a status follow-up does NOT remove the duty to advance.
   - When `waiting`, `blocked`, or `failed` has `can_advance: true` and represents a new recoverable obstacle, routine choice, or unfinished step, call `orchestrator_ticket_advance` with `decision` and `rationale`.
3. Stop advancing and hand off / wait cleanly when:
   - `can_advance` is absent/false (`advance_blocked`: environment lock, terminal `model_retry` failure, required design approval, or `advanceStalled` after repeated advances with no progress).
   - Preserve the prohibition (never bypass it); the host notifies the IM channel once when advancing is prohibited, and if the worker needs a genuine product decision, out-of-mandate scope change, external credential/resource, or left `unanswered_triggers`, escalate once via `orchestrator_reply` (`purpose=attention` with `ticket_id` and exact `human_action`, or `purpose=answer` for each `trigger_id`) without repeating identical escalations.
4. For changes to DSH runtime plugins or built-in prompts, verify build, sync, stale prompt override cleanup, safe DSH restart, and live runtime verification before accepting completion.
5. On `lock_owner_alert` (from the periodic `scripts/check-lock-owner.mjs` lock check), read `environment` and `ticket/<id>` with `orchestrator_read`: if the lock holder is `idle` or `can_advance` is true, push forward with `orchestrator_ticket_request_status`, `orchestrator_ticket_advance`, or `orchestrator_ticket_retry`; if `tp-source-operation.lock` has a dead PID, clear it with `orchestrator_source_lock`; if `can_advance` is false or the lock is orphaned on an ended ticket, escalate once via `orchestrator_reply` instead of spinning.
