# Workflow loading validation (TP extension)

This host gate is independent of prompt wording and strict test/visual acceptance. It proves required material was delivered through successful tools in the ticket's worker Session; it does **not** prove comprehension, independent review, or product correctness.

## Configuration and lifecycle

The host reads `.dsh/workflow-validation.json` from its resolved **source checkout**, freezes a validated copy plus Git HEADs in `execution.workflow` before launching a worker, and persists successful tool evidence there. Worker edits to the policy cannot relax that ticket's contract. No policy preserves existing deployment behavior. Existing already-running tickets are not retroactively certified; new launches capture the policy.

```json
{
  "version": 1,
  "repositories": ["ignored-independent-repository"],
  "rules": [{
    "id": "tooling",
    "paths": ["tools/"],
    "taskIncludes": ["audit tools"],
    "reads": ["knowledge/tooling.md"],
    "skills": ["tool-verification"]
  }]
}
```

Paths are relative, forward-slash, exact files or directory prefixes (not globs). A changed path **or** a case-insensitive task substring activates a rule. Task matching covers title, authorized scope and assignment, allowing read-only reviews to require loads without changes. Use narrow task terms. Requirements from all matched rules accumulate.

The main Git repository and initialized submodules are scanned recursively. Explicit `repositories` cover ignored independent Git repositories that parent Git cannot see. Add such repositories deliberately; there is no expensive/unbounded filesystem discovery. Failure to read a configured repository refuses launch/verification. Git diff compares the frozen HEAD to the current worktree (thus covers staged and committed edits), plus non-ignored untracked files. Ignored files outside declared repositories are not covered. A change reverted before completion is not a delivered change.

## Evidence and refusal

Only paired `tool/call` + non-error `tool/result` events from the ticket's own Session count. A successful `skill` result must include the named complete skill envelope. A `read` result must identify the resolved file, and every current line must have been returned, with identical text. Paginated reads accumulate. Partial/truncated lines, stale content, failures, shell output and worker report assertions cannot substitute. Shell reads are intentionally not accepted: use the explicit `read` tool for required rules. Subagent reads do not satisfy the parent worker's requirement.

The ready-report guard (including `completion: implementation`) and completion/PR-close guard refuse with the rule ID, triggering file/task, and missing rule/skill. Blocked/progress reports and explicit human stops remain available. Existing publication, editor locks, review, design and test gates are unchanged.

## Regression

`pnpm exec vitest run tests/workflow-validation.spec.ts` exercises real temporary Git repositories: committed/shell/untracked changes, ignored nested repositories, submodules, no-change review matching, full/partial/stale/error loading evidence, and atomic Engine completion refusal/recovery. It never starts Unreal or mutates production state. Run typecheck and build as separate checks.

Operational activation still requires source policy publication, plugin build in the loaded checkout and an authorized host restart. Tests alone do not prove the running host has loaded this implementation. Session evidence and frozen state share the host user's trust boundary; a process able to rewrite the host database or impersonate tool results is outside this guard's security model.
