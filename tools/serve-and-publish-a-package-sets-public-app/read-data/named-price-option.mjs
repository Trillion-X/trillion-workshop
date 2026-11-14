// Which option of a linked offer a funnel step sells, NAMED rather than inferred from position.
//
// The step names it as `price_option_ref`, beside the `offer_ref` it already names, which is the
// same shape `public-sales-page` settled on (`checkout_price_option_id` beside `checkout_offer_id`).
// A sole option needs no name because there is nothing to choose between. Anything else returns
// null and the caller falls back to `display_amount_cents`, the number the funnel author actually
// wrote, rather than to whichever row a decoder happened to leave first.
//
// This is deliberately NOT a shared helper with the sibling packages. Centralising it would make one
// owner for a rule whose whole defect was being applied where nobody had authored an answer; the
// convergence verdict says so outright. What is shared is the DATA vocabulary, not the code. Each
// surface falls back to something different, and that difference is the reason the rule is local:
// this one falls back to the authored `display_amount_cents`, `checkout` to its display SSOT, and
// `public-sales-page` to a reported `unnamed`.
//
// It lives HERE rather than in `processes/public-entry-server-source.mjs`, where it was written,
// for one reason: that file is a server program with zero exports, so nothing could import the
// expression that decides which price a funnel step charges, and it was the only one of this lane's
// four sites with no test of its own. A rule about money that cannot be imported cannot be verified.
export function namedPriceOption(linked, namedId) {
  const options = Array.isArray(linked?.price_options) ? linked.price_options : [];
  if (namedId) return options.find((option) => option && option.id === namedId) ?? null;
  return options.length === 1 ? options[0] : null;
}
