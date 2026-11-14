# notice-when-something-shows-up/do-work/mechanisms

One leaf per way of waiting. Each leaf knows nothing about any other leaf, any source, any app, or anything that reacts. A leaf never writes to the log and never dispatches; it hands each transition to its caller. Adding a way to wait is adding one leaf here plus one waiter descriptor row, and it edits nothing else.

## Files

| File | Purpose |
|---|---|
| `elapsed-time.mjs` | Wait for a stretch of time to pass. Contributes `iso_time`, `epoch_ms`, `counter`, `every`, which is exactly the clock record. |
| `filesystem-volume-attachment.mjs` | Wait for a storage volume to become reachable or stop being reachable under a declared attachment place. Identity is read from the volume's own identity file (`.fseventsd/fseventsd-uuid`), so no child process is spawned and it runs under leaf containment. Reports everything currently present on start. A listing or watch the process is forbidden to make throws, so the emitter records it as a fact. |
| `inbound-http-delivery.mjs` | Wait for something delivered over the network on a declared host and port, bounded by a body byte ceiling. Answers 503 when the fact could not be written so the sender retries. |
| `files-someone-finished-putting-here.mjs` | Wait for somebody outside to FINISH putting a unit in a declared place. Completeness is the completion note and nothing else, so a unit still arriving has no note and does not exist to this leaf; there is no timer and no size comparison. The note carries the identity, so a large original is never read to learn what it is, and a note field invented later travels verbatim into `observed_identity` with no edit here. A note that will not parse, or whose declared length disagrees with the bytes beside it, is reported as a REFUSED note rather than skipped. The place is the WRITER'S private volume, read without taking its lease: the start action declares `readable_private_volumes` and binds `BITFIELD_HANDOVER_PLACE` to the resolved root (`architect` `352f9b79`), so the row names an environment key and never a host path. An unresolvable place THROWS and an absent place is an error, because a `.` fallback would watch an empty ephemeral directory forever while looking healthy. |

## The leaf contract

| Export | Shape | Role |
|---|---|---|
| `MECHANISM_REF` | `package::notice-when-something-shows-up::mechanism::<leaf>` | The identity the emitter compares against the row's declared reference. |
| `describeMechanism()` | `{mechanism_ref, detail_fields, conditions}` | Declared identity plus the payload fields this leaf contributes; may not name an arrival field. |
| `readSettings(settings)` | pure | The row's `mechanism_settings` with declared fallbacks. |
| `watchForTransitions(settings, {onTransition, signal, nextSequence, ...injected})` | resident | Returns only when the signal fires; calls `onTransition({condition, observed_identity, detail})` per event. Every host touch is injectable for tests, including `environment`. |

## Dependencies

**Depends on:** `node:fs`, `node:fs/promises`, `node:http`, `node:crypto`. Nothing in this package.
**Depended on by:** `../emit-arrival-fact.mjs` (by plain filename), `../../things-to-store-and-run.json` (stored bytes), `../../tests/`.
