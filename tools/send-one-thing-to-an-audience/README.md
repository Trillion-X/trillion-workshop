# Send one thing to an audience

Source-preserving port of the old audience-send owner. `read-data/audience-sends.mjs`
keeps normalization, exclusions, schedules, per-channel receipts, opt-outs,
bounded retries, unknown-result suppression and historical receipt import.
`audienceRecords(door)` uses the existing records door and compares observed
records for claims and subsequent writes, so independently launched clients and
stale processes cannot overwrite each other's delivery ownership.

`readAudienceSendContent(door)` reads the five independently addressed rows of
type `audience-send-content`, ids `audience-send-content:channels`, `:timings`,
`:audience_states`, `:words` and `:screen`. Each row value is `{ content: section }`.
Missing rows are empty; failed reads propagate. No runtime content is bundled.

Use `makeAudienceSends({ eeaf: audienceRecords(door), readContent: () =>
readAudienceSendContent(door), ...host })`. The host must supply admitted list and
formula reads, current sharing/link state, scheduling, price experiments and
delivery roads. These native service bindings are not supplied by this port;
there is no runnable tool row claiming them and no retired Worker engine import.
Every host read may be asynchronous. Every delivery road must answer typed
`sent` and optional `unknown`; completion alone never acknowledges delivery.

Tests use synthetic records and admitted-effect stand-ins and send nothing.
Source-first contracts are in `ports/`; their baseline commit must name a real
source-baseline ancestor before shipping. This is not an installed-runtime
qualification.
