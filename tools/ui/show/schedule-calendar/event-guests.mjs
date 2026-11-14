// parts/ui/show/schedule-calendar/event-guests.mjs
//
// PURPOSE
//   The guests of one event as a list of email addresses: taking what a person typed or pasted (one address or many, split
//   by commas, semicolons, spaces or line breaks), refusing what is not an address, never listing one twice, and never more
//   than the most the caller's DATA allows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An address is kept as typed (its case is the person's), but two that differ only in case are one guest.
//   2. What was refused is answered, so the caller can say which words were not addresses; nothing is dropped silently.

const ADDRESS = /^[^\s@,;<>()[\]]+@[^\s@,;<>()[\]]+\.[^\s@,;<>()[\]]+$/;

/** The guests after adding `text`: { guests, invalid, over } where `invalid` are the words that are not addresses and `over` the addresses the limit left out. */
export function addGuests(list, text, max) {
  const guests = [...list];
  const invalid = [];
  const over = [];
  for (const word of String(text).split(/[\s,;]+/).map(piece => piece.trim()).filter(Boolean)) {
    if (!ADDRESS.test(word)) invalid.push(word);
    else if (guests.some(guest => guest.toLowerCase() === word.toLowerCase())) continue;
    else if (guests.length >= max) over.push(word);
    else guests.push(word);
  }
  return { guests, invalid, over };
}

export const removeGuest = (list, email) => list.filter(guest => guest !== email);

/** The provider's attendees field for a list of guests (nothing when there are none). */
export const guestFields = list => (list.length ? { attendees: list.map(email => ({ email })) } : {});
