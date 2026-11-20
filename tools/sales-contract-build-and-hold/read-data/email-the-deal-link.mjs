// Emailing a deal's link to the person it is for, with the seller's note. Port of the share-email road and the send step
// in the old native commercial owner (src/native-commercial-domain.mjs at 3b7063d6f3). Storage-free: the caller checks
// the recipient with its outbound owner before it sends the request this returns.
import data from './email-the-deal-link.json' with { type: 'json' };

/** The request for one person's email: their address, name, and the link's record and share. */
export function shareEmailRequest({ send, person, shareId, origin }) {
  return {
    to: person.email,
    recipient: person.name,
    record: send.record,
    share_id: shareId,
    note: send.note ?? null,
    origin,
  };
}

/** The answer once the share email has gone: it names the address it went to. */
export function emailedAnswer(sent) {
  return { sent: true, said: data.messages.emailed.replace('{to}', () => sent.sent_to) };
}

/** A deal sent with no address is only made a link; with an address, its link is emailed with the note (null when none). */
export function dealEmailRequest({ to, note = null, origin, contractId, shareId }) {
  if (to === null) return null;
  return { record: contractId, share_id: shareId, options: { note, origin } };
}

/** The sent fields a deal answer carries once an email went out, and none when it did not. */
export function sentFields(sent) {
  return sent ? { sent_to: sent.sent_to, sent_at: sent.sent_at } : {};
}
