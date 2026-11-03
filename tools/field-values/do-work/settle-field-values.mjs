// tools/field-values/do-work/settle-field-values.mjs
//
// Purpose: who set each value, and which source wins. Every value offered for a field of a row (typed by a person, set
// by a rule, answered by a source, worked out by an AI) is an offer with its source; the field keeps the offer the
// precedence (precedence.mjs) puts first, and the answer keeps every other offer beside it with the reason it lost, so
// a person can see what was typed and what was worked out for them, and an AI's guess never overwrites a confirmation.
//
// Non-Negotiable Invariants:
//   1. Nothing is dropped silently: every offer handed in is the winner, an outranked offer, an offer set aside (below
//      its kind's confidence floor, withdrawn, or later than as_of), and says which and why.
//   2. A withdrawal (an offer with `withdraws: true`) removes the earlier offers of the same source (kind and by) for
//      that field, so the field falls back to the next offer; it never removes another source's offer.
//   3. `as_of` answers the value a field held at that time: offers made after it are left out.
//   4. A field whose two best offers tie on everything but the order they were handed in says `contested`.
import { precedenceOf } from './precedence.mjs';
import { sameValue } from './row-paths.mjs';

const keyOf = offer => JSON.stringify([offer.row, offer.field]);
const sourceKey = source => JSON.stringify([source?.kind ?? null, source?.by ?? null]);
const timeOf = source => (typeof source?.at === 'string' ? Date.parse(source.at) : Number.NEGATIVE_INFINITY);
const shown = ({ value, source, basis }) => ({ value, source, ...(basis === undefined ? {} : { basis }) });

/** The value each field keeps from the offers handed in, with every other offer and why it did not win. */
export function settleFieldValues({ offers, precedence, as_of: asOf }) {
  const policy = precedenceOf({ precedence });
  const cutoff = asOf === undefined ? Number.POSITIVE_INFINITY : Date.parse(asOf);
  const cells = new Map();
  offers.forEach((offer, position) => {
    const key = keyOf(offer);
    if (!cells.has(key)) cells.set(key, { row: offer.row, field: offer.field, offers: [] });
    cells.get(key).offers.push({ ...offer, position });
  });

  const answers = [...cells.values()].map(({ row, field, offers: made }) => {
    const setAside = [];
    const standing = [];
    for (const offer of made) {
      if (timeOf(offer.source) > cutoff) setAside.push({ ...shown(offer), why: 'made after as_of' });
      else standing.push(offer);
    }
    standing.sort((a, b) => (timeOf(a.source) - timeOf(b.source)) || (a.position - b.position));
    const kept = [];
    for (const offer of standing) {
      if (offer.withdraws !== true) { kept.push(offer); continue; }
      const withdrawn = kept.filter(earlier => sourceKey(earlier.source) === sourceKey(offer.source) && timeOf(earlier.source) <= timeOf(offer.source));
      for (const earlier of withdrawn) {
        kept.splice(kept.indexOf(earlier), 1);
        setAside.push({ ...shown(earlier), why: `withdrawn by ${offer.source?.kind}${offer.source?.by ? ` ${offer.source.by}` : ''}` });
      }
    }
    const eligible = [];
    for (const offer of kept) {
      const floor = policy.belowFloor(offer.source);
      if (floor) setAside.push({ ...shown(offer), why: floor });
      else eligible.push(offer);
    }
    eligible.sort(policy.compare);
    const [winner, ...rest] = eligible;
    return {
      row,
      field,
      value: winner ? winner.value : null,
      set_by: winner ? { ...winner.source, ...(winner.basis === undefined ? {} : { basis: winner.basis }) } : null,
      contested: Boolean(winner && rest[0] && policy.tied(winner, rest[0]) && !sameValue(winner.value, rest[0].value)),
      outranked: rest.map(offer => ({ ...shown(offer), why: policy.whyLost(offer, winner) })),
      set_aside: setAside,
    };
  });

  return {
    cells: answers,
    counts: {
      offers: offers.length,
      cells: answers.length,
      settled: answers.filter(cell => cell.set_by !== null).length,
      contested: answers.filter(cell => cell.contested).length,
      set_aside: answers.reduce((sum, cell) => sum + cell.set_aside.length, 0),
      withdrawals: offers.filter(offer => offer.withdraws === true).length,
    },
  };
}
