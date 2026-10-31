# tools/form-groups-and-matches/

Keeps groups of anything in a person's records (lists, collections, folders, boards: ordered members, groups inside groups), regroups a tree by the person's own words, and forms matches and small groups of people by grounded expected value, with introductions that wait for every party's consent. Seven Workshop tools: `tool:read-my-groups` and `tool:change-my-groups` (through the records door), `tool:regroup-a-tree`, `tool:form-matches`, `tool:check-match-evidence`, `tool:assign-helpers-under-capacity` and `tool:choose-configurations`. Ported from the `group` package's membership nucleus (and the membership graph it used from `ui/show/group`) and from the `interaction-program` package's matching policy.

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
| `tool-rows.json` | The seven tool rows. Every row runs with `tools/records-door/do-work/run-an-export.mjs`. |
| `part.json` | No module here is offered to other tools. |
| `test/group-graph.test.mjs` | The membership gauntlet: every operation, nesting and the cycle rule (the original graph's twenty cases, and ids that are object property names). |
| `test/group-records.test.mjs` | Record ids, the fold (later wins, removed, misplaced and malformed records) and the minimal writes. |
| `test/group-changes.test.mjs` | Every kind of change through one applier, and the hard cases as writes. |
| `test/my-groups.test.mjs` | The two group rows against the stand-in records door: fresh, existing, no-op, a loop across stored groups, ungrouping, a tree import, the read. |
| `test/tree-to-groups.test.mjs` | The tree bridge (twelve cases) and regrouping by intent (ten cases), on a made-up bakery's folders. |
| `test/match-fixtures.mjs` | A made-up bakers' circle: three factors, two scope fields, candidates and consents. |
| `test/select-groups.test.mjs`, `test/expected-value.test.mjs`, `test/match-evidence.test.mjs`, `test/matchmaker-gauntlet.test.mjs`, `test/capacity-assignment.test.mjs`, `test/select-configurations.test.mjs` | The original package's matching tests, on the made-up program. |
| `test/rows.test.mjs` | Every row run as the container runs it, against its sample. |

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

## Invariants

- A group never contains itself at any depth; a change that would make it so is refused whole and nothing is written.
- Member ids and every other identity are the caller's; nothing here invents one. A parent made by intent takes its id from `new_parent_ids` when given.
- Only groups that changed are written; a group that is gone is removed. A record whose id is not its own group's id is not read as that group.
- A match's value is the exact product of the program's factors, each grounded in cited evidence with a score in (0, 1]. Similarity from a search only breaks ties. A missing, zero or uncited factor, or a cut between equal values, forms no group.
- Work is bounded by the shortlist size: subjects x shortlist size, and no pair outside a shortlist is ever looked at.
- An introduction may be sent only when its initiative is pre-authorized and every party (members and anyone a candidate names) has approved with their own value and none has vetoed. `tool:form-matches` gives connections only for those, and sends and writes nothing.
- A helper is never booked past capacity, and nobody is assigned to themself.
- Nothing here is any program's or person's: factors, scope fields, questions, citation rules, consent words, access tiers, group sizes and capacities all arrive in the request. The tests use made-up names, and a test checks the matching code has no randomness and no branch on who someone is.

## Dependencies

**Depends on:** `tools/records-door` (its runner for every row, and its client for the two group rows), Node 24 in the tool container.

**Not carried:** the old group read and write targets' engine framing (identity-text read-current frames, write batches, host partition labels, producer requests), the interaction-program descriptor fold with its ten references to old packages and its match-cycle workflow (engine composition), the subject-participant hosted join doorway (access-rule admission, signed owner events, engine CAS writes: joining a group is `add-member` here), the board surfaces and screens (screens), and the group package's board features (layouts, connectors, exports and imports, board analytics), which belong to a board tool.

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
