# tools/hold-one-thing-until-done/

Covers a person's workspace until every required setup step is done, then holds the one must-do row that unblocks the most until it is done, set aside with a reason or handed back to their AIs. The two tools read and keep nothing: the person's setup steps, must-do rows, hold setting and hold rules come in with the request (the person's AI reads them from a store), and the answer holds the cover, the one row held, and what to keep (the next hold setting, the tasks, the held fact and the device runs to start). A page draws the answer (the full-window Get started cover, then the held row); the shared action owner publishes any AI work through the existing AI-work owner.

- **The decisions moved here as they were.** `read-data/needs-you-hold.mjs` is the hold (which row holds, setting aside, handing back, the stakes for turning it off, off only after a delay, every rule DATA) and `read-data/required-cover.mjs` is the decision the Get started cover reads (`setupScreenComplete`), both moved from the trillion app with their invariants.
- **The cover fails closed.** `requiredCover(screen, gate)` is `{ covered, key }`: covered until required setup is proved. A gate row with no `key` still covers, under `required-setup`. Setup step rows that say nothing answer `covered: null`, never false, so the caller reads the Get started answer instead of opening everything.
- **The rows come in with the request.** The person's AI reads the rows `read-data/hold-rows.json` names and sends them: the hold setting as `state` (`setting:needs_you_hold`), the rules as `rules` (`setting:needs_you_hold_rules`), the gate as `gate` (`setting:required_setup_gate`, `{ key }`), the Waiting on you rows as `must_do` (`record:waiting-on-you`, each not `Done` is one card, mapped by `must_do.card`) or the whole waiting answer as `things`, and the setup steps as `setup_steps` (`record:setup-steps`, `required`, `status`) or the Get started answer as `setup`. The held thing last kept goes in as `kept_held`.
- **Each change answers the whole next setting.** Setting aside, handing back, choosing a stake, asking off and turning on answer the whole next hold setting (`state`) and its jobs (`jobs`, `calendar-task` records) for the caller to keep together. Jobs have `sent_by: null`, a real record producer, the exact `source_task` trigger and original structured input. Stable BLAKE3 identities make a repeated trigger one job id.

## Files

| File | Purpose |
|------|---------|
| `read-data/needs-you-hold.mjs` | The hold: `holdView`, `rankedThings`, `heldThing`, `controlOf`, `setAside`, `handBack`, `chooseStake`, `askOff`, `turnOn`, `stakeJob`, `heldInput` |
| `read-data/required-cover.mjs` | `setupScreenComplete`, `requiredCover`, `requiredCoverOfRows`, `DEFAULT_COVER_KEY` |
| `read-data/hold-rows.json` | Which records hold the setting, rules, gate, must-do rows and setup steps, and how a must-do row becomes a card |
| `do-work/hold.mjs` | `seeWhatHoldsMe` and `changeWhatHoldsMe`, run by `do-work/run-given.mjs`; they read and keep nothing |
| `read-data/hold-answer.mjs` | `holdAnswer` (the read worked out from the request: the doer gate, the walk-away nudge, the view, the held fact, the device runs), `holdJobRecords`, `answerOfRows` |
| `do-work/needs-you-hold-route.mjs` | `answerNeedsYouHoldRoute`, `tool:answer-the-needs-you-hold-route`: the page routes GET and POST /work/api/needs-you-hold as a route tool (`{ path, method, query, body, browser }` in, `{ status, body }` out), answering as old trillion's needsYouHold did (src/worker.mjs:1100-1121, src/native-waiting-account-owner.mjs): the read with `said` and `words` (503 busy when it fails), each change by its old op name (aside, hand_back, stake, off, on; seen; read) with the read after it, and each task kept once as a `calendar-task` for the person's AIs. Contract: `ports/needs-you-hold-route.json`. |
| `part.json` | The public modules |
| `tool-rows.json` | The three Workshop rows |
| `test/needs-you-hold-route.test.mjs` | The route tool over the records handed in as `stored.records`, with what it keeps applied the way a store applies it (`test/kept-rows.mjs`): the read and its words, free, busy, a change with its job kept once, refusals (400), a held setting that moved refused by the store, the held thing kept, seen marking notices read (with old trillion's phone-tap test), the device runs answered once per change, a waiting row Trillion can do left out, 404. |
| `test/needs-you-hold-nudge-old.test.mjs` | Old trillion's test/needs-you-hold.test.mjs tests whose subject moved here with the route: AI-doable cards handed back before the hold picks, walking away carries out the stake, and the held fact and its device runs name the person's own card (on the route) |
| `read-data/waiting-weigh.mjs`, `read-data/waiting-nudge.mjs`, `read-data/waiting-on-you.json` | The doer gate and the walk-away nudge, moved from trillion, and the Waiting on you DATA they read; the DATA holds no host, the caller passes `nudge.own_origins` (the origins of the person's own Trillion) |
| `test/needs-you-hold-old.test.mjs` | Old trillion's test/needs-you-hold.test.mjs, the tests whose subject is here, assertions unchanged; its header names where the others run |
| `test/hold.test.mjs` | The cover, ranking, each change, a conflict, a resent change, refusals and each row's sample run in the container (made-up rows) |

## The rows

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:see-what-holds-me` | `seeWhatHoldsMe` | `{ cover: { covered, key }, hold, jobs, held_fact?, device_runs }`: whether setup still covers everything, and the one row held (nothing is held while the cover stands) |
| `tool:change-what-holds-me` | `changeWhatHoldsMe` | `set-aside`, `hand-back`, `choose-stake`, `turn-off` or `turn-on`, answered as the next setting with its jobs |

## The page route: what it does and does not do

Like old trillion's needsYouHold, the route keeps the held thing as `setting:needs_you_held` (`{ key, title }`, null when nothing is held, written only when it changed), and `seen` marks read the notices the held thing's own device runs told (each `hold.devices.when_held` run whose input `key` names the thing), on the page's surface with `from: 'thing'`. It marks them with the moved tell owner's `markRead` (tools/tell-one-person-something-through-every-way-they) over the person's `told-the-person` records.

A read publishes every `weighCards.toAis` hand-off before excluding that card; the earlier route discarded those hand-offs. A read first gathers what old trillion's Waiting on you reader answered from what the route can read: each card kept once (`sameOnce`) and weighed by the doer gate (`read-data/waiting-weigh.mjs`, over `tools/who-does-each-step` and the old doer DATA `tools/shared-code/src/who-does-it.json`), so a card Trillion can do, or one with nothing to press (`hold.no_control`), is left out of the person's view. Then the walk-away nudge's `prepareForHold` (`read-data/waiting-nudge.mjs`) hands what waited long enough and Trillion can do to the AIs, once per card, as a `calendar-task`, and the hold is weighed over the rest. A new thing held, or nothing held any more, starts the person's device tools (`hold.devices`: `when_held` tool:hold-a-device-quiet and tool:take-me-there, `when_free` tool:release-a-device) once for that change, through the run's door: the row declares them in `runs` (the brief's contract A), and a run that fails is let go, as old trillion's did.

`read-data/waiting-weigh.mjs` and `read-data/waiting-nudge.mjs` are old trillion's src/waiting-weigh.mjs and src/waiting-nudge.mjs, moved byte for byte (commit bebf1966) and then adapted in their import paths; the section-control call now passes the actual section so its finish and batch controls survive (`ports/waiting-weigh.json`, `ports/waiting-nudge.json`). `read-data/waiting-on-you.json` carries the old Waiting on you DATA they read (`nudge`, and `hold.no_control`, under which the person's own hold rules lie).

### Not a whole port yet

Old needsYouHold read the whole Waiting on you answer (src/native-waiting-account-owner.mjs `waiting`, every source of src/waiting-on-you.json). Both canonical and route reads now share the existing exported `read` lifecycle in `do-work/needs-you-hold-route.mjs`. An authoritative caller can supply the complete waiting answer as `things`, preserving every source section, finish, batch and consent reference. With no projection supplied, the default calls the existing source-row aggregator through `what-is-waiting-on-me/read-data/waiting-records.mjs`. It reads grounded record/tool adapters and preserves each missing owner in `waiting_sources`; coverage is complete only when every declared source is read. This is a source boundary, not evidence of installed full parity. Historical source dependencies that still require current-owner integration follow:

| Section | Old source | Why the route cannot read it |
|---|---|---|
| `given` | shared-space assignments (`network.assignedTo` through the network relay) | the relay's items are another service's, not the person's records |
| `approve` | social post drafts (`posts.posts.list`) | `post` records exist, but no record is shown to be the old post owner's list with its `status: draft` and `updated_at`; reading them would be a guess |
| `look` | what the AIs made (`readNewWork` over the old store's SQL, unread counts from the relay) | not records |
| `decide`, `answer` | the source engine's decision summaries (`engine.summaries`) | `decision` records exist, but the summaries' `status: needs_decision` and `outcome_question` are the old engine's projection, not a record field |
| `stuck` | stuck work on the agents board (`claims.stuckWork`, handoffs `blocked`) | handoff claims are the agents board's, not records |
| `turn-on-notices` | notification devices (`devices.listed`) | account mechanics: the files door's `setup_facts` (contract C) answers them, but its answer's shape is the engine lane's; this route does not read it yet |
| `sign-in` | connections needing the person (`connectionsNeedingYou`) | the held connection owner's, not records |
| `voices` | unnamed speakers in messages and their Namespace clip searches | the clip searches are the Namespace's, not records |

Old needsYouHold also settled the Waiting on you rules first (`settleWaitingRules`: done-when checks over saved logins, connections, computer sources, files, arrivals and work), which read the same non-record owners.

Two more differences:

- A notice's delivery receipt (old `tell-delivery:<key>`, a Workshop fact) is not a record, so a read mark does not reach it.
- The nudge's own wake (`runDue`: the reminder ladder, the live board, the walked-away stake) is not the route's: the route runs only `prepareForHold`, as old needsYouHold did.

The route and both rows read and keep nothing. The page route takes the person's records as `stored.records` and answers the rows to keep (`keep`, each with the `expected` record it was handed, so the store refuses a row whose record moved) and the device runs to start (`runs`, started only after the kept rows are written). The rows run through `do-work/run-given.mjs`. These checks establish source behavior, not installed device execution.
