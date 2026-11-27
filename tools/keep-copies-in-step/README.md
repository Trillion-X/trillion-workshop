# tools/keep-copies-in-step/

Whether every copy of a person's things is in step, as their own store knows it: each device says how it stands (its state, the changes it still holds, when its writes last reached the store), and every record two copies changed apart is read from the record store's kept-apart records, as the record now and the other versions. The person (or their AI) settles one by keeping one version, both, or a merged one.

- **Moved, not rewritten.** `read-data/catch-up.mjs` and `read-data/catch-up.json` are trillion `src/catch-up.mjs` and `records/catch-up.json` (b4e3c05abe), with only their import paths changed (`ports/catch-up.json`). The engine's Rust copy (trillion-rust `src/catch_up.rs`, `src/local_account/catch_up.rs`, `GET /catch-up`, `POST /catch-up/here`, `/catch-up/conditional-here` and `/catch-up/settle`, and `product/catch-up.json`) is deleted in the same move.
- **The rows come in with the request.** The person's AI reads the rows `read-data/copies-rows.json` names and sends them: the device rows as `devices` (`setting:catch_up_devices`, its list, newest first) and the kept-apart records and the records they name as `records` (`[{ id, type, value }]`; `kept-apart:<record id>` is the kind of a record kept apart). None of the three tools reads or keeps anything: `tool:say-how-this-device-stands` answers the next device list, `tool:settle-two-versions` answers the `writes` that settle a record kept apart, each standing on the record as it was handed in (`expected`).

- **One kind per call.** A row's rights name one record kind, so a read answers the versions of the kind it names and lists the other kinds kept apart in `other_kinds`, to ask about next.
- **Every answered write stands on what was handed in.** Each write carries `expected`: the record as it was handed in, or null for one nobody had, so the caller's conditional write refuses it when the record changed meanwhile.
- **How far each copy took.** The engine's copy positions are not a record; a caller that has them sends them as `positions` (`[{ copy, settled_at }]`).

## Files

| File | Purpose |
|------|---------|
| `read-data/catch-up.mjs` | `catchUp` (`here`, `settle`, `read`), `apartOf`, `KEPT_APART`, `handleCatchUpRequest` |
| `read-data/catch-up.json` | How often a device row is written again, how many are read, the words of each version |
| `read-data/copies-rows.json` | Which record holds the device rows, and the read bounds |
| `do-work/copies.mjs` | `seeIfMyCopiesAreInStep`, `sayHowThisDeviceStands`, `settleTwoVersions`, run by `tools/workflows/do-work/run-a-function.mjs` |
| `do-work/catch-up-routes.mjs` | `answerCatchUpRoute`: the page route POST /work/api/catch-up/here as a route tool (`{ path, method, query, body, browser }` in, `{ status, body }` out), answering as old trillion's `handleCatchUpRequest` did |
| `ports/catch-up.json` | The port contract for the move |
| `part.json` | The public modules |
| `what-this-tool-does-and-how-to-run-it.json` | The four Workshop rows |
| `test/catch-up.test.mjs` | The original trillion tests, assertions unchanged |
| `test/catch-up-routes.test.mjs` | The route tool over the device row the request carries: a report (200), the same report again (not written), refused reports (400), other paths (404), a report decided on the row it is handed, the other device rows kept |
| `test/copies.test.mjs` | Each row over made-up rows handed in as input: the read, a report, keep one, keep both, a conflict, a resent report |
| `show/catch-up-mount.tsx`, `show/catch-up-status-mount.tsx`, `show/two-versions-mount.tsx` | The module entries of `tool:screen-catch-up` and `tool:screen-catch-up-preview` (both `mountCatchUpScreen`), `tool:screen-catch-up-status` (`mountCatchUpStatusScreen`) and `tool:screen-two-versions` (`mountTwoVersionsScreen`). |
| `web/src/workspace/catch-up.tsx`, `web/src/workspace/catch-up.json` | What the page knows about whether every copy is in step, handed to the shared catch-up part as its sources: this device, the person's other devices and the records kept as two versions, the sidebar row, the screens, the pane mark and the ⋯ menu's Two versions rows. The page's start-up code imports `keepCatchUp`, `thisDeviceId` and `versionsRows` from here. Moved byte for byte from the web client (`moved-from.json`). |

## The rows

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:see-if-my-copies-are-in-step` | `seeIfMyCopiesAreInStep` | `{ devices, versions, other_kinds }` |
| `tool:say-how-this-device-stands` | `sayHowThisDeviceStands` | answers the next device list after one device's report, nothing when it changed nothing |
| `tool:settle-two-versions` | `settleTwoVersions` | keep `one`, `both` or `merged`, answered as the `writes` to keep |
| `tool:answer-the-catch-up-here-route` | `answerCatchUpRoute` | the page's POST /work/api/catch-up/here: 200 `{ device, written }`, 400 `{ error }` for a refused report, 404 `{ error: 'Not found' }` for any other path |

GET /work/api/catch-up and POST /work/api/catch-up/settle are not route tools yet: old trillion read and settled the record a kept-apart record names, of any kind, and a run's records right names one kind, filled at most from the input. The page sends no kind, so a route run cannot be granted that read.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`), `tools/content-identity`.


## Optional current presentation

`read-data/catch-up-content.mjs` ports old Trillion `src/catch-up-content.mjs` onto the existing private catch-up owner. `currentCatchUp(owner, host, {read, current})` preserves `here`, raw-receipt `settle`, and `read`. The host supplies current `bootstrap` content rows and `resolveContent(source, bootstrapSection, {read})`, an admitted publication resolver returning `{found, from, value, revision?}`. The resolver owns publication identity and durable withdrawal evidence; this wrapper does not manufacture either.

Only `/words`, `/title_fields` and `/copy_state` may shape presentation. Invalid, withdrawn, failed or stalled sections are absent. The existing bounded-answer owner limits the public wait to 250 ms. Rights are checked before and after that read, then the private snapshot is taken, including an asynchronous records-door owner. A late result cannot change the released answer. This module has explicit host interfaces and is not attached to a new route or a new publication store. `test/catch-up-content.test.mjs` proves selection, validation, withdrawal, timeout immutability and current-rights ordering.
