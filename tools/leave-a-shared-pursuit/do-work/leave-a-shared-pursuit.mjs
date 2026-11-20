// tools/leave-a-shared-pursuit/do-work/leave-a-shared-pursuit.mjs
//
// tool:leave-a-shared-pursuit: a person leaves a pursuit they share with other people. It changes only their own membership
// of the pursuit's space (tool:leave-a-space: the member row marked left, what they put there stays) and ends the pursuit for
// them. It never touches another person's row. NOT WIRED: no screen, route or wake calls it; the live wiring waits for the owner's word.
//
// The guards carried from the old leavePursuit (old repository commit 4ffa1dc4a2^:src/pursuit-rooms.mjs:184-190, 259-268):
//   G1  the pursuit must be the caller's own and not ended (the caller's records hold only their own pursuits).
//   G2  a pursuit with a shared space leaves that space through leaveASpace, which refuses the person who runs the space
//       (space-members do-work/space-members.mjs:59: "The person who runs a space cannot leave it: hand it over first.").
// The network's own room leave (old pursuit-rooms.mjs:261, network.leave) is not a row change, so this tool does not do it.
//
// The run reads no store and writes none: the caller hands in the rows it read ([{ id, type, value }]: the pursuit, the space,
// and the member rows) and gets back the rows that change under `keep` ([{ id, type, value, expected }]).
import { leaveASpace } from '../../space-members/do-work/space-members.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function refuse(words) {
  throw new Error(words);
}

function recordsIn(input) {
  if (!Array.isArray(input?.records)) refuse('records must be the list of rows read from the store: [{ id, type, value }].');
  return input.records;
}

/** Leaves a shared pursuit for the person: their own membership of its space, and the pursuit ended for them. */
export function leaveASharedPursuit(input) {
  const { pursuit: pursuitId, subject } = input ?? {};
  if (!nonempty(pursuitId) || !nonempty(subject)) refuse('pursuit (the pursuit id) and subject (the person) are required.');
  const records = recordsIn(input);
  const pursuitRow = records.find(row => row.type === 'pursuit' && row.id === pursuitId) ?? null;
  const pursuit = pursuitRow?.value ?? null;
  if (!pursuit || pursuit.status === 'ended') refuse(`${pursuitId} is not one of this person's pursuits.`);
  const ended = { ...pursuit, status: 'ended', ended_at: new Date(Date.now()).toISOString() };
  const keep = [{ id: pursuitId, type: 'pursuit', value: ended, expected: pursuit }];
  if (!pursuit.space_id) return { pursuit_id: pursuitId, left: null, keep };
  const membership = leaveASpace({ records, subject, space: pursuit.space_id });
  return {
    pursuit_id: pursuitId,
    left: membership.left ? pursuit.space_id : null,
    membership: membership.state,
    keep: [...keep, ...(membership.keep ?? [])],
  };
}
