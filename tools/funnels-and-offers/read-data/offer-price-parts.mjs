// tools/funnels-and-offers/read-data/offer-price-parts.mjs
//
// PURPOSE
//   A deal's price as priced parts. Each part is one row of an offer's parts: its piece (open text such as format,
//   length, publicity or testimonial), its option within that piece, how it counts, whether the public may see it
//   (`shown_publicly`) and the use grant purpose it gives when chosen (`grant_purpose`), if any. How a part counts is
//   its basis: `flat` (one amount), `per_unit` (an amount for each unit, such as each hour), `percent` (a whole-number
//   percent of the base, negative for a discount) or `at_cost` (a charge the buyer pays at cost, with no amount here).
//   A quote takes exactly one option per piece and returns the lines, the total and its status.
//   The owner view lists every chosen part with its amount. The public view returns the total and the labels of the
//   shown parts, with no amount on any line, so a hidden part's value is folded into the total and never named.
//
//   The base is the sum of the chosen `flat` and `per_unit` parts. Every `percent` part is a percent of that same base,
//   so no percent applies to another percent and nothing compounds. Each percent is rounded to the cent on its own.
//   The total is the base plus the percents. An `at_cost` part adds nothing to the total and is listed beside it.
//   The status is `ask` when a chosen part has no amount or percent yet, and then the total is null.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a piece, an option, a unit, an amount or a seller: those words are each row's own text.
//   2. Every piece of the offer has exactly one chosen option, and every choice names a real option of that piece.
//   3. A part with no amount or percent yet is unpriced, never zero: the total is null and the status is `ask`.
//   4. The public view carries only the total, the status and the labels of the shown parts, with no amount on any
//      line, so a buyer cannot subtract the shown lines from the total and recover a hidden part's value.
//   5. Pure: no database and no payment here. Buying a part writes its use grant where the purchase is made.
//
const VIEWS = new Set(['owner', 'public']);
const BASES = new Set(['flat', 'per_unit', 'percent', 'at_cost']);
const isWhole = value => Number.isSafeInteger(value) && value > 0;
const isAmount = value => Number.isSafeInteger(value);

export function quotePriceParts({ parts, choices = {}, view = 'owner' }) {
  if (!VIEWS.has(view)) throw new Error('A quote is for the owner or for the public.');
  const pieces = new Map();
  for (const part of parts) pieces.set(part.piece, [...(pieces.get(part.piece) ?? []), part]);
  for (const piece of Object.keys(choices)) if (!pieces.has(piece)) throw new Error('A choice names a part the offer does not have.');
  const chosen = [];
  for (const [piece, options] of pieces) {
    const choice = choices[piece];
    const part = options.find(row => row.option_key === choice?.option);
    if (!part) throw new Error('Every part needs exactly one chosen option.');
    if (!BASES.has(part.basis)) throw new Error('A part has a basis the quote does not know.');
    if (part.basis === 'per_unit' && !isWhole(choice.quantity)) throw new Error('A per-unit part needs a whole number of units.');
    if (part.basis !== 'per_unit' && choice.quantity !== undefined) throw new Error('Only a per-unit part takes a quantity.');
    chosen.push({ piece, part, quantity: part.basis === 'per_unit' ? choice.quantity : 1 });
  }
  let base = 0;
  let baseIsAsk = false;
  for (const { part, quantity } of chosen) {
    if (part.basis !== 'flat' && part.basis !== 'per_unit') continue;
    if (isAmount(part.amount_cents)) base += part.amount_cents * quantity;
    else baseIsAsk = true;
  }
  const amountOf = ({ part, quantity }) => {
    if (part.basis === 'flat' || part.basis === 'per_unit') return isAmount(part.amount_cents) ? part.amount_cents * quantity : null;
    if (part.basis === 'percent') return isAmount(part.percent) && !baseIsAsk ? Math.round(base * part.percent / 100) : null;
    return null;
  };
  const amounts = chosen.map(amountOf);
  const unpriced = amounts.some((amount, index) => amount === null && chosen[index].part.basis !== 'at_cost');
  const percents = chosen.reduce((sum, { part }, index) => part.basis === 'percent' ? sum + amounts[index] : sum, 0);
  const total = unpriced ? null : base + percents;
  const lines = [];
  chosen.forEach(({ piece, part, quantity }, index) => {
    if (view === 'public' && !part.shown_publicly) return;
    if (view === 'public') {
      lines.push({ label: part.label, quantity, unit: part.unit ?? null });
      return;
    }
    lines.push({
      piece,
      option: part.option_key,
      label: part.label,
      quantity,
      unit: part.unit ?? null,
      amount_cents: amounts[index],
      shown_publicly: part.shown_publicly,
      grant_purpose: part.grant_purpose ?? null,
    });
  });
  return { view, status: total === null ? 'ask' : 'priced', lines, total_cents: total };
}
