# tools/space-members/

A person who runs a shared space (a club, a class, a team, a place for posting and sometimes calling) can let people join it by a rule, let them leave, let them show a name in it, and ask whether anyone is a member right now. A space is not a kind of business: it is one `record:space` row and one `record:space-member` row per person in it, and every other space tool (invitations, posts, permissions, visibility, RSVPs, rewards) reads membership through this folder's one reader.

Ported from old Trillion (tag `old-trillion-before-worker-retire`): `src/community.mjs` (`mayJoin`, `activeMember`, join, leave, member names), `src/space-member-types.mjs` and `src/space-membership-kinds.mjs`. The old code kept members in Durable Object SQL tables; here they are rows over the records door, so any computer's run reads and writes the same rows.

## The one answer to "is this person a member now?"

`read-data/member-now.mjs` is the only place that answers it, and every tool asks it again on every call. It reads three things: the space's row (its `owner` and its `config.join` rows), the person's member row, and the access they hold now (`tools/paid-access`, read once per run by `read-data/held-access.mjs`).

- A join row is DATA read by the formula engine's row filter (`tools/formulas`): `{free:true}` lets anyone in, `{invited:true}` lets in a person who accepted an invitation, `{access:"<ref>"}` lets in a person who holds that access. Any row that holds admits. `read-data/join-rows.json` says which fact and comparison each row key reads; a row it does not name admits nobody.
- A space with no join rows is joined only by invitation, whatever else it has turned on.
- "Lapsed" is never stored. A member whose join rows no longer hold (their paid access ended or was refunded) is lapsed from the next ask, and a member whose access comes back is a member again with nothing written in between. The person who runs the space is a member while their row says so.
- Words shown to people (how to join, why refused, lapsed, removed, left) are rows of `join-rows.json`, and the space's own `config.words` replace any of them.

## Files

| File | Purpose |
|------|---------|
| `read-data/space-rows.mjs` | The one owner of the record kinds (`record:space`, `record:space-member`, `record:space-invitation`, `record:space-item`, `record:space-reaction`, `record:space-rsvp`, `record:space-fact`, `record:space-reward-claim`), their ids, and `keepRow`, a compare-and-set write that reports whether anything changed. Other space tools import it. |
| `read-data/member-now.mjs` | `memberNow`, `admission`, `joinRowProblems`, `howToJoin`, `wordsFor`: the join rule and the one membership reader. |
| `read-data/join-rows.json` | The join row keys, their comparisons and the standard words (DATA). |
| `read-data/member-types.mjs` | The member types of a space (its label's from `tools/space-member-types`, its own, its roles), inheritance with missing parents and cycles refused, the type a joiner gets. |
| `read-data/held-access.mjs` | What each person holds, from one read of the account's access records. |
| `do-work/space-members.mjs` | The functions the five rows run. |
| `tool-rows.json` | The five rows: `tool:join-a-space`, `tool:leave-a-space`, `tool:check-someone-is-in-a-space`, `tool:list-a-spaces-members`, `tool:choose-the-name-i-show-in-a-space`. |
| `kits/` | One kit per row. |
| `test/space-members.test.mjs` | The rows run as the container runs them against the stand-in records door: join by a free row, by held access, refused without it, lapse on refund and back, leave and rejoin, a person put out stays out, only members list members. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `memberNow` | `({ space, subject, member, held_access_refs }) => { member, state, reason }` | state is member, lapsed, left, removed or none. |
| `admission` | `(space, { invited, held_access }) => { admitted, how }` | Which join row, if any, lets a person in. |
| `keepRow` | `(door, kind, id, value, existing?) => { written, value }` | Create or replace one row, refused by the door if it changed since it was read. |
| `record:space-member` | `{ space, subject, member_type, state, how, invitation?, joined_at, ended_at?, name? }` | One row per person per space; the id is made from the space and the person. |

## Not carried, and why

- **A platform plan check at joining** (`plan_feature` of `tools/space-membership-kinds`: the joiner's own paid Trillion plan, or a seat the owner pays for). It reads the old app's plan-comparison rows, which are not in the Workshop; the kinds DATA stays and `tools/space-config` validates a space's `members_are` against it.
- **Putting a member out, giving a member another type, adding a type of the space's own** belong to `tools/space-permissions`, which decides who may do them by the space's rules.
- **Accepting an invitation** belongs to `tools/space-invites`; it writes the member row with `how: "invited"` and the invitation's id, which `admission` reads as the `invited` fact.

## Dependencies

**Depends on:** `tools/records-door` (packed), `tools/paid-access` (the held-access reader), `tools/formulas` (the row filter), `tools/space-member-types` (DATA).

**Depended on by:** every other space tool.
