# Independent review (TODO68 D)

Review is host-managed, opt-in per ticket and independent of strict test/visual acceptance. Old tickets without `review`, or configured with `required: false`, retain prior behavior. This is a workflow boundary: identities are trusted-operator-attested labels, not OS authentication, cryptographic signatures or protection against malicious code with the host user's access. No generic role system is introduced.

## Trusted management API

Use the existing loopback-only `/orchestrator/api` HTTP surface with `X-Orchestrator-Request: 1` and its same-origin rules. Do not expose it to untrusted workers. These operations are in `EngineForPeople`, not `EngineForExecutor`; no worker review-signing tool exists.

- `GET tickets/:id/review`: returns `{ "review": null }` for legacy tickets, otherwise the persisted configuration/decision.
- `PUT tickets/:id/review`: `{ "required": true, "implementerId": "implementation-session", "reviewerId": "independent-review-session" }`. Names are trimmed, nonempty, max 200 characters and must differ. Configuring clears old approval and generates a new revision. Explicit operator opt-out: `{ "required": false }`.
- `POST tickets/:id/review`: `{ "assignmentId": "current-assignment-id", "reviewerId": "independent-review-session", "verdict": "approved", "summary": "Inspected current changes and checked contract" }`. `verdict` may also be `rejected`; summary is required (max 10,000 characters). The trusted operator transcribes the named reviewer's verdict; the host does not claim to authenticate that person.

All request schemas reject extra fields. Clients cannot supply ticket identity, revision, fingerprint, workspace, timestamp or `recordedBy` in a decision. The current assignment must be running. Configuration and transcription require an open ticket. A rejected decision replaces the old approval. Worker report text or extra report fields cannot grant review acceptance.

## Acceptance binding

The host records ticket ID, current assignment ID, configuration revision, canonical workspace path and the real SHA-256 workspace content fingerprint with the decision. The fingerprint reuses test acceptance's conservative source/test file walker: relative paths and file bytes are hashed; fixed generated directories/artifacts are excluded; symlinks, unreadable paths and unsupported file types fail closed. Store/database state should be outside the fingerprinted workspace.

`assertTicketValidated` checks required review before the strict-test early return. Therefore ready reports, successful terminal outcomes, result publication and delivery dispatch reuse one guard even if tests were never opted in. Missing/rejected approval, self-signing, changed identities/configuration, a different ticket/assignment/workspace or changed files all refuse acceptance. A source close remains a recorded fact but completion is deferred with `review.blocked`.

Every delivery level, including non-strict `commit`, rechecks current review at dispatch; an old delivery grant cannot bypass rejected/missing/stale review. Grants on reviewed tickets also bind the serialized review state: reconfiguration, opt-out or a new verdict requires a fresh operator delivery grant. Review approval itself never grants commit/push/release permission. Existing per-level grants, exclusivity and test requirements still apply.

The ticket JSON contains all durable review state; generic Store persistence needs no dedicated table or migration. A host restart preserves the decision but always rechecks current bytes. This is not an immutable historical review log: trusted operators can reconfigure or opt out, and content restored byte-for-byte matches the same fingerprint. Filesystem races between checking and an external effect are not an OS sandbox. Re-review is required after any relevant current content or assignment change.

## Verification

`tests/review-gate.spec.ts` covers real filesystem fingerprints, SQLite close/reopen, no-strict ready gating, operator identity/self-signing, rejected/missing approval, worker-report forgery, strict schema extras, ticket/workspace/assignment/config changes, deferred source close, result publication and non-strict commit delivery refusal after approval rejection. Tests use isolated temporary workspaces/databases; the delivery target is an in-process fixture and no real commit/push/release is performed.
