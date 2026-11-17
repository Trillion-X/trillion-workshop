# tools/permission-lease/

Permission leases, exclusive control leases, obligation gates and the live guardrails surface: what someone has allowed an AI to do and for how long, one holder at a time for the control of a computer, and a decision over obligations that says whether a capability may run. Moved here byte for byte from bitfield-packages `packages/permission-lease`. The Workshop held only the device permission notice from this package (`tools/record-voice-and-meetings/read-data/capability-permission.ts` and `show/CapabilityPermissionPrompt.tsx`, both later copies); none of the lease, control or obligation code was anywhere else. This folder is a prepared restore: the files are the originals and are not yet wired to a tool row.

## Files moved from bitfield-packages (packages/permission-lease)

Each file below is the package's own, byte for byte; `moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `data/wholeness-walk-obligation.json` | A file of the package. |
| `do-work/exclusive-control-lease-core.ts` | A file of the package. |
| `do-work/exclusive-control-lease-targets.test.ts.held` | A test of the package, held: imports @bitfield/runtime-kit or @bitfield/slot-protocol (the retired package runtime); needs the records door in its place |
| `do-work/exclusive-control-lease-targets.ts` | A file of the package. |
| `do-work/exclusive-control-lease.test.ts.held` | A test of the package, held: imports @bitfield/runtime-kit or @bitfield/slot-protocol (the retired package runtime); needs the records door in its place |
| `do-work/exclusive-control-lease.ts` | A file of the package. |
| `do-work/permission-lease-actions.test.ts.held` | A test of the package, held: imports @bitfield/runtime-kit or @bitfield/slot-protocol (the retired package runtime); needs the records door in its place |
| `do-work/process-scripts/build-process-scripts.mjs` | A file of the package. |
| `do-work/process-scripts/obligation-decision-cli.test.ts.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `do-work/process-scripts/obligation-decision-cli.ts` | A file of the package. |
| `do-work/read-authorization-time.test.ts.held` | A test of the package, held: imports @bitfield/runtime-kit or @bitfield/slot-protocol (the retired package runtime); needs the records door in its place |
| `do-work/read-authorization-time.ts` | A file of the package. |
| `do-work/record-permission-lease.ts` | A file of the package. |
| `do-work/request-permission-lease-check.ts` | A file of the package. |
| `do-work/save-what-someone-is-allowed-to-do-target.test.ts.held` | A test of the package, held: imports @bitfield/runtime-kit or @bitfield/slot-protocol (the retired package runtime); needs the records door in its place |
| `do-work/save-what-someone-is-allowed-to-do-target.ts` | A file of the package. |
| `do-work/save-what-someone-is-allowed-to-do.test.ts` | A test of the package. |
| `do-work/save-what-someone-is-allowed-to-do.ts` | A file of the package. |
| `do-work/session-audit.test.ts` | A test of the package. |
| `read-data/capability-gate-descriptor.test.ts` | A test of the package. |
| `read-data/capability-gate-descriptor.ts` | A file of the package. |
| `read-data/condition-node-pack.ts` | A file of the package. |
| `read-data/hold-reason.ts` | A file of the package. |
| `read-data/live-guardrails-surface.test.ts` | A test of the package. |
| `read-data/live-guardrails-surface.ts` | A file of the package. |
| `read-data/lock-surface-descriptor.test.ts` | A test of the package. |
| `read-data/lock-surface-descriptor.ts` | A file of the package. |
| `read-data/obligation-decision.test.ts` | A test of the package. |
| `read-data/obligation-decision.ts` | A file of the package. |
| `read-data/permission-lease-surface.test.ts.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `read-data/permission-lease-surface.ts` | A file of the package. |
| `read-data/read-live-guardrails.ts` | A file of the package. |
| `show/CapabilityGate.tsx` | A file of the package. |
| `show/ObligationGatePanel.tsx` | A file of the package. |
| `show/PermissionLeasePanel.tsx` | A file of the package. |
| `show/mount-capability-gate.tsx` | A file of the package. |
| `show/mount-obligation-gate.tsx` | A file of the package. |
| `show/mount-permission-lease.tsx` | A file of the package. |
| `tests/every-action-ref-resolves.test.mjs.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `tests/published-records-scoped-feed.test.ts.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `tests/recorder-public-source-contract.test.ts.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |

### Not carried

- 35 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 3 files: package README, package.json or ignore file; this folder has its own README
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried
- 1 file: the Workshop holds a later copy at tools/record-voice-and-meetings/read-data/capability-permission.ts (browser notice, picked devices); kept
- 1 file: the Workshop holds a later copy at tools/record-voice-and-meetings/show/CapabilityPermissionPrompt.tsx; kept
- 1 file: build output of obligation-decision-cli.ts; built by build-process-scripts.mjs

The receipt's `not_carried` names each path.
