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
| `test/needs-you-hold-route.test.mjs` | The route tool against the records door stand-in: the read and its words, free, busy, a change with its job handed once, refusals (400), a conflict (409), the held thing kept, seen marking notices read (with old trillion's phone-tap test), the device tools started once per change, a waiting row Trillion can do left out, 404. |
| `test/needs-you-hold-nudge-old.test.mjs` | Old trillion's test/needs-you-hold.test.mjs tests whose subject moved here with the route: AI-doable cards handed back before the hold picks, walking away carries out the stake, and the held fact and its device runs name the person's own card (on the route) |
| `read-data/waiting-weigh.mjs`, `read-data/waiting-nudge.mjs`, `read-data/waiting-on-you.json` | The doer gate and the walk-away nudge, moved from trillion, and the Waiting on you DATA they read |
| `test/needs-you-hold-old.test.mjs` | Old trillion's test/needs-you-hold.test.mjs, the tests whose subject is here, assertions unchanged; its header names where the others run |
| `test/hold.test.mjs` | The cover, ranking, each change, a conflict, a resent change, refusals and each row's sample run in the container (made-up rows) |

## The rows

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:see-what-holds-me` | `seeWhatHoldsMe` | `{ cover: { covered, key }, hold }`: whether setup still covers everything, and the one row held (nothing is held while the cover stands) |
| `tool:change-what-holds-me` | `changeWhatHoldsMe` | `set-aside`, `hand-back`, `choose-stake`, `turn-off` or `turn-on`, written on condition; answers the jobs to hand |

## The page route: what it does and does not do

Like old trillion's needsYouHold, the route keeps the held thing as `setting:needs_you_held` (`{ key, title }`, null when nothing is held, written only when it changed), and `seen` marks read the notices the held thing's own device runs told (each `hold.devices.when_held` run whose input `key` names the thing), on the page's surface with `from: 'thing'`. It marks them with the moved tell owner's `markRead` (tools/tell-one-person-something-through-every-way-they) over the person's `told-the-person` records.

A read first gathers what old trillion's Waiting on you reader answered from what the route can read: each card kept once (`sameOnce`) and weighed by the doer gate (`read-data/waiting-weigh.mjs`, over `tools/who-does-each-step` and the old doer DATA `tools/shared-code/src/who-does-it.json`), so a card Trillion can do, or one with nothing to press (`hold.no_control`), is left out of the person's view. Then the walk-away nudge's `prepareForHold` (`read-data/waiting-nudge.mjs`) hands what waited long enough and Trillion can do to the AIs, once per card, as an `ai-job`, and the hold is weighed over the rest. A new thing held, or nothing held any more, starts the person's device tools (`hold.devices`: `when_held` tool:hold-a-device-quiet and tool:take-me-there, `when_free` tool:release-a-device) once for that change, through the run's door: the row declares them in `runs` (the brief's contract A), and a run that fails is let go, as old trillion's did.

`read-data/waiting-weigh.mjs` and `read-data/waiting-nudge.mjs` are old trillion's src/waiting-weigh.mjs and src/waiting-nudge.mjs, moved byte for byte (commit bebf1966) and then changed only in their import paths (`ports/waiting-weigh.json`, `ports/waiting-nudge.json`). `read-data/waiting-on-you.json` carries the old Waiting on you DATA they read (`nudge`, and `hold.no_control`, under which the person's own hold rules lie).

### Not a whole port yet

Old needsYouHold read the whole Waiting on you answer (src/native-waiting-account-owner.mjs `waiting`, every source of src/waiting-on-you.json). The route reads its `asks` section only, the person's own Waiting on you rows (`record:waiting-on-you`). The other sections' sources are not the person's records today, each for this reason:

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
