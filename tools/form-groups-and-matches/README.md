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
| `do-work/my-groups.mjs` | The commands of `tool:read-my-groups` and `tool:change-my-groups` over the records door. |
| `do-work/regroup-a-tree.mjs` | The command of `tool:regroup-a-tree`. |
| `do-work/form-matches.mjs` | The command of `tool:form-matches`: shortlists or candidates in, groups, introductions and connections out. |
| `do-work/check-match-evidence.mjs` | The command of `tool:check-match-evidence`. |
| `read-data/matchmaker.mjs` | A community's matchmaker, pure, over a book of its records at one time: settings checks, profiles and cited scores, inverted-index shortlists, rounds, groups formed by the leaves above, proposals, double opt-in with the consent of what each person is shown, the one-to-one group, topics, follow-ups, experiment arms, views and erasure. |
| `read-data/matchmaker-records.mjs` | The matchmaker's record kinds and ids, and the book one run loads and changes. |
| `do-work/community-matchmaker.mjs` | The commands of the five matchmaker rows: load the community's records through the door, run the matchmaker, write what changed. |
| `tool-rows.json` | The twelve tool rows. Every row runs with `tools/records-door/do-work/run-an-export.mjs`. |
| `part.json` | No module here is offered to other tools. |
| `test/group-graph.test.mjs` | The membership gauntlet: every operation, nesting and the cycle rule (the original graph's twenty cases, and ids that are object property names). |
| `test/group-records.test.mjs` | Record ids, the fold (later wins, removed, misplaced and malformed records) and the minimal writes. |
| `test/group-changes.test.mjs` | Every kind of change through one applier, and the hard cases as writes. |
| `test/my-groups.test.mjs` | The two group rows against the stand-in records door: fresh, existing, no-op, a loop across stored groups, ungrouping, a tree import, the read. |
| `test/tree-to-groups.test.mjs` | The tree bridge (twelve cases) and regrouping by intent (ten cases), on a made-up bakery's folders. |
| `test/match-fixtures.mjs` | A made-up bakers' circle: three factors, two scope fields, candidates and consents. |
| `test/select-groups.test.mjs`, `test/expected-value.test.mjs`, `test/match-evidence.test.mjs`, `test/matchmaker-gauntlet.test.mjs`, `test/capacity-assignment.test.mjs`, `test/select-configurations.test.mjs` | The original package's matching tests, on the made-up program. |
| `test/rows.test.mjs` | Every row run as the container runs it, against its sample; the matchmaker rows reach only its own kinds. |
| `test/community-fixtures.mjs` | A made-up woodworkers' guild: its own three factors, two scope fields, six questions and every word it says. |
| `test/community-matchmaker.test.mjs` | The original matchmaker's cases on the guild: default on and off, jobs per round, uncited scores, a pair introduced and talking, double opt-in, an AI's yes refused, a changed introduction, a no, expiry, a switch turned off, the clock, two yeses at once, discover, ties, experiments, erasure, follow-ups, and the bound on shortlist work. |
| `test/community-rows.test.mjs` | The matchmaker rows against the stand-in records door, from a round on the clock to the one-to-one and erasure. |

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
| matchmaker records | `match-member:C:P`, `match-round:C:R`, `match-ask:C:R:P`, `match:C:M`, `match-answer:C:M:P`, `ai-job:match:C:KEY`, `group:introduction:...` | One record kind per fact; a member's answers go only to their own records. Jobs are the engine's `ai-job` road: `{ status: "waiting", for, said, job, input }`. |
| `openCommunity({ communityId, book, now })` | `→ { apply, tick, nextAt, myMatching, forget, stateOf }` | The matchmaker over one book at one time. |
| match state | `proposed`, `one_yes`, `waiting_for_ais`, `introduced`, `talked`, `passed`, `expired` | Read from the match and its answers, never stored; the words each shows are `matching.state_words`. |
| consent | `consentOf({ text, recipients, shared, expires_at })` | One BLAKE3 identity per part; a yes holds while its consent matches what its person is shown now. |
| `shortlistsFor(members, { size, postingCap, seen })` | `→ { shortlists, comparisons }` | Inverted index over categories and answer words; at most members x tokens x postingCap comparisons. |

### Running a community's matchmaker

1. The community's owner keeps its settings as the `match-community` record (check them first with `tool:check-community-matching-settings`) and each member as a `match-member` record `{ person, name, state: "member", answers: {}, categories: [] }`.
2. The owner declares their own wake (`wake-declaration` in their own records): `{ tool: "tool:advance-a-community-matchmaker", id, on: { time: { every_ms } }, budget, input: { community_id } }`, and switches it on (`wake:switch`).
3. Each tick starts a round when due, closes it at its deadline, makes introductions and hands follow-ups. Each job is an `ai-job` record in the community's records for its person. A member's AI pulls its own waiting jobs with `tool:read-my-community-matches`, which also gives `wake_at`, the time the community's clock next acts, so the member side wakes then and pulls once. It answers through `tool:answer-in-a-community`. Nothing is written into another person's account.

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

**Depends on:** `tools/records-door` (its runner for every row, and its client for the group and matchmaker rows), `tools/content-identity` for the consent identity (with the `@noble/hashes` module it imports), Node 24 in the tool container.

**Not carried from the Trillion app's matchmaker:** each candidate's level (no standing owner here); the request-an-introduction road beside discover; the copy-rule check of its words (the community's words are its own); and the arm weights' feedback (`chance_best`): the keeper's view gives each arm's shown and converted events for an experiment owner, and the arms' weights stay the community's settings.

**Members on other accounts:** a member answers and reads at the holder's door through the community's act grant (`sharing:LABEL` with `tools: [tool:answer-in-a-community, tool:read-my-community-matches]`, `identity: self`): the engine sets `grant_person` to that member, and both rows refuse any other `person`. Their waiting jobs and `wake_at` come with their view, so nothing is written into their account. **What the engine does not give yet:** a member's page at their own account cannot yet carry its page stamp to the holder's door, so a member on another account says yes only once that carry exists; their AI's no works now.

**Not carried:** the old group read and write targets' engine framing (identity-text read-current frames, write batches, host partition labels, producer requests), the interaction-program descriptor fold with its ten references to old packages, the subject-participant hosted join doorway (access-rule admission, signed owner events, engine CAS writes: joining a group is `add-member` here), the board surfaces and screens (screens), and the group package's board features (layouts, connectors, exports and imports, board analytics), which belong to a board tool.

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
