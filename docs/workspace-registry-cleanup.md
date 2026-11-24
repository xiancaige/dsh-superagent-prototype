# Reclaimed ticket workspace registrations

Ticket: 5e285dc585652f1a5ecdc17fb49bb3f3. Scope: remove DSH picker entries for reclaimed ticket directories, not session history or unrelated workspaces.

## Implementation
- Finalize effect calls the native workspace registry deletion only after the finalizer succeeds and the exact directory is absent. Registry failures remain in the durable finalize retry.
- Opted-in isolated deployments reconcile old ended tickets before resuming workers on startup. Only exact execution paths with ENOENT are eligible; existing paths, symlinks, active owners and source root remain. Pending finalizers keep ownership of their own cleanup.
- Resuming a worker recreates its registration and attaches its retained Session. Deleted workspace registrations leave history in Ungrouped; no Session is deleted or archived.

## Progress
- Original Feishu thread and machine-local settings read; loaded plugin points at the source checkout, not this ticket directory.
- Implementation and directed tests in progress. Next automatically: affected specs, typecheck/build, publication inside-out, deploy to loaded checkout, safe restart, inspect live registry and health.
- No gameplay changes, game build, editor, CQTest or visual acceptance applies.
