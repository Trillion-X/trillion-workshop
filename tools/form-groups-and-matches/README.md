# tools/form-groups-and-matches/

Keeps groups of anything in a person's records (lists, collections, folders, boards: ordered members, groups inside groups), regroups a tree by the person's own words, and forms matches and small groups of people by grounded expected value, with introductions that wait for every party's consent, and runs a community's matchmaker: on the community's cadence it hands each member's own AI a bounded shortlist to score, forms matches from the cited scores, and opens a one-to-one only once both people said yes themselves. Twelve Workshop tools: `tool:read-my-groups` and `tool:change-my-groups` (through the records door), `tool:regroup-a-tree`, `tool:form-matches`, `tool:check-match-evidence`, `tool:assign-helpers-under-capacity`, `tool:choose-configurations`, and the matchmaker's `tool:advance-a-community-matchmaker`, `tool:answer-in-a-community`, `tool:read-my-community-matches`, `tool:forget-a-person-in-a-community` and `tool:check-community-matching-settings`. Ported from the `group` package's membership nucleus (and the membership graph it used from `ui/show/group`), from the `interaction-program` package's matching policy, and from the Trillion app's community matchmaker (`src/community-matching.mjs` with its introduction states and consent fingerprint).

## Files

| File | Purpose |
|------|---------|
| `read-data/group-graph.mjs` | The membership graph, pure: add, remove, reorder, move, set fields, group a selection, ungroup; a group can never contain itself. |
| `read-data/group-changes.mjs` | A change as a list of plain operations (`add-member`, `move-member`, `group-members`, ...), each handed to its graph function; `changeRoots` names the groups an operation touches. |
| `read-data/group-records.mjs` | Groups as `group` records: the record id of an address, records folded into a graph, and the records to write so what is kept matches a graph. |
| `read-data/tree-to-groups.mjs` | A flat tree (folders, bookmarks, an outline) as groups, and a tree regrouped by intent written in titles. |
| `read-data/match-evidence.mjs` | Profiles from answers and connected facts, and assessments checked against them, all under a contract given as input. |
| `read-data/expected-value.mjs` | The program's policy, the exact product of grounded factors, the clear-cut rule and bounded shortlists. |
| `read-data/select-groups.mjs` | Groups formed by expected value with prepared introductions and their send gate. |
| `read-data/select-configurations.mjs` | Which options go ahead together; only a shared collision ref makes two compete. |
| `read-data/capacity-assignment.mjs` | Helpers assigned within their capacity, from pair answers or from scored candidates; also the row's command (`executeAssignmentOperation`). |
| `read-data/interaction-program-fold.mjs` | The `interaction-program` descriptor reader: a payload as an object or JSON text into a program (unknown fields kept on `extra`), programs by id, and a program's per-day context sequence in day order. Not wired to a row yet. |
| `read-data/console-selectors.mjs` | The community console's pure models: role matrix, permission toggles, measures, sequences, surfaces, programs, setup items and formed matches. Not wired yet. |
| `read-data/feed-selectors.mjs` | The member feed's pure models: posts newest first, relative time, monograms. Not wired yet. |
| `do-work/my-groups.mjs` | The commands of `tool:read-my-groups` and `tool:change-my-groups`: the group records the caller hands in as `records`, read or changed in memory; a change answers the changed records as `keep` (each with the value it expected). No records door. |
| `do-work/regroup-a-tree.mjs` | The command of `tool:regroup-a-tree`. |
| `do-work/form-matches.mjs` | The command of `tool:form-matches`: shortlists or candidates in, groups, introductions and connections out. |
| `do-work/check-match-evidence.mjs` | The command of `tool:check-match-evidence`. |
| `read-data/matchmaker.mjs` | A community's matchmaker, pure, over a book of its records at one time: settings checks, profiles and cited scores, inverted-index shortlists, rounds, groups formed by the leaves above, proposals, double opt-in with the consent of what each person is shown, the one-to-one group, topics, follow-ups, experiment arms, views and erasure. |
| `read-data/matchmaker-records.mjs` | The matchmaker's record kinds and ids, and the book one run loads and changes. |
| `do-work/community-matchmaker.mjs` | The commands of the five matchmaker rows: take the community's records as input (`records`), run the matchmaker, and answer the changed records as `write` (each with the value it expected). No records door. |
| `what-this-tool-does-and-how-to-run-it.json` | The twelve tool rows. Every row runs with `tools/records-door/do-work/run-an-export.mjs`. |
| `part.json` | No module here is offered to other tools. |
| `test/group-graph.test.mjs` | The membership gauntlet: every operation, nesting and the cycle rule (the original graph's twenty cases, and ids that are object property names). |
| `test/group-records.test.mjs` | Record ids, the fold (later wins, removed, misplaced and malformed records) and the minimal writes. |
| `test/group-changes.test.mjs` | Every kind of change through one applier, and the hard cases as writes. |
| `test/my-groups.test.mjs` | The two group rows on records handed in: fresh, existing, no-op, a loop across stored groups, ungrouping, a tree import, the read, a spoofed record. |
| `test/tree-to-groups.test.mjs` | The tree bridge (twelve cases) and regrouping by intent (ten cases), on a made-up bakery's folders. |
| `test/match-fixtures.mjs` | A made-up bakers' circle: three factors, two scope fields, candidates and consents. |
| `test/select-groups.test.mjs`, `test/expected-value.test.mjs`, `test/match-evidence.test.mjs`, `test/matchmaker-gauntlet.test.mjs`, `test/capacity-assignment.test.mjs`, `test/select-configurations.test.mjs` | The original package's matching tests, on the made-up program. |
| `test/interaction-program-fold.test.mjs`, `test/console-selectors.test.mjs`, `test/feed-selectors.test.mjs` | The ported descriptor, console and feed readers, on made-up rows: the original assertions (JSON text, unknown fields, latest wins, the role matrix and its deletion test, measures, sequences, posts, monograms). |
| `test/rows.test.mjs` | Every row run as the container runs it, against its sample; the matchmaker rows reach only its own kinds. |
| `test/community-fixtures.mjs` | A made-up woodworkers' guild: its own three factors, two scope fields, six questions and every word it says. |
| `test/community-matchmaker.test.mjs` | The original matchmaker's cases on the guild: default on and off, jobs per round, uncited scores, a pair introduced and talking, double opt-in, an AI's yes refused, a changed introduction, a no, expiry, a switch turned off, the clock, two yeses at once, discover, ties, experiments, erasure, follow-ups, and the bound on shortlist work. |
| `test/community-rows.test.mjs` | The matchmaker rows with the records handed in and each answer's `write` applied to a small in-memory store, from a round on the clock to the one-to-one and erasure. |

## Key Types / Functions

| Type / Function | Shape | Role |
|---|---|---|
| address | `{ family, parts: { name: text } }` | What a member is and what a group is; a member whose address is a group nests it. |
| group | `{ groupRef, memberOrder: [memberId], members: { memberId: { memberId, nodeRef, role?, presentation? } } }` | One group; its order is `memberOrder`. |
| `groupRecordId(address)` | `group:<family>:<name>=<text>&...` | The one record a group is kept in. |
| `expected_value` policy | `{ factors, scope_fields, minimum_expected_value?, minimum_distinguishable_delta?, require_scope? }` | What a match's value is the product of and what scope it is for; required with every matching request. |
| contract | `{ factors, primitives, scope_fields, questions, citation_requirements, authority, forbidden_interventions }` | The intake questions and what each factor must cite; required by `tool:check-match-evidence`. |
| `selectGroups(request)` | `→ { groups, introductions, ready_introductions, blocked_introductions, unmatched, unmatched_details, instrumentation }` | The grouping policy. |
| `solveCapacityConstraints(request)` | `→ { assignments, unmatched, capacity_usage, instrumentation }` | The capacity solver. |
| community settings | `match-community:C` = `{ title, owner, created_at, matching }` | Everything a community chooses; `tool:check-community-matching-settings` names what is missing. `matching.contract` is the contract above; `matching.questions` must cover every claim kind a factor cites. |
| matchmaker records | `match-member:C:P`, `match-round:C:R`, `match-ask:C:R:P`, `match:C:M`, `match-answer:C:M:P`, `record:calendar-task:match:C:KEY`, `group:introduction:...` | One record kind per fact; a member's answers go only to their own records. Tasks are the engine's `calendar-task` records: `{ status: "To do", assignees, sent_by, title, description, input, request_key, sent_at }`. |
| `openCommunity({ communityId, book, now })` | `→ { apply, tick, nextAt, myMatching, forget, stateOf }` | The matchmaker over one book at one time. |
| match state | `proposed`, `one_yes`, `waiting_for_ais`, `introduced`, `talked`, `passed`, `expired` | Read from the match and its answers, never stored; the words each shows are `matching.state_words`. |
| consent | `consentOf({ text, recipients, shared, expires_at })` | One BLAKE3 identity per part; a yes holds while its consent matches what its person is shown now. |
| `shortlistsFor(members, { size, postingCap, seen })` | `→ { shortlists, comparisons }` | Inverted index over categories and answer words; at most members x tokens x postingCap comparisons. |

### Running a community's matchmaker

1. The community's owner keeps its settings as the `match-community` record (check them first with `tool:check-community-matching-settings`) and each member as a `match-member` record `{ person, name, state: "member", answers: {}, categories: [] }`.
2. The owner declares their own wake (`wake-declaration` in their own records): `{ tool: "tool:advance-a-community-matchmaker", id, on: { time: { every_ms } }, budget, input: { community_id } }`, and switches it on (`wake:switch`).
3. Each tick starts a round when due, closes it at its deadline, makes introductions and hands follow-ups. Each task is a `calendar-task` record in the community's records, assigned to its person. A member's AI pulls its own To do tasks with `tool:read-my-community-matches`, which also gives `wake_at`, the time the community's clock next acts, so the member side wakes then and pulls once. It answers through `tool:answer-in-a-community`. Nothing is written into another person's account.

## Invariants

- A group never contains itself at any depth; a change that would make it so is refused whole and nothing is written.
- Member ids and every other identity are the caller's; nothing here invents one. A parent made by intent takes its id from `new_parent_ids` when given.
- Only groups that changed are written; a group that is gone is removed. A record whose id is not its own group's id is not read as that group.
- A match's value is the exact product of the program's factors, each grounded in cited evidence with a score in (0, 1]. Similarity from a search only breaks ties. A missing, zero or uncited factor, or a cut between equal values, forms no group.
- Work is bounded by the shortlist size: subjects x shortlist size, and no pair outside a shortlist is ever looked at.
- An introduction may be sent only when its initiative is pre-authorized and every party (members and anyone a candidate names) has approved with their own value and none has vetoed. `tool:form-matches` gives connections only for those, and sends and writes nothing.
- A helper is never booked past capacity, and nobody is assigned to themself.
- Nothing here is any program's or person's: factors, scope fields, questions, citation rules, consent words, access tiers, group sizes and capacities all arrive in the request. The tests use made-up names, and a test checks the matching code has no randomness and no branch on who someone is.
- The matchmaker runs no model: every profile, score and topic is a member's own AI's answer to a job it was handed. Each member's AI scores at most `shortlist_size` people a round.
- A matchmaker introduction is double opt-in. A yes counts only while the run that carried it was started by the person on their own page, and for the consent of what that person is shown now; an AI may only say no. The page stamp is the engine's: `tool:answer-in-a-community` reads `{input, task}` on standard input, and `consent.yes_needs` (`{ field: "origin", equals: "page" }`, the engine's tool-runs.json `page_origin`) is checked against the run's task, which no input can set. A run an AI key, a wake or a grant starts carries no `origin`, so its yes is refused with the screen to open. Nobody is in a one-to-one group until every member's yes holds.
- The same people are never proposed twice in one community; a match that passed or expired is never proposed again.
- A matching answer that holds the community's contact pattern is refused, because other members' AIs read it.
- Erasure removes everything that names the person, including their place and scores in other members' asks and waiting score jobs.

## Dependencies

**Depends on:** `tools/records-door` (its runner for every row; the group rows take their records as input and reach no door), `tools/content-identity` for the consent identity (with the `@noble/hashes` module it imports), Node 24 in the tool container.

**Not carried from the Trillion app's matchmaker:** each candidate's level (no standing owner here); the request-an-introduction road beside discover; the copy-rule check of its words (the community's words are its own); and the arm weights' feedback (`chance_best`): the keeper's view gives each arm's shown and converted events for an experiment owner, and the arms' weights stay the community's settings.

**Members on other accounts:** a member answers and reads at the holder's door through the community's act grant (`sharing:LABEL` with `tools: [tool:answer-in-a-community, tool:read-my-community-matches]`, `identity: self`): the engine sets `grant_person` to that member, and both rows refuse any other `person`. Their To do tasks and `wake_at` come with their view, so nothing is written into their account. **What the engine does not give yet:** a member's page at their own account cannot yet carry its page stamp to the holder's door, so a member on another account says yes only once that carry exists; their AI's no works now.

**Not carried:** the old group read and write targets' engine framing (identity-text read-current frames, write batches, host partition labels, producer requests), the interaction-program storage key and its ten ref addresses (retired, see below), the interaction-program screens and process mounts (see below), the subject-participant hosted join doorway (access-rule admission, signed owner events, engine CAS writes: joining a group is `add-member` here), the board surfaces and screens (screens), and the group package's board features (layouts, connectors, exports and imports, board analytics), which belong to a board tool.

**Depended on by:** Trillion, which reads `what-this-tool-does-and-how-to-run-it.json` when it deploys.

## Carried from interaction-program

The pure readers of the `interaction-program` package are ported here with their tests, and no tool row or caller reaches them yet (not wired):

| Ported file | What it is |
|---|---|
| `read-data/interaction-program-fold.mjs` | `foldInteractionProgram`: an object or JSON-text payload into `{ id, label, pairing, extra }`, with fields it does not know kept on `extra`. `foldInteractionPrograms`: programs by id, the later record wins. `readDailySequence`: a program's per-day context sequence, days in day order. |
| `read-data/console-selectors.mjs` | The community console's models: role matrix and permission toggle, measure, sequence, surface, program, setup item and formed match. |
| `read-data/feed-selectors.mjs` | The member feed's models: post models (newest first; operator or member from the post's own data), relative time, monogram. |

Their tests are `test/interaction-program-fold.test.mjs`, `test/console-selectors.test.mjs` and `test/feed-selectors.test.mjs`. The original assertions run on made-up rows, because the package's seed rows are not in this folder.

Retired, not ported (the lead's ruling for this port, Nov 20 2026): the descriptor's storage key (`package::interaction-program::program::<id>`) and the ten Envelope-address refs it named. A program's ref fields are plain data here, kept on `extra` and read by the code that owns each one.

Not carried: the community console and feed screens (`show/mount-community-console.tsx`, `show/mount-community-feed.tsx`; their data layer still calls the old package runtime), the compute process mounts (`do-work/process-scripts/`), the package's seed records (`things-to-store-and-run.json`, with its `run-match-cycle` definition) and its held tests. The original files are in Workshop history at commit 352331c28 under `tools/form-groups-and-matches/from-bitfield-packages/interaction-program/`. That folder was removed from this tree by commit 332230b33, and its bytes are kept in the private repository at commit 2ffc5af.

The grouping, configuration, capacity and intake-evidence leaves of the package are in `tools/community-logic-match/` and `tools/match-community-members/` (vendored from the package with import paths changed); `read-data/select-groups.mjs`, `expected-value.mjs`, `select-configurations.mjs`, `capacity-assignment.mjs` and `match-evidence.mjs` here are a second implementation of the same jobs and stay until their rows are pointed at the vendored originals.
