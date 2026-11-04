// src/access-impact.mjs
//
// PURPOSE
//   Before a space owner adds a tool for members, say per member what it would give them that they do not already hold,
//   what the tool's own descriptor says it reaches (runs on their computer, sends data off the device, can cost money),
//   and whether the owner has to decide it themselves. Read-only: it grants nothing. The tool version in the answer is
//   the content hash of the definition (workshopToolVersion), so the owner approves exactly one immutable version, and
//   `changesSince` names what differs from a version approved earlier.
//
// NON-NEGOTIABLE INVARIANTS
//   1. What counts as a consequence is DATA (src/access-impact.json reaches); nothing here names a tool or a field.
//   2. A member's gain is the operations asked minus what their existing grants already give them; "*" is everyone now and later.
//   3. Reading the impact never changes a grant.
//
import data from './access-impact.json' with { type: 'json' };

const at = (value, path) => path.reduce((held, key) => (held && typeof held === 'object' ? held[key] : undefined), value);
const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text);

/** The operations asked for, or a plain refusal for one that is not an operation. */
export function operationsOf(asked) {
  const list = Array.isArray(asked) && asked.length ? asked : data.operations;
  const wrong = list.filter(operation => !data.operations.includes(operation));
  if (wrong.length) throw new Error(fill(data.words.unknown_operation, { operations: data.operations.join(', ') }));
  return [...new Set(list)];
}

/** The consequence rows the descriptor matches for these operations. */
export function reachesOf(descriptor, operations) {
  return data.reaches.filter(row => {
    if (!row.operations.some(operation => operations.includes(operation))) return false;
    const value = at(descriptor, row.path);
    if (row.present) return value !== undefined && value !== null;
    if (row.includes !== undefined) return Array.isArray(value) && value.includes(row.includes);
    return value === row.equals;
  });
}

/**
 * { tool_id, tool_version, operations, everyone, reaches, members: [{ member_id, gains, already }], needs_owner, says }
 * `members` are the current members ({ member_id, name }); `held` maps a member id to the operations their grants hold.
 */
export function accessImpact({ descriptor, toolVersion, operations: asked, memberId = data.every_member, members, held }) {
  const operations = operationsOf(asked);
  const everyone = memberId === data.every_member;
  const targets = (everyone ? members : members.filter(member => member.member_id === memberId)).slice(0, data.max_members);
  const reaches = reachesOf(descriptor, operations);
  const rows = targets.map(member => {
    const already = operations.filter(operation => (held[member.member_id] ?? []).includes(operation));
    return { member_id: member.member_id, name: member.name ?? null, gains: operations.filter(operation => !already.includes(operation)), already };
  });
  const deciding = reaches.filter(row => row.decided_by === 'owner' && rows.some(member => member.gains.some(operation => row.operations.includes(operation))));
  return {
    tool_id: descriptor.id, tool_version: toolVersion, operations, everyone, members: rows,
    reaches: reaches.map(row => ({ id: row.id, says: row.says, decided_by: row.decided_by })),
    needs_owner: deciding.length > 0,
    says: [rows.every(member => !member.gains.length) ? data.words.no_gain : null, deciding.length ? fill(data.words.needs_owner, { reasons: deciding.map(row => row.says).join(' ') }) : null, everyone ? data.words.later_members : null].filter(Boolean),
  };
}
