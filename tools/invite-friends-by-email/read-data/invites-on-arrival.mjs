// Library only. The native caller supplies current admitted owners and a records-backed account facade.
// There is no Worker import, unsigned Network fallback, or caller-authored proof of an address here.
export function invitationArrivals({ signInMethodsOf, executeNativeSharedInvitation, joinAdmittedAddressedInvitation }) {
  for (const owner of [signInMethodsOf, executeNativeSharedInvitation, joinAdmittedAddressedInvitation]) {
    if (typeof owner !== 'function') throw new TypeError('Current sign-in and admitted Space invitation owners are required.');
  }
// src/invites-on-arrival.mjs
//
// Purpose
//   A person who arrives through an invite lands inside the Space it was for. Run by the person's own store each time
//   the account signs in or is made (src/worker.mjs signedInAnswer): the invite link they came through (its code, read
//   from the address signing in returns to) is spent, and every open invite sent to the account's proven email
//   (src/space-invite-addresses.mjs) is joined, through the same Network joins the invite link and an accepted
//   invitation use, so each Space's own rules decide them. What it joined is kept as the account's arrivals, so the
//   person's AI and rules can read where they came in.
//
// Non-negotiable invariants
//   1. Only an invite the person holds (its code) or one sent to an address their account proved is joined; nothing
//      typed about themselves counts, and no other Space is touched.
//   2. A join that fails (used, revoked, expired, refused by the Space's rules) is skipped, never thrown: signing in
//      always finishes.
//   3. Joining is the Network's own, so a person already in the Space is answered already_member and nothing repeats.
//

const ARRIVALS = 'arrivals';
const KEEP = 50;

/** Joins what this account arrived through; answers { joined: [space ids, the invite link's first] }. */
async function joinInvitesOnArrival(person, { userId, code = null, claims = null, recorder = {} }) {
  if (!claims?.sign_in) return { joined: [] };
  const network = person.network();
  const relay = person.relay();
  const personRef = person.ctx.id.toString();
  const joined = [];
  const tried = async (kind, join) => {
    try {
      const answer = await join();
      if (answer?.space_id && !joined.includes(answer.space_id)) joined.push(answer.space_id);
      if (answer?.space_id && !answer.already_member) await arrived(person, { kind, space_id: answer.space_id });
    } catch (error) { console.error(`${kind} not joined on arrival:`, String(error?.message ?? error)); }
  };
  if (code) await tried('invite-link', () => claims?.sign_in
    ? executeNativeSharedInvitation({ env: person.env, owner: personRef, claims, recorder, relay,
      operation: 'joinWithInvite', input: { code } })
    : Promise.reject(new Error('A current admitted sign-in is required.')));
  try {
    const email = userId ? (await signInMethodsOf(person, userId)).email?.address ?? null : null;
    if (email) {
      const { records = [] } = await network.rememberAddresses({ relay, person_ref: personRef, addresses: [email], claims, recorder });
      for (const { record } of records) await tried('invite-to-email', () => claims?.sign_in
        ? joinAdmittedAddressedInvitation({ env: person.env, owner: personRef, claims, recorder, relay, invite_id: record.invite_id })
        : Promise.reject(new Error('A current admitted sign-in is required.')));
    }
  } catch (error) {
    // Optional email discovery must not discard a link already joined above.
    // Without a proven address, no addressed invitation is attempted.
    console.error('addressed invites not read on arrival:', String(error?.message ?? error));
  }
  return { joined };
}

// One arrival kept on the account, newest first.
async function arrived(person, { kind, space_id: spaceId }) {
  const kept = (await person.fact(ARRIVALS)) ?? [];
  await person.setFact(ARRIVALS, [{ kind, space_id: spaceId, at: new Date().toISOString() }, ...kept].slice(0, KEEP));
}

/** Where this account came in, newest first: [{ kind, space_id, at }]. */
const arrivalsOf = async person => (await person.fact(ARRIVALS)) ?? [];

return { joinInvitesOnArrival, arrivalsOf };
}
