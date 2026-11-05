# tools/hold-one-thing-until-done/

Covers a person's workspace until every required setup step is done, then holds the one must-do row that unblocks the most until it is done, set aside with a reason or handed back to their AIs. It reads the person's setup steps, must-do rows and hold setting through the records door, answers whether the cover stands and which one row is held, and writes each change of the hold setting on condition of the value just read. A page draws the answer (the full-window Get started cover, then the held row); this tool decides, and sends nothing.

- **The decisions moved here as they were.** `read-data/needs-you-hold.mjs` is the hold (which row holds, setting aside, handing back, the stakes for turning it off, off only after a delay, every rule DATA) and `read-data/required-cover.mjs` is the decision the Get started cover reads (`setupScreenComplete`), both moved from the trillion app with their invariants.
- **The cover fails closed.** `requiredCover(screen, gate)` is `{ covered, key }`: covered until required setup is proved. A gate row with no `key` still covers, under `required-setup`. Setup step rows that say nothing answer `covered: null`, never false, so the caller reads the Get started answer instead of opening everything.
- **The person's own rows.** Read and written only as `read-data/hold-rows.json` names them, and the rows' rights grant no more:

| Row | Record | How |
|-----|--------|-----|
| The hold setting | `setting:needs_you_hold` (type `setting`, the value under `value`) | read; changed by `tool:change-what-holds-me` only |
| The hold rules | `setting:needs_you_hold_rules` | read; a request may carry `rules` instead |
| The gate | `setting:required_setup_gate` (`{ key }`) | read; a request may carry `gate` instead |
| Must-do rows | `record:waiting-on-you` (the person's Waiting on you list) | listed; each row not `Done` is one card, mapped by `must_do.card` |
| Setup steps | `record:setup-steps` (`required`, `status`) | listed; a request may carry the Get started answer as `setup` instead |

- **One write per change, conditioned on what was read.** Setting aside, handing back, choosing a stake, asking off and turning on each write the whole hold setting with `expected` set to what was read. A setting changed meanwhile (another page, another device) answers `{ changed: false, conflict: true }` and nothing is written. The `request_key` makes the same change safe to send again.
- **Jobs are answered, not sent.** A change answers the jobs for the person's AIs (weigh a reason, finish a thing handed back, carry out a stake); the caller hands them.

## Files

| File | Purpose |
|------|---------|
| `read-data/needs-you-hold.mjs` | The hold: `holdView`, `rankedThings`, `heldThing`, `controlOf`, `setAside`, `handBack`, `chooseStake`, `askOff`, `turnOn`, `stakeJob`, `heldInput` |
| `read-data/required-cover.mjs` | `setupScreenComplete`, `requiredCover`, `requiredCoverOfRows`, `DEFAULT_COVER_KEY` |
| `read-data/hold-rows.json` | Which records hold the setting, rules, gate, must-do rows and setup steps, and how a must-do row becomes a card |
| `do-work/hold.mjs` | `seeWhatHoldsMe` and `changeWhatHoldsMe`, run by `tools/records-door/do-work/run-an-export.mjs` |
| `do-work/needs-you-hold-route.mjs` | `answerNeedsYouHoldRoute`, `tool:answer-the-needs-you-hold-route`: the page routes GET and POST /work/api/needs-you-hold as a route tool (`{ path, method, query, body, browser }` in, `{ status, body }` out), answering as old trillion's needsYouHold did (src/worker.mjs:1100-1121, src/native-waiting-account-owner.mjs): the read with `said` and `words` (503 busy when it fails), each change by its old op name (aside, hand_back, stake, off, on; seen; read) with the read after it, and each job kept once as an `ai-job` for the person's AIs. Contract: `ports/needs-you-hold-route.json`. |
| `part.json` | The public modules |
| `tool-rows.json` | The three Workshop rows |
| `test/needs-you-hold-route.test.mjs` | The route tool against the records door stand-in: the read and its words, free, busy, a change with its job handed once, refusals (400), a conflict (409), the held thing kept, seen marking notices read (with old trillion's phone-tap test), 404. |
| `test/needs-you-hold-old.test.mjs` | Old trillion's test/needs-you-hold.test.mjs, the tests whose subject is here, assertions unchanged; its header names where the others run |
| `test/hold.test.mjs` | The cover, ranking, each change, a conflict, a resent change, refusals and each row's sample run in the container (made-up rows) |

## The rows

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:see-what-holds-me` | `seeWhatHoldsMe` | `{ cover: { covered, key }, hold }`: whether setup still covers everything, and the one row held (nothing is held while the cover stands) |
| `tool:change-what-holds-me` | `changeWhatHoldsMe` | `set-aside`, `hand-back`, `choose-stake`, `turn-off` or `turn-on`, written on condition; answers the jobs to hand |

## The page route: what it does and does not do

Like old trillion's needsYouHold, the route keeps the held thing as `setting:needs_you_held` (`{ key, title }`, null when nothing is held, written only when it changed), and `seen` marks read the notices the held thing's own device runs told (each `hold.devices.when_held` run whose input `key` names the thing), on the page's surface with `from: 'thing'`. It marks them with the moved tell owner's `markRead` (tools/tell-one-person-something-through-every-way-they) over the person's `told-the-person` records.

Old needsYouHold also did three things this route cannot, each for an exact reason:

- **The cards.** Old trillion read them from the whole Waiting on you answer (src/native-waiting-account-owner.mjs `waiting`, every source of src/waiting-on-you.json). This route reads the person's own Waiting on you rows (`record:waiting-on-you`) only. The rest of that answer is not a route run's to read: see the waiting-on-you notes in the lane report (shared-space assignments through the network relay, stuck work on the agents board, connections needing the person, social posts, voices and their Namespace clip searches, and what the AIs made).
- **The walk-away nudge** (src/waiting-nudge.mjs `prepareForHold`) weighs that whole answer's sections and their `step` DATA, so it waits for the whole answer.
- **The device tools** of `hold.devices` (`when_held`: tool:hold-a-device-quiet, tool:take-me-there; `when_free`: tool:release-a-device) are other Workshop tools. A run's capability holds only the records door's `run_operations` (trillion-rust src/record_value/records-routes.json: records:read, records:list, records:search, records:write, workspace:read, workspace:write, sharing.receive, wake:switch, wake:causes), and none of them starts another tool's run (`tools:run` at `@workshop-tools`).
- A notice's delivery receipt (old `tell-delivery:<key>`, a Workshop fact) is not a record, so a read mark does not reach it.
