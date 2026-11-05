# 013 — Opt-in host-managed design confirmation

Design confirmation is **not universally required**. Existing tickets without
`ticket.designApproval.required === true` keep their previous behavior. This is
a narrowly scoped design gate, not a generic approval platform or admission
assessment.

## Trusted management contract and signature

Management routes (independent of `/validation` and `/review`):

- `GET tickets/:id/design`: current `designApproval`, or `null`.
- `PUT tickets/:id/design`: strict `{ required: true, scope: string,
  documentPath: string }`, or `{ required: false }`. Scope must be explicit and
  nonempty. `documentPath` is a portable workspace-relative file path; absolute
  paths, traversal, backslashes, links/junctions in any component, and hard-linked
  documents are rejected. The document must already exist in the ticket workspace.
- `POST tickets/:id/design`: strict `{ assignmentId, operatorId }`. Only the host
  reads and hashes current document bytes. The caller cannot supply a digest,
  signature, approval flag or timestamp. Pending assignments can be approved:
  approval must precede their launch.

`Engine.configureDesign` and `Engine.approveDesign` are management-only role
methods. No worker approval tool is added. `operatorId` and
`recordedBy: management-operator` are trusted operator-attested **workflow
identity**, not OS authentication, independent proof of a human, or a new HTTP
security boundary. Deployment access control must protect management routes.

The host records SHA-256 document digest, scope, document relative path,
canonical workspace, ticket ID, current assignment ID, contract revision,
operator label and time. A contract replacement clears the old signature.
Changing design bytes or scope, or replacing the assignment, requires a fresh
operator signature. An unreadable, missing or linked design document fails
closed. State is serialized in the existing Ticket aggregate through both memory
and generic SQLite persistence; no separate approval database is used.

## Lifecycle boundaries

Ticket creation normally plans an assignment before an operator configures the
contract. Therefore checking ticket creation alone is insufficient. The shared
`assertTicketDesignApproved` guard is called in real executor launch before any
workspace preparation/session creation, rechecked across asynchronous launch
boundaries and immediately before worker delivery, and called again by
`Assignments.started`. The guard reads current persisted ticket state rather
than trusting the queued launch's snapshot.

Unapproved launches use the existing durable effect queue's `Later` state: the
assignment stays pending, with no failed report or replacement assignment. Approval
requeues that same assignment immediately. Running workers' new input deliveries
also check the gate before session creation and at the final prompt authorization
callback; inputs remain undelivered while blocked. A transient-error retry timer
blocked by design confirmation becomes one durable text input, not an unbounded
retry timer; approval wakes its delivery on the same assignment.

For tasks whose necessity is known before execution, configure the opt-in contract
before launch (for example while processing is paused, or via trusted ticket
preparation). Acceptance otherwise queues execution immediately; this gate does
not automatically infer design necessity from natural-language task content.

Enabling a gate after a worker has already begun cannot undo prior work. It
blocks subsequent assignment starts, managed input/retry continuations and acceptance/delivery. It does not cancel a turn already executing, retrospectively prevent earlier implementation, or isolate arbitrary external writes.

The shared completion guard `assertTicketValidated` checks design approval even
when strict tests and independent review are disabled. This covers ready reports,
completion/source-close handling and every delivery level through the existing
delivery gate. A close fact is retained and its design refusal stored as
`designApproval.blocked` rather than silently accepting it. Delivery grants also
bind design state, so changing a signature/contract requires a fresh delivery
grant. Existing grant digests remain compatible when no design state exists.

## Deliberately different from independent review

Design approval hashes **only the selected design document**. Editing unrelated
implementation or test source does not invalidate it. Independent review binds
the whole conservative workspace fingerprint and may become stale after those
same implementation edits. Neither approval substitutes for required tests,
visual evidence, independent review, environment ownership or delivery grants.

Local regression coverage: `tests/design-gate.spec.ts` exercises legacy tickets,
planned-start/real-launch rejection before approval, successful approval, source
edit stability, document-change rejection, scope/assignment re-signing, strict
schemas, link rejection, SQLite reopen/revalidation, real durable launch-effect
resumption without assignment replacement, running-input deferral and bounded
transient-timer deferral. Tests create temporary
workspaces only; no editor, live host, push or release is performed.
