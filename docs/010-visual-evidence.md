# Strict visual acceptance (phase 2 B)

Real visual evidence for tickets whose acceptance needs screenshots, on top of the phase A strict acceptance described in [007 Architecture](007-architecture.md). It is not a second workflow: it extends the same opt-in `validation` record, the same `assertTicketValidated` completion guard and the same ticket/assignment/workspace binding rules. A ticket that has no `validation.visual` behaves exactly as before.

## Operator management

`PUT tickets/:id/validation` with `visual` in the same body, or `PUT tickets/:id/validation/visual` afterwards, configures the visual contract on a ticket whose strict acceptance is already enabled:

```json
{
  "scenario": "inventory-open",
  "capture": { "server": "tpmcp", "tool": "capture_screenshot", "arguments": { "path": "{{path}}" } },
  "inspector": { "executable": "<absolute installed Python>", "args": ["<absolute visual_inspector.py>"] },
  "checks": ["nonblank", "readable", "pixel:ff0000"],
  "minimumFrames": 1
}
```

- `scenario` names the fixed editor state and the capture instruction (a short slug). The capture tool is fixed: one MCP server, one tool name and a JSON argument template whose `{{path}}` is the frame path the host chooses.
- `inspector` is the host-trusted image reader and is bound by its file digest. `scripts/visual_inspector.py` in this plugin is a working example; any executable that reads `<request.json> <report.json>` and writes the structured report works.
- `checks` are judged one by one, from the frames only; `minimumFrames` allows multi-frame evidence.
- `POST tickets/:id/validation/visual/prepare` records that the operator confirmed the trusted capture tool is ready for this ticket. A capture without it is recorded as failed and cannot pass.
- Reconfiguring replaces the contract and clears preparation and prior evidence. There is no worker operation for any of this.

The deployment decides the real transport: the project editor MCP endpoint (`DSH_SUPERAGENT_VISUAL_ENDPOINT`, default `http://127.0.0.1:55255/mcp`) or a local stdio MCP server (`DSH_SUPERAGENT_VISUAL_COMMAND`, `DSH_SUPERAGENT_VISUAL_ARGS`).

## Editor recovery (phase 2 B2)

An unreachable editor endpoint is **recovered first**, then reported, following the project rule for TPMcp (`knowledge/tpmcp/00-prerequisites-p1.md`). Recovery is off unless the operator enables it, and then it acts only on the deployment's own TP environment:

| Variable | Meaning |
|---|---|
| `DSH_SUPERAGENT_EDITOR_RECOVERY=1` | Enables recovery; without it an unreachable endpoint stays `unavailable`, exactly as phase B did. |
| `DSH_SUPERAGENT_TP_PROJECT` | Absolute TP `.uproject`; recovery never touches another project. |
| `DSH_SUPERAGENT_TP_EDITOR_EXE` | Absolute `UnrealEditor.exe` the TP project opens with. |
| `DSH_SUPERAGENT_TP_MCP_PORT` | TPMcp port (default `55255`). |
| `DSH_SUPERAGENT_TP_CAPTURE_TOOL` | Tool readiness requires (default `CaptureWidgetBlueprintScreenshot`). |
| `DSH_SUPERAGENT_TP_WAIT_SECONDS` | Handshake budget (default `300`). |

The order is fixed and every step is a project entry point, not a new loop:

1. Take the **TP environment exclusivity** first: the one lock of phase 2 C below (`tp-environment.lock` in the deployment state directory, outside every ticket workspace). Without it nothing is detected, launched or killed.
2. Decide TP identity from the absolute `.uproject`, the editor process name and the port owner. A listening port alone is never readiness, and a port served by another UE project is a block, never a reason to stop it.
3. `kill-tp-editor.ps1` stops only this project's TP editor, `launch-tp-editor.ps1` starts it, and `wait-tp-mcp.ps1` performs the real `initialize` + `tools/list` handshake. Readiness additionally requires the configured capture tool in `tools/list`.
4. **One recovery chance per ticket.** Success captures over the endpoint again; failure records an environment block on the ticket (`validation.visual.blocked`) and is not retried.
5. A TP editor a recovery started is stopped when that ticket ends; a borrow of the environment is handed back at the end of every attempt.

## The TP environment exclusivity (phase 2 C)

From the moment a ticket is accepted until it is completed, a person hands it over, or its work ends, exactly one ticket owns the TP environment: the TP editor process, the TPMcp port, the TP project workspace, and that ticket's execution directory. One ordinary Session can own it too, through a person's handover.

The record is the **same** `tp-environment.lock` B2 wrote — one lock, not two — with what it now means:

| Field | Meaning |
|---|---|
| `holder` | `ticket` with its id and title, or `session` for a person's handover. |
| `resources` | `tp-editor` (the absolute `.uproject`), `tpmcp-port`, `tp-project` (the project's directory), and `ticket-directory`. |
| `acquiredAt` | When the ticket took it; it never moves while the ticket holds it, across restarts. |
| `heartbeat` | Written every 30 s while the host lives, so an operator sees the holder alive during a wait, an idle turn, or a released slot. |
| `facts` | What this deployment recorded for the holder, such as the TP editor PID it started (`-1`/`reused` for an editor it did not start). |

Rules, and what they refuse:

- A live foreign holder is **never stolen**: the second ticket, or an ordinary Session's operation, fails with the holder's name (`TP environment is held by ticket <title> (<id>) (Session pid N) since …`). The refused ticket is stored blocked and is not launched; no process is detected, launched or killed for it, and nothing retries.
- Waiting for a person, a `waiting` report, an idle worker, a released slot, a failed acceptance under rework, a retry and a restart all keep the lease. The owner is the hosting Session process, so a restart resumes the persisted lease (new token, same owner and acquisition time) instead of releasing it; only a record whose process no longer exists is reaped.
- Only three facts release it: `acceptance` (the host's own completion after the strict acceptance it requires passed), `handover` (a person's explicit request) and `stopped` (a person's stop, or work that ended by itself such as a dropped report). `TP environment exclusivity: … is not a release reason` refuses anything else, and only the holder's own token releases.
- A **handover preserves the scene**: the ticket directory's uncommitted changes are exported first (`git stash create`, which writes a commit object and never applies anything; then a bundle holding it and a binary patch) under the state directory's `handovers/`. No `stash` is applied and nothing is committed, reset, checked out or cleaned. When the export cannot be made (not a git work tree, no commit yet, git failing) the handover is refused and the ticket keeps the lock.
- B2's recovery uses the same broker: inside the ticket's own lease when the ticket recovers, otherwise a borrow that names the holder it found. It never creates a second lock.
- The single-worker configuration stays as the second line of defence; the exclusive lease is the first.

The panel reads the holder at `GET /orchestrator/api/environment`; a person hands over with `POST /orchestrator/api/tickets/:id/environment/handover` (`{ "stop": true }` also stops the ticket).

### What the running TP editor really accepts

Measured against the live editor on 2026-11-02 (PID recorded in the ticket report):

- `tools/list` returns only `list_toolsets`, `describe_toolset` and `call_tool`. Editor functions are called through `call_tool` with `{ toolset_name, tool_name, arguments }`, and `tool_name` is the bare name (`CaptureWidgetBlueprintScreenshot`), not the namespaced one. `tpmcpCaptureCall` builds that call from a contract, and a server that lists the tool directly is still called directly.
- `blueprintPath` must be the full object path (`/Game/.../Name.Name`). A bare package path such as `Game/.../Name` loads nothing and returns `Failed to load blueprint`.
- `outputPath` is required, and `testData` must be empty (non-empty is refused).
- The tool instantiates the widget into the editor world and renders it with `FWidgetRenderer`. A WidgetBlueprint whose native class calls `UGameplayMessageSubsystem::Get()` from `NativeConstruct` **crashes the editor during capture** in that world, because the editor preview world has no game-instance subsystem (`GameplayMessageSubsystem.cpp:47`, `check(Router)`). Choose a capture target whose native class does not touch the router at construction; this is a project asset constraint, not a plugin fault.
- A nearly empty WidgetBlueprint (one label on black) is a real frame but fails `nonblank`; that is the check doing its job, not a broken route.

## What worker tools may do

`orchestrator_capture_visual` takes a group name and a frame count only; `orchestrator_read_visual` takes nothing. Neither accepts a path, a command, a tool name or a verdict. The host captures into `<workspace>/.dsh-visual-evidence/<group>/<scenario>-NN.png` and records a manifest entry bound to the ticket, the assignment, the instruction and each frame's digest.

## Evidence and completion

A capture is real only when the configured MCP tool answered with image content and the file read back from disk is a complete PNG. A blank or non-PNG frame is a failure, never a pass; an unreachable trusted tool is recorded as `unavailable`. A capture group on its own never passes a check.

The read hands every intact frame of the current ticket and assignment to the inspector, which must answer for every contract check with `passed`, `failed` or `undetermined`, naming the frames it read. A pass is accepted only when it cites frames of that group; the group verdict is a pass only when every check passed. The latest complete read becomes the ticket's visual evidence, bound to the ticket, the assignment, the contract digest and a workspace fingerprint that counts source files and the captured frames.

### Evidence integrity (phase B3)

A verdict is only worth the frame it was computed from, so each capture is one frame of its own and one report never borrows another's:

- A capture sets aside anything already at its frame path (a file an earlier capture wrote, or one a worker left, or a symlink) into `.dsh-visual-evidence/.capture-scratch/` before it calls the tool, and refuses the frame when the tool's image and the file on disk differ. A capture never reads a file it did not just receive.
- Every manifest frame records its sha256, byte size, dimensions, capture time and the tool's own answer: the call it received, its text, the kind and size of each content block, and digests of the response and of a summary of it. `captureDigest` is the digest of that whole record.
- The read compares its frames with every report this ticket already settled: a frame digest decided `passed` by one and `failed` by the other for the same check is a contradiction, and a later capture holding bytes an earlier one already wrote is a reused frame, renamed or not. Either one fails the affected group, is kept in `evidence.contradictions`, and refuses the whole report; `validateVisualEvidence` and the completion gate refuse such evidence as well.
- Only a report without a contradiction becomes a ledger entry on the ticket (`validation.visual.reports`), so what two captures decided stays comparable instead of one being taken for granted, and a real change between two states is caught by their different frame digests.

Two captures of the same state therefore legitimately produce the same bytes, and the second is correctly refused: distinct visual evidence needs the captures to differ (another widget, or a state that really changed), never a renamed copy of one image.

Every ready report, every common successful end and every `result` reply re-checks the visual evidence along with phase A evidence: a failed or missing read, a frame that no longer matches its digest, a changed source file, another assignment, another ticket or another contract keeps the ticket blocked. Visual evidence never shares the phase A digest fields, so an A contract and a B contract cannot be mistaken for each other, and a visual-only ticket needs no unittest run (a ticket with an A contract still needs its tests).

## Limits

The frame ledger compares reports this host recorded on the ticket; a worker with write access to the evidence directory can still edit the manifest, which the plugin treats as out of its trust boundary, exactly as it does for the inspector. This is not isolation against the process that runs the agent. The capture tool and the inspector are trusted operator configuration; a worker that can edit them or the plugin itself is outside this gate. The inspector's verdict is only as good as its checks: a check that reads nothing meaningful can still be satisfied by a real frame, so the operator owns check quality just as it owns test assertions in phase A. Decoding is limited to PNG. The editor endpoint must actually serve the capture tool; without it every capture is `unavailable` and the ticket stays blocked rather than passing on an old or fabricated frame. The recovery borrows phase 2 C's environment lease and does not prove the editor was compiled from the current source. Its helpers are the project's existing scripts; a host that cannot run them reports an environment block instead of a test failure.
