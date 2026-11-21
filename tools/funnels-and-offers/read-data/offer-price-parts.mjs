// tools/funnels-and-offers/read-data/offer-price-parts.mjs
//
// PURPOSE
//   A deal's price as priced parts. Each part is one row of an offer's parts: its piece (open text such as format,
//   length, publicity or testimonial), its option within that piece, how it counts (`flat`, one amount, or `per_unit`,
//   an amount for each unit such as each hour), whether the public may see it (`shown_publicly`) and the use grant
//   purpose it gives when chosen (`grant_purpose`), if any. A quote takes exactly one option per piece and returns the
//   lines and the total. The owner view lists every chosen part. The public view lists only the shown parts, but its
//   total still counts every chosen part, so a hidden part's value is folded into the total and never named.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a piece, an option, a unit, an amount or a seller: those words are each row's own text.
//   2. Every piece of the offer has exactly one chosen option, and every choice names a real option of that piece.
//   3. A part with no amount yet is unpriced, never zero: the total is null and the quote says so, in both views.
//   4. The public view never carries a hidden part's piece, option, label, grant or amount in its lines.
//   5. Pure: no database and no payment here. Buying a part writes its use grant where the purchase is made.
//
const VIEWS = new Set(['owner', 'public']);
const isWhole = value => Number.isSafeInteger(value) && value > 0;
const isPriced = part => Number.isSafeInteger(part.amount_cents);

export function quotePriceParts({ parts, choices = {}, view = 'owner' }) {
  if (!VIEWS.has(view)) throw new Error('A quote is for the owner or for the public.');
  const pieces = new Map();
  for (const part of parts) pieces.set(part.piece, [...(pieces.get(part.piece) ?? []), part]);
  for (const piece of Object.keys(choices)) if (!pieces.has(piece)) throw new Error('A choice names a part the offer does not have.');
  const lines = [];
  let total = 0;
  for (const [piece, options] of pieces) {
    const choice = choices[piece];
    const part = options.find(row => row.option_key === choice?.option);
    if (!part) throw new Error('Every part needs exactly one chosen option.');
    if (part.basis === 'per_unit' && !isWhole(choice.quantity)) throw new Error('A per-unit part needs a whole number of units.');
    if (part.basis === 'flat' && choice.quantity !== undefined) throw new Error('A flat part takes no quantity.');
    const quantity = part.basis === 'per_unit' ? choice.quantity : 1;
    const amount_cents = isPriced(part) ? part.amount_cents * quantity : null;
    total = total === null || amount_cents === null ? null : total + amount_cents;
    if (view === 'public' && !part.shown_publicly) continue;
    lines.push({
      piece,
      option: part.option_key,
      label: part.label,
      quantity,
      unit: part.unit ?? null,
      amount_cents,
      ...(view === 'owner' ? { shown_publicly: part.shown_publicly, grant_purpose: part.grant_purpose ?? null } : {}),
    });
  }
  return { view, lines, total_cents: total };
}
