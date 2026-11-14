// tools/space-members/read-data/member-now.mjs
//
// The ONE reader of "is this person a member of this space now". Every tool that asks (posting, reading, RSVPs, rewards,
// the permission facts) calls `memberNow`; none re-derives it.
//
// What it reads: the space's row (its owner and `config.join` rows), the person's member row (their stored state and how
// they came in) and the access refs they hold now (tools/paid-access). What it never stores: "lapsed". A member whose
// join rows no longer hold, for instance because the paid access that let them in ended or was refunded, is lapsed from
// the moment the access is gone, and a member whose access comes back is a member again, with nothing written in
// between. A member row says who came in and how; whether they still count is asked every time, so a refund closes the
// very next request.
//
// The join rows are DATA (join-rows.json) evaluated by the formula engine's row filter (tools/formulas): one rule per
// row, any row that holds admits. A row that is not one the DATA names fails closed: it admits nobody.
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import joinData from './join-rows.json' with { type: 'json' };

const FIELDS = joinData.facts;

/** The join rows a space is read by: its own, or invitation only when it names none. */
export const joinRowsOf = space => (Array.isArray(space.config?.join) && space.config.join.length ? space.config.join : joinData.invited_only);

/** The key of one join row in the DATA (`free`, `invited`, `access`), or null when it is not one the DATA names. */
function keyOf(row) {
  const keys = Object.keys(joinData.rows).filter(key => row?.[key] !== undefined && row[key] !== null && row[key] !== false);
  return keys.length === 1 ? keys[0] : null;
}

/** Every reason a space's join rows cannot be used, in plain words; empty when they can. */
export function joinRowProblems(rows) {
  if (!Array.isArray(rows) || !rows.length) return ['join lists who may join: one or more rows, each naming one of ' + Object.keys(joinData.rows).join(', ') + '.'];
  return rows.flatMap((row, at) => {
    const key = keyOf(row);
    if (!key) return [`join row ${at + 1} must name exactly one of ${Object.keys(joinData.rows).join(', ')}.`];
    const spec = joinData.rows[key];
    if (spec.value === 'true' && row[key] !== true) return [`join row ${at + 1}: ${key} must be true.`];
    if (spec.value === 'row' && (typeof row[key] !== 'string' || !row[key].trim())) return [`join row ${at + 1}: ${key} must name a value.`];
    return [];
  });
}

/** The rule tree of a list of join rows: any row that holds. A row the DATA does not name becomes no rule at all. */
function treeOf(rows) {
  const rules = rows.flatMap(row => {
    const key = keyOf(row);
    if (!key) return [];
    const spec = joinData.rows[key];
    return [{ kind: 'rule', field: spec.fact, operator: spec.operator, params: { values: spec.value === 'true' ? [true] : [row[key]] } }];
  });
  return { kind: 'group', combinator: 'or', negate: false, rules };
}

/**
 * Whether the join rows let a person in, and which row did. `facts` is { invited, held_access }. Rows that name nothing
 * the DATA knows admit nobody.
 */
export function admission(space, { invited = false, held_access: heldAccess = [] } = {}) {
  const rows = joinRowsOf(space);
  const row = { free: true, invited: Boolean(invited), held_access: [...heldAccess] };
  const holding = rows.filter(one => keyOf(one) && filterRecords({ records: [row], fields: FIELDS, tree: treeOf([one]) }).matches.length === 1);
  if (!holding.length) return { admitted: false, how: null };
  const key = keyOf(holding[0]);
  return { admitted: true, how: key === 'access' ? `access:${holding[0].access}` : key };
}

/** A sentence from the DATA's words (or the space's own `config.words`), with {space}, {access} and {how} filled. */
export function wordsFor(space, id, fill = {}) {
  const template = space.config?.words?.[id] ?? joinData.words[id];
  const values = { space: space.title ?? '', ...fill };
  return template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}

/** How a person gets in, in words, from the join rows. */
export function howToJoin(space) {
  if (!(Array.isArray(space.config?.join) && space.config.join.length)) return wordsFor(space, 'joined_by_invitation_only');
  return joinRowsOf(space).flatMap(row => {
    const key = keyOf(row);
    return key ? [wordsFor(space, key, { access: row.access ?? '' })] : [];
  }).join(' ');
}

/**
 * The answer: { member, state, reason }. state is one of
 *   "member"  in the space now
 *   "lapsed"  their member row says member but no join row holds for them now (access ended); back when it holds again
 *   "left"    they left
 *   "removed" a host put them out
 *   "none"    no member row
 * The owner is a member while their member row says so, whatever the join rows say.
 */
export function memberNow({ space, subject, member, held_access_refs: held = [] }) {
  if (!member) return { member: false, state: 'none', reason: wordsFor(space, 'refused', { how: howToJoin(space) }) };
  if (member.state === 'left') return { member: false, state: 'left', reason: wordsFor(space, 'left') };
  if (member.state === 'removed') return { member: false, state: 'removed', reason: wordsFor(space, 'removed') };
  if (member.state !== 'member') return { member: false, state: 'none', reason: wordsFor(space, 'refused', { how: howToJoin(space) }) };
  if (subject === space.owner) return { member: true, state: 'member', reason: null };
  const { admitted } = admission(space, { invited: Boolean(member.invitation), held_access: held });
  if (admitted) return { member: true, state: 'member', reason: null };
  return { member: false, state: 'lapsed', reason: wordsFor(space, 'lapsed', { how: howToJoin(space) }) };
}
