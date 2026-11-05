# Strict test acceptance (phase 2 A)

Opt-in host-managed workflow validation, not a new ticket lifecycle. Historical tickets without `validation.enabled` retain their existing behavior and are **not** described as strictly validated.

## Operator management

Use the existing loopback management API (`/orchestrator/api`, normal same-origin management headers):

- `PUT tickets/:id/validation`, body `{ "enabled": true }`: enable strict acceptance without a contract (completion remains blocked).
- The same PUT with `contract: { adapter: "python-unittest", executable: "<absolute installed Python executable>", workspace: "<absolute ticket execution directory>", requiredTestIds: ["test_example.Example.test_case"], timeoutMs: 120000 }`: configure/replace the contract. The host generates a fresh revision and removes prior evidence. There is deliberately no disable operation or worker configuration tool.
- `GET tickets/:id/validation`: inspect the persisted contract, running marker and last real execution evidence.

Configure only after the workspace exists. Executable and workspace paths must be absolute, real and link-free. The executable must be trusted installed Python, not a script supplied by the worker. The worker calls `orchestrator_run_tests` with **no arguments**. Commands, required case IDs and pass/fail counts cannot be supplied through that tool. Adapters are explicitly selected by the trusted contract; unsupported adapters (including CQTest) are rejected, not inferred from text output. The Node adapter and its test-ID format are described below.

## Node test adapter

Set `adapter: "node-test"` and `executable` to an absolute trusted installed Node executable outside the workspace. The host recursively discovers only `*.test.mjs`, `*.test.cjs` and `*.test.js` (with the same generated-directory exclusions as fingerprints). TypeScript transpilation and arbitrary command arguments are not accepted.

Required IDs use the canonical form `relative/file.test.mjs::["suite name","test name"]`: a workspace-relative forward-slash filename plus a JSON array of the exact nesting names. For example, `answer.test.mjs::["returns 42"]` identifies a top-level case. This avoids conflating nested names containing spaces. Missing or duplicate IDs cannot pass.

A fixed host-owned runner outside the workspace consumes `node:test` structured events. Test stdout/stderr is drained only for the output bound; TAP or printed success text never creates evidence. The child environment removes `NODE_OPTIONS`, `NODE_PATH` and `NODE_TEST_CONTEXT` without changing the host environment. The shared execution timeout, cancellation, process-tree cleanup, executable digest, workspace fingerprints and ticket/assignment/revision binding still apply. Zero cases, failed/cancelled/skipped/todo cases, missing completion or missing required cases fail closed. This is a Node built-in test adapter, not a Vitest/Jest/CQTest parser.

## Evidence and completion

The host runs a fixed Python `unittest` discovery adapter (`test*.py`, workspace as top-level directory), with isolated startup and bytecode disabled. It captures a structured report in a unique temporary directory outside the workspace, not arbitrary stdout/stderr. Passing requires an exit code of zero, a completed report, positive case count, all cases successful, every required case present, and no failures, errors, skips, expected failures or unexpected successes. Standard-library-only tests work with `-I -S`; site-packages are intentionally unavailable in this initial adapter.

Contract/evidence live in the existing serialized Ticket aggregate and SQLite transaction/recovery path. Evidence binds ticket ID, current assignment ID, canonical workspace, contract revision/digest and before/after content fingerprints. Every ready report, every common successful end (`completed`, `merged`, `closed`, including thread closure and dropped-to-merged), and every `result` reply rechecks the same evidence and current content. Worker-supplied report summaries/counts never create evidence. A failed or running newer test attempt removes the old green evidence. Ordinary dropped/stopped/failed work stays non-successful; a strict dropped ticket cannot publish a result without validation.

Fingerprints hash every file name, directory and file content, including new/deleted source and tests that an `htmlcov` or report-looking directory may hold. The only exclusions are `.git`, `node_modules`, Python/tool caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`), `.coverage*` files and `.dsh/home`. No worker-controlled glob/exclusion list exists. Symbolic links/junctions and nonregular files are rejected rather than traversed. Reports are written to a unique temporary directory outside the workspace and never enter the fingerprint. A trusted Python executable outside the workspace is bound by its digest. Because Python tests are real code, a test that starts a detached background writer in an excluded directory can still change files after the run; the written report is outside that set.

Restored evidence is checked again against disk. A run leaves a persisted running marker while it executes and cannot pass; stop, retry, assignment replacement and host lifetime abort the process tree, and the run returns only after bounded process-tree termination. Operator reconfiguration is refused while this host runs tests but replaces the contract (clearing the marker and prior evidence) after a crash. A new assignment cannot use an old assignment's evidence.

## Explicit security and delivery limits

This is a trusted operator API boundary and workflow correctness gate, **not isolation against a malicious process running as the same OS user**. Host/Origin/header checks do not prevent a worker using shell HTTP, editing SQLite/plugin files, replacing the Python executable, monkeypatching unittest from tests, or racing filesystem checks. Fingerprints observe before/after/current content; they do not detect modification then restoration between observations. Tests execute code under the host user, not in a new OS sandbox. No claim of immutable evidence against that user is made. Review the contract and test semantics independently; a fingerprint does not prove assertions are meaningful.

Phase B visual evidence, C exclusive resources and D release authorization have separate contracts and evidence; this page documents test acceptance only. Source tests and builds do not by themselves prove the currently running GUI has loaded a change. Runtime restart/loading and a real enabled-ticket smoke test remain separate acceptance steps.
