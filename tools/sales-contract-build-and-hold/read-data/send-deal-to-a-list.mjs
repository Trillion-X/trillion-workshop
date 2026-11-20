// Sending a deal, or any shared record, to each person on a list: the scope and link each person gets, the words the
// email or text carries, and whether a deal is a priced one. Port of audienceSends in the old native commercial owner
// (src/native-commercial-domain.mjs at 3b7063d6f3). Storage-free: the caller passes the contract and its free check.
import data from './send-deal-to-a-list.json' with { type: 'json' };

/** The share scope for one person: their email, else their phone, else public. */
export function scopeOfPerson(person) {
  if (person.email) return { kind: data.scope_kinds.email, value: person.email };
  if (person.phone) return { kind: data.scope_kinds.phone, value: person.phone };
  return { kind: data.scope_kinds.public };
}

/** The words a send carries: its note (or title), then the person's link, each on its own line when both are there. */
export function linkWordsOf(send, link) {
  return [send.note ?? send.title, link].filter(Boolean).join('\n');
}

/** Which link road a send's record takes: a sales contract gets a priced deal link, anything else a record share. */
export function linkRouteOf(record) {
  return record.startsWith(data.contract_prefix) ? data.link_route.contract : data.link_route.record;
}

/** A sales contract is priced when it asks for money: a deal that is free is agreed by signing its link instead. */
export function isPricedDeal({ record, contract, isFree }) {
  return record.startsWith(data.contract_prefix) && !isFree(contract);
}

/** The options for a sales contract link: its id, the person's scope, and the arm's price when a price test sent it. */
export function contractLinkRequest({ send, person, arm }) {
  return {
    contract_id: send.record,
    scope: scopeOfPerson(person),
    ...(arm?.arm ? { amount_cents: arm.amount_cents } : {}),
  };
}

/** The options for a record share link: its scope, origin, and the send's own end time and permissions when it has them. */
export function recordLinkRequest({ send, person, origin }) {
  return {
    record: send.record,
    options: {
      scope: scopeOfPerson(person),
      origin,
      ...(send.until ? { expires_at: send.until } : {}),
      ...(send.can ? { can: send.can } : {}),
    },
  };
}
