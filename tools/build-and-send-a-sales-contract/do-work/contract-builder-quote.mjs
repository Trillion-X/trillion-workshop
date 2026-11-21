// tools/build-and-send-a-sales-contract/do-work/contract-builder-quote.mjs
//
// Pure: a private deal's price lines, its total, and the message the customer gets. The builder screen (web/src/workspace)
// draws these and the person edits them on the spot; nothing here reads a database or sends.
//
// The price parts are the owner's rows (offer_price_parts of the pursuit's database, read by the screen). A piece is one
// row group (format, length, publicity, testimonial, travel); its option is the one chosen. Each part's basis says how it
// counts: `flat` (one amount), `per_unit` (an amount times a whole quantity), `percent` (a share of the amount lines, so
// a negative percent is a discount) and `at_cost` (named, never added to the total).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a piece, option, label or word: they are the rows' own text, and the template's words are DATA.
//   2. A line with no amount yet is unpriced, never zero: the total is null and the quote says so.
//   3. Money is whole cents everywhere; a percent line is rounded once, to the nearest cent.

const isWhole = value => Number.isSafeInteger(value) && value > 0;
const isCents = value => Number.isSafeInteger(value) && value >= 0;

/** The choices for each piece: { [piece]: { option, quantity?, amount_cents? } }. Every piece has exactly one option. */
export function quoteLines(parts, choices) {
  const pieces = new Map();
  for (const part of parts) pieces.set(part.piece, [...(pieces.get(part.piece) ?? []), part]);
  for (const piece of Object.keys(choices)) if (!pieces.has(piece)) throw new Error('A choice names a part the offer does not have.');
  const lines = [];
  for (const [piece, options] of pieces) {
    const choice = choices[piece];
    const part = options.find(row => row.option_key === choice?.option);
    if (!part) throw new Error('Every part needs exactly one chosen option.');
    const quantity = part.basis === 'per_unit' ? choice.quantity ?? 1 : 1;
    if (part.basis === 'per_unit' && !isWhole(quantity)) throw new Error('A per-unit part needs a whole number of units.');
    const amount = choice.amount_cents !== undefined ? choice.amount_cents : part.amount_cents;
    lines.push(lineOf(part, piece, quantity, amount));
  }
  return { lines, total_cents: totalOf(lines) };
}

function lineOf(part, piece, quantity, amount) {
  const base = { piece, option: part.option_key, label: part.label, unit: part.unit ?? null, basis: part.basis, quantity };
  if (part.basis === 'at_cost') return { ...base, kind: 'at_cost', amount_cents: null, total_cents: null };
  if (part.basis === 'percent') return { ...base, kind: 'percent', percent: part.percent ?? null, amount_cents: null, total_cents: null };
  if (!isCents(amount)) return { ...base, kind: 'amount', amount_cents: null, total_cents: null };
  return { ...base, kind: 'amount', amount_cents: amount, total_cents: amount * quantity };
}

/** The total: every amount line, plus each percent line on the amount lines. Null while any amount line is unpriced. */
export function totalOf(lines) {
  const amounts = lines.filter(line => line.kind === 'amount');
  if (amounts.some(line => line.total_cents === null)) return null;
  const base = amounts.reduce((sum, line) => sum + line.total_cents, 0);
  const shares = lines.filter(line => line.kind === 'percent' && Number.isSafeInteger(line.percent))
    .reduce((sum, line) => sum + Math.round((base * line.percent) / 100), 0);
  return base + shares;
}

/** The template's words with its placeholders filled. `words` names the text shown where a value is not set. */
export function fillTemplate(text, values) {
  return text.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole));
}

/** The lines as the customer reads them, one per line of text. Amounts are formatted by the caller's `money`. */
export function linesText(lines, money, words) {
  return lines.map(line => {
    const amount = line.kind === 'at_cost' ? words.at_cost
      : line.kind === 'percent' ? (line.percent === null ? words.unpriced : `${line.percent}%`)
        : line.total_cents === null ? words.unpriced : money(line.total_cents);
    const count = line.basis === 'per_unit' ? `${line.quantity} × ` : '';
    return `${line.label} — ${count}${amount}`;
  }).join('\n');
}

/** The message the customer gets: from the pursuit's sender row, to the customer, the template's subject and body. */
export function composeMessage({ sender, customer, template, offerLabel, lines, total_cents, link, money, words }) {
  const values = {
    name: customer.name || customer.email,
    offer: offerLabel,
    lines: linesText(lines, money, words),
    total: total_cents === null ? words.unpriced : money(total_cents),
    link: link ?? words.link_not_yet,
    payment: words.payment_not_set_up,
    signature: sender.name,
  };
  return {
    from: sender.from_address,
    reply_to: sender.reply_to ?? null,
    to: customer.email,
    subject: fillTemplate(template.subject, values),
    body: fillTemplate(template.body, values),
    footer: sender.mailing_address ?? null,
  };
}
