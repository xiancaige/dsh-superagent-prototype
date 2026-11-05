# Strict test acceptance (phase 2 A)

Opt-in host-managed workflow validation, not a new ticket lifecycle. Historical tickets without `validation.enabled` retain their existing behavior and are **not** described as strictly validated.

## Operator management

Use the existing loopback management API (`/orchestrator/api`, normal same-origin management headers):

- `PUT tickets/:id/validation`, body `{ "enabled": true }`: enable strict acceptance without a contract (completion remains blocked).
- The same PUT with `contract: { adapter: "cqtest-report", executable: "<absolute trusted CQTest report validator>", workspace: "<absolute ticket execution directory>", requiredTestIds: ["TP.Editor.UiDsl.ApplyGateRejectsNonPatchable"], timeoutMs: 120000 }`: configure/replace the contract. The host generates a fresh revision and removes prior evidence. There is deliberately no disable operation or worker configuration tool.
- `GET tickets/:id/validation`: inspect the persisted contract, running marker and last real execution evidence.

Configure only after the workspace exists. Executable and workspace paths must be absolute, real and link-free. The executable must be a trusted validator outside the workspace, not a script supplied by the worker. The worker calls `orchestrator_run_tests` with **no arguments**. Commands, required case IDs and pass/fail counts cannot be supplied through that tool. The adapter is explicitly selected by the trusted contract and is not inferred from text output.

## CQTest adapter (the only adapter)

The project owns running Unreal: a person or worker runs `BuildScripts/run-cqtest` itself (for example `run-cqtest.bat editor <filter> 600`), and that run writes Unreal's own `Saved/Automation/TestReport/index.json`. The host **never launches Unreal** and has no way to pick a filter, a map or a command; `orchestrator_run_tests` only validates the report the run left behind. See `cqtest-validation.ts` for the exact rules.

Required IDs are Unreal test paths such as `TP.GAS.Smoke.Runs`. A report is evidence only when it is a real, link-free file inside the workspace, parses as Unreal's report, its per-state counts equal its own root summary, every required ID is `Success`, and nothing is Fail / NotRun / InProcess or carries errors. Warnings are tolerated the way Unreal tolerates them, but an error on a passing entry contradicts it.

Freshness is part of acceptance: both `reportCreatedOn` (UTC, `2026.11.02-07.10.32`) and the file mtime must not predate the current assignment start, so a report left by an earlier run or an earlier assignment can never be reused. Stdout, logs and printed success text never create evidence.

## Evidence and completion

Passing requires a completed report with a positive case count, every case successful, every required case present, and no failures, errors, skips or in-process entries. The accepted report's SHA-256 is stored with the evidence and re-read from disk on every re-validation, so a replaced report invalidates the evidence.

Contract/evidence live in the existing serialized Ticket aggregate and SQLite transaction/recovery path. Evidence binds ticket ID, current assignment ID, canonical workspace, contract revision/digest and before/after content fingerprints. Every ready report, every common successful end (`completed`, `merged`, `closed`, including thread closure and dropped-to-merged), and every `result` reply rechecks the same evidence and current content. Worker-supplied report summaries/counts never create evidence. A failed or running newer test attempt removes the old green evidence. Ordinary dropped/stopped/failed work stays non-successful; a strict dropped ticket cannot publish a result without validation.

Fingerprints hash every file name, directory and file content, including new/deleted source and tests that an `htmlcov` or report-looking directory may hold. The only exclusions are `.git`, `node_modules`, Python/tool caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`), `.coverage*` files and `.dsh/home`. No worker-controlled glob/exclusion list exists. Symbolic links/junctions and nonregular files are rejected rather than traversed. Reports are written to a unique temporary directory outside the workspace and never enter the fingerprint. A trusted Python executable outside the workspace is bound by its digest. Because Python tests are real code, a test that starts a detached background writer in an excluded directory can still change files after the run; the written report is outside that set.

Restored evidence is checked again against disk. A run leaves a persisted running marker while it executes and cannot pass; stop, retry, assignment replacement and host lifetime abort the process tree, and the run returns only after bounded process-tree termination. Operator reconfiguration is refused while this host runs tests but replaces the contract (clearing the marker and prior evidence) after a crash. A new assignment cannot use an old assignment's evidence.

## Explicit security and delivery limits

This is a trusted operator API boundary and workflow correctness gate, **not isolation against a malicious process running as the same OS user**. Host/Origin/header checks do not prevent a worker using shell HTTP, editing SQLite/plugin files, replacing the Python executable, monkeypatching unittest from tests, or racing filesystem checks. Fingerprints observe before/after/current content; they do not detect modification then restoration between observations. Tests execute code under the host user, not in a new OS sandbox. No claim of immutable evidence against that user is made. Review the contract and test semantics independently; a fingerprint does not prove assertions are meaningful.

Phase B visual evidence, C exclusive resources and D release authorization have separate contracts and evidence; this page documents test acceptance only. Source tests and builds do not by themselves prove the currently running GUI has loaded a change. Runtime restart/loading and a real enabled-ticket smoke test remain separate acceptance steps.
