# process-session

## Build and test admission on each computer

`do-work/heavy-work.mjs` owns one cache-backed heavy-work slot per computer, shared by
all Trillion checkouts on that computer. Its queue lives in the computer's cache folder
(`do-work/computer-cache-folder.mjs`: `$XDG_CACHE_HOME/trillion`, or
`~/.cache/trillion`), the same rule on every computer; nothing asks what kind of
computer it runs on. `runHeavyProcess` runs already-authorized argv through
the existing bounded process lifetime; `enterHeavyWork` guards a canonical CLI
before dependencies, builds, checks or build-output mutation. The canonical test,
build, local publication/deploy and native release entries use it. Native release
keeps its `shlock`, Keychain wrapper and existing release checks; hosted CI keeps
its existing lane and deployment traffic lease. Browser admission uses its own
independent cache root and cannot be preempted by a higher-priority ticket.

`node scripts/run-heavy-work.mjs <executable> <args...>` admits an explicit heavy
command. `npm test -- test/exact-file.test.mjs` or
`node scripts/test.mjs test/exact-file.test.mjs` admits a focused run before Node
creates its test workers and fixes concurrency at two. Raw Node test invocations
use the explicit heavy-command wrapper; an ESM `--import` is not a test-parent
guard on the installed Node version. A bare Node command without the wrapper
remains outside this voluntary mechanism; it is not an OS-wide process sandbox.

CLI adapters pass the caller's readable stdin through a separate private pipe
(fd 4) to the command. The lifetime supervisor retains its independent fd 0
ownership pipe; input EOF cannot retire the owned group. Input is streamed with
backpressure, never copied into argv, environment, diagnostics or a file. Cleanup
unpipes the caller without destroying its stream. Optional lifecycle diagnostics
contain only fixed stage names, not command, environment or input values.

An inherited claim is accepted only when its exact token, owner incarnation,
registered supervisor incarnation, current group and ancestry match live state.
Nested owned helpers register another supervisor before the start handshake;
a detached independent process cannot use a copied environment as admission.
Unknown probes fail closed. A dead parent with a live bound supervisor still
holds the slot; inconclusive group cleanup retains the owner record. Cancellation
and parent-pipe closure stop owned groups, with no claim that intentionally
detached, unregistered descendants are covered. Admission adds no scheduler,
watcher, command selection, publication policy or release lifecycle.

`do-work/process-admission.mjs` contains the shared atomic ticket mechanics also
used by `headless-browser/admission.mjs`. Test fixture factories may choose an
isolated temporary root; production roots are fixed by their resource owners.

The local `do-work/run-owned-process.mjs` embedding adapter accepts optional `onStdout(chunk)` for incremental caller-owned result handling. UTF-8 decoding and the existing output cap apply before delivery. A callback exception terminates the owned group through the same bounded cleanup as cancellation. The callback does not own scheduling, command selection or durable state.

`process-session` owns the reusable session read model, live-output view, and the
public dependency-injected Envelope client for `compute.process_session`.

`do-work/run-owned-process.mjs` is a declared public source for local Node
embedding. It runs already-authorized argv subprocesses, bounds time/output,
preserves UTF-8 and terminates its POSIX process group on cancellation. Expansion
uses it for its existing local media work. It adds no command discovery, durable
queue, scheduling or permission authority. Its two tests include a descendant
that ignores SIGTERM. Windows descendant termination is not verified.

- `read-data/` decodes session snapshots/events and renders launch descriptors.
- `show/` folds live output for product surfaces.
- `envelope-client/` builds and decodes the canonical start-session request while
  requiring callers to inject both the configured target and sender.
- `do-work/` is private owner implementation except `do-work/run-assigned-work`,
  which is declared a public source because harness dispatch and Visual Database
  actions prove against it.
  It holds the assigned-work session lifecycle: `run-assigned-work.ts` builds
  start/stop process-session requests from ordinary source records, Record Board
  action payloads, live `ai-agent-profile` records, owner-declared fallback launch
  templates, and optional team records, and proves guard, permission, and budget
  before an authorized launch.
- `entry-scope-bindings.json` declares the `engine.operation.label-addressed`,
  `ai-action-guard.evaluate-guard-policy`, `slot::workflow`, and
  `compute.process_session` targets each assigned-work entry may reach.

The public client does not spawn a process or bind transport. The runtime target
`compute.process_session` remains the sole execution owner.

## Assigned-work session targets

The assigned-work session lifecycle moved here from `ai-work-control` on
2026-09-03: `process-session` already published the `compute.process_session`
route, so it is the owner of starting a process.

| Target | Export | Role |
| --- | --- | --- |
| `process-session.start-assigned-work-session` | `startAssignedWorkSession` | Starts one session from a resolved source plus worker profile |
| `process-session.start-authorized-assigned-work-session` | `startAuthorizedAssignedWorkSession` | Re-reads source/profile/tool, then proves guard, permission, and budget before any process starts |
| `process-session.stop-assigned-work-session` | `stopAssignedWorkSession` | Stops the correlated session |
| `process-session.start-assigned-record-work-session` | `startAssignedRecordWorkSession` | Starts a session from a Visual Database record action payload |

## The launcher is DATA

`package::process-session::published-record::assigned-work-launch-template::local-codex`
is one launch template row. A second launcher, whether another CLI, a remote runner,
or a container, is another DATA row and zero code change here.

The authorized path still proves that the process runs the model its profile declares.
It does that without knowing any CLI, vendor, model family, or binary: each launch row
declares `model_binding.argv_index`, the argv slot holding the model id, and optionally
`model_binding.executable`, the binary it pins. The owner reads the model out of the real
argv at that slot and checks it against the profile's declared models, so a launch row
cannot claim a model it does not run. A row that declares no binding is refused.

This package names no partition at all. Worker profiles, the tool catalog and the owner
records are read through `engine.operation.label-addressed` without a `partition_label`,
and the engine answers from the partition the request arrived on, which is the app doing
the asking. The `profile_partition_label` route field this replaced was DATA, but it was
DATA naming a specific app (`bitfield-studio`), so every worker-profile read went to a
retired app's store no matter which app was running.

The authorized start input may declare `identity_text` or `label_hash` separately for
the worker and tool owner records; omitted modes remain `identity_text` for existing
callers. Each source `execution_preconditions` row may likewise declare its owner
address mode. The process owner validates those closed values, reads the exact mode,
and repeats every condition after guard, permission, and budget checks. This lets a
policy use the owner's real published address without creating an alias, and lets a
late cancellation or session-authority revision stop the process before launch.

## Owned workspaces

| File | Purpose |
| --- | --- |
| `do-work/owned-workspace.mjs` | `createOwnedWorkspace(ownerRoot)` and `retireDeadOwnedWorkspaces(ownerRoot)`: private build/run folders with a pid-bound owner record |
| `do-work/owned-workspace.test.mjs` | Retirement, symlink, pending-creator and process-group coverage |

An owner root holds only workspaces this module made. A workspace is assembled as `.pending-<pid>-*` and renamed to `work-<token>` once its `.owner.json` exists. Retirement removes every entry no live owner holds: dead workspaces, anything placed in the root by hand or another tool, and leftovers of an interrupted retirement. A symlink is removed as a link; its target is never followed. Owner roots are siblings, never nested inside another owner's root.

**Depends on:** `run-owned-process.mjs`. **Depended on by:** `native-artifact/do-work/run-project-app-open-bundle.mjs`, `advance-local-signed-runner.mjs`, `publish-retained-package-source.mjs`.

## In Trillion

Trillion's `parts/process-session` carries only what the documents surface imports, copied verbatim but for imports pointed at `#workspace-records` (`scripts/port-sources.json`): `show/use-process-session-live-output.ts` (a session's output as it grows), `envelope-client/start-process-session.ts` (asks for a session to start), and `read-data/accumulate-process-session-output.ts`, `read-process-session-events.ts`, `read-process-session-launch.ts`, `render-launch-from-chat-launch.ts` and `stream-output-text.ts` under it. `part.json` names the files other parts may import. Trillion runs no process sessions of its own in the page, so `do-work/`, the session lists and the package's tests did not come across.

**Depended on by:** `parts/documents/show/DocumentsSurface.tsx`.

