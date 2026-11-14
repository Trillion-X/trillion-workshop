# tools/change-pause-resume-or-cancel-a-plan/

The plan lifecycle screen: shows a person's current account access as record work (field, relationship, projection, rule, owner-target and action descriptors, all data) and routes Change plan, Pause, Resume and Cancel to generic workflow owner targets; it owns no payment, account or access internals. `read-data/record-work-model.ts` reads the descriptors into a model, `show/plan-lifecycle-surface-descriptor.ts` turns the model into the screen descriptor, `show/app-shell/PlanLifecyclePortalSurface.tsx` draws it, `show-ios-jscore/mount-plan-lifecycle-jscore.js` draws the same descriptor natively on iOS without React, and the `do-work/` files send the requests. It is not `tools/move-records-through-declared-states` (a rule engine over stages); this is the person's account screen.

## Files

| File | Purpose |
|------|---------|
| `do-work/README.md` | The package's own note, moved as written. |
| `do-work/read-portal-plan-state.ts` | Portal plan reader: browser session -> signed effect list -> plan projection. |
| `do-work/request-record-work-action.ts` | The package's code, moved as written. |
| `do-work/send-plan-lifecycle-event.ts` | Sign a plan lifecycle event and admit it through the signed event authority. |
| `from-bitfield-packages/README.md` | The package's own note, moved as written. |
| `index.ts` | The package's code, moved as written. |
| `read-data/README.md` | The package's own note, moved as written. |
| `read-data/record-work-model.ts` | The package's code, moved as written. |
| `show-ios-jscore/README.md` | The package's own note, moved as written. |
| `show-ios-jscore/mount-plan-lifecycle-jscore.js` | Invariants: consumes the shared Surface Descriptor, imports no web framework, |
| `show-ios-jscore/mount-plan-lifecycle-jscore.test.ts.held` | Held test: imports things-to-store-and-run.json as a bare JSON module (no `with { type: 'json' }` attribute) |
| `show/README.md` | The package's own note, moved as written. |
| `show/app-shell/PlanLifecyclePortalSurface.tsx` | Portal plan panel: current access status plus pause/resume/cancel lifecycle |
| `show/mount-plan-lifecycle-portal.tsx` | The package's code, moved as written. |
| `show/plan-lifecycle-surface-descriptor.ts` | The package's code, moved as written. |
| `tests/README.md` | The package's own note, moved as written. |
| `tests/read-portal-plan-state.test.ts.held` | Held test: reads do-work/read-portal-plan-state.ts |
| `tests/record-work-backend.test.ts.held` | Held test: bundles do-work/request-record-work-action.ts |
| `things-to-store-and-run.json` | Data the package carried as written. |
| `moved-from.json` | Where each file came from: source path and commit in bitfield-packages, the identity of its source bytes and of its bytes here, the call rows applied, the held tests and the files that still call the retired runtime. |
| `part.json` | Nothing here is imported by this tree; the folder is a part another tree imports. |
| `README.md` | This file |

The original package README is kept at `from-bitfield-packages/README.md`.

## Still on the retired runtime

These files are the original bytes, with import paths changed to this tree. They call the retired package runtime or a package path this tree does not hold, so no tool row opens them until each call is swapped for the records door.

- `do-work/read-portal-plan-state.ts`: retired package runtime
- `do-work/request-record-work-action.ts`: retired package runtime
- `do-work/send-plan-lifecycle-event.ts`: retired package runtime

## Held tests

Each is the package's test file, same bytes, named `.held` so no test run picks it up; the reason is in `moved-from.json` under `held`.

- `show-ios-jscore/mount-plan-lifecycle-jscore.test.ts.held`
- `tests/read-portal-plan-state.test.ts.held`
- `tests/record-work-backend.test.ts.held`

## Dependencies

**Depends on:** `tools/keep-lists-of-rows` (the visual-database read model), the shared ui parts of the web client, Node 24.

**Depended on by:** nothing yet; a tool row and its screen wiring come once the held calls are swapped.
