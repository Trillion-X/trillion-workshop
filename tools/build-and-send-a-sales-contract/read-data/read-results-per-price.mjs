// How each price did: sent, opened, signed and paid, counted per price arm. Port of the results capability in the old
// native commercial owner (src/native-commercial-domain.mjs at 3b7063d6f3: audienceSends with its linkState), which
// the send screen read as operation results. Storage-free: the caller passes the send rows and a function that reads a
// link's state (opened, signed, paid) from the share it made.
import data from './read-results-per-price.json' with { type: 'json' };

/**
 * sends: [{ record, share_id?, sent?: boolean, arm?: { arm, amount_cents } | null }];
 * linkStateOf(record, share_id) → { opened, signed, paid } or null when the link is unknown.
 * → [{ arm, amount_cents, sent, opened, signed, paid }] with one row per price arm (arm null is the price-free send).
 */
export function resultsPerPrice({ sends, linkStateOf }) {
  const byPrice = new Map();
  for (const send of sends) {
    const arm = send.arm?.arm ?? null;
    const row = byPrice.get(arm) ?? { arm, amount_cents: send.arm?.amount_cents ?? null, ...Object.fromEntries(data.measures.map(measure => [measure, 0])) };
    const state = send.share_id ? linkStateOf(send.record, send.share_id) : null;
    const counted = { sent: send.sent === true, opened: Boolean(state?.opened), signed: Boolean(state?.signed), paid: Boolean(state?.paid) };
    for (const measure of data.measures) if (counted[measure]) row[measure] += 1;
    byPrice.set(arm, row);
  }
  return [...byPrice.values()];
}
