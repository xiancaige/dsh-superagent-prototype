# Local ticket delivery and workspace reclamation

This is opt-in tooling, not permission to publish from a Feishu message. Keep `executionMode: local`; no GitHub Source or PR is needed. Existing deployments retain their behavior unless the operator sets `finalizeWorktrees: true` alongside `worktrees: true` in the repository rollout and reapplies the configuration.

1. Worker verifies the tooling/game change as required, commits only authorized files, and publishes initialized submodules from the inside out before the parent pointers. Use the configured origin branches, never force-push. Synchronize competing changes and rerun affected checks before retrying a rejected push.
2. Worker reports ready with actual commit/push/check evidence. The configured acceptance and publication gates still decide completion; ready is neither independent review nor proof that cleanup happened.
3. A committed `completed` event queues the configured executor `finalize` command in the durable effect queue. Drops, stops, failures and source-mode tickets do not queue cleanup. The host waits for background work to stop, the worker to become idle and the editor lease to release. A resumed ticket invalidates a waiting effect; launch/delivery waits while an effect is pending.
4. The repository-owned finalizer checks exact linked-worktree ownership, clean source and ticket repositories, recursive initialized submodules, fresh origin refs and live remote branch SHA. The parent ticket HEAD must be an ancestor of origin/main. It only fast-forwards source main, aligns submodules and verifies source contains the ticket HEAD.
5. Only then it removes that exact worktree using Git. Initialized submodules require Git's `--force`; this is used only after clean and remote checks on every initialized repository. It never resets, stashes, cleans, deletes branches, prunes other worktrees or falls back to recursive filesystem deletion. A failed operation retains the workspace and its branches. Ignored build/cache files in the ticket workspace are intentionally reclaimed.

The effect queue persists across restart. Failures and retries appear under the `finalize` health entry and effect error, separately from the completed ticket's implementation result. Fix the concrete source/remote/lock error; do not label failed cleanup as reclaimed. Removing the workspace does not erase stored ticket/session history. A later resumed assignment recreates its missing workspace using the retained ticket branch; prepare never deletes a retained branch on a submodule initialization failure.

## Deployment boundaries

`configure-superagent-local.mjs` generates the command and delivery prompt only with the explicit rollout opt-in. Review the generated command's source path and remote/branch policy before applying it. This change does not apply settings to a running host, enable opt-in, push production commits, integrate the production source checkout or reclaim existing production tickets.

Checks: `node --test .dsh/plugins/test-finalize-ticket-worktree.mjs`; plugin typecheck/build and affected executor/runtime/policy specs. UE compilation, packaging and visual acceptance do not apply to this tooling-only change.
