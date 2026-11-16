# leave-out-steps-for-devices-i-do-not-own

The old `src/device-rows.mjs` device identity and evidence matching rules are preserved under `read-data/`. `deviceOfRow`, `namesDevice`, `factsShowDevice` and the bounded operator cleanup report keep their original behavior. The cleanup route receives the current account owner's authorization, account page and per-account cleanup operation. It imports no rotation-ticket, root-key or KV engine code.

The public Workshop row only inspects the rows and observations supplied to it. It hides a row only when `evidence_complete` is explicitly true and neither device reports nor file names show its model. Unknown or failed evidence leaves the row visible. This row writes nothing and does not expose cross-account cleanup authority.

The device rules arrive only as the input `rules` row; the tool reads no records. `ports/device-rows.json` preserves source provenance; `test/` checks whole-word evidence, explicit-field precedence, authorization-before-enumeration, bounded pages, dry mode and partial failures.
