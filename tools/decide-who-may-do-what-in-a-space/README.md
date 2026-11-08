# tools/decide-who-may-do-what-in-a-space/

Decide who may do what in a space by each member's kind and the space's own rules, and open or close a space to everyone.

The capability catalogue registers this existing owner in commit `56c0c27b`. Historical held files contain changed import addresses; their receipt records source and target identities separately. They are not qualified fresh cores.

The four method-span files in `source-baselines/` are exact immutable source bytes, selected before adaptation. The earlier full `space-permissions.mjs.held` capture remains unchanged and inactive; a baseline commit including its retired BLAKE3 import was refused. The admitted permission selection is now exact original lines75–343, before any fresh core was authored. The contracts in `ports/` name their source spans and planned fresh core paths. A normal baseline commit must precede those fresh cores. Baseline, active source, public dependency admission, semantic checks, consumer binding and installed behavior are separate facts.

The planned public entry is `read-data/space-permissions.mjs`, with `nativeSpacePermissions`, `ruleProblems`, `problemsWithRules` and `inheritedMemberTypes`. It preserves `allowedInSpace(spaceId, relay, action, thing?)`, `decideInSpace(space, relay, action, thing?)`, `mayIn(space, relay, actionIds, thing?)` and `readSpaceRules({relay, space_id})` over the same rule decisions. An unavailable policy read raises an error; it never produces an empty policy or a completed boolean denial.

The permission library owns no membership store or native grant. Its required record adapter reads the existing record model:

| Method | Result |
| --- | --- |
| `read(spaceId)` | The space membership record, or confirmed `null` |
| `member(spaceId, relay)` | The actual member row, including role and state, or confirmed `null` |
| `members(spaceId)` | All member rows in this space |
| `rules(spaceId)` | Stored `{rules: JSON text, changed_at}`, or confirmed `null` |
| `ensureRules(spaceId, startingRow)` | Atomic insert-if-absent returning the actual winning row |
| `community(spaceId)` | Current stored configuration, or confirmed `null` |
| `ownMemberTypes(spaceId)` | The complete own-type graph, including legacy rows beyond creation limits and current document precedence |
| `accessState(spaceId, relay, thing)` | Fresh stable serialization of all membership, maker, rules, configuration and own-type inputs |

Read failure must throw. `accessState` rereads current state before and after awaited decisions; returning one cached snapshot defeats that check. The consuming record transaction must validate the captured readset and current native principal atomically with its event or member writes. A successful permission decision alone is not native write authority.

Community consumers retain the existing eligibility order: `checkedMember` verifies current membership, paid access and invitation conditions; `checkedMay` then awaits `allowedInSpace`. A configured role's `may` list is a rule fact, never an independent grant. A private record's `shared_here: false` refuses before reading space policy.

Current work is synthetic only. No live calendar, provider, account, member, grant or policy writes are exercised. Canonical shared formula, effect and DATA dependencies must be publicly admitted before the full permission tests can run; injection or copied helpers cannot qualify that boundary.

Current independent continuation: source:bGVhZC02Ni1kZWNvdXBsZS1ldmVyeXRoaW5nLWZyb20tdGhpcy1tYWMtMjAyNi0xMS0wMi0xNzMw requires the canonical permission owner for synthetic six-person space invitations. This does not change the earlier delegated directive attribution in ports/*.json. Baseline bytes were independently compared with all four exact source selections at b6ae0ebf815f2f5271eed34e6e023c7e1767ec04; every byte and declared BLAKE3 matched.
