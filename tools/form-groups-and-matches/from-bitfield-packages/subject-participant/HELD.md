# tools/form-groups-and-matches/from-bitfield-packages/subject-participant/

The bitfield-packages subject-participant package at d926b7adb8ca24159ee64f47e7d9cae254f5b641, moved here unchanged under its package paths. `moved-from.json` names each file's source path and commit and its BLAKE3 identity. Nothing here is wired into `tool-rows.json`; joining a group is `add-member` in this tool until the doorway is adapted.

| Path | What it holds | Status |
|---|---|---|
| `do-work/join-subject.ts.held`, `do-work/join-subject.test.ts.held` | The hosted join doorway: admission proof, revisioned rows, compare-and-set, idempotency receipts, signed accepted event | held: needs `@bitfield/runtime-kit`, `access-rule`, `signed-event-author`, `signed-event-authority` and `slot::workflow` |
| `read-data/subject-participant-surface.js`, `show/mount-subject-participant.js` | The boundary surface descriptor and its mount | plain files |
| `tests/subject-participant-surface.test.mjs.held` | Reads the package's own records and built entry | held: needs the package layout and its built bytes |
| `things-to-store-and-run.json` | Owner-action contracts (request entry, update, invite), the membership-request workflow actions, the input, targets | data |
| `README.md`, `visual-proof.md`, `read-data/README.md`, `show/README.md` | The package's own description and proof matrix | documents |

`claim.md` and `reference-grounded-screen-contract.md` were not carried: they name directories on a person's computer, which a public tree may not keep.
