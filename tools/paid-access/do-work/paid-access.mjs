// tools/paid-access/do-work/paid-access.mjs
//
// The functions the access rows run, one per job, through the records-door command:
//   node /opt/records-door/do-work/run-an-export.mjs /opt/paid-access/do-work/paid-access.mjs <function> < input.json
// Each is `(input, { door }) => result`. The delivery rows run their own files in read-data/ the same way.
import { heldAccess, readHeldAccess } from '../read-data/who-holds-access.mjs';
import { decodeAddressedExpiringValueScope } from '../read-data/addressed-scope.mjs';
import { holdsAnyRequiredAccessRef } from '../read-data/holds-any-required-access-ref.ts';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export { heldAccess };

/** tool:grant-paid-access-to-people: the access-grant records for people who hold access by hand, and the revokes that end one. */
export { grantAccess as grantPaidAccessToPeople } from '../read-data/access-grants.mjs';

/** tool:see-who-holds-paid-access: the access refs one buyer holds now, and why. The clock is this run's own. */
export function seeWhoHoldsPaidAccess(input, context) {
  return readHeldAccess(input ?? {}, { door: context.door, nowMs: context.nowMs ?? Date.now() });
}

/**
 * tool:check-a-buyer-may-open: whether a buyer may open one gated thing, from the scope it is gated by. A thing that
 * requires nothing is open to any named buyer; otherwise the buyer must hold ANY required ref now. Anything that is
 * not exactly a scope, no subject, or access that cannot be worked out is not authorized. An authorized answer carries
 * `membership_revision`: a fixed word for a thing that requires nothing, else a hash of what the buyer holds, so a
 * grant or revoke that changes it changes the revision and an admitted action can fail closed when membership moves.
 */
export const UNGATED_MEMBERSHIP_REVISION = 'membership-revision:ungated';

export async function checkABuyerMayOpen(input, context) {
  const subject = typeof input?.subject === 'string' ? input.subject.trim() : '';
  const scope = decodeAddressedExpiringValueScope(input?.scope);
  if (!subject || !scope) return { authorized: false };
  if (scope.required_access_refs.length === 0) return { authorized: true, membership_revision: UNGATED_MEMBERSHIP_REVISION };
  try {
    const { held_access_refs: held, membership_revision_input: granted } = await readHeldAccess({ subject }, { door: context.door, nowMs: context.nowMs ?? Date.now() });
    const revision = makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify({ granted, held: [...held].sort() })));
    return { authorized: holdsAnyRequiredAccessRef(held, scope.required_access_refs), membership_revision: revision };
  } catch {
    return { authorized: false };
  }
}
